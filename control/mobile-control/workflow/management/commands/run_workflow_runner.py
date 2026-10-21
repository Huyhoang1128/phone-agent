"""Django management command — chạy workflow-runner process.

Usage:
    python manage.py run_workflow_runner
    python manage.py run_workflow_runner --consumer-name worker-1
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from workflow.runner.loop import DEFAULT_CONSUMER_NAME, run_forever


class Command(BaseCommand):
    help = 'Run the workflow-runner process (Phase 2.1 Chatbot TikTok).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--consumer-name',
            default=DEFAULT_CONSUMER_NAME,
            help=(
                'Tên định danh consumer instance (unique per process). '
                f'Default: {DEFAULT_CONSUMER_NAME!r} (hostname-pid).'
            ),
        )

    def handle(self, *args, **opts):
        consumer_name = opts['consumer_name']
        self.stdout.write(
            self.style.SUCCESS(f'Starting workflow-runner consumer={consumer_name}')
        )
        run_forever(consumer_name=consumer_name)
        self.stdout.write(self.style.WARNING('workflow-runner stopped'))
