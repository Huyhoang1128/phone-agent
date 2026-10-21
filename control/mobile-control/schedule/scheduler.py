"""
APScheduler-backed scheduler engine.

The scheduler is started once when the Django application boots (via
ScheduleConfig.ready()).  It polls the database every 30 seconds for schedules
that are due to run and executes them.

For ``once`` schedules  : run the task at run_at and mark completed.
For ``interval`` schedules: run repeatedly every interval_seconds.
For ``cron`` schedules   : run according to the cron expression.

Retry logic
-----------
If the simulated task execution "fails" and retry_count < max_retries,
the next_run_at is set to now + retry_delay_seconds and retry_count is
incremented; otherwise the schedule is marked failed.
"""

import logging
import threading
from datetime import datetime, timezone, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from croniter import croniter

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None
_lock = threading.Lock()

def _drain_device_task_queue() -> None:
    """Send QUEUED phoneagent tasks to their device once it is free.

    Every FB device task that hit a busy device is parked as QUEUED (by
    ``task.device_lock.dispatch_or_queue``) instead of flooding the phone. This
    poll drains the queue: at most one task per device per tick, oldest first,
    as soon as the device's current task finishes (or its lease expires).
    """
    import django
    django.setup()  # noqa

    from task.models import Task, TaskStatus
    from task.device_lock import device_is_busy
    from mbcontrol.kafka_utils import send_task_execution_message

    queued = (
        Task.objects
        .filter(status=TaskStatus.QUEUED)
        .exclude(device_id__isnull=True)
        .order_by('device_id', 'created_at')
    )
    handled: set = set()
    for task in queued:
        dev = task.device_id
        if dev in handled:
            continue  # one per device per tick — the oldest queued task wins
        handled.add(dev)
        if device_is_busy(dev, exclude_task_id=task.id):
            continue  # still busy → leave QUEUED for the next tick
        delivered = send_task_execution_message(task, devices_id=[dev])
        if delivered:
            task.status = TaskStatus.RUNNING
            task.save(update_fields=['status', 'updated_at'])
            logger.info('Drain: sent queued task %s to device %s', task.id, dev)
        else:
            logger.warning('Drain: Kafka not delivered for queued task %s', task.id)


def _compute_next_run(schedule) -> datetime | None:
    """Return the next datetime a schedule should fire."""
    from .models import ScheduleType
    now = datetime.now(tz=timezone.utc)
    if schedule.schedule_type == ScheduleType.ONCE:
        return schedule.run_at
    if schedule.schedule_type == ScheduleType.INTERVAL:
        if schedule.interval_seconds:
            return now + timedelta(seconds=schedule.interval_seconds)
    if schedule.schedule_type == ScheduleType.CRON:
        if schedule.cron_expression:
            try:
                cron = croniter(schedule.cron_expression, now)
                return cron.get_next(datetime).replace(tzinfo=timezone.utc)
            except Exception:
                logger.exception("Invalid cron expression: %s", schedule.cron_expression)
    return None


