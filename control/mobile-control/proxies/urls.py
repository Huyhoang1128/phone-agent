from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ProxyViewSet

router = DefaultRouter()
router.register('proxies', ProxyViewSet, basename='proxy')

urlpatterns = [
    path('', include(router.urls)),
]
