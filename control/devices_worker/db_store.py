"""Thin database helper for the devices_worker.

Updates the ``devices_device`` table when a device connects or disconnects so
that the Django backend always reflects the current ``worker_id`` for each
device without requiring a separate API call.

The worker locates the device row by ``device_serial_id`` first, falling back
to ``identifier`` when the serial is not found, to handle devices that were
registered before serial-based lookup was added.
"""
from __future__ import annotations

import logging
import os

import psycopg

logger = logging.getLogger(__name__)

_DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql://mbcontrol:mbcontrol@db:5432/mbcontrol",
)


def _get_conn() -> psycopg.Connection:
    return psycopg.connect(_DATABASE_URL)


def update_device_worker_id(
    serial: str,
    identifier: str,
    worker_id: str,
) -> None:
    """Set ``worker_id`` on the matching device row (if one exists)."""
    if not serial and not identifier:
        return
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                if serial:
                    # updated_at is set explicitly because this is raw SQL;
                    # Django's auto_now only fires through the ORM.
                    cur.execute(
                        "UPDATE devices_device SET worker_id = %s, updated_at = NOW()"
                        " WHERE device_serial_id = %s",
                        (worker_id, serial),
                    )
                    if cur.rowcount:
                        logger.info(
                            "DB: updated worker_id=%s for serial=%s", worker_id, serial
                        )
                        return

                # Fallback: match by identifier when the serial did not hit any row.
                if identifier:
                    # updated_at is set explicitly because this is raw SQL;
                    # Django's auto_now only fires through the ORM.
                    cur.execute(
                        "UPDATE devices_device SET worker_id = %s, updated_at = NOW()"
                        " WHERE identifier = %s AND identifier != ''",
                        (worker_id, identifier),
                    )
                    if cur.rowcount:
                        logger.info(
                            "DB: updated worker_id=%s for identifier=%s",
                            worker_id,
                            identifier,
                        )
                    else:
                        logger.debug(
                            "DB: no device row found for serial=%s identifier=%s; skipping update",
                            serial,
                            identifier,
                        )
    except Exception:
        logger.warning(
            "DB: failed to update worker_id for serial=%s identifier=%s",
            serial,
            identifier,
            exc_info=True,
        )


def clear_device_worker_id(serial: str, identifier: str) -> None:
    """Clear ``worker_id`` when a device disconnects."""
    update_device_worker_id(serial, identifier, "")


# ── Task status helpers ──────────────────────────────────────────────────────

_KAFKA_STATUS_MAP = {
    "processing": "running",
    "processed": "completed",
}


