from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from profiles.models import Profile
from schedule.models import Schedule, ScheduleType
from task.models import Task, TaskKind, TaskStatus, TaskType

from .models import TiktokCommentPlan

CLUSTER_RETRY_LIMIT = 3
CLUSTER_DELAY_MINUTES = 5
TASK_PAYLOAD_CLUSTER_KEY = 'tiktok_comment_plan_cluster_execution'

def _resolve_cluster_root(plan: TiktokCommentPlan) -> TiktokCommentPlan:
    reply_to = (plan.reply_to or '').strip()
    if not reply_to:
        return plan
    root = (
        TiktokCommentPlan.objects.filter(
            video_id=plan.video_id,
            owner_id=plan.owner_id,
            reply_to='',
            comment_content=reply_to,
        )
        .order_by('created_at', 'id')
        .first()
    )
    return root or plan

def _list_cluster_plans(root: TiktokCommentPlan) -> list[TiktokCommentPlan]:
    root_content = (root.comment_content or '').strip()
    plans = [root]
    if not root_content:
        return plans
    replies = list(
        TiktokCommentPlan.objects.filter(
            video_id=root.video_id,
            owner_id=root.owner_id,
            reply_to=root_content,
        )
        .exclude(id=root.id)
        .order_by('created_at', 'id')
    )
    plans.extend(replies)
    return plans


def _mark_cluster_failed(plans: list[TiktokCommentPlan], *, from_index: int, reason: str) -> None:
    to_update: list[TiktokCommentPlan] = []
    for plan in plans[from_index:]:
        plan.execution_status = TiktokCommentPlan.ExecutionStatus.FAILED
        if not plan.execution_last_error:
            plan.execution_last_error = reason
        to_update.append(plan)
    if to_update:
        TiktokCommentPlan.objects.bulk_update(to_update, ['execution_status', 'execution_last_error', 'updated_at'])


def _resolve_plan_profile(plan: TiktokCommentPlan) -> Profile | None:
    if plan.profile_id:
        return Profile.objects.filter(id=plan.profile_id).first()
    if not plan.device_id:
        return None
    return Profile.objects.filter(device_id=plan.device_id).order_by('id').first()


def _resolve_fetch_link_plan(
    root_plan: TiktokCommentPlan,
    cluster_plans: list[TiktokCommentPlan],
) -> TiktokCommentPlan:
    for reply_plan in cluster_plans[1:]:
        if reply_plan.device_id and reply_plan.device_id != root_plan.device_id:
            return reply_plan
    return cluster_plans[1]


def _create_execution_task_for_plan(
    plan: TiktokCommentPlan,
    *,
    root_plan_id: int,
    cluster_index: int,
    cluster_size: int,
    run_at,
) -> Task:
    profile = _resolve_plan_profile(plan)
    if profile and not plan.profile_id:
        plan.profile = profile
    video_url = plan.video_link or plan.video.video_url or ''
    is_reply = bool((plan.reply_to or '').strip())
    payload = {
        'agent': 'tiktok',
        'video_url': video_url,
        'comment_content': plan.comment_content,
        'reply_to': plan.reply_to or '',
        'device_id': plan.device_id,
        TASK_PAYLOAD_CLUSTER_KEY: True,
        'comment_plan_id': plan.id,
        'cluster_root_plan_id': root_plan_id,
        'cluster_index': cluster_index,
        'cluster_size': cluster_size,
    }
    if profile:
        payload['profile_id'] = profile.id

    if is_reply:
        root_comment_link = (
            TiktokCommentPlan.objects.filter(id=root_plan_id)
            .values_list('comment_link', flat=True)
            .first() or ''
        )
        if root_comment_link:
            payload['root_comment_link'] = root_comment_link
            description = (
                f'Hãy mở tiktok và trả lời bình luận có link "{root_comment_link}" '
                f'với nội dung {plan.comment_content}'
            )
        else:
            description = (
                f'Hãy mở tiktok và trả lời bình luận "{plan.reply_to}" '
                f'trong video {video_url} với nội dung {plan.comment_content}'
            )
    else:
        description = f'Hãy mở tiktok và bình luận vào video {video_url} với nội dung {plan.comment_content}'
    task = Task.objects.create(
        name=f'TikTok cluster comment plan #{plan.id}',
        description=description,
        task_type=TaskType.GENERIC,
        task_kind=TaskKind.APP,
        status=TaskStatus.PENDING,
        payload=payload,
        device_id=plan.device_id,
        device_serial=plan.device.device_serial_id if plan.device_id and plan.device else '',
        owner=plan.owner,
    )
    Schedule.objects.create(
        task=task,
        profile=profile,
        schedule_type=ScheduleType.ONCE,
        run_at=run_at,
        next_run_at=run_at,
    )
    plan.execution_status = TiktokCommentPlan.ExecutionStatus.SCHEDULED
    plan.execution_last_error = ''
    update_fields = ['execution_status', 'execution_last_error', 'updated_at']
    if profile and not plan.profile_id:
        update_fields.append('profile')
    plan.save(update_fields=update_fields)
    return task


