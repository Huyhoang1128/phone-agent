import asyncio
import json
import os
import subprocess
import logging

logger = logging.getLogger(__name__)

SCAN_INTERVAL = int(os.getenv("ADB_SCAN_INTERVAL", "5"))


def _get_connected_devices() -> set:
    try:
        result = subprocess.run(
            ["adb", "devices"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        devices = set()
        for line in result.stdout.splitlines()[1:]:
            line = line.strip()
            if line and not line.startswith("*") and "\t" in line:
                serial, state = line.split("\t", 1)
                if state.strip() == "device":
                    devices.add(serial.strip())
        return devices
    except Exception as exc:
        logger.error("adb scan failed: %s", exc)
        return set()


def _get_device_id(serial: str) -> str | None:
    """Query the device identifier via the Mobilerun Portal content provider.

    First sets the device serial, then queries the device ID.
    Runs:
      adb -s <serial> shell content insert --uri content://com.mobilerun.portal/set_device_serial --bind serial:s:<serial>
      adb -s <serial> shell content query --uri content://com.mobilerun.portal/get_device_id
    Returns the device UUID string, or None on failure.
    """
    try:
        # First, set the device serial so the portal knows which device we're querying
        subprocess.run(
            ["adb", "-s", serial, "shell", "content", "insert",
             "--uri", "content://com.mobilerun.portal/set_device_serial",
             "--bind", f"serial:s:{serial}"],
            capture_output=True,
            text=True,
            timeout=15,
        )

        # Then query the device ID
        result = subprocess.run(
            ["adb", "-s", serial, "shell", "content", "query",
             "--uri", "content://com.mobilerun.portal/get_device_id"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        # Expected output: "Row: 0 result={"status":"success","result":"<uuid>"}"
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("Row:"):
                # Extract the JSON part after "result="
                _, _, raw = line.partition("result=")
                if raw:
                    payload = json.loads(raw)
                    if payload.get("status") == "success":
                        return payload["result"]
        logger.warning("Could not parse device_id from output: %s", result.stdout.strip())
        return None
    except Exception as exc:
        logger.error("Failed to get device_id for %s: %s", serial, exc)
        return None


def _get_device_display_info(serial: str) -> dict:
    """Query the device display density and size via ADB.

    Runs:
      adb -s <serial> shell wm density
      adb -s <serial> shell wm size
    Returns a dict with 'density' (int) and 'size' (str), or empty dict on failure.
    """
    info = {}
    try:
        # Get density
        result = subprocess.run(
            ["adb", "-s", serial, "shell", "wm", "density"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("Physical density:"):
                try:
                    info["density"] = int(line.split(":")[1].strip())
                except (ValueError, IndexError):
                    pass
                break

        # Get screen size
        result = subprocess.run(
            ["adb", "-s", serial, "shell", "wm", "size"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("Physical size:"):
                info["size"] = line.split(":", 1)[1].strip()
                break
    except Exception as exc:
        logger.error("Failed to get display info for %s: %s", serial, exc)

    return info


async def _publish_device_event(broker, topic: str, event: str, serial: str, worker_id: str = "") -> None:
    """Build and publish a device event, enriching it with the device identifier and display info."""
    identifier = await asyncio.to_thread(_get_device_id, serial)
    display_info = await asyncio.to_thread(_get_device_display_info, serial)
    payload = {"event": event, "serial": serial}
    if worker_id:
        payload["worker_id"] = worker_id
    if identifier:
        payload["identifier"] = identifier
    if display_info:
        payload.update(display_info)
    await broker.publish(payload, topic)
    logger.info(
        "Published %s event for device %s (worker_id=%s, identifier=%s, density=%s, size=%s)",
        event, serial, worker_id, identifier,
        display_info.get("density"), display_info.get("size"),
    )


async def rescan_and_publish(broker, topic: str, worker_id: str = "") -> None:
    """Scan all currently connected devices and publish a 'connected' event for each."""
    logger.info("Rescan triggered – publishing all connected devices to topic '%s'", topic)
    devices: set[str] = await asyncio.to_thread(_get_connected_devices)
    for serial in devices:
        await _publish_device_event(broker, topic, "connected", serial, worker_id)
    logger.info("Rescan complete – %d device(s) published", len(devices))


async def scan_loop(broker, topic: str, worker_id: str = "") -> None:
    known: set = set()
    logger.info("ADB scanner started (interval=%ss, topic=%s, worker_id=%s)", SCAN_INTERVAL, topic, worker_id)

    while True:
        current: set = await asyncio.to_thread(_get_connected_devices)

        for serial in current - known:
            await _publish_device_event(broker, topic, "connected", serial, worker_id)

        for serial in known - current:
            payload: dict = {"event": "disconnected", "serial": serial}
            if worker_id:
                payload["worker_id"] = worker_id
            await broker.publish(payload, topic)
            logger.info("Device disconnected: %s (worker_id=%s)", serial, worker_id)

        known = current
        await asyncio.sleep(SCAN_INTERVAL)
