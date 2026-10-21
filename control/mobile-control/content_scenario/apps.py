from django.apps import AppConfig


class ContentScenarioConfig(AppConfig):
    """Django app cho AI Scenario v3.

    Tách hẳn khỏi `content/` (Gen Content + chat-refine v1/v2) vì:
    - Schema phân tầng khác (registry + shots + continuity graph) — xem
      `docs/Gen_Scenario/ai-scenario-v3-thiet-ke.md` §6, §12.
    - Pipeline 3 layer (Parse → Scripter → 5 Reviewer async → CODE-enforce) —
      xem cùng doc §7.
    - Tránh đụng vào Gen Content cũ đang chạy ổn định ở prod.
    """
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'content_scenario'
