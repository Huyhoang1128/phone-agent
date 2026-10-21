"""
Post-hooks for sending notifications via the backend API.
"""

import json
import logging
import os
import shlex

import httpx

from agno.hooks import hook
from agno.run.agent import RunOutput

logger = logging.getLogger(__name__)


@hook(run_in_background=True)
async def send_scheduler_notification(
    run_output: RunOutput,
    metadata: dict = None,
    user_id: str = None,
    **kwargs,
):
    """Post-hook: send a push notification when a run is triggered by the scheduler.

    Only fires when ``metadata.source == "scheduler"``.  The ``user_id`` and
    the agent's response content are forwarded to the backend notification API.
    """
    source = (metadata or {}).get("source", "")
    if source != "scheduler":
        return

    backend_url = os.getenv("BACKEND_API_URL", "").rstrip("/")
    api_key = os.getenv("SERVER_API_KEY", "")

    if not backend_url or not api_key:
        logger.warning(
            "send_scheduler_notification: BACKEND_API_URL or SERVER_API_KEY is not set. "
            "Skipping notification."
        )
        return

    if not user_id:
        logger.warning(
            "send_scheduler_notification: user_id is not available. Skipping notification."
        )
        return

    content = getattr(run_output, "content", None) or ""
    if len(content) > 100:
        content = content[:100] + "..."
    message = content or "Scheduled task completed"

    session_id = getattr(run_output, "session_id", None)
    deeplink = f"deeplove://chat/session/{session_id}" if session_id else None

    url = f"{backend_url}/server-api/notifications"
    payload = {
        "user_id": str(user_id),
        "title": "Scheduled task completed",
        "message": message,
        "should_push": True,
        "should_create_notification": True,
        "url": deeplink,
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=30,
            )
            response.raise_for_status()
            logger.info(
                f"Scheduler notification sent for user {user_id}: "
                f"status={response.status_code}"
            )
    except Exception as e:
        masked_key = api_key[:4] + "****" if len(api_key) > 4 else "****"
        curl_cmd = (
            f"curl --location '{url}' "
            f"--header 'X-API-Key: {masked_key}' "
            f"--header 'Content-Type: application/json' "
            f"--data {shlex.quote(json.dumps(payload))}"
        )
        logger.error(f"send_scheduler_notification failed for user {user_id}: {e}")
        logger.warning(f"send_scheduler_notification debug curl:\n{curl_cmd}")
