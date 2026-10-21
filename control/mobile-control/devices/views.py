import logging

from django.db import IntegrityError
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from mbcontrol.mixins import OwnedResourceMixin
from mbcontrol.redis_utils import get_connected_devices, get_connected_device_serials, get_device_screen_info
from mbcontrol.kafka_utils import send_message
from teams.models import TeamMembership
from .models import Device, DeviceNotification, DeviceUsageSession
from .serializers import DeviceNotificationSerializer, DeviceSerializer

logger = logging.getLogger(__name__)


class _NotificationPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100

DEVICE_COMMANDS_TOPIC = 'device-commands'


def _apply_redis_screen_info(data: dict, serial: str, key_check) -> None:
    """Populate ``screen_width`` and ``screen_height`` in *data* from Redis.

    Only fills in a field when *key_check(field_name)* returns ``True``, which
    lets callers decide whether to skip fields already present in the payload.
    """
    if not serial:
        return
    screen_info = get_device_screen_info(serial)
    for field in ('screen_width', 'screen_height'):
        value = screen_info.get(field)
        if value is not None and key_check(field):
            data[field] = value


class DeviceViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Device.objects.all()
    serializer_class = DeviceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related('usage_sessions', 'profiles')
        # TCS-v2 Sprint 2 (#2): mặc định chỉ trả device active (soft-delete
        # filter ra). Caller cần xem device đã xóa → query ?include_deleted=true.
        # Áp dụng cho list + retrieve + update. Action `restore` lookup riêng
        # qua Device.objects (KHÔNG đi qua get_queryset filter này).
        include_deleted = self.request.query_params.get('include_deleted') == 'true'
        if not include_deleted:
            qs = qs.filter(is_active=True)
        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # Inject the set of currently connected serials so the serializer can
        # mark each device as `available` (i.e. physically plugged in).
        # Computed once per request, not per row.
        if 'connected_serials' not in ctx:
            ctx['connected_serials'] = set(get_connected_device_serials())
        return ctx

    def create(self, request, *args, **kwargs):
        """
        Upsert device: if a device with the same non-empty identifier or the
        same non-empty device_serial_id already exists, update it instead of
        creating a duplicate record.
        """
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        incoming_identifier = (serializer.validated_data.get('identifier') or '').strip()
        incoming_serial = (serializer.validated_data.get('device_serial_id') or '').strip()

        existing = None
        if incoming_identifier:
            existing = Device.objects.filter(identifier=incoming_identifier).first()
        if existing is None and incoming_serial:
            existing = Device.objects.filter(device_serial_id=incoming_serial).first()

        if existing is not None:
            # Thiết bị là danh tính TOÀN CỤC (identifier/serial), nên bản ghi tìm được có
            # thể thuộc TÀI KHOẢN KHÁC. Bản trước cứ thế ghi đè rồi trả về nguyên bản ghi
            # đó: gửi đúng serial máy của công ty khác là sửa được bản ghi của họ và đọc
            # được thông tin máy. Chặn lại, và KHÔNG tiết lộ nó thuộc về ai.
            if not self._can_access_device(existing, request.user):
                logger.warning(
                    'Device create bị chặn: serial=%r identifier=%r đã thuộc tài khoản khác '
                    '(device id=%s), người gửi=%s',
                    incoming_serial, incoming_identifier, existing.id, request.user.username,
                )
                return Response(
                    {'detail': 'Thiết bị này đã được đăng ký ở một tài khoản khác. '
                               'Liên hệ quản trị để chuyển quyền sở hữu.'},
                    status=status.HTTP_409_CONFLICT,
                )
            # TCS-v2 Sprint 2 (#2): auto-restore nếu device đã soft-delete.
            # User xóa nhầm thì thêm lại = khôi phục → giữ history toàn vẹn.
            if not existing.is_active:
                logger.info(
                    'Auto-restore soft-deleted device id=%s (identifier=%r serial=%r)',
                    existing.id, existing.identifier, existing.device_serial_id,
                )
                existing.is_active = True
                # save() trong update_serializer.save() bên dưới sẽ persist field này.
            # Merge screen info from Redis if not already provided in the request.
            update_data = request.data.copy()
            serial = (incoming_serial or existing.device_serial_id or '').strip()
            _apply_redis_screen_info(update_data, serial, key_check=lambda k: k not in update_data)
            update_serializer = self.get_serializer(
                existing, data=update_data, partial=True
            )
            update_serializer.is_valid(raise_exception=True)
            update_serializer.save()
            return Response(update_serializer.data, status=status.HTTP_200_OK)

        # Populate screen dimensions from Redis for the new device.
        if incoming_serial:
            _apply_redis_screen_info(
                serializer.validated_data,
                incoming_serial,
                key_check=lambda k: not serializer.validated_data.get(k),
            )

        # TCS-v2 Sprint 1 (#17): catch IntegrityError race condition.
        # Upsert path ở trên đã filter existing — nhưng có thể 2 request đồng thời
        # vượt qua filter cùng lúc → DB-level UniqueConstraint
        # (identifier__gt='') raise IntegrityError ở INSERT thứ 2.
        try:
            self.perform_create(serializer)
        except IntegrityError as exc:
            logger.warning(
                'Device create IntegrityError (likely race condition on identifier/serial): %s',
                exc,
            )
            return Response(
                {'detail': 'Thiết bị này đã được thêm trước đó. Vui lòng tải lại trang.'},
                status=status.HTTP_409_CONFLICT,
            )
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    def destroy(self, request, *args, **kwargs):
        """TCS-v2 Sprint 2 (#2): override DELETE để soft-delete (set is_active=False)
        thay vì hard-delete CASCADE. Giữ history TiktokMessage/Task/Notification
        của customer khi user xóa device.
        """
        device = self.get_object()
        device.soft_delete()
        logger.info(
            'Soft-deleted device id=%s identifier=%r serial=%r by user=%s',
            device.id, device.identifier, device.device_serial_id, request.user.username,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        """TCS-v2 Sprint 2 (#2): khôi phục device đã soft-delete. Lookup qua
        Device.objects (bypass get_queryset filter is_active=True) để tìm row
        deleted.
        """
        device = Device.objects.filter(pk=pk).first()
        if device is None:
            return Response({'detail': 'Device not found.'}, status=status.HTTP_404_NOT_FOUND)
        if not self._can_access_device(device, request.user):
            return Response(
                {'detail': 'You do not have access to this device.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        device.restore()
        logger.info(
            'Restored device id=%s identifier=%r serial=%r by user=%s',
            device.id, device.identifier, device.device_serial_id, request.user.username,
        )
        serializer = self.get_serializer(device)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='connected')
    def connected(self, request):
        """
        Return the list of device serials that are currently plugged in
        (as reported by the devices_worker via Redis), including their
        identifier when available.
        """
        devices = get_connected_devices()
        return Response({'devices': devices})

    def _can_access_device(self, device, user):
        """Return True if user is the owner or a member of the shared team."""
        if device.owner == user:
            return True
        if device.team_id is not None:
            return TeamMembership.objects.filter(team_id=device.team_id, user=user).exists()
        return False

    @action(detail=True, methods=['post'])
    def claim(self, request, pk=None):
        """Claim a device for exclusive use. Fails if someone else already holds it."""
        device = self.get_object()
        user = request.user

        if not self._can_access_device(device, user):
            return Response(
                {'detail': 'You do not have access to this device.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        active = DeviceUsageSession.objects.filter(device=device, released_at__isnull=True).first()
        if active is not None:
            if active.user == user:
                # Already claimed by the same user – idempotent
                serializer = self.get_serializer(device)
                return Response(serializer.data)
            return Response(
                {'detail': 'Device is currently in use by another user.'},
                status=status.HTTP_409_CONFLICT,
            )

        DeviceUsageSession.objects.create(device=device, user=user)
        serializer = self.get_serializer(device)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def release(self, request, pk=None):
        """Release a device that the current user holds."""
        device = self.get_object()
        user = request.user

        active = DeviceUsageSession.objects.filter(device=device, user=user, released_at__isnull=True).first()
        if active is None:
            return Response(
                {'detail': 'You are not currently using this device.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        active.released_at = timezone.now()
        active.save(update_fields=['released_at'])
        serializer = self.get_serializer(device)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='send_command')
    def send_command(self, request, pk=None):
        """
        Send a device command to the Kafka ``device-commands`` topic.

        Expected request body::

            {"action": "screen_on"}   # or "screen_off", etc.

        The device's ``device_serial_id`` is used as the Kafka message key and
        is also included in the message payload under ``devices_serical``.
        """
        device = self.get_object()
        action_value = request.data.get('action', '')
        if not action_value:
            return Response(
                {'detail': 'action is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serial = device.device_serial_id or ''
        message = {
            'action': action_value,
            'devices_serical': serial,
        }
        ok = send_message(DEVICE_COMMANDS_TOPIC, message, key=serial or None)
        if not ok:
            return Response(
                {'detail': 'Failed to send command to Kafka.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({'success': True, 'action': action_value, 'devices_serical': serial})

    @action(detail=True, methods=['post'])
    def reclaim(self, request, pk=None):
        """Owner force-releases the current session and claims the device back."""
        device = self.get_object()
        user = request.user

        if device.owner != user:
            return Response(
                {'detail': 'Only the device owner can reclaim it.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        now = timezone.now()
        # Release any active sessions held by others
        DeviceUsageSession.objects.filter(device=device, released_at__isnull=True).exclude(user=user).update(
            released_at=now
        )
        # Create a new session for the owner if they don't already hold one
        if not DeviceUsageSession.objects.filter(device=device, user=user, released_at__isnull=True).exists():
            DeviceUsageSession.objects.create(device=device, user=user)

        serializer = self.get_serializer(device)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def notifications(self, request, pk=None):
        """List notifications received from this device, newest first, with pagination."""
        device = self.get_object()
        qs = DeviceNotification.objects.filter(device=device).order_by('-received_at')
        paginator = _NotificationPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        serializer = DeviceNotificationSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)


class DeviceNotificationViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only viewset for device notifications.

    Supports filtering by ``identifier`` query param:
      GET /api/device-notifications/?identifier=<device-identifier>
    """

    serializer_class = DeviceNotificationSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = _NotificationPagination

    def get_queryset(self):
        qs = DeviceNotification.objects.select_related('device').order_by('-received_at')
        identifier = self.request.query_params.get('identifier')
        if identifier:
            qs = qs.filter(identifier=identifier)
        return qs
