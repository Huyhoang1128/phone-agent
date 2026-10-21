from rest_framework import serializers
from .models import AgentGroup, AgentGroupMember, AgentGroupSharedMemory, AgentGroupSharedFile, AgentGroupSharedState, AgentGroupPlan


class AgentGroupMemberSerializer(serializers.ModelSerializer):
    device_name = serializers.CharField(source='device.name', read_only=True)
    device_status = serializers.CharField(source='device.status', read_only=True)
    device_type = serializers.CharField(source='device.device_type', read_only=True)
    device_identifier = serializers.CharField(source='device.identifier', read_only=True)
    device_serial_id = serializers.CharField(source='device.device_serial_id', read_only=True)
    device_worker_id = serializers.CharField(source='device.worker_id', read_only=True)
    device_profile_name = serializers.SerializerMethodField()

    def get_device_profile_name(self, obj):
        profile = obj.device.profiles.order_by('id').first()
        return profile.name if profile else ''

    class Meta:
        model = AgentGroupMember
        fields = [
            'id',
            'device',
            'device_name',
            'device_status',
            'device_type',
            'device_identifier',
            'device_serial_id',
            'device_worker_id',
            'device_profile_name',
            'role',
            'added_at',
        ]
        read_only_fields = [
            'id',
            'device_name',
            'device_status',
            'device_type',
            'device_identifier',
            'device_serial_id',
            'device_worker_id',
            'device_profile_name',
            'added_at',
        ]


class AgentGroupSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    members = AgentGroupMemberSerializer(many=True, read_only=True)
    member_count = serializers.SerializerMethodField()

    class Meta:
        model = AgentGroup
        fields = [
            'id', 'name', 'description', 'system_prompt', 'goal',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'members', 'member_count',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'team_id', 'team_name', 'members', 'member_count', 'created_at', 'updated_at']

    def get_member_count(self, obj):
        return obj.members.count()


class AgentGroupSharedMemorySerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentGroupSharedMemory
        fields = ['id', 'key', 'value', 'updated_at']
        read_only_fields = ['id', 'updated_at']


class AgentGroupSharedFileSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = AgentGroupSharedFile
        fields = ['id', 'name', 'file', 'file_url', 'uploaded_at']
        read_only_fields = ['id', 'file_url', 'uploaded_at']
        extra_kwargs = {'file': {'write_only': True}}

    def get_file_url(self, obj):
        request = self.context.get('request')
        if obj.file and request:
            return request.build_absolute_uri(obj.file.url)
        return None


class AgentGroupSharedStateSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentGroupSharedState
        fields = ['id', 'key', 'value', 'updated_at']
        read_only_fields = ['id', 'updated_at']


class AgentGroupPlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentGroupPlan
        fields = ['id', 'group', 'goal', 'plan', 'status', 'created_by', 'created_at', 'updated_at']
        read_only_fields = ['id', 'group', 'status', 'created_by', 'created_at', 'updated_at']
