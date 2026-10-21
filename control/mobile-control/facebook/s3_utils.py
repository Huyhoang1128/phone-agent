"""S3 upload utilities for Facebook post images.

Reuses the same Cloudfly/S3-compatible configuration as mobile_apps/s3_utils.py.
"""
import os
import uuid
from tempfile import SpooledTemporaryFile

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework.exceptions import APIException

_s3_client = None

# Files up to this size stay in RAM; bigger ones spill to a temp file on disk so
# importing a heavy video never buffers the whole payload in memory.
_SPOOL_MAX_RAM = 8 * 1024 * 1024
# Stream big uploads to S3 in 8 MiB parts (multipart) instead of one giant PUT —
# keeps backend memory flat regardless of file size.
_S3_TRANSFER = TransferConfig(
    multipart_threshold=_SPOOL_MAX_RAM,
    multipart_chunksize=_SPOOL_MAX_RAM,
    max_concurrency=2,
    use_threads=True,
)


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            's3',
            endpoint_url=settings.CLOUDFLY_S3_ENDPOINT,
            aws_access_key_id=settings.CLOUDFLY_ACCESS_KEY,
            aws_secret_access_key=settings.CLOUDFLY_SECRET_KEY,
            region_name=settings.CLOUDFLY_REGION,
            config=Config(
                signature_version='s3v4',
                s3={'addressing_style': 'path'},
                request_checksum_calculation='when_required',
                response_checksum_validation='when_required',
                # Fail fast instead of hanging a gunicorn worker forever when
                # Cloudfly is slow/unreachable — a no-timeout get_object (e.g. the
                # editor's proxy-image / source-image server-side download) could
                # otherwise block a worker indefinitely and exhaust the pool.
                connect_timeout=5,
                read_timeout=30,
                retries={'max_attempts': 2, 'mode': 'standard'},
            ),
        )
    return _s3_client


VIDEO_EXTENSIONS = {'.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'}


