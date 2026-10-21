import logging
import threading
import time as _time

import requests as http_requests
from django.conf import settings

from .models import TiktokChannelVideo

logger = logging.getLogger(__name__)


def start_repost_background_poll(
    genvideo_task_id: str,
    profile_id: int | None,
    scheduled_at: str,
    content_text: str,
    owner_id: int | None,
    caption: str = '',
    hashtags: list = None,
) -> None:
    thread = threading.Thread(
        target=_poll_repost_until_done,
        args=(genvideo_task_id, profile_id, scheduled_at, content_text, owner_id, caption, hashtags),
        daemon=True,
    )
    thread.start()
    logger.info('repost-poll: started background thread for task %s', genvideo_task_id)


def _poll_repost_until_done(
    genvideo_task_id: str,
    profile_id: int | None,
    scheduled_at: str,
    content_text: str,
    owner_id: int | None,
    caption: str = '',
    hashtags: list = None,
) -> None:
    api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
    endpoint = f'{api_url.rstrip("/")}/api/tasks/{genvideo_task_id}'

    for attempt in range(40):  # 40 * 30s ≈ 20 min
        _time.sleep(30)
        try:
            resp = http_requests.get(endpoint, headers={'accept': 'application/json'}, timeout=15)
        except http_requests.RequestException as exc:
            logger.warning('repost-poll: task %s attempt %s error: %s', genvideo_task_id, attempt, exc)
            continue

        if not resp.ok:
            continue

        try:
            payload = resp.json()
        except ValueError:
            continue

        task_status = payload.get('status')
        if task_status == 'succeeded':
            link_download = (payload.get('result') or {}).get('link_download')
            if link_download:
                _complete_repost(link_download, profile_id, scheduled_at, content_text, owner_id, caption, hashtags)
            else:
                logger.warning('repost-poll: task %s succeeded but no link_download', genvideo_task_id)
            return
        elif task_status in ('failed', 'error'):
            logger.warning('repost-poll: task %s finished with status=%s', genvideo_task_id, task_status)
            return

    logger.warning('repost-poll: task %s timed out after 40 attempts', genvideo_task_id)


def _complete_repost(
    link_download: str,
    profile_id: int | None,
    scheduled_at: str,
    content_text: str,
    owner_id: int | None,
    caption: str = '',
    hashtags: list = None,
) -> None:
    from datetime import datetime, timezone as dt_timezone
    from django.contrib.auth import get_user_model
    from schedule.models import Schedule, ScheduleStatus, ScheduleType
    from task.models import Task, TaskStatus, TaskType

    if scheduled_at:
        try:
            run_at = datetime.fromisoformat(scheduled_at.replace('Z', '+00:00'))
            if run_at.tzinfo is None:
                run_at = run_at.replace(tzinfo=dt_timezone.utc)
        except ValueError:
            logger.warning('repost-complete: invalid scheduled_at=%s', scheduled_at)

    User = get_user_model()
    owner = None
    if owner_id:
        try:
            owner = User.objects.get(pk=owner_id)
        except User.DoesNotExist:
            pass

    task = Task.objects.create(
        name='Share TikTok video',
        description=f'Hãy tải video từ {link_download} và đăng lên TikTok.',
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING_APPROVAL,
        payload={
            'agent': 'tiktok',
            'link_download': link_download,
            'profile_id': profile_id,
            'scheduled_at': scheduled_at,
            'content_text': content_text,
            'caption': caption,
            'hashtags': hashtags or [],
        },
        owner=owner,
    )

    logger.info('repost-complete: task %s created in PENDING_APPROVAL status for link=%s', task.id, link_download)


def _coerce_text(value) -> str:
    if value in (None, ''):
        return ''
    return str(value)


def poll_pending_channel_video_understand_tasks(batch_size: int = 20) -> dict[str, int]:
    api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
    endpoint_base = f'{api_url.rstrip("/")}/api/tasks'

    pending_videos = list(
        TiktokChannelVideo.objects.filter(
            is_understand_video=False,
            video_process_task_id__isnull=False,
        )
        .exclude(video_process_task_id='')
        .order_by('updated_at')[: max(int(batch_size or 1), 1)]
    )

    stats = {'scanned': len(pending_videos), 'updated': 0}
    for video in pending_videos:
        task_id = str(video.video_process_task_id or '').strip()
        if not task_id:
            continue

        try:
            response = http_requests.get(
                f'{endpoint_base}/{task_id}',
                headers={'accept': 'application/json'},
                timeout=15,
            )
        except http_requests.RequestException as exc:
            logger.warning('tiktok-understand-poll: failed checking task %s: %s', task_id, exc)
            continue

        if not response.ok:
            continue

        try:
            payload = response.json()
        except ValueError:
            continue

        if not isinstance(payload, dict) or payload.get('status') != 'succeeded':
            continue

        result = payload.get('result')
        if not isinstance(result, dict):
            continue

        rewritten_content = result.get('rewritten_content')
        rewritten_content = rewritten_content if isinstance(rewritten_content, dict) else {}
        video_analysis = result.get('video_analysis')
        if not isinstance(video_analysis, dict):
            video_analysis = {}
        video_style = _coerce_text(payload.get('video_style'))
        if video_style:
            video_analysis['video_style'] = video_style

        video.is_understand_video = True
        video.understand_text_overlay = _coerce_text(rewritten_content.get('text_overlay'))
        video.understand_content_text = _coerce_text(rewritten_content.get('content_text'))
        video.understand_background_description = _coerce_text(rewritten_content.get('background_description'))
        video.understand_style_analysis = _coerce_text(result.get('style_analysis'))
        video.understand_video_analysis = video_analysis or None

        if video.understand_content_text and not video.analyzed_content:
            video.analyzed_content = video.understand_content_text

        video.save(
            update_fields=[
                'is_understand_video',
                'understand_text_overlay',
                'understand_content_text',
                'understand_background_description',
                'understand_style_analysis',
                'understand_video_analysis',
                'analyzed_content',
                'updated_at',
            ]
        )
        stats['updated'] += 1

    return stats
