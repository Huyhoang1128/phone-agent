"""Long-running Kafka consumer that turns video-agent-worker ``task_status``
messages into ContentScenario render results.

The worker publishes progress/result messages shaped like::

    {"task_id": "scn12-ab..", "status": "completed", "content": "...",
     "video_url": "https://...", "payload": {...}}

We match ``task_id`` → ``ContentScenario.video_task_id`` and update the row so
the ``/video-status/`` endpoint (polled by the FE) can serve the result.

Run as its own always-on process (see docker-compose ``video-status-consumer``)::

    python manage.py consume_video_status
"""
from __future__ import annotations

import json
import logging
import time

from django.conf import settings
from django.core.management.base import BaseCommand

logger = logging.getLogger(__name__)

_DONE = {'completed', 'failed', 'cancelled'}

# On (re)start the consumer rewinds every partition this many seconds and reads
# forward. Large enough to catch results published during a brief outage, small
# enough to stay cheap — the status topic is shared with high-volume device
# tasks, so starting from 'earliest' would replay tens of thousands of messages.
_LOOKBACK_SECONDS = 6 * 3600


class Command(BaseCommand):
    help = 'Consume Kafka task_status and update ContentScenario video fields.'

    def handle(self, *args, **options):
        from kafka import KafkaConsumer, TopicPartition
        from kafka.admin import KafkaAdminClient

        from content_scenario.models import ContentScenario

        topic = getattr(settings, 'KAFKA_TASK_STATUS_TOPIC', 'task_status')
        servers = getattr(settings, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9094')
        group_id = getattr(settings, 'KAFKA_VIDEO_STATUS_GROUP_ID', 'video-status-consumer')

        consumer = KafkaConsumer(
            bootstrap_servers=servers,
            group_id=group_id,
            value_deserializer=lambda v: json.loads(v.decode('utf-8')),
            auto_offset_reset='latest',
            enable_auto_commit=True,
        )

        # Manually assign ALL partitions rather than subscribe-by-name: the group
        # coordinator was observed handing this consumer only 3 of the topic's 30
        # partitions, silently dropping every result that landed on the rest
        # (status keys are null → results round-robin across all partitions).
        # Get the count from the BROKER (authoritative + retried): a cold
        # consumer's partitions_for_topic() can race and return a partial set,
        # which is exactly how we ended up assigning only [0, 1, 2].
        num_partitions = 0
        for attempt in range(10):
            try:
                admin = KafkaAdminClient(bootstrap_servers=servers)
                try:
                    meta = admin.describe_topics([topic])
                finally:
                    admin.close()
                found = meta[0].get('partitions') if meta else None
                if found:
                    num_partitions = len(found)
                    break
            except Exception:  # noqa: BLE001
                logger.warning('consume_video_status: describe_topics attempt %d failed', attempt + 1)
            time.sleep(1)

        if not num_partitions:
            consumer.subscribe([topic])
            self.stdout.write(
                f'consume_video_status: could not read partition count for {topic!r} — '
                f'fell back to subscribe()'
            )
        else:
            tps = [TopicPartition(topic, p) for p in range(num_partitions)]
            consumer.assign(tps)
            # Rewind every partition ~_LOOKBACK_SECONDS and read forward. This is
            # deterministic (unlike 'latest', which can race a result published
            # around startup and skip it) and cheap (unlike 'earliest', which
            # replays the whole shared backlog). offsets_for_times → None for a
            # partition means no message in the window, so start at its tail.
            cutoff_ms = int((time.time() - _LOOKBACK_SECONDS) * 1000)
            starts = consumer.offsets_for_times({tp: cutoff_ms for tp in tps})
            for tp in tps:
                off = starts.get(tp)
                if off is not None:
                    consumer.seek(tp, off.offset)
                else:
                    consumer.seek_to_end(tp)
            self.stdout.write(
                f'consume_video_status: assigned {len(consumer.assignment())} '
                f'partitions of {topic!r}, reading from ~{_LOOKBACK_SECONDS // 3600}h '
                f'back, group {group_id!r}'
            )

        for msg in consumer:
            try:
                self._handle(msg.value, ContentScenario)
            except Exception:  # noqa: BLE001 — never let one bad message kill the loop
                logger.exception('consume_video_status: failed to handle message')

    @staticmethod
    def _handle(body: dict, ContentScenario) -> None:
        task_id = body.get('task_id')
        # Only scenario render tasks use this id prefix; ignore everything else
        # sharing the status topic (device tasks, other workers, …).
        if not task_id or not str(task_id).startswith('scn'):
            return
        scenario = ContentScenario.objects.filter(video_task_id=str(task_id)).first()
        if scenario is None:
            return

        raw_status = (body.get('status') or '').lower()
        content = body.get('content') or ''

        # Status is monotonic. 'completed' is final — a successful render produced
        # a real video URL — so ignore any later message (out-of-order across
        # partitions, or from another worker that also picked up this task_id) that
        # would otherwise downgrade the result back to 'processing'/'failed'.
        if scenario.video_status == 'completed':
            return

        if raw_status == 'completed':
            scenario.video_status = 'completed'
            scenario.video_url = body.get('video_url') or ''
            scenario.video_error = ''
        elif raw_status in ('failed', 'cancelled'):
            if scenario.video_status in ('failed', 'cancelled'):
                return  # already terminal — nothing to change
            scenario.video_status = raw_status
            scenario.video_error = content
        else:
            # Progress message: only meaningful before a terminal state is reached.
            if scenario.video_status not in ('', 'processing'):
                return
            scenario.video_status = 'processing'
        scenario.save(update_fields=['video_status', 'video_url', 'video_error', 'updated_at'])
        logger.info('scenario %s video → %s', scenario.id, scenario.video_status)
