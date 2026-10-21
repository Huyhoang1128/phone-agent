"""Views cho Chatbot TikTok Inbox (Phase 2.3).

Phase 2.3.1: `GET /api/tiktok-conversations/?device_id=X` — list peer per device.

Tách module riêng khỏi `tiktok/views.py` (3400+ dòng) để không lẫn với code
TikTok cũ. Xem `docs/Chatbot_Tiktok/design.md` mục 13 + HANDOFF.md.

Authorization model:
- Mỗi `Device` có `owner` + `team` + `team_permission` (giống các resource khác).
- User access conversation = access device đó (qua `_can_access_device`).
- KHÔNG dùng `OwnedResourceMixin` vì `TiktokMessage` không có owner/team trực
  tiếp — scope qua parent `Device`.
"""
from __future__ import annotations

import logging

from django.db.models import Count, Max, Min, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView
from users.authentication import VersionedJWTAuthentication as JWTAuthentication

from api_keys.authentication import ApiKeyAuthentication
from devices.models import Device
from teams.models import TeamMembership

from .inbox_serializers import (
    TiktokConversationListItemSerializer,
    TiktokMessageSerializer,
    TiktokPeerMuteSerializer,
)
from .models import TiktokMessage, TiktokPeerMute

logger = logging.getLogger(__name__)


# ── Authorization helper ─────────────────────────────────────────────────────


def _can_access_device(device: Device, user) -> bool:
    """User có quyền access device này không?

    Cùng pattern với `DeviceViewSet._can_access_device` (devices/views.py:106-112).
    """
    if device.owner_id == user.id:
        return True
    if device.team_id is not None:
        return TeamMembership.objects.filter(team_id=device.team_id, user=user).exists()
    return False


# ── 2.3.1: List conversations per device ─────────────────────────────────────


# Default limit cho list peer; FE virtual scroll nên không quá quan trọng.
DEFAULT_CONVERSATIONS_LIMIT = 200
MAX_CONVERSATIONS_LIMIT = 500


