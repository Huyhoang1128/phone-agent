"""Chatbot domain models (Phase 2.6 refactor — moved từ `tiktok/models.py`).

Composite conversation key: `(device, peer_handle)`. Copy pattern từ ChatbotMessage
của project chatbot prod (FB/Zalo). Xem docs/Chatbot_Tiktok/design.md mục 5.

Tên symbol giữ nguyên (`TiktokMessage`, `TiktokPeerMute`) — đây là
**domain object** (TikTok message), KHÔNG đặt tên theo app location.
"""
from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class TiktokMessageType(models.TextChoices):
    USER = 'user', 'User (peer → bot)'
    BOT = 'bot', 'Bot (bot → peer)'
    SYSTEM = 'system', 'System / Algorithm marker'


class TiktokMessageSource(models.TextChoices):
    """Nguồn gốc tin (KHÁC `delivery_status` — đó là kết quả gửi thực tế).

    `AGENT_SENT` = tin do agent SINH RA ĐỂ GỬI (intent), KHÔNG nói lên đã gửi
    thành công hay chưa. Tra `delivery_status` để biết kết quả thực tế.
    """
    NOTIFICATION = 'notification', 'Từ notification preview (may truncated)'
    AGENT_OBSERVED = 'agent_observed', 'Mobile agent đọc trực tiếp từ inbox'
    AGENT_SENT = 'agent_sent', 'Tin do agent sinh ra để gửi (xem delivery_status)'


class TiktokMessageChannel(models.TextChoices):
    DM = 'tiktok_dm', 'TikTok DM'
    COMMENT = 'tiktok_comment', 'TikTok Comment'


class TiktokMessageDeliveryStatus(models.TextChoices):
    """Trạng thái gửi tin (chỉ áp dụng cho `message_type=BOT`).

    Hybrid pattern (TCS-v1 OQ-1 C): insert `pending` ngay khi Step 1 nhận
    `reply_text` từ n8n, UPDATE thành `sent`/`failed`/`unknown` khi worker
    confirm qua Kafka `task_status`.

    USER msg KHÔNG dùng field này (giữ NULL) — vì user gửi tin tới = đã thấy.
    """
    PENDING = 'pending', 'Đang chờ worker confirm'
    SENT = 'sent', 'Đã gửi (worker confirm SENT_CONFIRMED hoặc SKIPPED_ALREADY_SENT)'
    FAILED = 'failed', 'Worker báo thất bại (logout / hết pin / app crash)'
    UNKNOWN = 'unknown', 'Worker không trả marker rõ ràng (parser không tìm được)'


class TiktokMessage(models.Model):
    """Tin nhắn DM hoặc reply comment trong cuộc trò chuyện TikTok.

    Conversation = composite key (device, peer_handle) — không có bảng
    Conversation riêng (theo pattern ChatbotMessage prod). Filter conversation
    bằng `TiktokMessage.objects.filter(device=X, peer_handle=Y)`.
    """

    device = models.ForeignKey(
        'devices.Device', on_delete=models.CASCADE, related_name='tiktok_messages'
    )
    peer_handle = models.CharField(max_length=255)
    channel = models.CharField(max_length=20, choices=TiktokMessageChannel.choices)

    content = models.TextField()
    message_type = models.CharField(max_length=10, choices=TiktokMessageType.choices)
    source = models.CharField(max_length=20, choices=TiktokMessageSource.choices)
    is_preview = models.BooleanField(
        default=False, help_text='True khi text bị truncated từ notification'
    )

    source_notification = models.ForeignKey(
        'devices.DeviceNotification',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='tiktok_messages',
        help_text='Khi source=notification',
    )
    source_task = models.ForeignKey(
        'task.Task',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='tiktok_messages',
        help_text='Khi source=agent_sent hoặc agent_observed',
    )
    video_id = models.CharField(
        max_length=255, null=True, blank=True, help_text='Khi channel=tiktok_comment'
    )

    delivery_status = models.CharField(
        max_length=10,
        choices=TiktokMessageDeliveryStatus.choices,
        null=True, blank=True,
        help_text='Chỉ set cho BOT msg (hybrid pattern). USER msg để NULL.',
    )
    error_reason = models.TextField(
        blank=True, default='',
        help_text='Excerpt error content khi delivery_status=failed/unknown',
    )

    # TCS-v2 Sprint 4 (#1): hash 32 chars đầu SHA256 của
    # (device_id + peer + reply_text + workflow_run_id + step_index). Chống dup
    # khi worker timeout/crash + backend retry tạo task mới (id khác). Cùng
    # (run, step, device, peer, reply) → cùng key → DB constraint chặn INSERT
    # thứ 2 → KHÔNG gửi tin trùng cho khách.
    # USER msg + rows cũ giữ NULL (conditional unique constraint không apply).
    # Xem docs/Chatbot_Tiktok/tcs_v2_sprint_4_idempotency_key.md.
    idempotency_key = models.CharField(
        max_length=64,
        null=True, blank=True,
        db_index=True,
        help_text='SHA256 hash 32 chars đầu của (device_id + peer + reply + run + step).',
    )

    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True, help_text='Soft delete flag')

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['device', 'peer_handle', 'created_at'], name='tiktokmsg_conv_idx'),
            models.Index(fields=['device', 'channel', 'created_at'], name='tiktokmsg_channel_idx'),
            models.Index(fields=['source_notification'], name='tiktokmsg_notif_idx'),
            models.Index(fields=['source_task', 'delivery_status'], name='tiktokmsg_task_dlv_idx'),
        ]
        constraints = [
            # TCS-v2 Sprint 4 (#1): thay constraint cũ (device, peer, source_task)
            # bằng idempotency_key — robust hơn vì 2 task retry có cùng key.
            models.UniqueConstraint(
                fields=['idempotency_key'],
                condition=models.Q(idempotency_key__isnull=False),
                name='tiktokmsg_unique_idempotency_key',
            ),
        ]
        verbose_name = 'TikTok Message'
        verbose_name_plural = 'TikTok Messages'

    def __str__(self):
        prefix = '←' if self.message_type == TiktokMessageType.USER else '→'
        return f"{prefix} {self.peer_handle}: {self.content[:40]}"


class TiktokPeerMute(models.Model):
    """User chủ động pause AI auto-reply cho 1 peer cụ thể.

    KHÔNG nhằm detect human takeover (project không có cơ chế đó — Worker
    kiểm soát TikTok account qua ADB, không qua official API). Chỉ là cờ
    user-controlled để dừng bot reply cho 1 conversation.
    """

    device = models.ForeignKey(
        'devices.Device', on_delete=models.CASCADE, related_name='tiktok_peer_mutes'
    )
    peer_handle = models.CharField(max_length=255)
    muted_until = models.DateTimeField(
        null=True, blank=True, help_text='null = mute vô thời hạn'
    )
    note = models.TextField(
        blank=True, default='', help_text='Lý do mute (vd "khách đã gọi điện rồi")'
    )
    created_by = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_peer_mutes_created',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('device', 'peer_handle')]
        verbose_name = 'TikTok Peer Mute'
        verbose_name_plural = 'TikTok Peer Mutes'

    def __str__(self):
        suffix = f' until {self.muted_until}' if self.muted_until else ' (no expiry)'
        return f"Mute {self.device_id}/{self.peer_handle}{suffix}"

    @property
    def is_active(self) -> bool:
        """Mute còn hiệu lực hay đã hết hạn."""
        if self.muted_until is None:
            return True
        return self.muted_until >= timezone.now()
