"""Background sweeper — force_flush các buffer kẹt sau khi timeout.

Vấn đề: `AdaptiveMessageBuffer` (Phase 2.2) chờ LLM scorer / heuristic ≥ 0.82
mới flush. Nếu user gõ 1 tin ngắn ambiguous (vd "chị muốn tư vấn nâng ngực")
→ LLM judge "có thể gõ tiếp" → score 0.3 → buffer HOLD mãi.

Sweeper này chạy mỗi N giây, scan toàn bộ peer buffers:
  - Nếu `elapsed = now - first_message_time > adaptive_timeout(msg_count)` (5/4/3/3s)
  - → `force_flush()` → dispatch_event(DEVICE_NOTIFY) để fire WorkflowTrigger
  - → Bot reply ngay cả khi user dừng gõ sau 1 tin

Wire docker-compose.dev.yml: service `chatbot_buffer_sweeper` chạy command này
như background long-running process.

Usage:
    python manage.py run_chatbot_buffer_sweeper
    python manage.py run_chatbot_buffer_sweeper --interval 1.0
"""
from __future__ import annotations

import json
import logging
import signal
import time

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from chatbot.buffer import (
    BufferConfig,
    _meta_key,
    _msgs_key,
    get_adaptive_timeout,
    get_buffer,
)

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 1.0
_shutdown_requested = False


def _on_signal(signum, frame):  # noqa: ARG001
    global _shutdown_requested  # noqa: PLW0603
    logger.info('Sweeper: shutdown signal %s received', signum)
    _shutdown_requested = True


class Command(BaseCommand):
    help = 'Background sweeper force_flush stuck TikTok DM buffers (Phase 2.3 defer item).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--interval', type=float, default=DEFAULT_INTERVAL_SECONDS,
            help=f'Sleep giữa 2 lần scan (giây). Default: {DEFAULT_INTERVAL_SECONDS}.',
        )

    def handle(self, *args, **opts):
        interval = float(opts['interval'])
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _on_signal)
            except (ValueError, OSError):
                pass

        self.stdout.write(self.style.SUCCESS(
            f'chatbot_buffer_sweeper started (interval={interval}s)'
        ))

        # Lazy import — dispatch_event needs apps ready
        from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event
        from devices.models import Device

        config = BufferConfig()
        buffer = get_buffer()
        r = buffer._redis()  # noqa: SLF001 — reuse redis client từ buffer

        while not _shutdown_requested:
            try:
                self._scan_once(r, buffer, config, dispatch_event,
                                SystemEvent, EventSourceType, Device)
            except Exception as exc:  # noqa: BLE001
                logger.error('Sweeper scan error: %s', exc, exc_info=True)
            time.sleep(interval)

        self.stdout.write(self.style.WARNING('chatbot_buffer_sweeper stopped'))

    # ── core scan ──────────────────────────────────────────────────────────

    def _scan_once(self, r, buffer, config, dispatch_event,
                   SystemEvent, EventSourceType, Device):
        """Scan all `tiktok:buffer:meta:*` keys → force_flush nếu timeout."""
        now = time.time()
        meta_keys = r.keys('tiktok:buffer:meta:*')
        if not meta_keys:
            return

        for meta_key in meta_keys:
            try:
                self._maybe_flush(r, buffer, meta_key, now, config,
                                  dispatch_event, SystemEvent, EventSourceType, Device)
            except Exception as exc:  # noqa: BLE001
                logger.warning('Sweeper: flush failed for %s: %s', meta_key, exc, exc_info=True)

    def _maybe_flush(self, r, buffer, meta_key, now, config,
                     dispatch_event, SystemEvent, EventSourceType, Device):
        meta_raw = r.get(meta_key)
        if not meta_raw:
            return
        try:
            meta = json.loads(meta_raw)
        except (ValueError, TypeError):
            return

        msg_count = int(meta.get('msg_count') or 0)
        if msg_count == 0:
            return

        first_time = float(meta.get('first_message_time') or now)
        elapsed = now - first_time
        timeout = get_adaptive_timeout(msg_count)

        if elapsed <= timeout:
            return  # chưa đủ thời gian, đợi

        # Parse meta_key: tiktok:buffer:meta:{device_id}:{peer_handle}
        parts = meta_key.split(':', 4)
        if len(parts) < 5:
            return
        try:
            device_id = int(parts[3])
        except (ValueError, TypeError):
            return
        peer_handle = parts[4]

        # Force flush + dispatch event
        flushed_msgs = buffer.force_flush(device_id=device_id, peer_handle=peer_handle)
        if not flushed_msgs:
            return

        combined_content = '\n'.join(flushed_msgs)

        # Build history (sync) để pass vào trigger_payload
        history = self._build_history_sync(device_id, peer_handle)

        # Lookup device để có identifier
        try:
            device = Device.objects.get(pk=device_id)
        except Device.DoesNotExist:
            logger.warning('Sweeper: device=%s not found, skip dispatch', device_id)
            return

        payload = {
            'identifier': device.identifier or '',
            'notification_type': 'tiktok_buffer_sweeper',
            'event_type': 'tiktok_dm',
            'peer_handle': peer_handle,
            'content': combined_content,
            'history': history,
            'flushed_message_count': len(flushed_msgs),
            'event_source_id': device.id,
            'sweeper_reason': f'timeout {elapsed:.1f}s > {timeout}s (msg_count={msg_count})',
        }

        logger.info(
            'Sweeper FLUSH device=%s peer=%s msgs=%s elapsed=%.1fs timeout=%.1fs',
            device_id, peer_handle, msg_count, elapsed, timeout,
        )

        try:
            dispatch_event(
                SystemEvent.DEVICE_NOTIFY,
                EventSourceType.DEVICE,
                device_id,
                payload,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error('Sweeper dispatch_event failed: %s', exc, exc_info=True)

    def _build_history_sync(self, device_id: int, peer_handle: str, limit: int = 10) -> str:
        """Thin wrapper — delegate sang `chatbot.services.history.build_history_string`."""
        try:
            from devices.models import Device  # noqa: PLC0415
            from chatbot.services.history import build_history_string  # noqa: PLC0415
            device = Device.objects.filter(pk=device_id).first()
            if device is None:
                return ''
            return build_history_string(device, peer_handle, limit=limit)
        except Exception as exc:  # noqa: BLE001
            logger.debug('Sweeper build_history failed: %s', exc)
            return ''
