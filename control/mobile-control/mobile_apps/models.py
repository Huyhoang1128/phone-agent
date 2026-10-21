from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.db import models
from mbcontrol.constants import TeamPermission

ALLOWED_APK_EXTENSIONS = {'.apk', '.xapk', '.apkm', '.zip'}
MAX_APK_SIZE_BYTES = 500 * 1024 * 1024  # 500 MB


def validate_apk_file(value):
    import os
    ext = os.path.splitext(value.name)[1].lower()
    if ext not in ALLOWED_APK_EXTENSIONS:
        raise ValidationError(
            f'Unsupported file extension "{ext}". Allowed: {", ".join(sorted(ALLOWED_APK_EXTENSIONS))}'
        )
    if value.size > MAX_APK_SIZE_BYTES:
        raise ValidationError(
            f'File size {value.size} bytes exceeds the maximum allowed size of {MAX_APK_SIZE_BYTES} bytes.'
        )


class AppPlatform(models.TextChoices):
    ANDROID = 'android', 'Android'
    IOS = 'ios', 'iOS'


class MobileApp(models.Model):
    name = models.CharField(max_length=255)
    package_name = models.CharField(max_length=255, blank=True, default='')
    platform = models.CharField(
        max_length=10,
        choices=AppPlatform.choices,
        default=AppPlatform.ANDROID,
    )
    apk_file = models.FileField(
        upload_to='apks/', null=True, blank=True, validators=[validate_apk_file]
    )
    apk_url = models.TextField(blank=True, default='')
    version = models.CharField(max_length=50, blank=True, default='')
    description = models.TextField(blank=True, default='')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='mobile_apps')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='mobile_apps')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} ({self.package_name or 'no package'})"
