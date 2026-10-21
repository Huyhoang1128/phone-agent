"""SeaweedFS upload utilities for Facebook post images and videos.

Mirrors the interface of ``facebook/s3_utils.py`` but routes all media to the
self-hosted SeaweedFS cluster instead of Cloudfly.

SeaweedFS exposes two ports:
  - **8333** – S3-compatible API (used for upload via boto3).
  - **8888** – Filer HTTP API (used to generate public read URLs).

The bucket name in SEAWEEDFS_BUCKET must exist on the SeaweedFS cluster.
Create it once via::

    curl -X PUT http://<host>:8333/<bucket-name>

"""
import os
import re
import uuid

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework.exceptions import APIException

_seaweedfs_client = None

# Stream big uploads to SeaweedFS in 8 MiB multipart chunks so a heavy video
# never sits in backend memory whole. Small files (< threshold) still go as a
# single PUT under the hood.
_SW_TRANSFER = TransferConfig(
    multipart_threshold=8 * 1024 * 1024,
    multipart_chunksize=8 * 1024 * 1024,
    max_concurrency=2,
    use_threads=True,
)

VIDEO_EXTENSIONS = {'.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'}

CONTENT_TYPE_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
}


def _get_seaweedfs_client():
    """Return a cached boto3 S3 client pointing at SeaweedFS S3 API (port 8333)."""
    global _seaweedfs_client
    if _seaweedfs_client is None:
        _seaweedfs_client = boto3.client(
            's3',
            endpoint_url=settings.SEAWEEDFS_S3_ENDPOINT,
            aws_access_key_id=settings.SEAWEEDFS_ACCESS_KEY,
            aws_secret_access_key=settings.SEAWEEDFS_SECRET_KEY,
            region_name=settings.SEAWEEDFS_REGION,
            config=Config(
                signature_version='s3v4',
                s3={'addressing_style': 'path'},
                request_checksum_calculation='when_required',
                response_checksum_validation='when_required',
                # Fail fast instead of hanging a worker forever when the SeaweedFS
                # endpoint is unreachable/misconfigured (a hung put_object blocks
                # the gunicorn worker and can take the whole server down).
                connect_timeout=5,
                read_timeout=30,
                retries={'max_attempts': 2, 'mode': 'standard'},
            ),
        )
    return _seaweedfs_client


def upload_to_seaweedfs(file_obj, original_filename: str) -> str:
    """Upload an image or video file-like object to SeaweedFS and return the public URL.

    Files are stored under ``facebook/images/<uuid>.<ext>`` or
    ``facebook/videos/<uuid>.<ext>`` inside the configured bucket.

    Returns a **public Filer URL** (port 8888) that is directly accessible
    without any credentials or presigning.

    Raises ``APIException`` on upload failure.
    """
    ext = os.path.splitext(original_filename)[1].lower()
    if not ext:
        ext = '.jpg'

    is_video = ext in VIDEO_EXTENSIONS
    folder = 'videos' if is_video else 'images'
    key = f"facebook/{folder}/{uuid.uuid4().hex}{ext}"

    content_type = CONTENT_TYPE_MAP.get(ext, 'video/mp4' if is_video else 'image/jpeg')

    try:
        client = _get_seaweedfs_client()

        if hasattr(file_obj, 'seek'):
            file_obj.seek(0)

        # Stream to SeaweedFS (multipart for large files) so a heavy video is
        # never held entirely in memory during upload.
        client.upload_fileobj(
            file_obj,
            settings.SEAWEEDFS_BUCKET,
            key,
            ExtraArgs={'ContentType': content_type},
            Config=_SW_TRANSFER,
        )

    except (BotoCoreError, ClientError) as exc:
        raise APIException(detail=f"Failed to upload media to SeaweedFS: {exc}") from exc

    # Build public URL using Filer HTTP API (port 8888) for direct access.
    # Format: http://<host>:8888/<key>   (without bucket prefix in path)
    # SeaweedFS Filer stores files keyed by path, so we skip the bucket name
    # in the public URL and use the Filer path directly.
    filer_base = settings.SEAWEEDFS_PUBLIC_BASE_URL.rstrip('/')
    public_url = f"{filer_base}/{key}"
    return public_url


def get_seaweedfs_url(stored_url: str) -> str:
    """Return the stored URL unchanged.

    SeaweedFS Filer URLs (port 8888) are always publicly readable without
    presigning.  This helper exists so callers can use the same pattern as
    ``get_presigned_image_url`` from s3_utils without conditional logic.
    """
    return stored_url or ''


