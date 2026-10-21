from __future__ import annotations

import logging
import re
from collections.abc import Mapping

from django.db.models import Q
from django.utils import timezone

from workflow.models import RunStatus, TriggeredBy, WorkflowStatus, WorkflowRun, WorkflowTrigger

logger = logging.getLogger(__name__)


# Chatbot TikTok (Phase 2.5.x — revise Q4.b followup) ─────────────────────────
# `event_filter` extend MongoDB-style operators để trigger match flexible hơn.
# Backward compat: equality scalar value vẫn work y như cũ.
#
# Syntax:
#     {"event_type": "tiktok_dm"}                  ← equality (cũ)
#     {"content": {"$regex": "giá|báo giá"}}       ← regex (mặc định case-insensitive)
#     {"event_type": {"$in": ["tiktok_dm", "tiktok_comment_single"]}}
#     {"peer_handle": {"$exists": true}}           ← True = có giá trị non-empty
#     {"sender": {"$contains": "BS"}}              ← substring (case-insensitive)
#     {"event_type": {"$ne": "tiktok_marketing"}}
#     {"peer_handle": {"$not": {"$regex": "^Moon ơi"}}}  ← negate nested
#
# Implicit AND giữa các top-level key.
# Dot-notation cho nested payload: `{"payload.tag": "app_notify_ame"}`.
#
# Operators KHÔNG hỗ trợ MVP: $or, $and explicit, $gt/$lte cho number/timestamp.
# Có thể thêm sau nếu cần (Phase L).

_REGEX_FLAGS = re.IGNORECASE


def _resolve_path(payload: object, key: str) -> object:
    """Truy cập dot-path qua dict/list lồng nhau.

    `'event_type'`         → payload['event_type']
    `'payload.tag'`        → payload['payload']['tag']
    `'history.0.content'`  → payload['history'][0]['content']

    Trả về None nếu path không tồn tại / type không khớp.
    """
    parts = key.split('.')
    cur: object = payload
    for part in parts:
        if isinstance(cur, Mapping):
            cur = cur.get(part)
        elif isinstance(cur, (list, tuple)):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
        if cur is None:
            return None
    return cur


def _is_operator_dict(value: object) -> bool:
    """True nếu value là dict có ít nhất 1 key bắt đầu `$` → operator condition."""
    return isinstance(value, dict) and any(
        isinstance(k, str) and k.startswith('$') for k in value
    )


def _match_condition(actual: object, condition: object) -> bool:
    """Match `actual` value với `condition`.

    - Scalar / list / dict KHÔNG có $-key → equality compare
    - Dict CÓ $-key → apply operators (AND giữa các operator trong dict)
    """
    if not _is_operator_dict(condition):
        return actual == condition

    assert isinstance(condition, dict)  # for type checker
    for op, op_arg in condition.items():
        if not _check_operator(actual, op, op_arg):
            return False
    return True


def _check_operator(actual: object, op: str, op_arg: object) -> bool:
    """Apply 1 operator. Unknown op → log warning + return True (forward compat)."""
    if op == '$regex':
        if not isinstance(actual, str) or not isinstance(op_arg, str):
            return False
        try:
            return bool(re.search(op_arg, actual, _REGEX_FLAGS))
        except re.error as exc:
            logger.warning('Invalid regex %r in event_filter: %s', op_arg, exc)
            return False

    if op == '$in':
        if not isinstance(op_arg, (list, tuple)):
            logger.warning('$in expects list, got %r', type(op_arg).__name__)
            return False
        return actual in op_arg

    if op == '$contains':
        if isinstance(actual, str) and isinstance(op_arg, str):
            return op_arg.lower() in actual.lower()
        if isinstance(actual, (list, tuple)):
            return op_arg in actual
        return False

    if op == '$exists':
        # True = có giá trị non-empty (KHÔNG None, KHÔNG '', KHÔNG empty list/dict)
        is_present = actual is not None and actual != '' and actual != [] and actual != {}
        return bool(op_arg) == is_present

    if op == '$ne':
        return actual != op_arg

    if op == '$not':
        return not _match_condition(actual, op_arg)

    logger.warning('Unknown event_filter operator %r — ignore (forward compat)', op)
    return True


def _event_filter_matches(event_filter: object, payload: Mapping[str, object]) -> bool:
    """Top-level entry point. Implicit AND giữa các key trong event_filter."""
    if not isinstance(event_filter, dict) or not event_filter:
        # Empty filter = match-all. Backward compat với trigger event_filter={}.
        return True
    for key, condition in event_filter.items():
        actual = _resolve_path(payload, key) if isinstance(key, str) else None
        if not _match_condition(actual, condition):
            return False
    return True


def handle_event_triggers(
    event_name: str,
    source_type: str,
    source_id: int,
    payload: Mapping[str, object],
) -> int:
    """Create workflow runs for all active event triggers matching this event.

    TCS-v2: cho phép `event_source_id=NULL` = **broadcast trigger** (match mọi
    source cùng `event_source_type`). Lý do robust với CRUD device — trigger
    KHÔNG bị stale khi user xóa + tạo lại device (id mới).

    Filter device-specific khi cần multi-clinic/multi-device dùng `event_filter`
    với dot-path (vd `{'device_serial': '416H4EFS222CS'}` hoặc
    `{'identifier': 'cf28698d-...'}`) — robust hơn DB id binding.
    """
    qs = (
        WorkflowTrigger.objects.select_related('workflow')
        .filter(
            trigger_type='event',
            is_active=True,
            event_name=event_name,
            event_source_type=source_type,
            workflow__status=WorkflowStatus.ACTIVE,
        )
        .filter(
            Q(event_source_id__isnull=True) | Q(event_source_id=source_id),
        )
    )

    matched_count = 0
    for trigger in qs:
        if not _event_filter_matches(trigger.event_filter, payload):
            continue

        run = WorkflowRun.objects.create(
            workflow=trigger.workflow,
            trigger=trigger,
            triggered_by=TriggeredBy.EVENT,
            status=RunStatus.PENDING,
            trigger_payload=dict(payload),
        )
        trigger.last_triggered_at = timezone.now()
        trigger.save(update_fields=['last_triggered_at', 'updated_at'])

        # Chatbot TikTok (Phase 2.1) — publish workflow:runs để workflow-runner
        # pickup tức thì. Stream layer cũng giúp retry/DLQ qua autoclaim.
        # Degrade gracefully nếu Redis fail (workflow vẫn ở DB với PENDING,
        # có thể recover bằng polling fallback hoặc retry manual).
        try:
            from workflow.streams import xadd_run  # noqa: PLC0415
            xadd_run(run.id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                'Failed to XADD workflow:runs for run=%s (DB row still PENDING): %s',
                run.id, exc, exc_info=True,
            )

        matched_count += 1

    if matched_count:
        logger.info(
            'Event %s (%s:%s) created %s workflow run(s)',
            event_name,
            source_type,
            source_id,
            matched_count,
        )
    return matched_count

