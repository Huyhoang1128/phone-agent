"""Serializers cho Chatbot TikTok Inbox (Phase 2.3).

Tách module riêng khỏi `tiktok/serializers.py` để không lẫn với code TikTok cũ
(video crawl, comment plan, keyword list). Xem `docs/Chatbot_Tiktok/design.md`
mục 13 (API endpoints) + HANDOFF.md task 2.3.1-2.3.3.
"""
from __future__ import annotations

from rest_framework import serializers

from .models import TiktokMessage, TiktokPeerMute


class TiktokConversationListItemSerializer(serializers.Serializer):
    """1 conversation = composite key `(device, peer_handle)`.

    KHÔNG phải `ModelSerializer` vì payload là kết quả aggregate (GROUP BY
    peer_handle + JOIN last message + JOIN mute). View tự build dict.
    """

    peer_handle = serializers.CharField()
    last_message_at = serializers.DateTimeField()
    last_message_content = serializers.CharField()
    last_message_type = serializers.CharField()
    last_message_channel = serializers.CharField()
    last_message_is_preview = serializers.BooleanField()
    message_count = serializers.IntegerField()
    is_muted = serializers.BooleanField()
    muted_until = serializers.DateTimeField(allow_null=True)


class TiktokMessageSerializer(serializers.ModelSerializer):
    """Read-only — message chỉ tạo qua notification consumer / kafka listener."""

    source_task_id = serializers.IntegerField(source='source_task.id', read_only=True, allow_null=True)
    source_notification_id = serializers.IntegerField(
        source='source_notification.id', read_only=True, allow_null=True,
    )

    class Meta:
        model = TiktokMessage
        fields = [
            'id',
            'peer_handle',
            'channel',
            'content',
            'message_type',
            'source',
            'is_preview',
            'source_task_id',
            'source_notification_id',
            'video_id',
            'created_at',
        ]
        read_only_fields = fields


class TiktokPeerMuteSerializer(serializers.ModelSerializer):
    """User-controlled pause AI per peer.

    `is_active` là property (computed) — luôn read-only.
    `created_by` auto-set từ `request.user` trong view, không cho client gửi.
    """

    is_active = serializers.BooleanField(read_only=True)
    created_by_id = serializers.IntegerField(source='created_by.id', read_only=True, allow_null=True)

    class Meta:
        model = TiktokPeerMute
        fields = [
            'id',
            'device',
            'peer_handle',
            'muted_until',
            'note',
            'is_active',
            'created_by_id',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'is_active', 'created_by_id', 'created_at', 'updated_at']