def delete_from_seaweedfs(url_or_key: str) -> bool:
    """Delete a single object from SeaweedFS.

    Accepts a full Filer/S3 URL or a raw S3 key (``facebook/images/<uuid>.jpg``).
    Returns ``True`` when the object was actually removed, ``False`` otherwise.
    """
    import logging as _logging
    _logger = _logging.getLogger(__name__)

    if not url_or_key:
        return False

    # Extract the S3 key from the URL if needed.
    key = _extract_seaweedfs_key(url_or_key)
    if not key:
        return False

    try:
        client = _get_seaweedfs_client()
        try:
            client.head_object(Bucket=settings.SEAWEEDFS_BUCKET, Key=key)
        except ClientError as head_exc:
            code = (head_exc.response or {}).get('Error', {}).get('Code', '')
            if code in ('404', 'NoSuchKey', 'NotFound'):
                return False
            _logger.warning('SeaweedFS: HEAD failed for %s — %s', key, head_exc)

        client.delete_object(Bucket=settings.SEAWEEDFS_BUCKET, Key=key)
        _logger.info('SeaweedFS: deleted key %s', key)
        return True

    except (BotoCoreError, ClientError) as exc:
        _logger.warning('SeaweedFS: delete failed for key %s — %s', key, exc)
        return False


def _extract_seaweedfs_key(url_or_key: str) -> str | None:
    """Extract the S3 object key from a SeaweedFS Filer or S3 URL.

    Only handles keys under the ``facebook/`` prefix (images/videos we uploaded).
    Returns ``None`` for URLs that don't belong to this storage backend.
    """
    if not url_or_key or not isinstance(url_or_key, str):
        return None

    # Already a raw key (e.g. 'facebook/images/abc123.jpg')
    if url_or_key.startswith('facebook/'):
        return url_or_key

    from urllib.parse import urlparse
    parsed = urlparse(url_or_key)
    path = parsed.path.lstrip('/')

    bucket = settings.SEAWEEDFS_BUCKET.strip('/')
    if path.startswith(bucket + '/'):
        key = path[len(bucket) + 1:]
    else:
        key = path

    if not key.startswith('facebook/'):
        return None

    return key or None


_DRIVE_FILE_D_RE = re.compile(r'/file/(?:u/\d+/)?d/([a-zA-Z0-9_-]+)')
_DRIVE_ID_PARAM_RE = re.compile(r'[?&]id=([a-zA-Z0-9_-]+)')


def _extract_drive_file_id_for_api(media_url: str) -> str | None:
    """File id from any Drive URL form — ``/file/d/<id>``, ``uc?id=<id>`` or
    ``drive.usercontent.google.com/download?id=<id>`` — or ``None`` for
    non-Drive URLs."""
    from urllib.parse import urlparse

    host = urlparse(media_url).netloc.lower()
    if host not in ('drive.google.com', 'drive.usercontent.google.com'):
        return None
    m = _DRIVE_FILE_D_RE.search(media_url) or _DRIVE_ID_PARAM_RE.search(media_url)
    return m.group(1) if m else None


