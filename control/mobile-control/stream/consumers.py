import asyncio
import json
import logging
import uuid

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.db import DatabaseError

from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event

logger = logging.getLogger(__name__)

# Strong references to fire-and-forget background tasks (e.g. n8n forwarding).
# asyncio only holds a weak reference to a task, so without this a pending task
# may be garbage-collected mid-flight before it finishes.
_background_tasks: set[asyncio.Task] = set()


async def _forward_to_n8n(
    device_obj,
    identifier: str,
    package: str,
    title: str,
    text: str,
    post_time,
    key: str = '',
    notification_id=None,
    tag: str = '',
    is_ongoing: bool = False,
):
    """
    Asynchronously forward a TikTok notification to the configured n8n webhook.
    Uses httpx.AsyncClient to send the request in a fire-and-forget task.
    """
    webhook_url = getattr(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_URL', '')
    if not webhook_url:
        return

    package_lower = (package or '').lower()
    is_tiktok = 'ss.android.ugc.trill' in package_lower or 'musically' in package_lower
    if not is_tiktok:
        return

    method = (getattr(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_METHOD', 'POST') or 'POST').upper()

    device_id = str(device_obj.pk) if device_obj else ""
    device_name = device_obj.name if device_obj else ""
    device_serial = device_obj.device_serial_id if device_obj else ""

    from django.utils import timezone as dj_tz
    payload = {
        'device_id': device_id,
        'device_name': device_name,
        'device_serial': device_serial,
        'identifier': identifier,
        'package': package,
        'sender': title,
        'message': text,
        'notification_id': notification_id,
        'tag': tag,
        'is_ongoing': is_ongoing,
        'key': key,
        'post_time': post_time,
        'received_at': dj_tz.now().isoformat(),
    }

    try:
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as client:
            if method == 'GET':
                response = await client.get(webhook_url, params=payload)
            else:
                response = await client.post(webhook_url, json=payload)
            logger.info(
                'Forwarded TikTok notification to n8n (%s %s): status=%s',
                method, webhook_url, response.status_code
            )
    except Exception as exc:
        logger.warning('Failed to forward TikTok notification to n8n: %s', exc)


# ── Chatbot TikTok Phase 2.2 helpers ─────────────────────────────────────────


async def _create_tiktok_message_in(device_obj, peer_handle: str, content: str, notification_id):
    """Insert TiktokMessage(direction=user/IN, source=notification) cho mỗi DM
    notification — accumulate history cho conversation Inbox UI.

    is_preview=True vì notification.text thường truncated bởi Android system.
    """
    if not peer_handle:
        return
    try:
        from chatbot.models import (  # noqa: PLC0415
            TiktokMessage,
            TiktokMessageChannel,
            TiktokMessageSource,
            TiktokMessageType,
        )
        await TiktokMessage.objects.acreate(
            device=device_obj,
            peer_handle=peer_handle,
            channel=TiktokMessageChannel.DM,
            content=content or '',
            message_type=TiktokMessageType.USER,
            source=TiktokMessageSource.NOTIFICATION,
            is_preview=True,
            source_notification_id=notification_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Create TiktokMessage IN failed (degraded): device=%s peer=%s err=%s',
            getattr(device_obj, 'pk', '?'), peer_handle, exc,
        )


async def _build_tiktok_history(device_obj, peer_handle: str, limit: int = 10) -> str:
    """Thin wrapper — delegate sang `chatbot.services.history.abuild_history_string`.

    Service đã handle filter `delivery_status` + format chuẩn.
    """
    try:
        from chatbot.services.history import abuild_history_string  # noqa: PLC0415
        return await abuild_history_string(device_obj, peer_handle, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning('Build TiktokMessage history failed (degraded): %s', exc)
        return ''


SPECIAL_MARKERS_NEED_HUMAN = ('[Sticker]', '[Voice message]')


async def _is_peer_muted(device_obj, peer_handle: str) -> bool:
    """Check `TiktokPeerMute` cho (device, peer) — user chủ động pause AI?

    Mute còn hiệu lực khi: `muted_until IS NULL` (vô thời hạn) OR `muted_until >= now()`.
    """
    if not peer_handle:
        return False
    try:
        from django.db.models import Q  # noqa: PLC0415
        from django.utils import timezone as dj_timezone  # noqa: PLC0415
        from chatbot.models import TiktokPeerMute  # noqa: PLC0415

        return await TiktokPeerMute.objects.filter(
            device=device_obj,
            peer_handle=peer_handle,
        ).filter(
            Q(muted_until__isnull=True) | Q(muted_until__gte=dj_timezone.now()),
        ).aexists()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Check peer mute failed (degraded → assume not muted): %s', exc,
        )
        return False


async def _detect_special_marker(content: str) -> str | None:
    """Detect special TikTok markers cần human handle (KHÔNG auto-reply).

    Returns: marker name (vd '[Sticker]', '[Voice message]') hoặc None.
    """
    if not content:
        return None
    for marker in SPECIAL_MARKERS_NEED_HUMAN:
        if marker in content:
            return marker
    return None


async def _auto_mute_for_special_marker(device_obj, peer_handle: str, marker: str) -> None:
    """Insert TiktokPeerMute với note rõ lý do cho special markers.

    Phase 2.2.5: mark conversation cần human review — bot KHÔNG đủ context để
    reply sticker/voice (text notification chỉ chứa label, không có nội dung).
    User check Inbox UI sẽ thấy mute icon ⏸ + note.

    Idempotent: nếu peer đã mute (vì lý do khác) → skip, KHÔNG override note.
    """
    if not peer_handle:
        return
    try:
        from django.utils import timezone  # noqa: PLC0415
        from datetime import timedelta  # noqa: PLC0415
        from chatbot.models import TiktokPeerMute  # noqa: PLC0415

        # Mute 24h auto (đủ thời gian cho user check + handle tay), KHÔNG vô
        # thời hạn vì user có thể quên unmute → bot kẹt mãi.
        await TiktokPeerMute.objects.aupdate_or_create(
            device=device_obj,
            peer_handle=peer_handle,
            defaults={
                'muted_until': timezone.now() + timedelta(hours=24),
                'note': f'Auto-muted vì TikTok DM chứa {marker} — cần human handle (bot không reply được sticker/voice).',
            },
        )
        logger.info(
            'Auto-mute peer device=%s peer=%s marker=%s for 24h',
            device_obj.pk, peer_handle, marker,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            'Auto-mute peer failed (degraded): device=%s peer=%s marker=%s err=%s',
            device_obj.pk, peer_handle, marker, exc,
        )


async def _buffer_or_dispatch_dm(
    *,
    device_obj,
    identifier: str,
    peer_handle: str,
    content: str,
    notification_id,
    payload: dict,
    params: dict,
):
    """Add DM vào AdaptiveMessageBuffer. Flush → dispatch_event combined.

    Edge cases (Phase 2.2.5):
    - [Sticker] / [Voice message] → auto-mute peer 24h + KHÔNG dispatch
      (bot không đủ context để reply, cần human handle).
    - Phase L cân nhắc: gửi reply emoji default cho sticker, nhận diện voice
      qua agent task riêng (Whisper transcribe), v.v.

    1. INSERT TiktokMessage IN (accumulate history)
    2. Detect special marker [Sticker]/[Voice message] → auto-mute + skip
    3. Check peer đang mute không → skip dispatch
    4. add_message vào buffer (3-tier scoring)
    5. Nếu flush → dispatch combined với history → trigger workflow chạy
    6. Nếu chưa flush → return, đợi msg tiếp / background timeout sweeper
    """
    await _create_tiktok_message_in(device_obj, peer_handle, content, notification_id)

    # Edge case 1: special markers cần human (Phase 2.2.5)
    marker = await _detect_special_marker(content)
    if marker is not None:
        await _auto_mute_for_special_marker(device_obj, peer_handle, marker)
        logger.info(
            'Skip dispatch DM (special marker) device=%s peer=%s marker=%s',
            device_obj.pk, peer_handle, marker,
        )
        return

    # Edge case 2: peer đang mute (user chủ động pause AI)
    if await _is_peer_muted(device_obj, peer_handle):
        logger.info(
            'Skip dispatch DM (peer muted) device=%s peer=%s',
            device_obj.pk, peer_handle,
        )
        return

    history = await _build_tiktok_history(device_obj, peer_handle, limit=10)

    from chatbot.buffer import get_buffer  # noqa: PLC0415

    should_flush, flushed_msgs = await sync_to_async(
        get_buffer().add_message, thread_sensitive=False,
    )(device_obj.pk, peer_handle, content, history)

    if not should_flush:
        logger.debug(
            'DM buffered (no flush) device=%s peer=%s content=%r',
            device_obj.pk, peer_handle, content[:60],
        )
        return

    combined_content = '\n'.join(flushed_msgs)
    logger.info(
        'DM buffer FLUSH → dispatch_event device=%s peer=%s combined_len=%d msgs=%d',
        device_obj.pk, peer_handle, len(combined_content), len(flushed_msgs),
    )

    await sync_to_async(dispatch_event, thread_sensitive=True)(
        SystemEvent.DEVICE_NOTIFY,
        EventSourceType.DEVICE,
        device_obj.pk,
        {
            'identifier': identifier,
            'notification_type': params.get('type'),
            'payload': payload,
            'event_type': 'tiktok_dm',
            'peer_handle': peer_handle,
            'content': combined_content,
            'notification_id': notification_id,
            'history': history,
            'flushed_message_count': len(flushed_msgs),
        },
    )


async def _save_notification(identifier: str, device_pk: 'int | None', params: dict, raw_event: dict):
    """Persist a NOTIFICATION_POSTED device event to DeviceNotification.

    Deduplication strategy:
    - When the notification ``key`` field is non-empty we use ``(identifier, key)``
      as a unique lookup key via ``update_or_create``, updating mutable fields in
      place and skipping a true duplicate insert.
    - When ``key`` is empty we fall back to ``create`` (no reliable dedup key).
    """
    try:
        from devices.models import Device, DeviceNotification  # noqa: PLC0415

        payload = params.get('payload') or {}

        device_obj = None
        if device_pk is not None:
            device_obj = await Device.objects.filter(pk=device_pk).afirst()
        if device_obj is None and identifier:
            device_obj = await Device.objects.filter(identifier=identifier).afirst()

        notif_key = payload.get('key', '') or ''
        notif_defaults = dict(
            device=device_obj,
            package=payload.get('package', ''),
            title=payload.get('title', ''),
            text=payload.get('text', ''),
            notification_id=payload.get('id'),
            tag=payload.get('tag', ''),
            is_ongoing=bool(payload.get('is_ongoing', False)),
            post_time=payload.get('post_time'),
            event_timestamp=params.get('timestamp'),
            raw_data=raw_event,
        )

        notif_obj = None
        if notif_key:
            # Deduplicate on (identifier, key) — update mutable fields if already stored.
            notif_obj, created = await DeviceNotification.objects.aupdate_or_create(
                identifier=identifier,
                key=notif_key,
                defaults=notif_defaults,
            )
            if not created:
                logger.debug(
                    'Skipped duplicate DeviceNotification for device=%s key=%s', identifier, notif_key
                )
                return
        else:
            notif_obj = await DeviceNotification.objects.acreate(
                identifier=identifier,
                key='',
                **notif_defaults,
            )

        logger.debug('Saved DeviceNotification for device=%s package=%s', identifier, payload.get('package'))

        # Chatbot TikTok (Phase 2.1) — classify notification → enrich payload
        # với event_type để WorkflowTrigger.event_filter có thể match.
        # Khi event_type=None → notification là marketing/system, KHÔNG
        # emit DEVICE_NOTIFY → tránh trigger workflow lạc.
        #
        # Phase 2.5 (revise Q4.b): nếu TIKTOK_USE_N8N_BRIDGE_DISPATCH=true →
        # SKIP block inline dispatch hoàn toàn (n8n callback path B sẽ làm).
        # Tránh dual-path race tạo 2 WorkflowRun cho cùng 1 noti.
        event_type: str | None = None
        use_n8n_bridge = getattr(settings, 'TIKTOK_USE_N8N_BRIDGE_DISPATCH', False)

        if not use_n8n_bridge:
            try:
                from chatbot.notification_matcher import get_matcher  # noqa: PLC0415
                event_type = await sync_to_async(get_matcher().match, thread_sensitive=False)(notif_obj)
            except Exception as exc:  # noqa: BLE001
                logger.warning('NotificationMatcher failed for device=%s: %s', identifier, exc, exc_info=True)

        if device_obj is not None and event_type is not None and not use_n8n_bridge:
            peer_handle = payload.get('title', '') or ''
            content = payload.get('text', '') or ''

            # Chatbot TikTok (Phase 2.2.3) — DM type qua AdaptiveMessageBuffer:
            # debounce nhiều msg rời rạc của cùng user thành 1 flush event.
            # Các event_type khác (follow/comment/...) → dispatch ngay.
            if event_type == 'tiktok_dm' and peer_handle:
                await _buffer_or_dispatch_dm(
                    device_obj=device_obj,
                    identifier=identifier,
                    peer_handle=peer_handle,
                    content=content,
                    notification_id=notif_obj.pk if notif_obj is not None else None,
                    payload=payload,
                    params=params,
                )
            else:
                await sync_to_async(dispatch_event, thread_sensitive=True)(
                    SystemEvent.DEVICE_NOTIFY,
                    EventSourceType.DEVICE,
                    device_obj.pk,
                    {
                        'identifier': identifier,
                        'notification_type': params.get('type'),
                        'payload': payload,
                        # Enrich cho WorkflowTrigger.event_filter match (Phase 2.1).
                        'event_type': event_type,
                        'peer_handle': peer_handle,
                        'content': content,
                        'notification_id': notif_obj.pk if notif_obj is not None else None,
                    },
                )

        # Trigger n8n forwarding asynchronously (fire-and-forget).
        # Keep a strong reference so the task is not garbage-collected mid-flight.
        n8n_task = asyncio.create_task(
            _forward_to_n8n(
                device_obj=device_obj,
                identifier=identifier,
                package=payload.get('package', ''),
                title=payload.get('title', ''),
                text=payload.get('text', ''),
                post_time=payload.get('post_time'),
                key=notif_key,
                notification_id=payload.get('id'),
                tag=payload.get('tag', ''),
                is_ongoing=bool(payload.get('is_ongoing', False)),
            )
        )
        _background_tasks.add(n8n_task)
        n8n_task.add_done_callback(_background_tasks.discard)
    except Exception as exc:  # noqa: BLE001
        logger.warning('Failed to save DeviceNotification for %s: %s', identifier, exc, exc_info=True)


async def _resolve_device_pk(identifier: str) -> int | None:
    if not identifier:
        return None
    from devices.models import Device  # noqa: PLC0415

    device = await Device.objects.filter(identifier=identifier).only('id').afirst()
    return device.pk if device else None


# How long (seconds) a device connection may be idle before it is closed.
_IDLE_TIMEOUT: int = int(getattr(settings, 'WEBRTC_IDLE_TIMEOUT_SECONDS', 600))

# Interval (seconds) at which the viewer sends keep-alive frames to the device.
_KEEPALIVE_INTERVAL: int = int(getattr(settings, 'WEBRTC_KEEPALIVE_INTERVAL_SECONDS', 25))

# How long (seconds) to wait after the last viewer disconnects before sending
# stream/stop to the device.  This grace period allows brief reconnects (e.g.
# page refresh) without interrupting an ongoing stream session.
_VIEWER_DISCONNECT_STOP_DELAY: int = int(
    getattr(settings, 'WEBRTC_VIEWER_DISCONNECT_STOP_DELAY_SECONDS', 120),
)

# Pending delayed stream/stop tasks keyed by device identifier.
# When a new viewer connects it cancels any in-flight stop task for that device.
# NOTE: this dict lives in a single worker process.  In a multi-worker deployment
# the grace period is best-effort — if the new viewer lands on a different worker
# the stop task running on the original worker will still fire after the delay.
_pending_stop_tasks: dict[str, asyncio.Task] = {}

# ── Logging helpers ─────────────────────────────────────────────────────────────

def _log_signaling(role: str, identifier: str, method: str, msg_id, **extra):
    """Log a WebRTC signaling event with consistent formatting."""
    parts = [f'[{role}]', f'device={identifier}', f'method={method}']
    if msg_id:
        parts.append(f'id={msg_id}')
    for k, v in extra.items():
        parts.append(f'{k}={v}')
    logger.info(' '.join(parts))


def _log_binary_relay(role: str, identifier: str, direction: str, byte_count: int):
    """Log binary data relay with size info."""
    logger.info(
        '[%s] device=%s direction=%s bytes=%d',
        role, identifier, direction, byte_count,
    )


# ── Group name helpers ─────────────────────────────────────────────────────────

def _device_group(identifier: str) -> str:
    return f'device_{identifier}'


def _viewer_group(identifier: str) -> str:
    return f'viewer_{identifier}'


def _get_ice_servers() -> list:
    """Return the ICE server list from settings, falling back to public STUN."""
    return list(getattr(settings, 'WEBRTC_ICE_SERVERS', [
        {'urls': ['stun:stun.l.google.com:19302']},
    ]))


# ── PersonalJoinConsumer ───────────────────────────────────────────────────────

class PersonalJoinConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for Android devices connecting via the personal-join endpoint.

    Android devices connect to: wss://host/v1/providers/personal/join

    Expected headers sent by the device:
      Authorization:       Bearer <jwt-token>   (optional — validated if present)
      X-Device-ID:         device UUID          (required)
      X-Device-Name:       model name           (optional)
      X-Device-Country:    ISO country code     (optional)
      X-Device-Serial:     ADB/USB serial       (optional — used to migrate legacy records)
      X-Remote-Device-Key: service key          (optional)

    When X-Device-Serial is present the server looks up the Device record whose
    identifier matches that serial and migrates it to the new UUID identifier,
    preserving the record's owner, team, and all associated data.  If no legacy
    record exists the server falls back to an upsert keyed on the UUID.

    Terminal error close codes (device will NOT reconnect):
      4001 → 401 Unauthorized (invalid token)
      4000 → 400 Bad Request  (missing required header)
      4003 → 403 Forbidden
    """

    async def connect(self):
        headers = {
            k.decode().lower(): v.decode()
            for k, v in self.scope.get('headers', [])
        }

        # ── Authentication (optional) ──────────────────────────────────────────
        # Personal-join devices may connect without a JWT token. When a token is
        # provided it is validated; when absent the device is still allowed to
        # connect (the device identity is established via X-Device-ID).
        auth_header = headers.get('authorization', '')
        if auth_header.lower().startswith('bearer '):
            token_str = auth_header.split(' ', 1)[1].strip()
            try:
                from rest_framework_simplejwt.tokens import UntypedToken  # noqa: PLC0415
                UntypedToken(token_str)
            except Exception as exc:
                logger.warning('PersonalJoin: JWT validation failed: %s', exc)
                await self.close(code=4001)
                return
        else:
            logger.info('PersonalJoin: device connecting without Authorization token')

        # ── Device identity ────────────────────────────────────────────────────
        device_id = headers.get('x-device-id', '').strip()
        if not device_id:
            logger.warning('PersonalJoin: missing X-Device-ID header')
            await self.close(code=4000)
            return

        self.device_id = device_id
        self.device_name = headers.get('x-device-name', 'Unknown')
        self.device_country = headers.get('x-device-country', '')

        # ── Persist device presence in the database ────────────────────────────
        # Strategy:
        #   1. If the device sent X-Device-Serial, look for a legacy Device record
        #      whose identifier matches that serial (e.g. an ADB serial registered
        #      before the personal-join UUID flow existed).  If found, migrate it
        #      by updating its identifier to the UUID — all ownership, team, and
        #      session data on the old record is preserved.
        #   2. Otherwise (no serial, or no matching legacy record), upsert a Device
        #      keyed on the UUID so Device.identifier always matches the channel-group
        #      key used by the viewer (/ws/viewer/{identifier}/), ensuring that
        #      stream/start reaches this consumer.
        serial = headers.get('x-device-serial', '').strip()
        try:
            from devices.models import Device, DeviceStatus, DeviceType  # noqa: PLC0415

            device_obj = None
            if serial:
                # Try to find and migrate the legacy serial-keyed record.
                device_obj = await Device.objects.filter(identifier=serial).afirst()
                if device_obj is not None:
                    device_obj.identifier = device_id
                    device_obj.name = self.device_name
                    device_obj.device_type = DeviceType.PERSONAL
                    device_obj.status = DeviceStatus.ONLINE
                    await device_obj.asave(update_fields=['identifier', 'name', 'device_type', 'status'])
                    logger.info(
                        'PersonalJoin: migrated legacy record serial=%s → uuid=%s pk=%s',
                        serial, device_id, device_obj.pk,
                    )

            if device_obj is None:
                # No legacy record — upsert by UUID.
                # Use filter+afirst (same pattern as the serial path above) to
                # avoid MultipleObjectsReturned if duplicate rows exist in the DB.
                device_obj = await Device.objects.filter(identifier=device_id).afirst()
                if device_obj is not None:
                    device_obj.name = self.device_name
                    device_obj.device_type = DeviceType.PERSONAL
                    device_obj.status = DeviceStatus.ONLINE
                    await device_obj.asave(update_fields=['name', 'device_type', 'status'])
                else:
                    device_obj = await Device.objects.acreate(
                        identifier=device_id,
                        name=self.device_name,
                        device_type=DeviceType.PERSONAL,
                        status=DeviceStatus.ONLINE,
                    )

            self._device_pk = device_obj.pk
        except DatabaseError as exc:
            logger.warning('PersonalJoin: DB upsert failed for %s: %s', device_id, exc)
            self._device_pk = None

        self._last_activity = asyncio.get_event_loop().time()
        self.device_group = _device_group(device_id)
        self.viewer_group = _viewer_group(device_id)

        await self.channel_layer.group_add(self.device_group, self.channel_name)
        await self.accept()

        logger.info(
            'Device connected (personal/join): device_id=%s name=%s country=%s serial=%s',
            device_id, self.device_name, self.device_country, serial,
        )

        # Notify waiting viewers that the device is online.
        await self.channel_layer.group_send(
            self.viewer_group,
            {'type': 'device_online', 'identifier': device_id},
        )

        # Start idle-timeout watchdog.
        self._idle_task = asyncio.ensure_future(self._idle_timeout_loop())

        if self._device_pk is not None:
            await sync_to_async(dispatch_event, thread_sensitive=True)(
                SystemEvent.DEVICE_CONNECTED,
                EventSourceType.DEVICE,
                self._device_pk,
                {'identifier': device_id},
            )

    async def disconnect(self, close_code):
        if hasattr(self, '_idle_task'):
            self._idle_task.cancel()

        device_id = getattr(self, 'device_id', 'unknown')
        logger.info(
            'Device disconnecting (personal/join): device_id=%s code=%s',
            device_id, close_code,
        )

        # Mark the device as offline in the database.
        if getattr(self, '_device_pk', None) is not None:
            try:
                from devices.models import Device, DeviceStatus  # noqa: PLC0415
                await Device.objects.filter(pk=self._device_pk).aupdate(
                    status=DeviceStatus.OFFLINE,
                )
            except DatabaseError as exc:
                logger.warning('PersonalJoin: DB status update failed for %s: %s', device_id, exc)

        if hasattr(self, 'device_group'):
            await self.channel_layer.group_discard(self.device_group, self.channel_name)

        if hasattr(self, 'viewer_group'):
            await self.channel_layer.group_send(
                self.viewer_group,
                {'type': 'device_offline', 'identifier': device_id},
            )

        if getattr(self, '_device_pk', None) is not None:
            await sync_to_async(dispatch_event, thread_sensitive=True)(
                SystemEvent.DEVICE_DISCONNECTED,
                EventSourceType.DEVICE,
                self._device_pk,
                {'identifier': device_id, 'close_code': close_code},
            )

    async def receive(self, text_data=None, bytes_data=None):
        # Guard: connection may have been rejected before accept() was called.
        if not hasattr(self, 'device_id'):
            return

        self._last_activity = asyncio.get_event_loop().time()

        if bytes_data:
            # Binary DataChannel relay: device → viewers (e.g. reverse control acks).
            _log_binary_relay('PersonalJoin', self.device_id, 'device→viewer', len(bytes_data))
            await self.channel_layer.group_send(
                self.viewer_group,
                {'type': 'relay_bytes_to_viewer', 'data': bytes_data.hex()},
            )
            return

        if not text_data:
            return

        try:
            msg = json.loads(text_data)
        except json.JSONDecodeError:
            logger.warning('Device %s sent invalid JSON', self.device_id)
            return

        method = msg.get('method', '')
        msg_id = msg.get('id')

        logger.debug('Device (personal/join) %s -> method=%s', self.device_id, method)

        # Relay WebRTC signaling and stream-lifecycle events to connected viewers.
        if method in (
            'webrtc/offer', 'webrtc/answer', 'webrtc/ice',
            'stream/ready', 'stream/stopped', 'stream/error',
        ):
            _log_signaling('PersonalJoin', self.device_id, method, msg_id)
            await self.channel_layer.group_send(
                self.viewer_group,
                {'type': 'relay_to_viewer', 'message': msg},
            )

        # Persist device events (e.g. NOTIFICATION_POSTED) to the database.
        if method == 'events/device':
            params = msg.get('params') or {}
            if params.get('type') == 'NOTIFICATION_POSTED':
                await _save_notification(
                    self.device_id,
                    getattr(self, '_device_pk', None),
                    params,
                    msg,
                )

        # Send a JSON-RPC ACK for any request that carries an id, except for
        # 'webrtc/offer': the device expects a full 'webrtc/answer' back (not a
        # simple "ok"), so we skip the ACK and let the viewer's answer be
        # forwarded via relay_to_device.
        if msg_id is not None and method != 'webrtc/offer':
            await self.send(text_data=json.dumps({'id': msg_id, 'result': 'ok'}))

    # ── Channel layer event handlers ───────────────────────────────────────────

    async def relay_to_device(self, event):
        """Forward a JSON message from a viewer/backend to this device."""
        msg = event.get('message', {})
        method = msg.get('method', 'unknown')
        _log_signaling('PersonalJoin', self.device_id, f'relay→device:{method}', msg.get('id'))
        await self.send(text_data=json.dumps(msg))

    async def relay_bytes_to_device(self, event):
        """Forward binary control data (scrcpy protocol) from a viewer to this device."""
        raw = event.get('data', '')
        try:
            data = bytes.fromhex(raw) if isinstance(raw, str) else bytes(raw)
        except Exception:
            return
        _log_binary_relay('PersonalJoin', self.device_id, 'viewer→device', len(data))
        await self.send(bytes_data=data)

    # ── Idle-timeout watchdog ──────────────────────────────────────────────────

    async def _idle_timeout_loop(self):
        """Close the connection if no message is received for _IDLE_TIMEOUT seconds."""
        check_interval = min(60, _IDLE_TIMEOUT)
        while True:
            await asyncio.sleep(check_interval)
            elapsed = asyncio.get_event_loop().time() - self._last_activity
            if elapsed >= _IDLE_TIMEOUT:
                logger.info(
                    'Device %s idle timeout (%ds), closing connection',
                    self.device_id, _IDLE_TIMEOUT,
                )
                await self.close()
                break


# ── DeviceConsumer (legacy USB-serial path) ────────────────────────────────────

class DeviceConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for Android devices.

    Android devices connect to: wss://host/ws/device/{identifier}/
    Expected headers (sent by the device):
      - X-Device-ID:      device UUID
      - X-Device-Name:    model name
      - X-Device-Country: ISO country code
      - Authorization:    Bearer <token>  (optional)
    """

    async def connect(self):
        self.identifier = self.scope['url_route']['kwargs']['identifier']
        self.device_group = _device_group(self.identifier)
        self.viewer_group = _viewer_group(self.identifier)
        self._device_pk = None

        headers = {k.decode(): v.decode() for k, v in self.scope.get('headers', [])}
        device_id_header = headers.get('x-device-id', self.identifier)
        logger.info('Device connecting: identifier=%s x-device-id=%s', self.identifier, device_id_header)

        await self.channel_layer.group_add(self.device_group, self.channel_name)
        await self.accept()

        # Notify any waiting viewer that the device is now online
        await self.channel_layer.group_send(
            self.viewer_group,
            {'type': 'device_online', 'identifier': self.identifier},
        )

        self._device_pk = await _resolve_device_pk(self.identifier)
        if self._device_pk is not None:
            await sync_to_async(dispatch_event, thread_sensitive=True)(
                SystemEvent.DEVICE_CONNECTED,
                EventSourceType.DEVICE,
                self._device_pk,
                {'identifier': self.identifier},
            )

    async def disconnect(self, close_code):
        logger.info('Device disconnecting: identifier=%s code=%s', self.identifier, close_code)
        await self.channel_layer.group_discard(self.device_group, self.channel_name)
        # Notify viewers
        await self.channel_layer.group_send(
            self.viewer_group,
            {'type': 'device_offline', 'identifier': self.identifier},
        )

        if self._device_pk is not None:
            await sync_to_async(dispatch_event, thread_sensitive=True)(
                SystemEvent.DEVICE_DISCONNECTED,
                EventSourceType.DEVICE,
                self._device_pk,
                {'identifier': self.identifier, 'close_code': close_code},
            )

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            # Binary relay: device → viewers
            _log_binary_relay('Device', self.identifier, 'device→viewer', len(bytes_data))
            await self.channel_layer.group_send(
                self.viewer_group,
                {'type': 'relay_bytes_to_viewer', 'data': bytes_data.hex()},
            )
            return

        if not text_data:
            return
        try:
            msg = json.loads(text_data)
        except json.JSONDecodeError:
            logger.warning('Device %s sent invalid JSON', self.identifier)
            return

        method = msg.get('method', '')
        msg_id = msg.get('id')

        logger.debug('Device %s -> %s', self.identifier, method)

        # Relay signaling messages to viewer group
        if method in ('webrtc/offer', 'webrtc/answer', 'webrtc/ice', 'stream/ready', 'stream/stopped', 'stream/error'):
            _log_signaling('Device', self.identifier, method, msg_id)
            await self.channel_layer.group_send(
                self.viewer_group,
                {'type': 'relay_to_viewer', 'message': msg},
            )

        # Persist device events (e.g. NOTIFICATION_POSTED) to the database.
        if method == 'events/device':
            params = msg.get('params') or {}
            if params.get('type') == 'NOTIFICATION_POSTED':
                await _save_notification(self.identifier, None, params, msg)

        # Send JSON-RPC ACK for messages that have an id, except 'webrtc/offer':
        # when the device sends an offer it expects a full 'webrtc/answer' relayed
        # from the viewer (not a simple "ok"), so we skip the ACK here and let the
        # viewer's answer be forwarded back via the relay_to_device handler.
        if msg_id is not None and method != 'webrtc/offer':
            await self.send(text_data=json.dumps({'id': msg_id, 'result': 'ok'}))

    # ── Channel layer event handlers ──────────────────────────────────────────

    async def relay_to_device(self, event):
        """Forward a message from a viewer/backend to this device."""
        msg = event.get('message', {})
        method = msg.get('method', 'unknown')
        _log_signaling('Device', self.identifier, f'relay→device:{method}', msg.get('id'))
        await self.send(text_data=json.dumps(msg))

    async def relay_bytes_to_device(self, event):
        """Forward binary control data from a viewer to this device."""
        raw = event.get('data', '')
        try:
            data = bytes.fromhex(raw) if isinstance(raw, str) else bytes(raw)
        except Exception:
            return
        _log_binary_relay('Device', self.identifier, 'viewer→device', len(data))
        await self.send(bytes_data=data)


# ── ViewerConsumer ─────────────────────────────────────────────────────────────

class ViewerConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for browser viewers.

    Browsers connect to: wss://host/ws/viewer/{identifier}/
    where {identifier} is the device's identifier (UUID for personal-join devices,
    serial number for USB-connected devices).

    Roles:
      - Signals the device to start/stop streaming.
      - Relays WebRTC signaling (offer/answer/ICE) between device and browser.
      - Sends periodic webrtc/requestFrame keep-alive messages to the device.
      - Relays binary scrcpy control frames from the browser to the device, and
        any binary frames from the device back to the browser.

    Two signaling flows are supported:
      Flow A (default, waitForOffer=false): device creates SDP Offer.
      Flow B (waitForOffer=true):           server/viewer creates SDP Offer.
    """

    async def connect(self):
        self.identifier = self.scope['url_route']['kwargs']['identifier']
        self.device_group = _device_group(self.identifier)
        self.viewer_group = _viewer_group(self.identifier)
        self.session_id = str(uuid.uuid4())

        await self.channel_layer.group_add(self.viewer_group, self.channel_name)
        await self.accept()

        logger.info('Viewer connected for device %s session %s', self.identifier, self.session_id)

        # Push ICE server configuration (including any TURN credentials) to the
        # browser immediately after the WebSocket is accepted.  The browser must
        # receive this *before* the device's webrtc/offer so that the
        # RTCPeerConnection is created with the full ICE server list (STUN + TURN).
        # Without this, connections over 4G/5G (carrier-grade NAT) fail because
        # the browser would fall back to the hardcoded STUN-only default and TURN
        # relay would never be attempted.
        await self.send(text_data=json.dumps({
            'method': 'webrtc/rtcConfiguration',
            'params': {
                'rtcConfiguration': {
                    'iceServers': _get_ice_servers(),
                },
            },
        }))

        # Cancel any pending delayed stream/stop for this device (e.g. a previous
        # viewer disconnected and left a 2-minute stop timer running).
        pending = _pending_stop_tasks.pop(self.identifier, None)
        if pending is not None:
            pending.cancel()
            logger.info(
                'Viewer %s: cancelled pending stream/stop for device %s (new viewer arrived)',
                self.session_id, self.identifier,
            )

        # Ask the device to start streaming using Flow A (device creates offer).
        await self._send_stream_start(wait_for_offer=False)

        # Start keep-alive loop so the device doesn't idle-timeout.
        self._keepalive_task = asyncio.ensure_future(self._keepalive_loop())

    async def disconnect(self, close_code):
        if hasattr(self, '_keepalive_task'):
            self._keepalive_task.cancel()

        logger.info('Viewer disconnected for device %s session %s', self.identifier, self.session_id)

        # Replace any existing pending stop task for this device with a fresh one.
        # The grace period lets a reconnecting viewer cancel the stop before it fires.
        existing = _pending_stop_tasks.pop(self.identifier, None)
        if existing is not None:
            existing.cancel()
        _pending_stop_tasks[self.identifier] = asyncio.create_task(
            self._delayed_stream_stop(self.session_id),
        )
        logger.info(
            'Viewer %s: scheduled stream/stop for device %s in %ds',
            self.session_id, self.identifier, _VIEWER_DISCONNECT_STOP_DELAY,
        )

        await self.channel_layer.group_discard(self.viewer_group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            # Binary relay: browser → device (scrcpy control protocol).
            _log_binary_relay('Viewer', self.identifier, 'viewer→device', len(bytes_data))
            await self.channel_layer.group_send(
                self.device_group,
                {'type': 'relay_bytes_to_device', 'data': bytes_data.hex()},
            )
            return

        if not text_data:
            return
        try:
            msg = json.loads(text_data)
        except json.JSONDecodeError:
            logger.warning('Viewer sent invalid JSON for device %s', self.identifier)
            return

        method = msg.get('method', '')
        msg_id = msg.get('id')
        logger.debug('Viewer -> device %s: %s', self.identifier, method)

        if method in ('webrtc/answer', 'webrtc/ice'):
            # Core signaling relay: browser SDP answer / ICE candidates → device.
            _log_signaling('Viewer', self.identifier, f'viewer→device:{method}', msg_id)
            await self.channel_layer.group_send(
                self.device_group,
                {'type': 'relay_to_device', 'message': msg},
            )

        elif method == 'webrtc/offer':
            # Browser-initiated re-offer (renegotiation to add a control DataChannel
            # after the initial video-only connection).
            _log_signaling('Viewer', self.identifier, 'viewer→device:webrtc/offer', msg_id)
            await self.channel_layer.group_send(
                self.device_group,
                {'type': 'relay_to_device', 'message': msg},
            )

        elif method == 'webrtc/connect':
            # Browser-initiated shortcut: stream/start with waitForOffer=true.
            params = msg.get('params', {})
            _log_signaling('Viewer', self.identifier, 'webrtc/connect', msg_id,
                           width=params.get('width', 720), height=params.get('height', 1640))
            await self._send_stream_start(
                wait_for_offer=True,
                width=int(params.get('width', 720)),
                height=int(params.get('height', 1640)),
                fps=int(params.get('fps', settings.WEBRTC_STREAM_FPS)),
                ice_servers=params.get('iceServers'),
            )

        elif method == 'webrtc/rtcConfiguration':
            # Forward ICE server update directly to the device.
            _log_signaling('Viewer', self.identifier, 'webrtc/rtcConfiguration', msg_id)
            await self.channel_layer.group_send(
                self.device_group,
                {'type': 'relay_to_device', 'message': msg},
            )

        elif method in ('webrtc/requestFrame', 'webrtc/keepAlive'):
            # Forward explicit keep-alive / keyframe requests from the browser.
            _log_signaling('Viewer', self.identifier, method, msg_id)
            await self.channel_layer.group_send(
                self.device_group,
                {'type': 'relay_to_device', 'message': msg},
            )

    # ── Helpers ────────────────────────────────────────────────────────────────

    async def _delayed_stream_stop(self, session_id: str):
        """
        Wait for _VIEWER_DISCONNECT_STOP_DELAY seconds, then send stream/stop to the
        device.  This task is cancelled if a new viewer reconnects within the window.

        The task removes itself from _pending_stop_tasks only when the entry still
        matches this task, preventing a newer stop-task (created by a subsequent
        disconnect) from being inadvertently removed from tracking.
        """
        current_task = asyncio.current_task()
        try:
            await asyncio.sleep(_VIEWER_DISCONNECT_STOP_DELAY)
        except asyncio.CancelledError:
            logger.info(
                'Viewer %s: delayed stream/stop for device %s was cancelled (viewer reconnected)',
                session_id, self.identifier,
            )
            return
        # Only deregister this task if it is still the active one for this device.
        if _pending_stop_tasks.get(self.identifier) is current_task:
            _pending_stop_tasks.pop(self.identifier, None)
        logger.info(
            'Viewer %s: sending stream/stop to device %s after %ds grace period',
            session_id, self.identifier, _VIEWER_DISCONNECT_STOP_DELAY,
        )
        await self.channel_layer.group_send(
            self.device_group,
            {
                'type': 'relay_to_device',
                'message': {
                    'method': 'stream/stop',
                    'params': {'sessionId': session_id},
                    'id': f'stop-{session_id}',
                },
            },
        )

    async def _send_stream_start(
        self,
        *,
        wait_for_offer: bool,
        width: int = 720,
        height: int = 1640,
        fps: int = settings.WEBRTC_STREAM_FPS,
        ice_servers: list | None = None,
    ):
        if ice_servers is None:
            ice_servers = _get_ice_servers()
        _log_signaling(
            'Viewer', self.identifier, 'stream/start', f'start-{self.session_id}',
            session_id=self.session_id, width=width, height=height, fps=fps,
            wait_for_offer=wait_for_offer,
        )
        await self.channel_layer.group_send(
            self.device_group,
            {
                'type': 'relay_to_device',
                'message': {
                    'method': 'stream/start',
                    'params': {
                        'sessionId': self.session_id,
                        'width': width,
                        'height': height,
                        'fps': fps,
                        'waitForOffer': wait_for_offer,
                        'iceServers': ice_servers,
                    },
                    'id': f'start-{self.session_id}',
                },
            },
        )

    async def _keepalive_loop(self):
        """Send webrtc/requestFrame to the device every _KEEPALIVE_INTERVAL seconds."""
        while True:
            await asyncio.sleep(_KEEPALIVE_INTERVAL)
            _log_signaling(
                'Viewer', self.identifier, 'webrtc/requestFrame', None,
                session_id=self.session_id,
            )
            await self.channel_layer.group_send(
                self.device_group,
                {
                    'type': 'relay_to_device',
                    'message': {
                        'method': 'webrtc/requestFrame',
                        'params': {'sessionId': self.session_id},
                    },
                },
            )

    # ── Channel layer event handlers ──────────────────────────────────────────

    async def relay_to_viewer(self, event):
        """Forward a message from the device to this viewer."""
        msg = event.get('message', {})
        method = msg.get('method', 'unknown')
        _log_signaling('Viewer', self.identifier, f'device→viewer:{method}', msg.get('id'))
        await self.send(text_data=json.dumps(msg))

    async def relay_bytes_to_viewer(self, event):
        """Forward binary data from the device to this viewer."""
        raw = event.get('data', '')
        try:
            data = bytes.fromhex(raw) if isinstance(raw, str) else bytes(raw)
        except Exception:
            return
        _log_binary_relay('Viewer', self.identifier, 'device→viewer', len(data))
        await self.send(bytes_data=data)

    async def device_online(self, event):
        logger.info('[Viewer] device=%s event=device/online', self.identifier)
        await self.send(text_data=json.dumps({
            'method': 'device/online',
            'params': {'identifier': event['identifier']},
        }))

    async def device_offline(self, event):
        logger.info('[Viewer] device=%s event=device/offline', self.identifier)
        await self.send(text_data=json.dumps({
            'method': 'device/offline',
            'params': {'identifier': event['identifier']},
        }))


# ── TaskStatusConsumer ──────────────────────────────────────────────────────

class TaskStatusConsumer(AsyncWebsocketConsumer):
    """WebSocket consumer that streams live task events to the browser.

    The browser connects to ``wss://host/ws/task/{task_id}/`` after starting a
    task.  When the devices_worker processes a ``task_status`` Kafka message it
    publishes the event to the Redis pub/sub channel ``task:{task_id}:events``.
    This consumer subscribes to that channel and forwards every message to the
    connected browser client as JSON.

    The consumer also requires a valid JWT Bearer token in the
    ``Authorization`` query-string parameter (``?token=<jwt>``) so that
    unauthenticated browsers cannot subscribe to arbitrary task streams.
    """

    async def connect(self):
        import redis.asyncio as aioredis  # noqa: PLC0415

        self.task_id = self.scope['url_route']['kwargs']['task_id']

        # ── JWT auth via query-string token ───────────────────────────────────
        from urllib.parse import unquote  # noqa: PLC0415

        query_string = self.scope.get('query_string', b'').decode()
        token_str = None
        for part in query_string.split('&'):
            if part.startswith('token='):
                token_str = unquote(part[len('token='):])
                break

        if not token_str:
            logger.warning('TaskStatus WS: missing token for task %s', self.task_id)
            await self.close(code=4001)
            return

        try:
            from rest_framework_simplejwt.tokens import UntypedToken  # noqa: PLC0415
            UntypedToken(token_str)
        except Exception as exc:
            logger.warning('TaskStatus WS: invalid token for task %s: %s', self.task_id, exc)
            await self.close(code=4001)
            return

        await self.accept()

        # ── Subscribe to Redis pub/sub ─────────────────────────────────────────
        redis_url = getattr(settings, 'REDIS_URL', 'redis://redis:6379/0')
        self._redis = aioredis.from_url(redis_url)
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(f'task:{self.task_id}:events')
        self._listener_task = asyncio.create_task(self._listen())

        logger.info('TaskStatus WS: client connected for task %s', self.task_id)

    async def disconnect(self, close_code):
        if hasattr(self, '_listener_task'):
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        if hasattr(self, '_pubsub'):
            try:
                await self._pubsub.unsubscribe(f'task:{self.task_id}:events')
                await self._pubsub.aclose()
            except Exception:
                pass
        if hasattr(self, '_redis'):
            try:
                await self._redis.aclose()
            except Exception:
                pass
        logger.info('TaskStatus WS: client disconnected for task %s (code=%s)', self.task_id, close_code)

    async def _listen(self):
        """Forward Redis pub/sub messages to the WebSocket client."""
        try:
            async for message in self._pubsub.listen():
                if message['type'] == 'message':
                    data = message['data']
                    if isinstance(data, bytes):
                        data = data.decode()
                    await self.send(text_data=data)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.warning('TaskStatus WS: listener error for task %s: %s', self.task_id, exc)
