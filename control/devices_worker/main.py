"""devices_worker entrypoint.

Consumes the `device-events` Kafka topic produced by ADB scanner workers and
maintains the set of currently connected device serials in Redis. The Django
backend reads this set to expose `/api/devices/connected/`.
"""
from __future__ import annotations

import asyncio
import logging
import os

from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from faststream import FastStream, Context, ContextRepo
from faststream.kafka import KafkaBroker

from kafka_consumer import handle_device_event, handle_task_status_event
from redis_store import get_redis_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)

logger = logging.getLogger(__name__)

BOOTSTRAP_SERVERS = os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9094")
DEVICE_EVENTS_TOPIC = os.environ.get("KAFKA_DEVICE_EVENTS_TOPIC", "device-events")
COMMANDS_TOPIC = os.environ.get("KAFKA_COMMANDS_TOPIC", "device-commands")
TASK_STATUS_TOPIC = os.environ.get("KAFKA_TASK_STATUS_TOPIC", "task_status")
CONSUMER_GROUP = os.getenv("KAFKA_DEVICES_WORKER_GROUP", "devices-worker")

broker = KafkaBroker(BOOTSTRAP_SERVERS)
app = FastStream(broker)


@broker.subscriber(DEVICE_EVENTS_TOPIC, group_id=CONSUMER_GROUP)
async def on_device_event(body: dict, redis_client=Context("redis_client")) -> None:
    await handle_device_event(body, redis_client)


@broker.subscriber(TASK_STATUS_TOPIC, group_id=CONSUMER_GROUP)
async def on_task_status(body: dict, redis_client=Context("redis_client")) -> None:
    await handle_task_status_event(body, redis_client)


async def _ensure_topic_exists(
    topic: str,
    num_partitions: int = 3,
    replication_factor: int = 1,
) -> None:
    """Create the topic if it does not already exist on the broker.

    This prevents the consumer from being stuck with zero partition assignments
    when the topic has not been created yet by the producer side.
    """
    admin_client = AIOKafkaAdminClient(
        bootstrap_servers=BOOTSTRAP_SERVERS,
        client_id="devices-worker-admin",
    )
    try:
        await admin_client.start()
        existing = await admin_client.list_topics()
        if topic in existing:
            logger.info("Topic '%s' already exists (partitions available)", topic)
            return

        logger.info("Topic '%s' not found – creating it now ...", topic)
        new_topic = NewTopic(
            name=topic,
            num_partitions=num_partitions,
            replication_factor=replication_factor,
        )
        await admin_client.create_topics([new_topic])
        logger.info(
            "Created topic '%s' (%d partitions, rf=%d)",
            topic,
            num_partitions,
            replication_factor,
        )
    except Exception:
        logger.warning(
            "Could not ensure topic '%s' exists – "
            "the consumer may not receive partition assignments if the topic "
            "has not been created by the producer yet.",
            topic,
            exc_info=True,
        )
    finally:
        await admin_client.close()


@app.on_startup
async def setup(context: ContextRepo) -> None:
    # 1. Ensure the device-events topic exists so the consumer can get partition
    #    assignments even if the ADB scanner producer has not started yet.
    await _ensure_topic_exists(DEVICE_EVENTS_TOPIC)
    await _ensure_topic_exists(TASK_STATUS_TOPIC)

    # 2. Set up Redis.
    client = get_redis_client()
    client.ping()
    context.set_global("redis_client", client)
    logger.info(
        "devices_worker started (bootstrap=%s, topic=%s, group=%s)",
        BOOTSTRAP_SERVERS,
        DEVICE_EVENTS_TOPIC,
        CONSUMER_GROUP,
    )

    # 3. Schedule the rescan to run after the broker connects.
    async def _send_rescan() -> None:
        """Wait for the broker to connect, then send a rescan command."""
        for attempt in range(30):
            try:
                await broker.publish({"action": "rescan"}, COMMANDS_TOPIC)
                logger.info("Sent rescan command to topic %s", COMMANDS_TOPIC)
                return
            except AssertionError:
                if attempt == 0:
                    logger.info("Broker not yet connected, waiting...")
                await asyncio.sleep(1)
        logger.warning(
            "Could not send rescan command: broker did not connect within 30s"
        )

    asyncio.create_task(_send_rescan())


@app.on_shutdown
async def close_redis(context: ContextRepo) -> None:
    client = context.get("redis_client")
    if client is not None:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup on shutdown
            pass