def download_and_upload_to_seaweedfs(media_url: str) -> str:
    """Download an image or video from a public URL and re-upload it to SeaweedFS.

    Mirrors ``s3_utils.download_and_upload_image`` but targets SeaweedFS.

    Supports:
    - Direct image/video URLs (http/https)
    - Google Drive share links (drive.google.com/file/d/<id>/view)
    - Google Drive UC download links (drive.google.com/uc?id=...)
    - Google Drive folder links (expands to all files in folder)

    Returns the SeaweedFS public Filer URL. Raises ``APIException`` on failure.
    """
    import requests as http_requests
    from urllib.parse import urlparse
    from rest_framework.exceptions import APIException

    parsed = urlparse(media_url)
    if parsed.scheme not in ('http', 'https'):
        raise APIException(detail=(
            f"Giá trị {media_url!r} ở cột ảnh không phải URL hợp lệ "
            "(thiếu http:// hoặc https://). "
            "Sửa lại sheet: dán URL đầy đủ (Drive file /file/d/<id>/view, "
            "Drive folder /drive/folders/<id>, hoặc link ảnh/video công khai)."
        ))

    path_filename = os.path.basename(parsed.path)
    ext_from_path = os.path.splitext(path_filename)[1].lower()

    _KNOWN_MEDIA_EXTS = {
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic',
        '.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv',
    }
    _CONTENT_TYPE_TO_EXT = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'image/webp': '.webp', 'image/bmp': '.bmp', 'image/heic': '.heic',
        'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
        'video/x-m4v': '.m4v', 'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv',
    }
    _MAGIC = {
        b'\xff\xd8\xff': '.jpg', b'\x89PNG': '.png',
        b'GIF8': '.gif', b'RIFF': '.webp',
        b'\x00\x00\x00': '.mp4', b'ftyp': '.mp4',
    }

    def _ext_from_magic(head: bytes) -> str:
        for sig, ext in _MAGIC.items():
            if head[:len(sig)] == sig:
                return ext
        return ''

    def _looks_like_media(head: bytes) -> bool:
        text_markers = (b'<!', b'<?', b'<h', b'<H')
        return not any(head.startswith(m) for m in text_markers)

    max_bytes = int(getattr(settings, 'FB_MEDIA_MAX_BYTES', 500 * 1024 * 1024))

    session = http_requests.Session()
    session.headers['User-Agent'] = (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    )

    from .s3_utils import _drive_uc_get_with_confirm, _spool_response

    def _fetch_public():
        """Logic cũ, giữ nguyên: tải qua endpoint public (link đã share)."""
        # Google Drive UC download link handling
        is_drive_uc = (
            parsed.netloc.endswith('drive.google.com')
            and parsed.path.rstrip('/').endswith('/uc')
        )
        if is_drive_uc:
            # Use the same _drive_uc_get_with_confirm from s3_utils
            return _drive_uc_get_with_confirm(
                media_url, session, max_bytes, timeout=180,
            )
        resp = session.get(media_url, timeout=120, stream=True)
        resp.raise_for_status()
        # Stream into a SpooledTemporaryFile (small → RAM, big → disk) and
        # reject oversized files up-front via Content-Length — keeps backend
        # memory flat even for large/slow media.
        return _spool_response(resp, max_bytes)

    def _fetch_drive_api():
        """Fallback cho file Drive PRIVATE đã share cho service account.

        Returns ``None`` when not applicable (URL không phải Drive, hoặc chưa
        cấu hình GOOGLE_SERVICE_ACCOUNT_FILE) so the caller keeps the public
        path's error.
        """
        file_id = _extract_drive_file_id_for_api(media_url)
        if not file_id:
            return None
        from .google_auth import get_google_bearer_token
        token = get_google_bearer_token()
        if not token:
            return None
        resp = session.get(
            f'https://www.googleapis.com/drive/v3/files/{file_id}',
            params={'alt': 'media', 'supportsAllDrives': 'true'},
            headers={'Authorization': f'Bearer {token}'},
            timeout=180,
            stream=True,
        )
        resp.raise_for_status()
        return _spool_response(resp, max_bytes)

    def _media_error_detail(content_type: str, head: bytes) -> str:
        head_preview = head.decode('latin-1', errors='replace')
        from .google_auth import get_google_service_account_email
        sa_email = get_google_service_account_email()
        drive_hint = (
            f'Với Google Drive, share file/folder cho "{sa_email}" (Viewer) '
            'hoặc share public, rồi dùng URL dạng /file/d/{id}/view hoặc URL folder.'
            if sa_email else
            'Với Google Drive, dùng URL dạng /file/d/{id}/view (đã share public) '
            'hoặc URL folder.'
        )
        return (
            f"URL {media_url!r} không trả về file ảnh/video hợp lệ "
            f"(Content-Type={content_type!r}, bytes head={head_preview[:80]!r}). "
            + drive_hint
        )

    # Thứ tự tải: public (logic cũ) trước — ai đã share public thì hành vi
    # không đổi; chỉ khi public thất bại (exception, hoặc Drive trả trang HTML
    # login vì file private) mới fallback sang Drive API + service account.
    file_obj = None
    content_type = ''
    fetch_error: Exception | None = None
    for fetch in (_fetch_public, _fetch_drive_api):
        candidate = None
        try:
            candidate = fetch()
        except Exception as exc:
            if fetch_error is None:
                fetch_error = exc
            continue
        if candidate is None:
            continue
        obj, ctype = candidate
        obj.seek(0)
        probe = obj.read(120)
        obj.seek(0)
        if _looks_like_media(probe[:16]):
            file_obj, content_type = obj, ctype
            break
        # HTML/login page thay vì bytes media → file private chưa share đủ.
        if fetch_error is None:
            fetch_error = APIException(detail=_media_error_detail(ctype, probe))
        try:
            obj.close()
        except Exception:
            pass

    if file_obj is None:
        if isinstance(fetch_error, APIException):
            raise fetch_error
        raise APIException(
            detail=f"Không thể tải media từ {media_url}: {fetch_error}"
        ) from fetch_error

    try:
        # Peek only the first bytes for detection — body stays a stream.
        file_obj.seek(0)
        head = file_obj.read(120)
        file_obj.seek(0)

        if ext_from_path in _KNOWN_MEDIA_EXTS:
            filename = path_filename
        else:
            ext = _CONTENT_TYPE_TO_EXT.get(content_type.lower())
            if ext is None:
                ext = _ext_from_magic(head[:16]) or '.jpg'
            base = os.path.splitext(path_filename)[0] or 'download'
            filename = f"{base}{ext}"

        return upload_to_seaweedfs(file_obj, filename)
    finally:
        try:
            file_obj.close()
        except Exception:
            pass

