"""Shared mixin for resource viewsets: ownership filtering and share/unshare actions."""
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.response import Response


def owned_or_shared(queryset, user):
    """Giới hạn ``queryset`` về những bản ghi ``user`` ĐƯỢC PHÉP dùng: của chính mình,
    hoặc đã chia sẻ cho một team mà mình là thành viên.

    Đây là ĐỊNH NGHĨA DUY NHẤT của luật "ai thấy được gì" — ``OwnedResourceMixin``
    dùng nó cho danh sách, còn các chỗ nhận ID trực tiếp từ request (không đi qua
    ``get_queryset``) cũng phải gọi nó. Trước đây luật này chỉ nằm trong mixin, nên
    mọi hàm tra cứu bằng ID do client gửi đều bỏ kiểm quyền và cho phép tài khoản của
    công ty này dùng đồ của công ty khác.

    Dùng khi có ID từ ``request.data`` / URL mà không lấy qua ``self.get_object()``::

        device = owned_or_shared(Device.objects.all(), request.user).filter(id=x).first()
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return queryset.none()
    from teams.models import TeamMembership
    team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
    # Giữ nguyên dạng hợp hai queryset (không đổi sang Q(...)|Q(...)) để câu SQL sinh ra
    # y như bản cũ của mixin — 12 endpoint đang dựa vào nó.
    return queryset.filter(owner=user) | queryset.filter(team_id__in=team_ids)


class OwnedResourceMixin:
    """
    Mixin that:
    - Filters queryset to resources owned by or shared with the current user's team
    - Auto-sets owner on create
    - Provides share/unshare actions
    """

    def get_queryset(self):
        return owned_or_shared(super().get_queryset(), self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=True, methods=['post'])
    def share(self, request, pk=None):
        resource = self.get_object()
        if resource.owner != request.user:
            return Response({'detail': 'Only the owner can share this resource.'}, status=status.HTTP_403_FORBIDDEN)
        team_id = request.data.get('team')
        team_permission = request.data.get('team_permission', 'view')
        if team_id is None:
            return Response({'detail': 'team is required.'}, status=status.HTTP_400_BAD_REQUEST)
        from teams.models import Team, TeamMembership
        try:
            team = Team.objects.get(id=team_id)
        except Team.DoesNotExist:
            return Response({'detail': 'Team not found.'}, status=status.HTTP_404_NOT_FOUND)
        if not TeamMembership.objects.filter(team=team, user=request.user).exists():
            return Response({'detail': 'You are not a member of this team.'}, status=status.HTTP_403_FORBIDDEN)
        if team_permission not in ('view', 'edit'):
            return Response({'detail': 'team_permission must be "view" or "edit".'}, status=status.HTTP_400_BAD_REQUEST)
        resource.team = team
        resource.team_permission = team_permission
        resource.save(update_fields=['team', 'team_permission'])
        serializer = self.get_serializer(resource)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def unshare(self, request, pk=None):
        resource = self.get_object()
        if resource.owner != request.user:
            return Response({'detail': 'Only the owner can unshare this resource.'}, status=status.HTTP_403_FORBIDDEN)
        resource.team = None
        resource.team_permission = 'view'
        resource.save(update_fields=['team', 'team_permission'])
        serializer = self.get_serializer(resource)
        return Response(serializer.data)
