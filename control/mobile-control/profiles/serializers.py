from rest_framework import serializers
from croniter import croniter
from django.utils import timezone
from .models import (
    Profile,
    ProfileFile,
    ProfileMemory,
    ProfileRoutine,
    ProfileAppInstallation,
    ProfileContentItem,
)
from mobile_apps.models import MobileApp
from mobile_apps.serializers import MobileAppSerializer
from credentials.models import Credential
from credentials.serializers import CredentialSerializer
from devices.serializers import DeviceSerializer


class ProfileFileSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = ProfileFile
        fields = ['id', 'profile', 'name', 'file', 'file_url', 'created_at']
        read_only_fields = ['id', 'file_url', 'created_at']
        extra_kwargs = {'file': {'write_only': True}, 'profile': {'read_only': True}}

    def get_file_url(self, obj):
        if obj.file:
            request = self.context.get('request')
            try:
                url = obj.file.url
            except Exception:
                return None
            if request:
                return request.build_absolute_uri(url)
            return url
        return None


class ProfileSerializer(serializers.ModelSerializer):
    apps_detail = MobileAppSerializer(source='apps', many=True, read_only=True)
    credentials_detail = CredentialSerializer(source='credentials', many=True, read_only=True)
    device_detail = DeviceSerializer(source='device', read_only=True)
    files = ProfileFileSerializer(many=True, read_only=True)
    routines = serializers.SerializerMethodField()
    apps = serializers.PrimaryKeyRelatedField(many=True, queryset=MobileApp.objects.all(), required=False, default=list)
    credentials = serializers.PrimaryKeyRelatedField(many=True, queryset=Credential.objects.all(), required=False, default=list)
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = Profile
        fields = [
            'id', 'name', 'goal', 'topic', 'topics', 'topic_history', 'topic_audit_logs', 'personality', 'website_url',
            'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password',
            'device', 'device_detail',
            'apps', 'apps_detail',
            'credentials', 'credentials_detail',
            'files',
            'routines',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'device_detail', 'apps_detail', 'credentials_detail', 'files', 'routines',
            'owner_id', 'team_id', 'team_name', 'topic_history', 'topic_audit_logs', 'created_at', 'updated_at',
        ]

    @staticmethod
    def _normalize_topics(raw_topics):
        topics = []
        seen = set()
        for value in raw_topics or []:
            topic = str(value).strip()
            if not topic:
                continue
            lowered = topic.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            topics.append(topic)
        return topics

    def create(self, validated_data):
        topic = (validated_data.get('topic') or '').strip()
        topics = self._normalize_topics(validated_data.get('topics') or [])
        if topic and topic.lower() not in {item.lower() for item in topics}:
            topics.insert(0, topic)
        if not topic and topics:
            topic = topics[0]
        validated_data['topic'] = topic
        validated_data['topics'] = topics
        if topic:
            validated_data['topic_history'] = [{'topic': topic, 'updated_at': timezone.now().isoformat()}]
        return super().create(validated_data)

    def update(self, instance, validated_data):
        existing_topics = self._normalize_topics(instance.topics or [])
        original_primary_topic = (instance.topic or '').strip()
        next_topics = None

        if 'topics' in validated_data:
            next_topics = self._normalize_topics(validated_data.get('topics') or [])

        if 'topic' in validated_data:
            next_topic = (validated_data.get('topic') or '').strip()
            validated_data['topic'] = next_topic
            if next_topics is None:
                next_topics = list(existing_topics)
            if next_topic:
                lower_set = {item.lower() for item in next_topics}
                if next_topic.lower() not in lower_set:
                    next_topics.insert(0, next_topic)
            else:
                next_topics = []
            if next_topic and next_topic != (instance.topic or '').strip():
                history = list(instance.topic_history or [])
                history.append({'topic': next_topic, 'updated_at': timezone.now().isoformat()})
                validated_data['topic_history'] = history

        if next_topics is not None:
            validated_data['topics'] = next_topics
            if 'topic' not in validated_data:
                validated_data['topic'] = next_topics[0] if next_topics else ''

        has_topic_list_change = next_topics is not None and next_topics != existing_topics
        has_primary_change = 'topic' in validated_data and validated_data['topic'] != original_primary_topic
        if has_topic_list_change or has_primary_change:
            request = self.context.get('request')
            actor_id = getattr(getattr(request, 'user', None), 'id', None)
            audit_logs = list(instance.topic_audit_logs or [])
            audit_logs.append({
                'action': 'update_topics',
                'actor_id': actor_id,
                'updated_at': timezone.now().isoformat(),
                'before': existing_topics,
                'after': validated_data.get('topics', existing_topics),
            })
            validated_data['topic_audit_logs'] = audit_logs
        return super().update(instance, validated_data)

    def get_routines(self, obj):
        return ProfileRoutineSerializer(obj.routines.all(), many=True).data


class ProfileAppInstallationSerializer(serializers.ModelSerializer):
    """Read-only view of an app's install/uninstall state on a profile.

    Entirely read-only: these rows are mutated solely through the
    ``install-apps`` action, never via direct serializer writes.
    """
    app_detail = MobileAppSerializer(source='app', read_only=True)
    requested_by_id = serializers.IntegerField(
        source='requested_by.id', read_only=True, allow_null=True
    )

    class Meta:
        model = ProfileAppInstallation
        fields = [
            'id', 'profile', 'app', 'app_detail', 'device',
            'status', 'command_id', 'error_message',
            'requested_by_id', 'created_at', 'updated_at',
        ]
        read_only_fields = fields


class ProfileMemorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ProfileMemory
        fields = ['id', 'key', 'value', 'tags', 'updated_at']
        read_only_fields = ['id', 'updated_at']


class ProfileRoutineSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProfileRoutine
        fields = ['id', 'schedule_time', 'action', 'cron_expression', 'created_at', 'updated_at']
        read_only_fields = ['id', 'created_at', 'updated_at']

    def validate_cron_expression(self, value):
        expression = value.strip()
        if not croniter.is_valid(expression):
            raise serializers.ValidationError('Invalid cron expression.')
        return expression


class ProfileContentItemSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True, allow_null=True)

    class Meta:
        model = ProfileContentItem
        fields = [
            'id', 'owner_id', 'title', 'source_url', 'video_url', 'description', 'tags',
            'metadata', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
