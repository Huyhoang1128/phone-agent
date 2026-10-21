from rest_framework import viewsets, parsers, permissions
from mbcontrol.mixins import OwnedResourceMixin
from .models import MobileApp
from .serializers import MobileAppSerializer


class MobileAppViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = MobileApp.objects.all()
    serializer_class = MobileAppSerializer
    parser_classes = [parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser]
    permission_classes = [permissions.IsAuthenticated]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context
