"""Background polling for character "Tạo video" — mirrors the TikTok repost
poll (tiktok/video_understand.py) but, on completion, appends the finished
genvideo URL to the character's ``videos`` store instead of scheduling a post.

The generation is slow (minutes), so the request returns immediately and a
daemon thread polls genvideo; the video simply shows up in the character's
gallery when it is ready.
"""
import logging
import threading
import time as _time

import requests as http_requests
from django.conf import settings

logger = logging.getLogger(__name__)


def start_character_video_poll(genvideo_task_id: str, character_id: int) -> None:
    thread = threading.Thread(
        target=_poll_until_done,
        args=(str(genvideo_task_id), int(character_id)),
        daemon=True,
    )
    thread.start()
    logger.info('character-video-poll: started for task %s char %s', genvideo_task_id, character_id)


def _poll_until_done(genvideo_task_id: str, character_id: int) -> None:
    api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
    endpoint = f'{api_url.rstrip("/")}/api/tasks/{genvideo_task_id}'

    for attempt in range(40):  # 40 * 30s ≈ 20 min
        _time.sleep(30)
        try:
            resp = http_requests.get(endpoint, headers={'accept': 'application/json'}, timeout=15)
        except http_requests.RequestException as exc:
            logger.warning('character-video-poll: task %s attempt %s error: %s', genvideo_task_id, attempt, exc)
            continue
        if not resp.ok:
            continue
        try:
            payload = resp.json()
        except ValueError:
            continue

        task_status = payload.get('status')
        if task_status in ('succeeded', 'finished', 'done', 'success'):
            # Text-videos return result.link_download; script-to-video (scene)
            # returns result.download_url — accept either.
            result = payload.get('result') or {}
            link_download = result.get('link_download') or result.get('download_url')
            if link_download:
                _save_to_character(character_id, link_download)
            else:
                logger.warning('character-video-poll: task %s succeeded but no link_download', genvideo_task_id)
            return
        if task_status in ('failed', 'error'):
            logger.warning('character-video-poll: task %s finished with status=%s', genvideo_task_id, task_status)
            return

    logger.warning('character-video-poll: task %s timed out after 40 attempts', genvideo_task_id)


def _save_to_character(character_id: int, link_download: str) -> None:
    from django.utils import timezone
    from .models import Character

    try:
        character = Character.objects.get(id=character_id)
    except Character.DoesNotExist:
        logger.warning('character-video-poll: character %s no longer exists', character_id)
        return
    item = {'url': link_download, 'created_at': timezone.now().isoformat()}
    character.videos = (character.videos or []) + [item]
    character.save(update_fields=['videos', 'updated_at'])
    logger.info('character-video-poll: saved video to character %s', character_id)
