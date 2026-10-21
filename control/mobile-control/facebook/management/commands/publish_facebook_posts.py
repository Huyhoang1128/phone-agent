"""Management command: publish_facebook_posts

Finds all ``FacebookScheduledPost`` records whose ``scheduled_at`` is in the
past and whose ``status`` is still ``pending``, then publishes them to
Facebook via the Graph API.

Usage:
    python manage.py publish_facebook_posts

Typical usage is to run this every minute via a cron job or a Celery beat
periodic task:

    * * * * * cd /app && python manage.py publish_facebook_posts >> /var/log/fb_publish.log 2>&1
"""
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from facebook.models import FacebookScheduledPost, FacebookScheduledPostStatus
from facebook.views import _publish_to_facebook

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Publish all pending FacebookScheduledPost records that are due now.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='List due posts without publishing them.',
        )

    def handle(self, *args, **options):
        now = timezone.now()
        dry_run = options['dry_run']

        due_posts = (
            FacebookScheduledPost.objects
            .filter(status=FacebookScheduledPostStatus.PENDING, scheduled_at__lte=now)
            .select_related('page')
        )

        count = due_posts.count()
        if count == 0:
            self.stdout.write('No due posts found.')
            return

        self.stdout.write(f'Found {count} due post(s).')

        published = 0
        failed = 0

        for post in due_posts:
            page_name = post.page.name if post.page else f'page#{post.page_id}'
            if dry_run:
                self.stdout.write(
                    f'[DRY RUN] Would publish post #{post.id} to {page_name} '
                    f'(scheduled {post.scheduled_at})'
                )
                continue

            try:
                _publish_to_facebook(post)
                self.stdout.write(
                    self.style.SUCCESS(
                        f'Published post #{post.id} to {page_name} '
                        f'(fb_post_id={post.fb_post_id})'
                    )
                )
                published += 1
            except Exception as exc:
                self.stderr.write(
                    self.style.ERROR(
                        f'Failed to publish post #{post.id} to {page_name}: {exc}'
                    )
                )
                logger.exception('publish_facebook_posts: post #%s failed', post.id)
                failed += 1

        if not dry_run:
            self.stdout.write(f'Done. Published: {published}, Failed: {failed}')