def update_task_status_and_result(task_id: int, kafka_status: str, event: dict) -> None:
    """Append *event* to the task's ``result`` JSON array and update its status.

    *kafka_status* is the raw value from the ``task_status`` Kafka topic
    (``"processing"`` or ``"processed"``).  It is mapped to the Django
    ``TaskStatus`` vocabulary before being written to the database.

    The ``result`` column is updated with a PostgreSQL JSON concatenation
    expression to avoid a read-modify-write race when multiple events arrive
    in quick succession.
    """
    if not task_id:
        return

    django_status = _KAFKA_STATUS_MAP.get(kafka_status, kafka_status)

    try:
        import json as _json

        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE task_task
                       SET status     = CASE
                                          WHEN %s = 'completed' THEN 'completed'
                                          WHEN status IN ('pending', 'running') THEN %s
                                          ELSE status
                                        END,
                           result     = COALESCE(result, '[]'::jsonb) || %s::jsonb,
                           updated_at = NOW()
                     WHERE id = %s
                    """,
                    (django_status, django_status, _json.dumps([event]), task_id),
                )
                if cur.rowcount:
                    logger.info(
                        "DB: task %s status=%s, appended event (content=%s...)",
                        task_id,
                        django_status,
                        str(event.get("content", ""))[:60],
                    )
                else:
                    logger.warning("DB: task %s not found, skipping update", task_id)

                # ── Mirror terminal state onto FacebookProfileScheduledPost ──
                # The Django REST `perform_update` hook calls
                # `handle_fb_profile_post_task_status` to flip the scheduled-
                # post row from PUBLISHING → PUBLISHED/FAILED. We bypass the
                # ORM here (raw SQL straight on task_task) so that hook never
                # fires; mirror the transition by hand.
                if django_status in ('completed', 'failed'):
                    _update_fb_profile_scheduled_post_terminal(cur, task_id, django_status)
    except Exception:
        logger.warning("DB: failed to update task %s", task_id, exc_info=True)


_FB_PROFILE_MEDIA_ACTIONS = ('change_avatar', 'change_cover', 'post_story')
_FB_GROUP_PENDING_DECISIONS = ('approve_group_pending_post', 'reject_group_pending_post')


# ── S3 cleanup helpers (mirror of facebook.s3_utils.cleanup_post_media) ─────
#
# After a phoneagent task flips a scheduled-post row to ``published``, the
# media on Cloudfly S3 is no longer needed (worker already pushed it to the
# device). Delete the S3 objects unless they're still referenced by ANOTHER
# pending/publishing row. Wrapped in try/except — never block status flip.

_S3_CLEANUP_TABLES_LIST = (
    'facebook_facebookscheduledpost',
    'facebook_facebookgroupscheduledpost',
    'facebook_facebookprofilescheduledpost',
)
_S3_CLEANUP_TABLE_SINGLE = 'facebook_facebookprofilescheduledmediaaction'

_boto3_s3_client = None


def _get_boto3_s3_client():
    """Lazily build a Cloudfly S3 client from env vars.

    Same env config Django uses (CLOUDFLY_* in settings.py). Returns ``None``
    if config is missing — cleanup becomes a no-op instead of crashing the
    mirror.
    """
    global _boto3_s3_client
    if _boto3_s3_client is not None:
        return _boto3_s3_client
    try:
        import boto3
        from botocore.client import Config
    except ImportError:
        return None
    endpoint = os.environ.get('CLOUDFLY_S3_ENDPOINT') or os.environ.get('CLOUDFLY_ENDPOINT')
    access = os.environ.get('CLOUDFLY_ACCESS_KEY')
    secret = os.environ.get('CLOUDFLY_SECRET_KEY')
    region = os.environ.get('CLOUDFLY_REGION', 'auto')
    if not (endpoint and access and secret):
        return None
    _boto3_s3_client = boto3.client(
        's3',
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name=region,
        config=Config(
            signature_version='s3v4',
            s3={'addressing_style': 'path'},
            request_checksum_calculation='when_required',
            response_checksum_validation='when_required',
        ),
    )
    return _boto3_s3_client


def _s3_url_to_key(url: str) -> str | None:
    """Extract object key from a Cloudfly URL. Only return keys under the
    ``facebook/`` prefix (defensive — refuse to delete keys outside what
    upload_image_to_s3 writes to).
    """
    if not url or not isinstance(url, str):
        return None
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if 'cloudfly.vn' not in (parsed.netloc or ''):
        return None
    path = (parsed.path or '').lstrip('/')
    bucket = (os.environ.get('CLOUDFLY_BUCKET') or 'user-media').strip('/')
    if path.startswith(bucket + '/'):
        key = path[len(bucket) + 1:]
    else:
        key = path
    if not key.startswith('facebook/'):
        return None
    return key


def _url_still_referenced_sql(cur, url: str, exclude_table: str, exclude_id: int) -> bool:
    """True if another scheduled-post row still references *url* in any of
    the 4 tables. *exclude_table* / *exclude_id* let the caller exclude the
    row currently being published.

    Match on substring of the URL **without** the presigned query string —
    DB rows store the canonical (raw, unsigned) URL, but signed URLs share
    the same path prefix.
    """
    base_url = url.split('?', 1)[0]
    pattern = f'%{base_url}%'

    for table in _S3_CLEANUP_TABLES_LIST:
        if table == exclude_table:
            cur.execute(
                f"SELECT 1 FROM {table} "
                f"WHERE image_urls::text LIKE %s AND id <> %s LIMIT 1",
                (pattern, exclude_id),
            )
        else:
            cur.execute(
                f"SELECT 1 FROM {table} WHERE image_urls::text LIKE %s LIMIT 1",
                (pattern,),
            )
        if cur.fetchone():
            return True

    table = _S3_CLEANUP_TABLE_SINGLE
    if table == exclude_table:
        cur.execute(
            f"SELECT 1 FROM {table} WHERE image_url = %s AND id <> %s LIMIT 1",
            (base_url, exclude_id),
        )
    else:
        cur.execute(
            f"SELECT 1 FROM {table} WHERE image_url = %s LIMIT 1",
            (base_url,),
        )
    if cur.fetchone():
        return True
    return False


def _cleanup_s3_after_publish(
    cur, image_urls, exclude_table: str, exclude_id: int,
) -> int:
    """Iterate URLs, skip if still referenced elsewhere, else delete from S3.

    *image_urls* may be a list (page/group/profile post) or a single string
    (media action). Returns number of objects deleted. Never raises.
    """
    if not image_urls:
        return 0
    if isinstance(image_urls, str):
        urls = [image_urls]
    else:
        urls = list(image_urls)

    bucket = os.environ.get('CLOUDFLY_BUCKET') or 'user-media'
    client = _get_boto3_s3_client()
    if client is None:
        return 0  # S3 not configured — silently skip

    deleted = 0
    for url in urls:
        try:
            key = _s3_url_to_key(url)
            if key is None:
                continue
            if _url_still_referenced_sql(cur, url, exclude_table, exclude_id):
                continue
            client.delete_object(Bucket=bucket, Key=key)
            deleted += 1
            logger.info('S3: deleted key %s (post-publish cleanup)', key)
        except Exception as exc:
            logger.warning('S3 cleanup failed for %s — %s', url, exc)
    return deleted


def _humanize_post_error(raw: str) -> str:
    """Rewrite known raw phoneagent error strings into Vietnamese explanations.

    Mirror of ``facebook.views._humanize_post_error`` — keep them in sync.
    """
    if not raw:
        return raw
    if 's3.cloudfly.vn' in raw and '/uc?X-Amz-' in raw:
        return (
            'Không tải được file media từ Google Drive. File có thể đã bị xoá, '
            'chưa share "Anyone with the link", hoặc lớn hơn 100MB (Drive chặn '
            'tải qua API key). Mở sheet, kiểm tra cell image_url của row này.'
        )
    return raw


def _update_fb_profile_scheduled_post_terminal(cur, task_id: int, django_status: str) -> None:
    """Mirror task terminal state onto FB-app data rows.

    Reads ``task.payload`` (JSON) directly from the row we just updated and
    dispatches to the matching handler:
      * ``payload.action == 'publish_profile_post'`` → flip the matching
        ``FacebookProfileScheduledPost`` from publishing → published/failed.
      * ``payload.action`` in change_avatar/change_cover/post_story AND
        ``payload.fb_scheduled_media_action_id`` set → flip the matching
        ``FacebookProfileScheduledMediaAction``.
      * ``payload.action == 'fetch_group_pending_posts'`` → upsert
        ``FacebookGroupPendingMemberPost`` rows from the worker's scraped
        list (stored in ``task.result`` event stream).
      * ``payload.action`` in approve/reject_group_pending_post →
        flip the matching ``FacebookGroupPendingMemberPost`` from processing
        to approved/rejected/failed.

    Safe to call repeatedly: handlers gate by the source-of-truth status of
    the target row.
    """
    cur.execute("SELECT payload, result FROM task_task WHERE id = %s", (task_id,))
    row = cur.fetchone()
    if not row:
        return
    payload, result = row[0] or {}, row[1] or []
    if not isinstance(payload, dict):
        return

    action = payload.get('action')

    # ── FB Group: sync member-pending-posts ──────────────────────────────
    if action == 'fetch_group_pending_posts':
        _upsert_fb_group_pending_posts(cur, task_id, django_status, payload, result)
        return

    # ── FB Group: approve / reject a member pending post ─────────────────
    if action in _FB_GROUP_PENDING_DECISIONS:
        pending_id = payload.get('fb_pending_post_id')
        if not pending_id:
            return
        _update_fb_group_pending_post_row(
            cur, task_id, django_status, pending_id, action, result,
        )
        return

    # ── FB Group: scheduled post publish (poster taps Đăng anonymously) ──
    if action == 'publish_group_scheduled_post':
        sched_id = payload.get('fb_scheduled_post_id')
        if not sched_id:
            return
        _update_fb_group_scheduled_post_terminal(
            cur, task_id, django_status, sched_id, result, payload,
        )
        return

    # ── FB Phase 3: seeding (like/comment/reply) on Profile/Group posts ──
    if action == 'seed_post_interaction':
        seeding_id = payload.get('seeding_action_id')
        surface = payload.get('surface')
        if not seeding_id or surface not in ('profile', 'group'):
            return
        _update_fb_seeding_action_terminal(
            cur, task_id, django_status, surface, seeding_id, result,
        )
        return

    # ── Media action (avatar / cover / story) ────────────────────────────
    if action in _FB_PROFILE_MEDIA_ACTIONS:
        media_id = payload.get('fb_scheduled_media_action_id')
        if not media_id:
            return  # manual button (not scheduled) — nothing to mirror
        _update_fb_media_action_row(cur, task_id, django_status, media_id, result)
        return

    # ── FB Profile: find post link (keyless mirror) ──────────────────────
    # The "Tìm link" feature dispatches action='find_profile_post_link'. The
    # worker copies the post URL from the clipboard and emits it on the
    # task_status stream (raw_context['post_url']). Mirror it onto the
    # scheduled post's fb_post_id WITHOUT touching status — resolved by
    # fb_scheduled_post_id, so it works for every owner with no per-account
    # API key (replaces the old worker-side FACEBOOK_API_KEY HTTP call).
    if action == 'find_profile_post_link':
        sched_id = payload.get('fb_scheduled_post_id')
        if not sched_id or django_status != 'completed':
            return
        post_url = ''
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('post_url'):
                    post_url = str(item['post_url'])[:255]
                    break
        if post_url:
            cur.execute(
                """
                UPDATE facebook_facebookprofilescheduledpost
                   SET fb_post_id = %s,
                       updated_at = NOW()
                 WHERE id = %s
                """,
                (post_url, sched_id),
            )
            if cur.rowcount:
                logger.info(
                    "DB: FB profile scheduled post %s → fb_post_id set via find-link (task=%s)",
                    sched_id, task_id,
                )
        else:
            logger.info(
                "DB: find-link task %s completed but no post_url in result stream (sched=%s)",
                task_id, sched_id,
            )
        return

    if action != 'publish_profile_post':
        return
    sched_id = payload.get('fb_scheduled_post_id')
    if not sched_id:
        return

    target_group_id = payload.get('target_group_id')

    if django_status == 'completed':
        # Best-effort: look for a post_url in the event stream. Worker doesn't
        # always emit one for FB profile posts, so empty is OK.
        post_url = ''
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('post_url'):
                    post_url = str(item['post_url'])[:255]
                    break
        cur.execute(
            """
            UPDATE facebook_facebookprofilescheduledpost
               SET status = 'published',
                   fb_post_id = %s,
                   error_msg = '',
                   updated_at = NOW()
             WHERE id = %s
               AND status IN ('publishing', 'failed', 'pending')
            RETURNING profile_id, owner_id, content, image_urls
            """,
            (post_url, sched_id),
        )
        sp_row = cur.fetchone()
        if sp_row:
            logger.info(
                "DB: FB profile scheduled post %s → published (task=%s)",
                sched_id, task_id,
            )
            _, owner_id, content, image_urls = sp_row
            if target_group_id and post_url and owner_id:
                # Mirror as a FacebookGroupPost on the target group (re-routed).
                import json as _json
                image_url_val = ''
                if isinstance(image_urls, list) and image_urls:
                    image_url_val = str(image_urls[0])[:2048]
                cur.execute(
                    """
                    INSERT INTO facebook_facebookgrouppost
                        (group_id, post_url, image_url, image_urls, caption,
                         content, keywords, status, owner_id, created_at, updated_at)
                    VALUES (%s, %s, %s, %s::jsonb, NULL, %s, %s::jsonb, 'shared',
                            %s, NOW(), NOW())
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        target_group_id, post_url, image_url_val,
                        _json.dumps(image_urls if isinstance(image_urls, list) else []),
                        content, _json.dumps([]), owner_id,
                    ),
                )
            # Free S3 bytes — best-effort, never raises.
            try:
                _cleanup_s3_after_publish(
                    cur, image_urls,
                    exclude_table='facebook_facebookprofilescheduledpost',
                    exclude_id=sched_id,
                )
            except Exception:
                logger.warning('S3 cleanup hook crashed for profile post %s', sched_id, exc_info=True)
        return
    else:  # failed
        # Pull the last error string from the result stream when available.
        err = 'Phoneagent task failed without details.'
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict):
                    msg = item.get('error') or item.get('content')
                    if msg and ('error' in str(item.get('status', '')).lower() or 'fail' in str(item.get('status', '')).lower() or item.get('error')):
                        err = str(msg)[:500]
                        break
        err = _humanize_post_error(err)
        cur.execute(
            """
            UPDATE facebook_facebookprofilescheduledpost
               SET status = 'failed',
                   error_msg = %s,
                   updated_at = NOW()
             WHERE id = %s
               AND status IN ('publishing', 'pending')
            """,
            (err, sched_id),
        )
        if cur.rowcount:
            logger.info(
                "DB: FB profile scheduled post %s → failed (task=%s)",
                sched_id, task_id,
            )


