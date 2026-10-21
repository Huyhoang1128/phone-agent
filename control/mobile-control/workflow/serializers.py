from rest_framework import serializers

from devices.models import Device
from mbcontrol.events.enums import EventSourceType, SystemEvent
from profiles.models import Profile
from schedule.models import ScheduleType
from task.models import TaskStatus, TaskType

from .models import StepActionType, Workflow, WorkflowRun, WorkflowStep, WorkflowTrigger

TASK_TYPE_VALUES = {choice for choice, _ in TaskType.choices}
TASK_STATUS_VALUES = {choice for choice, _ in TaskStatus.choices}
SCHEDULE_TYPE_VALUES = {choice for choice, _ in ScheduleType.choices}


class WorkflowStepSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowStep
        fields = [
            'id',
            'workflow',
            'name',
            'description',
            'sort_order',
            'action_type',
            'action_config',
            'input_bindings',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'workflow', 'created_at', 'updated_at']

    def validate_sort_order(self, value):
        if value < 1:
            raise serializers.ValidationError('sort_order must be greater than 0.')
        return value

    def validate_action_config(self, value):
        if value in (None, ''):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError('action_config must be an object.')
        return value

    def validate_input_bindings(self, value):
        if value in (None, ''):
            return []
        if not isinstance(value, list):
            raise serializers.ValidationError('input_bindings must be a list.')

        normalized = []
        errors = {}
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                errors[index] = 'Each binding must be an object.'
                continue

            source_type = item.get('source_type') or 'trigger'
            source_path = item.get('source_path')
            target_path = item.get('target_path')

            if source_type != 'trigger':
                errors[index] = 'source_type must be "trigger".'
                continue
            if not isinstance(source_path, str) or not source_path.strip():
                errors[index] = 'source_path is required.'
                continue
            if not isinstance(target_path, str) or not target_path.strip():
                errors[index] = 'target_path is required.'
                continue

            normalized.append(
                {
                    'source_type': source_type,
                    'source_path': source_path.strip(),
                    'target_path': target_path.strip(),
                }
            )

        if errors:
            raise serializers.ValidationError(errors)
        return normalized

    def validate(self, attrs):
        attrs = super().validate(attrs)
        action_type = attrs.get('action_type', getattr(self.instance, 'action_type', StepActionType.CUSTOM))
        action_config = attrs.get('action_config', getattr(self.instance, 'action_config', {}))
        input_bindings = attrs.get('input_bindings', getattr(self.instance, 'input_bindings', []))

        self._validate_action_config_for_type(action_type, action_config)
        self._validate_binding_targets(action_type, input_bindings)
        return attrs

    def _validate_action_config_for_type(self, action_type, action_config):
        if action_type == StepActionType.CUSTOM:
            return

        if action_type == StepActionType.CREATE_TASK:
            task_config = action_config.get('task')
            if task_config is not None:
                self._validate_task_config(task_config)
            return

        if action_type == StepActionType.CREATE_SCHEDULE:
            task_config = action_config.get('task')
            schedule_config = action_config.get('schedule')
            if task_config is not None:
                self._validate_task_config(task_config)
            if schedule_config is not None:
                self._validate_schedule_config(schedule_config)
            return

    def _validate_task_config(self, task_config):
        if not isinstance(task_config, dict):
            raise serializers.ValidationError(
                {'action_config': {'task': 'task config must be an object.'}}
            )

        task_type = task_config.get('task_type')
        if task_type not in (None, '') and task_type not in TASK_TYPE_VALUES:
            raise serializers.ValidationError(
                {'action_config': {'task': {'task_type': 'Invalid task_type.'}}}
            )

        status = task_config.get('status')
        if status not in (None, '') and status not in TASK_STATUS_VALUES:
            raise serializers.ValidationError(
                {'action_config': {'task': {'status': 'Invalid status.'}}}
            )

        payload = task_config.get('payload')
        if payload is not None and not isinstance(payload, dict):
            raise serializers.ValidationError(
                {'action_config': {'task': {'payload': 'payload must be an object.'}}}
            )

        device_id = task_config.get('device_id')
        if device_id is not None and not isinstance(device_id, int):
            raise serializers.ValidationError(
                {'action_config': {'task': {'device_id': 'device_id must be an integer or null.'}}}
            )

    def _validate_schedule_config(self, schedule_config):
        if not isinstance(schedule_config, dict):
            raise serializers.ValidationError(
                {'action_config': {'schedule': 'schedule config must be an object.'}}
            )

        schedule_type = schedule_config.get('schedule_type')
        if schedule_type not in (None, '') and schedule_type not in SCHEDULE_TYPE_VALUES:
            raise serializers.ValidationError(
                {'action_config': {'schedule': {'schedule_type': 'Invalid schedule_type.'}}}
            )

        for field_name in ['profile_id', 'interval_seconds', 'max_retries', 'retry_delay_seconds']:
            value = schedule_config.get(field_name)
            if value is not None and not isinstance(value, int):
                raise serializers.ValidationError(
                    {'action_config': {'schedule': {field_name: f'{field_name} must be an integer or null.'}}}
                )

    def _validate_binding_targets(self, action_type, input_bindings):
        if action_type == StepActionType.CUSTOM:
            return

        if action_type == StepActionType.CREATE_TASK:
            allowed_prefixes = ('task.',)
        else:
            allowed_prefixes = ('task.', 'schedule.')

        for index, binding in enumerate(input_bindings):
            target_path = binding['target_path']
            if any(target_path.startswith(prefix) for prefix in allowed_prefixes):
                continue
            raise serializers.ValidationError(
                {
                    'input_bindings': {
                        index: f'target_path must start with one of: {", ".join(allowed_prefixes)}'
                    }
                }
            )

    def create(self, validated_data):
        workflow = validated_data['workflow']
        if 'sort_order' not in getattr(self, 'initial_data', {}):
            last_step = workflow.steps.order_by('-sort_order').values_list('sort_order', flat=True).first()
            validated_data['sort_order'] = (last_step or 0) + 1
        return super().create(validated_data)


class WorkflowTriggerSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowTrigger
        fields = [
            'id', 'workflow', 'trigger_type', 'is_active',
            # periodic
            'periodic_schedule_type', 'run_at', 'interval_seconds', 'cron_expression',
            # event
            'event_name', 'event_source_type', 'event_source_id', 'event_filter',
            # webhook
            'webhook_token', 'webhook_secret',
            # state
            'next_run_at', 'last_triggered_at',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'workflow', 'webhook_token', 'next_run_at', 'last_triggered_at',
            'created_at', 'updated_at',
        ]
        extra_kwargs = {'webhook_secret': {'write_only': True}}

    def validate(self, attrs):
        trigger_type = attrs.get('trigger_type', getattr(self.instance, 'trigger_type', None))

        if trigger_type == 'periodic':
            schedule_type = attrs.get(
                'periodic_schedule_type',
                getattr(self.instance, 'periodic_schedule_type', ''),
            )
            if not schedule_type:
                raise serializers.ValidationError(
                    {'periodic_schedule_type': 'periodic_schedule_type is required for periodic triggers.'}
                )
            if schedule_type == 'once' and not attrs.get('run_at') and not getattr(self.instance, 'run_at', None):
                raise serializers.ValidationError({'run_at': 'run_at is required for once schedules.'})
            if schedule_type == 'interval' and not attrs.get('interval_seconds') and not getattr(self.instance, 'interval_seconds', None):
                raise serializers.ValidationError(
                    {'interval_seconds': 'interval_seconds is required for interval schedules.'}
                )
            if schedule_type == 'cron':
                expr = attrs.get('cron_expression') or getattr(self.instance, 'cron_expression', '')
                if not expr:
                    raise serializers.ValidationError(
                        {'cron_expression': 'cron_expression is required for cron schedules.'}
                    )
                try:
                    from croniter import croniter
                    croniter(expr)
                except Exception:
                    raise serializers.ValidationError(
                        {'cron_expression': f'Invalid cron expression: {expr}'}
                    )

        if trigger_type == 'event':
            event_name = attrs.get('event_name') or getattr(self.instance, 'event_name', '')
            event_source_type = attrs.get('event_source_type') or getattr(self.instance, 'event_source_type', '')
            event_source_id = attrs.get('event_source_id', getattr(self.instance, 'event_source_id', None))
            if not event_name:
                raise serializers.ValidationError(
                    {'event_name': 'event_name is required for event triggers.'}
                )
            if event_name not in {event.value for event in SystemEvent}:
                raise serializers.ValidationError(
                    {'event_name': 'event_name must be a registered SystemEvent value.'}
                )
            if not event_source_type:
                raise serializers.ValidationError(
                    {'event_source_type': 'event_source_type is required for event triggers.'}
                )
            if event_source_type not in {source.value for source in EventSourceType}:
                allowed = ', '.join(source.value for source in EventSourceType)
                raise serializers.ValidationError(
                    {'event_source_type': f'event_source_type must be one of {allowed}.'}
                )
            if event_source_id is None:
                raise serializers.ValidationError(
                    {'event_source_id': 'event_source_id is required for event triggers.'}
                )

        return attrs

    def create(self, validated_data):
        instance = super().create(validated_data)
        if instance.trigger_type == 'periodic':
            instance.next_run_at = _compute_next_run(instance)
            instance.save(update_fields=['next_run_at'])
        return instance


