import secrets

from django.contrib.auth.models import User
from django.db import models

from mbcontrol.events.enums import EventSourceType, SystemEvent
from mbcontrol.constants import TeamPermission
from devices.models import Device


class WorkflowStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    INACTIVE = 'inactive', 'Inactive'


class TriggerType(models.TextChoices):
    PERIODIC = 'periodic', 'Periodic'
    EVENT = 'event', 'Event'
    WEBHOOK = 'webhook', 'Webhook'


class PeriodicScheduleType(models.TextChoices):
    ONCE = 'once', 'Once'
    INTERVAL = 'interval', 'Interval'
    CRON = 'cron', 'Cron'


class StepActionType(models.TextChoices):
    CREATE_TASK = 'create_task', 'Create Task'
    CREATE_SCHEDULE = 'create_schedule', 'Create Schedule'
    CUSTOM = 'custom', 'Custom'


class RunStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    RUNNING = 'running', 'Running'
    # Phase 2.1 (Chatbot TikTok): runner đã publish Kafka task_execution và đang
    # đợi `task_status` reply qua kafka-task-status-listener → workflow:resume.
    WAITING_TASK = 'waiting_task', 'Waiting Task'
    # Phase 2.1: runner đang chờ HTTP response từ n8n (sync call timeout 120s).
    WAITING_N8N = 'waiting_n8n', 'Waiting n8n'
    COMPLETED = 'completed', 'Completed'
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'
    # Phase 2.1: vượt max retry → đẩy sang workflow:runs:dlq để alert.
    DLQ = 'dlq', 'Dead Letter Queue'


class TriggeredBy(models.TextChoices):
    MANUAL = 'manual', 'Manual'
    PERIODIC = 'periodic', 'Periodic'
    EVENT = 'event', 'Event'
    WEBHOOK = 'webhook', 'Webhook'


def _generate_webhook_token():
    return secrets.token_urlsafe(32)


class Workflow(models.Model):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    status = models.CharField(
        max_length=20,
        choices=WorkflowStatus.choices,
        default=WorkflowStatus.ACTIVE,
    )
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='workflows'
    )
    team = models.ForeignKey(
        'teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='workflows'
    )
    team_permission = models.CharField(
        max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW
    )
    profile = models.ForeignKey(
        'profiles.Profile', null=True, blank=True, on_delete=models.SET_NULL, related_name='workflows'
    )
    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL, related_name='workflows'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} [{self.status}]"


class WorkflowStep(models.Model):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name='steps')
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    sort_order = models.PositiveIntegerField(default=1)
    action_type = models.CharField(
        max_length=50,
        choices=StepActionType.choices,
        default=StepActionType.CUSTOM,
    )
    action_config = models.JSONField(default=dict, blank=True)
    input_bindings = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['sort_order', 'created_at', 'id']

    def __str__(self):
        return f"Step({self.name}) for Workflow({self.workflow_id})"


class WorkflowTrigger(models.Model):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name='triggers')
    trigger_type = models.CharField(max_length=20, choices=TriggerType.choices)
    is_active = models.BooleanField(default=True)

    # ── Periodic fields ──────────────────────────────────────────────────────
    periodic_schedule_type = models.CharField(
        max_length=20,
        choices=PeriodicScheduleType.choices,
        blank=True,
        default='',
    )
    # Once
    run_at = models.DateTimeField(null=True, blank=True)
    # Interval
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    # Cron
    cron_expression = models.CharField(max_length=100, blank=True, default='')

    # ── Event fields ─────────────────────────────────────────────────────────
    # Name of the internal event that fires this trigger (e.g. "device.connected").
    event_name = models.CharField(
        max_length=255,
        choices=SystemEvent.choices(),
        blank=True,
        default='',
    )
    event_source_type = models.CharField(
        max_length=20,
        choices=EventSourceType.choices(),
        blank=True,
        default='',
    )
    event_source_id = models.PositiveIntegerField(null=True, blank=True)
    # Optional JSON filter that must match the event payload.
    event_filter = models.JSONField(default=dict, blank=True)

    # ── Webhook fields ───────────────────────────────────────────────────────
    # Unique token embedded in the public webhook URL.
    webhook_token = models.CharField(
        max_length=64, unique=True, blank=True, default=_generate_webhook_token
    )
    # Optional secret used to verify the X-Webhook-Secret header from callers.
    webhook_secret = models.CharField(max_length=255, blank=True, default='')

    # ── Runtime state ────────────────────────────────────────────────────────
    next_run_at = models.DateTimeField(null=True, blank=True)
    last_triggered_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Trigger({self.trigger_type}) for Workflow({self.workflow_id})"


class WorkflowRun(models.Model):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name='runs')
    trigger = models.ForeignKey(
        WorkflowTrigger, null=True, blank=True, on_delete=models.SET_NULL, related_name='runs'
    )
    run_number = models.PositiveIntegerField(default=1)
    status = models.CharField(
        max_length=20,
        choices=RunStatus.choices,
        default=RunStatus.PENDING,
    )
    triggered_by = models.CharField(
        max_length=20,
        choices=TriggeredBy.choices,
        default=TriggeredBy.MANUAL,
    )
    # Payload that caused this run (e.g. webhook body, event data).
    trigger_payload = models.JSONField(default=dict, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True, default='')

    # ── Phase 2.1 (Chatbot TikTok) — Redis Streams workflow runner state ──────
    # Vị trí step hiện tại đang chạy (resume sau khi WAITING_TASK/WAITING_N8N
    # được đánh thức qua workflow:resume stream).
    current_step_index = models.PositiveIntegerField(default=0)
    # UUID của Kafka task message đang đợi response. Khi listener nhận task_status
    # với cùng command_id → match WorkflowRun này → resume.
    pending_command_id = models.UUIDField(null=True, blank=True, db_index=True)
    # Output của các step trước (e.g. step1_output={"reply_text": "..."}). Step
    # sau có thể reference qua template `{{ context.step1.reply_text }}`.
    context = models.JSONField(default=dict, blank=True)
    # Khi nào retry tiếp (do stream layer XAUTOCLAIM hoặc do manual retry).
    next_retry_at = models.DateTimeField(null=True, blank=True, db_index=True)
    retry_count = models.PositiveIntegerField(default=0)
    last_error = models.TextField(blank=True, default='')

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        unique_together = [('workflow', 'run_number')]

    def save(self, *args, **kwargs):
        if not self.pk and self.run_number == 1:
            last = (
                WorkflowRun.objects.filter(workflow=self.workflow)
                .order_by('-run_number')
                .values_list('run_number', flat=True)
                .first()
            )
            self.run_number = (last or 0) + 1
        super().save(*args, **kwargs)

    def __str__(self):
        return f"WorkflowRun #{self.run_number} for Workflow({self.workflow_id}) [{self.status}]"