def _update_fb_media_action_row(
    cur, task_id: int, django_status: str, media_id: int, result,
) -> None:
    """Flip facebook_facebookprofilescheduledmediaaction to published/failed.

    Counterpart to :func:`_update_fb_profile_scheduled_post_terminal` for
    avatar / cover / story rows. Same publishing-only guard.
    """
    if django_status == 'completed':
        cur.execute(
            """
            UPDATE facebook_facebookprofilescheduledmediaaction
               SET status = 'published',
                   error_msg = '',
                   updated_at = NOW()
             WHERE id = %s
               AND status IN ('publishing', 'failed', 'pending')
            RETURNING image_url
            """,
            (media_id,),
        )
        row = cur.fetchone()
        if row:
            logger.info(
                "DB: FB profile scheduled media action %s → published (task=%s)",
                media_id, task_id,
            )
            try:
                _cleanup_s3_after_publish(
                    cur, row[0],
                    exclude_table='facebook_facebookprofilescheduledmediaaction',
                    exclude_id=media_id,
                )
            except Exception:
                logger.warning('S3 cleanup hook crashed for media action %s', media_id, exc_info=True)
        return

    err = 'Phoneagent task failed without details.'
    if isinstance(result, list):
        for item in reversed(result):
            if isinstance(item, dict):
                msg = item.get('error') or item.get('content')
                status_str = str(item.get('status', '')).lower()
                if msg and (item.get('error') or 'error' in status_str or 'fail' in status_str):
                    err = str(msg)[:500]
                    break
    err = _humanize_post_error(err)
    cur.execute(
        """
        UPDATE facebook_facebookprofilescheduledmediaaction
           SET status = 'failed',
               error_msg = %s,
               updated_at = NOW()
         WHERE id = %s
           AND status = 'publishing'
        """,
        (err, media_id),
    )
    if cur.rowcount:
        logger.info(
            "DB: FB profile scheduled media action %s → failed (task=%s)",
            media_id, task_id,
        )


