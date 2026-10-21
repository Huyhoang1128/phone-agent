from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    EventCatalogView,
    WebhookTriggerReceiveView,
    WorkflowRunViewSet,
    WorkflowStepViewSet,
    WorkflowTriggerViewSet,
    WorkflowViewSet,
)

router = DefaultRouter()
router.register('workflows', WorkflowViewSet, basename='workflow')

urlpatterns = [
    path('', include(router.urls)),
    path('events/', EventCatalogView.as_view(), name='event-catalog'),
    # Nested: triggers under a workflow
    path(
        'workflows/<int:workflow_pk>/steps/',
        WorkflowStepViewSet.as_view({'get': 'list', 'post': 'create'}),
        name='workflow-step-list',
    ),
    path(
        'workflows/<int:workflow_pk>/steps/<int:pk>/',
        WorkflowStepViewSet.as_view({
            'get': 'retrieve',
            'put': 'update',
            'patch': 'partial_update',
            'delete': 'destroy',
        }),
        name='workflow-step-detail',
    ),
    path(
        'workflows/<int:workflow_pk>/triggers/',
        WorkflowTriggerViewSet.as_view({'get': 'list', 'post': 'create'}),
        name='workflow-trigger-list',
    ),
    path(
        'workflows/<int:workflow_pk>/triggers/<int:pk>/',
        WorkflowTriggerViewSet.as_view({
            'get': 'retrieve',
            'put': 'update',
            'patch': 'partial_update',
            'delete': 'destroy',
        }),
        name='workflow-trigger-detail',
    ),
    # Nested: runs under a workflow
    path(
        'workflows/<int:workflow_pk>/runs/',
        WorkflowRunViewSet.as_view({'get': 'list'}),
        name='workflow-run-list',
    ),
    path(
        'workflows/<int:workflow_pk>/runs/<int:pk>/',
        WorkflowRunViewSet.as_view({'get': 'retrieve'}),
        name='workflow-run-detail',
    ),
    path(
        'workflows/<int:workflow_pk>/runs/<int:pk>/cancel/',
        WorkflowRunViewSet.as_view({'post': 'cancel'}),
        name='workflow-run-cancel',
    ),
    # Public webhook receive endpoint
    path(
        'workflows/webhook/<str:token>/',
        WebhookTriggerReceiveView.as_view({'post': 'create'}),
        name='workflow-webhook-receive',
    ),
]