def _execute_schedule(schedule_id: int) -> None:
    """
    Run a single schedule.  This is the function called by APScheduler.
    In a real implementation the task type would dispatch to a specific
    handler; here we simulate success/failure based on the task payload.
    """
    import django
    django.setup()  # noqa – safe to call multiple times after first call

    from django.utils import timezone as dj_tz
    from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event
    from mbcontrol.kafka_utils import send_task_execution_message
    from .models import Schedule, ScheduleStatus, ExecutionStatus
    from task.models import TaskStatus

    try:
        schedule = Schedule.objects.select_related('task').get(pk=schedule_id)
    except Schedule.DoesNotExist:
        logger.warning("Schedule %s no longer exists", schedule_id)
        return

    if not schedule.is_active or schedule.status == ScheduleStatus.PAUSED:
        return

    execution = schedule.executions.create()
    payload = {
        'schedule_id': schedule.id,
        'execution_id': execution.id,
        'task_id': schedule.task_id,
        'schedule_type': schedule.schedule_type,
    }
    if schedule.task.device_id:
        dispatch_event(SystemEvent.SCHEDULE_RUN, EventSourceType.DEVICE, schedule.task.device_id, payload)
    if schedule.task.team_id:
        dispatch_event(SystemEvent.SCHEDULE_RUN, EventSourceType.TEAM, schedule.task.team_id, payload)
    if schedule.task.owner_id:
        dispatch_event(SystemEvent.SCHEDULE_RUN, EventSourceType.USER, schedule.task.owner_id, payload)

    dispatch_device_ids: list[int] = []
    if schedule.profile and schedule.profile.device_id:
        dispatch_device_ids = [schedule.profile.device_id]
    elif schedule.task.device_id:
        dispatch_device_ids = [schedule.task.device_id]

    delivered = send_task_execution_message(
        schedule.task,
        devices_id=dispatch_device_ids,
        profile_id=schedule.profile_id,
    )

    finished_at = dj_tz.now()

    if not delivered:
        execution.result_status = ExecutionStatus.FAILURE
        execution.error_message = 'Failed to dispatch Kafka message for scheduled task execution'
        execution.finished_at = finished_at
        execution.save()

        schedule.task.status = TaskStatus.FAILED
        schedule.task.save(update_fields=['status', 'updated_at'])

        if schedule.retry_count < schedule.max_retries:
            schedule.retry_count += 1
            schedule.last_run_at = finished_at
            schedule.next_run_at = finished_at + timedelta(seconds=schedule.retry_delay_seconds)
            schedule.save(update_fields=['retry_count', 'last_run_at', 'next_run_at', 'updated_at'])
            logger.info(
                "Schedule %s failed; retrying (%s/%s) at %s",
                schedule_id, schedule.retry_count, schedule.max_retries, schedule.next_run_at,
            )
        else:
            schedule.status = ScheduleStatus.FAILED
            schedule.last_run_at = finished_at
            schedule.next_run_at = None
            schedule.save(update_fields=['status', 'last_run_at', 'next_run_at', 'updated_at'])
            logger.warning("Schedule %s failed after all retries", schedule_id)
    else:
        execution.result_status = ExecutionStatus.SUCCESS
        execution.finished_at = finished_at
        execution.save()

        schedule.task.status = TaskStatus.RUNNING
        schedule.task.save(update_fields=['status', 'updated_at'])

        from .models import ScheduleType
        if schedule.schedule_type == ScheduleType.ONCE:
            schedule.status = ScheduleStatus.COMPLETED
            schedule.next_run_at = None
        else:
            schedule.next_run_at = _compute_next_run(schedule)

        schedule.retry_count = 0
        schedule.last_run_at = finished_at
        schedule.save(update_fields=['status', 'next_run_at', 'retry_count', 'last_run_at', 'updated_at'])

        logger.info("Schedule %s executed successfully", schedule_id)


def _poll_schedules() -> None:
    """Poll the DB for due schedules and enqueue their execution."""
    import django
    django.setup()  # noqa

    from django.utils import timezone as dj_tz
    from .models import Schedule, ScheduleStatus

    now = dj_tz.now()
    due = Schedule.objects.filter(
        is_active=True,
        status=ScheduleStatus.ACTIVE,
        next_run_at__lte=now,
    ).select_related('task')

    for schedule in due:
        logger.debug("Triggering schedule %s", schedule.pk)
        _execute_schedule(schedule.pk)


def _poll_tiktok_channel_video_understand() -> None:
    import django
    django.setup()  # noqa

    from tiktok.video_understand import poll_pending_channel_video_understand_tasks

    stats = poll_pending_channel_video_understand_tasks()
    if stats.get('updated', 0):
        logger.info(
            'TikTok understand poll updated %s/%s videos',
            stats.get('updated', 0),
            stats.get('scanned', 0),
        )


