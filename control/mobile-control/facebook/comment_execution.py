"""Sequenced execution of a Facebook scheduled-post comment cluster.

Port of ``tiktok.execution`` for FB scheduled-post comment plans. A *cluster* is
one opener comment (``reply_to == ''``) plus its replies (``reply_to ==
opener.comment_content``), grouped by ``scheduled_post`` + ``owner``.

Why a fetch-link step
---------------------
Facebook does NOT let an account copy the permalink of its OWN comment. So after
the opener is posted, a DIFFERENT account in the cluster opens the post, locates
the opener comment (by author + text) and copies its link (worker skill
``facebook_find_comment_link``). That link is stored on the opener plan's
``comment_link`` and every reply then deep-links straight to it. If a fetcher
account fails to copy the link, we retry with ANOTHER account in the cluster
(up to ``CLUSTER_RETRY_LIMIT``); only after exhausting accounts do we fall back
to locating the opener by text.

Flow: opener → fetch-link (other account) → reply #1 → reply #2 → …  Each step is
driven by the phoneagent task-status callback (``advance_after_member`` /
``handle_fetch_link_status``).
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from task.models import Task, TaskStatus, TaskType

from .models import FacebookScheduledPostCommentPlan

logger = logging.getLogger(__name__)

CLUSTER_RETRY_LIMIT = 3
# Minimum gap between consecutive posted comments in a cluster (opener → reply #1
# → reply #2 …) so they look like a natural conversation, not a burst. The poll
# (every 30s) dispatches the next reply only once this much time has passed since
# the previous comment finished. The invisible fetch-link step runs right after
# the opener (no delay) so the link is ready in time.
CLUSTER_DELAY_MINUTES = 5
_ExecStatus = FacebookScheduledPostCommentPlan.ExecutionStatus


# ── cluster shape helpers ────────────────────────────────────────────────────

def _resolve_cluster_root(plan: FacebookScheduledPostCommentPlan) -> FacebookScheduledPostCommentPlan:
    # Stable FK first — immune to comment edits / text drift.
    if plan.root_plan_id:
        return plan.root_plan
    # Legacy fallback (rows created before the root_plan FK): match by text.
    reply_to = (plan.reply_to or '').strip()
    if not reply_to:
        return plan
    root = (
        FacebookScheduledPostCommentPlan.objects.filter(
            scheduled_post_id=plan.scheduled_post_id,
            owner_id=plan.owner_id,
            reply_to='',
            comment_content=reply_to,
        )
        .order_by('created_at', 'id')
        .first()
    )
    return root or plan


def _list_cluster_plans(root: FacebookScheduledPostCommentPlan) -> list[FacebookScheduledPostCommentPlan]:
    plans = [root]
    seen = {root.id}
    # New: replies linked by the stable root_plan FK.
    for reply in (
        root.replies
        .select_related('actor_fb_profile', 'device')
        .order_by('created_at', 'id')
    ):
        if reply.id not in seen:
            plans.append(reply)
            seen.add(reply.id)
    # Legacy fallback: replies matched by text (rows without the FK), de-duped.
    root_content = (root.comment_content or '').strip()
    if root_content:
        for reply in (
            FacebookScheduledPostCommentPlan.objects.filter(
                scheduled_post_id=root.scheduled_post_id,
                owner_id=root.owner_id,
                reply_to=root_content,
            )
            .exclude(id=root.id)
            .select_related('actor_fb_profile', 'device')
            .order_by('created_at', 'id')
        ):
            if reply.id not in seen:
                plans.append(reply)
                seen.add(reply.id)
    return plans


def _resolve_fetch_link_plan(
    root: FacebookScheduledPostCommentPlan,
    cluster: list[FacebookScheduledPostCommentPlan],
    tried_device_ids: list[int] | None = None,
) -> FacebookScheduledPostCommentPlan | None:
    """Pick a reply plan on a DIFFERENT device than the opener (and not already
    tried) to go copy the opener's comment link. None when no candidate left."""
    tried = set(tried_device_ids or [])
    for reply in cluster[1:]:
        if reply.device_id and reply.device_id != root.device_id and reply.device_id not in tried:
            return reply
    return None


def _mark_cluster_failed(cluster, *, from_index: int, reason: str) -> None:
    to_update = []
    for plan in cluster[from_index:]:
        if plan.execution_status == _ExecStatus.COMPLETED or plan.is_commented:
            continue
        plan.execution_status = _ExecStatus.FAILED
        if not plan.execution_last_error:
            plan.execution_last_error = reason
        to_update.append(plan)
    if to_update:
        FacebookScheduledPostCommentPlan.objects.bulk_update(
            to_update, ['execution_status', 'execution_last_error', 'updated_at']
        )


