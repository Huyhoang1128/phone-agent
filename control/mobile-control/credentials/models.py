from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission


class Credential(models.Model):
    app_name = models.CharField(max_length=255)
    username = models.CharField(max_length=255)
    password = models.CharField(max_length=255)
    notes = models.TextField(blank=True, default='')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='credentials')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='credentials')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.app_name} / {self.username}"
