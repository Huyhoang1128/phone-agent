"""WebSocket consumer cho Chatbot TikTok Inbox (Phase 2.3.4).

Endpoint: `wss://host/ws/tiktok-inbox/{device_id}/?token=<jwt>`

Pattern follow `stream.consumers.TaskStatusConsumer`:
- JWT validate qua `?token=` query string (signature-only — không lookup user
  từ DB để tránh sync DB hit trong async context).
- Sau khi connect → subscribe channel layer group `tiktok-inbox-{device_id}`.
- Forward mọi event (message.created / peer_mute.changed) tới client dưới dạng
  JSON.

Authorization: SAU khi JWT valid, decode `user_id` từ token và check
`_can_access_device` async (qua `sync_to_async`).
"""
from __future__ import annotations

import json
import logging
from urllib.parse import unquote

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from .realtime import _group_name

logger = logging.getLogger(__name__)


class TiktokInboxConsumer(AsyncWebsocketConsumer):
    """Realtime feed các event của 1 device's TikTok inbox."""

    async def connect(self):
        self.device_id_raw = self.scope['url_route']['kwargs'].get('device_id')
        try:
            self.device_id = int(self.device_id_raw)
        except (TypeError, ValueError):
            await self.close(code=4000)
            return

        # ── JWT auth via query-string token ──────────────────────────────────
        query_string = self.scope.get('query_string', b'').decode()
        token_str = None
        for part in query_string.split('&'):
            if part.startswith('token='):
                token_str = unquote(part[len('token='):])
                break
        if not token_str:
            logger.warning('TiktokInbox WS: missing token for device %s', self.device_id)
            await self.close(code=4001)
            return

        try:
            from rest_framework_simplejwt.tokens import UntypedToken  # noqa: PLC0415
            decoded = UntypedToken(token_str)
        except Exception as exc:  # noqa: BLE001
            logger.warning('TiktokInbox WS: invalid token for device %s: %s', self.device_id, exc)
            await self.close(code=4001)
            return

        user_id = decoded.get('user_id')
        if not user_id:
            await self.close(code=4001)
            return

        # ── Device access check ──────────────────────────────────────────────
        allowed = await self._can_access_device(user_id, self.device_id)
        if not allowed:
            logger.warning(
                'TiktokInbox WS: user %s denied access to device %s',
                user_id, self.device_id,
            )
            await self.close(code=4003)
            return

        # ── Subscribe channel layer group ────────────────────────────────────
        self.group_name = _group_name(self.device_id)
        if self.channel_layer is None:
            logger.error('TiktokInbox WS: channel_layer is None (CHANNEL_LAYERS chưa setup?)')
            await self.close(code=1011)
            return
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        logger.info('TiktokInbox WS: user %s connected device %s', user_id, self.device_id)

    async def disconnect(self, close_code):
        group = getattr(self, 'group_name', None)
        if group and self.channel_layer is not None:
            try:
                await self.channel_layer.group_discard(group, self.channel_name)
            except Exception:  # noqa: BLE001 — defensive cleanup
                pass
        logger.info(
            'TiktokInbox WS: disconnected device %s (code=%s)',
            getattr(self, 'device_id', '?'), close_code,
        )

    # ── Channel layer event handler ──────────────────────────────────────────

    async def forward_event(self, event: dict):
        """Receive event từ `group_send` → encode JSON → send tới client.

        Method name `forward_event` map với `'type': 'forward.event'` trong
        `realtime._publish_safe`.
        """
        await self.send(text_data=json.dumps({
            'event_type': event.get('event_type'),
            'payload': event.get('payload') or {},
        }, default=str))

    # ── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    @sync_to_async
    def _can_access_device(user_id: int, device_id: int) -> bool:
        """Sync DB query qua sync_to_async."""
        from django.contrib.auth.models import User  # noqa: PLC0415
        from devices.models import Device  # noqa: PLC0415
        from teams.models import TeamMembership  # noqa: PLC0415

        try:
            device = Device.objects.get(pk=device_id)
        except Device.DoesNotExist:
            return False
        if device.owner_id == user_id:
            return True
        if device.team_id is None:
            return False
        return TeamMembership.objects.filter(
            team_id=device.team_id, user_id=user_id,
        ).exists()
