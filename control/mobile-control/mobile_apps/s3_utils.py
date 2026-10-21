import os
import uuid

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework.exceptions import APIException

_s3_client = None


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            's3',
            endpoint_url=settings.CLOUDFLY_S3_ENDPOINT,
            aws_access_key_id=settings.CLOUDFLY_ACCESS_KEY,
            aws_secret_access_key=settings.CLOUDFLY_SECRET_KEY,
            config=Config(
                signature_version='s3v4',
                # botocore >= 1.36 enables flexible (aws-chunked) checksums by
                # default, which makes PutObject send Content-Encoding:
                # aws-chunked instead of a plain Content-Length. S3-compatible
                # providers like Cloudfly reject that with MissingContentLength.
                # Restrict checksums to "when_required" to keep the classic
                # Content-Length upload path.
                request_checksum_calculation='when_required',
                response_checksum_validation='when_required',
            ),
        )
    return _s3_client


def upload_apk_to_s3(file_obj, original_filename: str) -> str:
    """Upload *file_obj* to S3 and return the public URL.

    A UUID prefix is prepended to *original_filename* to avoid collisions.
    The target bucket must be configured to allow public read access via
    bucket policy or ACL on the Cloudfly console.
    """
    ext = os.path.splitext(original_filename)[1].lower()
    key = f"apks/{uuid.uuid4().hex}{ext}"

    try:
        client = _get_s3_client()

        # Ensure we read from the beginning of the file.
        if hasattr(file_obj, 'seek'):
            file_obj.seek(0)

        # Determine the file size so we can provide an explicit Content-Length.
        # This avoids the MissingContentLength error that some S3-compatible
        # providers raise during the UploadPart call of a multipart upload.
        file_size = getattr(file_obj, 'size', None)
        if file_size is None:
            if hasattr(file_obj, 'seek'):
                file_obj.seek(0, 2)
                file_size = file_obj.tell()
                file_obj.seek(0)

        # Use put_object with an explicit ContentLength to bypass multipart
        # upload entirely, which is incompatible with certain S3-compatible
        # endpoints when the part content-length is not known up front.
        put_kwargs = {
            'Bucket': settings.CLOUDFLY_BUCKET,
            'Key': key,
            'Body': file_obj,
            'ContentType': _content_type(ext),
        }
        if file_size is not None:
            put_kwargs['ContentLength'] = file_size

        client.put_object(**put_kwargs)
    except (BotoCoreError, ClientError) as exc:
        raise APIException(
            detail=f"Failed to upload file to S3: {exc}"
        ) from exc
    finally:
        try:
            file_obj.close()
        except Exception:
            pass

    public_url = f"{settings.CLOUDFLY_PUBLIC_BASE_URL.rstrip('/')}/{key}"
    return public_url


def _content_type(ext: str) -> str:
    mapping = {
        '.apk': 'application/vnd.android.package-archive',
        '.xapk': 'application/vnd.android.package-archive',
        '.apkm': 'application/vnd.android.package-archive',
        '.zip': 'application/zip',
    }
    return mapping.get(ext, 'application/octet-stream')