def upload_image_to_s3(file_obj, original_filename: str) -> str:
    """Upload an image OR video file-like to S3 and return the public URL.

    Despite the name, accepts both image and video files (extension-detected).
    """
    ext = os.path.splitext(original_filename)[1].lower()
    if not ext:
        ext = '.jpg'

    is_video = ext in VIDEO_EXTENSIONS
    folder = 'videos' if is_video else 'images'
    key = f"facebook/{folder}/{uuid.uuid4().hex}{ext}"

    content_type_map = {
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
    content_type = content_type_map.get(ext, 'image/jpeg' if not is_video else 'video/mp4')

    try:
        client = _get_s3_client()

        if hasattr(file_obj, 'seek'):
            file_obj.seek(0)

        # Stream to S3 (multipart for large files) so a heavy video is never held
        # entirely in memory during upload.
        client.upload_fileobj(
            file_obj,
            settings.CLOUDFLY_BUCKET,
            key,
            ExtraArgs={'ContentType': content_type},
            Config=_S3_TRANSFER,
        )
    except (BotoCoreError, ClientError) as exc:
        raise APIException(detail=f"Failed to upload image to S3: {exc}") from exc

    public_url = f"{settings.CLOUDFLY_PUBLIC_BASE_URL.rstrip('/')}/{key}"
    return public_url


def get_presigned_image_url(image_url: str, expires_in: int = 3600) -> str:
    """Return a presigned GET URL for the object stored at *image_url*.

    Works regardless of whether the bucket grants public read on the prefix —
    the signature is computed locally from the configured credentials.

    Accepts both raw and previously-signed URLs (only the path/key matters;
    the query string is ignored). Returns *image_url* unchanged on any error
    OR when *image_url* is not hosted on the configured S3 endpoint (Drive,
    public CDN, …) — signing a non-S3 URL would mangle it into a fake S3 URL
    pointing at a non-existent key, which worker would 400 on.
    """
    if not image_url:
        return ''
    from urllib.parse import urlparse

    parsed = urlparse(image_url)

    # SeaweedFS public host (SEAWEEDFS_PUBLIC_BASE_URL → e.g. media.example.com) is a
    # plain-HTTP box that can go down and can't be loaded as an <img> on the HTTPS
    # app (mixed content). When MEDIA_PROXY_BASE_URL is set, rewrite these URLs to
    # stream through this backend instead (content.views.media_proxy at /api/media/).
    # Covers old AND new URLs because it runs on read; set MEDIA_PROXY_BASE_URL='' to
    # disable and pass the raw SeaweedFS URL through unchanged again.
    proxy_base = (getattr(settings, 'MEDIA_PROXY_BASE_URL', '') or '').rstrip('/')
    seaweed_host = urlparse(getattr(settings, 'SEAWEEDFS_PUBLIC_BASE_URL', '') or '').netloc
    if proxy_base and seaweed_host and parsed.netloc == seaweed_host:
        sw_path = parsed.path.lstrip('/')            # e.g. buckets/user-media/characters/…
        if sw_path.startswith('buckets/'):
            sw_path = sw_path[len('buckets/'):]
        sw_bucket = (getattr(settings, 'SEAWEEDFS_BUCKET', '') or '').strip('/')
        if sw_bucket and sw_path.startswith(sw_bucket + '/'):
            sw_path = sw_path[len(sw_bucket) + 1:]
        if sw_path:
            return f'{proxy_base}/api/media/{sw_path}'
        return image_url

    endpoint_host = urlparse(settings.CLOUDFLY_S3_ENDPOINT).netloc
    if parsed.netloc and endpoint_host and parsed.netloc != endpoint_host:
        return image_url
    path = parsed.path.lstrip('/')
    bucket = settings.CLOUDFLY_BUCKET.strip('/')
    if path.startswith(bucket + '/'):
        key = path[len(bucket) + 1:]
    else:
        key = path
    if not key:
        return image_url

    try:
        client = _get_s3_client()
        return client.generate_presigned_url(
            'get_object',
            Params={'Bucket': settings.CLOUDFLY_BUCKET, 'Key': key},
            ExpiresIn=expires_in,
        )
    except (BotoCoreError, ClientError):
        return image_url


def download_image_bytes_from_s3(image_url: str, max_attempts: int = 3) -> tuple[bytes, str]:
    """Download image bytes directly from S3 using boto3 (works for private buckets).

    Extracts the object key from *image_url* by stripping the
    ``CLOUDFLY_S3_ENDPOINT/{bucket}/`` prefix, then calls ``get_object`` with
    the configured credentials.

    Retries transient errors (network blips, 5xx, NoSuchKey caused by Cloudfly
    eventual consistency right after a fresh upload) with exponential backoff:
    1s → 2s → 4s. ``max_attempts=3`` by default.

    Returns ``(raw_bytes, filename)``.
    Raises ``APIException`` on persistent failure.
    """
    import os as _os
    import time as _time
    from urllib.parse import urlparse as _urlparse

    # Derive the S3 key from the stored URL.
    # URL pattern: https://s3.cloudfly.vn/<bucket>/<key...>
    parsed = _urlparse(image_url)
    path = parsed.path.lstrip('/')
    bucket = settings.CLOUDFLY_BUCKET.strip('/')
    if path.startswith(bucket + '/'):
        key = path[len(bucket) + 1:]
    else:
        key = path  # fallback: use path as-is

    filename = _os.path.basename(key) or 'image.jpg'

    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            client = _get_s3_client()
            response = client.get_object(Bucket=settings.CLOUDFLY_BUCKET, Key=key)
            return response['Body'].read(), filename
        except Exception as exc:
            last_exc = exc
            if attempt < max_attempts - 1:
                _time.sleep(2 ** attempt)  # 1s, 2s
    raise APIException(
        detail=f'Failed to download image from S3 after {max_attempts} attempts: {last_exc}'
    ) from last_exc


# ─── Cleanup helpers ─────────────────────────────────────────────────────────


def _url_to_s3_key(url: str) -> str | None:
    """Extract the S3 object key from a Cloudfly URL (presigned or raw).

    Returns ``None`` when the URL doesn't point at our managed bucket — we
    only delete keys we own. Defensive: also requires the key to live under
    the ``facebook/`` prefix that ``upload_image_to_s3`` writes to.
    """
    if not url or not isinstance(url, str):
        return None
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if not parsed.path:
        return None
    path = parsed.path.lstrip('/')
    bucket = settings.CLOUDFLY_BUCKET.strip('/')
    if path.startswith(bucket + '/'):
        key = path[len(bucket) + 1:]
    else:
        key = path
    # Only delete keys we wrote (facebook/images/ or facebook/videos/).
    if not key.startswith('facebook/'):
        return None
    return key or None


def delete_s3_object(url_or_key: str) -> bool:
    """Delete a single S3 object. Accepts a URL (raw/presigned) or a raw key.

    Returns ``True`` ONLY when an existing object was actually removed.
    Returns ``False`` for: key missing (already deleted), unparseable input,
    or S3 error. We HEAD first because Cloudfly's ``delete_object`` is
    idempotent and returns 200 even for non-existent keys — without HEAD the
    caller can't tell a fresh delete from a no-op, which made the "Dọn S3"
    button report the same ``deleted`` count on repeat clicks.
    """
    import logging as _logging
    _logger = _logging.getLogger(__name__)

    if not url_or_key:
        return False
    if '/' in url_or_key and not url_or_key.startswith('facebook/'):
        key = _url_to_s3_key(url_or_key)
    else:
        key = url_or_key if url_or_key.startswith('facebook/') else None
    if not key:
        return False
    try:
        client = _get_s3_client()
        try:
            client.head_object(Bucket=settings.CLOUDFLY_BUCKET, Key=key)
        except ClientError as head_exc:
            code = (head_exc.response or {}).get('Error', {}).get('Code', '')
            if code in ('404', 'NoSuchKey', 'NotFound'):
                return False  # already gone — don't count
            # Other HEAD error (403/permission/network): fall through to DELETE
            # attempt; worst case S3 confirms idempotently and we return False.
            _logger.warning('S3: HEAD failed for %s before delete — %s', key, head_exc)
        client.delete_object(Bucket=settings.CLOUDFLY_BUCKET, Key=key)
        _logger.info('S3: deleted key %s', key)
        return True
    except (BotoCoreError, ClientError) as exc:
        _logger.warning('S3: delete failed for key %s — %s', key, exc)
        return False


def _url_still_referenced(url: str, exclude=None) -> bool:
    """True if any other scheduled-post row still references this S3 URL.

    Checks all 4 surfaces (page, group, profile, media-action). If
    ``exclude`` is given (a model instance), excludes that exact row from the
    check — used when the caller is about to publish or delete that row.

    URL match uses JSONField ``__contains`` for ``image_urls`` (list field)
    and exact match for ``image_url`` (single string field on media actions).
    """
    from .models import (
        FacebookGroupScheduledPost,
        FacebookProfileScheduledMediaAction,
        FacebookProfileScheduledPost,
        FacebookScheduledPost,
    )

    list_models = (
        FacebookScheduledPost,
        FacebookGroupScheduledPost,
        FacebookProfileScheduledPost,
    )
    for model in list_models:
        qs = model.objects.filter(image_urls__contains=[url])
        if exclude is not None and isinstance(exclude, model):
            qs = qs.exclude(pk=exclude.pk)
        if qs.exists():
            return True

    qs = FacebookProfileScheduledMediaAction.objects.filter(image_url=url)
    if exclude is not None and isinstance(exclude, FacebookProfileScheduledMediaAction):
        qs = qs.exclude(pk=exclude.pk)
    if qs.exists():
        return True
    return False


def cleanup_post_media(image_urls, exclude=None) -> int:
    """Delete S3 objects for each URL in *image_urls* UNLESS the URL is still
    referenced by another scheduled-post row.

    *image_urls* may be a list (page/group/profile post) or a single string
    (media action). *exclude* is the model instance owning these URLs — passed
    so the cross-table check ignores it when counting other references.

    Best-effort + safe to call repeatedly. Returns the number of keys deleted.
    """
    if not image_urls:
        return 0
    urls = image_urls if isinstance(image_urls, list) else [image_urls]
    deleted = 0
    for url in urls:
        if not url or not isinstance(url, str):
            continue
        if _url_to_s3_key(url) is None:
            continue  # not our S3 key (Drive raw URL, external, etc.)
        if _url_still_referenced(url, exclude=exclude):
            continue
        if delete_s3_object(url):
            deleted += 1
    return deleted


_CONTENT_TYPE_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/bmp': '.bmp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-m4v': '.m4v',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
}

