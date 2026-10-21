"""Standalone utility helpers for common device queries.

These functions work directly via ADB without requiring a full driver/portal
setup, making them suitable for lightweight scripts and ad-hoc queries.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from async_adbutils import adb

from mobilerun.portal import PORTAL_PACKAGE_NAME, portal_content_uri

logger = logging.getLogger("mobilerun")


async def _adb(serial: str, *args: str, timeout: int = 15) -> str:
    """Run an ADB shell command on the given device and return its stdout.

    ``args`` should start with the literal string ``"shell"`` (to mirror the
    ``adb shell …`` CLI convention used at call sites); that token is stripped
    before the remaining arguments are forwarded to ``device.shell()``.
    """
    device = await adb.device(serial=serial)
    # Skip the leading "shell" token — device.shell() handles the ADB shell layer.
    shell_args = args[1:] if args and args[0] == "shell" else args
    return await device.shell(" ".join(shell_args), timeout=timeout)


def _extract_elements(node: dict[str, Any], results: list[dict] | None = None) -> list[dict]:
    """Recursively walk an a11y tree and collect interactable elements.

    An element is considered interactable when it is clickable, long-clickable,
    checkable, editable, or scrollable.
    """
    if results is None:
        results = []

    if not isinstance(node, dict):
        return results

    interactable = (
        node.get("isClickable")
        or node.get("isLongClickable")
        or node.get("isCheckable")
        or node.get("isEditable")
        or node.get("isScrollable")
    )

    if interactable:
        bounds = node.get("boundsInScreen", {})
        results.append(
            {
                "resourceId": node.get("resourceId", ""),
                "className": node.get("className", ""),
                "text": node.get("text") or node.get("contentDescription") or "",
                "bounds": (
                    f"{bounds.get('left', 0)},"
                    f"{bounds.get('top', 0)},"
                    f"{bounds.get('right', 0)},"
                    f"{bounds.get('bottom', 0)}"
                ),
                "isClickable": bool(node.get("isClickable")),
                "isEditable": bool(node.get("isEditable")),
                "isCheckable": bool(node.get("isCheckable")),
                "isChecked": bool(node.get("isChecked")),
                "isScrollable": bool(node.get("isScrollable")),
            }
        )

    for child in node.get("children", []):
        _extract_elements(child, results)

    return results


async def screen_state(serial: str) -> dict:
    """Return the running app, current activity, and interactable UI elements.

    UI elements are fetched from the Mobilerun Portal when it is running.
    If the Portal is not available, ``elements`` will be an empty list.

    Args:
        serial: ADB serial number of the target device.

    Returns:
        A dict with keys ``serial``, ``current_app``, ``current_activity``,
        and ``elements``.
    """
    # ── Current app / activity via dumpsys ──────────────────────────────────
    dumpsys_out = await _adb(
        serial, "shell", "dumpsys", "activity", "activities", timeout=20
    )
    current_app: str | None = None
    current_activity: str | None = None
    for line in dumpsys_out.splitlines():
        line = line.strip()
        if "mCurrentFocus" in line or "mFocusedApp" in line:
            m = re.search(r"\{[^}]+ ([^\s/]+)/([^\s}]+)", line)
            if m:
                current_app = m.group(1)
                current_activity = m.group(2)
                break

    # ── UI elements from Mobilerun Portal (best-effort) ──────────────────────
    # The content provider returns a row whose value starts with "result=<JSON>"
    _RESULT_PREFIX = "result="
    elements: list[dict] = []
    try:
        portal_out = await _adb(
            serial,
            "shell",
            "content",
            "query",
            "--uri",
            portal_content_uri(PORTAL_PACKAGE_NAME, "state_full"),
            timeout=10,
        )
        idx = portal_out.find(_RESULT_PREFIX)
        if idx != -1:
            data = json.loads(portal_out[idx + len(_RESULT_PREFIX) :])
            a11y_tree = data.get("result", {}).get("a11y_tree")
            if a11y_tree:
                elements = _extract_elements(a11y_tree)
    except json.JSONDecodeError as exc:
        logger.debug("screen_state: failed to parse portal JSON: %s", exc)
    except KeyError as exc:
        logger.debug("screen_state: unexpected portal response structure: %s", exc)
    except Exception as exc:
        logger.debug("screen_state: portal query failed: %s", exc)

    return {
        "serial": serial,
        "current_app": current_app,
        "current_activity": current_activity,
        "elements": elements,
    }
