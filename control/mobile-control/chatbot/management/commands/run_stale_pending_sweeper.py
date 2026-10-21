"""Stale-pending sweeper — reconcile TiktokMessage rows stuck `delivery_status='pending'`.

TCS-v2 Sprint 3 (#3). Xem docs/Chatbot_Tiktok/tcs_v2_sprint_3_delivery_unknown_sweeper.md.

Vấn đề: hybrid C pattern insert row `pending` ngay khi tạo task, UPDATE qua
Kafka task_status sau. Nếu chain UPDATE fail (Kafka mất, worker crash,
parser fail, ...) → row stuck `pending` mãi mãi. Filter LLM history bỏ qua
pending → bot lặp câu hỏi cũ. UI hiện "đang gửi" forever.

Sweeper scan định kỳ TiktokMessage pending > age threshold → lookup
source_task để reconcile:
  - task FAILED/CANCELLED → row.delivery_status='failed'
  - task COMPLETED nhưng row vẫn pending (Kafka update mất / parse fail) → 'unknown'
  - task RUNNING/PENDING quá lâu → 'unknown' (conservative, không tự confirm fail)

Wire docker-compose.dev.yml: service `chatbot_pending_sweeper`.

Usage:
    python manage.py run_stale_pending_sweeper
    python manage.py run_stale_pending_sweeper --interval 300 --age-minutes 10
"""
from __future__ import annotations

import logging
import signal
import time

from django.core.management.base import BaseCommand
from django.utils import timezone

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 300  # 5 phút
DEFAULT_AGE_MINUTES = 10
DEFAULT_BATCH_LIMIT = 50  # Cap rows/cycle để không hit DB query timeout

_shutdown_requested = False


def _on_signal(signum, frame):  # noqa: ARG001
    global _shutdown_requested  # noqa: PLW0603
    logger.info('Stale-pending sweeper: shutdown signal %s received', signum)
    _shutdown_requested = True


class Command(BaseCommand):
    help = (
        'TCS-v2 Sprint 3 (#3): Background sweeper reconcile TikTok BOT messages '
        'stuck delivery_status=pending (Kafka task_status update mất / parser fail).'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--interval', type=int, default=DEFAULT_INTERVAL_SECONDS,
            help=f'Sleep giữa 2 cycle scan (giây). Default: {DEFAULT_INTERVAL_SECONDS}.',
        )
        parser.add_argument(
            '--age-minutes', type=int, default=DEFAULT_AGE_MINUTES,
            help=f'Threshold tuổi row pending (phút) — chỉ sweep nếu age > N. Default: {DEFAULT_AGE_MINUTES}.',
        )
        parser.add_argument(
            '--batch-limit', type=int, default=DEFAULT_BATCH_LIMIT,
            help=f'Cap số rows xử lý mỗi cycle (anti-DB-spam). Default: {DEFAULT_BATCH_LIMIT}.',
        )

    def handle(self, *args, **opts):
        interval = int(opts['interval'])
        age_minutes = int(opts['age_minutes'])
        batch_limit = int(opts['batch_limit'])

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _on_signal)
            except (ValueError, OSError):
                pass

        self.stdout.write(self.style.SUCCESS(
            f'chatbot_pending_sweeper started '
            f'(interval={interval}s age_threshold={age_minutes}min batch_limit={batch_limit})'
        ))

        while not _shutdown_requested:
            try:
                self._scan_cycle(age_minutes, batch_limit)
            except Exception as exc:  # noqa: BLE001
                logger.error('Stale-pending sweeper cycle error: %s', exc, exc_info=True)
            # Sleep với granularity 1s để shutdown nhanh
            for _ in range(interval):
                if _shutdown_requested:
                    break
                time.sleep(1)

        self.stdout.write(self.style.WARNING('chatbot_pending_sweeper stopped'))

    # ── Core cycle ────────────────────────────────────────────────────────

    def _scan_cycle(self, age_minutes: int, batch_limit: int) -> None:
        """Scan 1 cycle: tìm TiktokMessage pending stuck → reconcile."""
        from datetime import timedelta  # noqa: PLC0415
        from chatbot.models import TiktokMessage, TiktokMessageDeliveryStatus  # noqa: PLC0415

        threshold = timezone.now() - timedelta(minutes=age_minutes)

        stale_qs = (
            TiktokMessage.objects
            .select_related('source_task')
            .filter(
                delivery_status=TiktokMessageDeliveryStatus.PENDING,
                created_at__lt=threshold,
            )
            .order_by('created_at')[:batch_limit]
        )

        scanned = 0
        swept = 0
        for row in stale_qs:
            scanned += 1
            try:
                if self._reconcile(row, age_minutes):
                    swept += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    'Sweeper reconcile failed for row id=%s: %s',
                    row.id, exc, exc_info=True,
                )

        if scanned:
            logger.info(
                'Sweeper cycle done: scanned=%s swept=%s (age_threshold=%smin)',
                scanned, swept, age_minutes,
            )
        else:
            logger.debug('Sweeper cycle: no stale pending rows')

    def _reconcile(self, row, age_minutes: int) -> bool:
        """Reconcile 1 row pending dựa vào task status. Trả True nếu UPDATE."""
        from chatbot.models import TiktokMessageDeliveryStatus  # noqa: PLC0415

        age_min = (timezone.now() - row.created_at).total_seconds() / 60
        task = row.source_task

        if task is None:
            new_status = TiktokMessageDeliveryStatus.UNKNOWN
            reason = f'Stale pending swept (no source_task, age={age_min:.1f}min)'
        else:
            task_status = (task.status or '').lower()
            if task_status in ('failed', 'cancelled'):
                # Task chết → likely Kafka task_status mất hoặc worker crash trước publish
                new_status = TiktokMessageDeliveryStatus.FAILED
                reason = (
                    f'Stale pending swept (task={task.id} status={task_status}, '
                    f'age={age_min:.1f}min)'
                )
            elif task_status == 'completed':
                # Task xong nhưng row vẫn pending → Kafka update mất / parser trả UNKNOWN
                new_status = TiktokMessageDeliveryStatus.UNKNOWN
                reason = (
                    f'Stale pending swept (task={task.id} completed nhưng Kafka update mất, '
                    f'age={age_min:.1f}min)'
                )
            else:
                # RUNNING / PENDING / PENDING_APPROVAL quá lâu → conservative set UNKNOWN
                new_status = TiktokMessageDeliveryStatus.UNKNOWN
                reason = (
                    f'Stale pending swept (task={task.id} stuck status={task_status}, '
                    f'age={age_min:.1f}min)'
                )

        row.delivery_status = new_status
        row.error_reason = reason[:1000]
        row.save(update_fields=['delivery_status', 'error_reason'])

        logger.info(
            'Sweeper UPDATE pending → %s row=%s task=%s peer=%r age=%.1fmin',
            new_status, row.id,
            task.id if task else None,
            row.peer_handle[:30], age_min,
        )
        return True