# ─── FB Group: scheduled-post publish mirror ─────────────────────────────────

def _update_fb_group_scheduled_post_terminal(
    cur, task_id: int, django_status: str, sched_id: int, result, payload,
) -> None:
    """Flip facebook_facebookgroupscheduledpost from publishing → published/failed
    when the phoneagent task ends. Also upserts the corresponding
    ``FacebookGroupPost`` row on success so the post list reflects it.

    Mirrors :func:`_update_fb_profile_scheduled_post_terminal` but for the
    group scheduled-post surface.
    """
    import json as _json

    if django_status == 'completed':
        post_url = ''
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('post_url'):
                    post_url = str(item['post_url'])[:255]
                    break
        cur.execute(
            """
            UPDATE facebook_facebookgroupscheduledpost
               SET status = 'published',
                   fb_post_id = %s,
                   error_msg = '',
                   updated_at = NOW()
             WHERE id = %s
               AND status IN ('publishing', 'failed', 'pending')
            RETURNING group_id, content, image_urls, owner_id
            """,
            (post_url, sched_id),
        )
        row = cur.fetchone()
        if not row:
            return
        logger.info(
            "DB: FB group scheduled post %s → published (task=%s)",
            sched_id, task_id,
        )
        group_id, content, image_urls, owner_id = row
        # Upsert a FacebookGroupPost row for the published artifact.
        if owner_id and post_url:
            image_url = ''
            if isinstance(image_urls, list) and image_urls:
                image_url = str(image_urls[0])[:2048]
            cur.execute(
                """
                INSERT INTO facebook_facebookgrouppost
                    (group_id, post_url, image_url, image_urls, caption,
                     content, keywords, status, owner_id, created_at, updated_at)
                VALUES (%s, %s, %s, %s::jsonb, NULL, %s, %s::jsonb, 'shared',
                        %s, NOW(), NOW())
                ON CONFLICT DO NOTHING
                """,
                (
                    group_id, post_url, image_url,
                    _json.dumps(image_urls if isinstance(image_urls, list) else []),
                    content, _json.dumps([]), owner_id,
                ),
            )
        # Free S3 bytes — best-effort, never raises.
        try:
            _cleanup_s3_after_publish(
                cur, image_urls,
                exclude_table='facebook_facebookgroupscheduledpost',
                exclude_id=sched_id,
            )
        except Exception:
            logger.warning('S3 cleanup hook crashed for group post %s', sched_id, exc_info=True)
        return

    if django_status != 'failed':
        return

    err = 'Phoneagent task failed without details.'
    if isinstance(result, list):
        for item in reversed(result):
            if isinstance(item, dict):
                msg = item.get('error') or item.get('content')
                status_str = str(item.get('status', '')).lower()
                if msg and (item.get('error') or 'error' in status_str or 'fail' in status_str):
                    err = str(msg)[:500]
                    break
    err = _humanize_post_error(err)
    cur.execute(
        """
        UPDATE facebook_facebookgroupscheduledpost
           SET status = 'failed',
               error_msg = %s,
               updated_at = NOW()
         WHERE id = %s
           AND status = 'publishing'
        """,
        (err, sched_id),
    )
    if cur.rowcount:
        logger.info(
            "DB: FB group scheduled post %s → failed (task=%s)",
            sched_id, task_id,
        )


