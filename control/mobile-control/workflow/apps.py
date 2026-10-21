from django.apps import AppConfig


class WorkflowConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'workflow'

    def ready(self):
        # Phase 2.2 — register action handlers (CALL_N8N_WORKFLOW,
        # CREATE_MOBILE_AGENT_TASK) qua side-effect import.
        # KHÔNG có ready() này thì workflow_runner sẽ log "No handler
        # registered for action_type=..." và return {} stub.
        from .runner import actions  # noqa: F401
