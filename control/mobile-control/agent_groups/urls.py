from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import AgentGroupViewSet

router = DefaultRouter()
router.register('agent-groups', AgentGroupViewSet, basename='agentgroup')

urlpatterns = [
    path('', include(router.urls)),
]
