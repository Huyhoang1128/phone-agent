from django.contrib.auth.models import User
from rest_framework import serializers
from .models import Team, TeamMembership, TeamRole


class TeamMemberSerializer(serializers.ModelSerializer):
    user_id = serializers.IntegerField(source='user.id', read_only=True)
    username = serializers.CharField(source='user.username', read_only=True)
    email = serializers.EmailField(source='user.email', read_only=True)
    display_name = serializers.SerializerMethodField()

    class Meta:
        model = TeamMembership
        fields = ['id', 'user_id', 'username', 'email', 'display_name', 'role', 'joined_at']
        read_only_fields = ['id', 'user_id', 'username', 'email', 'display_name', 'joined_at']

    def get_display_name(self, obj):
        try:
            return obj.user.profile.display_name or obj.user.get_full_name() or obj.user.username
        except Exception:
            return obj.user.username


class TeamSerializer(serializers.ModelSerializer):
    member_count = serializers.SerializerMethodField()
    my_role = serializers.SerializerMethodField()

    class Meta:
        model = Team
        fields = ['id', 'name', 'description', 'created_by', 'member_count', 'my_role', 'created_at', 'updated_at']
        read_only_fields = ['id', 'created_by', 'member_count', 'my_role', 'created_at', 'updated_at']

    def get_member_count(self, obj):
        return obj.memberships.count()

    def get_my_role(self, obj):
        request = self.context.get('request')
        if request and request.user.is_authenticated:
            membership = obj.memberships.filter(user=request.user).first()
            return membership.role if membership else None
        return None


class TeamDetailSerializer(TeamSerializer):
    members = TeamMemberSerializer(source='memberships', many=True, read_only=True)

    class Meta(TeamSerializer.Meta):
        fields = TeamSerializer.Meta.fields + ['members']


class AddMemberSerializer(serializers.Serializer):
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=TeamRole.choices, default=TeamRole.MEMBER)

    def validate_email(self, value):
        try:
            user = User.objects.get(email=value)
        except User.DoesNotExist:
            raise serializers.ValidationError('No user found with this email address.')
        self.context['member_user'] = user
        return value


class UpdateMemberRoleSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=TeamRole.choices)
