"""Redis Streams wrapper cho Workflow Engine (Phase 2.1 Chatbot TikTok).

3 stream + 1 consumer-group-per-stream:

| Stream                | Producer                            | Consumer group           |
|-----------------------|-------------------------------------|--------------------------|
| `workflow:runs`       | `handle_event_triggers` (existing)  | `workflow-runner-group`  |
| `workflow:resume`     | `kafka-task-status-listener`        | `workflow-runner-group`  |
| `workflow:runs:dlq`   | `workflow-runner` (after max retry) | `dlq-handler-group`      |

Lý do dùng Redis Streams thay vì Channels worker (Update 7 — Option B chốt):
- Pending list + autoclaim built-in cho fault tolerance
- Consumer group native — scale ngang nhiều worker
- Copy pattern proven từ chatbot prod (`core-chat/redis_stream_consumer.py`)

Xem `docs/Chatbot_Tiktok/design.md` mục 7 cho thiết kế chi tiết.
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Any

import redis
from django.conf import settings

logger = logging.getLogger(__name__)


# ── Stream + group names ─────────────────────────────────────────────────────
# Constants — KHÔNG đổi tên runtime (consumer group đã commit offset theo tên).

STREAM_RUNS = 'workflow:runs'
STREAM_RESUME = 'workflow:resume'
STREAM_DLQ = 'workflow:runs:dlq'

GROUP_RUNNER = 'workflow-runner-group'
GROUP_DLQ = 'dlq-handler-group'

# Stream layer retry policy (Update 7 — Q5 Lớp 1).
# Idle > 5 phút = message stuck (worker crashed mid-process) → autoclaim.
MIN_IDLE_TIME_MS = 5 * 60 * 1000
# Sau 5 lần claim mà vẫn fail → đẩy DLQ.
MAX_DELIVERY_COUNT = 5

# Stream trim — giữ ~100k entry mỗi stream để tránh phình Redis. XADD MAXLEN
# approximate (`~`) cho performance (Redis docs khuyến nghị).
STREAM_MAXLEN = 100_000


# ── Client (lazy + thread-safe) ──────────────────────────────────────────────

_client_lock = threading.Lock()
_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """Process-wide Redis client (sync, decode_responses=True)."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = redis.Redis.from_url(
                    settings.REDIS_URL, decode_responses=True
                )
    return _client


# ── Init: ensure stream + consumer group tồn tại ─────────────────────────────


def ensure_groups(client: redis.Redis | None = None) -> None:
    """Tạo 3 stream (nếu chưa) và 3 consumer group (idempotent).

    Gọi từ:
    - `apps.py` ready() khi backend khởi động (production runtime)
    - Pre-run init của workflow-runner / dlq-handler process

    XGROUP CREATE với MKSTREAM=True → tạo cả stream nếu chưa tồn tại.
    Nếu group đã có sẵn → bắt BUSYGROUP error, ignore.
    """
    r = client or get_redis()
    groups = [
        (STREAM_RUNS, GROUP_RUNNER),
        (STREAM_RESUME, GROUP_RUNNER),
        (STREAM_DLQ, GROUP_DLQ),
    ]
    for stream, group in groups:
        try:
            r.xgroup_create(name=stream, groupname=group, id='$', mkstream=True)
            logger.info('Created Redis stream group: %s on %s', group, stream)
        except redis.exceptions.ResponseError as exc:
            if 'BUSYGROUP' in str(exc):
                logger.debug('Group %s on %s already exists, skip', group, stream)
            else:
                logger.error(
                    'Failed to create group %s on %s: %s', group, stream, exc
                )
                raise


# ── Producer helpers ─────────────────────────────────────────────────────────


def xadd_run(workflow_run_id: int, *, client: redis.Redis | None = None) -> str:
    """Publish workflow:runs — báo workflow-runner pickup `WorkflowRun(PENDING)`.

    Gọi từ `handle_event_triggers` (sửa existing) sau khi `WorkflowRun.objects.create`.

    Args:
        workflow_run_id: PK của WorkflowRun row vừa tạo.

    Returns:
        Redis message id (vd `1707892834-0`).
    """
    r = client or get_redis()
    msg_id = r.xadd(
        STREAM_RUNS,
        {'workflow_run_id': str(workflow_run_id)},
        maxlen=STREAM_MAXLEN,
        approximate=True,
    )
    logger.info('XADD %s workflow_run_id=%s → %s', STREAM_RUNS, workflow_run_id, msg_id)
    return msg_id


def xadd_resume(
    workflow_run_id: int,
    command_id: str,
    result: dict[str, Any],
    *,
    client: redis.Redis | None = None,
) -> str:
    """Publish workflow:resume — đánh thức workflow-runner đang WAITING_TASK.

    Gọi từ `kafka-task-status-listener` khi Kafka task_status arrive với
    matching `command_id`.

    Args:
        workflow_run_id: PK WorkflowRun đang WAITING_TASK.
        command_id: UUID str đã set trong WorkflowRun.pending_command_id.
        result: dict serialize được JSON (status, outcome, error, ...).
    """
    r = client or get_redis()
    msg_id = r.xadd(
        STREAM_RESUME,
        {
            'workflow_run_id': str(workflow_run_id),
            'command_id': command_id,
            'result': json.dumps(result, ensure_ascii=False),
        },
        maxlen=STREAM_MAXLEN,
        approximate=True,
    )
    logger.info(
        'XADD %s workflow_run_id=%s command_id=%s → %s',
        STREAM_RESUME, workflow_run_id, command_id, msg_id,
    )
    return msg_id


