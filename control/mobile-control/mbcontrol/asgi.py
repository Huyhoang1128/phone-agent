"""
ASGI config for mbcontrol project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/
"""

import os

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mbcontrol.settings')

# Import websocket URL patterns after setting the environment variable.
from stream.routing import device_ws_urlpatterns, websocket_urlpatterns  # noqa: E402


class _WebSocketRouter:
    """
    Route WebSocket connections based on path:

    - /v1/providers/personal/join  → PersonalJoinConsumer
      Android devices do not send an Origin header, so AllowedHostsOriginValidator
      must be bypassed for this path.  Auth is handled inside the consumer via JWT.

    - /ws/device/… and /ws/viewer/… → DeviceConsumer / ViewerConsumer
      Browser connections; wrapped in AllowedHostsOriginValidator for CSRF
      protection and AuthMiddlewareStack for Django session auth.
    """

    def __init__(self):
        self._device_router = URLRouter(device_ws_urlpatterns)
        self._viewer_router = AllowedHostsOriginValidator(
            AuthMiddlewareStack(URLRouter(websocket_urlpatterns))
        )

    async def __call__(self, scope, receive, send):
        if scope.get('path') == '/v1/providers/personal/join':
            await self._device_router(scope, receive, send)
        else:
            await self._viewer_router(scope, receive, send)


application = ProtocolTypeRouter({
    'http': get_asgi_application(),
    'websocket': _WebSocketRouter(),
})