def _create_fetch_link_task(
    root_plan: TiktokCommentPlan,
    cluster_plans: list[TiktokCommentPlan],
    *,
    retry_count: int = 0,
) -> Task:
    fetch_plan = _resolve_fetch_link_plan(root_plan, cluster_plans)
    profile = _resolve_plan_profile(fetch_plan)
    root_profile = _resolve_plan_profile(root_plan)
    tag_name = root_profile.name if root_profile else ''
    video_url = root_plan.video_link or root_plan.video.video_url or ''
    run_at = timezone.now() + timedelta(minutes=CLUSTER_DELAY_MINUTES)
    payload = {
        'agent': 'tiktok',
        TASK_PAYLOAD_CLUSTER_KEY: True,
        'is_fetch_link': True,
        'comment_plan_id': root_plan.id,
        'cluster_root_plan_id': root_plan.id,
        'fetch_link_retry_count': retry_count,
        'video_url': video_url,
        'comment_content': root_plan.comment_content,
        'device_id': fetch_plan.device_id,
    }
    if profile:
        payload['profile_id'] = profile.id
    task = Task.objects.create(
        name=f'TikTok fetch comment link for plan #{root_plan.id}',
        description=(
            f'Đi vào link video này {video_url} '
            f'tìm cho tôi comment "{root_plan.comment_content}" '
            f'của tag "{tag_name}"'
        ),
        task_type=TaskType.GENERIC,
        task_kind=TaskKind.APP,
        status=TaskStatus.PENDING,
        payload=payload,
        device_id=fetch_plan.device_id,
        device_serial=fetch_plan.device.device_serial_id if fetch_plan.device_id and fetch_plan.device else '',
        owner=root_plan.owner,
    )
    Schedule.objects.create(
        task=task,
        profile=profile,
        schedule_type=ScheduleType.ONCE,
        run_at=run_at,
        next_run_at=run_at,
    )
    return task


def execute_cluster(plan: TiktokCommentPlan, *, force_restart: bool = False) -> tuple[TiktokCommentPlan, TiktokCommentPlan | None, Task | None]:
    root = _resolve_cluster_root(plan)
    cluster_plans = _list_cluster_plans(root)
    if not cluster_plans:
        return root, None, None

    if force_restart:
        for item in cluster_plans:
            item.execution_status = TiktokCommentPlan.ExecutionStatus.IDLE
            item.execution_retry_count = 0
            item.execution_last_error = ''
            item.is_commented = False
            item.save(update_fields=['execution_status', 'execution_retry_count', 'execution_last_error', 'is_commented', 'updated_at'])

    next_index = None
    for index, item in enumerate(cluster_plans):
        if item.execution_status != TiktokCommentPlan.ExecutionStatus.COMPLETED and not item.is_commented:
            next_index = index
            break
    if next_index is None:
        return root, None, None

    next_plan = cluster_plans[next_index]
    task = _create_execution_task_for_plan(
        next_plan,
        root_plan_id=root.id,
        cluster_index=next_index,
        cluster_size=len(cluster_plans),
        run_at=timezone.now(),
    )
    return root, next_plan, task