# ─── FB Phase 3: seeding action mirror ───────────────────────────────────────

_SEEDING_TABLES = {
    'profile': 'facebook_facebookprofilepostseedingaction',
    'group': 'facebook_facebookgrouppostseedingaction',
}


def _update_fb_seeding_action_terminal(
    cur, task_id: int, django_status: str, surface: str, seeding_id: int, result,
) -> None:
    """Flip FacebookProfilePostSeedingAction / FacebookGroupPostSeedingAction
    from dispatched → done/failed when the phoneagent task ends.
    """
    table = _SEEDING_TABLES.get(surface)
    if not table:
        return

    if django_status == 'completed':
        comment_url = ''
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('comment_url'):
                    comment_url = str(item['comment_url'])[:255]
                    break
        cur.execute(
            f"""
            UPDATE {table}
               SET status = 'done',
                   fb_comment_id = %s,
                   error_msg = '',
                   updated_at = NOW()
             WHERE id = %s
               AND status IN ('dispatched', 'failed', 'pending')
            """,
            (comment_url, seeding_id),
        )
        if cur.rowcount:
            logger.info(
                "DB: FB %s seeding action %s → done (task=%s)",
                surface, seeding_id, task_id,
            )
        return

    if django_status != 'failed':
        return

    err = 'Phoneagent task failed without details.'
    if isinstance(result, list):
        for item in reversed(result):
            if isinstance(item, dict):
                msg = item.get('error') or item.get('content')
                status_str = str(item.get('status', '')).lower()
                if msg and (item.get('error') or 'error' in status_str or 'fail' in status_str):
                    err = str(msg)[:500]
                    break
    err = _humanize_post_error(err)
    cur.execute(
        f"""
        UPDATE {table}
           SET status = 'failed',
               error_msg = %s,
               updated_at = NOW()
         WHERE id = %s
           AND status = 'dispatched'
        """,
        (err, seeding_id),
    )
    if cur.rowcount:
        logger.info(
            "DB: FB %s seeding action %s → failed (task=%s)",
            surface, seeding_id, task_id,
        )


