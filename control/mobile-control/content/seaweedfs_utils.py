"""SeaweedFS upload utilities for character images (face-swap feature).

Mirrors :func:`content.s3_utils.upload_character_image` but routes **new**
character media to the self-hosted SeaweedFS cluster instead of Cloudfly S3.

Old character images already stored on Cloudfly stay there and remain viewable:
``facebook.s3_utils.get_presigned_image_url`` passes through URLs whose host is
not the Cloudfly endpoint unchanged, so the public SeaweedFS Filer URLs written
here are returned as-is on read, while legacy ``s3.cloudfly.vn`` URLs are still
presigned.
"""
import base64
import logging
import uuid

from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework.exceptions import APIException

from facebook.seaweedfs_utils import _get_seaweedfs_client

from .image_utils import detect_provenance, format_meta, sanitize_image

logger = logging.getLogger(__name__)


def upload_character_image_to_seaweedfs(
    b64_or_data_uri: str,
    subfolder: str = 'media',
    *,
    sanitize: bool = False,
    sanitize_fmt: str = 'JPEG',
    sanitize_quality: int = 95,
    sanitize_max_edge: int | None = None,
) -> str:
    """Decode a base64 / data-URI string and upload it to SeaweedFS.

    Stores the file at ``characters/{subfolder}/{uuid}.{ext}`` in the SeaweedFS
    bucket and returns the public Filer URL.  Raises ``APIException`` on upload
    failure.  Sanitize behaviour matches
    :func:`content.s3_utils.upload_character_image` exactly.
    """
    data = b64_or_data_uri or ''

    # Already-hosted image URL (an existing character's stored source image, or an
    # image uploaded on a previous save that the client re-submits): it is NOT
    # base64 — return it unchanged instead of decoding. Decoding a URL throws
    # "Invalid base64 image data: Incorrect padding". Mirrors the http(s) guard in
    # ContentViewSet.generate_image.
    if data.startswith('http://') or data.startswith('https://'):
        return data

    # Strip a data-URI prefix (``data:image/png;base64,....``) if present.
    if ',' in data:
        data = data.split(',', 1)[1]

    # Normalise before decoding: base64.b64decode is strict, so a payload that
    # lost its trailing ``=`` padding (some encoders omit it) or picked up
    # whitespace/newlines in transit raises "Incorrect padding" and fails the
    # whole save for one image. Drop whitespace and restore the padding first.
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

        # Same provenance survival logging as the S3 path so the audit trail is
        # identical regardless of storage backend.
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
        client = _get_seaweedfs_client()
        client.put_object(
            Bucket=settings.SEAWEEDFS_BUCKET,
            Key=key,
            Body=raw,
            ContentType=content_type,
            ContentLength=len(raw),
        )
    except (BotoCoreError, ClientError) as exc:
        raise APIException(detail=f'Failed to upload character image to SeaweedFS: {exc}') from exc

    return f"{settings.SEAWEEDFS_PUBLIC_BASE_URL.rstrip('/')}/{key}"