def _start_of_today_local():
    """Tz-aware datetime tại 00:00 HÔM NAY theo giờ Việt Nam (Asia/Ho_Chi_Minh).

    Dùng làm CHẶN DƯỚI cho các poll đăng bài theo lịch: bài có ``scheduled_at``
    rơi vào một ngày TRƯỚC hôm nay bị coi là quá hạn → scheduler bỏ qua, KHÔNG
    tự đăng nữa (tránh việc scheduler nghẽn/downtime rồi khi chạy lại đăng dồn
    một loạt bài cũ của các ngày trước). Bài quá hạn giữ nguyên trạng thái
    ``pending`` — người dùng có thể tự bấm "đăng ngay" nếu vẫn muốn đăng. Bài
    hẹn SÁNG NAY mà giờ mới chạy buổi chiều thì vẫn nằm trong [00:00 hôm nay,
    now] nên vẫn được tự đăng bình thường.
    """
    from zoneinfo import ZoneInfo
    from django.utils import timezone as dj_tz
    local_now = dj_tz.now().astimezone(ZoneInfo('Asia/Ho_Chi_Minh'))
    return local_now.replace(hour=0, minute=0, second=0, microsecond=0)


def _poll_facebook_scheduled_posts() -> None:
    import django
    django.setup()  # noqa

    from django.utils import timezone as dj_tz
    from facebook.models import FacebookScheduledPost, FacebookScheduledPostStatus
    from facebook.views import _publish_to_facebook

    now = dj_tz.now()
    # Chặn dưới = 00:00 hôm nay (giờ VN): bài của các ngày trước không tự đăng.
    today_start = _start_of_today_local()
    due_posts = (
        FacebookScheduledPost.objects
        .filter(
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__gte=today_start,
            scheduled_at__lte=now,
        )
        .select_related('page')
        .order_by('scheduled_at', 'id')
    )

    for post in due_posts:
        try:
            _publish_to_facebook(post)
            logger.info('Facebook scheduled post %s published', post.id)
        except Exception:
            logger.exception('Failed to publish Facebook scheduled post %s', post.id)


def _poll_facebook_profile_scheduled_posts() -> None:
    """Mirror of ``_poll_facebook_scheduled_posts`` for the profile-side surface.

    Polls ``FacebookProfileScheduledPost`` (timeline + re-routed-to-group) and
    ``FacebookProfileScheduledMediaAction`` (avatar / cover / story). Each due
    row is dispatched as a phoneagent task; the actual published/failed
    transition happens later via the devices_worker mirror.
    """
    import django
    django.setup()  # noqa

    from django.utils import timezone as dj_tz
    from facebook.models import (
        FacebookProfileScheduledPost,
        FacebookProfileScheduledMediaAction,
        FacebookScheduledPostStatus,
    )
    from facebook.views import (
        _publish_profile_scheduled_to_facebook,
        _publish_profile_scheduled_media_action,
    )

    now = dj_tz.now()
    # Chặn dưới = 00:00 hôm nay (giờ VN): bài của các ngày trước không tự đăng.
    today_start = _start_of_today_local()

    # Each due row is dispatched via dispatch_or_queue: it runs now if the device
    # is free, else it parks as a QUEUED task that _drain_device_task_queue sends
    # later — so a backlog for one phone serialises instead of flooding it.
    due_posts = (
        FacebookProfileScheduledPost.objects
        .filter(
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__gte=today_start,
            scheduled_at__lte=now,
        )
        .select_related('profile')
        .order_by('scheduled_at', 'id')
    )
    for post in due_posts:
        # Atomic claim: flip PENDING→PUBLISHING in a single UPDATE. If 0 rows
        # changed, another poll/process already grabbed it — skip to avoid
        # dispatching a duplicate task.
        claimed = (
            FacebookProfileScheduledPost.objects
            .filter(id=post.id, status=FacebookScheduledPostStatus.PENDING)
            .update(status=FacebookScheduledPostStatus.PUBLISHING)
        )
        if not claimed:
            continue
        try:
            _publish_profile_scheduled_to_facebook(post)
            logger.info('FB profile scheduled post %s dispatched', post.id)
        except Exception:
            logger.exception('Failed to dispatch FB profile scheduled post %s', post.id)

    due_actions = (
        FacebookProfileScheduledMediaAction.objects
        .filter(
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__gte=today_start,
            scheduled_at__lte=now,
        )
        .select_related('profile')
        .order_by('scheduled_at', 'id')
    )
    for action in due_actions:
        try:
            _publish_profile_scheduled_media_action(action)
            logger.info('FB profile media action %s dispatched', action.id)
        except Exception:
            logger.exception('Failed to dispatch FB profile media action %s', action.id)