_KNOWN_MEDIA_EXTS = {
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp',
    '.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv',
}


def _ext_from_magic(data: bytes) -> str | None:
    """Sniff first bytes to derive a file extension.

    Used as a fallback when neither the URL path nor the HTTP ``Content-Type``
    header tells us the extension — common for Google Drive ``/uc?export=
    download&id=...`` URLs serving MP4 with ``application/octet-stream``. The
    extension is what FE uses (regex on URL) to decide ``<video>`` vs ``<img>``,
    so getting it wrong renders an MP4 inside an image tag → broken thumbnail.
    """
    if not data or len(data) < 4:
        return None
    if data.startswith(b'\xff\xd8\xff'):
        return '.jpg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    if data.startswith(b'GIF8'):
        return '.gif'
    if data.startswith(b'BM'):
        return '.bmp'
    if len(data) >= 12 and data.startswith(b'RIFF'):
        if data[8:12] == b'WEBP':
            return '.webp'
        if data[8:12] == b'AVI ':
            return '.avi'
    if len(data) >= 12 and data[4:8] == b'ftyp':
        # MP4 / MOV / M4V / HEIC family — disambiguate by the brand bytes.
        brand = data[8:12]
        if brand in (b'heic', b'heix', b'mif1', b'msf1'):
            return '.heic'
        if brand == b'qt  ':
            return '.mov'
        if brand in (b'M4V ', b'M4VP', b'M4VH'):
            return '.m4v'
        return '.mp4'  # default the MP4 family to .mp4
    if data.startswith(b'\x1a\x45\xdf\xa3'):
        return '.mkv'  # EBML — could be .webm too; .mkv is the safer default
    return None


