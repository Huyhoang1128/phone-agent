"""Backfill Content.origin_frames for rows generated before migration 0006.

The ChatRefine "Khôi phục bản gốc" button reads ``Content.origin_frames``;
without a snapshot it would 404. Most legacy rows are taken care of by the
lazy fallback in ``ContentViewSet.retrieve`` the first time they're opened,
but a one-off eager backfill is faster and lets us delete the lazy hook
in v1.1 once observed quiet.

Run::

    docker compose -f docker-compose.dev.yml exec backend \
        python manage.py backfill_origin_frames

Idempotent — re-running is a no-op.
"""

from __future__ import annotations

import copy

from django.core.management.base import BaseCommand
from django.db import transaction

from content.models import Content, ContentSourceType


class Command(BaseCommand):
    help = (
        "Snapshot Content.frames → Content.origin_frames for generated rows "
        "that don't have an origin snapshot yet."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Report counts without writing anything.',
        )
        parser.add_argument(
            '--chunk-size',
            type=int,
            default=200,
            help='Iterate-and-save batch size (default 200).',
        )

    def handle(self, *args, **options):
        dry = bool(options.get('dry_run'))
        chunk = int(options.get('chunk_size') or 200)

        # Only generated rows have frames worth snapshotting. Manual content
        # rows have no scenario-frame editor.
        qs = (
            Content.objects
            .filter(source_type=ContentSourceType.GENERATED)
            .exclude(frames=[])
        )

        updated = 0
        skipped = 0
        scanned = 0
        for c in qs.iterator(chunk_size=chunk):
            scanned += 1
            if c.origin_frames:
                skipped += 1
                continue
            if dry:
                updated += 1
                continue
            with transaction.atomic():
                c.origin_frames = copy.deepcopy(c.frames)
                c.save(update_fields=['origin_frames'])
            updated += 1

        prefix = '[DRY-RUN] ' if dry else ''
        self.stdout.write(self.style.SUCCESS(
            f"{prefix}Backfill done. scanned={scanned} updated={updated} skipped={skipped}"
        ))
