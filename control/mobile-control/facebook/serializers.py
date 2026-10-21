from rest_framework import serializers

from .models import (
    FacebookCommentPlan,
    FacebookGroup,
    FacebookGroupPendingMemberPost,
    FacebookGroupPost,
    FacebookGroupPostSeedingAction,
    FacebookGroupScheduledPost,
    FacebookPage,
    FacebookPost,
    FacebookPostInteraction,
    FacebookPostUserComment,
    FacebookProfileScheduledPostUserComment,
    FacebookProfile,
    FacebookProfilePost,
    FacebookProfilePostSeedingAction,
    FacebookProfileScheduledMediaAction,
    FacebookProfileScheduledPost,
    FacebookScheduledPost,
    FacebookScheduledPostCommentPlan,
    FbHackKey,
)


class FacebookPageSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)

    class Meta:
        model = FacebookPage
        fields = [
            'id', 'name', 'page_url', 'page_uid', 'page_token', 'category', 'description',
            'follower_count', 'status', 'owner_id', 'team_id',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'created_at', 'updated_at']


class FacebookGroupSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    admin_profile_name = serializers.CharField(source='admin_profile.name', read_only=True, allow_null=True)
    admin_fb_profile_name = serializers.CharField(source='admin_fb_profile.name', read_only=True, allow_null=True)
    default_poster_fb_profile_name = serializers.CharField(
        source='default_poster_fb_profile.name', read_only=True, allow_null=True,
    )

    class Meta:
        model = FacebookGroup
        fields = [
            'id', 'name', 'group_url', 'group_uid', 'group_token', 'description', 'member_count',
            'admin_profile', 'admin_profile_name',
            'admin_fb_profile', 'admin_fb_profile_name',
            'default_poster_fb_profile', 'default_poster_fb_profile_name',
            'status',
            'owner_id', 'team_id', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'owner_id', 'admin_profile_name', 'admin_fb_profile_name',
            'default_poster_fb_profile_name',
            'created_at', 'updated_at',
        ]

    def _user_can_assign(self, request, value) -> bool:
        """Return True when *request.user* may assign *value* as admin.

        Matches what ``OwnedResourceMixin.get_queryset`` returns for the
        profile / FB profile list endpoints: owned by the user, OR shared to
        a team the user belongs to. Anything outside that set is hidden in
        the UI dropdown so it being assigned would only happen via a hand-
        crafted request — reject.
        """
        if request is None or value is None:
            return True
        user = request.user
        if value.owner_id == user.id:
            return True
        if getattr(value, 'team_id', None):
            from teams.models import TeamMembership
            return TeamMembership.objects.filter(team_id=value.team_id, user=user).exists()
        return False

    def validate_admin_profile(self, value):
        if not self._user_can_assign(self.context.get('request'), value):
            raise serializers.ValidationError(
                'Profile này không thuộc bạn và cũng không được share qua team — không thể gán làm admin.'
            )
        return value

    def validate_admin_fb_profile(self, value):
        if not self._user_can_assign(self.context.get('request'), value):
            raise serializers.ValidationError(
                'FB profile này không thuộc bạn và cũng không được share qua team — không thể gán làm admin.'
            )
        return value

    def validate_default_poster_fb_profile(self, value):
        if not self._user_can_assign(self.context.get('request'), value):
            raise serializers.ValidationError(
                'FB profile này không thuộc bạn và cũng không được share qua team — không thể gán làm poster.'
            )
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        admin = attrs.get('admin_fb_profile') or getattr(self.instance, 'admin_fb_profile', None)
        poster = attrs.get('default_poster_fb_profile') or getattr(self.instance, 'default_poster_fb_profile', None)
        if admin and poster and admin.id == poster.id:
            raise serializers.ValidationError({
                'default_poster_fb_profile': (
                    'Poster phải khác Admin. Admin chỉ duyệt, poster mới là tài '
                    'khoản tap nút Đăng.'
                ),
            })
        return attrs


class FacebookPostSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    page_name = serializers.CharField(source='page.name', read_only=True)

    class Meta:
        model = FacebookPost
        fields = [
            'id', 'page', 'page_name', 'post_url', 'image_url', 'image_urls', 'caption', 'content',
            'keywords', 'status', 'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'page_name', 'owner_id', 'created_at', 'updated_at']

    def validate_page(self, value):
        request = self.context.get('request')
        if request and value.owner_id != request.user.id:
            raise serializers.ValidationError('You can only add posts to your own pages.')
        return value

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        if data.get('image_url'):
            data['image_url'] = get_presigned_image_url(data['image_url'])
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookPostInteractionSerializer(serializers.ModelSerializer):
    class Meta:
        model = FacebookPostInteraction
        fields = [
            'id', 'interaction_type', 'profile_username', 'profile_avatar_url',
            'comment_content', 'comment_link', 'interacted_at',
            'replay_task_dispatched', 'dig_comment_dispatched', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']


class FacebookCommentPlanSerializer(serializers.ModelSerializer):
    profile_name = serializers.CharField(source='profile.name', read_only=True, allow_null=True)
    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    agent_group_name = serializers.CharField(source='agent_group.name', read_only=True, allow_null=True)

    class Meta:
        model = FacebookCommentPlan
        fields = [
            'id', 'post', 'post_link', 'agent_group', 'agent_group_name',
            'profile', 'profile_name', 'device', 'device_name',
            'comment_content', 'comment_link', 'reply_to',
            'is_approved', 'is_commented',
            'execution_status', 'execution_retry_count', 'execution_last_error',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'post', 'execution_status', 'execution_retry_count',
            'execution_last_error', 'created_at', 'updated_at',
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


class FacebookScheduledPostCommentPlanSerializer(serializers.ModelSerializer):
    """Comment plan for a published scheduled post. The comment is posted by the
    FB account on ``device`` (``actor_fb_profile``), mirroring TiktokCommentPlan
    but with ``device_name`` denormalised for the (shared) TikTok-style UI."""

    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    actor_name = serializers.SerializerMethodField()
    agent_group_name = serializers.CharField(source='agent_group.name', read_only=True, allow_null=True)

    class Meta:
        model = FacebookScheduledPostCommentPlan
        fields = [
            'id', 'scheduled_post', 'post_link', 'agent_group', 'agent_group_name',
            'device', 'device_name', 'actor_fb_profile', 'actor_name',
            'comment_content', 'comment_link', 'reply_to',
            'is_approved', 'is_commented',
            'execution_status', 'execution_retry_count', 'execution_last_error',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'scheduled_post', 'post_link', 'agent_group', 'device',
            'actor_fb_profile', 'comment_link', 'is_commented', 'execution_status',
            'execution_retry_count', 'execution_last_error', 'created_at', 'updated_at',
        ]

    def get_actor_name(self, obj):
        actor = obj.actor_fb_profile
        if not actor:
            return None
        return actor.account_name or actor.name


class FbHackKeySerializer(serializers.ModelSerializer):
    """Third-party hacklike token. ``token`` is write-only (paste on create);
    reads expose only ``key_masked``."""

    key_masked = serializers.CharField(read_only=True)

    class Meta:
        model = FbHackKey
        fields = ['id', 'name', 'token', 'key_masked', 'is_active', 'last_used_at', 'created_at', 'updated_at']
        extra_kwargs = {'token': {'write_only': True}}
        read_only_fields = ['id', 'key_masked', 'last_used_at', 'created_at', 'updated_at']


class FacebookPostUserCommentSerializer(serializers.ModelSerializer):
    class Meta:
        model = FacebookPostUserComment
        fields = ['id', 'cid', 'user_id', 'nickname', 'text', 'create_time', 'parent_cid', 'comment_link']
        read_only_fields = ['id']


class FacebookProfileScheduledPostUserCommentSerializer(serializers.ModelSerializer):
    class Meta:
        model = FacebookProfileScheduledPostUserComment
        fields = ['id', 'cid', 'user_id', 'nickname', 'text', 'create_time', 'parent_cid', 'comment_link']
        read_only_fields = ['id']


class FacebookScheduledPostSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    page_name = serializers.CharField(source='page.name', read_only=True)

    class Meta:
        model = FacebookScheduledPost
        fields = [
            'id', 'page', 'page_name', 'content', 'image_urls', 'image_description',
            'topic', 'scheduled_at', 'status', 'fb_post_id', 'error_msg',
            'buffed_like_total', 'buffed_at',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'page_name', 'fb_post_id', 'error_msg',
            'buffed_like_total', 'buffed_at',
            'owner_id', 'created_at', 'updated_at',
        ]

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookGroupPostSerializer(serializers.ModelSerializer):
    """Mirror of FacebookPostSerializer keyed on FacebookGroup."""

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    group_name = serializers.CharField(source='group.name', read_only=True)

    class Meta:
        model = FacebookGroupPost
        fields = [
            'id', 'group', 'group_name', 'post_url', 'image_url', 'image_urls', 'caption', 'content',
            'keywords', 'status', 'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'group_name', 'owner_id', 'created_at', 'updated_at']

    def validate_group(self, value):
        request = self.context.get('request')
        if request and value.owner_id != request.user.id:
            raise serializers.ValidationError('You can only add posts to your own groups.')
        return value

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        if data.get('image_url'):
            data['image_url'] = get_presigned_image_url(data['image_url'])
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookGroupScheduledPostSerializer(serializers.ModelSerializer):
    """Mirror of FacebookScheduledPostSerializer keyed on FacebookGroup."""

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    group_name = serializers.CharField(source='group.name', read_only=True)
    poster_fb_profile_name = serializers.CharField(
        source='poster_fb_profile.name', read_only=True, allow_null=True,
    )

    class Meta:
        model = FacebookGroupScheduledPost
        fields = [
            'id', 'group', 'group_name', 'content', 'image_urls', 'image_description',
            'topic', 'scheduled_at', 'status', 'is_approved',
            'poster_fb_profile', 'poster_fb_profile_name',
            'fb_post_id', 'error_msg',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'group_name', 'is_approved', 'poster_fb_profile_name',
            'fb_post_id', 'error_msg',
            'owner_id', 'created_at', 'updated_at',
        ]

    def validate_poster_fb_profile(self, value):
        if value is None:
            return value
        request = self.context.get('request')
        if request is None:
            return value
        user = request.user
        if value.owner_id == user.id:
            return value
        if getattr(value, 'team_id', None):
            from teams.models import TeamMembership
            if TeamMembership.objects.filter(team_id=value.team_id, user=user).exists():
                return value
        raise serializers.ValidationError(
            'FB profile này không thuộc bạn và cũng không được share qua team — không thể gán làm poster.'
        )

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookProfileSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    device_serial = serializers.CharField(source='device.device_serial_id', read_only=True, default='')
    device_name = serializers.CharField(source='device.name', read_only=True, default='')

    class Meta:
        model = FacebookProfile
        fields = [
            'id', 'name', 'profile_url', 'profile_uid', 'profile_token', 'description',
            'friend_count', 'status', 'owner_id', 'team_id',
            'device', 'device_serial', 'device_name', 'account_name',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'owner_id', 'device_serial', 'device_name',
            'created_at', 'updated_at',
        ]


class FacebookProfilePostSerializer(serializers.ModelSerializer):
    """Mirror of FacebookGroupPostSerializer keyed on FacebookProfile."""

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True)

    class Meta:
        model = FacebookProfilePost
        fields = [
            'id', 'profile', 'profile_name', 'post_url', 'image_url', 'image_urls', 'caption', 'content',
            'keywords', 'status', 'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'profile_name', 'owner_id', 'created_at', 'updated_at']

    def validate_profile(self, value):
        request = self.context.get('request')
        if request and value.owner_id != request.user.id:
            raise serializers.ValidationError('You can only add posts to your own profiles.')
        return value

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        if data.get('image_url'):
            data['image_url'] = get_presigned_image_url(data['image_url'])
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookProfileScheduledPostSerializer(serializers.ModelSerializer):
    """Mirror of FacebookGroupScheduledPostSerializer keyed on FacebookProfile."""

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True)
    target_group_name = serializers.CharField(
        source='target_group.name', read_only=True, allow_null=True,
    )

    class Meta:
        model = FacebookProfileScheduledPost
        fields = [
            'id', 'profile', 'profile_name', 'content', 'image_urls', 'image_description',
            'topic', 'ai_prompt', 'ai_rewritten_content',
            'scheduled_at', 'status',
            'target_group', 'target_group_name', 'is_approved',
            'fb_post_id', 'error_msg',
            'buffed_like_total', 'buffed_at',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'profile_name', 'target_group_name', 'is_approved',
            'fb_post_id', 'error_msg',
            'buffed_like_total', 'buffed_at',
            'owner_id', 'created_at', 'updated_at',
        ]

    def validate_target_group(self, value):
        if value is None:
            return value
        request = self.context.get('request')
        if request is None:
            return value
        user = request.user
        if value.owner_id == user.id:
            return value
        if getattr(value, 'team_id', None):
            from teams.models import TeamMembership
            if TeamMembership.objects.filter(team_id=value.team_id, user=user).exists():
                return value
        raise serializers.ValidationError(
            'Group này không thuộc bạn và cũng không được share qua team.'
        )

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        image_urls = data.get('image_urls') or []
        if image_urls:
            data['image_urls'] = [get_presigned_image_url(u) for u in image_urls if u]
        return data


class FacebookGroupPendingMemberPostSerializer(serializers.ModelSerializer):
    """Read-only-ish snapshot of a member's pending post on FB.

    Rows are created by the phoneagent sync task — never via API. Only the
    `status` field transitions through the approve/reject endpoints.
    """

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    group_name = serializers.CharField(source='group.name', read_only=True)

    class Meta:
        model = FacebookGroupPendingMemberPost
        fields = [
            'id', 'group', 'group_name', 'post_fb_id', 'post_url',
            'author_name', 'author_uid', 'content', 'image_urls', 'posted_at',
            'status', 'pending_tab', 'error_msg',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = fields  # all read-only; mutations go through actions


class FacebookProfileScheduledMediaActionSerializer(serializers.ModelSerializer):
    """Scheduled avatar / cover / story change on a Facebook profile."""

    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True)

    class Meta:
        model = FacebookProfileScheduledMediaAction
        fields = [
            'id', 'profile', 'profile_name', 'action_type', 'image_url',
            'scheduled_at', 'status', 'error_msg',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'profile_name', 'error_msg',
            'owner_id', 'created_at', 'updated_at',
        ]

    def to_representation(self, instance):
        """Sign S3 image URL so the browser can fetch private bucket objects."""
        data = super().to_representation(instance)
        from .s3_utils import get_presigned_image_url
        if data.get('image_url'):
            data['image_url'] = get_presigned_image_url(data['image_url'])
        return data


class FacebookCommentedInteractionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    comment_plan_id = serializers.IntegerField(allow_null=True)
    post_id = serializers.IntegerField()
    post_url = serializers.CharField(allow_blank=True)
    page_id = serializers.IntegerField(allow_null=True)
    page_name = serializers.CharField(allow_null=True)
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


_SEEDING_FIELDS = [
    'id', 'post', 'actor_fb_profile', 'actor_fb_profile_name',
    'interaction_type', 'comment_content',
    'reply_target_username', 'reply_target_snippet',
    'ai_prompt',
    'status', 'fb_comment_id', 'error_msg',
    'task', 'created_at', 'updated_at',
]
_SEEDING_READ_ONLY = ['id', 'status', 'fb_comment_id', 'error_msg', 'task', 'created_at', 'updated_at']


class FacebookProfilePostSeedingActionSerializer(serializers.ModelSerializer):
    actor_fb_profile_name = serializers.CharField(
        source='actor_fb_profile.name', read_only=True, allow_null=True,
    )

    class Meta:
        model = FacebookProfilePostSeedingAction
        fields = _SEEDING_FIELDS
        read_only_fields = _SEEDING_READ_ONLY


class FacebookGroupPostSeedingActionSerializer(serializers.ModelSerializer):
    actor_fb_profile_name = serializers.CharField(
        source='actor_fb_profile.name', read_only=True, allow_null=True,
    )

    class Meta:
        model = FacebookGroupPostSeedingAction
        fields = _SEEDING_FIELDS
        read_only_fields = _SEEDING_READ_ONLY
