import logging
import re

from django.conf import settings

from .models import ExternalWebhook

logger = logging.getLogger(__name__)
EXTERNAL_WEBHOOK_KEY_PATTERN = re.compile(r'^[A-Z0-9_]+_WEBHOOK_URL$')


class ExternalWebhookNotConfiguredError(RuntimeError):
    pass


def get_external_webhook_url(webhook_name: str) -> str:
    """
    Resolve an outbound webhook URL by webhook name.

    Resolution strategy:
    1) Active URL from ExternalWebhook table (highest priority)
    2) Django settings value with the same key as `webhook_name` (fallback)

    Raises:
        ValueError: If webhook_name does not match expected key format.
        ExternalWebhookNotConfiguredError: If URL cannot be resolved.
    """
    if not EXTERNAL_WEBHOOK_KEY_PATTERN.match(webhook_name):
        raise ValueError(f'Invalid external webhook key: {webhook_name}')

    db_webhook_url = (
        ExternalWebhook.objects.filter(webhook_name=webhook_name, is_active=True)
        .values_list('webhook_url', flat=True)
        .first()
    )
    if db_webhook_url:
        return db_webhook_url
    settings_webhook_url = getattr(settings, webhook_name, '')
    if not settings_webhook_url:
        message = (
            f'External webhook "{webhook_name}" could not be resolved '
            'from active database configuration or settings.'
        )
        logger.warning(message)
        raise ExternalWebhookNotConfiguredError(message)
    return settings_webhook_url
