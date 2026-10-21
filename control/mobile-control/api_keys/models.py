import secrets
import hashlib

from django.contrib.auth.models import User
from django.db import models


def generate_api_key():
    return 'sk-' + secrets.token_urlsafe(32)


def hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


class ApiKey(models.Model):
    name = models.CharField(max_length=255)
    key_hash = models.CharField(max_length=64, unique=True)
    key_prefix = models.CharField(max_length=16)
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='api_keys')
    is_active = models.BooleanField(default=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} ({self.key_prefix}…)"

    @classmethod
    def create_key(cls, name: str, owner) -> tuple['ApiKey', str]:
        """Create a new ApiKey and return (instance, raw_key). raw_key is shown once."""
        raw_key = generate_api_key()
        instance = cls(
            name=name,
            key_hash=hash_key(raw_key),
            key_prefix=raw_key[:12],
            owner=owner,
        )
        instance.save()
        return instance, raw_key

    @classmethod
    def verify(cls, raw_key: str):
        """Return the matching active ApiKey or None."""
        try:
            return cls.objects.get(key_hash=hash_key(raw_key), is_active=True)
        except cls.DoesNotExist:
            return None