# ─── FB Group: pending-member-post helpers ───────────────────────────────────

def _scan_result_for_payload(result, payload_key: str):
    """Search the task's result event list (newest-first) for a dict event
    that carries *payload_key* and return its value.

    Workers can emit any number of intermediate ``[plan] / [action] / [agent]``
    events; the final structured payload is whatever event explicitly stamps
    the requested key (e.g. ``pending_posts``).
    """
    if not isinstance(result, list):
        return None
    for item in reversed(result):
        if isinstance(item, dict) and payload_key in item:
            return item[payload_key]
    return None


def _upsert_fb_group_pending_posts(cur, task_id: int, django_status: str, payload, result) -> None:
    """Process the result of a ``fetch_group_pending_posts`` task.

    Expected: the worker stamps a final event with ``pending_posts`` set to
    a list of dicts, each having (best-effort) fields:
        post_fb_id, post_url, author_name, author_uid, content,
        image_urls, posted_at (ISO 8601 string)

    Rows are upserted by ``(group_id, post_fb_id)``. Existing rows that the
    worker no longer sees stay in the DB — we don't auto-prune, the admin
    can delete via the UI.
    """
    import json as _json
    from datetime import datetime as _dt

    if django_status == 'failed':
        logger.info('DB: FB group pending-posts sync task %s failed; no upsert', task_id)
        return
    if django_status != 'completed':
        return

    group_id = payload.get('fb_group_id')
    if not group_id:
        logger.warning('DB: fetch_group_pending_posts task %s missing fb_group_id', task_id)
        return

    posts_list = _scan_result_for_payload(result, 'pending_posts') or []
    if not isinstance(posts_list, list):
        logger.warning('DB: task %s pending_posts payload is not a list', task_id)
        return

    # Resolve owner from the group so newly inserted rows are visible in the UI.
    cur.execute('SELECT owner_id FROM facebook_facebookgroup WHERE id = %s', (group_id,))
    row = cur.fetchone()
    if not row:
        logger.warning('DB: group %s not found for pending posts upsert', group_id)
        return
    owner_id = row[0]

    import hashlib as _hashlib

    upserts = 0
    for p in posts_list:
        if not isinstance(p, dict):
            continue
        post_fb_id = str(p.get('post_fb_id') or '').strip()[:255]
        post_url = str(p.get('post_url') or '').strip()[:2048]
        author_name = str(p.get('author_name') or '').strip()[:255]
        author_uid = str(p.get('author_uid') or '').strip()[:255]
        content = str(p.get('content') or '')
        # Synthesize a stable ID when worker can't get the real FB post id (FB
        # Android doesn't expose it via accessibility tree). Hash inputs that
        # don't drift between re-scrapes: author + content prefix + tab.
        # Prefixed with ``synth:`` so future code can distinguish real vs
        # synthesized IDs. Skip only when there's literally nothing to hash.
        if not post_fb_id:
            tab_for_hash = str(p.get('pending_tab') or 'approval').strip().lower()
            seed = f'{author_name}|{content[:500]}|{tab_for_hash}'
            if not seed.replace('|', '').strip():
                continue
            digest = _hashlib.sha1(seed.encode('utf-8', errors='ignore')).hexdigest()[:24]
            post_fb_id = f'synth:{digest}'
        image_urls = p.get('image_urls') or []
        if not isinstance(image_urls, list):
            image_urls = []
        posted_at_raw = p.get('posted_at')
        posted_at = None
        if isinstance(posted_at_raw, str) and posted_at_raw:
            try:
                # Worker emits ISO 8601 with timezone; allow trailing Z too.
                posted_at = _dt.fromisoformat(posted_at_raw.replace('Z', '+00:00'))
            except ValueError:
                posted_at = None
        # Validate pending_tab — accept only the two known values. Default to
        # 'approval' for backward compat with worker versions that don't stamp.
        pending_tab = str(p.get('pending_tab') or 'approval').strip().lower()
        if pending_tab not in ('approval', 'maybe_spam'):
            pending_tab = 'approval'

        cur.execute(
            """
            INSERT INTO facebook_facebookgrouppendingmemberpost
                (group_id, post_fb_id, post_url, author_name, author_uid,
                 content, image_urls, posted_at, status, pending_tab,
                 error_msg, owner_id, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, 'queued', %s,
                    '', %s, NOW(), NOW())
            ON CONFLICT ON CONSTRAINT uniq_fb_pending_post_per_group DO UPDATE
                SET post_url = EXCLUDED.post_url,
                    author_name = EXCLUDED.author_name,
                    author_uid = EXCLUDED.author_uid,
                    content = EXCLUDED.content,
                    image_urls = EXCLUDED.image_urls,
                    posted_at = COALESCE(EXCLUDED.posted_at, facebook_facebookgrouppendingmemberpost.posted_at),
                    pending_tab = EXCLUDED.pending_tab,
                    updated_at = NOW()
            """,
            (
                group_id, post_fb_id, post_url, author_name, author_uid,
                content, _json.dumps(image_urls), posted_at, pending_tab, owner_id,
            ),
        )
        upserts += 1

    logger.info(
        'DB: upserted %d pending-member-posts for group %s (task=%s)',
        upserts, group_id, task_id,
    )