def _looks_like_media(data: bytes) -> bool:
    """Sniff first bytes for image/video magic numbers. Returns False for
    HTML/XML/text payloads (which Drive returns for share-page URLs, etc.).
    """
    if not data or len(data) < 4:
        return False
    # Image magic
    if data.startswith(b'\xff\xd8\xff'):
        return True  # JPEG
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return True  # PNG
    if data.startswith(b'GIF8'):
        return True  # GIF
    if data.startswith(b'BM'):
        return True  # BMP
    if len(data) > 11 and data.startswith(b'RIFF') and data[8:12] in (b'WEBP', b'AVI '):
        return True  # WEBP/AVI
    if len(data) > 11 and data[4:8] == b'ftyp':
        return True  # MP4/MOV/M4V/HEIC family
    if data.startswith(b'\x1a\x45\xdf\xa3'):
        return True  # WEBM/MKV (EBML)
    return False


def _read_response_with_limit(resp, max_bytes: int) -> tuple[bytes, str]:
    """Read a streaming ``Response`` body, enforcing a hard size ceiling.

    Uses ``Content-Length`` to reject the download BEFORE pulling bytes when
    the server declares the size. If the header is missing/invalid, streams
    in 64KiB chunks and aborts once the buffer exceeds ``max_bytes`` to
    protect the local disk + downstream S3.

    Returns ``(body_bytes, content_type)``. Raises ``APIException`` on
    overflow.
    """
    declared = resp.headers.get('Content-Length')
    if declared and declared.strip().isdigit():
        declared_n = int(declared.strip())
        if declared_n > max_bytes:
            resp.close()
            raise APIException(detail=(
                f"File nguồn nặng {declared_n // (1024 * 1024)} MB — vượt giới "
                f"hạn {max_bytes // (1024 * 1024)} MB. Hãy nén/cắt nhỏ file "
                "trước khi import để tránh quá tải S3."
            ))

    bytes_buf = bytearray()
    try:
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            bytes_buf.extend(chunk)
            if len(bytes_buf) > max_bytes:
                resp.close()
                raise APIException(detail=(
                    f"File nguồn vượt giới hạn {max_bytes // (1024 * 1024)} MB "
                    "trong khi tải (server không khai báo Content-Length). "
                    "Hủy bỏ để tránh quá tải S3."
                ))
    finally:
        try:
            resp.close()
        except Exception:
            pass
    content_type = (resp.headers.get('Content-Type') or '').split(';')[0].strip()
    return bytes(bytes_buf), content_type


