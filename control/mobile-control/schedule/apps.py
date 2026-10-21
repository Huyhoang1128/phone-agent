from django.apps import AppConfig


class ScheduleConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'schedule'

    # Local dev (`runserver`) starts the scheduler in-process for convenience.
    # In Docker/prod the web server runs under `daphne` AND a dedicated
    # `run_scheduler` container exists, so daphne must NOT start its own
    # scheduler — otherwise every poll runs twice and dispatches duplicate
    # tasks for the same due item.
    _SERVER_COMMANDS = frozenset({'runserver'})

    def ready(self):
        import sys
        # Only start the background scheduler for local `runserver`. Management
        # commands such as `migrate`/`check` must NOT start it (an exception in
        # ready() crashes manage.py, and a background thread in a one-shot
        # command is wasteful). The production web server (daphne) must NOT start
        # it either — the dedicated `run_scheduler` container owns the scheduler.
        # Note: daphne runs as `daphne -b ...` (argv[1] == '-b'), so it never
        # matches _SERVER_COMMANDS — and the scheduler module no longer
        # auto-starts on import, so importing schedule.views won't spin one up.
        if not (sys.argv and len(sys.argv) >= 2 and sys.argv[1] in self._SERVER_COMMANDS):
            return
        from . import scheduler
        scheduler.start_scheduler()
