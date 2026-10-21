import hashlib
import hmac
import logging

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from mbcontrol.events.enums import EVENT_DEFINITIONS
from mbcontrol.mixins import OwnedResourceMixin, owned_or_shared
from teams.models import TeamMembership

from .models import RunStatus, TriggeredBy, Workflow, WorkflowRun, WorkflowStep, WorkflowTrigger
from .serializers import (
    WorkflowRunSerializer,
    WorkflowSerializer,
    WorkflowStepSerializer,
    WorkflowTriggerReadSerializer,
    WorkflowTriggerSerializer,
    _compute_next_run,
)

logger = logging.getLogger(__name__)


class EventCatalogView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        data = [
            {
                'name': event_def.name.value,
                'label': event_def.label,
                'source_type': event_def.source_type.value,
            }
            for event_def in EVENT_DEFINITIONS
        ]
        return Response(data)


class WorkflowViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    """CRUD for Workflow definitions."""

    queryset = Workflow.objects.prefetch_related('steps', 'triggers').all()
    serializer_class = WorkflowSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset()
        profile_id = self.request.query_params.get('profile')
        if profile_id is not None:
            qs = qs.filter(profile_id=profile_id)
        device_id = self.request.query_params.get('device')
        if device_id is not None:
            qs = qs.filter(device_id=device_id)
        return qs

    @action(detail=True, methods=['post'])
    def run(self, request, pk=None):
        """Manually trigger a workflow run."""
        workflow = self.get_object()
        run = WorkflowRun.objects.create(
            workflow=workflow,
            triggered_by=TriggeredBy.MANUAL,
            status=RunStatus.PENDING,
            trigger_payload=request.data or {},
        )
        return Response(WorkflowRunSerializer(run).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'])
    def runs(self, request, pk=None):
        """List all runs for this workflow."""
        workflow = self.get_object()
        qs = WorkflowRun.objects.filter(workflow=workflow)
        page = self.paginate_queryset(qs)
        if page is not None:
            serializer = WorkflowRunSerializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        return Response(WorkflowRunSerializer(qs, many=True).data)


class WorkflowTriggerViewSet(viewsets.ModelViewSet):
    """CRUD for WorkflowTrigger objects nested under a workflow."""

    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return WorkflowTrigger.objects.none()
        workflow_id = self.kwargs.get('workflow_pk')
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        qs = WorkflowTrigger.objects.select_related('workflow').filter(
            workflow_id=workflow_id
        )
        return qs.filter(workflow__owner=user) | qs.filter(workflow__team_id__in=team_ids)

    def get_serializer_class(self):
        if self.request.method in ('GET',):
            return WorkflowTriggerReadSerializer
        return WorkflowTriggerSerializer

    def perform_create(self, serializer):
        workflow_id = self.kwargs.get('workflow_pk')
        # Lọc theo chủ sở hữu như get_queryset ở trên. Bản trước tra thẳng
        # ``get_object_or_404(Workflow, pk=...)``: đọc thì đã chặn đúng, nhưng THÊM
        # trigger/step thì không — tài khoản công ty khác POST vào
        # /api/workflows/<id-của-mình>/steps/ là nhét được bước vào workflow của mình,
        # và bước đó sẽ chạy thật.
        workflow = get_object_or_404(
            owned_or_shared(Workflow.objects.all(), self.request.user), pk=workflow_id)
        if workflow.triggers.exists():
            raise ValidationError({'detail': 'A workflow can only have one trigger.'})
        serializer.save(workflow=workflow)


class WorkflowStepViewSet(viewsets.ModelViewSet):
    """CRUD for WorkflowStep objects nested under a workflow."""

    serializer_class = WorkflowStepSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return WorkflowStep.objects.none()
        workflow_id = self.kwargs.get('workflow_pk')
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        qs = WorkflowStep.objects.select_related('workflow').filter(workflow_id=workflow_id)
        return qs.filter(workflow__owner=user) | qs.filter(workflow__team_id__in=team_ids)

    def perform_create(self, serializer):
        workflow_id = self.kwargs.get('workflow_pk')
        # Lọc theo chủ sở hữu như get_queryset ở trên. Bản trước tra thẳng
        # ``get_object_or_404(Workflow, pk=...)``: đọc thì đã chặn đúng, nhưng THÊM
        # trigger/step thì không — tài khoản công ty khác POST vào
        # /api/workflows/<id-của-mình>/steps/ là nhét được bước vào workflow của mình,
        # và bước đó sẽ chạy thật.
        workflow = get_object_or_404(
            owned_or_shared(Workflow.objects.all(), self.request.user), pk=workflow_id)
        serializer.save(workflow=workflow)


class WorkflowRunViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only access to WorkflowRun records (with status update support)."""

    serializer_class = WorkflowRunSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return WorkflowRun.objects.none()
        workflow_id = self.kwargs.get('workflow_pk')
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        qs = WorkflowRun.objects.select_related('workflow', 'trigger').filter(
            workflow_id=workflow_id
        )
        return qs.filter(workflow__owner=user) | qs.filter(workflow__team_id__in=team_ids)

    @action(detail=True, methods=['post'])
    def cancel(self, request, **kwargs):
        run = self.get_object()
        if run.status not in (RunStatus.PENDING, RunStatus.RUNNING):
            return Response(
                {'detail': 'Only pending or running runs can be cancelled.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        run.status = RunStatus.CANCELLED
        run.finished_at = timezone.now()
        run.save(update_fields=['status', 'finished_at', 'updated_at'])
        return Response(WorkflowRunSerializer(run).data)


class WebhookTriggerReceiveView(viewsets.ViewSet):
    """
    Public endpoint that receives incoming webhook calls and creates WorkflowRuns.

    POST /api/workflows/webhook/<token>/
    """

    permission_classes = [permissions.AllowAny]

    def create(self, request, token=None):
        try:
            trigger = WorkflowTrigger.objects.select_related('workflow').get(
                webhook_token=token,
                trigger_type='webhook',
                is_active=True,
            )
        except WorkflowTrigger.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        # Verify optional secret via X-Webhook-Secret header.
        if trigger.webhook_secret:
            provided = request.headers.get('X-Webhook-Secret', '')
            if not hmac.compare_digest(trigger.webhook_secret, provided):
                return Response({'detail': 'Invalid webhook secret.'}, status=status.HTTP_403_FORBIDDEN)

        payload = request.data if isinstance(request.data, dict) else {}

        run = WorkflowRun.objects.create(
            workflow=trigger.workflow,
            trigger=trigger,
            triggered_by=TriggeredBy.WEBHOOK,
            status=RunStatus.PENDING,
            trigger_payload=payload,
        )

        trigger.last_triggered_at = timezone.now()
        trigger.save(update_fields=['last_triggered_at', 'updated_at'])

        logger.info('WorkflowRun #%s created via webhook trigger %s', run.run_number, trigger.id)
        return Response(WorkflowRunSerializer(run).data, status=status.HTTP_201_CREATED)