def _update_fb_group_pending_post_row(
    cur, task_id: int, django_status: str, pending_id: int, action: str, result,
) -> None:
    """Flip a pending-member-post row from processing → approved/rejected/failed.

    Only updates while the row is still in the ``processing`` state, so
    duplicate terminal events from re-execution don't overwrite a manual
    correction.
    """
    if django_status == 'completed':
        target = 'approved' if action == 'approve_group_pending_post' else 'rejected'
        cur.execute(
            """
            UPDATE facebook_facebookgrouppendingmemberpost
               SET status = %s,
                   error_msg = '',
                   updated_at = NOW()
             WHERE id = %s
               AND status = 'processing'
            """,
            (target, pending_id),
        )
        if cur.rowcount:
            logger.info(
                'DB: FB group pending post %s → %s (task=%s)',
                pending_id, target, task_id,
            )
        return

    if django_status != 'failed':
        return

    err = 'Phoneagent task failed without details.'
    if isinstance(result, list):
        for item in reversed(result):
            if isinstance(item, dict):
                msg = item.get('error') or item.get('content')
                status_str = str(item.get('status', '')).lower()
                if msg and (item.get('error') or 'error' in status_str or 'fail' in status_str):
                    err = str(msg)[:500]
                    break
    cur.execute(
        """
        UPDATE facebook_facebookgrouppendingmemberpost
           SET status = 'failed',
               error_msg = %s,
               updated_at = NOW()
         WHERE id = %s
           AND status = 'processing'
        """,
        (err, pending_id),
    )
    if cur.rowcount:
        logger.info(
            'DB: FB group pending post %s → failed (task=%s)',
            pending_id, task_id,
        )
