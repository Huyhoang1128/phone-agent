from rest_framework import mixins, permissions, status, viewsets
from rest_framework.response import Response

from .models import ApiKey
from .serializers import ApiKeySerializer


class ApiKeyViewSet(
    mixins.ListModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = ApiKeySerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return ApiKey.objects.filter(owner=self.request.user)

    def create(self, request, *args, **kwargs):
        name = (request.data.get('name') or '').strip()
        if not name:
            return Response({'name': ['This field is required.']}, status=status.HTTP_400_BAD_REQUEST)
        instance, raw_key = ApiKey.create_key(name=name, owner=request.user)
        # Attach raw key so the serializer can expose it once
        instance._raw_key = raw_key
        serializer = self.get_serializer(instance)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
