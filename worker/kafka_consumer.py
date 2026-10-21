import asyncio
import logging
from faststream.kafka import KafkaMessage

logger = logging.getLogger(__name__)


async def _get_screen_state(serial: str) -> str | None:
    """Check the current screen wakefulness via ADB.

    Returns 'on', 'off', or None if the check fails.
    """
    import subprocess

    try:
        result = subprocess.run(
            ["adb", "-s", serial, "shell", "dumpsys", "power"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if "mWakefulness=" in line:
                if "Awake" in line:
                    return "on"
                else:
                    return "off"
        logger.warning(
            "Could not determine screen state for %s from dumpsys output",
            serial,
        )
        return None
    except Exception as exc:
        logger.error("Failed to check screen state for %s: %s", serial, exc)
        return None


async def _execute_adb_command(serial: str, command: str) -> bool:
    """Execute an ADB shell command on the given device.

    Returns True on success, False on failure.
    """
    import subprocess

    try:
        result = subprocess.run(
            ["adb", "-s", serial, "shell", command],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            logger.error(
                "ADB command failed for %s: %s (stderr: %s)",
                serial,
                command,
                result.stderr.strip(),
            )
            return False
        return True
    except Exception as exc:
        logger.error(
            "Failed to execute ADB command '%s' for %s: %s",
            command,
            serial,
            exc,
        )
        return False


async def handle_command(body: dict, msg: KafkaMessage) -> None:
    target = body.get("target", "")
    # raw_message can be a single ConsumerRecord or a tuple of ConsumerRecords
    raw = msg.raw_message
    if isinstance(raw, tuple):
        offset = raw[0].offset
    else:
        offset = raw.offset
    logger.info(
        "Received command for target: %s | offset=%s | payload: %s",
        target,
        offset,
        body,
    )

    action = body.get("action", "")
    serial = body.get("devices_serical", "")

    if not serial:
        logger.warning("No devices_serical provided in command payload")
        return

    if action == "screen_on":
        current_state = await _get_screen_state(serial)
        if current_state == "on":
            logger.info(
                "Screen is already ON for %s — skipping screen_on command",
                serial,
            )
            return
        logger.info("Screen is %s for %s — turning screen ON", current_state, serial)
        success = await _execute_adb_command(serial, "input keyevent 26")
        if success:
            logger.info("Screen turned ON for %s", serial)
        else:
            logger.error("Failed to turn screen ON for %s", serial)

    elif action == "screen_off":
        current_state = await _get_screen_state(serial)
        if current_state == "off":
            logger.info(
                "Screen is already OFF for %s — skipping screen_off command",
                serial,
            )
            return
        logger.info("Screen is %s for %s — turning screen OFF", current_state, serial)
        success = await _execute_adb_command(serial, "input keyevent 26")
        if success:
            logger.info("Screen turned OFF for %s", serial)
        else:
            logger.error("Failed to turn screen OFF for %s", serial)

    else:
        logger.debug("Unhandled action '%s' for target %s", action, target)