# ── dispatch helpers ─────────────────────────────────────────────────────────

def _dispatch_member(plan: FacebookScheduledPostCommentPlan):
    """Dispatch a comment/reply plan via the shared dispatcher (lazy import to
    avoid a circular import with facebook.views)."""
    from .views import _dispatch_fb_comment_plan_task, TransientPublishError
    try:
        return _dispatch_fb_comment_plan_task(plan)
    except (ValueError, TransientPublishError) as exc:
        plan.execution_status = _ExecStatus.FAILED
        plan.execution_last_error = str(exc)[:500]
        plan.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])
        logger.warning('FB cluster: dispatch plan #%s failed: %s', plan.id, exc)
        return None


def _extract_comment_url(task: Task) -> str:
    result = task.result
    if isinstance(result, dict):
        return (result.get('comment_url') or result.get('comment_link') or '').strip()
    if isinstance(result, list):
        for item in reversed(result):
            if isinstance(item, dict) and (item.get('comment_url') or item.get('comment_link')):
                return (item.get('comment_url') or item.get('comment_link') or '').strip()
    return ''


def _create_fetch_link_task(
    root: FacebookScheduledPostCommentPlan,
    cluster: list[FacebookScheduledPostCommentPlan],
    *,
    retry_count: int = 0,
    tried_device_ids: list[int] | None = None,
):
    """Dispatch a task to a DIFFERENT account that opens the post, finds the
    opener comment and copies its link. Falls back to text-based replies when no
    other account is available."""
    from mbcontrol.kafka_utils import send_task_execution_message

    tried = list(tried_device_ids or [])
    fetcher = _resolve_fetch_link_plan(root, cluster, tried)
    if fetcher is None or fetcher.actor_fb_profile is None or not fetcher.device_id:
        logger.info('FB cluster root #%s: no fetcher account left — schedule replies by text.', root.id)
        _schedule_next_reply(cluster)
        return None

    post = root.scheduled_post
    post_url = (root.post_link or (post.fb_post_id if post else '') or '').strip()
    root_author = root.actor_fb_profile.account_name if root.actor_fb_profile else ''
    snippet = (root.comment_content or '')[:200]
    fetcher_actor = fetcher.actor_fb_profile.account_name or ''
    goal = (
        f'Vào facebook {fetcher_actor}, mở bài đăng {post_url}, tìm bình luận của '
        f'"{root_author}" (đoạn text: "{snippet}"), long-press và Sao chép liên kết '
        f'của bình luận đó.'
    )
    task = Task.objects.create(
        name=f'FB fetch comment link — cluster root #{root.id} via {fetcher_actor}',
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'seed_fetch_comment_link',
            'fb_cluster_root_plan_id': root.id,
            'fb_scheduled_post_id': post.id if post else None,
            'fetcher_plan_id': fetcher.id,
            'fetcher_device_id': fetcher.device_id,
            'fetch_link_retry_count': retry_count,
            'tried_device_ids': tried,
            'post_url': post_url,
            'root_author': root_author,
            'root_snippet': snippet,
        },
        device_id=fetcher.device_id,
        owner=root.owner or (post.owner if post else None),
    )
    delivered = send_task_execution_message(task, devices_id=[fetcher.device_id])
    if not delivered:
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        logger.warning('FB cluster root #%s: fetch-link Kafka dispatch failed.', root.id)
        _retry_fetch_link(root, cluster, retry_count=retry_count, tried_device_ids=tried,
                          failed_device_id=fetcher.device_id)
    return task


def _retry_fetch_link(root, cluster, *, retry_count, tried_device_ids, failed_device_id):
    tried = list(tried_device_ids or [])
    if failed_device_id and failed_device_id not in tried:
        tried.append(failed_device_id)
    next_retry = retry_count + 1
    if next_retry <= CLUSTER_RETRY_LIMIT and _resolve_fetch_link_plan(root, cluster, tried) is not None:
        logger.info('FB cluster root #%s: retry fetch-link (#%s) with another account.', root.id, next_retry)
        _create_fetch_link_task(root, cluster, retry_count=next_retry, tried_device_ids=tried)
    else:
        logger.info('FB cluster root #%s: fetch-link exhausted — scheduling replies by text matching '
                    '(delayed).', root.id)
        _schedule_next_reply(cluster)


