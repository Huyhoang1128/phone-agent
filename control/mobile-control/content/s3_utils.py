"""S3 upload utilities for character images (face-swap feature).

Uploads to the ``characters/`` prefix in the configured Cloudfly/S3 bucket,
separate from Facebook images (``facebook/``) and APK uploads (``apks/``).
"""
import base64
import logging
import uuid

from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework.exceptions import APIException

from facebook.s3_utils import _get_s3_client

from .image_utils import detect_provenance, format_meta, sanitize_image

logger = logging.getLogger(__name__)


def upload_character_image(
    b64_or_data_uri: str,
    subfolder: str = 'media',
    *,
    sanitize: bool = False,
    sanitize_fmt: str = 'JPEG',
    sanitize_quality: int = 95,
    sanitize_max_edge: int | None = None,
) -> str:
    """Decode a base64 / data-URI string and upload it to S3.

    Stores the file at ``characters/{subfolder}/{uuid}.{ext}`` and returns the
    public URL.  Raises ``APIException`` on upload failure.

    When ``sanitize`` is True the image is re-encoded through Pillow before
    upload (see :func:`content.image_utils.sanitize_image`), which strips EXIF /
    XMP / IPTC side-cars and any embedded C2PA manifest. This is an opt-in
    research / privacy switch; the default (False) preserves the original bytes
    and the legacy ``.png`` behaviour exactly.
    """
    data = b64_or_data_uri or ''

    # Already-hosted image URL (not base64) → return unchanged instead of decoding
    # it (decoding a URL throws "Incorrect padding"). Mirrors seaweedfs_utils.
    if data.startswith('http://') or data.startswith('https://'):
        return data

    if ',' in data:
        data = data.split(',', 1)[1]

    # base64.b64decode is strict: restore missing ``=`` padding and drop stray
    # whitespace/newlines so a payload that lost padding or picked up whitespace
    # in transit doesn't fail the whole save with "Incorrect padding".
    data = ''.join(data.split())
    data += '=' * (-len(data) % 4)

    try:
        raw = base64.b64decode(data)
    except Exception as exc:
        raise APIException(detail=f'Invalid base64 image data: {exc}') from exc

    if sanitize:
        before = detect_provenance(raw)
        try:
            raw = sanitize_image(
                raw,
                fmt=sanitize_fmt,
                quality=sanitize_quality,
                max_edge=sanitize_max_edge,
            )
        except Exception as exc:
            raise APIException(detail=f'Failed to sanitize image: {exc}') from exc
        content_type, ext = format_meta(sanitize_fmt)

        # Validation: confirm the re-encode actually removed the container-level
        # provenance markers. Logged per upload so the survival study has a
        # before/after record for every saved image (scenes included). NB: this
        # only covers container markers, NOT pixel watermarks / ML classifiers.
        after = detect_provenance(raw)
        leftover = [k for k in ('xmp_ai', 'c2pa', 'exif') if after[k]]
        if leftover:
            logger.warning(
                'provenance: %s/%s markers SURVIVED sanitize (before=%s, after=%s)',
                ','.join(leftover), subfolder, before, after,
            )
        elif before['any']:
            logger.info(
                'provenance: %s markers stripped on %s (before=%s)',
                ','.join(k for k in ('xmp_ai', 'c2pa', 'exif') if before[k]),
                subfolder, before,
            )
    else:
        content_type, ext = 'image/png', 'png'

    key = f'characters/{subfolder}/{uuid.uuid4().hex}.{ext}'

    try:
        client = _get_s3_client()
        client.put_object(
            Bucket=settings.CLOUDFLY_BUCKET,
            Key=key,
            Body=raw,
            ContentType=content_type,
            ContentLength=len(raw),
        )
    except (BotoCoreError, ClientError) as exc:
        raise APIException(detail=f'Failed to upload character image to S3: {exc}') from exc

    return f"{settings.CLOUDFLY_PUBLIC_BASE_URL.rstrip('/')}/{key}"
