"""Custom DRF authentication backend for API keys.

Clients must pass the key in the ``Authorization`` header using the
``Api-Key`` scheme::

    Authorization: Api-Key sk-<token>

On success the request is authenticated as the key owner and the matched
``ApiKey`` instance is stored in ``request.auth``.
"""
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .models import ApiKey

_SCHEME = 'Api-Key'


class ApiKeyAuthentication(BaseAuthentication):
    """Authenticate requests that carry an ``Authorization: Api-Key <key>`` header."""

    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        if not auth_header.lower().startswith(_SCHEME.lower() + ' '):
            return None  # not our scheme – pass to the next authenticator

        raw_key = auth_header[len(_SCHEME) + 1:].strip()
        if not raw_key:
            raise AuthenticationFailed('API key is empty.')

        api_key = ApiKey.verify(raw_key)
        if api_key is None:
            raise AuthenticationFailed('Invalid or inactive API key.')

        user = api_key.owner
        if user is None:
            raise AuthenticationFailed('API key has no associated user.')

        # Record usage (best-effort – failures are silently ignored)
        try:
            from django.utils import timezone
            ApiKey.objects.filter(pk=api_key.pk).update(last_used_at=timezone.now())
        except Exception:
            pass

        return (user, api_key)

    def authenticate_header(self, request):
        return _SCHEME
