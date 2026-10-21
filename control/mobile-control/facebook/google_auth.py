"""Google Service Account auth for reading PRIVATE Drive files and Sheets.

The CSV/Sheet importers historically required every Drive folder/file and the
Google Sheet itself to be shared "Anyone with the link" — API keys can only
read public data. With a service account configured, users instead share their
folder/sheet with the service-account **email** (Viewer role) and nothing has
to be public: possession of the link no longer grants access to anyone else.

Configuration:
    GOOGLE_SERVICE_ACCOUNT_FILE — path to the service-account JSON key file
    (mounted into the backend + scheduler containers; see docker-compose.yml).

Every helper degrades gracefully: when the feature is unconfigured, the
``google-auth`` lib is missing (old image) or the key file is unreadable, they
return ``None``/``''`` so all call-sites fall back to the public
GOOGLE_API_KEY path exactly as before.
"""
import logging
import os
import threading

from django.conf import settings

logger = logging.getLogger(__name__)

# drive.readonly covers Drive listing + content download AND read-only access
# to the Sheets v4 API — a single scope serves every importer call-site. Keep
# it read-only: a leaked key must not be able to modify/delete anything.
_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

_lock = threading.Lock()
_credentials = None
_load_failed_path = None  # warn once per bad path instead of spamming logs


def _get_credentials():
    global _credentials, _load_failed_path
    path = (getattr(settings, 'GOOGLE_SERVICE_ACCOUNT_FILE', '') or '').strip()
    if not path or not os.path.exists(path):
        return None
    with _lock:
        if _credentials is not None:
            return _credentials
        if _load_failed_path == path:
            return None
        try:
            from google.oauth2 import service_account
            _credentials = service_account.Credentials.from_service_account_file(
                path, scopes=_SCOPES,
            )
        except Exception:
            _load_failed_path = path
            logger.exception(
                'Không load được Google service account key tại %s — '
                'importer sẽ fallback về GOOGLE_API_KEY (chỉ đọc link public).',
                path,
            )
            return None
        return _credentials


def get_google_bearer_token() -> str | None:
    """OAuth access token for the configured service account, or ``None``.

    The token lives on the cached credentials object and is refreshed only
    when expired (google-auth handles expiry slack). Never raises — callers
    treat ``None`` as "feature off" and fall back to the public API-key path.
    """
    creds = _get_credentials()
    if creds is None:
        return None
    try:
        with _lock:
            if not creds.valid:
                from google.auth.transport.requests import Request
                creds.refresh(Request())
            return creds.token
    except Exception:
        logger.exception('Refresh token Google service account thất bại')
        return None


def get_google_service_account_email() -> str:
    """Service-account email — used in error hints ("share cho email này")."""
    creds = _get_credentials()
    return getattr(creds, 'service_account_email', '') or ''