def xadd_dlq(
    workflow_run_id: int,
    reason: str,
    last_error: str = '',
    *,
    client: redis.Redis | None = None,
) -> str:
    """Publish workflow:runs:dlq — dead-letter cho run đã vượt max retry.

    Gọi từ workflow-runner khi retry_count > MAX_DELIVERY_COUNT.
    """
    r = client or get_redis()
    msg_id = r.xadd(
        STREAM_DLQ,
        {
            'workflow_run_id': str(workflow_run_id),
            'reason': reason,
            'last_error': last_error[:2000],  # cap để tránh huge entry
        },
        maxlen=STREAM_MAXLEN,
        approximate=True,
    )
    logger.warning(
        'XADD DLQ workflow_run_id=%s reason=%s → %s',
        workflow_run_id, reason, msg_id,
    )
    return msg_id


# ── Consumer helpers ─────────────────────────────────────────────────────────


def xreadgroup_block(
    consumer_name: str,
    streams: dict[str, str],
    *,
    group: str = GROUP_RUNNER,
    count: int = 10,
    block_ms: int = 5000,
    client: redis.Redis | None = None,
) -> list:
    """Block read từ 1 hoặc nhiều stream cho 1 consumer.

    Args:
        consumer_name: định danh consumer instance (vd hostname-pid).
        streams: dict `{stream_name: last_id}` — `'>'` = chỉ message mới chưa
            deliver cho group này; cụ thể ID = catch up.
        block_ms: timeout milliseconds (0 = block forever).

    Returns:
        List `[(stream_name, [(msg_id, {field: value, ...}), ...]), ...]`.
        Trả về `[]` khi timeout.
    """
    r = client or get_redis()
    try:
        result = r.xreadgroup(
            groupname=group,
            consumername=consumer_name,
            streams=streams,
            count=count,
            block=block_ms,
        )
        return result or []
    except redis.exceptions.ResponseError as exc:
        # NOGROUP — stream chưa init. Caller phải ensure_groups() trước.
        if 'NOGROUP' in str(exc):
            logger.error(
                'NOGROUP error reading streams %s — call ensure_groups() first',
                list(streams.keys()),
            )
        raise


def xack(stream: str, msg_id: str, *, group: str = GROUP_RUNNER, client: redis.Redis | None = None) -> int:
    """Acknowledge 1 message — loại nó khỏi pending list của group."""
    r = client or get_redis()
    return r.xack(stream, group, msg_id)


def xautoclaim_stuck(
    stream: str,
    consumer_name: str,
    *,
    group: str = GROUP_RUNNER,
    min_idle_ms: int = MIN_IDLE_TIME_MS,
    count: int = 10,
    client: redis.Redis | None = None,
) -> list:
    """Claim message stuck > `min_idle_ms` (worker crashed mid-process).

    Trả về list `[(msg_id, {field: value, ...}), ...]` cho consumer xử lý lại.
    Caller phải tự check delivery count (qua XPENDING) để quyết định DLQ.
    """
    r = client or get_redis()
    # XAUTOCLAIM trả về (next_cursor, claimed_messages, deleted_ids).
    next_cursor, claimed, _deleted = r.xautoclaim(
        name=stream,
        groupname=group,
        consumername=consumer_name,
        min_idle_time=min_idle_ms,
        start_id='0-0',
        count=count,
    )
    if claimed:
        logger.info(
            'XAUTOCLAIM %s by %s: claimed %d stuck messages (next=%s)',
            stream, consumer_name, len(claimed), next_cursor,
        )
    return claimed


def xpending_count(
    stream: str, msg_id: str,
    *, group: str = GROUP_RUNNER, client: redis.Redis | None = None,
) -> int:
    """Trả về delivery count của 1 pending message (số lần đã được deliver).

    Dùng để quyết định: nếu > MAX_DELIVERY_COUNT → đẩy DLQ.
    Trả về 0 nếu message không còn pending (đã ack).
    """
    r = client or get_redis()
    try:
        # XPENDING <stream> <group> IDLE 0 <start> <end> <count> [consumer]
        # Format response: list of [msg_id, consumer, idle_ms, delivery_count].
        entries = r.xpending_range(
            name=stream, groupname=group,
            min=msg_id, max=msg_id, count=1,
        )
        if not entries:
            return 0
        return int(entries[0].get('times_delivered', 0))
    except redis.exceptions.ResponseError as exc:
        logger.warning('XPENDING failed for %s/%s: %s', stream, msg_id, exc)
        return 0


# ── Health / debug ───────────────────────────────────────────────────────────


def stream_stats(client: redis.Redis | None = None) -> dict[str, dict]:
    """Trả về depth + pending count cho mỗi stream — cho /api/internal/health."""
    r = client or get_redis()
    stats = {}
    for stream, group in [
        (STREAM_RUNS, GROUP_RUNNER),
        (STREAM_RESUME, GROUP_RUNNER),
        (STREAM_DLQ, GROUP_DLQ),
    ]:
        try:
            length = r.xlen(stream)
            groups_info = r.xinfo_groups(stream)
            group_stats = next(
                (g for g in groups_info if g.get('name') == group), None
            )
            stats[stream] = {
                'length': length,
                'group': group,
                'pending': group_stats.get('pending', 0) if group_stats else 0,
                'last_delivered_id': group_stats.get('last-delivered-id', '') if group_stats else '',
            }
        except redis.exceptions.ResponseError:
            # Stream chưa tồn tại
            stats[stream] = {'length': 0, 'group': group, 'pending': 0, 'error': 'no_stream'}
    return stats
