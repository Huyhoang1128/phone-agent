"""Kafka producer utility for sending messages to Kafka topics."""
import json
import logging
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)


def _get_bootstrap_servers() -> str:
    return getattr(settings, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9094')


def _get_task_topic() -> str:
    return getattr(settings, 'KAFKA_TASK_TOPIC', 'task_execution')


def _get_device_commands_topic() -> str:
    return getattr(settings, 'KAFKA_DEVICE_COMMANDS_TOPIC', 'device-commands')


def send_message(topic: str, message: dict[str, Any], key: str | None = None) -> bool:
    """
    Send a JSON message to a Kafka topic.

    If *key* is provided it is encoded as UTF-8 bytes and used as the Kafka
    message key (useful for partition routing / ordering guarantees).

    Returns True on success, False on failure.
    """
    try:
        from kafka import KafkaProducer

        producer = KafkaProducer(
            bootstrap_servers=_get_bootstrap_servers(),
            value_serializer=lambda v: json.dumps(v).encode('utf-8'),
        )
        encoded_key = key.encode('utf-8') if key else None
        future = producer.send(topic, message, key=encoded_key)
        producer.flush()
        future.get(timeout=10)
        producer.close()
        return True
    except Exception as exc:
        logger.error('Failed to send Kafka message to topic %s: %s', topic, exc)
        return False


def send_task_execution_message(task, devices_id: list[int] | None = None, profile_id: int | None = None) -> bool:
    """
    Publish one task execution message per device to the task topic.

    Each message contains a single ``device_serial_id`` string (the hardware
    serial) rather than a list of database PKs.  ``goal`` is set to the task
    description and ``app`` to the agent name (e.g. ``"tiktok"``).

    If *profile_id* is given the message also includes ``profile_id``,
    ``profile_goal`` and ``profile_personality`` from the associated Profile.

    When a device's ``worker_id`` is stored in Redis the message is sent to
    ``<KAFKA_TASK_TOPIC>_<worker_id>`` so that the correct ADB scanner worker
    receives it.  Devices without a ``worker_id`` fall back to the default
    ``KAFKA_TASK_TOPIC``.

    Returns True when every message is delivered successfully, False if any
    delivery fails.
    """
    from devices.models import Device
    from mbcontrol.redis_utils import get_device_worker_id

    payload = task.payload or {}
    payload_app = payload.get('app')
    if payload_app and payload_app != 'default':
        app = payload_app
    else:
        agent = payload.get('agent')
        app = agent if agent and agent != 'default' else None

    serial_ids: list[str] = []
    if devices_id:
        device_map: dict[int, str] = dict(
            Device.objects.filter(id__in=devices_id)
            .values_list('id', 'device_serial_id')
        )
        missing = [pk for pk in devices_id if pk not in device_map]
        if missing:
            logger.warning('Task %s: device PKs not found: %s', task.id, missing)
        serial_ids = [device_map[pk] for pk in devices_id if pk in device_map]

    base = {
        'task_id': task.id,
        'name': task.name,
        'description': task.description,
        'task_type': task.task_type,
        'status': task.status,
        'payload': payload,
        'goal': task.description,
        'app': app,
    }

    if profile_id is not None:
        from profiles.models import Profile
        try:
            profile = Profile.objects.get(id=profile_id)
            base['profile_id'] = profile.id
            base['profile_goal'] = profile.goal
            base['profile_personality'] = profile.personality
        except Profile.DoesNotExist:
            logger.warning('Task %s: profile %s not found', task.id, profile_id)

    default_topic = _get_task_topic()
    if not serial_ids:
        return send_message(default_topic, base)

    all_delivered = True
    for serial_id in serial_ids:
        worker_id = get_device_worker_id(serial_id)
        topic = f"{default_topic}-{worker_id}" if worker_id else default_topic
        message = {**base, 'device_serial_id': serial_id}
        if not send_message(topic, message, key=serial_id):
            all_delivered = False
    return all_delivered


def _publish_device_command(serial: str, message: dict) -> bool:
    """Send *message* to ``device-commands`` (or the worker-specific variant
    when the device's worker_id is known from Redis), keyed by *serial* so
    Kafka preserves command order on the same device.
    """
    from mbcontrol.redis_utils import get_device_worker_id

    default_topic = _get_device_commands_topic()
    worker_id = get_device_worker_id(serial)
    topic = f"{default_topic}-{worker_id}" if worker_id else default_topic
    return send_message(topic, message, key=serial)


def send_install_app_command(installation) -> bool:
    """
    Publish an ``install_app`` command for *installation* to the device worker.

    Message contract::

        {
            "action": "install_app",
            "command_id": "<uuid>",            # idempotency key
            "installation_id": <int>,          # control-plane PK to call back with
            "devices_serical": "<serial>",     # kept misspelled to match the
                                               # existing worker contract
            "app": {
                "id": <int>,
                "name": "<str>",
                "package_name": "<str>",
                "platform": "android" | "ios",
                "version": "<str>",
                "apk_url": "<https URL to download the APK from S3>"
            }
        }

    Returns True on Kafka delivery success.
    """
    device = getattr(installation, 'device', None)
    serial = (getattr(device, 'device_serial_id', '') or '').strip()
    if not serial:
        logger.warning(
            'Installation %s: no device_serial_id; skipping install_app dispatch',
            installation.id,
        )
        return False

    app = installation.app
    apk_url = (app.apk_url or '').strip()
    if not apk_url:
        logger.warning(
            'Installation %s: app %s has no apk_url; skipping install_app dispatch',
            installation.id, app.id,
        )
        return False

    message = {
        'action': 'install_app',
        'command_id': str(installation.command_id),
        'installation_id': installation.id,
        'devices_serical': serial,
        'app': {
            'id': app.id,
            'name': app.name,
            'package_name': app.package_name,
            'platform': app.platform,
            'version': app.version,
            'apk_url': apk_url,
        },
    }
    return _publish_device_command(serial, message)


def send_uninstall_app_command(installation) -> bool:
    """
    Publish an ``uninstall_app`` command for *installation*.

    Message contract::

        {
            "action": "uninstall_app",
            "command_id": "<uuid>",
            "installation_id": <int>,
            "devices_serical": "<serial>",
            "app": {
                "id": <int>,
                "package_name": "<str>",       # what the worker uses for `adb uninstall`
                "platform": "android" | "ios"
            }
        }
    """
    device = getattr(installation, 'device', None)
    serial = (getattr(device, 'device_serial_id', '') or '').strip()
    if not serial:
        logger.warning(
            'Installation %s: no device_serial_id; skipping uninstall_app dispatch',
            installation.id,
        )
        return False

    app = installation.app
    if not app.package_name:
        # Without a package_name the worker cannot identify the app to remove.
        logger.warning(
            'Installation %s: app %s has no package_name; skipping uninstall_app dispatch',
            installation.id, app.id,
        )
        return False

    message = {
        'action': 'uninstall_app',
        'command_id': str(installation.command_id),
        'installation_id': installation.id,
        'devices_serical': serial,
        'app': {
            'id': app.id,
            'package_name': app.package_name,
            'platform': app.platform,
        },
    }
    return _publish_device_command(serial, message)


def send_stop_task_message(task) -> bool:
    """
    Publish a ``stop_task`` command to the ``device-commands`` Kafka topic.

    The message format matches the device-commands contract::

        {
            "action": "stop_task",
            "devices_serical": "<device_serial_id>",
            "task_id": <task_id>,
        }

    The device serial is used as the Kafka message key for partition routing.
    Returns True on success, False if delivery fails or no serial is available.
    """
    serial = getattr(task, 'device_serial', '') or ''
    if not serial:
        logger.warning('Task %s: no device_serial set, skipping stop_task command', task.id)
        return False

    message = {
        'action': 'stop_task',
        'devices_serical': serial,
        'task_id': task.id,
    }
    return send_message(_get_device_commands_topic(), message, key=serial)
