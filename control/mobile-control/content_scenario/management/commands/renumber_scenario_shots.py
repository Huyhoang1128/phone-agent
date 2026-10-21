"""One-time data fix: renumber shot_id của scenarios để khớp shot_order.

Background (v3.2.2 hotfix):
    Trước hotfix, mỗi insert_shot tạo shot_id = max+1. Sau N insert/delete,
    shot_id không còn khớp position trong timeline → user thấy "Shot 10" ở
    vị trí 1 thay vì "Shot 1" — confusing.

    Hotfix `_renumber_shot_ids(sc)` đã được gọi trong 5 mutation endpoint
    (insert/delete/move/duplicate/reorder), nhưng KHÔNG auto fix các scenario
    cũ đã sai trước deploy. Command này renumber TOÀN BỘ scenario 1 lần.

Usage:
    # Xem những scenario cần fix (không apply)
    python manage.py renumber_scenario_shots --dry-run

    # Apply fix toàn bộ
    python manage.py renumber_scenario_shots

    # Chỉ fix 1 scenario cụ thể
    python manage.py renumber_scenario_shots --scenario-id 6

    # Trên prod (docker)
    docker compose exec backend python manage.py renumber_scenario_shots --dry-run
    docker compose exec backend python manage.py renumber_scenario_shots
"""
from django.core.management.base import BaseCommand

from content_scenario.models import ContentScenario
from content_scenario.views import _renumber_shot_ids


class Command(BaseCommand):
    help = (
        'Renumber shot_id của scenarios để khớp shot_order (1, 2, ..., N). '
        'One-time data fix sau v3.2.2 hotfix _renumber_shot_ids.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Chỉ list scenarios cần fix, KHÔNG apply.',
        )
        parser.add_argument(
            '--scenario-id',
            type=int,
            default=None,
            help='Chỉ fix 1 scenario cụ thể (theo id).',
        )

    def handle(self, *args, **opts):
        dry = opts['dry_run']
        sc_id = opts['scenario_id']

        if sc_id:
            qs = ContentScenario.objects.filter(id=sc_id)
            if not qs.exists():
                self.stdout.write(
                    self.style.ERROR(f'Scenario id={sc_id} không tồn tại.')
                )
                return
        else:
            qs = ContentScenario.objects.all()

        total = qs.count()
        self.stdout.write(f'Scanning {total} scenario(s)...')
        self.stdout.write('')

        fixed = 0
        already_ok_count = 0
        for sc in qs.iterator():
            shots = list(sc.shots.order_by('shot_order'))
            if not shots:
                continue
            already_ok = all(s.shot_id == i + 1 for i, s in enumerate(shots))
            if already_ok:
                already_ok_count += 1
                continue
            current = [s.shot_id for s in shots]
            preview = current[:10]
            suffix = '...' if len(current) > 10 else ''
            self.stdout.write(
                f'  sc#{sc.id:4d}  "{sc.title[:50]:<50}"  '
                f'shots={len(shots):3d}  '
                f'current shot_ids={preview}{suffix}'
            )
            if not dry:
                _renumber_shot_ids(sc)
            fixed += 1

        self.stdout.write('')
        prefix = 'WOULD FIX' if dry else 'FIXED'
        self.stdout.write(
            self.style.SUCCESS(
                f'{prefix}: {fixed} scenario(s).  '
                f'Already OK: {already_ok_count}.  Total scanned: {total}.'
            )
        )
        if dry and fixed > 0:
            self.stdout.write(
                self.style.WARNING(
                    'Để apply thật, chạy lại không có --dry-run.'
                )
            )
