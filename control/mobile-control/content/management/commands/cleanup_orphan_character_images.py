"""Delete SeaweedFS character images no longer referenced by any Character.

Since ``ContentViewSet.generate_image`` pre-uploads every freshly generated image
to SeaweedFS (so saving a character can reference it by URL instead of re-POSTing
the base64), images the user generates but never saves become orphan objects.
This command reaps them: it lists every object under the ``characters/`` prefix,
subtracts the keys still referenced by a Character row (``source_image_url`` plus
every ``media`` / ``scenes`` / ``videos`` item URL — including hidden ones), and
deletes the remainder.

An age guard (``--min-age-hours``, default 24h) protects objects from an
in-progress session that has generated but not yet saved — only objects older
than the cutoff are eligible, so a user mid-wizard never loses their images.

Examples::

    python manage.py cleanup_orphan_character_images --dry-run
    python manage.py cleanup_orphan_character_images --min-age-hours 48
"""
from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlparse

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from content.models import Character
from facebook.seaweedfs_utils import _get_seaweedfs_client

CHARACTERS_PREFIX = 'characters/'


def _key_from_url(url: str) -> str | None:
    """Extract the S3 object key from a stored SeaweedFS URL (or raw key).

    Stored URLs look like ``http://host:8888/buckets/<bucket>/characters/…`` (the
    Filer serves S3 buckets under a ``/buckets/`` path prefix), while the S3 key
    returned by ``list_objects_v2`` is just ``characters/…``. Both the ``buckets/``
    Filer prefix AND the bucket segment must be stripped so a referenced URL maps
    to the SAME key space the listing uses — otherwise nothing matches and every
    saved image looks orphaned."""
    if not url or not isinstance(url, str):
        return None
    if url.startswith(CHARACTERS_PREFIX):
        return url
    path = urlparse(url).path.lstrip('/')
    if path.startswith('buckets/'):
        path = path[len('buckets/'):]
    bucket = settings.SEAWEEDFS_BUCKET.strip('/')
    if path.startswith(bucket + '/'):
        path = path[len(bucket) + 1:]
    return path or None


def _referenced_keys() -> tuple[set[str], int]:
    """Every characters/ key still pointed at by a Character row, plus the count
    of raw image-URL strings seen (used as a fail-safe: URLs-seen but 0 keys
    resolved means the URL→key mapping is broken — don't mass-delete)."""
    keys: set[str] = set()
    urls_seen = 0

    def _add(url):
        nonlocal urls_seen
        if not url or not isinstance(url, str):
            return
        urls_seen += 1
        key = _key_from_url(url)
        if key and key.startswith(CHARACTERS_PREFIX):
            keys.add(key)

    # .iterator() keeps memory flat even with many characters; hidden rows and
    # hidden per-image items still count so we never delete a recoverable image.
    for char in Character.objects.all().iterator():
        _add(char.source_image_url)
        for field in (char.media, char.scenes, char.videos):
            for item in (field or []):
                if isinstance(item, dict):
                    _add(item.get('url'))
    return keys, urls_seen


class Command(BaseCommand):
    help = 'Delete SeaweedFS characters/ images not referenced by any Character.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--min-age-hours', type=int, default=24,
            help='Only delete objects older than this many hours (default 24).',
        )
        parser.add_argument(
            '--dry-run', action='store_true',
            help='List what would be deleted without deleting anything.',
        )

    def handle(self, *args, **options):
        min_age_hours = options['min_age_hours']
        dry_run = options['dry_run']
        cutoff = timezone.now() - timedelta(hours=min_age_hours)

        referenced, urls_seen = _referenced_keys()
        self.stdout.write(f'Referenced characters/ objects: {len(referenced)} (from {urls_seen} stored URLs)')

        # Fail-safe: if the DB holds image URLs but NONE resolved to a
        # characters/ key, the URL→key mapping is broken (e.g. the storage URL
        # format changed) — every object would look orphaned and we'd wipe live
        # data. Refuse to proceed rather than mass-delete.
        if urls_seen > 0 and not referenced:
            self.stderr.write(self.style.ERROR(
                'Aborting: found %d stored image URLs but resolved 0 referenced '
                'keys — the URL→key mapping looks broken. No objects deleted.' % urls_seen
            ))
            return

        client = _get_seaweedfs_client()
        bucket = settings.SEAWEEDFS_BUCKET
        paginator = client.get_paginator('list_objects_v2')

        scanned = deleted = skipped_young = 0
        for page in paginator.paginate(Bucket=bucket, Prefix=CHARACTERS_PREFIX):
            for obj in page.get('Contents', []) or []:
                scanned += 1
                key = obj['Key']
                if key in referenced:
                    continue
                # LastModified is tz-aware (UTC) from botocore.
                if obj.get('LastModified') and obj['LastModified'] > cutoff:
                    skipped_young += 1
                    continue
                if dry_run:
                    self.stdout.write(f'  would delete: {key}')
                    deleted += 1
                    continue
                try:
                    client.delete_object(Bucket=bucket, Key=key)
                    deleted += 1
                except Exception as exc:  # noqa: BLE001 — keep going on a single failure
                    self.stderr.write(f'  delete failed for {key}: {exc}')

        verb = 'would delete' if dry_run else 'deleted'
        self.stdout.write(self.style.SUCCESS(
            f'Scanned {scanned} objects; {verb} {deleted}; '
            f'skipped {skipped_young} younger than {min_age_hours}h.'
        ))
