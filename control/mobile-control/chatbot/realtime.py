"""Realtime broadcast helpers cho Chatbot TikTok Inbox (Phase 2.3.4).

Publish events tới channel layer group `tiktok-inbox-{device_id}`. WS consumer
`TiktokInboxConsumer` subscribe group này và forward sang client.

Events:
- `message.created` — TiktokMessage mới (IN từ peer hoặc OUT từ bot)
- `peer_mute.changed` — TiktokPeerMute create / update / delete

Caller KHÔNG cần await — `_publish_safe` swallow exception (channel layer fail
không được crash flow sync chính như save notification).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

# NOTE: KHÔNG import `inbox_serializers` / `models` ở top-level. Module này
# được kéo vào qua `stream.routing` lúc Daphne boot ASGI app → Django apps
# CHƯA ready → import models sẽ raise `AppRegistryNotReady`. Lazy import bên
# trong từng function thay vào đó (cùng pattern `stream/consumers.py`).
if TYPE_CHECKING:
    from .models import TiktokMessage, TiktokPeerMute

logger = logging.getLogger(__name__)


def _group_name(device_id: int) -> str:
    return f'tiktok-inbox-{device_id}'


def _publish_safe(device_id: int, event_type: str, payload: dict[str, Any]) -> None:
    """Gửi message tới channel layer group; nuốt mọi exception (degraded mode)."""
    layer = get_channel_layer()
    if layer is None:
        logger.debug('Channel layer chưa cấu hình → skip publish %s', event_type)
        return
    try:
        async_to_sync(layer.group_send)(
            _group_name(device_id),
            {
                'type': 'forward.event',  # method name trong consumer
                'event_type': event_type,
                'payload': payload,
            },
        )
    except Exception as exc:  # noqa: BLE001 — broad catch by design
        logger.warning(
            'tiktok.realtime publish failed (device=%s event=%s): %s',
            device_id, event_type, exc, exc_info=True,
        )


def publish_message_created(message: 'TiktokMessage') -> None:
    """Broadcast khi 1 TiktokMessage mới được tạo (IN hoặc OUT)."""
    from .inbox_serializers import TiktokMessageSerializer  # lazy — xem note top file
    try:
        data = TiktokMessageSerializer(message).data
    except Exception as exc:  # noqa: BLE001
        logger.warning('Serialize TiktokMessage %s failed: %s', message.id, exc)
        return
    _publish_safe(
        message.device_id,
        'message.created',
        {
            'device_id': message.device_id,
            'peer_handle': message.peer_handle,
            'message': data,
        },
    )


def publish_peer_mute_changed(mute: 'TiktokPeerMute', action: str) -> None:
    """Broadcast khi mute thay đổi.

    Args:
        mute: instance (vẫn còn nguyên cho create/update; với delete cần snapshot
              trước khi instance bị delete).
        action: 'created' | 'updated' | 'deleted'
    """
    from .inbox_serializers import TiktokPeerMuteSerializer  # lazy — xem note top file
    try:
        data = TiktokPeerMuteSerializer(mute).data
    except Exception as exc:  # noqa: BLE001
        logger.warning('Serialize TiktokPeerMute %s failed: %s', getattr(mute, 'id', '?'), exc)
        return
    _publish_safe(
        mute.device_id,
        'peer_mute.changed',
        {
            'device_id': mute.device_id,
            'peer_handle': mute.peer_handle,
            'action': action,
            'mute': data,
        },
    )
