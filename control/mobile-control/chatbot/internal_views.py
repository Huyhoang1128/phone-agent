"""Internal views cho Chatbot TikTok — n8n bridge callback (revise Q4.b).

Endpoint: `POST /api/internal/n8n-notify-callback/`

Context: design v9 ban đầu chốt catalog YAML inline backend (drop n8n classifier).
Sau Phase 2.4 user pivot — adopt n8n bridge:
- n8n workflow `Tiktok_chatbot` nhận noti forward từ backend `_forward_to_n8n`
  (legacy code có sẵn, env `N8N_TIKTOK_CHAT_WEBHOOK_URL=...trigger-notify`).
- n8n classify event_type + extract peer_handle/content qua Code/Function node.
- n8n HTTP Request node POST callback về endpoint này với event_type đã quyết.
- Endpoint dispatch_event(DEVICE_NOTIFY) → handle_event_triggers fire trigger
  workflow PhoneAgent → tạo WorkflowRun → workflow-runner execute steps.

Lý do pivot (UA Phase 2.4): TikTok đổi format noti version mới → user fix
nhanh trên n8n UI thay vì đợi deploy backend. Visual classify cho non-IT.

Pipeline tiktok_dm vẫn đi qua AdaptiveMessageBuffer + special marker check
+ mute check (đồng nhất với pipeline inline matcher) để KHÔNG mất các tính năng
Phase 2.2 (sticker auto-mute, voice auto-mute, debounce DM rời rạc).

Security: shared-secret token qua `Authorization: Bearer <N8N_CALLBACK_TOKEN>`
header (n8n HTTP Request node có UI built-in cho Bearer auth).
"""
from __future__ import annotations

import hmac
import logging

from django.conf import settings
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

from devices.models import Device, DeviceNotification
from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event

from .buffer import get_buffer
from .models import (
    TiktokMessage,
    TiktokMessageChannel,
    TiktokMessageSource,
    TiktokMessageType,
    TiktokPeerMute,
)

logger = logging.getLogger(__name__)


# Markers TikTok app dùng cho non-text DM. Đồng bộ với
# `stream/consumers.py:SPECIAL_MARKERS_NEED_HUMAN`.
_MARKERS_NEED_HUMAN = ('[Sticker]', '[Voice message]')
_AUTO_MUTE_HOURS = 24


