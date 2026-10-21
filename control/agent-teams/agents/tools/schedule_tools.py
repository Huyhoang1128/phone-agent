import logging
from typing import Optional

from agno.run import RunContext
from agno.scheduler import ScheduleManager
from db import get_postgres_db

logger = logging.getLogger(__name__)

_PAL_AGENT_ID = "pal"


def _get_manager() -> ScheduleManager:
    """Return a ScheduleManager backed by the shared Postgres database."""
    return ScheduleManager(get_postgres_db())


def create_pal_schedule(
    name: str,
    cron_expr: str,
    message: str,
    run_context: Optional[RunContext] = None,
    timezone: str = "UTC",
    max_retries: int = 0,
    retry_delay_seconds: int = 60,
    timeout_seconds: int = 3600,
    if_exists: str = "raise",
) -> str:
    """
    Create a cron schedule that will send a message to the PAL agent on a recurring basis.

    The current user's ID is automatically extracted from the JWT token via the
    run context — no need to pass ``user_id`` explicitly.

    Parameters
    ----------
    name : str
        Unique name for the schedule (e.g. "morning-standup").
    cron_expr : str
        Standard 5-field cron expression (e.g. "0 9 * * 1-5" for weekdays at 09:00).
    message : str
        The message that PAL will receive at each scheduled run.
    timezone : str, optional
        IANA timezone string (default: "UTC").
    max_retries : int, optional
        Number of extra attempts after first failure (default: 0).
    retry_delay_seconds : int, optional
        Seconds to wait between retry attempts (default: 60).
    timeout_seconds : int, optional
        Maximum seconds for the scheduled request (default: 3600).
    if_exists : str, optional
        Behavior when a schedule with the same name already exists.
        ``"raise"`` (default) raises an error, ``"skip"`` returns the existing
        schedule unchanged, ``"update"`` overwrites it with the new values.

    Returns
    -------
    str
        Confirmation with schedule details, or an error message.
    """
    # Resolve user_id from the JWT-injected run context
    user_id = getattr(run_context, "user_id", None) if run_context is not None else None

    if not name or not isinstance(name, str):
        return "Error: name must be a non-empty string."
    if not cron_expr or not isinstance(cron_expr, str):
        return "Error: cron_expr must be a non-empty string."
    if not message or not isinstance(message, str):
        return "Error: message must be a non-empty string."
    if not user_id or not isinstance(user_id, str):
        return "Error: could not determine user_id from the current session."

    try:
        mgr = _get_manager()
        logger.info(f"Creating PAL schedule '{name}' for user '{user_id}'")
        schedule = mgr.create(
            name=name,
            cron=cron_expr,
            endpoint=f"/agents/{_PAL_AGENT_ID}/runs",
            method="POST",
            payload={
                "message": message,
                "user_id": user_id,
                "metadata": {
                    "source": "scheduler",
                    "user_id": user_id,
                    "message": message,
                },
            },
            timezone=timezone,
            max_retries=max_retries,
            retry_delay_seconds=retry_delay_seconds,
            timeout_seconds=timeout_seconds,
            if_exists=if_exists,
        )
        return (
            f"Schedule created successfully!\n"
            f"- ID: {schedule.id}\n"
            f"- Name: {schedule.name}\n"
            f"- Cron: {schedule.cron_expr} ({schedule.timezone})\n"
            f"- Next run: {schedule.next_run_at}\n"
            f"- Message: {message}"
        )
    except ValueError as e:
        logger.error(f"Schedule creation conflict for '{name}': {e}")
        return f"Error creating schedule: {e}"
    except Exception as e:
        logger.error(f"Error creating schedule '{name}': {e}")
        return f"Error creating schedule: {e}"


def list_pal_schedules(run_context: Optional[RunContext] = None, enabled_only: bool = False) -> str:
    """
    List PAL agent schedules that belong to the current user.

    The current user's ID is automatically extracted from the JWT token via the
    run context — no need to pass ``user_id`` explicitly.

    Parameters
    ----------
    enabled_only : bool, optional
        When True, only return schedules that are currently enabled (default: False).

    Returns
    -------
    str
        A formatted list of the user's schedules, or an error message.
    """
    # Resolve user_id from the JWT-injected run context
    user_id = getattr(run_context, "user_id", None) if run_context is not None else None

    if not user_id or not isinstance(user_id, str):
        return "Error: could not determine user_id from the current session."

    try:
        mgr = _get_manager()
        logger.info(f"Listing PAL schedules for user '{user_id}'")
        all_schedules = mgr.list(enabled=True if enabled_only else None)

        # Filter to schedules owned by this user (user_id stored in payload)
        user_schedules = [
            s for s in all_schedules
            if isinstance(s.payload, dict) and str(s.payload.get("user_id", "")) == str(user_id)
        ]

        if not user_schedules:
            return f"No schedules found for user '{user_id}'."

        lines = [f"Schedules for user '{user_id}':"]
        for s in user_schedules:
            status = "enabled" if s.enabled else "disabled"
            lines.append(
                f"- [{s.id}] {s.name} | {s.cron_expr} ({s.timezone}) | {status} | next: {s.next_run_at}"
            )
        return "\n".join(lines)
    except Exception as e:
        logger.error(f"Error listing schedules for user '{user_id}': {e}")
        return f"Error listing schedules: {e}"


def disable_pal_schedule(schedule_id: str) -> str:
    """
    Disable a PAL agent schedule so it no longer runs automatically.

    Parameters
    ----------
    schedule_id : str
        The unique ID of the schedule to disable.

    Returns
    -------
    str
        Confirmation message, or an error message.
    """
    if not schedule_id or not isinstance(schedule_id, str):
        return "Error: schedule_id must be a non-empty string."

    try:
        mgr = _get_manager()
        logger.info(f"Disabling PAL schedule '{schedule_id}'")
        mgr.disable(schedule_id)
        return f"Schedule '{schedule_id}' has been disabled."
    except Exception as e:
        logger.error(f"Error disabling schedule '{schedule_id}': {e}")
        return f"Error disabling schedule: {e}"


def enable_pal_schedule(schedule_id: str) -> str:
    """
    Re-enable a previously disabled PAL agent schedule.

    Parameters
    ----------
    schedule_id : str
        The unique ID of the schedule to enable.

    Returns
    -------
    str
        Confirmation message, or an error message.
    """
    if not schedule_id or not isinstance(schedule_id, str):
        return "Error: schedule_id must be a non-empty string."

    try:
        mgr = _get_manager()
        logger.info(f"Enabling PAL schedule '{schedule_id}'")
        mgr.enable(schedule_id)
        return f"Schedule '{schedule_id}' has been enabled."
    except Exception as e:
        logger.error(f"Error enabling schedule '{schedule_id}': {e}")
        return f"Error enabling schedule: {e}"


def delete_pal_schedule(schedule_id: str) -> str:
    """
    Permanently delete a PAL agent schedule.

    Parameters
    ----------
    schedule_id : str
        The unique ID of the schedule to delete.

    Returns
    -------
    str
        Confirmation message, or an error message.
    """
    if not schedule_id or not isinstance(schedule_id, str):
        return "Error: schedule_id must be a non-empty string."

    try:
        mgr = _get_manager()
        logger.info(f"Deleting PAL schedule '{schedule_id}'")
        mgr.delete(schedule_id)
        return f"Schedule '{schedule_id}' has been deleted."
    except Exception as e:
        logger.error(f"Error deleting schedule '{schedule_id}': {e}")
        return f"Error deleting schedule: {e}"

