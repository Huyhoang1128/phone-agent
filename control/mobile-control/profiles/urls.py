from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ProfileViewSet, worker_app_installation_callback

router = DefaultRouter()
router.register('profiles', ProfileViewSet, basename='profile')

urlpatterns = [
    path('', include(router.urls)),
    # Worker → Control callback (authenticated via shared-secret X-Worker-Token)
    path(
        'internal/app-installations/<int:installation_id>/status/',
        worker_app_installation_callback,
        name='worker-app-installation-callback',
    ),
]
