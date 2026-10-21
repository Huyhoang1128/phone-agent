"""Action handlers package for workflow-runner (Phase 2.2).

Mỗi handler đăng ký qua `@register_handler('TYPE_NAME')` decorator của
`workflow.runner.executor`. Khi WorkflowStep.action_config['type'] == 'TYPE_NAME'
runner sẽ dispatch sang handler tương ứng.

Handlers in this package:
- `n8n.call_n8n_workflow`: CALL_N8N_WORKFLOW — HTTP POST n8n + retry
- `mobile_agent.create_mobile_agent_task`: CREATE_MOBILE_AGENT_TASK — Kafka publish

Import side-effect: importing this package registers all handlers in executor
registry.
"""
# Side-effect imports — register handlers at startup.
from . import n8n  # noqa: F401
from . import mobile_agent  # noqa: F401
