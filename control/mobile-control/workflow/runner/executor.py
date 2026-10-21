"""Execute 1 WorkflowStep.

Phase 2.1: skeleton — registry kiểu plugin. Mỗi action_type có 1 handler được
đăng ký qua `@register_handler('CALL_N8N_WORKFLOW')`. Hiện chỉ stub các handler;
Phase 2.2 sẽ implement đầy đủ.

Return value của handler:
- `dict` (output) → ghi vào `WorkflowRun.context[f'step{sort_order}_output']`,
  workflow-runner advance sang step kế.
- Sentinel `PAUSED` → workflow-runner pause, đợi `workflow:resume` đánh thức.
- Raise exception → workflow-runner cập nhật retry_count + raise lên stream layer.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)


# Sentinel — handler return giá trị này để báo runner pause + đợi resume signal.
PAUSED = '__PAUSED__'


# ── Handler registry ─────────────────────────────────────────────────────────

_HANDLERS: dict[str, Callable] = {}


def register_handler(action_type: str):
    """Decorator đăng ký handler cho 1 action_type.

    Vd:
        @register_handler('CALL_N8N_WORKFLOW')
        def call_n8n(step, run, ctx): ...
    """
    def deco(fn: Callable) -> Callable:
        if action_type in _HANDLERS:
            logger.warning('Overwrite handler for action_type=%s', action_type)
        _HANDLERS[action_type] = fn
        return fn
    return deco


def get_handler(action_type: str) -> Callable | None:
    return _HANDLERS.get(action_type)


def execute_step(step, run, ctx: dict[str, Any]) -> Any:
    """Dispatch step → handler theo step.action_config['type'] hoặc step.action_type.

    Args:
        step: WorkflowStep instance.
        run: WorkflowRun instance.
        ctx: dict context = run.trigger_payload + run.context output các step trước.

    Returns:
        - dict output (step thành công)
        - PAUSED sentinel (step yêu cầu đợi external — CREATE_MOBILE_AGENT_TASK)
        - Raise exception (step fail)
    """
    # action_type ưu tiên đọc từ action_config['type'] (typed action node mới)
    # fallback sang step.action_type cũ (CREATE_TASK / CREATE_SCHEDULE / CUSTOM).
    action_config = step.action_config or {}
    typed = action_config.get('type') or step.action_type

    handler = get_handler(typed)
    if handler is None:
        # Phase 2.1: chưa implement → log warning + skip (return empty dict).
        # Phase 2.2 sẽ register CALL_N8N_WORKFLOW + CREATE_MOBILE_AGENT_TASK.
        logger.warning(
            'No handler registered for action_type=%s (step=%s wf=%s). '
            'Phase 2.1 stub — return {}.',
            typed, step.id, step.workflow_id,
        )
        return {}

    logger.info(
        'Execute step=%s action=%s run=%s', step.id, typed, run.id,
    )
    return handler(step, run, ctx)


# ── Phase 2.1 stub handlers (placeholder — Phase 2.2 sẽ thay thế đầy đủ) ────


@register_handler('NOOP')
def _noop(step, run, ctx):
    """No-op handler — useful cho test workflow rỗng."""
    return {'noop': True}
