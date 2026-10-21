from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event
from mbcontrol.mixins import OwnedResourceMixin

from task.models import Task
from .models import Schedule, ScheduleStatus
from .serializers import (
    TaskSerializer,
    ScheduleSerializer,
    ScheduleReadSerializer,
    ScheduleExecutionSerializer,
)
from .scheduler import _compute_next_run


class TaskViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Task.objects.all()
    serializer_class = TaskSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class ScheduleViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Schedule.objects.select_related('task', 'profile').all()
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        schedule = serializer.save()
        payload = {
            'schedule_id': schedule.id,
            'task_id': schedule.task_id,
            'schedule_type': schedule.schedule_type,
        }
        if schedule.task.device_id:
            dispatch_event(
                SystemEvent.SCHEDULE_CREATED,
                EventSourceType.DEVICE,
                schedule.task.device_id,
                payload,
            )
        if schedule.task.team_id:
            dispatch_event(
                SystemEvent.SCHEDULE_CREATED,
                EventSourceType.TEAM,
                schedule.task.team_id,
                payload,
            )
        if schedule.task.owner_id:
            dispatch_event(
                SystemEvent.SCHEDULE_CREATED,
                EventSourceType.USER,
                schedule.task.owner_id,
                payload,
            )

    def get_queryset(self):
        # Schedules are visible if the underlying task is accessible
        user = self.request.user
        qs = Schedule.objects.select_related('task', 'profile').all()
        if not user.is_authenticated:
            return qs.none()

        profile_id = self.request.query_params.get('profile_id')
        if profile_id is not None:
            try:
                qs = qs.filter(profile_id=int(profile_id))
            except (TypeError, ValueError):
                return qs.none()

        from teams.models import TeamMembership
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        return (
            qs.filter(
            task__owner=user
            ) | qs.filter(
            task__team_id__in=team_ids
        )
        ).distinct()

    def get_serializer_class(self):
        if self.request.method in ('GET',):
            return ScheduleReadSerializer
        return ScheduleSerializer

    @action(detail=True, methods=['post'])
    def pause(self, request, pk=None):
        schedule = self.get_object()
        if schedule.status not in (ScheduleStatus.ACTIVE,):
            return Response(
                {'detail': 'Schedule is not active.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        schedule.status = ScheduleStatus.PAUSED
        schedule.is_active = False
        schedule.save(update_fields=['status', 'is_active', 'updated_at'])
        return Response(ScheduleReadSerializer(schedule).data)

    @action(detail=True, methods=['post'])
    def resume(self, request, pk=None):
        schedule = self.get_object()
        if schedule.status not in (ScheduleStatus.PAUSED,):
            return Response(
                {'detail': 'Schedule is not paused.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        schedule.status = ScheduleStatus.ACTIVE
        schedule.is_active = True
        schedule.next_run_at = _compute_next_run(schedule)
        schedule.save(update_fields=['status', 'is_active', 'next_run_at', 'updated_at'])
        return Response(ScheduleReadSerializer(schedule).data)

    @action(detail=True, methods=['get'])
    def executions(self, request, pk=None):
        schedule = self.get_object()
        execs = schedule.executions.all()
        serializer = ScheduleExecutionSerializer(execs, many=True)
        return Response(serializer.data)
