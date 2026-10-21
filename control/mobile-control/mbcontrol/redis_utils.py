"""Redis helpers shared across the Django backend."""
from __future__ import annotations

import json
import logging

import redis
from django.conf import settings

logger = logging.getLogger(__name__)


def get_redis_client() -> redis.Redis:
    """Return a Redis client bound to the configured `REDIS_URL`."""
    return redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)


def get_connected_device_serials() -> list[str]:
    """
    Return the sorted list of device serials currently in the Redis
    `connected_devices` set, as maintained by the `devices_worker` service.

    Returns an empty list if Redis is unavailable.
    """
    try:
        client = get_redis_client()
        members = client.smembers(settings.REDIS_DEVICES_KEY)
        return sorted(members)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully
        logger.warning('Failed to read connected devices from Redis: %s', exc)
        return []


def get_connected_devices() -> list[dict]:
    """
    Return connected devices as ``[{"serial": ..., "identifier": ..., "screen_width": ..., "screen_height": ..., "density": ..., "worker_id": ...}, ...]``
    sorted by serial, including the identifier, optional screen info, and worker_id stored by the devices_worker.

    Returns an empty list if Redis is unavailable.
    """
    try:
        client = get_redis_client()
        serials = sorted(client.smembers(settings.REDIS_DEVICES_KEY))
        if not serials:
            return []
        info_key = getattr(settings, 'REDIS_DEVICES_INFO_KEY', 'connected_devices_info')
        screen_key = getattr(settings, 'REDIS_DEVICES_SCREEN_KEY', 'connected_devices_screen')
        worker_key = getattr(settings, 'REDIS_DEVICES_WORKER_KEY', 'connected_devices_worker')
        identifiers = client.hmget(info_key, *serials)
        screen_values = client.hmget(screen_key, *serials)
        worker_ids = client.hmget(worker_key, *serials)
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
    except Exception as exc:  # noqa: BLE001 - degrade gracefully
        logger.warning('Failed to read connected devices from Redis: %s', exc)
        return []


def get_device_worker_id(serial: str) -> str:
    """
    Return the ``worker_id`` for the given device serial as stored in Redis
    by the devices_worker.

    Returns an empty string if the serial is not found or Redis is unavailable.
    """
    if not serial:
        return ""
    try:
        client = get_redis_client()
        worker_key = getattr(settings, 'REDIS_DEVICES_WORKER_KEY', 'connected_devices_worker')
        value = client.hget(worker_key, serial)
        return value or ""
    except Exception as exc:  # noqa: BLE001 - degrade gracefully
        logger.warning('Failed to read worker_id for %s from Redis: %s', serial, exc)
        return ""


def get_device_screen_info(serial: str) -> dict:
    """
    Return screen info (``screen_width``, ``screen_height``, ``density``) for a
    specific device serial as stored in Redis by the devices_worker.

    Returns an empty dict if the serial is not found or Redis is unavailable.
    """
    if not serial:
        return {}
    try:
        client = get_redis_client()
        screen_key = getattr(settings, 'REDIS_DEVICES_SCREEN_KEY', 'connected_devices_screen')
        raw = client.hget(screen_key, serial)
        if raw:
            return json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully
        logger.warning('Failed to read screen info for %s from Redis: %s', serial, exc)
    return {}