def _poll_facebook_comment_clusters() -> None:
    """Reconcile FB scheduled-post comment clusters.

    The task-status consumer (devices_worker) updates task rows via raw SQL and
    bypasses the DRF ``perform_update`` hook, so the comment-cluster state
    machine never advances on its own. This poll drives it: finished opener/reply
    tasks → mirror plan state + dispatch the next step; finished fetch-link tasks
    → store the opener link + start replies (or retry with another account)."""
    import django
    django.setup()  # noqa

    from facebook.comment_execution import poll_comment_clusters
    try:
        poll_comment_clusters()
    except Exception:
        logger.exception('Failed to poll FB comment clusters')


def _poll_auto_sync_group_pending_after_publish() -> None:
    """When a FacebookProfileScheduledPost with ``target_group`` flips to
    PUBLISHED, auto-dispatch ``fetch_group_pending_posts`` for that group so the
    new (anonymous) post shows up in the Group pending tab for admin approval.

    Dedupe: skip if any ``fetch_group_pending_posts`` task for that group was
    created in the last 5 min — one sync covers multiple recent publishes, and
    survives scheduler restarts because the lookup is DB-backed.
    """
    import django
    django.setup()  # noqa

    from datetime import timedelta as _td
    from django.utils import timezone as dj_tz
    from facebook.models import FacebookProfileScheduledPost, FacebookScheduledPostStatus
    from facebook.views import _dispatch_fb_group_fetch_pending_task, TransientPublishError
    from task.models import Task

    now = dj_tz.now()
    cutoff = now - _td(minutes=5)

    recent_posts = (
        FacebookProfileScheduledPost.objects
        .filter(
            status=FacebookScheduledPostStatus.PUBLISHED,
            target_group__isnull=False,
            updated_at__gte=cutoff,
        )
        .order_by('target_group_id', '-updated_at')
        .distinct('target_group_id')
        .select_related('target_group')
    )

    for post in recent_posts:
        group = post.target_group
        if group is None:
            continue
        already = Task.objects.filter(
            payload__action='fetch_group_pending_posts',
            payload__fb_group_id=group.id,
            created_at__gte=cutoff,
        ).exists()
        if already:
            continue
        try:
            _dispatch_fb_group_fetch_pending_task(group)
            logger.info(
                'Auto-sync group pending dispatched for group %s after '
                'profile post %s published',
                group.id, post.id,
            )
        except (ValueError, TransientPublishError) as exc:
            logger.warning(
                'Auto-sync group pending failed for group %s: %s',
                group.id, exc,
            )


def _poll_facebook_group_scheduled_posts() -> None:
    """Mirror of ``_poll_facebook_scheduled_posts`` for the group surface.

    Polls ``FacebookGroupScheduledPost`` and dispatches via the poster
    (group.default_poster_fb_profile). is_approved is still gated here
    because the group-centric flow keeps that admin-approval semantic.
    """
    import django
    django.setup()  # noqa

    from django.utils import timezone as dj_tz
    from facebook.models import FacebookGroupScheduledPost, FacebookScheduledPostStatus
    from facebook.views import _publish_group_scheduled_to_facebook

    now = dj_tz.now()
    # Chặn dưới = 00:00 hôm nay (giờ VN): bài của các ngày trước không tự đăng.
    today_start = _start_of_today_local()
    due_posts = (
        FacebookGroupScheduledPost.objects
        .filter(
            status=FacebookScheduledPostStatus.PENDING,
            is_approved=True,
            scheduled_at__gte=today_start,
            scheduled_at__lte=now,
        )
        .select_related('group', 'poster_fb_profile')
        .order_by('scheduled_at', 'id')
    )
    for post in due_posts:
        # dispatch_or_queue serialises per device (runs now or parks as QUEUED).
        try:
            _publish_group_scheduled_to_facebook(post)
            logger.info('FB group scheduled post %s dispatched', post.id)
        except Exception:
            logger.exception('Failed to dispatch FB group scheduled post %s', post.id)


