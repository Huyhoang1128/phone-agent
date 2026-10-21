from django.contrib.auth.models import User
from django.db import models


class Team(models.Model):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    created_by = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name='created_teams'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class TeamRole(models.TextChoices):
    OWNER = 'owner', 'Owner'
    ADMIN = 'admin', 'Admin'
    MEMBER = 'member', 'Member'


class TeamMembership(models.Model):
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='team_memberships')
    role = models.CharField(max_length=20, choices=TeamRole.choices, default=TeamRole.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('team', 'user')]
        ordering = ['joined_at']

    def __str__(self):
        return f"{self.user.username} in {self.team.name} [{self.role}]"
