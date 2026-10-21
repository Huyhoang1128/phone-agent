from django.urls import re_path

from chatbot.consumers import TiktokInboxConsumer

from . import consumers

# Android device personal-join endpoint.
# No Origin header is required; JWT auth is handled inside the consumer.
# This list is mounted directly in asgi.py, bypassing AllowedHostsOriginValidator.
device_ws_urlpatterns = [
    re_path(
        r'^v1/providers/personal/join$',
        consumers.PersonalJoinConsumer.as_asgi(),
    ),
]

# Legacy USB-serial device and browser viewer endpoints.
# These are mounted behind AllowedHostsOriginValidator in asgi.py.
websocket_urlpatterns = [
    # Android device connects here: wss://host/ws/device/{identifier}/
    re_path(r'^ws/device/(?P<identifier>[^/]+)/$', consumers.DeviceConsumer.as_asgi()),
    # Browser viewer connects here: wss://host/ws/viewer/{identifier}/
    re_path(r'^ws/viewer/(?P<identifier>[^/]+)/$', consumers.ViewerConsumer.as_asgi()),
    # Task status stream: wss://host/ws/task/{task_id}/?token=<jwt>
    re_path(r'^ws/task/(?P<task_id>[0-9]+)/$', consumers.TaskStatusConsumer.as_asgi()),
    # Chatbot TikTok Inbox realtime (Phase 2.3.4):
    # wss://host/ws/tiktok-inbox/{device_id}/?token=<jwt>
    re_path(
        r'^ws/tiktok-inbox/(?P<device_id>[0-9]+)/$',
        TiktokInboxConsumer.as_asgi(),
    ),
]
