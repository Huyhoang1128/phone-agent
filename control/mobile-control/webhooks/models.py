from django.contrib.auth.models import User
from django.db import models


class Webhook(models.Model):
    name = models.CharField(max_length=255)
    url = models.URLField(max_length=2048)
    secret = models.CharField(max_length=255, blank=True, default='')
    events = models.JSONField(default=list)
    is_active = models.BooleanField(default=True)
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='webhooks')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} → {self.url}"


class ExternalWebhook(models.Model):
    """
    Outbound webhook configuration used when this system calls external services.

    `webhook_name` should match a Django settings key used as fallback
    (for example: N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL).
    """

    webhook_name = models.CharField(max_length=255, unique=True)
    webhook_url = models.URLField(max_length=2048)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['webhook_name']

    def __str__(self):
        return f"{self.webhook_name} → {self.webhook_url}"