@api_view(['POST'])
@authentication_classes([])  # KHÔNG dùng JWT — token bearer riêng
@permission_classes([permissions.AllowAny])
def n8n_notify_callback(request):
    """`POST /api/internal/n8n-notify-callback/`

    Body JSON:
        {
            "device_id": 8,                      # required
            "event_type": "tiktok_dm",           # required (vd tiktok_dm, tiktok_follow, ...)
            "peer_handle": "BS A",         # required
            "content": "Em hỏi giá nâng ngực",   # required
            "notification_id": 84,               # optional — DB DeviceNotification.id nếu n8n biết
            "raw": { ... }                       # optional — pass original n8n payload (log/audit)
        }

    Response:
        200: {status: 'dispatched'|'buffered'|'auto_muted'|'muted_skip', ...}
        400: validation error
        403: missing/invalid token
        404: device not found
    """
    # ── Auth: shared-secret token Bearer ─────────────────────────────────────
    expected = getattr(settings, 'N8N_CALLBACK_TOKEN', '') or ''
    if not expected:
        # Endpoint disabled khi env chưa set — tránh open relay.
        logger.warning('n8n callback hit nhưng N8N_CALLBACK_TOKEN chưa cấu hình.')
        return Response({'detail': 'Endpoint disabled.'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

    auth_header = request.META.get('HTTP_AUTHORIZATION', '') or ''
    if not auth_header.startswith('Bearer '):
        return Response({'detail': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)
    presented = auth_header[len('Bearer '):].strip()
    if not hmac.compare_digest(expected, presented):
        return Response({'detail': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)

    # ── Parse + validate body ────────────────────────────────────────────────
    body = request.data or {}
    device_id_raw = body.get('device_id')
    event_type = (body.get('event_type') or '').strip()
    peer_handle = (body.get('peer_handle') or '').strip()
    content = body.get('content') or ''
    notification_id = body.get('notification_id')
    raw = body.get('raw') or {}

    if not event_type:
        return Response({'detail': 'event_type is required.'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        device_id = int(device_id_raw)
    except (TypeError, ValueError):
        return Response({'detail': 'device_id must be an integer.'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        device = Device.objects.get(pk=device_id)
    except Device.DoesNotExist:
        return Response({'detail': 'Device not found.'}, status=status.HTTP_404_NOT_FOUND)

    logger.info(
        'n8n callback: device=%s event_type=%s peer=%s content=%r notif_id=%s',
        device_id, event_type, peer_handle, content[:60], notification_id,
    )

    # ── DM pipeline: TiktokMessage IN + marker + mute + buffer ───────────────
    if event_type == 'tiktok_dm' and peer_handle:
        return _handle_dm_callback(
            device=device, peer_handle=peer_handle, content=content,
            notification_id=notification_id, raw=raw,
        )

    # ── Other event types: dispatch ngay (follow/comment/...) ────────────────
    return _dispatch_and_respond(
        device=device, event_type=event_type, peer_handle=peer_handle,
        content=content, notification_id=notification_id, raw=raw,
        dispatch_kind='direct',
    )


# ── Helpers (sync) ───────────────────────────────────────────────────────────


# Social activity content patterns — noti gợi ý video / follow / like, KHÔNG phải DM.
# Match case-insensitive; nếu content chứa bất kỳ pattern nào → reject.
_SOCIAL_ACTIVITY_CONTENT_PATTERNS = (
    'đã đăng bài',
    'đã follow bạn',
    'đã bắt đầu follow',
    'đã thích video',
    'đã chia sẻ',
    'đã bình luận về',
    'người mà bạn có thể',
    'gợi ý cho bạn',
    'has posted',
    'started following',
    'liked your',
    'shared your',
    'commented on',
)

# Promotional title patterns — noti push marketing từ TikTok, KHÔNG phải DM.
# Match khi title contains pattern (case-insensitive).
_PROMOTIONAL_TITLE_PATTERNS = (
    'ơi, dành riêng cho bạn',
    'dành riêng cho bạn',
    'dành cho bạn này',
    'xin chào',  # title pattern "Xin chào {self_username}" — push social
)


def _is_garbage_dm_noti(*, peer_handle: str, content: str, raw: dict | None = None) -> str | None:
    """Filter noti rác từ TikTok system / app-name fallback / social activity push.

    Vì pipeline scrape Android notification thay vì TikTok API chính thống
    (xem `docs/Chatbot_Tiktok/notification_filter_quirks.md`), gặp các noti
    KHÔNG phải DM thật. 5 case hiện đã filter:

    1. **empty_content**: TikTok push noti "You have a new message" body rỗng.
    2. **empty_peer_handle**: noti hệ thống, không có target peer.
    3. **peer_is_app_name**: peer="TikTok" — fallback dùng app name khi không
       expose peer username.
    4. **social_activity_noti**: content match pattern "{user} đã đăng bài",
       "đã follow bạn", "gợi ý cho bạn", ... — noti gợi ý feed/social.
    5. **promotional_title**: title match "Xin chào {self}", "ơi, dành riêng
       cho bạn" — noti marketing push của TikTok.

    `raw` là dict optional chứa fields từ n8n payload (title, ...).

    Trả về reason string nếu noti rác, None nếu hợp lệ.
    """
    # Case 1-3: structural checks (cheap)
    if not content or not content.strip():
        return 'empty_content'
    if not peer_handle or not peer_handle.strip():
        return 'empty_peer_handle'
    if peer_handle.strip().lower() == 'tiktok':
        return 'peer_is_app_name'

    # Case 4: content match social activity patterns
    content_lower = content.lower()
    if any(p in content_lower for p in _SOCIAL_ACTIVITY_CONTENT_PATTERNS):
        return 'social_activity_noti'

    # Case 5: title match promotional patterns (chỉ check nếu raw có title)
    title = ''
    if isinstance(raw, dict):
        # Title có thể ở root hoặc nested trong raw.notification.title
        title = (raw.get('title') or '').strip()
        if not title and isinstance(raw.get('notification'), dict):
            title = (raw['notification'].get('title') or '').strip()
    if title:
        title_lower = title.lower()
        if any(p in title_lower for p in _PROMOTIONAL_TITLE_PATTERNS):
            return 'promotional_title'

    return None


def _handle_dm_callback(*, device, peer_handle, content, notification_id, raw):
    """DM pipeline mirror `stream/consumers.py:_buffer_or_dispatch_dm` async
    version — port sang sync cho DRF view.
    """
    # Step 0: Guard noti rác (xem docs/Chatbot_Tiktok/notification_filter_quirks.md).
    # Cách "ma giáo" — scrape Android noti thay vì TikTok API — có 5 case noti rác:
    # empty_content, empty_peer_handle, peer_is_app_name, social_activity_noti, promotional_title.
    garbage_reason = _is_garbage_dm_noti(peer_handle=peer_handle, content=content, raw=raw)
    if garbage_reason:
        logger.info(
            'Skip garbage DM noti: reason=%s peer=%r content_len=%d notif_id=%s',
            garbage_reason, peer_handle, len(content or ''), notification_id,
        )
        return Response({'status': 'skipped_garbage', 'reason': garbage_reason})

    # Step 1: insert TiktokMessage IN (source=notification, is_preview=True).
    #
    # FK quan trọng: `source_notification_id` PHẢI là `DeviceNotification.id`
    # (DB pk), KHÔNG phải Android `notification_id` int. n8n forward truyền
    # field Android ID — lookup ngược về DB pk qua (device, notification_id)
    # rồi mới gán FK. Nếu không tìm thấy (race / chưa insert) thì set None để
    # tránh FK violation.
    source_notif_pk = _resolve_source_notification_pk(device, notification_id)
    try:
        TiktokMessage.objects.create(
            device=device, peer_handle=peer_handle,
            channel=TiktokMessageChannel.DM,
            content=content,
            message_type=TiktokMessageType.USER,
            source=TiktokMessageSource.NOTIFICATION,
            is_preview=True,
            source_notification_id=source_notif_pk,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning('n8n callback: insert TiktokMessage IN failed: %s', exc)

    # Step 2: special marker → auto-mute 24h + skip dispatch.
    marker = _detect_special_marker(content)
    if marker is not None:
        TiktokPeerMute.objects.update_or_create(
            device=device, peer_handle=peer_handle,
            defaults={
                'muted_until': timezone.now() + timezone.timedelta(hours=_AUTO_MUTE_HOURS),
                'note': f'Auto-mute do nhận {marker} từ peer (n8n bridge)',
            },
        )
        return Response({
            'status': 'auto_muted', 'marker': marker,
            'muted_hours': _AUTO_MUTE_HOURS,
        })

    # Step 3: mute check — peer đã muted thì skip dispatch.
    if _is_peer_muted(device.id, peer_handle):
        return Response({'status': 'muted_skip'})

    # Step 4: build history + buffer add.
    history = _build_history_string(device, peer_handle)
    try:
        should_flush, flushed_msgs = get_buffer().add_message(
            device_id=device.id, peer_handle=peer_handle,
            content=content, history=history,
        )
    except Exception as exc:  # noqa: BLE001
        # Buffer fail (Redis down?) — fallback dispatch ngay với content gốc
        # để KHÔNG mất noti.
        logger.warning('n8n callback: buffer failed → dispatch direct: %s', exc)
        return _dispatch_and_respond(
            device=device, event_type='tiktok_dm', peer_handle=peer_handle,
            content=content, notification_id=notification_id, raw=raw,
            dispatch_kind='dm_buffer_fallback',
        )

    if not should_flush:
        return Response({'status': 'buffered', 'flushed': False})

    # Step 5: flush → dispatch với combined content.
    combined_content = '\n'.join(flushed_msgs) if flushed_msgs else content
    return _dispatch_and_respond(
        device=device, event_type='tiktok_dm', peer_handle=peer_handle,
        content=combined_content, notification_id=notification_id, raw=raw,
        dispatch_kind='dm_flushed',
        extra_payload={
            'flushed_message_count': len(flushed_msgs) if flushed_msgs else 1,
            'history': history,
        },
    )


def _dispatch_and_respond(
    *, device, event_type, peer_handle, content, notification_id, raw,
    dispatch_kind: str, extra_payload: dict | None = None,
):
    """Dispatch DEVICE_NOTIFY → handle_event_triggers tạo WorkflowRun cho mọi
    trigger có `event_filter` match payload. Trả về thông tin debug.
    """
    payload = {
        'identifier': device.identifier or '',
        # TCS-v2: expose `device_serial` top-level cho event_filter dot-path
        # filter theo serial (vd `{'device_serial': '416H4EFS222CS'}`) —
        # robust hơn binding theo Device DB id (id đổi khi user CRUD device).
        'device_serial': device.device_serial_id or '',
        'notification_type': 'tiktok_n8n_bridge',
        'payload': raw or {},
        # Enrich cho WorkflowTrigger.event_filter deep-match.
        'event_type': event_type,
        'peer_handle': peer_handle,
        'content': content,
        'notification_id': notification_id,
    }
    if extra_payload:
        payload.update(extra_payload)

    try:
        # dispatch_event return số trigger đã match (tùy implementation —
        # nếu trả None thì cứ log đơn giản).
        result = dispatch_event(
            SystemEvent.DEVICE_NOTIFY,
            EventSourceType.DEVICE,
            device.id,
            payload,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error('n8n callback: dispatch_event failed: %s', exc, exc_info=True)
        return Response(
            {'detail': 'dispatch_event failed', 'error': str(exc)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    return Response({
        'status': 'dispatched',
        'dispatch_kind': dispatch_kind,
        'event_type': event_type,
        'peer_handle': peer_handle,
        'dispatch_result': result if isinstance(result, (int, str, list, dict)) else None,
    })


def _resolve_source_notification_pk(device, android_notification_id) -> int | None:
    """n8n forward truyền `notification_id` là Android ID (BigInt), KHÔNG phải
    DB pk. Lookup ngược về `DeviceNotification.id` (FK target) qua field
    `notification_id` + `device`. Trả None nếu không match — TiktokMessage.create
    sẽ set FK NULL (model cho phép null=True).
    """
    if android_notification_id is None:
        return None
    try:
        n = (
            DeviceNotification.objects
            .filter(device=device, notification_id=android_notification_id)
            .order_by('-id')
            .values_list('id', flat=True)
            .first()
        )
        return n
    except Exception as exc:  # noqa: BLE001
        logger.debug('lookup DeviceNotification failed: %s', exc)
        return None


def _detect_special_marker(content: str) -> str | None:
    """`[Sticker]` / `[Voice message]` markers TikTok app gửi cho non-text DM."""
    if not content:
        return None
    stripped = content.strip()
    for m in _MARKERS_NEED_HUMAN:
        if m == stripped or m in stripped:
            return m
    return None


def _is_peer_muted(device_id: int, peer_handle: str) -> bool:
    from django.db.models import Q  # noqa: PLC0415
    now = timezone.now()
    return TiktokPeerMute.objects.filter(
        device_id=device_id, peer_handle=peer_handle,
    ).filter(
        Q(muted_until__isnull=True) | Q(muted_until__gte=now),
    ).exists()


def _build_history_string(device, peer_handle: str, limit: int = 10) -> str:
    """Thin wrapper — delegate sang `chatbot.services.history.build_history_string`."""
    from chatbot.services.history import build_history_string  # noqa: PLC0415
    return build_history_string(device, peer_handle, limit=limit)
