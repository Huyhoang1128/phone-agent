"""Kafka task_status listener — bridge giữa Worker world (Kafka) và Workflow
world (Redis Streams).

Subscribe topic `dev-task_status` (settings.KAFKA_TASK_STATUS_TOPIC). Mỗi
message từ worker chứa `payload.command_id` + `payload.workflow_run_id` nếu
task này được tạo bởi action `CREATE_MOBILE_AGENT_TASK`. Match → XADD vào
`workflow:resume` để đánh thức workflow-runner đang WAITING_TASK.

Bonus: nếu status=completed + content='SENT_CONFIRMED' → tạo TiktokMessage
(direction=OUT) trong DB để UI Inbox hiện reply.

Consumer group `workflow-task-status-listener` — KHÁC group của devices_worker
(`dev-devices-worker`) → cả 2 đều nhận đầy đủ message độc lập.

Xem `docs/Chatbot_Tiktok/design.md` mục 8.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import socket
import time

from django.conf import settings

from workflow import streams

logger = logging.getLogger(__name__)


# ── Config ───────────────────────────────────────────────────────────────────

DEFAULT_CONSUMER_GROUP = 'workflow-task-status-listener'
DEFAULT_CONSUMER_NAME = f'{socket.gethostname()}-{os.getpid()}'


# ── Graceful shutdown ────────────────────────────────────────────────────────

_shutdown_requested = False


def _request_shutdown(signum, frame):
    global _shutdown_requested
    logger.info('Shutdown signal (signum=%s), draining listener...', signum)
    _shutdown_requested = True


def install_signal_handlers():
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _request_shutdown)
        except (ValueError, OSError):
            pass


# ── Message handling ─────────────────────────────────────────────────────────


# TCS-v2 Sprint 3 (#6): regex whole-word marker tránh false positive với
# substring (vd "checking SENT_CONFIRMED state" KHÔNG match). Case-insensitive
# vì worker có thể emit lowercase/mixed case khi log streaming.
_OUTCOME_MARKER_RE = re.compile(
    r'\b(SENT_CONFIRMED|SKIPPED_ALREADY_SENT|FAILED)\b',
    re.IGNORECASE,
)


def parse_agent_outcome(content: str) -> str:
    """Parse status content từ Mobile Agent task_status events.

    Worker publish `content` = log stream chronological từ agent (plan → action
    → result). Trả về marker xuất hiện **CUỐI CÙNG** trong stream → vì đó là
    kết quả cuối cùng.

    TCS-v2 Sprint 3 (#6): refactor regex whole-word + last-marker-wins +
    thêm marker `FAILED` (TCS-v1 cũ thiếu). Xem
    docs/Chatbot_Tiktok/tcs_v2_sprint_3_delivery_unknown_sweeper.md.

    Trả về:
        - 'SENT_CONFIRMED' khi agent xác nhận đã gửi
        - 'SKIPPED_ALREADY_SENT' khi agent phát hiện tin đã có sẵn (idempotent skip)
        - 'FAILED' khi agent báo lỗi rõ ràng (vd "Failed: [bước 12]")
        - 'UNKNOWN' khi không tìm thấy marker chuẩn
    """
    if not content:
        return 'UNKNOWN'
    matches = _OUTCOME_MARKER_RE.findall(content)
    if not matches:
        return 'UNKNOWN'
    # Last-marker-wins: worker log chronological, marker cuối = kết quả cuối.
    last = matches[-1].upper()
    if last in ('SENT_CONFIRMED', 'SKIPPED_ALREADY_SENT', 'FAILED'):
        return last
    return 'UNKNOWN'


# Map outcome string từ worker → TiktokMessageDeliveryStatus.
# - SENT_CONFIRMED + SKIPPED_ALREADY_SENT: cả 2 đều `sent` (khách đã thấy tin)
# - FAILED: `failed` (phone logout, hết pin, app crash)
# - UNKNOWN: `unknown` (parser không tìm được marker)
_OUTCOME_TO_DELIVERY_STATUS = {
    'SENT_CONFIRMED': 'sent',
    'SKIPPED_ALREADY_SENT': 'sent',
    'FAILED': 'failed',
    'UNKNOWN': 'unknown',
}


def maybe_update_outbound_message(body: dict, outcome: str, status: str) -> None:
    """UPDATE row `TiktokMessage(BOT, pending)` → sent/failed/unknown khi worker confirm.

    Hybrid pattern (TCS-v1 OQ-1 C):
    - Row pending đã được insert ở `actions/mobile_agent.py` khi tạo task.
    - Tại đây UPDATE theo `source_task_id` (FK chặt) + outcome map.

    Outcome map:
        SENT_CONFIRMED      → delivery_status='sent'  (worker xác nhận đã gửi)
        SKIPPED_ALREADY_SENT → delivery_status='sent' (khách vẫn thấy tin → coi là sent)
        FAILED              → delivery_status='failed' (worker báo lỗi)
        UNKNOWN             → delivery_status='unknown' (parser không tìm marker)

    Kafka status=failed/cancelled mà outcome='UNKNOWN' → vẫn ghi 'failed' với
    error_reason là content excerpt.
    """
    task_id = body.get('task_id')
    if not task_id:
        return

    try:
        task_id_int = int(task_id)
    except (TypeError, ValueError):
        logger.warning('maybe_update_outbound_message: invalid task_id=%r', task_id)
        return

    # Kafka status terminal khác completed (failed/cancelled) → override outcome thành FAILED.
    if status in ('failed', 'cancelled'):
        effective_outcome = 'FAILED'
    else:
        effective_outcome = outcome or 'UNKNOWN'

    delivery_status = _OUTCOME_TO_DELIVERY_STATUS.get(effective_outcome, 'unknown')

    # Excerpt content cho error_reason (chỉ khi failed/unknown).
    error_reason = ''
    if delivery_status in ('failed', 'unknown'):
        content_excerpt = (body.get('content') or '')[:1000]
        error_reason = f'[outcome={effective_outcome} status={status}] {content_excerpt}'

    try:
        from chatbot.models import TiktokMessage, TiktokMessageDeliveryStatus  # noqa: PLC0415

        update_fields = {'delivery_status': delivery_status}
        if error_reason:
            update_fields['error_reason'] = error_reason

        updated = TiktokMessage.objects.filter(
            source_task_id=task_id_int,
            delivery_status=TiktokMessageDeliveryStatus.PENDING,
        ).update(**update_fields)

        if updated:
            logger.info(
                'Updated TiktokMessage task=%s pending → %s (outcome=%s status=%s)',
                task_id_int, delivery_status, effective_outcome, status,
            )
        else:
            # Không tìm được row pending — workflow KHÔNG insert sớm (vd workflow
            # khác không phải TikTok DM). KHÔNG fallback CREATE (giữ DB sạch).
            logger.debug(
                'maybe_update_outbound_message: no pending row task=%s '
                '(not TikTok DM workflow?)',
                task_id_int,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Failed update TiktokMessage delivery_status task=%s (degraded): %s',
            task_id_int, exc, exc_info=True,
        )


def handle_task_status_message(body: dict) -> None:
    """Xử lý 1 task_status message từ Kafka.

    Schema (theo worker `task_executor.py`):
        {
            "task_id": 12345,
            "device_serial_id": "416H4EFS222CS",
            "status": "processing" | "completed" | "failed" | "cancelled",
            "content": "[plan] ... | [action] ... | Task finished",
            "payload": {
                "agent": "tiktok",
                "command_id": "uuid-v4",
                "workflow_run_id": 42,
                "step_index": 3,
                "peer_handle": "...",
                "reply_text": "...",
                ...
            }
        }
    """
    payload = body.get('payload') or {}
    cmd_id = payload.get('command_id') or ''
    run_id = payload.get('workflow_run_id')
    status = body.get('status') or ''

    # Skip task không thuộc workflow (manual task user tạo từ UI, agent task riêng...).
    if not cmd_id or not run_id:
        return

    # Skip processing events — chỉ resume khi terminal (completed/failed/cancelled).
    if status in ('processing', 'pending', '', None):
        logger.debug(
            'Skip non-terminal task_status (status=%s) for run=%s cmd=%s',
            status, run_id, cmd_id,
        )
        return

    outcome = parse_agent_outcome(body.get('content') or '')
    logger.info(
        'task_status terminal: run=%s cmd=%s status=%s outcome=%s',
        run_id, cmd_id, status, outcome,
    )

    # Hybrid pattern: UPDATE row pending (do `actions/mobile_agent.py` insert)
    # → sent/failed/unknown theo outcome. Áp dụng cho cả status=completed/failed/cancelled.
    maybe_update_outbound_message(body, outcome, status)

    # Đánh thức workflow-runner.
    result = {
        'status': status,
        'outcome': outcome,
        'task_id': body.get('task_id'),
        'content_excerpt': (body.get('content') or '')[:500],
    }
    if status in ('failed', 'cancelled'):
        result['error'] = body.get('content') or 'task failed'

    try:
        run_id_int = int(run_id)
        streams.xadd_resume(run_id_int, cmd_id, result)
    except (ValueError, TypeError) as exc:
        logger.warning('Invalid workflow_run_id=%r, skip resume: %s', run_id, exc)


# ── Main loop ────────────────────────────────────────────────────────────────


def run_forever(
    consumer_group: str = DEFAULT_CONSUMER_GROUP,
    consumer_name: str = DEFAULT_CONSUMER_NAME,
) -> None:
    """Block consume Kafka dev-task_status → bridge sang Redis workflow:resume."""
    from kafka import KafkaConsumer  # noqa: PLC0415

    install_signal_handlers()
    streams.ensure_groups()

    topic = settings.KAFKA_TASK_STATUS_TOPIC
    bootstrap = settings.KAFKA_BOOTSTRAP_SERVERS
    logger.info(
        'kafka-task-status-listener started topic=%s group=%s consumer=%s bootstrap=%s',
        topic, consumer_group, consumer_name, bootstrap,
    )

    # Wrap KafkaConsumer() trong retry loop — fix NoBrokersAvailable lúc startup
    # khi network tới Kafka external (vd localhost:9094) bị jitter.
    # kafka-python `check_version()` probe timeout ~2s → crash → Docker restart.
    # Thay vì restart container, retry ở tầng app với exponential backoff:
    # 5s → 10s → 20s → 30s (max).
    from kafka.errors import NoBrokersAvailable  # noqa: PLC0415

    consumer = None
    backoff_seconds = [5, 10, 20, 30, 30, 30]
    for attempt in range(len(backoff_seconds) + 1):
        if _shutdown_requested:
            logger.warning('Shutdown requested during KafkaConsumer init, abort')
            return
        try:
            consumer = KafkaConsumer(
                topic,
                bootstrap_servers=bootstrap,
                group_id=consumer_group,
                client_id=consumer_name,
                auto_offset_reset='latest',  # Chỉ consume message MỚI khi listener start.
                enable_auto_commit=True,
                auto_commit_interval_ms=5000,
                value_deserializer=lambda v: json.loads(v.decode('utf-8')) if v else {},
                consumer_timeout_ms=5000,  # iter() trả về sau 5s → check shutdown flag.
            )
            break
        except NoBrokersAvailable as exc:
            if attempt >= len(backoff_seconds):
                logger.error(
                    'KafkaConsumer init: NoBrokersAvailable sau %s lần thử — bỏ cuộc',
                    attempt + 1,
                )
                raise
            sleep_s = backoff_seconds[attempt]
            logger.warning(
                'KafkaConsumer init attempt=%s/%s: %s — retry sau %ss',
                attempt + 1, len(backoff_seconds) + 1, exc, sleep_s,
            )
            time.sleep(sleep_s)

    if consumer is None:
        return  # shutdown during retry

    while not _shutdown_requested:
        try:
            for record in consumer:
                if _shutdown_requested:
                    break
                body = record.value or {}
                try:
                    handle_task_status_message(body)
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        'handle_task_status_message crashed (offset=%s): %s',
                        record.offset, exc, exc_info=True,
                    )
                    # Message vẫn được auto-commit — KHÔNG re-deliver. Phase 2.2
                    # cân nhắc thêm manual commit + DLQ topic riêng cho retry.
        except Exception as exc:  # noqa: BLE001
            logger.error('KafkaConsumer loop error: %s — retry sau 5s', exc, exc_info=True)
            time.sleep(5)

    try:
        consumer.close()
    except Exception:  # noqa: BLE001
        pass
    logger.info('kafka-task-status-listener exited gracefully')
