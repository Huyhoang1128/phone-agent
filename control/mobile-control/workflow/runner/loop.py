"""Workflow runner main loop.

Block-read 2 stream `workflow:runs` + `workflow:resume` qua XREADGROUP, dispatch
sang `handle_new_run` / `handle_resume`. Mỗi tick chạy XAUTOCLAIM cho stuck
messages → check delivery count → DLQ nếu vượt max.

Phase 2.1 SKELETON: chỉ load WorkflowRun + execute step (stub return empty).
Phase 2.2 sẽ implement CALL_N8N_WORKFLOW + CREATE_MOBILE_AGENT_TASK handlers.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import time
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from workflow import streams
from workflow.models import RunStatus, WorkflowRun

from .executor import PAUSED, execute_step

logger = logging.getLogger(__name__)


# ── Config ───────────────────────────────────────────────────────────────────

# Tên consumer instance (unique per process — dùng hostname+pid để debug).
DEFAULT_CONSUMER_NAME = f'{socket.gethostname()}-{os.getpid()}'

# Tần suất chạy XAUTOCLAIM (mỗi N giây quét stuck messages).
AUTOCLAIM_INTERVAL_SEC = 30


# ── Graceful shutdown flag ───────────────────────────────────────────────────

_shutdown_requested = False


def _request_shutdown(signum, frame):
    global _shutdown_requested
    logger.info('Shutdown signal received (signum=%s), draining loop...', signum)
    _shutdown_requested = True


def install_signal_handlers():
    """Catch SIGTERM/SIGINT cho graceful shutdown (drain current iter)."""
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _request_shutdown)
        except (ValueError, OSError):
            # Một số môi trường (vd thread không phải main) không cho register.
            pass


# ── Message handlers ─────────────────────────────────────────────────────────


def handle_new_run(msg_data: dict) -> None:
    """Xử lý 1 message từ `workflow:runs` — load WorkflowRun(PENDING) + execute."""
    run_id_raw = msg_data.get('workflow_run_id')
    if not run_id_raw:
        logger.warning('workflow:runs message missing workflow_run_id: %s', msg_data)
        return

    try:
        run_id = int(run_id_raw)
    except (TypeError, ValueError):
        logger.warning('Invalid workflow_run_id=%r, skip', run_id_raw)
        return

    run = WorkflowRun.objects.select_related('workflow').filter(pk=run_id).first()
    if run is None:
        logger.warning('WorkflowRun id=%s not found, skip', run_id)
        return

    # Idempotency: nếu đã COMPLETED/FAILED/CANCELLED → skip (autoclaim duplicate).
    if run.status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.DLQ):
        logger.info('WorkflowRun id=%s already %s, skip', run.id, run.status)
        return

    # Set started_at + RUNNING (nếu vừa PENDING).
    if run.status == RunStatus.PENDING:
        run.status = RunStatus.RUNNING
        run.started_at = timezone.now()
        run.save(update_fields=['status', 'started_at', 'updated_at'])

    _execute_from_current_step(run)


def handle_resume(msg_data: dict) -> None:
    """Xử lý 1 message từ `workflow:resume` — đánh thức run đang WAITING_*."""
    run_id_raw = msg_data.get('workflow_run_id')
    cmd_id_raw = msg_data.get('command_id') or ''
    result_raw = msg_data.get('result') or '{}'

    if not run_id_raw:
        logger.warning('workflow:resume message missing workflow_run_id: %s', msg_data)
        return

    try:
        run_id = int(run_id_raw)
    except (TypeError, ValueError):
        return

    run = WorkflowRun.objects.select_related('workflow').filter(pk=run_id).first()
    if run is None:
        logger.warning('Resume: WorkflowRun id=%s not found', run_id)
        return

    # Match command_id để tránh stale resume signal (vd run đã cancelled +
    # restart với command_id khác).
    if cmd_id_raw and run.pending_command_id:
        try:
            if UUID(cmd_id_raw) != run.pending_command_id:
                logger.info(
                    'Resume: stale signal (run=%s pending=%s != %s), ignore',
                    run.id, run.pending_command_id, cmd_id_raw,
                )
                return
        except ValueError:
            logger.warning('Resume: invalid command_id=%r', cmd_id_raw)
            return

    # Parse result + ghi vào context dưới step{current_step_index}_output
    try:
        result_data = json.loads(result_raw)
    except (ValueError, TypeError):
        result_data = {'raw': result_raw}

    step_key = f'step{run.current_step_index}_output'
    with transaction.atomic():
        run.refresh_from_db()
        run.context[step_key] = result_data
        run.pending_command_id = None
        # Nếu result báo failed → advance vào fail handler (Phase 2.2 sẽ design
        # chi tiết). Phase 2.1: cứ continue step kế.
        run.current_step_index += 1
        run.status = RunStatus.RUNNING
        run.save(update_fields=[
            'context', 'pending_command_id', 'current_step_index',
            'status', 'updated_at',
        ])

    _execute_from_current_step(run)


def _build_ctx(run: WorkflowRun) -> dict:
    """Build structured context cho template render.

    Layout:
        {
            'trigger': {...run.trigger_payload...},
            'context': {
                'step0': {...output step 0...},
                'step1': {...},
                ...
            },
        }

    Note: WorkflowRun.context lưu format `{'step0_output': {...}, 'step1_output': {...}}`.
    Ta strip suffix `_output` → expose `step0`, `step1` cho template ngắn gọn:
    `{{ context.step1.reply_text }}` thay vì `{{ context.step1_output.reply_text }}`.
    """
    step_outputs: dict[str, dict] = {}
    for key, value in (run.context or {}).items():
        # Strip `_output` suffix nếu có cho template ngắn gọn.
        if key.endswith('_output'):
            step_outputs[key[:-len('_output')]] = value or {}
        else:
            step_outputs[key] = value or {}
    return {
        'trigger': dict(run.trigger_payload or {}),
        'context': step_outputs,
    }


def _execute_from_current_step(run: WorkflowRun) -> None:
    """Loop execute step từ `current_step_index` cho đến hết hoặc PAUSED/exception."""
    steps = list(run.workflow.steps.order_by('sort_order'))
    while run.current_step_index < len(steps):
        step = steps[run.current_step_index]
        # Structured ctx — template ref qua `{{ trigger.X }}` / `{{ context.stepN.Y }}`.
        ctx = _build_ctx(run)

        try:
            result = execute_step(step, run, ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                'WorkflowRun %s step %s failed: %s', run.id, step.id, exc,
            )
            run.last_error = f'step {step.sort_order}: {exc}'[:5000]
            run.save(update_fields=['last_error', 'updated_at'])
            raise  # propagate → stream layer NACK → autoclaim retry

        if result == PAUSED:
            logger.info(
                'WorkflowRun %s paused at step %s (waiting external signal)',
                run.id, step.id,
            )
            return  # KHÔNG advance current_step_index — resume handler sẽ advance

        # Step success — ghi output vào context, advance.
        step_key = f'step{run.current_step_index}_output'
        run.context[step_key] = result if isinstance(result, dict) else {'value': result}
        run.current_step_index += 1
        run.save(update_fields=['context', 'current_step_index', 'updated_at'])

    # Hết step → COMPLETED.
    run.status = RunStatus.COMPLETED
    run.finished_at = timezone.now()
    run.save(update_fields=['status', 'finished_at', 'updated_at'])
    logger.info('WorkflowRun %s COMPLETED', run.id)


# ── Autoclaim + DLQ ──────────────────────────────────────────────────────────


def autoclaim_and_dlq(consumer_name: str) -> int:
    """Quét stuck messages trên 2 stream. Nếu delivery_count > MAX → DLQ.

    Trả về số message được DLQ (cho metric).
    """
    dlqed = 0
    for stream_name in (streams.STREAM_RUNS, streams.STREAM_RESUME):
        claimed = streams.xautoclaim_stuck(stream_name, consumer_name)
        for msg_id, data in claimed:
            count = streams.xpending_count(stream_name, msg_id)
            if count > streams.MAX_DELIVERY_COUNT:
                # Đẩy DLQ + ack original để loại khỏi pending.
                run_id_raw = data.get('workflow_run_id', '')
                try:
                    run_id = int(run_id_raw)
                except (TypeError, ValueError):
                    run_id = 0
                streams.xadd_dlq(
                    workflow_run_id=run_id,
                    reason=f'max_delivery_exceeded ({count}/{streams.MAX_DELIVERY_COUNT})',
                    last_error=f'stream={stream_name} msg={msg_id}',
                )
                streams.xack(stream_name, msg_id)
                # Cũng update DB WorkflowRun thành DLQ.
                if run_id:
                    WorkflowRun.objects.filter(pk=run_id).update(
                        status=RunStatus.DLQ,
                        last_error=f'Stream DLQ — max deliveries {count}',
                    )
                dlqed += 1
                logger.warning(
                    'DLQ run_id=%s stream=%s msg=%s delivery_count=%s',
                    run_id, stream_name, msg_id, count,
                )
    return dlqed


# ── Main loop ────────────────────────────────────────────────────────────────


def run_forever(consumer_name: str = DEFAULT_CONSUMER_NAME) -> None:
    """Block consume + process — return khi nhận SIGTERM/SIGINT."""
    install_signal_handlers()
    streams.ensure_groups()
    logger.info('workflow-runner started (consumer=%s)', consumer_name)

    last_autoclaim = 0.0

    while not _shutdown_requested:
        # 1. Autoclaim stuck mỗi AUTOCLAIM_INTERVAL_SEC.
        now = time.monotonic()
        if now - last_autoclaim > AUTOCLAIM_INTERVAL_SEC:
            try:
                autoclaim_and_dlq(consumer_name)
            except Exception as exc:  # noqa: BLE001
                logger.warning('autoclaim_and_dlq failed: %s', exc, exc_info=True)
            last_autoclaim = now

        # 2. Block read 2 stream.
        try:
            batches = streams.xreadgroup_block(
                consumer_name=consumer_name,
                streams={
                    streams.STREAM_RUNS: '>',
                    streams.STREAM_RESUME: '>',
                },
                block_ms=5000,
                count=10,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error('xreadgroup_block failed: %s — retry sau 5s', exc, exc_info=True)
            time.sleep(5)
            continue

        # 3. Dispatch + ack.
        for stream_name, entries in batches:
            for msg_id, data in entries:
                try:
                    if stream_name == streams.STREAM_RUNS:
                        handle_new_run(data)
                    elif stream_name == streams.STREAM_RESUME:
                        handle_resume(data)
                    streams.xack(stream_name, msg_id)
                except Exception as exc:  # noqa: BLE001
                    # KHÔNG xack — stream layer sẽ autoclaim sau MIN_IDLE_TIME_MS.
                    logger.error(
                        'Handler crashed (stream=%s msg=%s): %s — message stays pending',
                        stream_name, msg_id, exc, exc_info=True,
                    )

    logger.info('workflow-runner exited gracefully')
