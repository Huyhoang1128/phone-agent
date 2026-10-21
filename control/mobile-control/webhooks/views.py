from rest_framework import permissions, viewsets

from .models import Webhook
from .serializers import WebhookSerializer


class WebhookViewSet(viewsets.ModelViewSet):
    serializer_class = WebhookSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Webhook.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)
