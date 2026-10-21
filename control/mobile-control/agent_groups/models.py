from django.contrib.auth.models import User
from django.db import models
from mbcontrol.constants import TeamPermission  # noqa: F401 – re-exported for migrations


class AgentGroupRole(models.TextChoices):
    LEADER = 'leader', 'Leader'
    WORKER = 'worker', 'Worker'
    OBSERVER = 'observer', 'Observer'


class AgentGroupPlanStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    APPROVED = 'approved', 'Approved'
    REJECTED = 'rejected', 'Rejected'


class AgentGroup(models.Model):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    system_prompt = models.TextField(blank=True, default='')
    goal = models.TextField(blank=True, default='')
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='agent_groups')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='agent_groups')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class AgentGroupMember(models.Model):
    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE, related_name='members')
    device = models.ForeignKey('devices.Device', on_delete=models.CASCADE, related_name='group_memberships')
    role = models.CharField(max_length=20, choices=AgentGroupRole.choices, default=AgentGroupRole.WORKER)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('group', 'device')]
        ordering = ['added_at']

    def __str__(self):
        return f"{self.device.name} in {self.group.name} [{self.role}]"


class AgentGroupSharedMemory(models.Model):
    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE, related_name='shared_memories')
    key = models.CharField(max_length=255)
    value = models.TextField(blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('group', 'key')]
        ordering = ['key']

    def __str__(self):
        return f"{self.group.name}/{self.key}"


class AgentGroupSharedFile(models.Model):
    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE, related_name='shared_files')
    name = models.CharField(max_length=255)
    file = models.FileField(upload_to='agent_group_files/')
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-uploaded_at']

    def __str__(self):
        return f"{self.group.name}/{self.name}"


class AgentGroupSharedState(models.Model):
    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE, related_name='shared_states')
    key = models.CharField(max_length=255)
    value = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('group', 'key')]
        ordering = ['key']

    def __str__(self):
        return f"{self.group.name}/{self.key}"


class AgentGroupPlan(models.Model):
    """Stores AI-generated task plans awaiting human approval."""

    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE, related_name='plans')
    goal = models.TextField()
    plan = models.JSONField(default=list)
    status = models.CharField(
        max_length=20,
        choices=AgentGroupPlanStatus.choices,
        default=AgentGroupPlanStatus.PENDING,
    )
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='agent_group_plans')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Plan for {self.group.name} [{self.status}]"