def handle_task_status_update(task: Task, *, old_status: str, new_status: str) -> None:
    payload = task.payload if isinstance(task.payload, dict) else {}
    if not payload.get(TASK_PAYLOAD_CLUSTER_KEY):
        return

    if payload.get('is_fetch_link'):
        plan_id = payload.get('comment_plan_id')
        if not isinstance(plan_id, int):
            return
        root = TiktokCommentPlan.objects.filter(id=plan_id, owner=task.owner).select_related('video', 'device', 'owner').first()
        if not root:
            return
        cluster_plans = _list_cluster_plans(root)
        if len(cluster_plans) <= 1:
            return
        if new_status == TaskStatus.COMPLETED:
            root.execution_status = TiktokCommentPlan.ExecutionStatus.COMPLETED
            root.execution_last_error = ''
            root.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])
            _create_execution_task_for_plan(
                cluster_plans[1],
                root_plan_id=root.id,
                cluster_index=1,
                cluster_size=len(cluster_plans),
                run_at=timezone.now(),
            )
        elif new_status == TaskStatus.FAILED:
            retry_count = payload.get('fetch_link_retry_count', 0)
            if not isinstance(retry_count, int):
                retry_count = 0
            if retry_count < CLUSTER_RETRY_LIMIT:
                _create_fetch_link_task(root, cluster_plans, retry_count=retry_count + 1)
            else:
                root.execution_status = TiktokCommentPlan.ExecutionStatus.FAILED
                root.execution_last_error = 'Fetch link failed after max retries.'
                root.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])
                _mark_cluster_failed(
                    cluster_plans,
                    from_index=1,
                    reason=f'Cluster failed: could not fetch comment link for plan #{root.id}.',
                )
        return

    plan_id = payload.get('comment_plan_id')
    root_plan_id = payload.get('cluster_root_plan_id')
    if not isinstance(plan_id, int) or not isinstance(root_plan_id, int):
        return

    plan = TiktokCommentPlan.objects.filter(id=plan_id, owner=task.owner).select_related('video', 'device', 'owner').first()
    root = TiktokCommentPlan.objects.filter(id=root_plan_id, owner=task.owner).select_related('video', 'device', 'owner').first()
    if not plan or not root:
        return

    cluster_plans = _list_cluster_plans(root)
    cluster_plan_ids = [item.id for item in cluster_plans]
    if plan.id not in cluster_plan_ids:
        return
    current_index = cluster_plan_ids.index(plan.id)

    if new_status == TaskStatus.RUNNING:
        if plan.execution_status != TiktokCommentPlan.ExecutionStatus.COMPLETED and not plan.is_commented:
            plan.execution_status = TiktokCommentPlan.ExecutionStatus.RUNNING
            plan.save(update_fields=['execution_status', 'updated_at'])
        return

    if old_status == new_status:
        return

    if new_status == TaskStatus.COMPLETED:
        next_index = current_index + 1
        has_replies = next_index < len(cluster_plans)

        if current_index == 0 and has_replies:
            plan.is_commented = True
            plan.execution_last_error = ''
            plan.save(update_fields=['is_commented', 'execution_last_error', 'updated_at'])
            _create_fetch_link_task(plan, cluster_plans, retry_count=0)
            return

        plan.execution_status = TiktokCommentPlan.ExecutionStatus.COMPLETED
        plan.execution_last_error = ''
        plan.save(update_fields=['execution_status', 'execution_last_error', 'updated_at'])

        if not has_replies:
            return
        next_plan = cluster_plans[next_index]
        if next_plan.execution_status == TiktokCommentPlan.ExecutionStatus.COMPLETED:
            return
        _create_execution_task_for_plan(
            next_plan,
            root_plan_id=root.id,
            cluster_index=next_index,
            cluster_size=len(cluster_plans),
            run_at=timezone.now() + timedelta(minutes=CLUSTER_DELAY_MINUTES),
        )
        return

    if new_status != TaskStatus.FAILED:
        return

    if plan.execution_status == TiktokCommentPlan.ExecutionStatus.COMPLETED or plan.is_commented:
        return

    plan.execution_retry_count += 1
    if plan.execution_retry_count <= CLUSTER_RETRY_LIMIT:
        plan.execution_status = TiktokCommentPlan.ExecutionStatus.SCHEDULED
        plan.execution_last_error = 'Task failed. Scheduled for retry.'
        plan.save(update_fields=['execution_retry_count', 'execution_status', 'execution_last_error', 'updated_at'])
        _create_execution_task_for_plan(
            plan,
            root_plan_id=root.id,
            cluster_index=current_index,
            cluster_size=len(cluster_plans),
            run_at=timezone.now() + timedelta(minutes=CLUSTER_DELAY_MINUTES),
        )
        return

    plan.execution_status = TiktokCommentPlan.ExecutionStatus.FAILED
    plan.execution_last_error = 'Retry limit exceeded.'
    plan.save(update_fields=['execution_retry_count', 'execution_status', 'execution_last_error', 'updated_at'])
    _mark_cluster_failed(
        cluster_plans,
        from_index=current_index + 1,
        reason=f'Cluster failed at plan #{plan.id} after {CLUSTER_RETRY_LIMIT} retries.',
    )
