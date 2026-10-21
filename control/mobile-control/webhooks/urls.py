from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import WebhookViewSet

router = DefaultRouter()
router.register('webhooks', WebhookViewSet, basename='webhook')

urlpatterns = [
    path('', include(router.urls)),
]
