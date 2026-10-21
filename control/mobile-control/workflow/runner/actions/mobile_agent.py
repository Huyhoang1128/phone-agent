"""CREATE_MOBILE_AGENT_TASK action handler — Kafka publish task xuống worker.

Tận dụng:
- `task.models.Task` (DB row) — tạo trước Kafka publish để Workflow có FK tham chiếu.
- `mbcontrol.redis_utils.get_device_worker_id(serial)` lookup `connected_devices_worker`
  hash → biết worker đang giữ device → publish targeted topic.
- `mbcontrol.kafka_utils.send_message` (low-level producer) cho publish thực.

Pattern phỏng `task.views.TaskViewSet.run` (existing) + `kafka_utils.send_task_execution_message`,
nhưng:
- Action handler tạo Task riêng cho workflow (KHÔNG reuse Task có sẵn user tạo)
- Inject `command_id`, `workflow_run_id`, `step_index` vào payload để
  `kafka-task-status-listener` match resume signal.
- Return PAUSED sentinel → runner pause + đợi `workflow:resume`.

Config schema (WorkflowStep.action_config):
    type: CREATE_MOBILE_AGENT_TASK
    agent: tiktok                            # → payload.agent (worker dùng apps/tiktok/)
    duration_minutes: 3                      # → payload.duration_minutes
    goal_template: |                         # NL goal cho Mobile Agent
      Mở app TikTok, vào hộp thư, mở conv với "{{ trigger.peer_handle }}".
      Đọc 3 tin gần nhất. NẾU tin cuối từ bạn (bot) trùng "{{ context.step1.reply_text }}"
         → KHÔNG GỬI, báo SKIPPED_ALREADY_SENT.
      NGƯỢC LẠI → gõ "{{ context.step1.reply_text }}" + send + confirm.
    name_template: 'TikTok DM reply ({{ trigger.peer_handle }})'   # optional
    pause_after: true                        # default true
    require_worker_id: true                  # default true (no broadcast fallback)
    extra_payload:                           # optional — merge vào payload trước publish
      channel: tiktok_dm
      bubble_index: 0
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Any

from django.db import transaction
from django.utils import timezone

from workflow.models import RunStatus
from workflow.runner.executor import PAUSED, register_handler
from workflow.runner.template import render_value

logger = logging.getLogger(__name__)


class MobileAgentConfigError(Exception):
    """Config sai (vd thiếu goal_template, không tìm thấy device, ...)."""


class MobileAgentRetriableError(Exception):
    """Lỗi tạm thời — Kafka unavailable, worker không có mapping. Để stream
    layer retry hoặc human fix."""


@register_handler('CREATE_MOBILE_AGENT_TASK')
def create_mobile_agent_task(step, run, ctx: dict) -> Any:
    """Tạo Task DB + Kafka publish → mark WorkflowRun WAITING_TASK → return PAUSED.

    Workflow-runner sẽ pause sau khi handler return PAUSED. Khi worker xử lý
    task xong và publish `task_status`, kafka-task-status-listener match
    `command_id` ↔ `run.pending_command_id` → XADD `workflow:resume` → runner
    đánh thức + advance sang step kế.
    """
    cfg = step.action_config or {}

    # ── 1. Resolve config + render template ─────────────────────────────────
    goal_template = cfg.get('goal_template') or ''
    if not goal_template:
        raise MobileAgentConfigError(
            f'CREATE_MOBILE_AGENT_TASK step={step.id} thiếu goal_template'
        )

    agent = cfg.get('agent') or 'default'
    duration_minutes = int(cfg.get('duration_minutes') or 3)
    name_template = cfg.get('name_template') or f'Workflow {run.workflow_id} run {run.id} step {step.sort_order}'
    pause_after = cfg.get('pause_after', True)
    require_worker_id = cfg.get('require_worker_id', True)
    extra_payload = cfg.get('extra_payload') or {}

    goal = render_value(goal_template, ctx)
    if not isinstance(goal, str):
        goal = str(goal)
    name = render_value(name_template, ctx)
    extra_payload_rendered = render_value(extra_payload, ctx)
    if not isinstance(extra_payload_rendered, dict):
        extra_payload_rendered = {}

    # ── 2. Resolve device (Device PK + serial) ──────────────────────────────
    device = _resolve_device(step, run, ctx)
    if device is None:
        raise MobileAgentConfigError(
            f'CREATE_MOBILE_AGENT_TASK step={step.id} không tìm thấy device. '
            f'Trigger event_source_id={getattr(run.trigger, "event_source_id", None)}, '
            f'context device_id={ctx.get("device_id")}'
        )

    device_serial = device.device_serial_id or ''
    if not device_serial:
        raise MobileAgentConfigError(
            f'Device pk={device.pk} không có device_serial_id'
        )

    # ── 3. Lookup worker_id từ Redis (connected_devices_worker hash) ────────
    from mbcontrol.redis_utils import get_device_worker_id  # noqa: PLC0415

    worker_id = get_device_worker_id(device_serial)
    if not worker_id and require_worker_id:
        # Mỗi phone chỉ ở 1 worker. Nếu không biết worker → KHÔNG broadcast
        # (an toàn — tránh worker khác giữ phone khác bắt lệnh nhầm). Retry.
        raise MobileAgentRetriableError(
            f'Không tìm thấy worker_id cho device serial={device_serial!r}. '
            f'Phone có thể offline. Sẽ retry qua stream layer autoclaim.'
        )

    # ── 4. Tạo Task DB row + sinh command_id ────────────────────────────────
    command_id = str(uuid.uuid4())

    from task.models import Task, TaskKind, TaskStatus, TaskType  # noqa: PLC0415

    task_payload: dict[str, Any] = {
        'agent': agent,
        'duration_minutes': duration_minutes,
        'command_id': command_id,
        'workflow_run_id': run.id,
        'workflow_id': run.workflow_id,
        'step_id': step.id,
        'step_index': step.sort_order,
        **extra_payload_rendered,
    }

    with transaction.atomic():
        task = Task.objects.create(
            name=str(name)[:255],
            description=goal[:4000],
            task_kind=TaskKind.APP,
            task_type=TaskType.GENERIC,
            status=TaskStatus.RUNNING,
            payload=task_payload,
            device=device,
            device_serial=device_serial,
            owner=run.workflow.owner if run.workflow_id else None,
            team=run.workflow.team if run.workflow_id else None,
        )

        # Set WorkflowRun WAITING_TASK + pending_command_id.
        run.pending_command_id = command_id
        run.status = RunStatus.WAITING_TASK
        run.save(update_fields=['pending_command_id', 'status', 'updated_at'])

        # Insert TiktokMessage(BOT, pending) sớm cho hybrid pattern (TCS-v1 OQ-1 C).
        # Khi worker confirm qua kafka_task_status_listener → UPDATE delivery_status.
        # Skip nếu extra_payload không chứa reply_text+peer_handle (vd workflow khác).
        _maybe_insert_pending_bot_message(
            task=task, device=device, extra_payload=extra_payload_rendered,
        )

    # ── 5. Kafka publish — payload đúng schema worker đọc ───────────────────
    publish_ok = _publish_to_kafka(
        task=task,
        device_serial=device_serial,
        worker_id=worker_id,
        goal=goal,
        agent=agent,
        task_payload=task_payload,
    )
    if not publish_ok:
        # Rollback WAITING_TASK → cho stream layer retry.
        run.pending_command_id = None
        run.status = RunStatus.RUNNING
        run.save(update_fields=['pending_command_id', 'status', 'updated_at'])
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        # Mark row pending → failed (Kafka publish never reached worker).
        _mark_pending_bot_message_failed(
            task=task, reason='Kafka publish failed (worker không reachable)',
        )
        raise MobileAgentRetriableError(
            f'Kafka publish thất bại task={task.id} serial={device_serial} '
            f'worker={worker_id!r}'
        )

    logger.info(
        'CREATE_MOBILE_AGENT_TASK run=%s step=%s task=%s device=%s worker=%s '
        'command_id=%s → PAUSED',
        run.id, step.id, task.id, device_serial, worker_id, command_id,
    )

    # ── 6. Return — PAUSED (đợi resume) hay output dict (sync mode) ────────
    if pause_after:
        return PAUSED
    # Sync mode (rare — Phase L) — return ngay không đợi.
    return {
        'task_id': task.id,
        'command_id': command_id,
        'device_serial': device_serial,
        'worker_id': worker_id,
    }


# ── Helpers ──────────────────────────────────────────────────────────────────


def _compute_idempotency_key(
    *, device_id: int, peer_handle: str, reply_text: str,
    run_id: int, step_idx: int,
) -> str:
    """TCS-v2 Sprint 4 (#1): SHA256 hash 32 chars đầu của components.

    Chống dup khi worker timeout → backend retry tạo task mới (task id khác).
    Cùng `(run, step, device, peer, reply)` → cùng key → DB UniqueConstraint
    chặn INSERT thứ 2 → KHÔNG gửi tin trùng cho khách.

    Separator `\\x00` đảm bảo các component không nhập nhằng (vd peer='a:b' +
    reply='c' KHÔNG đụng peer='a' + reply='b:c').
    """
    key_input = f'{device_id}\x00{peer_handle}\x00{reply_text}\x00{run_id}\x00{step_idx}'
    digest = hashlib.sha256(key_input.encode('utf-8')).hexdigest()
    return digest[:32]


def _maybe_insert_pending_bot_message(*, task, device, extra_payload: dict) -> None:
    """Insert `TiktokMessage(BOT, pending)` cho TikTok DM/Comment workflow.

    Hybrid pattern (TCS-v1): row inserted ngay khi workflow tạo task. Khi worker
    confirm qua Kafka task_status → UPDATE delivery_status thành sent/failed/unknown
    (xem `workflow.runner.kafka_listener.maybe_update_outbound_message`).

    TCS-v2 Sprint 4 (#1): dùng `get_or_create` theo `idempotency_key` thay
    `create` thuần — chống dup khi worker retry tạo task mới.

    Skip nếu:
    - extra_payload không có `peer_handle` (workflow không phải TikTok DM)
    - extra_payload không có `reply_text` (workflow không gửi text)
    - DB insert lỗi (log warning, không block workflow)
    """
    peer_handle = (extra_payload or {}).get('peer_handle') or ''
    reply_text = (extra_payload or {}).get('reply_text') or ''
    if not peer_handle or not reply_text:
        return

    # Extract workflow_run_id + step_index từ task payload (set bởi
    # create_mobile_agent_task ở trên — line 122-131).
    task_payload = task.payload or {}
    run_id = task_payload.get('workflow_run_id') or 0
    step_idx = task_payload.get('step_index') or 0

    idempotency_key = _compute_idempotency_key(
        device_id=device.id,
        peer_handle=peer_handle,
        reply_text=reply_text,
        run_id=int(run_id),
        step_idx=int(step_idx),
    )

    try:
        from chatbot.models import (  # noqa: PLC0415
            TiktokMessage,
            TiktokMessageChannel,
            TiktokMessageDeliveryStatus,
            TiktokMessageSource,
            TiktokMessageType,
        )

        channel = (extra_payload or {}).get('channel') or TiktokMessageChannel.DM
        row, created = TiktokMessage.objects.get_or_create(
            idempotency_key=idempotency_key,
            defaults={
                'device': device,
                'peer_handle': peer_handle,
                'channel': channel,
                'content': reply_text,
                'message_type': TiktokMessageType.BOT,
                'source': TiktokMessageSource.AGENT_SENT,
                'delivery_status': TiktokMessageDeliveryStatus.PENDING,
                'source_task': task,
                'video_id': (extra_payload or {}).get('video_id') or None,
            },
        )
        if created:
            logger.info(
                'Inserted TiktokMessage(BOT, pending) task=%s device=%s peer=%s key=%s',
                task.id, device.id, peer_handle, idempotency_key[:8],
            )
        else:
            logger.info(
                'Skipped dup TiktokMessage task=%s peer=%s key=%s (existing row=%s task=%s)',
                task.id, peer_handle, idempotency_key[:8], row.id, row.source_task_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Insert TiktokMessage pending failed task=%s (degraded): %s',
            task.id, exc, exc_info=True,
        )


def _mark_pending_bot_message_failed(*, task, reason: str) -> None:
    """UPDATE row pending → failed khi Kafka publish rollback. Best-effort."""
    try:
        from chatbot.models import TiktokMessage, TiktokMessageDeliveryStatus  # noqa: PLC0415

        updated = TiktokMessage.objects.filter(
            source_task=task,
            delivery_status=TiktokMessageDeliveryStatus.PENDING,
        ).update(
            delivery_status=TiktokMessageDeliveryStatus.FAILED,
            error_reason=reason[:1000],
        )
        if updated:
            logger.info(
                'Marked TiktokMessage(pending → failed) task=%s reason=%r',
                task.id, reason[:100],
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Mark TiktokMessage failed (degraded): %s', exc, exc_info=True,
        )


def _resolve_device(step, run, ctx: dict):
    """Tìm Device theo (priority):

    1. `ctx['device_id']` (Device PK) — caller chỉ định
    2. `ctx['device_serial']` (string)
    3. **trigger_payload.device_serial** (event payload — TCS-v2: robust với CRUD device)
    4. **trigger_payload.identifier** (event payload — fallback nếu serial empty)
    5. `run.trigger.event_source_id` (Device PK — legacy, có thể NULL nếu broadcast)
    6. `run.workflow.device` (Workflow.device FK — legacy)

    TCS-v2 (2026-06-09): thêm priority 3+4 vì broadcast trigger (event_source_id=NULL)
    cần resolve device qua payload thay vì DB PK binding. Payload chứa serial +
    identifier do `chatbot/internal_views.py:_dispatch_and_respond` expose top-level.
    """
    from devices.models import Device  # noqa: PLC0415

    # 1. context device_id (PK)
    ctx_device_id = ctx.get('device_id')
    if ctx_device_id:
        try:
            device = Device.objects.filter(pk=int(ctx_device_id)).first()
            if device:
                return device
        except (TypeError, ValueError):
            pass

    # 2. context device_serial
    ctx_device_serial = ctx.get('device_serial')
    if ctx_device_serial:
        device = Device.objects.filter(device_serial_id=ctx_device_serial).first()
        if device:
            return device

    # 3+4. trigger_payload — event payload (TCS-v2)
    payload = run.trigger_payload or {}
    payload_serial = (payload.get('device_serial') or '').strip()
    if payload_serial:
        device = Device.objects.filter(device_serial_id=payload_serial).first()
        if device:
            return device
    payload_identifier = (payload.get('identifier') or '').strip()
    if payload_identifier:
        device = Device.objects.filter(identifier=payload_identifier).first()
        if device:
            return device

    # 5. trigger event_source_id (Device PK — legacy, có thể NULL nếu broadcast)
    if run.trigger and run.trigger.event_source_id:
        device = Device.objects.filter(pk=run.trigger.event_source_id).first()
        if device:
            return device

    # 6. workflow.device FK
    if run.workflow.device_id:
        device = Device.objects.filter(pk=run.workflow.device_id).first()
        if device:
            return device

    return None


def _publish_to_kafka(
    *,
    task,
    device_serial: str,
    worker_id: str,
    goal: str,
    agent: str | None,
    task_payload: dict,
) -> bool:
    """Publish Kafka message theo schema worker `task_executor.py` đọc.

    Topic: `<KAFKA_TASK_TOPIC>-<worker_id>` nếu có worker_id, else broadcast.
    Key: device_serial → cùng phone → cùng partition → đúng thứ tự.
    """
    from django.conf import settings  # noqa: PLC0415
    from mbcontrol.kafka_utils import _get_task_topic, send_message  # noqa: PLC0415

    default_topic = _get_task_topic()  # đọc settings.KAFKA_TASK_TOPIC
    topic = f'{default_topic}-{worker_id}' if worker_id else default_topic

    message = {
        'task_id': task.id,
        'name': task.name,
        'description': task.description,
        'task_type': task.task_type,
        'status': task.status,
        'payload': task_payload,
        'goal': goal,
        'app': agent if agent and agent != 'default' else None,
        'device_serial_id': device_serial,
    }

    return send_message(topic, message, key=device_serial)
