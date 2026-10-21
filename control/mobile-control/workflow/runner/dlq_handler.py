"""DLQ handler — consume `workflow:runs:dlq` để log + alert workflow run đã chết.

Phase 2.1 SKELETON: chỉ log structured + đảm bảo `WorkflowRun.status=DLQ` trong DB.
Phase 2.2 sẽ mở rộng:
- Push notify user qua WebSocket / email
- Slack alert nếu chạm threshold (vd > 10 DLQ/giờ)
- UI button "Retry manual" gọi back vào workflow:runs

Xem `docs/Chatbot_Tiktok/design.md` mục 11 Lớp 6.
"""
from __future__ import annotations

import logging
import os
import signal
import socket
import time

from workflow import streams
from workflow.models import RunStatus, WorkflowRun

logger = logging.getLogger(__name__)


DEFAULT_CONSUMER_NAME = f'{socket.gethostname()}-{os.getpid()}'


# ── Graceful shutdown ────────────────────────────────────────────────────────

_shutdown_requested = False


def _request_shutdown(signum, frame):
    global _shutdown_requested
    logger.info('Shutdown signal (signum=%s), draining dlq-handler...', signum)
    _shutdown_requested = True


def install_signal_handlers():
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _request_shutdown)
        except (ValueError, OSError):
            pass


# ── Handle ───────────────────────────────────────────────────────────────────


def handle_dlq_message(msg_data: dict) -> None:
    """Log DLQ entry + ensure WorkflowRun.status=DLQ."""
    run_id_raw = msg_data.get('workflow_run_id', '')
    reason = msg_data.get('reason', 'unknown')
    last_error = msg_data.get('last_error', '')

    try:
        run_id = int(run_id_raw)
    except (TypeError, ValueError):
        logger.error('DLQ msg invalid workflow_run_id=%r reason=%s', run_id_raw, reason)
        return

    # Structured log — sẵn sàng cho log aggregator (CloudWatch/Loki) parse.
    logger.error(
        'WORKFLOW_DLQ run_id=%s reason=%s last_error=%s',
        run_id, reason, last_error[:500],
    )

    # Ensure DB row marked DLQ (workflow-runner đã update khi đẩy DLQ, nhưng
    # safety net cho race condition).
    if run_id:
        WorkflowRun.objects.filter(pk=run_id).exclude(status=RunStatus.DLQ).update(
            status=RunStatus.DLQ,
            last_error=f'DLQ: {reason} | {last_error[:1000]}',
        )

    # Phase 2.2: push notify user + Slack alert ở đây.


# ── Main loop ────────────────────────────────────────────────────────────────


def run_forever(consumer_name: str = DEFAULT_CONSUMER_NAME) -> None:
    install_signal_handlers()
    streams.ensure_groups()
    logger.info('dlq-handler started (consumer=%s)', consumer_name)

    while not _shutdown_requested:
        try:
            batches = streams.xreadgroup_block(
                consumer_name=consumer_name,
                streams={streams.STREAM_DLQ: '>'},
                group=streams.GROUP_DLQ,
                block_ms=5000,
                count=10,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error('dlq xreadgroup failed: %s — retry sau 5s', exc, exc_info=True)
            time.sleep(5)
            continue

        for stream_name, entries in batches:
            for msg_id, data in entries:
                try:
                    handle_dlq_message(data)
                    streams.xack(stream_name, msg_id, group=streams.GROUP_DLQ)
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        'dlq handle crashed (msg=%s): %s — message stays pending',
                        msg_id, exc, exc_info=True,
                    )

    logger.info('dlq-handler exited gracefully')
