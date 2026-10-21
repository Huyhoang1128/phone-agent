from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission


class Proxy(models.Model):
    PROTOCOL_CHOICES = [
        ('socks5', 'SOCKS5'),
        ('http', 'HTTP'),
    ]
    STATUS_ACTIVE = 'active'
    STATUS_INACTIVE = 'inactive'
    STATUS_CHOICES = [
        (STATUS_ACTIVE, 'Active'),
        (STATUS_INACTIVE, 'Inactive'),
    ]

    name = models.CharField(max_length=255)
    protocol = models.CharField(max_length=20, choices=PROTOCOL_CHOICES, default='socks5')
    host = models.CharField(max_length=255)
    port = models.PositiveIntegerField(null=True, blank=True)
    username = models.CharField(max_length=255, blank=True, default='')
    password = models.CharField(max_length=255, blank=True, default='')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='proxies')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='proxies')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} ({self.protocol}://{self.host})"
