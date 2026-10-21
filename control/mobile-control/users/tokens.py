"""JWT helpers that embed the per-user ``token_version`` session epoch.

Issuing tokens through :func:`tokens_for_user` stamps the user's current
``token_version`` into the refresh token; SimpleJWT copies non-registered
claims onto the derived access token automatically, so both carry it. The
matching check lives in :mod:`users.authentication` (per-request) and in the
refresh view (per-refresh).
"""
from rest_framework_simplejwt.tokens import RefreshToken

from .models import UserProfile


def tokens_for_user(user) -> dict:
    """Return ``{'access', 'refresh'}`` for *user*, tagged with token_version."""
    profile, _ = UserProfile.objects.get_or_create(user=user)
    refresh = RefreshToken.for_user(user)
    refresh['token_version'] = profile.token_version
    return {
        'access': str(refresh.access_token),
        'refresh': str(refresh),
    }
