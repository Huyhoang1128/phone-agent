"""Django management command — chạy workflow dlq-handler process.

Usage:
    python manage.py run_workflow_dlq_handler
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from workflow.runner.dlq_handler import DEFAULT_CONSUMER_NAME, run_forever


class Command(BaseCommand):
    help = 'Run the workflow DLQ handler process (Phase 2.1 Chatbot TikTok).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--consumer-name',
            default=DEFAULT_CONSUMER_NAME,
            help=f'Consumer instance name. Default: {DEFAULT_CONSUMER_NAME!r}',
        )

    def handle(self, *args, **opts):
        consumer_name = opts['consumer_name']
        self.stdout.write(self.style.SUCCESS(
            f'Starting workflow-dlq-handler consumer={consumer_name}'
        ))
        run_forever(consumer_name=consumer_name)
        self.stdout.write(self.style.WARNING('workflow-dlq-handler stopped'))