class WorkflowTriggerReadSerializer(WorkflowTriggerSerializer):
    """Same as WorkflowTriggerSerializer but exposes webhook_token (write-only excluded)."""

    class Meta(WorkflowTriggerSerializer.Meta):
        extra_kwargs = {}


class WorkflowSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    profile_id = serializers.IntegerField(source='profile.id', read_only=True, allow_null=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True, allow_null=True)
    device_id = serializers.IntegerField(source='device.id', read_only=True, allow_null=True)
    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    steps = WorkflowStepSerializer(many=True, read_only=True)
    triggers = WorkflowTriggerReadSerializer(many=True, read_only=True)
    # Writable FK fields
    profile = serializers.PrimaryKeyRelatedField(
        queryset=Profile.objects.all(),
        allow_null=True, required=False, write_only=True,
    )
    device = serializers.PrimaryKeyRelatedField(
        queryset=Device.objects.all(),
        allow_null=True, required=False, write_only=True,
    )

    class Meta:
        model = Workflow
        fields = [
            'id', 'name', 'description', 'status',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'profile_id', 'profile_name', 'profile',
            'device_id', 'device_name', 'device',
            'steps',
            'triggers',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'owner_id', 'team_id', 'team_name',
            'profile_id', 'profile_name', 'device_id', 'device_name',
            'created_at', 'updated_at',
        ]


class WorkflowRunSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowRun
        fields = [
            'id', 'workflow', 'trigger', 'run_number', 'status', 'triggered_by',
            'trigger_payload', 'started_at', 'finished_at', 'error_message',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'run_number', 'triggered_by', 'trigger_payload',
            'started_at', 'finished_at', 'created_at', 'updated_at',
        ]


def _compute_next_run(trigger):
    """Compute the next scheduled run time for a periodic trigger."""
    from django.utils import timezone as dj_tz

    now = dj_tz.now()
    schedule_type = trigger.periodic_schedule_type

    if schedule_type == 'once':
        return trigger.run_at if trigger.run_at and trigger.run_at > now else None
    if schedule_type == 'interval' and trigger.interval_seconds:
        import datetime
        return now + datetime.timedelta(seconds=trigger.interval_seconds)
    if schedule_type == 'cron' and trigger.cron_expression:
        try:
            import datetime
            from croniter import croniter
            next_ts = croniter(trigger.cron_expression, now).get_next(float)
            return datetime.datetime.fromtimestamp(next_ts, tz=datetime.timezone.utc)
        except Exception:
            return None
    return None
