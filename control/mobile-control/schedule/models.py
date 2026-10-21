from django.db import models

from task.models import Task


class ScheduleType(models.TextChoices):
    ONCE = 'once', 'Once'
    INTERVAL = 'interval', 'Interval'
    CRON = 'cron', 'Cron'


class ScheduleStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    PAUSED = 'paused', 'Paused'
    COMPLETED = 'completed', 'Completed'
    FAILED = 'failed', 'Failed'


class ExecutionStatus(models.TextChoices):
    SUCCESS = 'success', 'Success'
    FAILURE = 'failure', 'Failure'
    RETRY = 'retry', 'Retry'


class Schedule(models.Model):
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name='schedules')
    profile = models.ForeignKey(
        'profiles.Profile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='schedules',
    )
    schedule_type = models.CharField(max_length=20, choices=ScheduleType.choices)

    # Once
    run_at = models.DateTimeField(null=True, blank=True)

    # Interval
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)

    # Cron
    cron_expression = models.CharField(max_length=100, blank=True, default='')

    # Retry
    max_retries = models.PositiveIntegerField(default=0)
    retry_delay_seconds = models.PositiveIntegerField(default=60)

    # State
    is_active = models.BooleanField(default=True)
    status = models.CharField(
        max_length=20,
        choices=ScheduleStatus.choices,
        default=ScheduleStatus.ACTIVE,
    )
    next_run_at = models.DateTimeField(null=True, blank=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    retry_count = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Schedule({self.schedule_type}) for Task({self.task_id}) [{self.status}]"


class ScheduleExecution(models.Model):
    schedule = models.ForeignKey(Schedule, on_delete=models.CASCADE, related_name='executions')
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    result_status = models.CharField(
        max_length=20,
        choices=ExecutionStatus.choices,
        default=ExecutionStatus.SUCCESS,
    )
    error_message = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-started_at']

    def __str__(self):
        return f"Execution({self.id}) for Schedule({self.schedule_id}) [{self.result_status}]"
