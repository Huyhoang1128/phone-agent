"""Django management command — chạy kafka-task-status-listener process.

Subscribe Kafka `dev-task_status` (settings.KAFKA_TASK_STATUS_TOPIC), bridge sang
Redis `workflow:resume` để đánh thức workflow-runner đang WAITING_TASK.

Usage:
    python manage.py run_kafka_task_status_listener
    python manage.py run_kafka_task_status_listener --consumer-group myteam-listener
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from workflow.runner.kafka_listener import (
    DEFAULT_CONSUMER_GROUP,
    DEFAULT_CONSUMER_NAME,
    run_forever,
)


class Command(BaseCommand):
    help = 'Run the Kafka task_status listener (Phase 2.1 Chatbot TikTok).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--consumer-group',
            default=DEFAULT_CONSUMER_GROUP,
            help=(
                'Kafka consumer group. Mặc định: '
                f'{DEFAULT_CONSUMER_GROUP!r}. KHÔNG đổi tên giữa các dev cùng '
                'cluster nếu muốn chia tải; mỗi env tách prefix.'
            ),
        )
        parser.add_argument(
            '--consumer-name',
            default=DEFAULT_CONSUMER_NAME,
            help=f'Consumer instance name. Default: {DEFAULT_CONSUMER_NAME!r}',
        )

    def handle(self, *args, **opts):
        group = opts['consumer_group']
        name = opts['consumer_name']
        self.stdout.write(self.style.SUCCESS(
            f'Starting kafka-task-status-listener group={group} consumer={name}'
        ))
        run_forever(consumer_group=group, consumer_name=name)
        self.stdout.write(self.style.WARNING('kafka-task-status-listener stopped'))
