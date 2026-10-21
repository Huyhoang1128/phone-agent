from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission


class TaskType(models.TextChoices):
    GENERIC = 'generic', 'Generic'


class TaskKind(models.TextChoices):
    APP = 'app', 'App Task'
    SYSTEM = 'system', 'System Task'


class TaskStatus(models.TextChoices):
    PENDING_APPROVAL = 'pending_approval', 'Pending Approval'
    PENDING = 'pending', 'Pending'
    QUEUED = 'queued', 'Queued'  # waiting for its device to finish another task
    RUNNING = 'running', 'Running'
    COMPLETED = 'completed', 'Completed'
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'


class Task(models.Model):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    task_kind = models.CharField(
        max_length=20,
        choices=TaskKind.choices,
        default=TaskKind.APP,
    )
    task_type = models.CharField(
        max_length=50,
        choices=TaskType.choices,
        default=TaskType.GENERIC,
    )
    status = models.CharField(
        max_length=20,
        choices=TaskStatus.choices,
        default=TaskStatus.PENDING,
    )
    payload = models.JSONField(default=dict, blank=True)
    result = models.JSONField(default=list, blank=True)
    device = models.ForeignKey(
        'devices.Device', null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks'
    )
    device_serial = models.CharField(max_length=255, blank=True, default='')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['owner', '-created_at']),
            models.Index(fields=['team', '-created_at']),
        ]

    def __str__(self):
        return f"{self.name} [{self.status}]"


class TaskStepStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    RUNNING = 'running', 'Running'
    COMPLETED = 'completed', 'Completed'
    FAILED = 'failed', 'Failed'
    SKIPPED = 'skipped', 'Skipped'


class TaskStep(models.Model):
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name='steps')
    handler = models.CharField(max_length=100)
    params = models.JSONField(default=dict, blank=True)
    order = models.PositiveIntegerField(default=0)
    status = models.CharField(
        max_length=20,
        choices=TaskStepStatus.choices,
        default=TaskStepStatus.PENDING,
    )
    result = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default='')
    executed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['order', 'id']

    def __str__(self):
        return f"TaskStep(task={self.task_id}, handler={self.handler}, order={self.order}, status={self.status})"
