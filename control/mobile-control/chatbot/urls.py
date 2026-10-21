"""URL patterns cho Chatbot domain (Phase 2.6 — moved từ `tiktok/urls.py`).

API path giữ nguyên (`/api/tiktok-conversations/*`, `/api/tiktok-peer-mute/*`,
`/api/internal/n8n-notify-callback/`) để KHÔNG break FE callers — chỉ
implementation location move sang chatbot app.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .inbox_views import (
    TiktokConversationDetailView,
    TiktokConversationListView,
    TiktokConversationMessagesView,
    TiktokPeerMuteViewSet,
)
from .internal_views import n8n_notify_callback

router = DefaultRouter()
router.register('tiktok-peer-mute', TiktokPeerMuteViewSet, basename='tiktok-peer-mute')

urlpatterns = [
    # Inbox conversations (Phase 2.3) — xem docs/Chatbot_Tiktok/design.md mục 13.
    # Note: detail/messages dùng query param `peer_handle` thay vì path
    # (TikTok username free-form có thể chứa `/`, space, unicode → path
    # converter dễ ambiguous với suffix `messages/`).
    path(
        'tiktok-conversations/',
        TiktokConversationListView.as_view(),
        name='chatbot-tiktok-conversation-list',
    ),
    path(
        'tiktok-conversations/detail/',
        TiktokConversationDetailView.as_view(),
        name='chatbot-tiktok-conversation-detail',
    ),
    path(
        'tiktok-conversations/messages/',
        TiktokConversationMessagesView.as_view(),
        name='chatbot-tiktok-conversation-messages',
    ),

    # n8n bridge callback (Phase 2.5 — revise Q4.b). n8n classify event_type
    # rồi POST callback về đây. Auth qua `Authorization: Bearer
    # <N8N_CALLBACK_TOKEN>`. Xem chatbot/internal_views.py.
    path(
        'internal/n8n-notify-callback/',
        n8n_notify_callback,
        name='chatbot-n8n-notify-callback',
    ),

    path('', include(router.urls)),
]
