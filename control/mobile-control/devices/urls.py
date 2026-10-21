from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import DeviceNotificationViewSet, DeviceViewSet

router = DefaultRouter()
router.register('devices', DeviceViewSet, basename='device')
router.register('device-notifications', DeviceNotificationViewSet, basename='device-notification')

urlpatterns = [
    path('', include(router.urls)),
]
