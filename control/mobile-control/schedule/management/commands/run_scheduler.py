"""
Management command: python manage.py run_scheduler

Starts a long-running process that uses APScheduler to poll for due
schedules and execute them.  Intended to run as a separate container /
process alongside the web server.
"""

import logging
import signal
import time

from django.core.management.base import BaseCommand

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Run the APScheduler-backed schedule polling process.'

    def handle(self, *args, **options):
        # Start the scheduler explicitly (the module no longer auto-starts on
        # import — see schedule/scheduler.py).
        from schedule import scheduler as scheduler_module

        scheduler_module.start_scheduler()
        self.stdout.write('Scheduler started. Press Ctrl+C to stop.')

        def _shutdown(signum, frame):
            self.stdout.write('\nShutting down scheduler…')
            scheduler_module.stop_scheduler()

        signal.signal(signal.SIGTERM, _shutdown)
        signal.signal(signal.SIGINT, _shutdown)

        try:
            while scheduler_module._scheduler and scheduler_module._scheduler.running:
                time.sleep(1)
        except (KeyboardInterrupt, SystemExit):
            scheduler_module.stop_scheduler()

        self.stdout.write('Scheduler stopped.')
