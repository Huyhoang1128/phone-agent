import logging
import json
import random
import copy
from datetime import time, timedelta, datetime, timezone as dt_timezone
from zoneinfo import ZoneInfo

import requests as http_requests
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils.dateparse import parse_datetime
from django.utils import timezone
from agent_groups.models import AgentGroup
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.response import Response
from rest_framework.views import APIView
from users.authentication import VersionedJWTAuthentication as JWTAuthentication

from api_keys.authentication import ApiKeyAuthentication
from mbcontrol.mixins import OwnedResourceMixin
from profiles.models import Profile
from schedule.models import Schedule, ScheduleType
from task.models import Task, TaskStatus, TaskType
from webhooks.services import ExternalWebhookNotConfiguredError, get_external_webhook_url
from proxies.models import Proxy
from .models import (
    KeywordList,
    TiktokChannel,
    TiktokChannelVideo,
    TiktokCommentPlan,
    TiktokCommentPlanChatMessage,
    TiktokInteractionType,
    TiktokVideo,
    TiktokVideoInteraction,
    TiktokVideoStatus,
    TiktokVideoUserComment,
)
from .serializers import (
    KeywordListSerializer,
    TiktokCommentedInteractionSerializer,
    TiktokCommentPlanChatMessageSerializer,
    TiktokCommentPlanSerializer,
    TiktokVideoInteractionSerializer,
    TiktokVideoSerializer,
    TiktokVideoUserCommentSerializer,
)
from .execution import execute_cluster

logger = logging.getLogger(__name__)
DEFAULT_PLAN_CHAT_MODEL = 'gpt-4o-mini'
DEFAULT_TIKTOK_PLAN_CHAT_ALLOWED_MODELS = {DEFAULT_PLAN_CHAT_MODEL, 'gpt-4.1-mini', 'gpt-4.1'}
DEFAULT_PLAN_CHAT_MAX_TOKENS = 500
MAX_EXISTING_COMMENTS_PREVIEW = 10
N8N_DISPATCH_COMMENTS_WEBHOOK_KEY = 'N8N_DISPATCH_COMMENTS_WEBHOOK_URL'
N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_KEY = 'N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL'
N8N_SEARCH_KEYWORD_WEBHOOK_KEY = 'N8N_SEARCH_KEYWORD_WEBHOOK_URL'
DEFAULT_TIKTOK_VIDEO_SEARCH_TIMEOUT_SECONDS = 300
DEFAULT_TIKTOK_CHANNEL_CRAWL_TIMEOUT_SECONDS = 240
DEFAULT_TIKTOK_COMMENT_TIMEOUT_SECONDS = 180
DIG_COMMENT_MAX_FETCH = 100
TIKTOK_CHANNEL_CACHE_TTL = timedelta(hours=12)
TIKTOK_CHANNEL_VIDEO_TITLE_MAX_LENGTH = TiktokChannelVideo._meta.get_field('title').max_length
MAX_UPSTREAM_ERROR_DETAIL_LENGTH = 300

# Backend stores timestamps in UTC but users are in Vietnam (UTC+7) and see
# local dates in the UI. Filtering by `created_at__date__gte/lte` would compare
# against the UTC date, causing rows whose local date crosses the UTC midnight
# (e.g. early-morning Hanoi time = previous day in UTC) to be wrongly included
# or excluded. Convert the user's date string into a local-tz datetime range
# instead.
_LOCAL_TZ = ZoneInfo('Asia/Ho_Chi_Minh')


def _get_random_active_proxy_string() -> str | None:
    active_proxies = list(
        Proxy.objects.filter(status=Proxy.STATUS_ACTIVE)
        .exclude(host='')
        .exclude(port__isnull=True)
        .exclude(username='')
        .exclude(password='')
        .values_list('host', 'port', 'username', 'password')
    )
    if not active_proxies:
        return None

    host, port, username, password = random.choice(active_proxies)
    return f'{host}:{port}:{username}:{password}'


