from rest_framework import serializers

from .models import (
    KeywordList,
    TiktokCommentPlan,
    TiktokCommentPlanChatMessage,
    TiktokVideo,
    TiktokVideoInteraction,
    TiktokVideoUserComment,
)


class TiktokVideoInteractionSerializer(serializers.ModelSerializer):
    class Meta:
        model = TiktokVideoInteraction
        fields = [
            'id', 'interaction_type', 'profile_username', 'profile_avatar_url',
            'comment_content', 'comment_link', 'interacted_at', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']


class TiktokVideoSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)

    class Meta:
        model = TiktokVideo
        fields = [
            'id', 'keywords', 'video_url', 'caption', 'content', 'status',
            'video_process_task_id', 'owner_id', 'team_id', 'existing_comments',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'video_process_task_id', 'created_at', 'updated_at']


class KeywordListSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = KeywordList
        fields = [
            'id', 'name', 'topic', 'keywords', 'dispatched_keywords', 'saved_keywords',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'owner_id', 'team_id', 'team_name', 'saved_keywords', 'created_at', 'updated_at',
        ]


class TiktokCommentPlanSerializer(serializers.ModelSerializer):
    profile_name = serializers.CharField(source='profile.name', read_only=True, allow_null=True)
    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    agent_group_name = serializers.CharField(source='agent_group.name', read_only=True, allow_null=True)

    class Meta:
        model = TiktokCommentPlan
        fields = [
            'id',
            'video',
            'video_link',
            'agent_group',
            'agent_group_name',
            'profile',
            'profile_name',
            'device',
            'device_name',
            'comment_content',
            'comment_link',
            'reply_to',
            'is_approved',
            'is_commented',
            'execution_status',
            'execution_retry_count',
            'execution_last_error',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'video',
            'execution_status',
            'execution_retry_count',
            'execution_last_error',
            'created_at',
            'updated_at',
        ]

    def validate(self, attrs):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            raise serializers.ValidationError({'detail': 'Authentication required.'})

        for field_name in ('agent_group', 'profile', 'device'):
            value = attrs.get(field_name)
            if value is not None and value.owner_id != request.user.id:
                raise serializers.ValidationError({field_name: 'You can only use your own resources.'})

        return attrs


class TiktokVideoUserCommentSerializer(serializers.ModelSerializer):
    class Meta:
        model = TiktokVideoUserComment
        fields = ['id', 'cid', 'user_id', 'nickname', 'text', 'create_time', 'parent_cid', 'comment_link']
        read_only_fields = ['id']


class TiktokCommentedInteractionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    comment_plan_id = serializers.IntegerField(allow_null=True)
    video_id = serializers.IntegerField()
    video_url = serializers.CharField(allow_blank=True)
    video_link = serializers.CharField(allow_blank=True)
    comment_content = serializers.CharField(allow_blank=True)
    comment_link = serializers.CharField(allow_blank=True)
    profile = serializers.IntegerField(allow_null=True)
    profile_name = serializers.CharField(allow_null=True)
    device = serializers.IntegerField(allow_null=True)
    device_name = serializers.CharField(allow_null=True)
    interacted_at = serializers.DateTimeField(allow_null=True)
    replay_task_dispatched = serializers.BooleanField()
    dig_comment_dispatched = serializers.BooleanField()
    created_at = serializers.DateTimeField()


class TiktokCommentPlanChatMessageSerializer(serializers.ModelSerializer):
    agent_group_name = serializers.CharField(source='agent_group.name', read_only=True, allow_null=True)

    class Meta:
        model = TiktokCommentPlanChatMessage
        fields = ['id', 'video', 'agent_group', 'agent_group_name', 'sender', 'content', 'created_at']
        read_only_fields = ['id', 'video', 'created_at']

    def validate(self, attrs):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            raise serializers.ValidationError({'detail': 'Authentication required.'})

        agent_group = attrs.get('agent_group')
        if agent_group is not None and agent_group.owner_id != request.user.id:
            raise serializers.ValidationError({'agent_group': 'You can only use your own resources.'})

        sender = attrs.get('sender')
        if sender is not None and sender != TiktokCommentPlanChatMessage.SenderType.USER:
            raise serializers.ValidationError({'sender': 'Only "user" sender is accepted for input messages.'})

        return attrs