def _spool_response(resp, max_bytes: int) -> tuple[SpooledTemporaryFile, str]:
    """Like :func:`_read_response_with_limit` but stream the body into a
    ``SpooledTemporaryFile`` instead of a bytes buffer: small files stay in RAM,
    big files spill to disk so a heavy video never sits in memory whole.

    Returns ``(file_obj, content_type)`` with the file rewound to position 0.
    Raises ``APIException`` on overflow. The caller owns the file (must close it).
    """
    declared = resp.headers.get('Content-Length')
    if declared and declared.strip().isdigit():
        declared_n = int(declared.strip())
        if declared_n > max_bytes:
            resp.close()
            raise APIException(detail=(
                f"File nguồn nặng {declared_n // (1024 * 1024)} MB — vượt giới "
                f"hạn {max_bytes // (1024 * 1024)} MB. Hãy nén/cắt nhỏ file "
                "trước khi import để tránh quá tải S3."
            ))

    spool = SpooledTemporaryFile(max_size=_SPOOL_MAX_RAM)
    total = 0
    try:
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                spool.close()
                resp.close()
                raise APIException(detail=(
                    f"File nguồn vượt giới hạn {max_bytes // (1024 * 1024)} MB "
                    "trong khi tải (server không khai báo Content-Length). "
                    "Hủy bỏ để tránh quá tải S3."
                ))
            spool.write(chunk)
    finally:
        try:
            resp.close()
        except Exception:
            pass
    spool.seek(0)
    content_type = (resp.headers.get('Content-Type') or '').split(';')[0].strip()
    return spool, content_type


def _drive_uc_get_with_confirm(
    media_url: str, session, max_bytes: int, timeout: int = 180,
) -> tuple[SpooledTemporaryFile, str]:
    """Drive ``uc?export=download`` serves a virus-scan HTML warning page for
    files >25 MB. Detect that page, lift the confirm token from cookies (or
    the HTML form), retry with ``&confirm=<token>``.

    Returns ``(file_obj, content_type)`` of the final file response. Falls
    back to the HTML response file if the workaround failed — caller's
    magic-byte check will reject it.
    """
    import re

    resp = session.get(media_url, timeout=timeout, allow_redirects=True, stream=True)
    resp.raise_for_status()
    spool, ct = _spool_response(resp, max_bytes)

    if 'html' not in ct.lower():
        return spool, ct

    # Warning page is tiny — safe to read it fully to lift the confirm token.
    text = spool.read().decode('latin-1', errors='replace')
    spool.seek(0)
    confirm = ''
    for ck_name, ck_val in session.cookies.items():
        if ck_name.startswith('download_warning'):
            confirm = ck_val
            break
    if not confirm:
        match = re.search(r'confirm=([0-9A-Za-z_\-]+)', text)
        if match:
            confirm = match.group(1)
    if not confirm:
        # Newer Drive variant uses a static "t" token on the virus-scan wall.
        if 'virus' in text.lower() or 'scan' in text.lower():
            confirm = 't'
        else:
            return spool, ct

    spool.close()  # drop the warning-page spool before fetching the real file
    sep = '&' if '?' in media_url else '?'
    retry_url = f"{media_url}{sep}confirm={confirm}"
    resp2 = session.get(retry_url, timeout=timeout, allow_redirects=True, stream=True)
    resp2.raise_for_status()
    return _spool_response(resp2, max_bytes)