def _schedule_member(plan: FacebookScheduledPostCommentPlan):
    """Create the reply's task NOW (visible as pending) + a one-shot Schedule that
    runs it after CLUSTER_DELAY_MINUTES. User can press ▶️ to run it earlier."""
    from .views import _dispatch_fb_comment_plan_task, TransientPublishError
    run_at = timezone.now() + timedelta(minutes=CLUSTER_DELAY_MINUTES)
    try:
        return _dispatch_fb_comment_plan_task(plan, run_at=run_at)
    except (ValueError, TransientPublishError) as exc:
        plan.execution_status = _ExecStatus.FAILED
        plan.execution_last_error = str(exc)[:500]
        plan.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])
        logger.warning('FB cluster: schedule plan #%s failed: %s', plan.id, exc)
        return None


def _schedule_next_reply(cluster: list[FacebookScheduledPostCommentPlan]) -> None:
    """Schedule the first not-yet-done reply (replies use root.comment_link if it
    was captured, else fall back to author+text matching in the worker skill).
    The task appears immediately; it runs CLUSTER_DELAY_MINUTES later."""
    for reply in cluster[1:]:
        if reply.execution_status != _ExecStatus.COMPLETED and not reply.is_commented:
            _schedule_member(reply)
            return


# ── public entry points ──────────────────────────────────────────────────────

def execute_cluster(plan: FacebookScheduledPostCommentPlan, *, force_restart: bool = False):
    """Start (or resume) the ordered run for *plan*'s cluster. Returns
    (root, next_plan, task)."""
    root = _resolve_cluster_root(plan)
    cluster = _list_cluster_plans(root)
    if not cluster:
        return root, None, None

    if force_restart:
        for item in cluster:
            item.execution_status = _ExecStatus.IDLE
            item.execution_retry_count = 0
            item.execution_last_error = ''
            item.is_commented = False
            item.save(update_fields=['execution_status', 'execution_retry_count',
                                     'execution_last_error', 'is_commented', 'updated_at'])

    next_plan = None
    for item in cluster:
        if item.execution_status != _ExecStatus.COMPLETED and not item.is_commented:
            next_plan = item
            break
    if next_plan is None:
        return root, None, None

    # Already in flight — don't double-dispatch.
    if not force_restart and next_plan.execution_status in (_ExecStatus.SCHEDULED, _ExecStatus.RUNNING):
        return root, next_plan, None

    # Resuming a reply before the opener link was captured → fetch link first.
    if (next_plan.reply_to or '').strip() and not (root.comment_link or '').strip() and len(cluster) > 1:
        task = _create_fetch_link_task(root, cluster, retry_count=0, tried_device_ids=[])
        return root, root, task

    task = _dispatch_member(next_plan)
    return root, next_plan, task


def advance_after_member(plan: FacebookScheduledPostCommentPlan, new_status: str) -> None:
    """Called after a ``seed_scheduled_comment`` plan's status update has been
    persisted. Advances the cluster: opener done → fetch link; reply done → next
    reply; failure → retry within limit else fail the rest."""
    root = _resolve_cluster_root(plan)
    cluster = _list_cluster_plans(root)
    if len(cluster) <= 1:
        return  # standalone comment — nothing to chain
    ids = [p.id for p in cluster]
    if plan.id not in ids:
        return
    index = ids.index(plan.id)

    if new_status == TaskStatus.COMPLETED:
        if index == 0:
            # Opener posted → fetch its link from another account (runs now, no
            # delay) so it is ready before replies. Replies themselves are
            # dispatched later by the poll, spaced CLUSTER_DELAY_MINUTES apart.
            if not (root.comment_link or '').strip():
                _create_fetch_link_task(root, cluster, retry_count=0, tried_device_ids=[])
            return
        # A reply finished → create the NEXT reply's task now (visible) scheduled to
        # run CLUSTER_DELAY_MINUTES later.
        _schedule_next_reply(cluster)
        return

    if new_status == TaskStatus.FAILED:
        # The base handler already incremented execution_retry_count + set FAILED.
        if (plan.execution_retry_count or 0) <= CLUSTER_RETRY_LIMIT:
            plan.execution_status = _ExecStatus.SCHEDULED
            plan.execution_last_error = 'Task failed — scheduled for retry.'
            plan.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])
            _dispatch_member(plan)
        else:
            _mark_cluster_failed(
                cluster, from_index=index,
                reason=f'Cluster failed at plan #{plan.id} after {CLUSTER_RETRY_LIMIT} retries.',
            )


