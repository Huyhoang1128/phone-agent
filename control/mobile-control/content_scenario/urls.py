"""URL routing cho AI Scenario v3.

Mount qua `path('api/', include('content_scenario.urls'))` ở `mbcontrol/urls.py`.
Prefix cuối cùng = `/api/content-scenarios/`.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import ContentScenarioViewSet

router = DefaultRouter()
router.register('content-scenarios', ContentScenarioViewSet, basename='content-scenario')

urlpatterns = [
    path('', include(router.urls)),
]