class TiktokConversationListView(APIView):
    """`GET /api/tiktok-conversations/?device_id=X[&limit=200]`

    Trả về list peer của 1 device, sort theo last_message_at DESC.
    Mỗi item gồm: peer_handle, last_message (content/type/channel/created_at),
    message_count, mute status.

    Query strategy (2 query, portable cả Postgres + SQLite):
    1. GROUP BY peer_handle → `(peer_handle, last_message_at, message_count)`,
       ORDER BY last_message_at DESC, LIMIT N → top N peer.
    2. Bulk fetch last message của N peer đó qua `(peer_handle, created_at)` cùng
       với mute status.
    """

    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        device_id_raw = request.query_params.get('device_id')
        if not device_id_raw:
            return Response(
                {'detail': 'device_id query param is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            device_id = int(device_id_raw)
        except (TypeError, ValueError):
            return Response(
                {'detail': 'device_id must be an integer.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        limit_raw = request.query_params.get('limit', DEFAULT_CONVERSATIONS_LIMIT)
        try:
            limit = int(limit_raw)
        except (TypeError, ValueError):
            limit = DEFAULT_CONVERSATIONS_LIMIT
        limit = max(1, min(limit, MAX_CONVERSATIONS_LIMIT))

        device = get_object_or_404(Device, pk=device_id)
        if not _can_access_device(device, request.user):
            return Response(
                {'detail': 'You do not have access to this device.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Query 1: aggregate per peer, sort by recency, LIMIT.
        agg_rows = list(
            TiktokMessage.objects
            .filter(device_id=device_id, is_active=True)
            .values('peer_handle')
            .annotate(
                last_message_at=Max('created_at'),
                message_count=Count('id'),
            )
            .order_by('-last_message_at')[:limit]
        )

        if not agg_rows:
            return Response({
                'device_id': device_id,
                'device_name': device.name,
                'total': 0,
                'conversations': [],
            })

        peer_handles = [row['peer_handle'] for row in agg_rows]
        last_at_by_peer = {row['peer_handle']: row['last_message_at'] for row in agg_rows}
        count_by_peer = {row['peer_handle']: row['message_count'] for row in agg_rows}

        # Query 2: bulk fetch last message per peer. Lấy theo
        # `(peer_handle, created_at=last_at)` — chính xác hơn so order_by trên
        # toàn bộ rồi pick first (đúng cho trường hợp 2 message cùng created_at
        # cực hiếm).
        last_msg_qs = TiktokMessage.objects.filter(
            device_id=device_id,
            peer_handle__in=peer_handles,
            is_active=True,
        ).order_by('peer_handle', '-created_at', '-id')

        last_msg_by_peer: dict[str, TiktokMessage] = {}
        for msg in last_msg_qs:
            if msg.peer_handle not in last_msg_by_peer:
                last_msg_by_peer[msg.peer_handle] = msg

        # Query 3: mute status — filter chỉ peer trong batch + active mute.
        now = timezone.now()
        muted_qs = (
            TiktokPeerMute.objects
            .filter(device_id=device_id, peer_handle__in=peer_handles)
            .filter(Q(muted_until__isnull=True) | Q(muted_until__gte=now))
            .values('peer_handle', 'muted_until')
        )
        mute_by_peer = {row['peer_handle']: row['muted_until'] for row in muted_qs}

        # Build response items theo thứ tự agg_rows (đã sort by last_message_at DESC).
        items: list[dict] = []
        for row in agg_rows:
            peer = row['peer_handle']
            last_msg = last_msg_by_peer.get(peer)
            if last_msg is None:
                # Edge case: agg cho ra peer nhưng query 2 không trả về
                # (race với delete giữa 2 query). Skip.
                logger.warning(
                    'List conversations: peer=%s missing last_msg row (device_id=%s)',
                    peer, device_id,
                )
                continue
            is_muted = peer in mute_by_peer
            items.append({
                'peer_handle': peer,
                'last_message_at': last_at_by_peer[peer],
                'last_message_content': last_msg.content,
                'last_message_type': last_msg.message_type,
                'last_message_channel': last_msg.channel,
                'last_message_is_preview': last_msg.is_preview,
                'message_count': count_by_peer[peer],
                'is_muted': is_muted,
                'muted_until': mute_by_peer.get(peer) if is_muted else None,
            })

        serialized = TiktokConversationListItemSerializer(items, many=True).data
        return Response({
            'device_id': device_id,
            'device_name': device.name,
            'total': len(serialized),
            'limit': limit,
            'conversations': serialized,
        })


# ── Helper: resolve device + check perm cho query-param style endpoint ──────


def _resolve_device_or_response(request, device_id_param='device_id'):
    """Parse `device_id` từ query params, load Device, verify permission.

    Trả về `(device, None)` nếu OK, hoặc `(None, Response)` để view return luôn.
    Tránh duplicate boilerplate 3 view dưới (detail, messages, mute).
    """
    device_id_raw = request.query_params.get(device_id_param)
    if not device_id_raw:
        return None, Response(
            {'detail': f'{device_id_param} query param is required.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        device_id = int(device_id_raw)
    except (TypeError, ValueError):
        return None, Response(
            {'detail': f'{device_id_param} must be an integer.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    device = get_object_or_404(Device, pk=device_id)
    if not _can_access_device(device, request.user):
        return None, Response(
            {'detail': 'You do not have access to this device.'},
            status=status.HTTP_403_FORBIDDEN,
        )
    return device, None


# ── 2.3.2: Conversation detail + messages history ────────────────────────────


# Note: dùng query param `peer_handle` (KHÔNG path) vì TikTok username free-form
# có thể chứa `/`, space, unicode — path converter dễ ambiguous với pattern
# `.../messages/`. Khác chút so với design.md mục 13 (gốc đề xuất path style)
# nhưng robust hơn và FE đỡ phải URL-encode 2 lần.

DEFAULT_MESSAGES_LIMIT = 50
MAX_MESSAGES_LIMIT = 200


class TiktokConversationDetailView(APIView):
    """`GET /api/tiktok-conversations/detail/?device_id=X&peer_handle=Y`

    Trả về metadata 1 conversation: counts, range thời gian, channel set,
    mute status. KHÔNG bao gồm danh sách message — gọi `messages/` endpoint
    riêng để load history (lazy).
    """

    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        device, err = _resolve_device_or_response(request)
        if err is not None:
            return err

        peer_handle = (request.query_params.get('peer_handle') or '').strip()
        if not peer_handle:
            return Response(
                {'detail': 'peer_handle query param is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        qs = TiktokMessage.objects.filter(
            device=device, peer_handle=peer_handle, is_active=True,
        )
        agg = qs.aggregate(
            message_count=Count('id'),
            first_message_at=Min('created_at'),
            last_message_at=Max('created_at'),
        )
        if agg['message_count'] == 0:
            return Response(
                {'detail': 'Conversation not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        # Clear ordering trước distinct — Meta.ordering trong TiktokMessage
        # (`-created_at`) làm distinct trên non-aggregated query không dedup
        # đúng. Dùng `set()` cho đơn giản (channel chỉ có 2 giá trị).
        channels = sorted(set(qs.values_list('channel', flat=True)))

        now = timezone.now()
        mute = (
            TiktokPeerMute.objects
            .filter(device=device, peer_handle=peer_handle)
            .filter(Q(muted_until__isnull=True) | Q(muted_until__gte=now))
            .first()
        )

        return Response({
            'device_id': device.id,
            'device_name': device.name,
            'peer_handle': peer_handle,
            'message_count': agg['message_count'],
            'first_message_at': agg['first_message_at'],
            'last_message_at': agg['last_message_at'],
            'channels': channels,
            'is_muted': mute is not None,
            'mute_id': mute.id if mute else None,
            'muted_until': mute.muted_until if mute else None,
            'mute_note': mute.note if mute else '',
        })


class TiktokConversationMessagesView(APIView):
    """`GET /api/tiktok-conversations/messages/?device_id=X&peer_handle=Y&limit=50&before=<id>`

    Cursor pagination: `before=<message_id>` → trả về messages có `id < before`,
    sort by `-created_at, -id` (newest first). Khi không có `before` → batch
    đầu tiên (newest).

    Response messages order: **DESC** (newest first). FE tự reverse khi render
    bottom-up nếu cần. `next_before` = id của message cũ nhất trong batch (dùng
    cho lần fetch tiếp).
    """

    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        device, err = _resolve_device_or_response(request)
        if err is not None:
            return err

        peer_handle = (request.query_params.get('peer_handle') or '').strip()
        if not peer_handle:
            return Response(
                {'detail': 'peer_handle query param is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Parse limit
        try:
            limit = int(request.query_params.get('limit') or DEFAULT_MESSAGES_LIMIT)
        except (TypeError, ValueError):
            limit = DEFAULT_MESSAGES_LIMIT
        limit = max(1, min(limit, MAX_MESSAGES_LIMIT))

        # Parse cursor
        before_raw = request.query_params.get('before')
        before_id: int | None = None
        if before_raw:
            try:
                before_id = int(before_raw)
            except (TypeError, ValueError):
                return Response(
                    {'detail': 'before must be an integer (message id).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        qs = TiktokMessage.objects.filter(
            device=device, peer_handle=peer_handle, is_active=True,
        ).select_related('source_task', 'source_notification')

        if before_id is not None:
            qs = qs.filter(id__lt=before_id)

        # Fetch limit+1 để biết has_more.
        rows = list(qs.order_by('-created_at', '-id')[:limit + 1])
        has_more = len(rows) > limit
        rows = rows[:limit]

        serialized = TiktokMessageSerializer(rows, many=True).data

        next_before = rows[-1].id if has_more and rows else None
        return Response({
            'device_id': device.id,
            'peer_handle': peer_handle,
            'limit': limit,
            'has_more': has_more,
            'next_before': next_before,
            'messages': serialized,
        })


# ── 2.3.3: TiktokPeerMute CRUD ──────────────────────────────────────────────


def _user_accessible_device_ids(user) -> list[int]:
    """Trả về list device_id user có quyền (owner hoặc team member)."""
    team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
    return list(
        Device.objects.filter(
            Q(owner=user) | Q(team_id__in=team_ids),
        ).values_list('id', flat=True)
    )


class TiktokPeerMuteViewSet(viewsets.ModelViewSet):
    """`/api/tiktok-peer-mute/` CRUD — user-controlled pause AI cho 1 peer.

    Scope: chỉ peer mute thuộc device user có quyền (owner hoặc team member).

    - `GET ?device_id=X` — list mute của 1 device (mặc định cả expired để FE
      có thể audit; FE filter `is_active=true` nếu chỉ muốn active).
    - `POST` body `{device, peer_handle, muted_until?, note?}` — create.
      `created_by` auto-set từ request.user.
    - `PATCH /{id}/` — update (đổi `muted_until` để extend, đổi `note`).
    - `DELETE /{id}/` — hard delete (unmute hoàn toàn).

    Note: hiện model `unique_together(device, peer_handle)` → POST trùng sẽ
    fail. Frontend nên kiểm tra trước hoặc dùng PATCH để extend.
    """

    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TiktokPeerMuteSerializer

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return TiktokPeerMute.objects.none()
        accessible_ids = _user_accessible_device_ids(user)
        qs = TiktokPeerMute.objects.filter(device_id__in=accessible_ids).select_related('device')

        # Filter optional theo device_id query param.
        device_id_raw = self.request.query_params.get('device_id')
        if device_id_raw:
            try:
                device_id = int(device_id_raw)
            except (TypeError, ValueError):
                return TiktokPeerMute.objects.none()
            qs = qs.filter(device_id=device_id)

        # Filter optional theo is_active=true → chỉ mute còn hiệu lực.
        only_active = (self.request.query_params.get('is_active') or '').lower() in (
            '1', 'true', 'yes',
        )
        if only_active:
            now = timezone.now()
            qs = qs.filter(Q(muted_until__isnull=True) | Q(muted_until__gte=now))

        return qs.order_by('-created_at')

    def perform_create(self, serializer):
        device = serializer.validated_data.get('device')
        if device is None or not _can_access_device(device, self.request.user):
            raise PermissionDenied('You do not have access to this device.')
        serializer.save(created_by=self.request.user)

    def perform_update(self, serializer):
        # KHÔNG cho đổi `device` / `peer_handle` qua update (sẽ vi phạm unique
        # constraint và confuse user). Chỉ `muted_until` + `note` mutable.
        device = serializer.instance.device
        if not _can_access_device(device, self.request.user):
            raise PermissionDenied('You do not have access to this device.')
        serializer.save()

    def perform_destroy(self, instance):
        if not _can_access_device(instance.device, self.request.user):
            raise PermissionDenied('You do not have access to this device.')
        instance.delete()


