from rest_framework import serializers

from task.models import Task
from .models import Schedule, ScheduleExecution


class TaskSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = Task
        fields = [
            'id', 'name', 'description', 'task_type', 'status', 'payload',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'team_id', 'team_name', 'created_at', 'updated_at']


class ScheduleExecutionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScheduleExecution
        fields = ['id', 'schedule', 'started_at', 'finished_at', 'result_status', 'error_message']
        read_only_fields = fields


class ScheduleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Schedule
        fields = [
            'id', 'task', 'profile', 'schedule_type',
            'run_at', 'interval_seconds', 'cron_expression',
            'max_retries', 'retry_delay_seconds',
            'is_active', 'status',
            'next_run_at', 'last_run_at', 'retry_count',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'status', 'last_run_at', 'retry_count', 'created_at', 'updated_at']

    def validate(self, attrs):
        schedule_type = attrs.get('schedule_type', getattr(self.instance, 'schedule_type', None))
        if schedule_type == 'once' and not attrs.get('run_at') and not getattr(self.instance, 'run_at', None):
            raise serializers.ValidationError({'run_at': 'run_at is required for once schedules.'})
        if schedule_type == 'interval' and not attrs.get('interval_seconds') and not getattr(self.instance, 'interval_seconds', None):
            raise serializers.ValidationError({'interval_seconds': 'interval_seconds is required for interval schedules.'})
        if schedule_type == 'cron':
            expr = attrs.get('cron_expression') or getattr(self.instance, 'cron_expression', '')
            if not expr:
                raise serializers.ValidationError({'cron_expression': 'cron_expression is required for cron schedules.'})
            try:
                from croniter import croniter
                croniter(expr)
            except Exception:
                raise serializers.ValidationError({'cron_expression': f'Invalid cron expression: {expr}'})
        return attrs

    def create(self, validated_data):
        from schedule.scheduler import _compute_next_run
        instance = super().create(validated_data)
        instance.next_run_at = _compute_next_run(instance)
        instance.save(update_fields=['next_run_at'])
        return instance


class ScheduleReadSerializer(ScheduleSerializer):
    task = TaskSerializer(read_only=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True, allow_null=True)

    class Meta(ScheduleSerializer.Meta):
        fields = ScheduleSerializer.Meta.fields + ['profile_name']
