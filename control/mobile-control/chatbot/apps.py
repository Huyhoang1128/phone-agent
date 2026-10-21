"""Django app config — Chatbot domain (Phase 2.6 refactor).

Chứa toàn bộ code cho feature Chatbot TikTok (DM auto-reply + Comment reply):
- Models `TiktokMessage`, `TiktokPeerMute` + choices
- AdaptiveMessageBuffer
- NotificationMatcher (deprecated, giữ reference)
- API endpoints (Inbox conversations, peer mute CRUD)
- WebSocket consumer realtime
- n8n bridge callback endpoint
- Channel layer broadcast helpers
- Management commands (E2E smoke + stress test)
- Services extracted từ `stream/consumers.py` (`handle_tiktok_notification`)

Mục đích app riêng: cohesion cao, dễ nâng cấp/sửa chữa/disable, tách boundary
với code TikTok crawl (`tiktok/` app — videos, channels, keyword lists).
"""
from django.apps import AppConfig


class ChatbotConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'chatbot'
    verbose_name = 'Chatbot (TikTok DM + Comment)'

    def ready(self):
        # Wire post_save / post_delete signals cho realtime broadcast.
        # Import side-effect đăng ký receivers.
        from . import signals  # noqa: F401
