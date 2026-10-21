"""FastStream handler that consumes ADB device events and updates Redis.

Expected payload shape (matches the reference ADB scanner producer):

    {"event": "connected",    "serial": "emulator-5554", "identifier": "uuid"}
    {"event": "connected",    "serial": "emulator-5554", "identifier": "uuid", "density": 320, "size": "720x1640"}
    {"event": "disconnected", "serial": "emulator-5554"}
"""
from __future__ import annotations

import logging

from redis_store import add_device, remove_device
from db_store import update_device_worker_id, clear_device_worker_id, update_task_status_and_result

logger = logging.getLogger(__name__)


def _parse_size(size: str) -> tuple[int | None, int | None]:
    """Parse a ``"WxH"`` size string into ``(width, height)`` integers.

    Returns ``(None, None)`` if the string is missing or malformed.
    """
    if not size:
        return None, None
    try:
        width_str, height_str = size.lower().split("x", 1)
        return int(width_str), int(height_str)
    except (ValueError, AttributeError):
        logger.warning("Could not parse size string %r", size)
        return None, None


async def handle_device_event(body: dict, redis_client) -> None:
    event = (body or {}).get("event", "")
    serial = (body or {}).get("serial", "")
    identifier = (body or {}).get("identifier", "")
    worker_id = (body or {}).get("worker_id", "")

    if not serial:
        logger.warning("Ignoring device event without serial: %s", body)
        return

    if event == "connected":
        density_raw = body.get("density")
        density: int | None = None
        if density_raw is not None:
            try:
                density = int(density_raw)
            except (ValueError, TypeError):
                logger.warning("Could not parse density value %r", density_raw)

        screen_width, screen_height = _parse_size(body.get("size", ""))

        add_device(
            redis_client,
            serial,
            identifier,
            screen_width=screen_width,
            screen_height=screen_height,
            density=density,
            worker_id=worker_id,
        )
        update_device_worker_id(serial, identifier, worker_id)
    elif event == "disconnected":
        remove_device(redis_client, serial)
        clear_device_worker_id(serial, identifier)
    else:
        logger.warning("Unknown device event %r for serial %s", event, serial)


async def handle_task_status_event(body: dict, redis_client) -> None:
    """Process a message from the ``task_status`` Kafka topic.

    Expected shape::

        {
            "task_id": 102,
            "device_serial_id": "416H4EFS2222A",
            "content": "...",
            "status": "processing" | "processed",
            "payload": {"agent": "tiktok"}
        }

    For every event the task's ``result`` array in the database is extended
    and the task status is updated.  The full event is then published to the
    Redis pub/sub channel ``task:{task_id}:events`` so that connected
    WebSocket clients receive it in real-time.
    """
    import json as _json

    task_id = (body or {}).get("task_id")
    kafka_status = (body or {}).get("status", "")

    if not task_id:
        logger.warning("Ignoring task_status event without task_id: %s", body)
        return

    # Persist to DB (update status + append event to result[])
    update_task_status_and_result(task_id, kafka_status, body)

    # Broadcast to WebSocket clients via Redis pub/sub
    channel = f"task:{task_id}:events"
    try:
        redis_client.publish(channel, _json.dumps(body))
        logger.debug("Published task event to Redis channel %s", channel)
    except Exception:
        logger.warning(
            "Failed to publish task event to Redis channel %s", channel, exc_info=True
        )
