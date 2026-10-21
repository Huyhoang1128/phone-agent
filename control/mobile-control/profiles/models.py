import uuid

from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission
from mobile_apps.models import MobileApp
from credentials.models import Credential
from devices.models import Device


def profile_file_upload_to(instance, filename):
    return f'profile_files/{instance.profile.id}/{filename}'


class Profile(models.Model):
    name = models.CharField(max_length=255)
    goal = models.TextField(blank=True, default='')
    topic = models.CharField(max_length=512, blank=True, default='')
    topics = models.JSONField(default=list, blank=True)
    topic_history = models.JSONField(default=list, blank=True)
    topic_audit_logs = models.JSONField(default=list, blank=True)
    personality = models.TextField(blank=True, default='')
    website_url = models.URLField(blank=True, default='')
    # Proxy settings
    proxy_host = models.CharField(max_length=255, blank=True, default='')
    proxy_port = models.PositiveIntegerField(null=True, blank=True)
    proxy_username = models.CharField(max_length=255, blank=True, default='')
    proxy_password = models.CharField(max_length=255, blank=True, default='')
    # Related objects
    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL, related_name='profiles'
    )
    apps = models.ManyToManyField(MobileApp, blank=True, related_name='profiles')
    credentials = models.ManyToManyField(Credential, blank=True, related_name='profiles')
    # Ownership
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='profiles')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='profiles')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class ProfileFile(models.Model):
    profile = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name='files')
    name = models.CharField(max_length=255, blank=True, default='')
    file = models.FileField(upload_to=profile_file_upload_to)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.profile.name} / {self.name or self.file.name}"


class ProfileMemory(models.Model):
    profile = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name='memories')
    key = models.CharField(max_length=255)
    value = models.TextField(blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('profile', 'key')]
        ordering = ['key']

    def __str__(self):
        return f"{self.profile.name}/{self.key}"


class ProfileContentItem(models.Model):
    profile = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name='content_items')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='profile_content_items')
    title = models.CharField(max_length=255, blank=True, default='')
    source_url = models.URLField(max_length=2048, blank=True, default='')
    video_url = models.URLField(max_length=2048, blank=True, default='')
    description = models.TextField(blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at', '-id']

    def __str__(self):
        return f"{self.profile.name} / {self.title or self.video_url or self.source_url or self.id}"


class InstallStatus(models.TextChoices):
    """Lifecycle states of a single app on a profile's device.

    Install branch:    PENDING -> INSTALLING -> INSTALLED
    Uninstall branch:  UNINSTALL_PENDING -> UNINSTALLING -> UNINSTALLED
    FAILED is shared by both branches; ``error_message`` records what failed.
    """
    PENDING = 'pending', 'Pending install'
    INSTALLING = 'installing', 'Installing'
    INSTALLED = 'installed', 'Installed'
    UNINSTALL_PENDING = 'uninstall_pending', 'Pending uninstall'
    UNINSTALLING = 'uninstalling', 'Uninstalling'
    UNINSTALLED = 'uninstalled', 'Uninstalled'
    FAILED = 'failed', 'Failed'


class ProfileAppInstallation(models.Model):
    """Per-device install/uninstall state of one MobileApp for one Profile.

    Design note: this is intentionally SEPARATE from the ``Profile.apps`` M2M.
    ``Profile.apps`` is the *desired set* (what the user picked); this model is
    the *execution state* of that intent on the bound device — it survives an
    app being de-selected (kept as ``uninstalling``/``uninstalled``) so the UI
    can show progress. One row per (profile, app); the row is reused and its
    status flipped when an app is re-selected after removal.
    """

    # Statuses meaning "the app should be / is present on the device".
    ACTIVE_STATUSES = (
        InstallStatus.PENDING,
        InstallStatus.INSTALLING,
        InstallStatus.INSTALLED,
    )
    # Statuses meaning "the app should be / is being removed".
    REMOVAL_STATUSES = (
        InstallStatus.UNINSTALL_PENDING,
        InstallStatus.UNINSTALLING,
        InstallStatus.UNINSTALLED,
    )

    profile = models.ForeignKey(
        Profile, on_delete=models.CASCADE, related_name='app_installations'
    )
    app = models.ForeignKey(
        MobileApp, on_delete=models.CASCADE, related_name='installations'
    )
    # Snapshot of the device targeted when the request was made. Kept even if
    # the profile is later re-bound to a different device, so it stays clear
    # which device the install/uninstall command was aimed at.
    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='app_installations',
    )
    status = models.CharField(
        max_length=20, choices=InstallStatus.choices, default=InstallStatus.PENDING
    )
    # Idempotency key for the (future) Kafka dispatch step. Kafka is
    # at-least-once, so the worker must be able to skip a duplicated command —
    # this id is regenerated whenever a fresh install/uninstall is requested.
    command_id = models.UUIDField(default=uuid.uuid4, editable=False)
    error_message = models.TextField(blank=True, default='')
    requested_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='app_installation_requests',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        # One install record per (profile, app); rows are reused, not duplicated.
        unique_together = [('profile', 'app')]

    def __str__(self):
        return f"{self.profile.name} / {self.app.name} [{self.status}]"


class ProfileRoutine(models.Model):
    profile = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name='routines')
    schedule_time = models.TimeField()
    action = models.TextField()
    cron_expression = models.CharField(max_length=120)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['schedule_time', 'id']

    def __str__(self):
        return f"{self.profile.name} {self.schedule_time} - {self.action[:40]}"