def handle_fetch_link_status(task: Task, *, old_status: str, new_status: str) -> None:
    """Process completion of a ``seed_fetch_comment_link`` task: store the opener
    link and kick off replies, or retry with another account."""
    if new_status == old_status or new_status not in (TaskStatus.COMPLETED, TaskStatus.FAILED):
        return
    payload = task.payload or {}
    root_id = payload.get('fb_cluster_root_plan_id')
    if not root_id:
        return
    root = FacebookScheduledPostCommentPlan.objects.filter(id=root_id).select_related('scheduled_post').first()
    if not root:
        return
    cluster = _list_cluster_plans(root)
    if len(cluster) <= 1:
        return
    retry_count = payload.get('fetch_link_retry_count', 0) or 0
    tried = list(payload.get('tried_device_ids') or [])
    failed_device_id = payload.get('fetcher_device_id')

    if new_status == TaskStatus.COMPLETED:
        url = _extract_comment_url(task)
        if url:
            root.comment_link = url
            root.execution_status = _ExecStatus.COMPLETED
            root.execution_last_error = ''
            root.save(update_fields=['comment_link', 'execution_status', 'execution_last_error', 'updated_at'])
            logger.info('FB cluster root #%s: captured comment link; scheduling reply #1 (delayed).', root.id)
            _schedule_next_reply(cluster)
        else:
            # Completed but no link captured → retry with another account.
            _retry_fetch_link(root, cluster, retry_count=retry_count,
                              tried_device_ids=tried, failed_device_id=failed_device_id)
        return

    # FAILED
    _retry_fetch_link(root, cluster, retry_count=retry_count,
                      tried_device_ids=tried, failed_device_id=failed_device_id)


# ── Poll-based reconciliation ────────────────────────────────────────────────
# The live task-status consumer (devices_worker) writes task status straight to
# the DB via raw SQL and bypasses DRF ``perform_update`` — so the status hooks
# never fire for device tasks. This poll (run from schedule/scheduler.py every
# ~30s) reconciles finished comment tasks against the cluster state machine.
# It reuses the same handlers and is idempotent: a plan is only acted on while
# it is in flight (SCHEDULED/RUNNING) and its task has reached a terminal state.

def poll_comment_clusters() -> None:
    from .views import handle_fb_scheduled_comment_task_status

    # 1) Opener/reply tasks that finished → mirror plan state + advance the chain.
    in_flight = (
        FacebookScheduledPostCommentPlan.objects
        .filter(execution_status__in=[_ExecStatus.SCHEDULED, _ExecStatus.RUNNING], task__isnull=False)
        .select_related('task')
    )
    for plan in in_flight:
        t = plan.task
        if not t or t.status not in (TaskStatus.COMPLETED, TaskStatus.FAILED):
            continue
        try:
            handle_fb_scheduled_comment_task_status(t, old_status='running', new_status=t.status)
        except Exception:
            logger.exception('poll_comment_clusters: member reconcile failed (task %s)', t.id)

    # 2) Clusters waiting on the opener's link → process the latest fetch-link task.
    waiting_roots = FacebookScheduledPostCommentPlan.objects.filter(
        reply_to='', is_commented=True, comment_link='',
    )
    for root in waiting_roots:
        try:
            cluster = _list_cluster_plans(root)
            if len(cluster) <= 1:
                continue
            # Only while still at the link step (no reply dispatched/posted yet).
            if any(r.execution_status != _ExecStatus.IDLE or r.is_commented for r in cluster[1:]):
                continue
            ft = (
                Task.objects
                .filter(payload__action='seed_fetch_comment_link', payload__fb_cluster_root_plan_id=root.id)
                .order_by('-id')
                .first()
            )
            if ft and ft.status in (TaskStatus.COMPLETED, TaskStatus.FAILED):
                handle_fetch_link_status(ft, old_status='running', new_status=ft.status)
        except Exception:
            logger.exception('poll_comment_clusters: fetch-link reconcile failed (root %s)', root.id)

    # 3) Cancel pending one-shot schedules whose comment task already started/finished
    #    (e.g. user pressed ▶️ to run it early) so the schedule does NOT fire again
    #    and double-post. Only touches FB scheduled-comment tasks. Reaction window
    #    (≤ poll interval, 30s) is well under CLUSTER_DELAY_MINUTES so no double run.
    from schedule.models import Schedule, ScheduleStatus
    active_scheds = (
        Schedule.objects
        .filter(status=ScheduleStatus.ACTIVE, schedule_type='once', task__isnull=False)
        .select_related('task')
        .exclude(task__status=TaskStatus.PENDING)
    )
    for s in active_scheds:
        try:
            if (s.task.payload or {}).get('action') != 'seed_scheduled_comment':
                continue
            s.status = ScheduleStatus.COMPLETED
            s.is_active = False
            s.next_run_at = None
            s.save(update_fields=['status', 'is_active', 'next_run_at', 'updated_at'])
            logger.info('FB cluster: cancelled stale schedule %s (task %s already ran).', s.id, s.task_id)
        except Exception:
            logger.exception('poll_comment_clusters: schedule cleanup failed (schedule %s)', s.id)
