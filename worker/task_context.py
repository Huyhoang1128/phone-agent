"""
task_context.py — async-safe raw task context store.

Provides a single ``ContextVar`` (``raw_context``) that holds the **full,
unmodified Kafka message body** for the duration of a task execution.
Any tool running inside the agent can call ``get_raw_context()`` to access
every field of the original message — task_id, name, description, goal,
app, device_serial_id, payload (keyword, list_id, source, agent, …) —
without requiring the LLM to pass them as explicit arguments.

The context is async-safe: each task coroutine has its own isolated copy,
so concurrent tasks on different devices never bleed data into each other.

Usage
-----
Set (in task_executor, before running the agent)::

    from task_context import set_raw_context
    set_raw_context(kafka_message_body)

Read (inside any tool function)::

    from task_context import get_raw_context
    raw = get_raw_context()

    # Top-level fields
    task_id  = raw.get("task_id")
    goal     = raw.get("goal") or raw.get("description", "")
    device   = raw.get("device_serial_id", "")

    # Payload sub-fields
    payload  = raw.get("payload") or {}
    keyword  = payload.get("keyword", "")
    list_id  = payload.get("list_id", 0)
    source   = payload.get("source", "")
"""

from contextvars import ContextVar
from typing import Any

_RAW_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("raw_context", default={})
_FAILURE_LOGGER: ContextVar[Any] = ContextVar("failure_logger", default=None)


def set_raw_context(body: dict[str, Any]) -> None:
    """Store the full Kafka message *body* as the raw context for the current async task."""
    _RAW_CONTEXT.set(body)


def get_raw_context() -> dict[str, Any]:
    """Return the full raw Kafka message body for the current async task.

    Returns an empty dict if no context has been set (e.g. when running outside
    a Kafka-dispatched task, such as in unit tests or ``runmb.py``).
    """
    return _RAW_CONTEXT.get()


def set_failure_logger(flog) -> None:
    """Store the ``TaskFailureLogger`` instance for the current async task.

    Allows any tool to push granular events to the failure log via
    ``get_failure_logger().add_event('kind', 'text')``. Logged events only
    persist to disk if the task ends in failure (success → discarded).
    """
    _FAILURE_LOGGER.set(flog)


def get_failure_logger():
    """Return the ``TaskFailureLogger`` for current async task, or None if unset.

    Tools should null-check before calling:
        flog = get_failure_logger()
        if flog is not None:
            flog.add_event('tool:send_dm', 'Bước X: ...')
    """
    return _FAILURE_LOGGER.get()
