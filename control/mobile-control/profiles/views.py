import hmac
import logging
import uuid

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework import viewsets, parsers, permissions, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from mbcontrol.constants import TeamPermission
from mbcontrol.kafka_utils import (
    send_install_app_command,
    send_uninstall_app_command,
)
from mbcontrol.mixins import OwnedResourceMixin
from mobile_apps.models import MobileApp
from teams.models import TeamMembership
from .models import (
    Profile,
    ProfileFile,
    ProfileMemory,
    ProfileRoutine,
    ProfileAppInstallation,
    InstallStatus,
    ProfileContentItem,
)
from .serializers import (
    ProfileSerializer, ProfileFileSerializer, ProfileMemorySerializer,
    ProfileRoutineSerializer, ProfileAppInstallationSerializer, ProfileContentItemSerializer,
)
from .utils import generate_profile_topics

logger = logging.getLogger(__name__)


# ───────────────────────────────────────────────────────────────────────────
# Sequential install queue
# ───────────────────────────────────────────────────────────────────────────
def _maybe_dispatch_next_for_device(device_id):
    """Pick the oldest pending/uninstall_pending row for *device_id* and
    transition it to installing/uninstalling + publish the Kafka command.

    Sequential queue rule: only one row may be installing/uninstalling per
    device at any time. Android cannot install two APKs in parallel, so we
    enforce that here on the control plane. If the device is already busy
    the call is a no-op; when the in-flight row finishes (callback from the
    worker) this function is called again to start the next one.

    Safe to register from `transaction.on_commit` — opens its own atomic
    block with row-level locking, and reverts the status if the Kafka
    publish fails so the row stays in the queue for the next dispatch tick.
    """
    if device_id is None:
        return

    with transaction.atomic():
        # Already an install/uninstall in flight on this device → wait.
        busy = (
            ProfileAppInstallation.objects.select_for_update()
            .filter(
                device_id=device_id,
                status__in=[InstallStatus.INSTALLING, InstallStatus.UNINSTALLING],
            )
            .exists()
        )
        if busy:
            return

        # Oldest queued operation goes next (FIFO within the device).
        next_inst = (
            ProfileAppInstallation.objects.select_for_update()
            .filter(
                device_id=device_id,
                status__in=[InstallStatus.PENDING, InstallStatus.UNINSTALL_PENDING],
            )
            .select_related('app', 'device')
            .order_by('created_at')
            .first()
        )
        if next_inst is None:
            return

        is_install = next_inst.status == InstallStatus.PENDING
        new_status = InstallStatus.INSTALLING if is_install else InstallStatus.UNINSTALLING
        next_inst.status = new_status
        next_inst.save(update_fields=['status', 'updated_at'])

    # Publish AFTER committing the status change so the worker never sees a
    # "ghost" command (Kafka delivered) without a matching DB row state.
    sender = send_install_app_command if is_install else send_uninstall_app_command
    if not sender(next_inst):
        revert_to = InstallStatus.PENDING if is_install else InstallStatus.UNINSTALL_PENDING
        # conditional update — do not clobber if another thread already moved on
        ProfileAppInstallation.objects.filter(id=next_inst.id, status=new_status).update(
            status=revert_to,
        )
        logger.error(
            'Failed to publish %s for installation %s — reverted to %s',
            'install_app' if is_install else 'uninstall_app',
            next_inst.id, revert_to,
        )


class ProfileViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Profile.objects.prefetch_related('apps', 'credentials', 'files', 'routines', 'content_items').select_related('device').all()
    serializer_class = ProfileSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    # ── App installation ────────────────────────────────────────────────────────

    def _user_can_edit_profile(self, profile, user):
        """Return True when *user* has EDIT-level access to *profile*.

        Control-plane rule: control actions (installing/uninstalling apps on a
        real device) require EDIT. A VIEW-only team share must never trigger
        them. EDIT = the owner, or a member of the team the profile is shared
        to *with* `edit` permission.
        """
        if profile.owner_id == user.id:
            return True
        if profile.team_id is not None and profile.team_permission == TeamPermission.EDIT:
            return TeamMembership.objects.filter(team_id=profile.team_id, user=user).exists()
        return False

    @action(detail=True, methods=['get'], url_path='installations')
    def installations(self, request, pk=None):
        """List the app install/uninstall status records for this profile."""
        profile = self.get_object()
        qs = profile.app_installations.select_related('app', 'device').all()
        serializer = ProfileAppInstallationSerializer(qs, many=True, context={'request': request})
        return Response(serializer.data)

    def _resolve_accessible_app(self, request, user):
        """Resolve ``app_id`` from the request body into a MobileApp the user
        may use, or return a DRF ``Response`` describing the error.

        Anti-IDOR: the app must be owned by the user or shared via one of their
        teams — knowing another team's app id must not be enough to attach it.
        """
        app_id = request.data.get('app_id')
        try:
            app_id = int(app_id)
        except (TypeError, ValueError):
            return Response(
                {'detail': 'app_id is required and must be an integer.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        app = (
            (MobileApp.objects.filter(owner=user) | MobileApp.objects.filter(team_id__in=team_ids))
            .filter(id=app_id)
            .first()
        )
        if app is None:
            # Do not reveal whether the id exists at all.
            return Response(
                {'detail': 'app_id is invalid or not accessible.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return app

    def _installations_response(self, profile, request):
        """Serialize all installation rows of *profile* into a Response."""
        records = profile.app_installations.select_related('app', 'device').all()
        serializer = ProfileAppInstallationSerializer(
            records, many=True, context={'request': request}
        )
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='install-app')
    def install_app(self, request, pk=None):
        """
        Queue a single app for installation on this profile's device.

        Body: ``{"app_id": <int>}``

        Idempotent: if the app is already pending/installing/installed the call
        is a no-op; if it was previously uninstalled/failed it is re-queued with
        a fresh ``command_id``.

        Records intent only — dispatching the actual install command to the
        device worker over Kafka is a separate, deferred step (see TODO below).
        """
        # OwnedResourceMixin.get_queryset() restricts the queryset to profiles
        # the user owns or shares — so get_object() is IDOR-safe here.
        profile = self.get_object()
        user = request.user

        # Least-privilege: a control action requires EDIT, never VIEW.
        if not self._user_can_edit_profile(profile, user):
            return Response(
                {'detail': 'You do not have edit permission on this profile.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        # A profile with no bound device has nowhere to install apps.
        if profile.device_id is None:
            return Response(
                {'detail': 'Hồ sơ chưa gắn thiết bị.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        app = self._resolve_accessible_app(request, user)
        if isinstance(app, Response):
            return app

        with transaction.atomic():
            # unique_together (profile, app) makes get_or_create the safe way to
            # handle a duplicated request; select_for_update locks an existing
            # row so a concurrent install/uninstall cannot interleave.
            inst, created = (
                ProfileAppInstallation.objects.select_for_update()
                .get_or_create(
                    profile=profile,
                    app=app,
                    defaults={
                        'device': profile.device,
                        'status': InstallStatus.PENDING,
                        'requested_by': user,
                    },
                )
            )
            if not created and inst.status not in ProfileAppInstallation.ACTIVE_STATUSES:
                # Previously uninstalled/failed → re-queue. A fresh command_id
                # ensures the worker does not idempotently skip it as a dup.
                inst.status = InstallStatus.PENDING
                inst.device = profile.device
                inst.command_id = uuid.uuid4()
                inst.error_message = ''
                inst.requested_by = user
                inst.save(update_fields=[
                    'status', 'device', 'command_id', 'error_message',
                    'requested_by', 'updated_at',
                ])
            # else: already pending/installing/installed → idempotent no-op.

            # Keep the Profile.apps M2M in sync as the "desired set".
            profile.apps.add(app)

            # Dispatch fires AFTER the row is committed. The dispatcher itself
            # is the single point of enforcement for the sequential queue —
            # if the device is already busy this is a no-op and the row stays
            # pending until the in-flight install finishes.
            device_id = profile.device_id
            transaction.on_commit(lambda: _maybe_dispatch_next_for_device(device_id))

        return self._installations_response(profile, request)

    @action(detail=True, methods=['post'], url_path='uninstall-app')
    def uninstall_app(self, request, pk=None):
        """
        Remove a single app from this profile's device.

        Body: ``{"app_id": <int>}``

        Behaviour depends on the app's current state:
          - ``installed`` / ``installing`` -> set to ``uninstall_pending``
            (a real uninstall command will be dispatched later)
          - ``pending`` (still only queued) -> the row is deleted: the app was
            never installed, so it is simply cancelled out of the queue
          - any other state / no row        -> idempotent no-op
        """
        profile = self.get_object()
        user = request.user

        if not self._user_can_edit_profile(profile, user):
            return Response(
                {'detail': 'You do not have edit permission on this profile.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        app = self._resolve_accessible_app(request, user)
        if isinstance(app, Response):
            return app

        with transaction.atomic():
            inst = (
                ProfileAppInstallation.objects.select_for_update()
                .filter(profile=profile, app=app)
                .first()
            )
            if inst is not None:
                if inst.status == InstallStatus.PENDING:
                    # Never installed — just cancel it out of the queue.
                    inst.delete()
                elif inst.status in (InstallStatus.INSTALLING, InstallStatus.INSTALLED):
                    inst.status = InstallStatus.UNINSTALL_PENDING
                    inst.device = profile.device
                    inst.command_id = uuid.uuid4()
                    inst.error_message = ''
                    inst.requested_by = user
                    inst.save(update_fields=[
                        'status', 'device', 'command_id', 'error_message',
                        'requested_by', 'updated_at',
                    ])
                # else: already in a removal/failed state → idempotent no-op.

            # Keep the Profile.apps M2M in sync.
            profile.apps.remove(app)

            # Dispatching after commit: if the just-flipped row is the next in
            # line for an idle device, the worker is sent the uninstall_app
            # command; if the row was a `pending` we just deleted (cancel),
            # the dispatcher will simply pick up the new "next" item.
            device_id = profile.device_id
            transaction.on_commit(lambda: _maybe_dispatch_next_for_device(device_id))

        return self._installations_response(profile, request)

    @action(detail=True, methods=['post'], parser_classes=[parsers.MultiPartParser, parsers.FormParser])
    def upload_file(self, request, pk=None):
        profile = self.get_object()
        file_obj = request.FILES.get('file')
        name = request.data.get('name', '')
        if not file_obj:
            return Response({'detail': 'No file provided.'}, status=400)
        pf = ProfileFile.objects.create(profile=profile, file=file_obj, name=name or file_obj.name)
        serializer = ProfileFileSerializer(pf, context={'request': request})
        return Response(serializer.data, status=201)

    @action(detail=True, methods=['delete'], url_path='files/(?P<file_id>[0-9]+)')
    def delete_file(self, request, pk=None, file_id=None):
        profile = self.get_object()
        try:
            pf = ProfileFile.objects.get(id=file_id, profile=profile)
        except ProfileFile.DoesNotExist:
            return Response({'detail': 'File not found.'}, status=404)
        pf.file.delete(save=False)
        pf.delete()
        return Response(status=204)

    # ── Memory ─────────────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='memory')
    def memory_list(self, request, pk=None):
        profile = self.get_object()
        if request.method == 'GET':
            items = ProfileMemory.objects.filter(profile=profile)
            return Response(ProfileMemorySerializer(items, many=True).data)
        serializer = ProfileMemorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = serializer.validated_data['key']
        obj, _ = ProfileMemory.objects.update_or_create(
            profile=profile, key=key,
            defaults={
                'value': serializer.validated_data.get('value', ''),
                'tags': serializer.validated_data.get('tags', []),
            },
        )
        # Always return 201 for upsert — client treats set as create-or-update
        return Response(ProfileMemorySerializer(obj).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'memory/(?P<memory_id>\d+)')
    def memory_detail(self, request, pk=None, memory_id=None):
        profile = self.get_object()
        try:
            obj = ProfileMemory.objects.get(id=memory_id, profile=profile)
        except ProfileMemory.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Content items (profile-scoped warehouse) ──────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='content-items')
    def content_items(self, request, pk=None):
        profile = self.get_object()
        if request.method == 'GET':
            items = ProfileContentItem.objects.filter(profile=profile, owner=request.user)
            return Response(ProfileContentItemSerializer(items, many=True).data)

        serializer = ProfileContentItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        tags = list(serializer.validated_data.get('tags') or [])
        topic = (profile.topic or '').strip()
        if topic and topic not in tags:
            tags.append(topic)
        obj = ProfileContentItem.objects.create(
            profile=profile,
            owner=request.user,
            title=serializer.validated_data.get('title', ''),
            source_url=serializer.validated_data.get('source_url', ''),
            video_url=serializer.validated_data.get('video_url', ''),
            description=serializer.validated_data.get('description', ''),
            tags=tags,
            metadata=serializer.validated_data.get('metadata', {}),
        )
        return Response(ProfileContentItemSerializer(obj).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'content-items/(?P<content_item_id>\d+)')
    def content_item_detail(self, request, pk=None, content_item_id=None):
        profile = self.get_object()
        try:
            obj = ProfileContentItem.objects.get(id=content_item_id, profile=profile, owner=request.user)
        except ProfileContentItem.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Routine ────────────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='routines')
    def routine_list(self, request, pk=None):
        profile = self.get_object()
        if request.method == 'GET':
            items = ProfileRoutine.objects.filter(profile=profile)
            return Response(ProfileRoutineSerializer(items, many=True).data)

        serializer = ProfileRoutineSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        obj = ProfileRoutine.objects.create(profile=profile, **serializer.validated_data)
        return Response(ProfileRoutineSerializer(obj).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'routines/(?P<routine_id>\d+)')
    def routine_detail(self, request, pk=None, routine_id=None):
        profile = self.get_object()
        try:
            obj = ProfileRoutine.objects.get(id=routine_id, profile=profile)
        except ProfileRoutine.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Schedule ────────────────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='add_schedule')
    def add_schedule(self, request, pk=None):
        """
        Add a schedule for this profile.

        Required body fields:
          - task_id (int): the Task to schedule.
          - auto_schedule (bool): if true, use OpenAI + ProfileRoutine data to
            determine the best schedule parameters automatically.

        When auto_schedule is false the remaining schedule fields must be
        supplied explicitly:
          - schedule_type: 'once' | 'interval' | 'cron'
          - run_at (datetime, required for 'once')
          - interval_seconds (int, required for 'interval')
          - cron_expression (str, required for 'cron')
          - max_retries, retry_delay_seconds (optional)
        """
        from task.models import Task
        from schedule.models import Schedule
        from schedule.serializers import ScheduleSerializer

        profile = self.get_object()

        task_id = request.data.get('task_id')
        if not task_id:
            return Response({'detail': 'task_id is required.'}, status=status.HTTP_400_BAD_REQUEST)

        # ``task_id`` do client gửi → phải lọc theo chủ sở hữu. Bản trước tra thẳng
        # ``Task.objects.get(pk=...)`` nên tài khoản này lên lịch được TÁC VỤ CỦA TÀI
        # KHOẢN KHÁC (kèm nội dung/thông tin đăng nhập trong payload của tác vụ đó).
        from mbcontrol.mixins import owned_or_shared
        task = owned_or_shared(Task.objects.all(), request.user).filter(pk=task_id).first()
        if task is None:
            return Response(
                {'detail': 'Task not found.'},  # không phân biệt "không có" với "không phải của bạn"
                status=status.HTTP_404_NOT_FOUND,
            )

        auto_schedule = request.data.get('auto_schedule', False)
        if isinstance(auto_schedule, str):
            auto_schedule = auto_schedule.lower() in ('true', '1', 'yes')

        if auto_schedule:
            schedule_params = self._auto_schedule_params(profile)
            if schedule_params is None:
                return Response(
                    {'detail': 'OpenAI API key is not configured on the server.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if isinstance(schedule_params, Response):
                return schedule_params
        else:
            schedule_params = {
                k: v for k, v in request.data.items()
                if k not in ('task_id', 'auto_schedule', 'profile')
            }

        schedule_params['task'] = task.pk
        schedule_params['profile'] = profile.pk

        serializer = ScheduleSerializer(data=schedule_params)
        serializer.is_valid(raise_exception=True)
        schedule = serializer.save()

        from schedule.serializers import ScheduleReadSerializer
        return Response(ScheduleReadSerializer(schedule).data, status=status.HTTP_201_CREATED)

    # ── Helpers ─────────────────────────────────────────────────────────────────

    def _auto_schedule_params(self, profile):
        """
        Fetch all ProfileRoutine entries for the profile, send them to OpenAI,
        and return a dict of schedule parameters suitable for ScheduleSerializer.

        Returns:
            None      – if the OpenAI API key is not configured.
            dict      – schedule params on success.
            Response  – 502 if the OpenAI call or JSON parsing fails.
        """
        from .utils import get_auto_schedule_params

        try:
            return get_auto_schedule_params(profile)
        except RuntimeError:
            return Response(
                {'detail': 'Failed to generate schedule parameters via OpenAI.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

    @action(detail=True, methods=['post'], url_path='generate-topics')
    def generate_topics(self, request, pk=None):
        profile = self.get_object()
        count = request.data.get('count', 5)
        try:
            count = max(1, min(int(count), 10))
        except (TypeError, ValueError):
            return Response({'detail': 'count must be an integer.'}, status=status.HTTP_400_BAD_REQUEST)

        existing_topics = request.data.get('existing_topics')
        if existing_topics is None:
            existing_topics = list(profile.topics or [])
        if not isinstance(existing_topics, list):
            return Response({'detail': 'existing_topics must be a list.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            generated_topics = generate_profile_topics(profile, existing_topics=existing_topics, count=count)
        except RuntimeError:
            return Response(
                {'detail': 'Failed to generate topics via OpenAI.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        if generated_topics is None:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        audit_logs = list(profile.topic_audit_logs or [])
        audit_logs.append({
            'action': 'generate_topics',
            'actor_id': request.user.id,
            'generated_topics': generated_topics,
            'created_at': timezone.now().isoformat(),
        })
        profile.topic_audit_logs = audit_logs
        profile.save(update_fields=['topic_audit_logs', 'updated_at'])

        return Response({'topics': generated_topics}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='topic-actions')
    def topic_actions(self, request, pk=None):
        profile = self.get_object()
        action_name = str(request.data.get('action') or '').strip()
        if not action_name:
            return Response({'detail': 'action is required.'}, status=status.HTTP_400_BAD_REQUEST)

        topic = request.data.get('topic')
        topics = request.data.get('topics')
        metadata = request.data.get('metadata')
        payload = {
            'action': action_name,
            'actor_id': request.user.id,
            'created_at': timezone.now().isoformat(),
        }
        if topic is not None:
            payload['topic'] = str(topic).strip()
        applied_topics = None
        if isinstance(topics, list):
            applied_topics = [str(item).strip() for item in topics if str(item).strip()]
            payload['topics'] = applied_topics
        if isinstance(metadata, dict):
            payload['metadata'] = metadata

        update_fields = ['topic_audit_logs', 'updated_at']
        if action_name == 'apply_generated_topics' and applied_topics is not None:
            existing_topics = [str(item).strip() for item in (profile.topics or []) if str(item).strip()]
            merged_topics = list(dict.fromkeys([*existing_topics, *applied_topics]))
            profile.topics = merged_topics
            profile.topic = merged_topics[0] if merged_topics else ''
            update_fields.extend(['topics', 'topic'])

        audit_logs = list(profile.topic_audit_logs or [])
        audit_logs.append(payload)
        profile.topic_audit_logs = audit_logs
        profile.save(update_fields=update_fields)
        return Response(payload, status=status.HTTP_201_CREATED)


# ───────────────────────────────────────────────────────────────────────────
# Worker → Control callback
# ───────────────────────────────────────────────────────────────────────────
# Status values the worker is allowed to report.
_WORKER_STATUSES = {
    InstallStatus.INSTALLING,
    InstallStatus.INSTALLED,
    InstallStatus.UNINSTALLING,
    InstallStatus.UNINSTALLED,
    InstallStatus.FAILED,
}
# Terminal statuses — after these, the device is free and the dispatcher
# should pick the next queued operation.
_TERMINAL_STATUSES = {
    InstallStatus.INSTALLED,
    InstallStatus.UNINSTALLED,
    InstallStatus.FAILED,
}


@api_view(['POST'])
@permission_classes([permissions.AllowAny])
def worker_app_installation_callback(request, installation_id: int):
    """
    Worker → Control callback for app install/uninstall progress and results.

    POST /api/internal/app-installations/<id>/status/
    Header:  X-Worker-Token: <shared secret>
    Body:    {
                "status": "installing" | "installed" |
                          "uninstalling" | "uninstalled" | "failed",
                "command_id": "<uuid that the control plane originally sent>",
                "error_message": "<optional, for status='failed'>"
             }

    Security:
      - Shared-secret token (constant-time comparison).
      - ``command_id`` MUST match the installation's current command_id;
        callbacks for stale (superseded) commands are ignored — this stops
        a late "installed" from a previous request overwriting a fresh
        "uninstall_pending" the user just requested.

    Behaviour:
      - Updates the ProfileAppInstallation row.
      - On a terminal status, schedules ``_maybe_dispatch_next_for_device``
        to start the next queued operation.
    """
    # ── Auth: shared-secret token ────────────────────────────────────────────
    expected = getattr(settings, 'WORKER_CALLBACK_TOKEN', '') or ''
    presented = request.META.get('HTTP_X_WORKER_TOKEN', '') or ''
    if not expected or not hmac.compare_digest(expected, presented):
        # Do not leak whether the token is missing vs wrong.
        return Response({'detail': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)

    # ── Validate body ────────────────────────────────────────────────────────
    new_status = request.data.get('status')
    command_id = request.data.get('command_id')
    error_message = request.data.get('error_message', '') or ''
    if new_status not in _WORKER_STATUSES:
        return Response(
            {'detail': 'Invalid or missing status.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if not command_id:
        return Response(
            {'detail': 'command_id is required.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    # error_message is a free-form string — clamp length so a misbehaving
    # worker cannot fill the DB.
    if isinstance(error_message, str) and len(error_message) > 2000:
        error_message = error_message[:2000]

    # ── Apply update atomically + idempotency check on command_id ────────────
    device_id_to_redispatch = None
    with transaction.atomic():
        try:
            inst = (
                ProfileAppInstallation.objects.select_for_update()
                .get(id=installation_id)
            )
        except ProfileAppInstallation.DoesNotExist:
            return Response(
                {'detail': 'Installation not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        if str(inst.command_id) != str(command_id):
            # Late callback for a superseded command — accept the request so the
            # worker stops retrying, but do not touch the row state.
            logger.info(
                'Stale callback for installation %s ignored (got command_id=%s, current=%s)',
                inst.id, command_id, inst.command_id,
            )
            return Response(
                {'ignored': True, 'reason': 'stale_command_id'},
                status=status.HTTP_200_OK,
            )

        inst.status = new_status
        inst.error_message = error_message if new_status == InstallStatus.FAILED else ''
        inst.save(update_fields=['status', 'error_message', 'updated_at'])

        if new_status in _TERMINAL_STATUSES:
            device_id_to_redispatch = inst.device_id

    # ── Kick off the next queued operation, if any ───────────────────────────
    if device_id_to_redispatch is not None:
        _maybe_dispatch_next_for_device(device_id_to_redispatch)

    return Response({'ok': True, 'installation_id': installation_id, 'status': new_status})
