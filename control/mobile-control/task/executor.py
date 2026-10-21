import logging
from typing import Any

from django.utils import timezone

from mbcontrol.kafka_utils import send_task_execution_message

from .models import Task, TaskStepStatus
from .registry import get_handler

logger = logging.getLogger(__name__)


def execute_system_task(
    task: Task,
    *,
    devices_id: list[int] | None = None,
    profile_id: int | None = None,
) -> bool:
    steps = list(task.steps.all())
    if not steps:
        logger.info('System task %s has no steps; falling back to Kafka execution.', task.id)
        return send_task_execution_message(task, devices_id=devices_id, profile_id=profile_id)

    for step in steps:
        handler = get_handler(step.handler)
        if handler is None:
            step.status = TaskStepStatus.FAILED
            step.error = f'Handler "{step.handler}" is not registered.'
            step.executed_at = timezone.now()
            step.save(update_fields=['status', 'error', 'executed_at', 'updated_at'])
            continue

        step.status = TaskStepStatus.RUNNING
        step.error = ''
        step.executed_at = timezone.now()
        step.save(update_fields=['status', 'error', 'executed_at', 'updated_at'])

        try:
            result: Any = handler(task, step)
            step.status = TaskStepStatus.COMPLETED
            step.result = result if isinstance(result, dict) else {'result': result}
            step.error = ''
            step.save(update_fields=['status', 'result', 'error', 'executed_at', 'updated_at'])
            # Fallback strategy: stop at the first successful step.
            return True
        except Exception as exc:
            logger.exception('System task %s failed at step %s', task.id, step.id)
            step.status = TaskStepStatus.FAILED
            step.error = str(exc)
            step.save(update_fields=['status', 'error', 'executed_at', 'updated_at'])

    return False
