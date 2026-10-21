"""Django signals → realtime broadcast (Phase 2.3.4).

Hook `post_save` + `post_delete` để mỗi khi `TiktokMessage` hoặc `TiktokPeerMute`
thay đổi → tự publish event lên channel layer. Tránh phải gọi explicit từ N
chỗ tạo message (notification consumer, kafka_listener, peer_mute viewset, ...).

Wire trong `tiktok/apps.py:ready()`.
"""
from __future__ import annotations

import logging

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .models import TiktokMessage, TiktokPeerMute
from .realtime import publish_message_created, publish_peer_mute_changed

logger = logging.getLogger(__name__)


@receiver(post_save, sender=TiktokMessage)
def _on_tiktok_message_saved(sender, instance: TiktokMessage, created: bool, **kwargs):
    if not created:
        # Update message hiếm trong design hiện tại — bỏ qua để giảm noise.
        return
    try:
        publish_message_created(instance)
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.warning('post_save TiktokMessage publish failed: %s', exc, exc_info=True)


@receiver(post_save, sender=TiktokPeerMute)
def _on_tiktok_peer_mute_saved(sender, instance: TiktokPeerMute, created: bool, **kwargs):
    action = 'created' if created else 'updated'
    try:
        publish_peer_mute_changed(instance, action)
    except Exception as exc:  # noqa: BLE001
        logger.warning('post_save TiktokPeerMute publish failed: %s', exc, exc_info=True)


@receiver(post_delete, sender=TiktokPeerMute)
def _on_tiktok_peer_mute_deleted(sender, instance: TiktokPeerMute, **kwargs):
    try:
        publish_peer_mute_changed(instance, 'deleted')
    except Exception as exc:  # noqa: BLE001
        logger.warning('post_delete TiktokPeerMute publish failed: %s', exc, exc_info=True)
