from rest_framework import viewsets, permissions
from mbcontrol.mixins import OwnedResourceMixin
from .models import Proxy
from .serializers import ProxySerializer


class ProxyViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Proxy.objects.all()
    serializer_class = ProxySerializer
    permission_classes = [permissions.IsAuthenticated]