def download_and_upload_image(media_url: str) -> str:
    """Download an image OR video from a public URL and re-upload it to S3.

    Despite the name (kept for backward compatibility), accepts both image and
    video URLs. Detection priority for the file extension (which drives the
    S3 Content-Type):

    1. Extension in the URL path (e.g. ``/foo/bar.mp4``).
    2. ``Content-Type`` HTTP response header (e.g. ``video/mp4``).
    3. Fallback to ``.jpg``.

    Files larger than ``FB_MEDIA_MAX_BYTES`` (default 500 MB; override via
    Django settings) are rejected up-front to avoid taking down S3.

    Returns the new S3 public URL. Raises ``APIException`` on failure.
    """
    import requests as http_requests
    from urllib.parse import urlparse

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
    max_bytes = int(getattr(settings, 'FB_MEDIA_MAX_BYTES', 500 * 1024 * 1024))

    try:
        # Use a Session so cookies set by Drive's virus-scan warning persist
        # across the follow-up confirm request.
        session = http_requests.Session()
        session.headers['User-Agent'] = (
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
            '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
        )
        is_drive_uc = (
            parsed.netloc.endswith('drive.google.com')
            and parsed.path.rstrip('/').endswith('/uc')
        )
        if is_drive_uc:
            file_obj, content_type = _drive_uc_get_with_confirm(
                media_url, session, max_bytes, timeout=180,
            )
        else:
            resp = session.get(media_url, timeout=120, stream=True)
            resp.raise_for_status()
            file_obj, content_type = _spool_response(resp, max_bytes)
    except APIException:
        raise  # already user-friendly
    except Exception as exc:
        raise APIException(detail=f"Failed to download media from {media_url}: {exc}") from exc

    try:
        # Peek only the first bytes for magic-byte detection — the body stays on
        # disk/RAM as a stream, never copied whole into memory.
        file_obj.seek(0)
        head = file_obj.read(120)
        file_obj.seek(0)

        # Magic-byte sniff: reject HTML/XML/text payloads so we never store a
        # share-page or login redirect into S3 as a fake image. This catches Drive
        # ``/file/d/.../view`` URLs and similar.
        if not _looks_like_media(head[:16]):
            head_preview = head.decode('latin-1', errors='replace')
            raise APIException(detail=(
                f"URL {media_url!r} không trả về file ảnh/video hợp lệ "
                f"(Content-Type={content_type!r}, bytes head={head_preview[:80]!r}). "
                "Có thể đây là URL trang share/preview thay vì link tải trực tiếp — "
                "với Google Drive, dùng URL dạng /file/d/{id}/view (đã share public) "
                "hoặc URL folder."
            ))

        if ext_from_path in _KNOWN_MEDIA_EXTS:
            filename = path_filename
        else:
            # Extension priority: header Content-Type → magic-byte sniff → .jpg.
            # The magic-byte fallback rescues Drive UC URLs that return
            # ``application/octet-stream`` for MP4s — without it the file lands on
            # S3 as ``.jpg`` and the FE renders ``<img>`` instead of ``<video>``.
            ext = _CONTENT_TYPE_TO_EXT.get(content_type.lower())
            if ext is None:
                ext = _ext_from_magic(head[:16]) or '.jpg'
            base = os.path.splitext(path_filename)[0] or 'download'
            filename = f"{base}{ext}"

        return upload_image_to_s3(file_obj, filename)
    finally:
        try:
            file_obj.close()
        except Exception:
            pass
