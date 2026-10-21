from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Team, TeamMembership, TeamRole
from .serializers import (
    TeamSerializer,
    TeamDetailSerializer,
    TeamMemberSerializer,
    AddMemberSerializer,
    UpdateMemberRoleSerializer,
)


class IsTeamAdminOrOwner(permissions.BasePermission):
    """Allow only team owner/admin to perform the action."""

    def has_object_permission(self, request, view, obj):
        if isinstance(obj, Team):
            membership = obj.memberships.filter(user=request.user).first()
        else:
            membership = obj
        if membership is None:
            return False
        return membership.role in (TeamRole.OWNER, TeamRole.ADMIN)


class TeamViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated]

    def get_serializer_class(self):
        if self.action in ('retrieve',):
            return TeamDetailSerializer
        return TeamSerializer

    def get_queryset(self):
        return Team.objects.filter(memberships__user=self.request.user).distinct()

    def perform_create(self, serializer):
        team = serializer.save(created_by=self.request.user)
        TeamMembership.objects.create(team=team, user=self.request.user, role=TeamRole.OWNER)

    def destroy(self, request, *args, **kwargs):
        team = self.get_object()
        membership = team.memberships.filter(user=request.user).first()
        if not membership or membership.role != TeamRole.OWNER:
            return Response({'detail': 'Only the team owner can delete the team.'}, status=status.HTTP_403_FORBIDDEN)
        return super().destroy(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        team = self.get_object()
        membership = team.memberships.filter(user=request.user).first()
        if not membership or membership.role not in (TeamRole.OWNER, TeamRole.ADMIN):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        return super().update(request, *args, **kwargs)

    @action(detail=True, methods=['get', 'post'], url_path='members')
    def members(self, request, pk=None):
        team = self.get_object()
        if request.method == 'GET':
            memberships = team.memberships.select_related('user', 'user__profile').all()
            return Response(TeamMemberSerializer(memberships, many=True).data)

        # POST – add member
        my_membership = team.memberships.filter(user=request.user).first()
        if not my_membership or my_membership.role not in (TeamRole.OWNER, TeamRole.ADMIN):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        serializer = AddMemberSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        member_user = serializer.context['member_user']
        role = serializer.validated_data['role']

        membership, created = TeamMembership.objects.get_or_create(
            team=team, user=member_user,
            defaults={'role': role},
        )
        if not created:
            return Response({'detail': 'User is already a member.'}, status=status.HTTP_400_BAD_REQUEST)
        return Response(TeamMemberSerializer(membership).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['patch', 'delete'], url_path=r'members/(?P<user_id>[0-9]+)')
    def member_detail(self, request, pk=None, user_id=None):
        team = self.get_object()
        my_membership = team.memberships.filter(user=request.user).first()
        if not my_membership or my_membership.role not in (TeamRole.OWNER, TeamRole.ADMIN):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        try:
            membership = team.memberships.get(user_id=user_id)
        except TeamMembership.DoesNotExist:
            return Response({'detail': 'Member not found.'}, status=status.HTTP_404_NOT_FOUND)

        if request.method == 'DELETE':
            # Owner cannot be removed unless they are removing themselves
            if membership.role == TeamRole.OWNER and str(request.user.id) != str(user_id):
                return Response({'detail': 'Cannot remove the team owner.'}, status=status.HTTP_400_BAD_REQUEST)
            membership.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        # PATCH – change role
        serializer = UpdateMemberRoleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        new_role = serializer.validated_data['role']
        # Cannot change owner role unless requester is owner
        if membership.role == TeamRole.OWNER and my_membership.role != TeamRole.OWNER:
            return Response({'detail': 'Only the owner can change the owner role.'}, status=status.HTTP_403_FORBIDDEN)
        membership.role = new_role
        membership.save(update_fields=['role'])
        return Response(TeamMemberSerializer(membership).data)

    @action(detail=True, methods=['get'], url_path='resources')
    def resources(self, request, pk=None):
        """List all resources shared with this team."""
        team = self.get_object()
        from devices.models import Device
        from credentials.models import Credential
        from profiles.models import Profile
        from task.models import Task
        from mobile_apps.models import MobileApp
        from devices.serializers import DeviceSerializer
        from credentials.serializers import CredentialSerializer
        from profiles.serializers import ProfileSerializer
        from schedule.serializers import TaskSerializer
        from mobile_apps.serializers import MobileAppSerializer

        return Response({
            'devices': DeviceSerializer(Device.objects.filter(team=team), many=True).data,
            'credentials': CredentialSerializer(Credential.objects.filter(team=team), many=True).data,
            'profiles': ProfileSerializer(Profile.objects.filter(team=team), many=True, context={'request': request}).data,
            'tasks': TaskSerializer(Task.objects.filter(team=team), many=True).data,
            'apps': MobileAppSerializer(MobileApp.objects.filter(team=team), many=True, context={'request': request}).data,
        })
