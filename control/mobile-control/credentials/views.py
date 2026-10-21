from rest_framework import viewsets, permissions
from mbcontrol.mixins import OwnedResourceMixin
from .models import Credential
from .serializers import CredentialSerializer


class CredentialViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Credential.objects.all()
    serializer_class = CredentialSerializer
    permission_classes = [permissions.IsAuthenticated]
