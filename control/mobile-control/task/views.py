from django.core.paginator import InvalidPage
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
import logging
from django.utils import timezone
from mbcontrol.events import EventSourceType, SystemEvent, dispatch_event
from mbcontrol.mixins import OwnedResourceMixin
from mbcontrol.kafka_utils import send_task_execution_message, send_stop_task_message
from tiktok.execution import handle_task_status_update
from .executor import execute_system_task
from .models import Task, TaskKind, TaskStatus
from .serializers import TaskSerializer

logger = logging.getLogger(__name__)


class TaskPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 100

    def paginate_queryset(self, queryset, request, view=None):
        self.request = request
        page_size = self.get_page_size(request)
        if not page_size:
            return None

        paginator = self.django_paginator_class(queryset, page_size)
        page_number = request.query_params.get(self.page_query_param, 1)

        if page_number in self.last_page_strings:
            page_number = paginator.num_pages or 1
        else:
            try:
                page_number = int(page_number)
            except (TypeError, ValueError):
                page_number = 1

        if page_number < 1:
            page_number = 1
        if paginator.num_pages and page_number > paginator.num_pages:
            page_number = paginator.num_pages

        try:
            self.page = paginator.page(page_number)
        except InvalidPage:
            self.page = paginator.page(1)
        return list(self.page)


class TaskViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Task.objects.select_related('owner', 'team', 'device').prefetch_related('steps').all()
    serializer_class = TaskSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = TaskPagination
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'description', 'device_serial']
    ordering_fields = ['created_at', 'updated_at', 'name', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = super().get_queryset().select_related('owner', 'team', 'device').prefetch_related('steps').distinct()
        status_param = self.request.query_params.get('status')
        if status_param and status_param != 'all':
            if ',' in status_param:
                qs = qs.filter(status__in=status_param.split(','))
            else:
                qs = qs.filter(status=status_param)
        elif self.action == 'list':
            qs = qs.exclude(status=TaskStatus.PENDING_APPROVAL)
        return qs

    def perform_create(self, serializer):
        task = serializer.save(owner=self.request.user)
        payload = {
            'task_id': task.id,
            'status': task.status,
            'name': task.name,
        }
        if task.device_id:
            dispatch_event(SystemEvent.TASK_CREATED, EventSourceType.DEVICE, task.device_id, payload)
        if task.team_id:
            dispatch_event(SystemEvent.TASK_CREATED, EventSourceType.TEAM, task.team_id, payload)
        if task.owner_id:
            dispatch_event(SystemEvent.TASK_CREATED, EventSourceType.USER, task.owner_id, payload)

    def perform_update(self, serializer):
        old_status = serializer.instance.status
        task = serializer.save()
        try:
            handle_task_status_update(task, old_status=old_status, new_status=task.status)
        except Exception:
            logger.exception('Failed to process TikTok comment cluster status update for task %s', task.id)
        try:
            from facebook.views import handle_fb_profile_post_task_status
            handle_fb_profile_post_task_status(task, old_status=old_status, new_status=task.status)
        except Exception:
            logger.exception('Failed to process FB profile post task status update for task %s', task.id)
        try:
            from facebook.views import handle_fb_group_post_task_status
            handle_fb_group_post_task_status(task, old_status=old_status, new_status=task.status)
        except Exception:
            logger.exception('Failed to process FB group post task status update for task %s', task.id)
        try:
            from facebook.views import handle_fb_scheduled_comment_task_status
            handle_fb_scheduled_comment_task_status(task, old_status=old_status, new_status=task.status)
        except Exception:
            logger.exception('Failed to process FB scheduled-comment task status update for task %s', task.id)
        if old_status != TaskStatus.COMPLETED and task.status == TaskStatus.COMPLETED:
            payload = {
                'task_id': task.id,
                'status': task.status,
                'name': task.name,
            }
            if task.device_id:
                dispatch_event(SystemEvent.TASK_DONE, EventSourceType.DEVICE, task.device_id, payload)
            if task.team_id:
                dispatch_event(SystemEvent.TASK_DONE, EventSourceType.TEAM, task.team_id, payload)
            if task.owner_id:
                dispatch_event(SystemEvent.TASK_DONE, EventSourceType.USER, task.owner_id, payload)

    @staticmethod
    def _resolve_profile_id(task: Task, request_profile_id):
        if request_profile_id is not None:
            return request_profile_id

        payload = task.payload if isinstance(task.payload, dict) else {}
        payload_profile_id = payload.get('profile_id')
        if payload_profile_id is None:
            return None

        try:
            return int(payload_profile_id)
        except (TypeError, ValueError):
            logger.warning('Task %s: invalid payload profile_id=%r', task.id, payload_profile_id)
            return None

    @staticmethod
    def _sync_related_schedule_for_manual_run(task: Task, profile_id: int | None):
        from schedule.models import Schedule, ScheduleStatus, ScheduleType

        schedules = Schedule.objects.filter(task=task)
        if profile_id is not None:
            schedules = schedules.filter(profile_id=profile_id)

        schedule = (
            schedules
            .filter(
                schedule_type=ScheduleType.ONCE,
                status=ScheduleStatus.ACTIVE,
                is_active=True,
            )
            .order_by('-created_at')
            .first()
        )
        if not schedule:
            return

        now = timezone.now()
        schedule.last_run_at = now
        update_fields = ['last_run_at', 'updated_at']

        if schedule.schedule_type == ScheduleType.ONCE:
            schedule.run_at = now
            schedule.next_run_at = None
            schedule.retry_count = 0
            schedule.status = ScheduleStatus.COMPLETED
            schedule.is_active = False
            update_fields.extend(['run_at', 'next_run_at', 'retry_count', 'status', 'is_active'])

        schedule.save(update_fields=update_fields)

    @action(detail=True, methods=['post'])
    def run(self, request, pk=None):
        task = self.get_object()
        devices_id = request.data.get('devices_id', [])
        if not isinstance(devices_id, list):
            return Response(
                {'detail': 'devices_id must be a list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        profile_id = request.data.get('profile_id')
        if profile_id is not None:
            try:
                profile_id = int(profile_id)
            except (TypeError, ValueError):
                return Response(
                    {'detail': 'profile_id must be an integer.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        profile_id = self._resolve_profile_id(task, profile_id)

        # ``devices_id`` là ID DO CLIENT GỬI và được đẩy thẳng xuống Kafka để điện thoại
        # thật chạy tác vụ (xem send_task_execution_message). Không kiểm quyền thì một
        # tài khoản chỉ cần đổi số trong request là ĐIỀU KHIỂN ĐƯỢC ĐIỆN THOẠI của tài
        # khoản/công ty khác — nặng hơn rò dữ liệu vì nó thao tác lên máy của người ta.
        # Kiểm TẤT CẢ id chứ không chỉ cái đầu: mọi id đều được gửi xuống Kafka.
        if devices_id:
            from devices.models import Device
            from mbcontrol.mixins import owned_or_shared
            allowed = set(
                owned_or_shared(Device.objects.all(), request.user)
                .filter(id__in=[d for d in devices_id if isinstance(d, int)])
                .values_list('id', flat=True)
            )
            denied = [d for d in devices_id if d not in allowed]
            if denied:
                # Không nói rõ "không tồn tại" hay "không phải của bạn" — phân biệt là
                # xác nhận cho người ngoài biết ID đó có thật.
                return Response(
                    {'detail': f'Không dùng được thiết bị: {denied}. '
                               'Chỉ chạy được trên thiết bị của bạn hoặc được chia sẻ cho team bạn.'},
                    status=status.HTTP_403_FORBIDDEN,
                )

        if not devices_id and task.device_id:
            # Thiết bị của chính task (do server gán), không phải ID client gửi.
            devices_id = [task.device_id]

        # Associate the first device with the task so we can send stop commands later.
        if devices_id:
            from devices.models import Device
            device_obj = Device.objects.filter(id=devices_id[0]).first()
            if device_obj:
                task.device = device_obj
                task.device_serial = device_obj.device_serial_id or ''

        # FB device tasks: if the target device is mid-task, QUEUE this re-run
        # instead of flooding it — the scheduler drain poll sends it when free.
        # (tiktok/system tasks keep their original immediate behaviour.)
        from task.device_lock import device_is_busy
        target_dev = devices_id[0] if devices_id else None
        if (
            task.task_kind != TaskKind.SYSTEM
            and (task.payload or {}).get('agent') == 'facebook'
            and target_dev
            and device_is_busy(target_dev, exclude_task_id=task.id)
        ):
            task.status = TaskStatus.QUEUED
            task.save(update_fields=['status', 'device', 'device_serial', 'updated_at'])
            self._sync_related_schedule_for_manual_run(task, profile_id)
            return Response(self.get_serializer(task).data)

        task.status = TaskStatus.RUNNING
        task.save(update_fields=['status', 'device', 'device_serial', 'updated_at'])
        self._sync_related_schedule_for_manual_run(task, profile_id)

        if task.task_kind == TaskKind.SYSTEM:
            success = execute_system_task(task, devices_id=devices_id, profile_id=profile_id)
            task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
            task.save(update_fields=['status', 'updated_at'])
        else:
            delivered = send_task_execution_message(task, devices_id=devices_id, profile_id=profile_id)
            if not delivered:
                logger.warning('Kafka message not delivered for task %s', task.id)

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def stop(self, request, pk=None):
        task = self.get_object()

        # Queued task isn't on the device yet — just drop it from the queue.
        if task.status == TaskStatus.QUEUED:
            task.status = TaskStatus.CANCELLED
            task.save(update_fields=['status', 'updated_at'])
            return Response(self.get_serializer(task).data)

        if task.status != TaskStatus.RUNNING:
            return Response(
                {'detail': 'Task is not running.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        task.status = TaskStatus.CANCELLED
        task.save(update_fields=['status', 'updated_at'])

        delivered = send_stop_task_message(task)
        if not delivered:
            logger.warning('Kafka stop_task command not delivered for task %s', task.id)

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        from schedule.models import Schedule, ScheduleStatus, ScheduleType
        from datetime import datetime, timezone as dt_timezone

        task = self.get_object()
        if task.status != TaskStatus.PENDING_APPROVAL:
            return Response(
                {'detail': 'Task is not in pending approval status.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        payload = task.payload if isinstance(task.payload, dict) else {}
        
        # Read optional updates from the request payload
        caption = request.data.get('caption')
        hashtags = request.data.get('hashtags')
        profile_id = request.data.get('profile_id')
        scheduled_at = request.data.get('scheduled_at')

        if caption is not None:
            payload['caption'] = str(caption).strip()

        if hashtags is not None:
            import json as _json
            raw_tags = []
            if isinstance(hashtags, list):
                raw_tags = hashtags
            elif isinstance(hashtags, str):
                try:
                    parsed = _json.loads(hashtags)
                    raw_tags = parsed if isinstance(parsed, list) else []
                except (ValueError, TypeError):
                    raw_tags = [h.strip() for h in hashtags.split(',') if h.strip()]
            payload['hashtags'] = [str(h).strip().lstrip('#') for h in raw_tags if str(h).strip()]

        if profile_id is not None:
            payload['profile_id'] = int(profile_id) if profile_id else None

        if scheduled_at is not None:
            payload['scheduled_at'] = str(scheduled_at).strip()

        # Update the task description/goal based on whether caption/hashtags are present
        link_download = payload.get('link_download', '')
        _goal = f'Hãy tải video từ {link_download} và đăng lên TikTok'
        if payload.get('caption') or payload.get('hashtags'):
            _goal += ' kèm caption và hashtag (đã có sẵn trong payload — tool tự đọc).'
        else:
            _goal += '.'

        task.description = _goal
        task.payload = payload
        task.status = TaskStatus.PENDING
        task.save(update_fields=['status', 'payload', 'description', 'updated_at'])

        resolved_profile_id = payload.get('profile_id')
        resolved_scheduled_at = payload.get('scheduled_at')

        run_at = None
        if resolved_scheduled_at:
            try:
                run_at = datetime.fromisoformat(resolved_scheduled_at.replace('Z', '+00:00'))
                if run_at.tzinfo is None:
                    run_at = run_at.replace(tzinfo=dt_timezone.utc)
            except (ValueError, TypeError, AttributeError):
                pass

        if not run_at:
            run_at = timezone.now()

        Schedule.objects.create(
            task=task,
            profile_id=resolved_profile_id,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        task = self.get_object()
        if task.status != TaskStatus.PENDING_APPROVAL:
            return Response(
                {'detail': 'Task is not in pending approval status.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        task.status = TaskStatus.CANCELLED
        task.save(update_fields=['status', 'updated_at'])

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def update_schedule_time(self, request, pk=None):
        from schedule.models import Schedule
        from datetime import datetime, timezone as dt_timezone

        task = self.get_object()
        scheduled_at = request.data.get('scheduled_at')
        if not scheduled_at:
            return Response(
                {'detail': 'scheduled_at is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            run_at = datetime.fromisoformat(scheduled_at.replace('Z', '+00:00'))
            if run_at.tzinfo is None:
                run_at = run_at.replace(tzinfo=dt_timezone.utc)
        except (ValueError, TypeError, AttributeError):
            return Response(
                {'detail': 'Invalid datetime format.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        payload = task.payload if isinstance(task.payload, dict) else {}
        payload['scheduled_at'] = scheduled_at
        task.payload = payload
        task.save(update_fields=['payload', 'updated_at'])

        Schedule.objects.filter(task=task).update(
            run_at=run_at,
            next_run_at=run_at,
            updated_at=timezone.now()
        )

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def update_profile(self, request, pk=None):
        from schedule.models import Schedule

        task = self.get_object()
        profile_id = request.data.get('profile_id')

        if profile_id in (None, '', 'null', 'None'):
            profile_id = None
        else:
            try:
                profile_id = int(profile_id)
            except (ValueError, TypeError):
                return Response(
                    {'detail': 'profile_id must be an integer.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        payload = task.payload if isinstance(task.payload, dict) else {}
        payload['profile_id'] = profile_id
        task.payload = payload
        task.save(update_fields=['payload', 'updated_at'])

        Schedule.objects.filter(task=task).update(
            profile_id=profile_id,
            updated_at=timezone.now()
        )

        serializer = self.get_serializer(task)
        return Response(serializer.data)
