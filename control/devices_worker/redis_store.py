"""Redis-backed store for the set of currently connected ADB device serials.

Wraps the `connected_devices` Redis set used to track which physical /
emulator devices are currently plugged in to a host running the ADB scanner.

A companion hash `connected_devices_info` maps each serial to its identifier
(UUID supplied by the ADB scanner alongside the connect event).

A second companion hash `connected_devices_screen` maps each serial to a JSON
object containing screen dimensions (``screen_width``, ``screen_height``) and
pixel density (``density``) when those fields are present in the connect event.

A third companion hash `connected_devices_worker` maps each serial to the
``worker_id`` of the ADB scanner worker that reported the device.  This is
used by the Django backend to route task-execution messages to the correct
per-worker Kafka topic.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Iterable

import redis

logger = logging.getLogger(__name__)

# Key used to store the set of connected device serials.
DEVICES_SET_KEY = os.getenv("REDIS_DEVICES_KEY", "connected_devices")
# Hash key: field = serial, value = identifier (may be empty string).
DEVICES_INFO_KEY = os.getenv("REDIS_DEVICES_INFO_KEY", "connected_devices_info")
# Hash key: field = serial, value = JSON with screen_width/screen_height/density.
DEVICES_SCREEN_KEY = os.getenv("REDIS_DEVICES_SCREEN_KEY", "connected_devices_screen")
# Hash key: field = serial, value = worker_id of the ADB scanner worker.
DEVICES_WORKER_KEY = os.getenv("REDIS_DEVICES_WORKER_KEY", "connected_devices_worker")


def get_redis_client() -> redis.Redis:
    """Build a Redis client from the REDIS_URL env var."""
    url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
    return redis.Redis.from_url(url, decode_responses=True)


def add_device(
    client: redis.Redis,
    serial: str,
    identifier: str = "",
    screen_width: int | None = None,
    screen_height: int | None = None,
    density: int | None = None,
    worker_id: str = "",
) -> None:
    if not serial:
        return
    pipe = client.pipeline()
    pipe.sadd(DEVICES_SET_KEY, serial)
    if identifier:
        pipe.hset(DEVICES_INFO_KEY, serial, identifier)
    screen_info: dict = {}
    if screen_width is not None:
        screen_info["screen_width"] = screen_width
    if screen_height is not None:
        screen_info["screen_height"] = screen_height
    if density is not None:
        screen_info["density"] = density
    if screen_info:
        pipe.hset(DEVICES_SCREEN_KEY, serial, json.dumps(screen_info))
    if worker_id:
        pipe.hset(DEVICES_WORKER_KEY, serial, worker_id)
    pipe.execute()
    logger.info(
        "Redis: added device %s (identifier=%s, screen=%s, worker_id=%s)",
        serial,
        identifier or "<none>",
        screen_info or "<none>",
        worker_id or "<none>",
    )


def remove_device(client: redis.Redis, serial: str) -> None:
    if not serial:
        return
    pipe = client.pipeline()
    pipe.srem(DEVICES_SET_KEY, serial)
    pipe.hdel(DEVICES_INFO_KEY, serial)
    pipe.hdel(DEVICES_SCREEN_KEY, serial)
    pipe.hdel(DEVICES_WORKER_KEY, serial)
    pipe.execute()
    logger.info("Redis: removed device %s", serial)


def list_devices(client: redis.Redis) -> list[str]:
    return sorted(client.smembers(DEVICES_SET_KEY))


def list_devices_with_info(client: redis.Redis) -> list[dict]:
    """Return devices as ``[{"serial": ..., "identifier": ..., "screen_width": ..., "screen_height": ..., "density": ..., "worker_id": ...}, ...]`` sorted by serial."""
    serials = sorted(client.smembers(DEVICES_SET_KEY))
    if not serials:
        return []
    identifiers = client.hmget(DEVICES_INFO_KEY, *serials)
    screen_values = client.hmget(DEVICES_SCREEN_KEY, *serials)
    worker_ids = client.hmget(DEVICES_WORKER_KEY, *serials)
    result = []
    for i, s in enumerate(serials):
        entry: dict = {
            "serial": s,
            "identifier": identifiers[i] or "",
            "worker_id": worker_ids[i] or "",
        }
        raw_screen = screen_values[i]
        if raw_screen:
            try:
                entry.update(json.loads(raw_screen))
            except (ValueError, TypeError):
                pass
        result.append(entry)
    return result


def reset_devices(client: redis.Redis, serials: Iterable[str]) -> None:
    """Replace the entire set with the supplied serials in a single transaction."""
    pipe = client.pipeline()
    pipe.delete(DEVICES_SET_KEY)
    pipe.delete(DEVICES_INFO_KEY)
    pipe.delete(DEVICES_SCREEN_KEY)
    pipe.delete(DEVICES_WORKER_KEY)
    serials = [s for s in serials if s]
    if serials:
        pipe.sadd(DEVICES_SET_KEY, *serials)
    pipe.execute()