def _post_with_retry_using_proxy(endpoint, payload, timeout, headers=None):
    """POST once without proxy, then retry once with a random active proxy on request failure."""
    first_error = None
    try:
        response = http_requests.post(
            endpoint,
            json=payload,
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()
        return response
    except http_requests.HTTPError as exc:
        status_code = getattr(exc.response, 'status_code', None)
        if status_code is not None and 400 <= status_code < 500:
            raise
        first_error = exc
    except http_requests.RequestException as exc:
        first_error = exc

    proxy_value = _get_random_active_proxy_string()
    if not proxy_value:
        logger.warning('External API retry skipped because no active proxy is available.')
        if first_error is None:
            raise AssertionError('Expected a captured exception before proxy retry.')
        raise first_error

    retry_payload = copy.deepcopy(payload)
    retry_payload['proxy'] = proxy_value
    response = http_requests.post(
        endpoint,
        json=retry_payload,
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()
    return response


def _extract_external_http_error_detail(exc: http_requests.HTTPError, fallback: str) -> tuple[str, int | None]:
    """Extract a user-safe error detail and upstream status code from an HTTPError."""
    if exc.response is None:
        return fallback, None
    status_code = exc.response.status_code

    message = ''
    try:
        body = exc.response.json()
    except ValueError:
        body = None

    if isinstance(body, dict):
        for key in ('detail', 'message', 'error'):
            value = body.get(key)
            if value is None:
                continue
            value_text = str(value).strip()
            if value_text:
                message = value_text
                break
    if not message:
        message = str(exc.response.text or '').strip()

    if not message:
        return fallback, status_code

    if len(message) > MAX_UPSTREAM_ERROR_DETAIL_LENGTH:
        message = f'{message[:MAX_UPSTREAM_ERROR_DETAIL_LENGTH]}...'
    return f'{fallback} Upstream detail: {message}', status_code


def _comment_service_error_response(
    action_name: str,
    exc: Exception,
    fallback_detail: str = 'Failed to call comment fetching service.',
):
    if isinstance(exc, http_requests.exceptions.HTTPError):
        detail, upstream_status = _extract_external_http_error_detail(
            exc,
            fallback_detail,
        )
        if upstream_status == status.HTTP_400_BAD_REQUEST:
            return Response({'detail': detail}, status=status.HTTP_400_BAD_REQUEST)

    logger.exception('%s: external API error: %s', action_name, exc)
    return Response(
        {'detail': f'{fallback_detail} Please try again later.'},
        status=status.HTTP_502_BAD_GATEWAY,
    )


def _name_clusters_with_llm(points: list, api_key: str) -> dict:
    """
    For each cluster, find the 5 comments closest to the centroid, then use
    OpenAI gpt-4o-mini (Responses API) to generate a short descriptive label.
    Returns {cluster_id (int): label (str)}.
    Never raises — returns an empty dict on any failure.
    """
    import math
    from collections import defaultdict

    clusters: dict = defaultdict(list)
    for point in points:
        cluster = point.get('cluster')
        if not isinstance(cluster, int) or cluster < 0:
            continue
        x, y = point.get('x'), point.get('y')
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        clusters[cluster].append(point)

    if not clusters:
        return {}

    try:
        from openai import OpenAI  # noqa: PLC0415
        client = OpenAI(api_key=api_key)
    except Exception:
        return {}

    labels: dict = {}
    for cluster_id, cluster_points in clusters.items():
        cx = sum(p['x'] for p in cluster_points) / len(cluster_points)
        cy = sum(p['y'] for p in cluster_points) / len(cluster_points)

        nearest = sorted(
            cluster_points,
            key=lambda p: math.sqrt((p['x'] - cx) ** 2 + (p['y'] - cy) ** 2),
        )[:5]

        sample_texts = [
            (p.get('normalized_text') or p.get('text') or '').strip()
            for p in nearest
        ]
        sample_texts = [t for t in sample_texts if t]

        if not sample_texts:
            labels[cluster_id] = f'Cụm {cluster_id + 1}'
            continue

        comments_list = '\n'.join(f'- {t}' for t in sample_texts)
        prompt = (
            'Dưới đây là các bình luận đại diện của một nhóm bình luận TikTok:\n'
            f'{comments_list}\n\n'
            'Hãy đặt tên ngắn gọn (3-6 từ tiếng Việt) cho nhóm này, '
            'mô tả chủ đề hoặc cảm xúc chính của nhóm. '
            'Chỉ trả về tên nhóm, không giải thích thêm.'
        )

        try:
            response = client.responses.create(
                model='gpt-4o-mini',
                input=prompt,
            )
            label = (response.output_text or '').strip()
            labels[cluster_id] = label if label else f'Cụm {cluster_id + 1}'
        except Exception as exc:
            logger.warning('_name_clusters_with_llm cluster %d error: %s', cluster_id, exc)
            labels[cluster_id] = f'Cụm {cluster_id + 1}'

    return labels


def _apply_local_date_filter(qs, field_name: str, date_from: str | None, date_to: str | None):
    """Filter `qs` by a local-timezone date range on the given datetime field.

    `date_from`/`date_to` are expected as ``YYYY-MM-DD``. Invalid values are
    silently ignored (matching prior lenient behaviour).
    """
    if date_from:
        try:
            d_from = datetime.strptime(date_from, '%Y-%m-%d').date()
        except ValueError:
            d_from = None
        if d_from is not None:
            start = datetime.combine(d_from, time.min, tzinfo=_LOCAL_TZ)
            qs = qs.filter(**{f'{field_name}__gte': start})
    if date_to:
        try:
            d_to = datetime.strptime(date_to, '%Y-%m-%d').date()
        except ValueError:
            d_to = None
        if d_to is not None:
            end_exclusive = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=_LOCAL_TZ)
            qs = qs.filter(**{f'{field_name}__lt': end_exclusive})
    return qs


def _sync_approved_comment_plan(video: TiktokVideo, interaction: TiktokVideoInteraction, owner):
    if interaction.interaction_type not in {TiktokInteractionType.COMMENT, TiktokInteractionType.REPLY}:
        return

    plan_owner = video.owner or owner
    plan_qs = TiktokCommentPlan.objects.filter(
        video=video,
        owner=plan_owner,
        is_commented=False,
    )

    plan = None
    raw_comment_content = interaction.comment_content or ''
    normalized_comment_content = raw_comment_content.strip()
    if raw_comment_content:
        plan = (
            plan_qs.filter(comment_content=raw_comment_content)
            .order_by('-is_approved', '-created_at')
            .first()
        )
    if not plan and normalized_comment_content:
        plan = (
            plan_qs.filter(comment_content=normalized_comment_content)
            .order_by('-is_approved', '-created_at')
            .first()
        )
        if not plan:
            plan = (
                plan_qs.filter(comment_content__iexact=normalized_comment_content)
                .order_by('-is_approved', '-created_at')
                .first()
            )
        if not plan:
            for candidate in plan_qs.order_by('-is_approved', '-created_at')[:100]:
                if (candidate.comment_content or '').strip() == normalized_comment_content:
                    plan = candidate
                    break

    if not plan:
        plan = plan_qs.order_by('-is_approved', '-created_at').first()
    if not plan:
        return

    plan.is_commented = True
    update_fields = ['is_commented']
    if interaction.comment_link and plan.comment_link != interaction.comment_link:
        plan.comment_link = interaction.comment_link
        update_fields.append('comment_link')
    update_fields.append('updated_at')
    plan.save(update_fields=update_fields)


class TiktokVideoViewSet(viewsets.ModelViewSet):
    serializer_class = TiktokVideoSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content', 'video_url']
    ordering_fields = ['created_at', 'updated_at', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = TiktokVideo.objects.filter(owner=self.request.user)
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @staticmethod
    def _build_tiktok_comment_task_description(video_url: str, comment_content: str) -> str:
        return (
            f'Hãy mở tiktok và bình luận vào video {video_url} với nội dung {comment_content}'
        )

    def _create_schedules_for_approved_comment_plan(self, plan: TiktokCommentPlan, owner) -> int:
        if not plan.device_id:
            return 0

        video_url = plan.video_link or plan.video.video_url or ''
        comment_content = (plan.comment_content or '').strip()
        if not video_url or not comment_content:
            return 0
        device_serial = ''
        if plan.device_id:
            from devices.models import Device
            device_serial = (
                Device.objects.filter(id=plan.device_id)
                .values_list('device_serial_id', flat=True)
                .first() or ''
            )

        count = 0
        profiles = list(Profile.objects.filter(device_id=plan.device_id).order_by('id'))
        if not plan.profile_id and profiles:
            plan.profile_id = profiles[0].id
            plan.save(update_fields=['profile', 'updated_at'])

        for profile in profiles:
            task = Task.objects.create(
                name=f'TikTok comment - {profile.name}',
                description=self._build_tiktok_comment_task_description(video_url, comment_content),
                task_type=TaskType.GENERIC,
                status=TaskStatus.PENDING,
                payload={
                    'agent': 'tiktok',
                    'video_url': video_url,
                    'comment_content': comment_content,
                    'profile_id': profile.id,
                    'device_id': plan.device_id,
                },
                device_id=plan.device_id,
                device_serial=device_serial,
                owner=owner,
            )
            self._create_schedule_for_profile(task, profile)
            count += 1
        return count

    @staticmethod
    def _create_schedule_for_profile(task, profile) -> Schedule:
        """
        Create a ONCE Schedule for *task* + *profile* at a reasonable time.
        Priority:
        1) OpenAI auto-schedule run_at (if valid future datetime)
        2) Next profile routine time
        3) 1 hour from now fallback
        """
        run_at = None
        now = timezone.now()

        try:
            from profiles.utils import get_auto_schedule_params

            auto_params = get_auto_schedule_params(profile)
            if isinstance(auto_params, dict) and auto_params.get('run_at'):
                raw_run_at = auto_params.get('run_at')
                if isinstance(raw_run_at, datetime):
                    parsed = raw_run_at
                else:
                    parsed = parse_datetime(str(raw_run_at))
                if parsed is not None:
                    if timezone.is_naive(parsed):
                        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
                    if parsed > now:
                        run_at = parsed
        except RuntimeError:
            logger.warning(
                'auto_schedule: invalid run_at for ONCE comment schedule task %s / profile %s',
                task.pk, profile.pk,
            )

        if run_at is None:
            from profiles.models import ProfileRoutine

            current_local_time = timezone.localtime(now).time().replace(tzinfo=None)
            next_routine = (
                ProfileRoutine.objects
                .filter(profile=profile, schedule_time__gt=current_local_time)
                .order_by('schedule_time')
                .first()
            )
            run_day_offset = 0
            if next_routine is None:
                next_routine = (
                    ProfileRoutine.objects
                    .filter(profile=profile)
                    .order_by('schedule_time')
                    .first()
                )
                run_day_offset = 1
            if next_routine:
                run_at = timezone.make_aware(
                    datetime.combine(
                        now.date() + timedelta(days=run_day_offset),
                        next_routine.schedule_time,
                    ),
                    timezone.get_current_timezone(),
                )

        if run_at is None:
            run_at = now + timedelta(hours=1)

        return Schedule.objects.create(
            task=task,
            profile=profile,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
        )

    @action(detail=False, methods=['get'], url_path='commented-interactions')
    def commented_interactions(self, request):
        """
        GET /api/tiktok/commented-interactions/ – list comment-type interactions for videos owned
        by the current user, enriched with device/profile/video_link from matching TiktokCommentPlan.

        Join logic:
          - TiktokVideoInteraction (type=comment) joined to TiktokVideo via video FK
          - TiktokCommentPlan matched by video_id and comment_content

        Supports optional filters:
          - date_from (YYYY-MM-DD)
          - date_to   (YYYY-MM-DD)
          - profile_id
          - device_id
        """
        interactions_qs = (
            TiktokVideoInteraction.objects.filter(
                interaction_type=TiktokInteractionType.COMMENT,
                video__owner=request.user,
            )
            .select_related('video')
            .order_by('-created_at')
        )

        date_from = request.query_params.get('date_from')
        date_to = request.query_params.get('date_to')
        profile_id = request.query_params.get('profile_id')
        device_id = request.query_params.get('device_id')

        interactions_qs = _apply_local_date_filter(interactions_qs, 'created_at', date_from, date_to)

        interactions = list(interactions_qs)
        video_ids = {i.video_id for i in interactions}

        # Batch-fetch all relevant comment plans to avoid N+1 queries
        plans_qs = (
            TiktokCommentPlan.objects.filter(video_id__in=video_ids)
            .select_related('profile', 'device')
            .order_by('-is_commented', '-is_approved', '-created_at')
        )
        if profile_id:
            plans_qs = plans_qs.filter(profile_id=profile_id)
        if device_id:
            plans_qs = plans_qs.filter(device_id=device_id)

        # Build lookups for robust matching by comment_link first, then comment_content.
        plan_by_link_lookup: dict[tuple[int, str], TiktokCommentPlan] = {}
        plan_by_content_lookup: dict[tuple[int, str], TiktokCommentPlan] = {}
        plan_by_content_ci_lookup: dict[tuple[int, str], TiktokCommentPlan] = {}
        fallback_plan_by_video_lookup: dict[int, TiktokCommentPlan] = {}

        def _plan_rank(plan: TiktokCommentPlan) -> tuple[int, int, int, float, int]:
            return (
                int(bool(plan.profile_id or plan.device_id)),
                int(bool(plan.is_commented)),
                int(bool(plan.is_approved)),
                plan.created_at.timestamp() if plan.created_at else 0.0,
                int(plan.id or 0),
            )

        def _should_replace(existing: TiktokCommentPlan | None, candidate: TiktokCommentPlan) -> bool:
            if existing is None:
                return True
            return _plan_rank(candidate) > _plan_rank(existing)

        for plan in plans_qs:
            video_key = plan.video_id
            if _should_replace(fallback_plan_by_video_lookup.get(video_key), plan):
                fallback_plan_by_video_lookup[video_key] = plan

            comment_link = (plan.comment_link or '').strip()
            if comment_link:
                link_key = (plan.video_id, comment_link)
                if _should_replace(plan_by_link_lookup.get(link_key), plan):
                    plan_by_link_lookup[link_key] = plan

            normalized_content = (plan.comment_content or '').strip()
            if normalized_content:
                content_key = (plan.video_id, normalized_content)
                if _should_replace(plan_by_content_lookup.get(content_key), plan):
                    plan_by_content_lookup[content_key] = plan

                content_ci_key = (plan.video_id, normalized_content.lower())
                if _should_replace(plan_by_content_ci_lookup.get(content_ci_key), plan):
                    plan_by_content_ci_lookup[content_ci_key] = plan

        results = []
        for interaction in interactions:
            plan = None
            interaction_comment_link = (interaction.comment_link or '').strip()
            if interaction_comment_link:
                plan = plan_by_link_lookup.get((interaction.video_id, interaction_comment_link))

            normalized_interaction_content = (interaction.comment_content or '').strip()
            if plan is None and normalized_interaction_content:
                plan = plan_by_content_lookup.get((interaction.video_id, normalized_interaction_content))
            if plan is None and normalized_interaction_content:
                plan = plan_by_content_ci_lookup.get((interaction.video_id, normalized_interaction_content.lower()))
            if plan is None:
                plan = fallback_plan_by_video_lookup.get(interaction.video_id)

            # If filtering by profile/device, skip interactions without a matching plan
            if (profile_id or device_id) and plan is None:
                continue

            results.append({
                'id': interaction.id,
                'comment_plan_id': plan.id if plan else None,
                'video_id': interaction.video_id,
                'video_url': interaction.video.video_url if interaction.video else '',
                'video_link': plan.video_link if plan else '',
                'comment_content': interaction.comment_content,
                'comment_link': interaction.comment_link,
                'profile': plan.profile_id if plan else None,
                'profile_name': plan.profile.name if plan and plan.profile else None,
                'device': plan.device_id if plan else None,
                'device_name': plan.device.name if plan and plan.device else None,
                'interacted_at': interaction.interacted_at,
                'replay_task_dispatched': interaction.replay_task_dispatched,
                'dig_comment_dispatched': interaction.dig_comment_dispatched,
                'created_at': interaction.created_at,
            })

        serializer = TiktokCommentedInteractionSerializer(results, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['post'], url_path='mark-replay-dispatched')
    def mark_replay_dispatched(self, request):
        """
        POST /api/tiktok/mark-replay-dispatched/ – flag comment interactions as
        having a replay task dispatched (shared highlight across all users).

        Body: {"ids": [<interaction id>, ...], "dispatched": true}

        ``dispatched`` is optional and defaults to true. Only comment-type
        interactions on videos owned by the current user are updated.
        """
        ids = request.data.get('ids')
        if not isinstance(ids, list) or not ids:
            return Response(
                {'detail': 'ids must be a non-empty list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            return Response(
                {'detail': 'ids must be a list of integers.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        dispatched = request.data.get('dispatched', True)
        if not isinstance(dispatched, bool):
            return Response(
                {'detail': 'dispatched must be a boolean.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        updated = TiktokVideoInteraction.objects.filter(
            id__in=ids,
            interaction_type=TiktokInteractionType.COMMENT,
            video__owner=request.user,
        ).update(replay_task_dispatched=dispatched)
        return Response({'updated': updated, 'dispatched': dispatched})

    @action(detail=False, methods=['post'], url_path='delete-interactions')
    def delete_interactions(self, request):
        """
        POST /api/tiktok/delete-interactions/ – delete comment interactions by id.

        Body: {"ids": [<interaction id>, ...]}

        Only comment-type interactions on videos owned by the current user are
        deleted; ids that don't match are silently skipped.
        """
        ids = request.data.get('ids')
        if not isinstance(ids, list) or not ids:
            return Response(
                {'detail': 'ids must be a non-empty list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            return Response(
                {'detail': 'ids must be a list of integers.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        qs = TiktokVideoInteraction.objects.filter(
            id__in=ids,
            interaction_type=TiktokInteractionType.COMMENT,
            video__owner=request.user,
        )
        deleted_count = qs.count()
        qs.delete()
        return Response({'deleted': deleted_count})

    @action(detail=False, methods=['get'], url_path='approved-comments')
    def approved_comments(self, request):
        """
        GET /api/tiktok/approved-comments/ – list comment plans (approved by default) across all videos for current user.
        Supports optional date filtering by plan creation date:
        - date_from (YYYY-MM-DD)
        - date_to   (YYYY-MM-DD)
        Supports optional approval status filtering:
        - approval_status=approved|pending|all (default: approved)
        """
        qs = TiktokCommentPlan.objects.filter(owner=request.user).select_related('video', 'profile', 'device')
        date_from = request.query_params.get('date_from')
        date_to = request.query_params.get('date_to')
        approval_status = request.query_params.get('approval_status', 'approved')
        profile_id = request.query_params.get('profile_id')
        device_id = request.query_params.get('device_id')
        commented_status = request.query_params.get('commented_status')
        if approval_status not in {'approved', 'pending', 'all'}:
            approval_status = 'approved'
        if approval_status == 'approved':
            qs = qs.filter(is_approved=True)
        elif approval_status == 'pending':
            qs = qs.filter(is_approved=False)
        elif approval_status == 'all':
            pass
        if commented_status in {'commented', 'not_commented', 'all'}:
            if commented_status == 'commented':
                qs = qs.filter(is_commented=True)
            elif commented_status == 'not_commented':
                qs = qs.filter(is_commented=False)
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        if device_id:
            qs = qs.filter(device_id=device_id)
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        serializer = TiktokCommentPlanSerializer(qs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='process-video')
    def process_video(self, request, pk=None):
        """
        Call the external video-analysis service for this TikTok video and
        store the returned task_id in video_process_task_id.
        """
        video = self.get_object()

        if not video.video_url:
            return Response(
                {'detail': 'video_url is empty. Cannot process video without a URL.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/tiktok/analyze-video'

        try:
            resp = http_requests.post(
                endpoint,
                json={'tiktok_url': video.video_url},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except http_requests.exceptions.RequestException as exc:
            logger.exception('process_video: external API error: %s', exc)
            return Response(
                {'detail': 'Failed to call video processing service. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        task_id = data.get('task_id')
        if not task_id:
            return Response(
                {'detail': 'Video processing service did not return a task_id.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        video.video_process_task_id = task_id
        video.save(update_fields=['video_process_task_id', 'updated_at'])

        serializer = self.get_serializer(video)
        return Response({'task_id': task_id, 'video': serializer.data})

    @action(detail=True, methods=['get', 'post'], url_path='interactions')
    def interactions(self, request, pk=None):
        """
        GET  /api/tiktok/{id}/interactions/ – list all interactions for this video.
        POST /api/tiktok/{id}/interactions/ – add a new interaction (like or comment).
        """
        video = self.get_object()

        if request.method == 'GET':
            qs = video.interactions.all()
            interaction_type = request.query_params.get('type')
            if interaction_type:
                qs = qs.filter(interaction_type=interaction_type)
            serializer = TiktokVideoInteractionSerializer(qs, many=True)
            return Response(serializer.data)

        # POST
        serializer = TiktokVideoInteractionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        interaction = serializer.save(video=video)

        _sync_approved_comment_plan(video=video, interaction=interaction, owner=request.user)

        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get', 'post'], url_path='comment-plans')
    def comment_plans(self, request, pk=None):
        """
        GET  /api/tiktok/{id}/comment-plans/ – list comment plans for this video.
        POST /api/tiktok/{id}/comment-plans/ – create a comment plan for this video.
        """
        video = self.get_object()

        if request.method == 'GET':
            qs = video.comment_plans.filter(owner=request.user)
            serializer = TiktokCommentPlanSerializer(qs, many=True)
            return Response(serializer.data)

        serializer = TiktokCommentPlanSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save(
            video=video,
            owner=request.user,
            video_link=request.data.get('video_link') or video.video_url or '',
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='comment-plans/approve-all')
    def approve_all_comment_plans(self, request, pk=None):
        """
        POST /api/tiktok/{id}/comment-plans/approve-all/ – approve all pending comment plans for this video.
        """
        video = self.get_object()
        plans = list(video.comment_plans.filter(owner=request.user, is_approved=False).select_related('video'))
        count = 0
        for plan in plans:
            plan.is_approved = True
            plan.save(update_fields=['is_approved', 'updated_at'])
            self._create_schedules_for_approved_comment_plan(plan, request.user)
            count += 1
        return Response({'approved': count})

    @action(detail=True, methods=['patch', 'delete'], url_path=r'comment-plans/(?P<plan_id>[^/.]+)')
    def comment_plan_detail(self, request, pk=None, plan_id=None):
        """
        PATCH  /api/tiktok/{id}/comment-plans/{plan_id}/ – update a comment plan.
        DELETE /api/tiktok/{id}/comment-plans/{plan_id}/ – delete a comment plan.
        """
        video = self.get_object()
        try:
            plan = video.comment_plans.get(id=plan_id, owner=request.user)
        except TiktokCommentPlan.DoesNotExist:
            return Response({'detail': 'Comment plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        if request.method == 'DELETE':
            plan.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        was_approved = plan.is_approved
        serializer = TiktokCommentPlanSerializer(plan, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        plan = serializer.save()
        if not was_approved and plan.is_approved:
            self._create_schedules_for_approved_comment_plan(plan, request.user)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path=r'comment-plans/(?P<plan_id>[^/.]+)/execute-cluster')
    def execute_comment_plan_cluster(self, request, pk=None, plan_id=None):
        video = self.get_object()
        try:
            plan = video.comment_plans.get(id=plan_id, owner=request.user)
        except TiktokCommentPlan.DoesNotExist:
            return Response({'detail': 'Comment plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        force_restart = bool(request.data.get('force_restart', False))
        root, scheduled_plan, task = execute_cluster(plan, force_restart=force_restart)

        if not scheduled_plan or not task:
            return Response(
                {
                    'detail': 'No pending comment plan item to execute.',
                    'root_plan_id': root.id,
                    'scheduled_plan_id': None,
                    'task_id': None,
                },
                status=status.HTTP_200_OK,
            )

        return Response(
            {
                'detail': 'Comment cluster execution scheduled.',
                'root_plan_id': root.id,
                'scheduled_plan_id': scheduled_plan.id,
                'task_id': task.id,
            },
            status=status.HTTP_202_ACCEPTED,
        )

    def _build_dispatch_payload(self, request, video):
        """Validate request data and return (group, payload, error_response).

        Success returns (AgentGroup, payload_dict, None).
        Validation failure returns (None, None, Response).
        """
        agent_group_id = request.data.get('agent_group')
        if agent_group_id is None:
            return None, None, Response({'agent_group': ['This field is required.']}, status=status.HTTP_400_BAD_REQUEST)

        try:
            group = AgentGroup.objects.prefetch_related('members__device').get(id=agent_group_id, owner=request.user)
        except (TypeError, ValueError):
            return None, None, Response({'agent_group': ['A valid integer is required.']}, status=status.HTTP_400_BAD_REQUEST)
        except AgentGroup.DoesNotExist:
            return None, None, Response(
                {'agent_group': ['You can only use your own resources.']},
                status=status.HTTP_400_BAD_REQUEST,
            )

        requested_devices = request.data.get('devices')
        if requested_devices is not None and not isinstance(requested_devices, list):
            return None, None, Response({'devices': ['Expected a list of device IDs.']}, status=status.HTTP_400_BAD_REQUEST)

        group_device_ids = [member.device_id for member in group.members.all()]
        group_device_id_set = set(group_device_ids)
        if requested_devices is None:
            device_ids = group_device_ids
        else:
            invalid_device_ids = [device_id for device_id in requested_devices if device_id not in group_device_id_set]
            if invalid_device_ids:
                return None, None, Response(
                    {'devices': ['All devices must belong to the selected agent group.']},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            device_ids = requested_devices

        requested_keywords = request.data.get('keywords')
        payload = {
            'video_url': request.data['video_url'] if 'video_url' in request.data else video.video_url,
            'content': request.data['content'] if 'content' in request.data else video.content,
            'keywords': requested_keywords if 'keywords' in request.data and isinstance(requested_keywords, list) else video.keywords,
            'agent_group': group.id,
            'devices': device_ids,
        }
        return group, payload, None

    def _call_dispatch_webhook(self, *, webhook_url, payload, response_log_message, error_log_message):
        """Call webhook and return (webhook_response, error_response).

        Success returns (parsed_response_or_text, None).
        Failure returns (None, Response).
        """
        try:
            resp = http_requests.post(webhook_url, json=payload, timeout=30)
            try:
                webhook_response = resp.json()
            except ValueError:
                webhook_response = resp.text
            logger.info(response_log_message, resp.status_code, webhook_response)
            resp.raise_for_status()
            return webhook_response, None
        except http_requests.exceptions.RequestException as exc:
            logger.exception(error_log_message, exc)
            return None, Response(
                {'detail': 'Failed to dispatch comments. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

    def _extract_comment_pairs(self, webhook_response):
        """Extract ordered list[tuple[int, str]] from webhook response.

        Supports two formats:

        Old format (dict)::

            {'output': [{'11': 'comment text'}, ...]}

        New format (list wrapper with named keys)::

            [{'output': [{'device_id': 11, 'comment': 'comment text'}, ...]}]
        """
        # Support list wrapper: take the first element
        if isinstance(webhook_response, list):
            if not webhook_response:
                return []
            if len(webhook_response) > 1:
                logger.warning(
                    '_extract_comment_pairs: webhook response list has %d elements; only the first will be used',
                    len(webhook_response),
                )
            webhook_response = webhook_response[0]

        if not isinstance(webhook_response, dict):
            return []
        output = webhook_response.get('output', [])
        if not isinstance(output, list):
            return []

        comment_pairs = []
        for item in output:
            if not isinstance(item, dict):
                continue
            # New format: {'device_id': 11, 'comment': 'text'}
            if 'device_id' in item and 'comment' in item:
                try:
                    device_id = int(item['device_id'])
                except (TypeError, ValueError):
                    continue
                comment_text = item['comment']
                for normalized_comment in self._normalize_comment_texts(comment_text):
                    comment_pairs.append((device_id, normalized_comment))
            else:
                # Old format: {'11': 'comment text'}
                for device_id_str, comment_text in item.items():
                    try:
                        device_id = int(device_id_str)
                    except (TypeError, ValueError):
                        continue
                    for normalized_comment in self._normalize_comment_texts(comment_text):
                        comment_pairs.append((device_id, normalized_comment))
        return comment_pairs

    @staticmethod
    def _normalize_comment_texts(raw_comment):
        if isinstance(raw_comment, str):
            return [raw_comment]
        if isinstance(raw_comment, (list, tuple)):
            return [item for item in raw_comment if isinstance(item, str)]
        return []

    @staticmethod
    def _resolve_external_webhook_url(webhook_key):
        try:
            return get_external_webhook_url(webhook_key), None
        except (ValueError, ExternalWebhookNotConfiguredError) as exc:
            logger.exception('External webhook resolution error: %s', exc)
            return None, Response(
                {'detail': f'External webhook chưa được cấu hình hợp lệ: {webhook_key}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

    @action(detail=True, methods=['post'], url_path='dispatch-comments')
    def dispatch_comments(self, request, pk=None):
        video = self.get_object()
        group, payload, error_response = self._build_dispatch_payload(request, video)
        if error_response:
            return error_response
        webhook_url, error_response = self._resolve_external_webhook_url(N8N_DISPATCH_COMMENTS_WEBHOOK_KEY)
        if error_response:
            return error_response

        logger.info('Dispatch TikTok comments request: %s', payload)
        webhook_response, error_response = self._call_dispatch_webhook(
            webhook_url=webhook_url,
            payload=payload,
            response_log_message='dispatch_comments: n8n webhook response status=%s body=%s',
            error_log_message='dispatch_comments: webhook error: %s',
        )
        if error_response:
            return error_response

        created_plans = []
        first_comment = ''
        for device_id, comment_text in self._extract_comment_pairs(webhook_response):
            plan = TiktokCommentPlan.objects.create(
                video=video,
                video_link=payload['video_url'],
                device_id=device_id,
                agent_group=group,
                comment_content=comment_text,
                reply_to=first_comment if first_comment else '',
                is_approved=False,
                is_commented=False,
                owner=request.user,
            )
            created_plans.append(plan)
            if not first_comment:
                first_comment = comment_text

        serializer = TiktokCommentPlanSerializer(created_plans, many=True)
        return Response(
            {
                'detail': 'Comment dispatch request submitted successfully.',
                'payload': payload,
                'comment_plans': serializer.data,
            },
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['post'], url_path='dispatch-single-comment')
    def dispatch_single_comment(self, request, pk=None):
        video = self.get_object()
        group, payload, error_response = self._build_dispatch_payload(request, video)
        if error_response:
            return error_response
        webhook_url, error_response = self._resolve_external_webhook_url(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_KEY)
        if error_response:
            return error_response

        logger.info('Dispatch single TikTok comment request: %s', payload)
        webhook_response, error_response = self._call_dispatch_webhook(
            webhook_url=webhook_url,
            payload=payload,
            response_log_message='dispatch_single_comment: n8n webhook response status=%s body=%s',
            error_log_message='dispatch_single_comment: webhook error: %s',
        )
        if error_response:
            return error_response

        created_plans = []
        comment_pairs = self._extract_comment_pairs(webhook_response)
        for device_id, comment_text in comment_pairs:
            created_plans.append(
                TiktokCommentPlan.objects.create(
                    video=video,
                    video_link=payload['video_url'],
                    device_id=device_id,
                    agent_group=group,
                    comment_content=comment_text,
                    reply_to='',
                    is_approved=False,
                    is_commented=False,
                    owner=request.user,
                )
            )

        serializer = TiktokCommentPlanSerializer(created_plans, many=True)
        return Response(
            {
                'detail': 'Single comment dispatch request submitted successfully.',
                'payload': payload,
                'comment_plans': serializer.data,
            },
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['get', 'post'], url_path='plan-chat')
    def plan_chat(self, request, pk=None):
        """
        GET  /api/tiktok/{id}/plan-chat/ – list planning chat messages for this video.
        POST /api/tiktok/{id}/plan-chat/ – append a planning chat message.
        """
        video = self.get_object()

        if request.method == 'GET':
            qs = video.comment_plan_chat_messages.filter(owner=request.user)
            serializer = TiktokCommentPlanChatMessageSerializer(qs, many=True)
            return Response(serializer.data)

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        serializer = TiktokCommentPlanChatMessageSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        user_message = serializer.save(
            video=video,
            owner=request.user,
            sender=TiktokCommentPlanChatMessage.SenderType.USER,
        )

        try:
            from openai import OpenAI  # noqa: PLC0415

            llm_model = DEFAULT_PLAN_CHAT_MODEL
            try:
                from users.models import UserChatSettings  # noqa: PLC0415

                chat_settings = UserChatSettings.objects.filter(user=request.user).only('llm_model').first()
                if chat_settings and chat_settings.llm_model.strip():
                    llm_model = chat_settings.llm_model.strip()
            except Exception:
                logger.warning('Failed to load user chat settings for TikTok plan chat user=%s', request.user.id)

            allowed_models = set(
                getattr(settings, 'TIKTOK_PLAN_CHAT_ALLOWED_MODELS', DEFAULT_TIKTOK_PLAN_CHAT_ALLOWED_MODELS)
            )
            if llm_model not in allowed_models:
                return Response(
                    {'detail': f'Invalid model "{llm_model}" for TikTok plan chat.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            recent_messages = list(
                video.comment_plan_chat_messages
                .filter(owner=request.user)
                .select_related('agent_group')
                .order_by('-created_at')[:30]
            )
            recent_messages.reverse()

            existing_comments = video.existing_comments if isinstance(video.existing_comments, list) else []
            existing_comment_texts = []
            for item in existing_comments[:MAX_EXISTING_COMMENTS_PREVIEW]:
                if isinstance(item, str):
                    text = item
                elif isinstance(item, dict):
                    text = item.get('text') or item.get('content') or ''
                else:
                    text = ''
                text = text.strip()
                if text:
                    existing_comment_texts.append(text)
            existing_comments_preview = ', '.join(existing_comment_texts)
            video_context = (
                f"Video URL: {video.video_url or 'N/A'}\n"
                f"Caption: {video.caption or 'N/A'}\n"
                f"Content: {video.content or 'N/A'}\n"
                f"Existing comments: {existing_comments_preview or 'N/A'}"
            )
            selected_group = user_message.agent_group.name if user_message.agent_group else 'N/A'

            chat_messages = [
                {
                    'role': 'system',
                    'content': (
                        'Bạn là trợ lý chiến lược TikTok. '
                        'Hãy lập kế hoạch comment theo mục tiêu cụ thể và hướng tới thảo luận qua lại tự nhiên. '
                        'Mỗi câu trả lời cần: '
                        '(1) nêu mục tiêu ngắn gọn, '
                        '(2) đề xuất 3-5 comment/reply theo thứ tự, '
                        '(3) nêu cách follow-up để kéo dài hội thoại nhưng vẫn tự nhiên. '
                        'Trả lời ngắn gọn bằng tiếng Việt.'
                    ),
                },
                {
                    'role': 'system',
                    'content': (
                        f'Ngữ cảnh video:\n{video_context}\n\n'
                        f'Agent group đang chọn: {selected_group}'
                    ),
                },
            ]
            for msg in recent_messages:
                chat_messages.append({
                    'role': 'assistant' if msg.sender == TiktokCommentPlanChatMessage.SenderType.ASSISTANT else 'user',
                    'content': msg.content,
                })

            client = OpenAI(api_key=api_key)
            chat_response = client.chat.completions.create(
                model=llm_model,
                messages=chat_messages,
                temperature=0.7,
                max_tokens=DEFAULT_PLAN_CHAT_MAX_TOKENS,
            )
            if not chat_response.choices:
                raise ValueError('OpenAI returned no choices for TikTok plan chat')
            assistant_content = (chat_response.choices[0].message.content or '').strip()
            if assistant_content:
                TiktokCommentPlanChatMessage.objects.create(
                    video=video,
                    owner=request.user,
                    agent_group=user_message.agent_group,
                    sender=TiktokCommentPlanChatMessage.SenderType.ASSISTANT,
                    content=assistant_content,
                )
        except Exception as exc:
            logger.exception('TikTok plan_chat OpenAI error: %s', exc)
            return Response(
                {'detail': 'Failed to generate comment planning response. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(TiktokCommentPlanChatMessageSerializer(user_message).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='video-comments')
    def video_comments(self, request, pk=None):
        """
        GET /api/tiktok/{id}/video-comments/ – list stored TikTok user comments for this video.
        """
        video = self.get_object()
        qs = video.user_comments.all()
        serializer = TiktokVideoUserCommentSerializer(qs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='fetch-comments')
    def fetch_comments(self, request, pk=None):
        """
        POST /api/tiktok/{id}/fetch-comments/ – call the external comment-scraping API
        and upsert results into TiktokVideoUserComment.

        Optional request body fields:
          max_comments (int, default 100)
          include_replies (bool, default true)
          num_sessions (int, default 1)
        """
        video = self.get_object()

        if not video.video_url:
            return Response(
                {'detail': 'video_url is empty. Cannot fetch comments without a URL.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        max_comments = int(request.data.get('max_comments', 100))
        include_replies = bool(request.data.get('include_replies', True))
        num_sessions = int(request.data.get('num_sessions', 1))

        api_url = settings.TIKTOK_COMMENT_API_URL
        endpoint = f'{api_url.rstrip("/")}/comments'
        timeout = getattr(
            settings,
            'TIKTOK_COMMENT_TIMEOUT_SECONDS',
            DEFAULT_TIKTOK_COMMENT_TIMEOUT_SECONDS,
        )

        try:
            resp = _post_with_retry_using_proxy(
                endpoint,
                payload={
                    'url': video.video_url,
                    'max_comments': max_comments,
                    'include_replies': include_replies,
                    'num_sessions': num_sessions,
                },
                timeout=timeout,
            )
            data = resp.json()
        except http_requests.exceptions.RequestException as exc:
            return _comment_service_error_response('fetch_comments', exc)

        comments = data.get('comments', [])
        if not isinstance(comments, list):
            return Response(
                {'detail': 'Unexpected response format from comment service.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        saved = 0
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            cid = str(comment.get('cid') or '').strip()
            if not cid:
                continue
            user = comment.get('user') or {}
            user_id = str(user.get('uid') or '').strip()
            nickname = str(user.get('nickname') or '').strip()
            text = str(comment.get('text') or '').strip()
            raw_create_time = comment.get('create_time')
            parent_cid = str(comment.get('parent_cid') or '').strip()
            raw = comment.get('raw') or {}
            share_info = raw.get('share_info') or {}
            comment_link = str(share_info.get('url') or '').strip() or None

            create_time = None
            if raw_create_time is not None:
                try:
                    from datetime import datetime as _datetime  # noqa: PLC0415
                    create_time = _datetime.fromtimestamp(int(raw_create_time), tz=dt_timezone.utc)
                except (TypeError, ValueError, OSError):
                    pass

            _obj, created = TiktokVideoUserComment.objects.update_or_create(
                video=video,
                cid=cid,
                defaults={
                    'user_id': user_id,
                    'nickname': nickname,
                    'text': text,
                    'create_time': create_time,
                    'parent_cid': parent_cid,
                    'comment_link': comment_link,
                },
            )
            if created:
                saved += 1

        qs = video.user_comments.all()
        serializer = TiktokVideoUserCommentSerializer(qs, many=True)
        return Response({'saved': saved, 'total': qs.count(), 'comments': serializer.data})

    @action(detail=True, methods=['post'], url_path='cluster-comments')
    def cluster_comments(self, request, pk=None):
        """
        POST /api/tiktok/{id}/cluster-comments/ – cluster stored comments and
        return visualization-ready JSON.

        On the first run: calls the external clustering API (UMAP + cluster),
        then embeds all comments via OpenAI (text-embedding-3-small, 1536d) and
        saves both the full vectors and the UMAP coordinates to Qdrant collection
        ``tiktok_comments``.  Subsequent runs return the cached result directly.

        Optional request body fields:
          model (str, default "text-embedding-3-small")
          n_neighbors (int, default 15)
          min_dist (float, default 0.1)
          k_max (int, default 10)
        """
        video = self.get_object()

        comments = [
            text
            for text in (
                (item or '').strip()
                for item in video.user_comments.values_list('text', flat=True)
            )
            if text
        ]

        if not comments:
            return Response(
                {'detail': 'No stored comments found. Please fetch comments first.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        model = str(request.data.get('model') or 'text-embedding-3-small').strip() or 'text-embedding-3-small'
        timeout = getattr(
            settings,
            'TIKTOK_COMMENT_TIMEOUT_SECONDS',
            DEFAULT_TIKTOK_COMMENT_TIMEOUT_SECONDS,
        )

        try:
            n_neighbors = int(request.data.get('n_neighbors', 15))
            min_dist = float(request.data.get('min_dist', 0.1))
            k_max = int(request.data.get('k_max', 10))
        except (TypeError, ValueError):
            return Response(
                {'detail': 'Invalid clustering params. Expected numeric n_neighbors, min_dist, k_max.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Step 1: check Qdrant for cached vectors ──────────────────────────
        points: list = []
        n_clusters = 0
        used_model = model
        qdrant_client = None

        try:
            from .qdrant_service import ensure_collection, get_client, get_video_points
            qdrant_client = get_client()
            ensure_collection(qdrant_client)
            cached = get_video_points(qdrant_client, video.id)
            if cached:
                points = cached
                valid_clusters = {
                    p['cluster'] for p in points
                    if isinstance(p.get('cluster'), int) and p['cluster'] >= 0
                }
                n_clusters = len(valid_clusters)
                logger.info(
                    'cluster_comments: cache hit – %d vectors from Qdrant for video_id=%d',
                    len(points), video.id,
                )
        except Exception as exc:
            logger.warning('cluster_comments: Qdrant unavailable, falling back to API: %s', exc)

        # ── Step 2: cache miss → call external clustering API ───────────────
        if not points:
            endpoint = f'{settings.TIKTOK_COMMENT_API_URL.rstrip("/")}/cluster-comment'
            try:
                resp = _post_with_retry_using_proxy(
                    endpoint,
                    payload={
                        'comments': comments,
                        'model': model,
                        'n_neighbors': n_neighbors,
                        'min_dist': min_dist,
                        'k_max': k_max,
                    },
                    timeout=timeout,
                )
                data = resp.json()
            except http_requests.exceptions.RequestException as exc:
                return _comment_service_error_response(
                    'cluster_comments',
                    exc,
                    fallback_detail='Failed to call comment clustering service.',
                )

            points = data.get('points', [])
            if not isinstance(points, list):
                return Response(
                    {'detail': 'Unexpected response format from comment clustering service.', 'response': data},
                    status=status.HTTP_502_BAD_GATEWAY,
                )

            n_clusters = int(data.get('n_clusters') or 0)
            used_model = data.get('model') or model

            # ── Step 3: embed via OpenAI → upsert full 1536d vectors to Qdrant
            if qdrant_client is not None and points:
                api_key = getattr(settings, 'OPENAI_API_KEY', '')
                if api_key:
                    try:
                        from openai import OpenAI as _OpenAI
                        from .qdrant_service import upsert_video_points
                        oai = _OpenAI(api_key=api_key)
                        emb_resp = oai.embeddings.create(
                            model='text-embedding-3-small',
                            input=comments,
                        )
                        embeddings = [e.embedding for e in emb_resp.data]
                        upsert_video_points(qdrant_client, video.id, points, embeddings)
                    except Exception as exc:
                        logger.warning('cluster_comments: failed to upsert embeddings to Qdrant: %s', exc)
                else:
                    logger.warning('cluster_comments: OPENAI_API_KEY not set, skipping Qdrant upsert')

        # ── Step 4: name clusters with LLM ──────────────────────────────────
        cluster_labels: dict = {}
        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if api_key and points:
            try:
                cluster_labels = _name_clusters_with_llm(points, api_key)
            except Exception as exc:
                logger.warning('cluster_comments: LLM naming failed: %s', exc)

        return Response(
            {
                'video_id': video.id,
                'source_comments': len(comments),
                'count': len(points),
                'model': used_model,
                'n_clusters': n_clusters,
                'points': points,
                'cluster_labels': cluster_labels,
            }
        )

    @action(detail=True, methods=['post'], url_path='dig-comment')
    def dig_comment(self, request, pk=None):
        """
        POST /api/tiktok/{id}/dig-comment/ – fetch video comments and find a match
        for a specific interaction using ≥98% text similarity (SequenceMatcher).

        Request body:
          interaction_id (int, required) – the TiktokVideoInteraction to update
          comment_plan_id (int, optional) – the TiktokCommentPlan to update

        On a successful match the comment_link is written to both
        TiktokVideoInteraction and (if provided) TiktokCommentPlan.
        """
        from difflib import SequenceMatcher  # noqa: PLC0415

        SIMILARITY_THRESHOLD = 0.98

        video = self.get_object()

        raw_interaction_id = request.data.get('interaction_id')
        raw_comment_plan_id = request.data.get('comment_plan_id')

        if not raw_interaction_id:
            return Response(
                {'detail': 'interaction_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            interaction_id = int(raw_interaction_id)
        except (TypeError, ValueError):
            return Response(
                {'detail': 'interaction_id must be an integer.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            interaction = TiktokVideoInteraction.objects.get(
                id=interaction_id,
                video=video,
                interaction_type=TiktokInteractionType.COMMENT,
                video__owner=request.user,
            )
        except TiktokVideoInteraction.DoesNotExist:
            return Response(
                {'detail': 'Interaction not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        comment_content = (interaction.comment_content or '').strip()
        if not comment_content:
            return Response(
                {'detail': 'Interaction has no comment content to match against.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not video.video_url:
            return Response(
                {'detail': 'video_url is empty. Cannot fetch comments without a URL.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Fetch comments from external API (same mechanism as fetch_comments)
        api_url = settings.TIKTOK_COMMENT_API_URL
        endpoint = f'{api_url.rstrip("/")}/comments'
        timeout = getattr(
            settings,
            'TIKTOK_COMMENT_TIMEOUT_SECONDS',
            DEFAULT_TIKTOK_COMMENT_TIMEOUT_SECONDS,
        )

        try:
            resp = _post_with_retry_using_proxy(
                endpoint,
                payload={
                    'url': video.video_url,
                    'max_comments': DIG_COMMENT_MAX_FETCH,
                    'include_replies': True,
                    'num_sessions': 1,
                },
                timeout=timeout,
            )
            data = resp.json()
        except http_requests.exceptions.RequestException as exc:
            return _comment_service_error_response('dig_comment', exc)

        comments = data.get('comments', [])
        if not isinstance(comments, list):
            return Response(
                {'detail': 'Unexpected response format from comment service.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Upsert fetched comments into TiktokVideoUserComment
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            cid = str(comment.get('cid') or '').strip()
            if not cid:
                continue
            user = comment.get('user') or {}
            user_id = str(user.get('uid') or '').strip()
            nickname = str(user.get('nickname') or '').strip()
            text = str(comment.get('text') or '').strip()
            raw_create_time = comment.get('create_time')
            parent_cid = str(comment.get('parent_cid') or '').strip()
            raw = comment.get('raw') or {}
            share_info = raw.get('share_info') or {}
            comment_link = str(share_info.get('url') or '').strip() or None

            create_time = None
            if raw_create_time is not None:
                try:
                    from datetime import datetime as _datetime  # noqa: PLC0415
                    create_time = _datetime.fromtimestamp(int(raw_create_time), tz=dt_timezone.utc)
                except (TypeError, ValueError, OSError):
                    pass

            TiktokVideoUserComment.objects.update_or_create(
                video=video,
                cid=cid,
                defaults={
                    'user_id': user_id,
                    'nickname': nickname,
                    'text': text,
                    'create_time': create_time,
                    'parent_cid': parent_cid,
                    'comment_link': comment_link,
                },
            )

        # Mark this interaction as dug (shared highlight across users, like
        # replay_task_dispatched). Set once the dig ran successfully, regardless
        # of whether a matching comment was found.
        if not interaction.dig_comment_dispatched:
            interaction.dig_comment_dispatched = True
            interaction.save(update_fields=['dig_comment_dispatched'])

        # Find the best-matching comment using SequenceMatcher
        best_match: dict | None = None
        best_ratio = 0.0
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            text = str(comment.get('text') or '').strip()
            if not text:
                continue
            ratio = SequenceMatcher(None, comment_content, text).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_match = comment

        if best_match is None or best_ratio < SIMILARITY_THRESHOLD:
            return Response({
                'matched': False,
                'comment_link': None,
                'similarity': round(best_ratio, 4),
                'interaction_id': interaction.id,
                'comment_plan_id': raw_comment_plan_id,
                'detail': 'No comment matched at 98% similarity threshold.',
            })

        raw = best_match.get('raw') or {}
        share_info = raw.get('share_info') or {}
        matched_link = str(share_info.get('url') or '').strip() or None

        if not matched_link:
            return Response({
                'matched': True,
                'comment_link': None,
                'similarity': round(best_ratio, 4),
                'interaction_id': interaction.id,
                'comment_plan_id': raw_comment_plan_id,
                'detail': 'Matched comment has no shareable link.',
            })

        # Update TiktokVideoInteraction
        interaction.comment_link = matched_link
        interaction.save(update_fields=['comment_link'])

        # Update TiktokCommentPlan if provided
        updated_plan = False
        if raw_comment_plan_id:
            try:
                plan = TiktokCommentPlan.objects.get(
                    id=int(raw_comment_plan_id),
                    video=video,
                )
                plan.comment_link = matched_link
                plan.save(update_fields=['comment_link', 'updated_at'])
                updated_plan = True
            except (TiktokCommentPlan.DoesNotExist, TypeError, ValueError):
                pass

        return Response({
            'matched': True,
            'comment_link': matched_link,
            'similarity': round(best_ratio, 4),
            'interaction_id': interaction.id,
            'comment_plan_id': raw_comment_plan_id,
            'updated_plan': updated_plan,
        })


class KeywordListViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = KeywordList.objects.all()
    serializer_class = KeywordListSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [OrderingFilter]
    ordering_fields = ['created_at', 'updated_at', 'name']
    ordering = ['-created_at']

    @staticmethod
    def _coerce_keywords(raw_keyword, raw_keywords):
        provided_keywords = []

        if raw_keyword is not None:
            if not isinstance(raw_keyword, str):
                raise ValueError('invalid_keyword')
            provided_keywords.append(raw_keyword)

        if raw_keywords is not None:
            if not isinstance(raw_keywords, list) or any(not isinstance(keyword, str) for keyword in raw_keywords):
                raise ValueError('invalid_keywords')
            provided_keywords.extend(raw_keywords)

        normalized_keywords = []
        seen = set()
        for keyword in provided_keywords:
            normalized_keyword = keyword.strip()
            if not normalized_keyword:
                continue
            lowered_keyword = normalized_keyword.lower()
            if lowered_keyword in seen:
                continue
            seen.add(lowered_keyword)
            normalized_keywords.append(normalized_keyword)

        return normalized_keywords

    @staticmethod
    def _build_video_url(video_id: str, author_unique_id: str = '') -> str:
        video_id = str(video_id or '').strip()
        author_unique_id = str(author_unique_id or '').strip()
        if not video_id:
            return 'https://www.tiktok.com/'
        if author_unique_id:
            return f'https://www.tiktok.com/@{author_unique_id}/video/{video_id}'
        return f'https://www.tiktok.com/video/{video_id}'

    @staticmethod
    def _parse_search_params(payload):
        keyword = payload.get('keyword', '')
        if not isinstance(keyword, str) or not keyword.strip():
            raise ValueError('keyword_required')
        keyword = keyword.strip()

        def _as_int(field, default):
            raw = payload.get(field, default)
            try:
                return int(raw)
            except (TypeError, ValueError):
                raise ValueError(f'invalid_{field}') from None

        count = _as_int('count', 10)
        cursor = _as_int('cursor', 0)
        num_sessions = _as_int('num_sessions', 1)

        if not (1 <= count <= 100):
            raise ValueError('invalid_count')
        if cursor < 0:
            raise ValueError('invalid_cursor')
        if not (1 <= num_sessions <= 10):
            raise ValueError('invalid_num_sessions')

        return keyword, count, cursor, num_sessions

    @staticmethod
    def _extract_video_id_from_url(url_value: str) -> str:
        url_value = str(url_value or '').strip()
        marker = '/video/'
        if marker not in url_value:
            return ''
        tail = url_value.split(marker, 1)[1]
        video_id_chars = []
        for ch in tail:
            if ch.isdigit():
                video_id_chars.append(ch)
            else:
                break
        return ''.join(video_id_chars)

    def _get_existing_video_map(self, owner, video_ids):
        clean_ids = [str(video_id).strip() for video_id in video_ids if str(video_id).strip()]
        if not clean_ids:
            return {}

        has_video_q = Q()
        for video_id in clean_ids:
            has_video_q |= Q(video_url__icontains=f'/video/{video_id}')

        matches = TiktokVideo.objects.filter(owner=owner).filter(has_video_q).only('id', 'video_url')
        result = {}
        for video in matches:
            parsed_video_id = self._extract_video_id_from_url(video.video_url)
            if not parsed_video_id:
                continue
            result.setdefault(parsed_video_id, []).append(video)
        return result

    @action(detail=True, methods=['post'], url_path='add-keyword')
    def add_keyword(self, request, pk=None):
        keyword_list = self.get_object()
        raw_keyword = request.data.get('keyword')
        raw_keywords = request.data.get('keywords')

        if raw_keyword is None and raw_keywords is None:
            return Response({'detail': 'keyword or keywords is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            requested_keywords = self._coerce_keywords(raw_keyword, raw_keywords)
        except ValueError as exc:
            error_code = exc.args[0]
            if error_code == 'invalid_keyword':
                detail = 'keyword must be a string.'
            else:
                detail = 'keywords must be a list of strings.'
            return Response({'detail': detail}, status=status.HTTP_400_BAD_REQUEST)

        if not requested_keywords:
            return Response(
                {'detail': 'Provide at least one non-empty keyword.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        current_keywords = list(keyword_list.keywords or [])
        existing_keywords = {
            keyword.strip().lower()
            for keyword in current_keywords
            if isinstance(keyword, str) and keyword.strip()
        }

        added_keywords = []
        for keyword in requested_keywords:
            lowered_keyword = keyword.lower()
            if lowered_keyword in existing_keywords:
                continue
            existing_keywords.add(lowered_keyword)
            current_keywords.append(keyword)
            added_keywords.append(keyword)

        if added_keywords:
            keyword_list.keywords = current_keywords
            keyword_list.save(update_fields=['keywords', 'updated_at'])

        serializer = self.get_serializer(keyword_list)
        return Response({
            'added_keywords': added_keywords,
            'keyword_list': serializer.data,
        })

    @action(detail=True, methods=['post'], url_path='search-videos')
    def search_videos(self, request, pk=None):
        self.get_object()
        try:
            keyword, count, cursor, num_sessions = self._parse_search_params(request.data)
        except ValueError as exc:
            code = exc.args[0]
            detail_map = {
                'keyword_required': 'keyword is required.',
                'invalid_count': 'count must be an integer between 1 and 100.',
                'invalid_cursor': 'cursor must be a non-negative integer.',
                'invalid_num_sessions': 'num_sessions must be an integer between 1 and 10.',
            }
            return Response({'detail': detail_map.get(code, 'Invalid request payload.')}, status=status.HTTP_400_BAD_REQUEST)

        endpoint = settings.TIKTOK_VIDEO_SEARCH_URL
        timeout = getattr(
            settings,
            'TIKTOK_VIDEO_SEARCH_TIMEOUT_SECONDS',
            DEFAULT_TIKTOK_VIDEO_SEARCH_TIMEOUT_SECONDS,
        )
        payload = {
            'keyword': keyword,
            'count': count,
            'cursor': cursor,
            'num_sessions': num_sessions,
        }

        try:
            external_response = _post_with_retry_using_proxy(
                endpoint,
                payload=payload,
                headers={
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                timeout=timeout,
            )
            raw_data = external_response.json()
        except (http_requests.RequestException, ValueError):
            logger.exception('Failed to search TikTok videos for keyword %s', keyword)
            return Response(
                {'detail': 'Could not fetch TikTok videos right now. Please try again.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        raw_videos = raw_data.get('videos', [])
        if not isinstance(raw_videos, list):
            raw_videos = []

        existing_video_map = self._get_existing_video_map(
            request.user,
            [item.get('video_id') for item in raw_videos if isinstance(item, dict)],
        )

        normalized_videos = []
        for item in raw_videos:
            if not isinstance(item, dict):
                continue
            video_id = str(item.get('video_id', '')).strip()
            if not video_id:
                continue
            author = item.get('author') if isinstance(item.get('author'), dict) else {}
            author_unique_id = str(author.get('unique_id', '')).strip()
            video_url = self._build_video_url(video_id=video_id, author_unique_id=author_unique_id)
            normalized_videos.append({
                'video_id': video_id,
                'desc': str(item.get('desc', '') or ''),
                'create_time': item.get('create_time'),
                'author': author,
                'stats': item.get('stats') if isinstance(item.get('stats'), dict) else {},
                'video_url': video_url,
                'is_existing': video_id in existing_video_map,
            })

        raw_count = raw_data.get('count')
        try:
            response_count = int(raw_count)
        except (TypeError, ValueError):
            response_count = len(normalized_videos)

        return Response({
            'keyword': str(raw_data.get('keyword') or keyword),
            'count': response_count,
            'partial': bool(raw_data.get('partial', False)),
            'videos': normalized_videos,
        })

    @action(detail=True, methods=['post'], url_path='save-search-videos')
    def save_search_videos(self, request, pk=None):
        keyword_list = self.get_object()
        raw_keyword = request.data.get('keyword')
        raw_videos = request.data.get('videos')

        if not isinstance(raw_keyword, str) or not raw_keyword.strip():
            return Response({'detail': 'keyword is required.'}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(raw_videos, list):
            return Response({'detail': 'videos must be a list.'}, status=status.HTTP_400_BAD_REQUEST)

        keyword = raw_keyword.strip()
        input_by_video_id = {}
        for item in raw_videos:
            if not isinstance(item, dict):
                continue
            video_id = str(item.get('video_id', '')).strip()
            if not video_id:
                continue
            input_by_video_id[video_id] = item

        video_ids = list(input_by_video_id.keys())
        existing_video_map = self._get_existing_video_map(request.user, video_ids)

        created = 0
        existing = 0
        saved_video_ids = []
        for video_id, item in input_by_video_id.items():
            author = item.get('author') if isinstance(item.get('author'), dict) else {}
            author_unique_id = str(author.get('unique_id', '')).strip()
            canonical_url = self._build_video_url(video_id=video_id, author_unique_id=author_unique_id)
            desc = str(item.get('desc', '') or '').strip()

            matches = existing_video_map.get(video_id, [])
            if matches:
                existing += 1
                for existing_video in matches:
                    update_fields = []
                    if existing_video.video_url != canonical_url:
                        existing_video.video_url = canonical_url
                        update_fields.append('video_url')
                    current_keywords = [
                        kw for kw in (existing_video.keywords or [])
                        if isinstance(kw, str) and kw.strip()
                    ]
                    if keyword.lower() not in {kw.lower() for kw in current_keywords}:
                        current_keywords.append(keyword)
                        existing_video.keywords = current_keywords
                        update_fields.append('keywords')
                    if update_fields:
                        update_fields.append('updated_at')
                        existing_video.save(update_fields=update_fields)
                    saved_video_ids.append(existing_video.id)
                continue

            created_video = TiktokVideo.objects.create(
                owner=request.user,
                keywords=[keyword],
                video_url=canonical_url,
                caption=desc or None,
                content=desc,
                status=TiktokVideoStatus.PENDING,
            )
            created += 1
            saved_video_ids.append(created_video.id)

        dedup_saved_ids = list(dict.fromkeys(saved_video_ids))

        # Mark this keyword as "saved" on the list so its chip shows green for
        # every user (shared flag, like replay_task_dispatched on interactions).
        existing_saved = [k for k in (keyword_list.saved_keywords or []) if isinstance(k, str)]
        if keyword not in existing_saved:
            keyword_list.saved_keywords = [*existing_saved, keyword]
            keyword_list.save(update_fields=['saved_keywords', 'updated_at'])

        return Response({
            'keyword': keyword,
            'list_id': keyword_list.id,
            'saved': created,
            'existing': existing,
            'total': len(video_ids),
            'video_ids': dedup_saved_ids,
        })

    @action(detail=False, methods=['post'], url_path='scan-dispatched')
    def scan_dispatched(self, request):
        """
        Scan all keyword lists belonging to the current user and remove any
        keyword from ``dispatched_keywords`` that does not have a corresponding
        entry in ``tiktok_tiktokvideo`` (i.e. no TiktokVideo whose ``keywords``
        JSON array contains that exact keyword).

        POST /api/tiktok/keyword-lists/scan-dispatched/

        Returns:
            lists_scanned  (int): total keyword lists examined.
            keywords_removed (int): total keywords removed across all lists.
            detail (list[dict]): per-list breakdown.
        """
        lists = list(KeywordList.objects.filter(owner=request.user))

        # Collect all distinct dispatched keywords in one pass to avoid N+1 queries
        all_dispatched = set()
        for kw_list in lists:
            for kw in kw_list.dispatched_keywords or []:
                all_dispatched.add(kw)

        # Build a set of keywords that have at least one matching video.
        # Use keywords__contains=[kw] for each keyword so Django uses a JSON
        # array containment check (exact element match, not substring match).
        if all_dispatched:
            has_video_qs = Q()
            for kw in all_dispatched:
                has_video_qs |= Q(keywords__contains=[kw])
            matched_keywords: set[str] = set()
            for video in TiktokVideo.objects.filter(owner=request.user).filter(has_video_qs).only('keywords'):
                for kw in (video.keywords or []):
                    matched_keywords.add(kw)
        else:
            matched_keywords = set()

        lists_scanned = len(lists)
        keywords_removed = 0
        detail = []

        for kw_list in lists:
            dispatched = list(kw_list.dispatched_keywords or [])
            if not dispatched:
                continue

            valid_keywords = [kw for kw in dispatched if kw in matched_keywords]
            removed = [kw for kw in dispatched if kw not in matched_keywords]

            if removed:
                kw_list.dispatched_keywords = valid_keywords
                kw_list.save(update_fields=['dispatched_keywords', 'updated_at'])
                keywords_removed += len(removed)
                detail.append({
                    'list_id': kw_list.id,
                    'list_name': kw_list.name,
                    'removed': removed,
                })

        return Response({
            'lists_scanned': lists_scanned,
            'keywords_removed': keywords_removed,
            'detail': detail,
        })

    @action(detail=False, methods=['post'], url_path='generate')
    def generate(self, request):
        """
        Generate a deduplicated list of TikTok keywords using OpenAI.

        Request body:
            topic (str): The seed topic / niche to generate keywords for.
            count (int): Number of keywords to generate (1-100).
            existing_keywords (list[str], optional): Keywords already in the
                list; generated keywords will not duplicate these.
        """
        topic = request.data.get('topic', '').strip()
        count = request.data.get('count', 20)
        existing_keywords = request.data.get('existing_keywords', [])

        if not topic:
            return Response({'detail': 'topic is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            count = int(count)
            if not (1 <= count <= 100):
                raise ValueError
        except (TypeError, ValueError):
            return Response(
                {'detail': 'count must be an integer between 1 and 100.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        existing_set = {kw.lower() for kw in existing_keywords if isinstance(kw, str)}

        try:
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key)

            existing_hint = (
                f"\nDo NOT include any of these already-existing keywords: {', '.join(sorted(existing_set))}"
                if existing_set
                else ''
            )

            prompt = (
                f"Generate exactly {count} unique TikTok keyword phrases for the topic: \"{topic}\".\n"
                f"Rules:\n"
                f"- Return ONLY a JSON array of strings, nothing else.\n"
                f"- Each keyword should be short (1-5 words), relevant, and suitable for TikTok content.\n"
                f"- All keywords must be unique (no duplicates).\n"
                f"- Do not include hashtag symbols (#).\n"
                f"{existing_hint}"
            )

            chat_response = client.chat.completions.create(
                model='gpt-4o-mini',
                messages=[
                    {
                        'role': 'system',
                        'content': (
                            'You are a TikTok content strategist. '
                            'You respond with valid JSON arrays only, no markdown or explanation.'
                        ),
                    },
                    {'role': 'user', 'content': prompt},
                ],
                temperature=0.7,
                max_tokens=1024,
            )

            raw = chat_response.choices[0].message.content.strip()

            import json  # noqa: PLC0415
            # Strip optional markdown code fences
            if raw.startswith('```'):
                raw = raw.split('\n', 1)[-1]
                raw = raw.rsplit('```', 1)[0]
            keywords = json.loads(raw)

            if not isinstance(keywords, list):
                raise ValueError('OpenAI did not return a JSON array')

            # Normalise and deduplicate (also against existing_keywords)
            seen = set(existing_set)
            unique_keywords = []
            for kw in keywords:
                if not isinstance(kw, str):
                    continue
                kw = kw.strip()
                if not kw:
                    continue
                if kw.lower() not in seen:
                    seen.add(kw.lower())
                    unique_keywords.append(kw)

        except Exception as exc:
            logger.exception('KeywordList generate error: %s', exc)
            return Response(
                {'detail': 'Keyword generation failed. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'keywords': unique_keywords})

    @staticmethod
    def _extract_keywords_from_search_response(response_data):
        extracted = []

        if isinstance(response_data, dict):
            # Common format from n8n: {"keywords": ["...", "..."]}
            raw_keywords = response_data.get('keywords')
            if isinstance(raw_keywords, list):
                for item in raw_keywords:
                    if isinstance(item, str) and item.strip():
                        extracted.append(item.strip())
                return extracted

            # Fallback: single keyword in object
            single_keyword = response_data.get('keyword')
            if isinstance(single_keyword, str) and single_keyword.strip():
                extracted.append(single_keyword.strip())
            return extracted

        if isinstance(response_data, list):
            for item in response_data:
                if isinstance(item, str) and item.strip():
                    extracted.append(item.strip())
                    continue
                if not isinstance(item, dict):
                    continue
                nested_keywords = item.get('keywords')
                if isinstance(nested_keywords, list):
                    for nested in nested_keywords:
                        if isinstance(nested, str) and nested.strip():
                            extracted.append(nested.strip())
                    continue
                nested_keyword = item.get('keyword')
                if isinstance(nested_keyword, str) and nested_keyword.strip():
                    extracted.append(nested_keyword.strip())

        return extracted

    @action(detail=False, methods=['post'], url_path='search-keywords')
    def search_keywords(self, request):
        """
        Search for keywords using N8N webhook.
        
        POST /api/tiktok/keyword-lists/search-keywords/
        
        Request body:
            keywords (list[str]): List of keywords to search for
        
        Response:
            keywords (list[str]): Flattened keyword list returned from webhook responses
        
        For each input keyword, call N8N with payload: {"keyword": "keyword_string"}
        and aggregate keywords from each response.
        """
        keywords_input = request.data.get('keywords', [])
        
        if not isinstance(keywords_input, list) or not keywords_input:
            return Response(
                {'detail': 'keywords must be a non-empty list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        
        webhook_url, error_response = self._resolve_external_webhook_url(N8N_SEARCH_KEYWORD_WEBHOOK_KEY)
        if error_response:
            return error_response
        
        # Clean, normalize, and de-duplicate input keywords
        clean_keywords = []
        seen_input = set()
        for raw_keyword in keywords_input:
            if not isinstance(raw_keyword, str):
                continue
            keyword = raw_keyword.strip()
            if not keyword:
                continue
            lowered = keyword.lower()
            if lowered in seen_input:
                continue
            seen_input.add(lowered)
            clean_keywords.append(keyword)
        
        if not clean_keywords:
            return Response(
                {'keywords': []},
                status=status.HTTP_200_OK,
            )
        
        logger.info('Search keywords request with %d keywords', len(clean_keywords))
        
        all_results = []
        seen_results = set()
        failed_keywords = []
        
        # Call webhook for each keyword individually
        for keyword in clean_keywords:
            try:
                payload = {'keyword': keyword}
                webhook_response = http_requests.post(
                    webhook_url,
                    json=payload,
                    headers={
                        'accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    timeout=300,
                )
                logger.info('Search keywords webhook for "%s" responded with status %d', keyword, webhook_response.status_code)
                webhook_response.raise_for_status()
                response_data = webhook_response.json()
                
                extracted_keywords = self._extract_keywords_from_search_response(response_data)
                if not extracted_keywords:
                    logger.warning('No keywords extracted from webhook response for keyword "%s": %s', keyword, response_data)
                    continue

                for extracted_keyword in extracted_keywords:
                    lowered = extracted_keyword.lower()
                    if lowered in seen_results:
                        continue
                    seen_results.add(lowered)
                    all_results.append(extracted_keyword)
                    
            except http_requests.RequestException as exc:
                logger.exception('Search keywords webhook error for keyword "%s": %s', keyword, exc)
                failed_keywords.append(keyword)
            except ValueError as exc:
                logger.exception('Invalid JSON from search keywords webhook for keyword "%s": %s', keyword, exc)
                failed_keywords.append(keyword)
        
        logger.info('Search keywords completed: %d keywords aggregated, %d failed requests', len(all_results), len(failed_keywords))
        
        response_obj = {'keywords': all_results}
        if failed_keywords:
            response_obj['failed_keywords'] = failed_keywords
            response_obj['detail'] = f'Some keywords failed to search: {", ".join(failed_keywords)}'
        
        return Response(response_obj)

    @staticmethod
    def _resolve_external_webhook_url(webhook_key):
        try:
            return get_external_webhook_url(webhook_key), None
        except (ValueError, ExternalWebhookNotConfiguredError) as exc:
            logger.exception('External webhook resolution error: %s', exc)
            return None, Response(
                {'detail': f'External webhook chưa được cấu hình hợp lệ: {webhook_key}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )


class RecordVideoInteractionView(APIView):
    """
    API endpoint (API-key authenticated) to record an interaction
    (like, comment, repost, reply) on a TikTok video identified by its URL.

    POST /api/tiktok/record-interaction/
    Body:
        video_url       (str, required)  – TikTok video link used to locate the video
        interaction_type (str, required) – like | comment | repost | reply
        profile_username (str, optional)
        profile_avatar_url (str, optional)
        comment_content (str, optional)  – required when interaction_type is comment or reply
        comment_link    (str, optional)  – direct URL to the posted TikTok comment/reply
        interacted_at   (datetime, optional) – ISO 8601 timestamp of the interaction
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        video_url = request.data.get('video_url', '').strip()
        if not video_url:
            return Response(
                {'detail': 'video_url is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        video = TiktokVideo.objects.filter(owner=request.user, video_url=video_url).first()
        if not video:
            return Response(
                {'detail': 'No TikTok video found with that video_url.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Upsert: an interaction is identified by (video, profile_username).
        # Same profile re-sending the request (e.g. to add comment_link) updates
        # the existing record. Different profiles on the same video each get their
        # own row.
        profile_username_raw = request.data.get('profile_username')
        profile_username = str(profile_username_raw).strip() if profile_username_raw is not None else ''
        existing_filter: dict = {'video': video}
        if profile_username:
            existing_filter['profile_username'] = profile_username
        existing = (
            TiktokVideoInteraction.objects
            .filter(**existing_filter)
            .order_by('-created_at')
            .first()
        )

        if existing is not None:
            serializer = TiktokVideoInteractionSerializer(existing, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            interaction = serializer.save(video=video)
            response_status = status.HTTP_200_OK
        else:
            serializer = TiktokVideoInteractionSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            interaction = serializer.save(video=video)
            response_status = status.HTTP_201_CREATED

        _sync_approved_comment_plan(video=video, interaction=interaction, owner=request.user)

        if (
            interaction.interaction_type == TiktokInteractionType.COMMENT
            and video.status != TiktokVideoStatus.COMMENTED
        ):
            video.status = TiktokVideoStatus.COMMENTED
            video.save(update_fields=['status', 'updated_at'])
        return Response(serializer.data, status=response_status)


class GenerateCommentView(APIView):
    """
    Generate a TikTok comment using OpenAI based on video content and existing comments.

    POST /api/tiktok/generate-comment/
    Body:
        video_content      (str, optional) – description / caption of the video
        existing_comments  (list[str], optional) – existing comments on the video
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        video_content = request.data.get('video_content', '').strip()
        existing_comments = request.data.get('existing_comments', [])

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key)

            comments_hint = ''
            if isinstance(existing_comments, list) and existing_comments:
                sample = [str(c) for c in existing_comments[:10]]
                comments_hint = '\nExisting comments on this video:\n' + '\n'.join(f'- {c}' for c in sample)

            prompt = (
                f'Generate a natural, engaging TikTok comment for a video.\n'
                f'Video content/description: {video_content or "No description available"}'
                f'{comments_hint}\n'
                f'Rules:\n'
                f'- Return ONLY the comment text, nothing else.\n'
                f'- Keep it short (1–2 sentences).\n'
                f'- Make it relevant, authentic, and fit the tone of existing comments.\n'
                f'- Write in Vietnamese.'
            )

            chat_response = client.chat.completions.create(
                model='gpt-4o-mini',
                messages=[
                    {
                        'role': 'system',
                        'content': (
                            'You are a TikTok user writing natural comments. '
                            'Write comments that feel authentic and engaging. '
                            'Respond with the comment text only.'
                        ),
                    },
                    {'role': 'user', 'content': prompt},
                ],
                temperature=0.8,
                max_tokens=150,
            )

            comment = chat_response.choices[0].message.content.strip()
        except Exception as exc:
            logger.exception('GenerateCommentView error: %s', exc)
            return Response(
                {'detail': 'Comment generation failed. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'comment': comment})


class UpdateVideoContentView(APIView):
    """
    API endpoint (API-key authenticated) to update the ``content`` and/or
    ``existing_comments`` fields of a TikTok video identified by its
    ``video_process_task_id``.

    POST /api/tiktok/update-content/
    Body:
        video_process_task_id (str, required)
        content               (str, optional)
        existing_comments     (list, optional) – replaces the existing_comments list
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        video_process_task_id = request.data.get('video_process_task_id', '').strip()

        if not video_process_task_id:
            return Response(
                {'detail': 'video_process_task_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            video = TiktokVideo.objects.get(video_process_task_id=video_process_task_id)
        except TiktokVideo.DoesNotExist:
            return Response(
                {'detail': 'No TikTok video found with that video_process_task_id.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        if 'content' not in request.data and 'existing_comments' not in request.data:
            return Response(
                {'detail': 'At least one of content or existing_comments is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        update_fields = ['updated_at']

        if 'content' in request.data:
            video.content = request.data.get('content', '')
            update_fields.append('content')

        if 'existing_comments' in request.data:
            existing_comments = request.data.get('existing_comments')
            if not isinstance(existing_comments, list):
                return Response(
                    {'detail': 'existing_comments must be a list.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            video.existing_comments = existing_comments
            update_fields.append('existing_comments')

        video.save(update_fields=update_fields)

        serializer = TiktokVideoSerializer(video)
        return Response(serializer.data)


class UpdateCommentPlanByVideoLinkView(APIView):
    """
    API endpoint (API-key/JWT authenticated) to update TikTok comment plans.

    POST /api/tiktok/update-comment-plan/

    Request body:
        video_link       (str, optional)
        comment_plan_id  (int, optional)
        comment_link     (str, optional)
        is_commented     (bool, optional)

    Validation rules:
        - At least one of ``video_link`` or ``comment_plan_id`` is required.
        - At least one of ``comment_link`` or ``is_commented`` is required.
        - ``comment_plan_id`` must be integer if provided.
        - ``is_commented`` must be boolean if provided.

    Filter behavior:
        - ``video_link`` only: update all plans of current user with that video_link.
        - ``comment_plan_id`` only: update that specific plan (owned by current user).
        - both provided: update plan matching both conditions.

    Example payload (by id only):
        {
            "comment_plan_id": 123,
            "is_commented": true,
            "comment_link": "https://www.tiktok.com/..."
        }

    Success response:
        {
            "updated_count": <int>,
            "comment_plans": [ ...serialized plans... ]
        }
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        video_link = request.data.get('video_link', '').strip()
        comment_plan_id = request.data.get('comment_plan_id')

        if not video_link and comment_plan_id is None:
            return Response(
                {'detail': 'At least one of video_link or comment_plan_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if comment_plan_id is not None:
            if isinstance(comment_plan_id, bool) or not isinstance(comment_plan_id, int):
                return Response(
                    {'detail': 'comment_plan_id must be an integer.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        if 'comment_link' not in request.data and 'is_commented' not in request.data:
            return Response(
                {'detail': 'At least one of comment_link or is_commented is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        plans = TiktokCommentPlan.objects.filter(owner=request.user)
        if video_link:
            plans = plans.filter(video_link=video_link)
        if comment_plan_id is not None:
            plans = plans.filter(id=comment_plan_id)

        if not plans.exists():
            return Response(
                {'detail': 'No comment plan found with provided criteria.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        updates = {}
        if 'comment_link' in request.data:
            comment_link = request.data.get('comment_link')
            if comment_link is None:
                comment_link = ''
            if not isinstance(comment_link, str):
                return Response(
                    {'detail': 'comment_link must be a string.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            updates['comment_link'] = comment_link

        if 'is_commented' in request.data:
            is_commented = request.data.get('is_commented')
            if not isinstance(is_commented, bool):
                return Response(
                    {'detail': 'is_commented must be a boolean.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            updates['is_commented'] = is_commented
        plan_ids = list(plans.values_list('id', flat=True))
        updates['updated_at'] = timezone.now()
        plans.update(**updates)

        if updates.get('is_commented'):
            from task.models import Task, TaskStatus
            from tiktok.execution import handle_task_status_update
            for plan_id in plan_ids:
                task = (
                    Task.objects.filter(
                        payload__comment_plan_id=plan_id,
                        payload__tiktok_comment_plan_cluster_execution=True,
                        owner=request.user,
                    )
                    .exclude(payload__contains={'is_fetch_link': True})
                    .exclude(status__in=[TaskStatus.CANCELLED, TaskStatus.FAILED])
                    .select_related('owner', 'device')
                    .order_by('-created_at')
                    .first()
                )
                if not task:
                    logger.warning('update-comment-plan: no active task found for plan %s, skipping cluster progression', plan_id)
                    continue
                fetch_link_exists = Task.objects.filter(
                    payload__contains={'comment_plan_id': plan_id, 'is_fetch_link': True},
                    owner=request.user,
                ).exclude(status__in=[TaskStatus.CANCELLED, TaskStatus.FAILED]).exists()
                if fetch_link_exists:
                    continue
                old_status = task.status
                if task.status != TaskStatus.COMPLETED:
                    task.status = TaskStatus.COMPLETED
                    task.save(update_fields=['status', 'updated_at'])
                try:
                    handle_task_status_update(task, old_status=old_status, new_status=TaskStatus.COMPLETED)
                except Exception:
                    logger.exception('Failed to process cluster status update for plan %s', plan_id)

        if updates.get('comment_link'):
            from task.models import Task, TaskStatus
            from tiktok.execution import handle_task_status_update
            for plan_id in plan_ids:
                fetch_task = (
                    Task.objects.filter(
                        payload__contains={'comment_plan_id': plan_id, 'is_fetch_link': True},
                        owner=request.user,
                    )
                    .exclude(status__in=[TaskStatus.CANCELLED, TaskStatus.FAILED, TaskStatus.COMPLETED])
                    .select_related('owner', 'device')
                    .order_by('-created_at')
                    .first()
                )
                if not fetch_task:
                    continue
                fetch_task.status = TaskStatus.COMPLETED
                fetch_task.save(update_fields=['status', 'updated_at'])
                try:
                    handle_task_status_update(fetch_task, old_status=TaskStatus.RUNNING, new_status=TaskStatus.COMPLETED)
                except Exception:
                    logger.exception('Failed to process fetch-link cluster status update for plan %s', plan_id)

        serializer = TiktokCommentPlanSerializer(
            TiktokCommentPlan.objects.filter(id__in=plan_ids),
            many=True,
        )
        return Response({'updated_count': len(serializer.data), 'comment_plans': serializer.data})


class TiktokChannelCrawlView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    @staticmethod
    def _is_truthy(value):
        return str(value or '').strip().lower() in {'1', 'true', 'yes', 'on'}

    @staticmethod
    def _safe_int(value, default=0):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _safe_datetime(value):
        if value in (None, ''):
            return None
        if isinstance(value, (int, float)):
            try:
                return datetime.fromtimestamp(value, tz=dt_timezone.utc)
            except (ValueError, OSError, OverflowError):
                return None
        if isinstance(value, str):
            normalized = value.strip()
            if not normalized:
                return None
            try:
                return datetime.fromtimestamp(int(normalized), tz=dt_timezone.utc)
            except (TypeError, ValueError, OSError, OverflowError):
                pass
            parsed = parse_datetime(normalized)
            if parsed is not None and timezone.is_naive(parsed):
                return timezone.make_aware(parsed, dt_timezone.utc)
            return parsed
        return None

    @staticmethod
    def _serialize_video(video: TiktokChannelVideo):
        return {
            'id': video.id,
            'url': video.video_url,
            'title': video.title,
            'description': video.description,
            'hashtags': video.hashtags if isinstance(video.hashtags, list) else [],
            'duration': video.duration,
            'view_count': video.view_count,
            'like_count': video.like_count,
            'comment_count': video.comment_count,
            'share_count': video.share_count,
            'published_at': video.published_at,
            'video_process_task_id': video.video_process_task_id,
            'analyzed_content': video.analyzed_content,
            'is_understand_video': video.is_understand_video,
            'understand_text_overlay': video.understand_text_overlay,
            'understand_content_text': video.understand_content_text,
            'understand_background_description': video.understand_background_description,
            'understand_style_analysis': video.understand_style_analysis,
            'understand_video_analysis': video.understand_video_analysis,
            'understand_video_style': (video.understand_video_analysis or {}).get('video_style', ''),
        }

    def _cached_response(self, channel: TiktokChannel, max_videos: int, cache_hit: bool = True):
        videos = list(channel.videos.order_by('-last_crawled_at', '-updated_at')[:max_videos])
        return Response(
            {
                'channel_url': channel.channel_url,
                'count': len(videos),
                'videos': [self._serialize_video(video) for video in videos],
                'last_crawled_at': channel.last_crawled_at,
                'cache_hit': cache_hit,
            },
            status=status.HTTP_200_OK,
        )

    def post(self, request):
        channel_url = str(request.data.get('channel_url', '') or '').strip()
        if not channel_url:
            return Response(
                {'detail': 'channel_url is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        max_videos = self._safe_int(request.data.get('max_videos'), default=100)
        if max_videos < 1:
            return Response(
                {'detail': 'max_videos must be at least 1.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        max_videos = min(max_videos, 500)

        no_cache = (
            self._is_truthy(request.query_params.get('no-cache'))
            or self._is_truthy(request.query_params.get('no_cache'))
        )

        channel = TiktokChannel.objects.filter(channel_url=channel_url).first()
        if (
            channel
            and channel.last_crawled_at
            and channel.last_crawled_at >= timezone.now() - TIKTOK_CHANNEL_CACHE_TTL
            and not no_cache
        ):
            return self._cached_response(channel, max_videos=max_videos)

        crawl_url = settings.TIKTOK_CHANNEL_CRAWL_API_URL
        crawl_timeout = self._safe_int(
            getattr(settings, 'TIKTOK_CHANNEL_CRAWL_TIMEOUT_SECONDS', DEFAULT_TIKTOK_CHANNEL_CRAWL_TIMEOUT_SECONDS),
            default=DEFAULT_TIKTOK_CHANNEL_CRAWL_TIMEOUT_SECONDS,
        )

        try:
            external_response = _post_with_retry_using_proxy(
                crawl_url,
                payload={
                    'channel_url': channel_url,
                    'max_videos': max_videos,
                },
                timeout=max(crawl_timeout, 1),
            )
        except http_requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            detail = (
                f'TikTok crawl service returned HTTP {status_code}.'
                if status_code is not None
                else 'TikTok crawl service returned an HTTP error (status unknown).'
            )
            return Response(
                {'detail': detail},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except http_requests.RequestException as exc:
            logger.exception('tiktok-channel-crawl: external call failed: %s', exc)
            return Response(
                {'detail': 'Failed to reach TikTok crawl service.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            payload = external_response.json()
        except ValueError:
            return Response(
                {'detail': 'TikTok crawl service returned non-JSON.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        videos = payload.get('videos') if isinstance(payload, dict) else []
        if not isinstance(videos, list):
            videos = []

        crawled_at = timezone.now()
        with transaction.atomic():
            channel, _ = TiktokChannel.objects.get_or_create(channel_url=channel_url)
            channel.last_crawled_at = crawled_at
            channel.last_crawl_video_count = len(videos)
            channel.save(update_fields=['last_crawled_at', 'last_crawl_video_count', 'updated_at'])

            for item in videos:
                if not isinstance(item, dict):
                    continue
                video_url = str(item.get('url', '') or '').strip()
                if not video_url:
                    continue
                hashtags = item.get('hashtags')
                defaults = {
                    'title': str(item.get('title', ''))[:TIKTOK_CHANNEL_VIDEO_TITLE_MAX_LENGTH],
                    'description': str(item.get('description', '')),
                    'hashtags': hashtags if isinstance(hashtags, list) else [],
                    'duration': max(self._safe_int(item.get('duration'), default=0), 0),
                    'view_count': max(self._safe_int(item.get('view_count'), default=0), 0),
                    'like_count': max(self._safe_int(item.get('like_count'), default=0), 0),
                    'comment_count': max(self._safe_int(item.get('comment_count'), default=0), 0),
                    'share_count': max(self._safe_int(item.get('share_count'), default=0), 0),
                    'published_at': (
                        self._safe_datetime(item.get('published_at'))
                        or self._safe_datetime(item.get('create_time'))
                        or self._safe_datetime(item.get('timestamp'))
                    ),
                    'last_crawled_at': crawled_at,
                }
                TiktokChannelVideo.objects.update_or_create(
                    video_url=video_url,
                    defaults={
                        'channel': channel,
                        **defaults,
                    },
                )

        return self._cached_response(channel, max_videos=max_videos, cache_hit=False)


class TiktokChannelKeywordExtractionView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    @staticmethod
    def _normalize_keywords(values):
        seen = set()
        normalized = []
        for value in values:
            if not isinstance(value, str):
                continue
            keyword = value.strip()
            if not keyword:
                continue
            lowered = keyword.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(keyword)
        return normalized

    @staticmethod
    def _parse_keyword_payload(raw_text):
        raw = str(raw_text or '').strip()
        if not raw:
            return []
        if raw.startswith('```'):
            lines = raw.splitlines()
            if lines and lines[0].startswith('```'):
                lines = lines[1:]
            if lines and lines[-1].strip() == '```':
                lines = lines[:-1]
            raw = '\n'.join(lines).strip()
        if not raw:
            return []

        obj_start = raw.find('{')
        obj_end = raw.rfind('}')
        arr_start = raw.find('[')
        arr_end = raw.rfind(']')
        if obj_start != -1 and obj_end != -1 and obj_end > obj_start:
            raw = raw[obj_start:obj_end + 1]
        elif arr_start != -1 and arr_end != -1 and arr_end > arr_start:
            raw = raw[arr_start:arr_end + 1]

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError('Groq returned malformed JSON.') from exc
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            raise ValueError('Groq did not return a JSON object.')
        keywords = payload.get('keywords')
        if not isinstance(keywords, list):
            raise ValueError('Groq JSON object must include "keywords" array.')
        return keywords

    @staticmethod
    def _build_context(videos):
        blocks = []
        for index, video in enumerate(videos, start=1):
            parts = []
            title = (video.title or '').strip()
            description = (video.description or '').strip()
            content_text = (video.understand_content_text or '').strip()
            if title:
                parts.append(f'Title: {title}')
            if description:
                parts.append(f'Description: {description}')
            if content_text:
                parts.append(f'Understand Content Text: {content_text}')
            if not parts:
                continue
            blocks.append(f'Video {index}:\n' + '\n'.join(parts))
        return '\n\n'.join(blocks)

    def post(self, request):
        channel_url = str(request.data.get('channel_url', '') or '').strip()
        if not channel_url:
            return Response({'detail': 'channel_url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        max_videos = TiktokChannelCrawlView._safe_int(request.data.get('max_videos'), default=100)
        if max_videos < 1:
            return Response({'detail': 'max_videos must be at least 1.'}, status=status.HTTP_400_BAD_REQUEST)
        max_videos = min(max_videos, 500)

        api_key = str(getattr(settings, 'GROQ_API_KEY', '') or '').strip()
        if not api_key:
            return Response(
                {'detail': 'Groq API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        channel = TiktokChannel.objects.filter(channel_url=channel_url).first()
        if not channel:
            return Response(
                {'detail': 'Channel data not found. Please analyze the channel first.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        videos = list(channel.videos.order_by('-last_crawled_at', '-updated_at')[:max_videos])
        if not videos:
            return Response({'channel_url': channel_url, 'count': 0, 'keywords': []})

        context = self._build_context(videos)
        if not context:
            return Response({'channel_url': channel_url, 'count': len(videos), 'keywords': []})

        try:
            from groq import Groq  # noqa: PLC0415
            client = Groq(api_key=api_key)
            completion = client.chat.completions.create(
                model='meta-llama/llama-4-scout-17b-16e-instruct',
                messages=[
                    {
                        'role': 'system',
                        'content': (
                            'Bạn là chuyên gia bóc tách keyword dựa trên nội dung, tập trung vào các thực thể, '
                            'tên riêng, chủ đề topic để phân tích xu hướng và insight. '
                            'Chỉ trả về JSON đúng định dạng {"keywords": ["keyword1", "keyword2"]}.'
                        ),
                    },
                    {
                        'role': 'user',
                        'content': f'Nội dung:\n\n{context[:50000]} \n\nHãy trích xuất các keyword quan trọng nhất từ nội dung trên, tập trung vào thực thể, tên riêng, chủ đề, xu hướng. Trả về kết quả dưới dạng JSON với định dạng: {{"keywords": ["keyword1", "keyword2", ...]}}. Chỉ trả về JSON, không giải thích gì thêm.',
                    },
                ],
                temperature=0.3,
                max_tokens=1024,
            )
            raw_content = ''
            if completion.choices and completion.choices[0].message:
                raw_content = completion.choices[0].message.content or ''
            keywords = self._normalize_keywords(self._parse_keyword_payload(raw_content))
        except Exception as exc:
            logger.exception('tiktok-channel-keyword-extract: groq call failed: %s', exc)
            return Response(
                {'detail': 'Failed to extract channel keywords.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'channel_url': channel_url, 'count': len(videos), 'keywords': keywords})


class TiktokChannelVideoProcessView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get(self, request, pk: int):
        video = TiktokChannelVideo.objects.filter(pk=pk).first()
        if not video:
            return Response({'detail': 'TiktokChannelVideo not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(TiktokChannelCrawlView._serialize_video(video))

    def post(self, request, pk: int):
        video = TiktokChannelVideo.objects.filter(pk=pk).first()
        if not video:
            return Response({'detail': 'TiktokChannelVideo not found.'}, status=status.HTTP_404_NOT_FOUND)

        if not video.video_url:
            return Response(
                {'detail': 'video_url is empty. Cannot process video without a URL.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/tiktok/analyze-video'

        language = str(request.data.get('language', '') or '').strip() or 'vi'

        body = {'tiktok_url': video.video_url, 'language': language}
        try:
            resp = http_requests.post(endpoint, json=body, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except http_requests.exceptions.RequestException as exc:
            logger.exception('tiktok-channel-video-process: external API error: %s', exc)
            return Response(
                {'detail': 'Failed to call video processing service. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        task_id = data.get('task_id')
        if not task_id:
            return Response(
                {'detail': 'Video processing service did not return a task_id.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        video.video_process_task_id = str(task_id)
        video.is_understand_video = False
        video.save(update_fields=['video_process_task_id', 'is_understand_video', 'updated_at'])

        return Response(
            {
                'task_id': str(task_id),
                'video': TiktokChannelCrawlView._serialize_video(video),
            }
        )


class TiktokChannelVideoRepostView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request, pk: int):
        video = TiktokChannelVideo.objects.filter(pk=pk).first()
        if not video:
            return Response({'detail': 'TiktokChannelVideo not found.'}, status=status.HTTP_404_NOT_FOUND)

        content_text = str(request.data.get('content_text', '') or '').strip()
        if not content_text:
            return Response({'detail': 'content_text is required.'}, status=status.HTTP_400_BAD_REQUEST)

        scheduled_at_raw = str(request.data.get('scheduled_at', '') or '').strip()

        profile_id = request.data.get('profile_id') or None
        background_description = str(request.data.get('background_description', '') or '').strip() or None
        concept_music = str(request.data.get('concept_music', '') or '').strip() or None
        uploaded_music_file = request.FILES.get('music_file') or None
        uploaded_ref_image = request.FILES.get('ref_image') or None
        style = str(request.data.get('style', '') or '').strip() or None
        duration_raw = request.data.get('duration')
        duration = int(duration_raw) if duration_raw not in (None, '', 'null') else None
        animation_raw = request.data.get('animation')
        animation = None
        if animation_raw is not None:
            if isinstance(animation_raw, bool):
                animation = 'true' if animation_raw else 'false'
            elif str(animation_raw).lower() in ('true', '1', 'yes'):
                animation = 'true'
            else:
                animation = 'false'

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/text-videos'

        form_data = {'content_text': content_text}
        if background_description:
            form_data['background_description'] = background_description
        if concept_music:
            form_data['concept_music'] = concept_music
        if style:
            form_data['style'] = style
        if duration is not None:
            form_data['duration'] = str(duration)
        if animation is not None:
            form_data['animation'] = animation

        files = {}
        if uploaded_music_file:
            files['music_file'] = (uploaded_music_file.name, uploaded_music_file.read(), uploaded_music_file.content_type)
        if uploaded_ref_image:
            files['ref_image'] = (uploaded_ref_image.name, uploaded_ref_image.read(), uploaded_ref_image.content_type)
        if not files:
            files = None

        logger.info('tiktok-repost: POST %s form_data=%s has_file=%s has_ref_image=%s', endpoint, form_data, files is not None, uploaded_ref_image is not None)
        try:
            resp = http_requests.post(endpoint, data=form_data, files=files, timeout=60)
            resp.raise_for_status()
            data = resp.json()
        except http_requests.exceptions.RequestException as exc:
            logger.exception('tiktok-repost: genvideo error: %s', exc)
            return Response({'detail': 'Failed to call video generation service.'}, status=status.HTTP_502_BAD_GATEWAY)

        task_id = data.get('task_id')
        if not task_id:
            return Response(
                {'detail': 'Video generation service did not return a task_id.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        from .video_understand import start_repost_background_poll
        
        # Clean description by stripping trailing hashtags to prevent duplicate hashing
        desc_raw = video.description or ''
        words = desc_raw.split()
        while words and words[-1].startswith('#'):
            words.pop()
        clean_caption = ' '.join(words)
        original_hashtags = video.hashtags if isinstance(video.hashtags, list) else []

        start_repost_background_poll(
            genvideo_task_id=str(task_id),
            profile_id=int(profile_id) if profile_id else None,
            scheduled_at=scheduled_at_raw,
            content_text=content_text,
            owner_id=request.user.pk,
            caption=clean_caption,
            hashtags=original_hashtags,
        )

        return Response(
            {'genvideo_task_id': str(task_id), 'estimated_seconds': data.get('estimated_seconds')},
            status=status.HTTP_202_ACCEPTED,
        )


class GenerateTextVideoView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        content_text = str(request.data.get('content_text', '') or '').strip()
        if not content_text:
            return Response({'detail': 'content_text is required.'}, status=status.HTTP_400_BAD_REQUEST)

        background_description = str(request.data.get('background_description', '') or '').strip() or None
        concept_music = str(request.data.get('concept_music', '') or '').strip() or None
        uploaded_music_file = request.FILES.get('music_file') or None
        uploaded_ref_image = request.FILES.get('ref_image') or None
        # ref_image_url lets the caller reference an already-hosted image (e.g. a
        # character's media) instead of uploading — we fetch it server-side.
        ref_image_url = str(request.data.get('ref_image_url', '') or '').strip() or None
        style = str(request.data.get('style', '') or '').strip() or None
        duration_raw = request.data.get('duration')
        duration = int(duration_raw) if duration_raw not in (None, '', 'null') else None
        animation_raw = request.data.get('animation')
        animation = None
        if animation_raw is not None:
            if isinstance(animation_raw, bool):
                animation = 'true' if animation_raw else 'false'
            elif str(animation_raw).lower() in ('true', '1', 'yes'):
                animation = 'true'
            else:
                animation = 'false'

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/text-videos'

        form_data = {'content_text': content_text}
        if background_description:
            form_data['background_description'] = background_description
        if concept_music:
            form_data['concept_music'] = concept_music
        if style:
            form_data['style'] = style
        if duration is not None:
            form_data['duration'] = str(duration)
        if animation is not None:
            form_data['animation'] = animation

        files = {}
        if uploaded_music_file:
            files['music_file'] = (uploaded_music_file.name, uploaded_music_file.read(), uploaded_music_file.content_type)
        if uploaded_ref_image:
            files['ref_image'] = (uploaded_ref_image.name, uploaded_ref_image.read(), uploaded_ref_image.content_type)
        elif ref_image_url:
            try:
                # Host-aware: Cloudfly URLs via boto3 (private bucket), SeaweedFS
                # / other public hosts via plain HTTP — a Cloudfly-only client
                # 404s (NoSuchKey) on SeaweedFS-hosted ref images.
                from facebook.views import _download_image_bytes
                raw_img, fname = _download_image_bytes(ref_image_url)
                files['ref_image'] = (fname or 'ref.png', raw_img, 'image/png')
            except Exception as exc:  # noqa: BLE001 — ref image is optional, log + continue
                logger.warning('generate-text-video: ref_image_url fetch failed: %s', exc)
        if not files:
            files = None

        logger.info('generate-text-video: POST %s form_data=%s has_file=%s', endpoint, form_data, files is not None)
        try:
            resp = http_requests.post(endpoint, data=form_data, files=files, timeout=60)
        except http_requests.exceptions.RequestException as exc:
            logger.exception('generate-text-video: connection error: %s', exc)
            return Response({'detail': 'Failed to call video generation service.', 'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        logger.info('generate-text-video: response status=%s body=%s', resp.status_code, resp.text[:500])
        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            return Response(
                {'detail': 'Video generation service returned an error.', 'status_code': resp.status_code, 'response': err_body},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            data = resp.json()
        except Exception:
            return Response({'detail': 'Video generation service returned invalid JSON.', 'response': resp.text[:500]}, status=status.HTTP_502_BAD_GATEWAY)

        task_id = data.get('task_id')
        if not task_id:
            return Response(
                {'detail': 'Video generation service did not return a task_id.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'genvideo_task_id': str(task_id), 'estimated_seconds': data.get('estimated_seconds')}, status=status.HTTP_202_ACCEPTED)


class GenerateSceneVideoView(APIView):
    """Scene/animated video via genvideo ``/api/script-to-video``.

    Mirrors :class:`GenerateTextVideoView` but for the "video hoạt cảnh" flow:
    a prompt + reference image drive a short cinematic clip. Returns a
    ``genvideo_task_id`` the caller hands to ``characters/{id}/watch-video-task``
    so the finished clip is polled and saved to the character in the background.
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        prompt = str(request.data.get('prompt', '') or '').strip()
        if not prompt:
            return Response({'detail': 'prompt is required.'}, status=status.HTTP_400_BAD_REQUEST)

        # size: only tiktok / youtube are valid; default youtube.
        size = str(request.data.get('size', '') or '').strip().lower()
        if size not in ('tiktok', 'youtube'):
            size = 'youtube'
        # mode 'boomerang' → the genvideo UNLIMITED endpoint: longer clips
        # (5 / 15 / 30s, default 15) with a fixed "natural action" prompt.
        # Default 'scene' → the short ≤5s cinematic clip endpoint.
        mode = str(request.data.get('mode', '') or '').strip().lower()
        unlimited = mode == 'boomerang'
        max_dur = 30 if unlimited else 5
        default_dur = 15 if unlimited else 5
        duration_raw = request.data.get('duration')
        try:
            duration = int(duration_raw) if duration_raw not in (None, '', 'null') else default_dur
        except (TypeError, ValueError):
            duration = default_dur
        duration = max(1, min(duration, max_dur))

        uploaded_ref_image = request.FILES.get('ref_image') or None
        ref_image_url = str(request.data.get('ref_image_url', '') or '').strip() or None

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = (
            f'{api_url.rstrip("/")}/api/script-to-video-unlimited' if unlimited
            else f'{api_url.rstrip("/")}/api/script-to-video'
        )

        form_data = {'prompt': prompt, 'duration': str(duration), 'size': size}

        files = {}
        if uploaded_ref_image:
            files['ref_image'] = (uploaded_ref_image.name, uploaded_ref_image.read(), uploaded_ref_image.content_type)
        elif ref_image_url:
            try:
                # Host-aware: Cloudfly URLs via boto3 (private bucket), SeaweedFS
                # / other public hosts via plain HTTP — a Cloudfly-only client
                # 404s (NoSuchKey) on SeaweedFS-hosted ref images.
                from facebook.views import _download_image_bytes
                raw_img, fname = _download_image_bytes(ref_image_url)
                files['ref_image'] = (fname or 'ref.png', raw_img, 'image/png')
            except Exception as exc:  # noqa: BLE001 — ref image is optional, log + continue
                logger.warning('generate-scene-video: ref_image_url fetch failed: %s', exc)
        if not files:
            files = None

        logger.info('generate-scene-video: POST %s form_data=%s has_file=%s', endpoint, form_data, files is not None)
        try:
            resp = http_requests.post(endpoint, data=form_data, files=files, timeout=60)
        except http_requests.exceptions.RequestException as exc:
            logger.exception('generate-scene-video: connection error: %s', exc)
            return Response({'detail': 'Failed to call video generation service.', 'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        logger.info('generate-scene-video: response status=%s body=%s', resp.status_code, resp.text[:500])
        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            return Response(
                {'detail': 'Video generation service returned an error.', 'status_code': resp.status_code, 'response': err_body},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            data = resp.json()
        except Exception:
            return Response({'detail': 'Video generation service returned invalid JSON.', 'response': resp.text[:500]}, status=status.HTTP_502_BAD_GATEWAY)

        task_id = data.get('task_id')
        if not task_id:
            return Response(
                {'detail': 'Video generation service did not return a task_id.', 'response': data},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'genvideo_task_id': str(task_id), 'estimated_seconds': data.get('estimated_seconds')}, status=status.HTTP_202_ACCEPTED)


class TextVideoTaskStatusView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get(self, request, task_id: str):
        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/tasks/{task_id}'

        try:
            resp = http_requests.get(endpoint, headers={'accept': 'application/json'}, timeout=15)
            resp.raise_for_status()
            return Response(resp.json())
        except http_requests.exceptions.RequestException as exc:
            logger.exception('text-video-task-status: external API error: %s', exc)
            return Response({'detail': 'Failed to fetch task status.'}, status=status.HTTP_502_BAD_GATEWAY)


class ScheduleTiktokVideoView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        from datetime import datetime, timezone as dt_timezone
        from schedule.models import Schedule, ScheduleType, ScheduleStatus

        link_download = str(request.data.get('link_download', '') or '').strip()
        if not link_download:
            return Response({'detail': 'link_download is required.'}, status=status.HTTP_400_BAD_REQUEST)

        scheduled_at_raw = str(request.data.get('scheduled_at', '') or '').strip()
        if not scheduled_at_raw:
            return Response({'detail': 'scheduled_at is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            run_at = datetime.fromisoformat(scheduled_at_raw.replace('Z', '+00:00'))
            if run_at.tzinfo is None:
                run_at = run_at.replace(tzinfo=dt_timezone.utc)
        except ValueError:
            return Response({'detail': 'scheduled_at must be a valid ISO datetime.'}, status=status.HTTP_400_BAD_REQUEST)

        profile_id = request.data.get('profile_id') or None

        # Caption + hashtags travel in the Kafka payload; the device agent's
        # video-upload tool reads them (keys: caption / hashtags) and types them
        # on TikTok's caption screen before posting. '#' is stripped — the worker
        # re-adds it. hashtags arrives as a JSON list (or a parseable string).
        def _as_list(raw):
            import json as _json
            if isinstance(raw, (list, tuple)):
                return list(raw)
            try:
                parsed = _json.loads(raw or '[]')
                return parsed if isinstance(parsed, list) else []
            except (ValueError, TypeError):
                return []

        caption = str(request.data.get('caption', '') or '').strip()
        hashtags = [str(h).strip().lstrip('#') for h in _as_list(request.data.get('hashtags')) if str(h).strip()]

        _goal = f'Hãy tải video từ {link_download} và đăng lên TikTok'
        if caption or hashtags:
            _goal += ' kèm caption và hashtag (đã có sẵn trong payload — tool tự đọc).'
        else:
            _goal += '.'

        task = Task.objects.create(
            name='Share TikTok video',
            description=_goal,
            task_type=TaskType.GENERIC,
            status=TaskStatus.PENDING,
            payload={
                'agent': 'tiktok',
                'link_download': link_download,
                'profile_id': profile_id,
                'scheduled_at': scheduled_at_raw,
                'caption': caption,
                'hashtags': hashtags,
            },
            owner=request.user,
        )

        Schedule.objects.create(
            task=task,
            profile_id=profile_id,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )

        return Response({'task_id': task.id, 'status': task.status}, status=status.HTTP_202_ACCEPTED)


class GenvideoHighlightsView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        youtube_url = str(request.data.get('youtube_url', '') or '').strip()
        if not youtube_url:
            return Response({'detail': 'youtube_url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/highlights'

        try:
            resp = http_requests.post(endpoint, json={'youtube_url': youtube_url}, timeout=60)
        except http_requests.exceptions.RequestException as exc:
            logger.exception('genvideo-highlights: connection error: %s', exc)
            return Response({'detail': 'Failed to call highlights service.', 'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            return Response(
                {'detail': 'Highlights service returned an error.', 'status_code': resp.status_code, 'response': err_body},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            data = resp.json()
        except Exception:
            return Response({'detail': 'Highlights service returned invalid JSON.'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(data, status=status.HTTP_202_ACCEPTED)


class GenvideoTodayVideosView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get(self, request):
        page = request.query_params.get('page', '1')
        size = request.query_params.get('size', '10')

        api_url = getattr(settings, 'GENVIDEO_API_URL', 'https://genvideo.example.com')
        endpoint = f'{api_url.rstrip("/")}/api/today-videos'

        try:
            resp = http_requests.get(endpoint, params={'page': page, 'size': size}, timeout=15)
            resp.raise_for_status()
            return Response(resp.json())
        except http_requests.exceptions.RequestException as exc:
            logger.exception('genvideo-today-videos: connection error: %s', exc)
            return Response({'detail': 'Failed to fetch today videos.', 'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)


class UpdateChannelVideoContentView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        video_process_task_id = str(request.data.get('video_process_task_id', '') or '').strip()
        if not video_process_task_id:
            return Response(
                {'detail': 'video_process_task_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if 'content' not in request.data:
            return Response(
                {'detail': 'content is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            video = TiktokChannelVideo.objects.get(video_process_task_id=video_process_task_id)
        except TiktokChannelVideo.DoesNotExist:
            return Response(
                {'detail': 'No channel video found with that video_process_task_id.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        video.analyzed_content = str(request.data.get('content', '') or '')
        video.is_understand_video = True
        if 'understand_text_overlay' in request.data:
            video.understand_text_overlay = str(request.data.get('understand_text_overlay', '') or '')
        if 'understand_content_text' in request.data:
            video.understand_content_text = str(request.data.get('understand_content_text', '') or '')
        if 'understand_background_description' in request.data:
            video.understand_background_description = str(request.data.get('understand_background_description', '') or '')
        if 'understand_style_analysis' in request.data:
            video.understand_style_analysis = str(request.data.get('understand_style_analysis', '') or '')
        if 'understand_video_analysis' in request.data:
            payload = request.data.get('understand_video_analysis')
            video.understand_video_analysis = payload if isinstance(payload, dict) else None

        video.save(
            update_fields=[
                'analyzed_content',
                'is_understand_video',
                'understand_text_overlay',
                'understand_content_text',
                'understand_background_description',
                'understand_style_analysis',
                'understand_video_analysis',
                'updated_at',
            ]
        )

        return Response(TiktokChannelCrawlView._serialize_video(video))
