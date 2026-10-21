"""Single source of truth for the per-device task lock.

A physical device runs ONE phoneagent task at a time. Pushing a second task at a
busy device just collides on-device ("Failed to get state … Portal"). We treat a
device as *busy* while it has a RUNNING task updated within the lease window; the
lease bounds how long a hung/offline device (whose task never reports back) stays
locked before a new task is allowed through.

This helper is the authoritative check used by every dispatch path:
  * ``mbcontrol.kafka_utils.send_task_execution_message`` — universal backstop so
    NO path can flood a busy device, whatever surface triggered it.
  * ``facebook.views`` dispatch helpers / "Đăng ngay" endpoints — friendly guards.
  * ``schedule.scheduler`` polls — serialise scheduled-post dispatch.
"""
from datetime import timedelta

from django.utils import timezone

# Keep in one place so every caller agrees on "how long until a hung device frees".
DEVICE_BUSY_LEASE_MINUTES = 15


def device_is_busy(device_id, *, exclude_task_id=None, lease_minutes=DEVICE_BUSY_LEASE_MINUTES) -> bool:
    """True when *device_id* has an in-flight (RUNNING) task fresh enough to still
    count as busy.

    ``exclude_task_id`` skips one task — callers that flip their own task to
    RUNNING *before* dispatch (e.g. ``/tasks/{id}/run/``) must exclude it so the
    device does not appear to be locked by the very task being sent.
    """
    if not device_id:
        return False
    from task.models import Task, TaskStatus

    cutoff = timezone.now() - timedelta(minutes=lease_minutes)
    qs = Task.objects.filter(
        device_id=device_id,
        status=TaskStatus.RUNNING,
        updated_at__gte=cutoff,
    )
    if exclude_task_id is not None:
        qs = qs.exclude(id=exclude_task_id)
    return qs.exists()


def dispatch_or_queue(task, device_id) -> str:
    """Send *task* to *device_id* now, or park it as QUEUED if the device is busy.

    Returns one of:
      * ``'sent'``   — delivered to Kafka; task flipped to RUNNING.
      * ``'queued'`` — device busy; task left QUEUED for the drain poll to send
        when the device frees (``schedule.scheduler._drain_device_task_queue``).
      * ``'failed'`` — Kafka delivery failed (infra); caller decides how to react.

    This is the single send-or-queue gate for FB device tasks so no path can
    flood a busy device, and queued work drains automatically in order.
    """
    from task.models import Task, TaskStatus  # noqa: F401 — TaskStatus used below
    from mbcontrol.kafka_utils import send_task_execution_message

    if device_is_busy(device_id, exclude_task_id=task.id):
        task.status = TaskStatus.QUEUED
        task.save(update_fields=['status', 'updated_at'])
        return 'queued'

    delivered = send_task_execution_message(task, devices_id=[device_id])
    if not delivered:
        return 'failed'

    task.status = TaskStatus.RUNNING
    task.save(update_fields=['status', 'updated_at'])
    return 'sent'
