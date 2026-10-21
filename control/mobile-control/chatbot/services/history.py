"""Unified conversation history builder cho TikTok chatbot.

Trước Phase 2.8 có 3 phiên bản duplicate:
- `chatbot/internal_views.py:_build_history_string` (sync)
- `stream/consumers.py:_build_tiktok_history` (async)
- `chatbot/management/commands/run_chatbot_buffer_sweeper.py:_build_history_sync` (sync)

Sau Phase 2.8 (TCS-v1): gom về service này, có filter `delivery_status` để
LOẠI các tin chưa chắc khách thấy (`pending`/`failed`/`unknown`) — chỉ giữ
`sent` (chắc đã gửi) và NULL (user IN msg).

Lý do filter: nếu inject row `pending` vào prompt LLM lần sau, LLM tưởng bot
đã nói câu đó → KHÔNG lặp lại → nhưng khách thật sự CHƯA thấy → bối rối.
"""
from __future__ import annotations

from asgiref.sync import sync_to_async


DEFAULT_LIMIT = 10


def build_history_string(device, peer_handle: str, limit: int = DEFAULT_LIMIT) -> str:
    """Build chuỗi history `[user]/[bot] content` cho LLM prompt.

    Filter:
    - `is_active=True` (loại soft-deleted)
    - Loại `message_type=SYSTEM`
    - Loại BOT msg có `delivery_status` khác `sent` (pending/failed/unknown)
      — chỉ giữ cái khách thật sự nhìn thấy trên TikTok

    Format output:
        [user] tin nhắn 1
        [bot] reply 1
        [user] tin nhắn 2

    Trả chuỗi rỗng nếu chưa có tin nào.
    """
    from django.db.models import Q  # noqa: PLC0415

    from chatbot.models import (  # noqa: PLC0415
        TiktokMessage,
        TiktokMessageDeliveryStatus,
        TiktokMessageType,
    )

    rows = (
        TiktokMessage.objects.filter(
            device=device,
            peer_handle=peer_handle,
            is_active=True,
        )
        .exclude(message_type=TiktokMessageType.SYSTEM)
        .filter(
            Q(delivery_status__isnull=True)
            | Q(delivery_status=TiktokMessageDeliveryStatus.SENT),
        )
        .order_by('-created_at')[:limit]
        .values('message_type', 'content')
    )

    lines = []
    for r in reversed(list(rows)):
        prefix = '[bot]' if r['message_type'] == TiktokMessageType.BOT else '[user]'
        lines.append(f'{prefix} {r["content"]}')
    return '\n'.join(lines)


async def abuild_history_string(device, peer_handle: str, limit: int = DEFAULT_LIMIT) -> str:
    """Async wrapper cho `build_history_string` — dùng trong WebSocket consumer."""
    return await sync_to_async(build_history_string, thread_sensitive=True)(
        device, peer_handle, limit,
    )
