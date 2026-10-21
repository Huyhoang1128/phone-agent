from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import MobileAppViewSet

router = DefaultRouter()
router.register('apps', MobileAppViewSet, basename='mobile-app')

urlpatterns = [
    path('', include(router.urls)),
]