def _poll_website_scheduled_posts() -> None:
    """Publish due Website posts (WordPress) — those PENDING with a scheduled_at
    in the past. Posting is a synchronous HTTP call to the site's REST API, so
    success/failure is recorded immediately on the post."""
    import django
    django.setup()  # noqa
    from django.utils import timezone

    from websites.models import WebsitePost, WebsitePostStatus
    from websites.views import _publish_website_post

    now = timezone.now()
    due = (
        WebsitePost.objects
        .filter(status=WebsitePostStatus.PENDING, scheduled_at__isnull=False, scheduled_at__lte=now)
        .select_related('website')
        .order_by('scheduled_at', 'id')
    )
    for post in due:
        try:
            _publish_website_post(post)
            logger.info('Website post %s published to %s', post.id, post.website_id)
        except Exception:
            logger.exception('Failed to publish website post %s', post.id)


def start_scheduler() -> None:
    """Start the background scheduler (idempotent)."""
    global _scheduler

    with _lock:
        if _scheduler is not None and _scheduler.running:
            return

        _scheduler = BackgroundScheduler(timezone='UTC')
        # Poll every 30 seconds for due schedules.
        _scheduler.add_job(
            _poll_schedules,
            trigger=IntervalTrigger(seconds=30),
            id='poll_schedules',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_tiktok_channel_video_understand,
            trigger=IntervalTrigger(minutes=5),
            id='poll_tiktok_channel_video_understand',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_facebook_scheduled_posts,
            trigger=IntervalTrigger(seconds=30),
            id='poll_facebook_scheduled_posts',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_facebook_profile_scheduled_posts,
            trigger=IntervalTrigger(seconds=30),
            id='poll_facebook_profile_scheduled_posts',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_facebook_group_scheduled_posts,
            trigger=IntervalTrigger(seconds=30),
            id='poll_facebook_group_scheduled_posts',
            replace_existing=True,
        )
        _scheduler.add_job(
            _drain_device_task_queue,
            trigger=IntervalTrigger(seconds=15),
            id='drain_device_task_queue',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_auto_sync_group_pending_after_publish,
            trigger=IntervalTrigger(seconds=30),
            id='poll_auto_sync_group_pending_after_publish',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_facebook_comment_clusters,
            trigger=IntervalTrigger(seconds=30),
            id='poll_facebook_comment_clusters',
            replace_existing=True,
        )
        _scheduler.add_job(
            _poll_website_scheduled_posts,
            trigger=IntervalTrigger(seconds=30),
            id='poll_website_scheduled_posts',
            replace_existing=True,
        )
        _scheduler.start()
        logger.info("APScheduler started")


def stop_scheduler() -> None:
    global _scheduler
    with _lock:
        if _scheduler and _scheduler.running:
            _scheduler.shutdown(wait=False)
            logger.info("APScheduler stopped")


# NOTE: the scheduler is started EXPLICITLY by:
#   - the `run_scheduler` management command (the dedicated container), and
#   - `ScheduleConfig.ready()` for local `runserver`.
# It must NOT auto-start on module import — the web server (daphne) imports this
# module indirectly via `schedule.views` (`_compute_next_run`), which would
# otherwise spin up a SECOND scheduler inside the backend container and dispatch
# every due post twice (or more, under load).
