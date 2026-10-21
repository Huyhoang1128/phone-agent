from rest_framework import serializers

from .models import Task, TaskStep


class TaskStepSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskStep
        fields = [
            'id',
            'task',
            'handler',
            'params',
            'order',
            'status',
            'result',
            'error',
            'executed_at',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'task',
            'status',
            'result',
            'error',
            'executed_at',
            'created_at',
            'updated_at',
        ]


class TaskSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    device_id = serializers.IntegerField(source='device.id', read_only=True, allow_null=True)
    steps = TaskStepSerializer(many=True, read_only=True)

    class Meta:
        model = Task
        fields = [
            'id',
            'name',
            'description',
            'task_kind',
            'task_type',
            'status',
            'payload',
            'result',
            'owner_id',
            'team_id',
            'team_name',
            'team_permission',
            'device_id',
            'device_serial',
            'steps',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'owner_id',
            'team_id',
            'team_name',
            'device_id',
            'device_serial',
            'result',
            'steps',
            'created_at',
            'updated_at',
        ]
