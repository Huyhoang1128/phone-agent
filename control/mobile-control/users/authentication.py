"""JWT authentication that enforces the per-user ``token_version`` epoch.

On every request the token's ``token_version`` claim must equal the value
stored on the user's :class:`~users.models.UserProfile`. A mismatch — or a
legacy token issued before this feature that lacks the claim entirely — is
rejected with 401, forcing a fresh login. This is what gives an otherwise
stateless JWT an instant "revoke everything for this user" capability.
"""
from django.utils.translation import gettext_lazy as _
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed

from .models import UserProfile


class VersionedJWTAuthentication(JWTAuthentication):
    """JWTAuthentication + a token_version equality check against the DB."""

    def get_user(self, validated_token):
        # Parent resolves the user AND enforces ``is_active`` — keep that.
        user = super().get_user(validated_token)

        token_version = validated_token.get('token_version')
        if token_version is None:
            # Legacy token minted before token_version existed. Under the
            # strict rollout every live session must re-login once.
            raise AuthenticationFailed(
                _('Session expired, please log in again.'),
                code='token_missing_version',
            )

        current_version = (
            UserProfile.objects
            .filter(user=user)
            .values_list('token_version', flat=True)
            .first()
        )
        if current_version is None:
            current_version = 1

        if token_version != current_version:
            raise AuthenticationFailed(
                _('Session has been revoked, please log in again.'),
                code='token_revoked',
            )

        return user
