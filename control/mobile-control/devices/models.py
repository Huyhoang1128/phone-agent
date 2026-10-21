from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission  # noqa: F401 – re-exported for migrations


class DeviceType(models.TextChoices):
    PERSONAL = 'personal', 'Personal Phone'
    EMULATOR = 'emulator', 'Temporary Emulator'
    AGENT = 'agent', 'Agent Phone'
    MOBILERUN = 'mobilerun', 'Mobilerun Phone'


class DeviceStatus(models.TextChoices):
    ONLINE = 'online', 'Online'
    OFFLINE = 'offline', 'Offline'
    CONNECTED = 'connected', 'Connected'


class Device(models.Model):
    name = models.CharField(max_length=255)
    device_type = models.CharField(max_length=20, choices=DeviceType.choices, default=DeviceType.PERSONAL)
    status = models.CharField(max_length=20, choices=DeviceStatus.choices, default=DeviceStatus.OFFLINE)
    identifier = models.CharField(max_length=255, blank=True, default='')
    device_serial_id = models.CharField(max_length=255, blank=True, default='')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='devices')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='devices')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    screen_width = models.PositiveIntegerField(null=True, blank=True)
    screen_height = models.PositiveIntegerField(null=True, blank=True)
    hardware_info = models.JSONField(default=dict, blank=True)
    worker_id = models.CharField(max_length=255, null=True, blank=True)
    # TCS-v2 Sprint 2 (#2): soft-delete flag thay vì CASCADE DELETE (chống mất
    # history TiktokMessage/Task/Notification của customer khi user xóa device).
    # Xem docs/Chatbot_Tiktok/tcs_v2_sprint_2_soft_delete_device.md.
    is_active = models.BooleanField(
        default=True,
        db_index=True,
        help_text='Soft-delete flag. False = đã xóa (filtered khỏi list UI mặc định).',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            # Identifiers are unique when non-empty; blank identifiers are allowed
            # on multiple rows (devices not yet assigned a hardware identifier).
            models.UniqueConstraint(
                fields=['identifier'],
                condition=models.Q(identifier__gt=''),
                name='devices_device_identifier_nonempty_unique',
            ),
        ]

    def __str__(self):
        return f"{self.name} [{self.device_type}]"

    def soft_delete(self):
        """Mark device as inactive (soft-delete). Use thay vì .delete() trong
        view flows để giữ history TiktokMessage/Task/Notification toàn vẹn.
        """
        if self.is_active:
            self.is_active = False
            self.save(update_fields=['is_active', 'updated_at'])

    def restore(self):
        """Restore a soft-deleted device. Called bởi view action `restore` hoặc
        auto-restore trong `create` upsert path.
        """
        if not self.is_active:
            self.is_active = True
            self.save(update_fields=['is_active', 'updated_at'])


class DeviceUsageSession(models.Model):
    """Tracks which user is actively using a device at a given time."""

    device = models.ForeignKey(Device, on_delete=models.CASCADE, related_name='usage_sessions')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='device_sessions')
    claimed_at = models.DateTimeField(auto_now_add=True)
    released_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-claimed_at']

    def __str__(self):
        status = 'active' if self.released_at is None else 'released'
        return f"{self.user.username} on {self.device.name} [{status}]"

    @property
    def is_active(self):
        return self.released_at is None


class DeviceNotification(models.Model):
    """Stores notifications forwarded from devices via the events/device WebSocket event."""

    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL, related_name='notifications'
    )
    # Copy of Device.identifier for fast lookup even if the FK is null.
    identifier = models.CharField(max_length=255, db_index=True)

    # Flattened payload fields
    package = models.CharField(max_length=255, blank=True, default='')
    title = models.CharField(max_length=512, blank=True, default='')
    text = models.TextField(blank=True, default='')
    notification_id = models.BigIntegerField(null=True, blank=True)
    tag = models.CharField(max_length=255, blank=True, default='')
    is_ongoing = models.BooleanField(default=False)
    post_time = models.BigIntegerField(null=True, blank=True)
    key = models.CharField(max_length=512, blank=True, default='')

    # Timestamp from the event params (unix epoch seconds or ms, as sent by device)
    event_timestamp = models.BigIntegerField(null=True, blank=True)

    # Full raw event for auditing / back-reference
    raw_data = models.JSONField(default=dict)

    received_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-received_at']
        constraints = [
            # Deduplicate notifications that carry a non-empty `key` field.
            # An Android notification key is unique per device (identifier) and
            # encodes package/id/tag, so (identifier, key) is a safe dedup key.
            models.UniqueConstraint(
                fields=['identifier', 'key'],
                condition=models.Q(key__gt=''),
                name='devices_devicenotification_identifier_key_nonempty_unique',
            ),
        ]

    def __str__(self):
        return f"[{self.identifier}] {self.package}: {self.title}"
