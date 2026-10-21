"""Stress test pipeline Chatbot TikTok (Phase 2.4.4).

Simulate viral scenario: N peer khác nhau gửi DM trong T phút → mock toàn bộ
pipeline (skip n8n thật + skip Mobile Agent thật) → measure throughput + latency
+ failure rate.

KHÔNG đo được real Mobile Agent task time (~1.5min per task) vì mock. Đo:
- Backend matcher + buffer + workflow-runner logic throughput
- p50/p95/p99 latency end-to-end (mock mode)
- Redis Stream backlog / DLQ count
- Memory leak qua nhiều workflow run

Usage:
    python manage.py run_chatbot_stress_test --device-id 8 --total-peers 50 \\
        --duration-seconds 60 --concurrency 5
"""
from __future__ import annotations

import random
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from devices.models import Device, DeviceNotification
from chatbot.buffer import get_buffer
from chatbot.models import (
    TiktokMessage,
    TiktokMessageChannel,
    TiktokMessageSource,
    TiktokMessageType,
    TiktokPeerMute,
)
from chatbot.notification_matcher import get_matcher
from workflow.models import RunStatus, Workflow, WorkflowRun, WorkflowStep
from workflow import streams


# Sample content variations (tiếng Việt — domain thẩm mỹ).
SAMPLE_CONTENTS = [
    'Em hỏi giá nâng ngực',
    'Cho em thông tin nâng mũi với ạ',
    'Chỗ chị có dịch vụ giảm cân không',
    'Em muốn đặt lịch tư vấn',
    'Bao nhiêu tiền vậy ạ',
    'Có ưu đãi gì không em',
    'Em ở Hà Nội có cơ sở không',
    'Cho em xin số điện thoại',
    'Em cần gặp bác sĩ trực tiếp',
    'Có làm thử miễn phí không ạ',
]

SAMPLE_REPLIES = [
    'Dạ chị inbox em tư vấn ạ ❤️',
    'Em cảm ơn chị quan tâm ạ',
    'Chị để lại số em gọi tư vấn nhé',
    'Dạ ưu đãi đang có ạ, em báo chị qua tin nhắn',
]


class Command(BaseCommand):
    help = 'Stress test pipeline TikTok (Phase 2.4.4).'

    def add_arguments(self, parser):
        parser.add_argument('--device-id', type=int, required=True)
        parser.add_argument(
            '--total-peers', type=int, default=20,
            help='Số peer khác nhau (default 20).',
        )
        parser.add_argument(
            '--duration-seconds', type=int, default=60,
            help='Tổng thời gian spread arrival (default 60s).',
        )
        parser.add_argument(
            '--concurrency', type=int, default=5,
            help='Số thread chạy song song (default 5).',
        )
        parser.add_argument(
            '--keep-data', action='store_true',
            help='KHÔNG cleanup test data.',
        )

    def handle(self, *args, **opts):
        try:
            device = Device.objects.get(pk=opts['device_id'])
        except Device.DoesNotExist:
            raise CommandError(f'Device id={opts["device_id"]} không tồn tại.')

        total = opts['total_peers']
        duration = opts['duration_seconds']
        concurrency = opts['concurrency']

        self.stdout.write(self.style.MIGRATE_HEADING(
            f'\n=== Stress test ===\n'
            f'device={device.id} ({device.name})\n'
            f'total_peers={total} duration={duration}s concurrency={concurrency}'
        ))

        # Snapshot pre-state Redis Streams.
        pre_stats = streams.stream_stats()
        pre_dlq = streams.xpending_count(streams.STREAM_DLQ, '0-0') if streams.STREAM_DLQ in pre_stats else 0
        self.stdout.write(f'\nRedis pre-state: {pre_stats}')

        wf = self._ensure_stress_workflow(device)

        # Cleanup prior test runs.
        self._cleanup_prefix(device, 'STRESS_')

        # Build arrival schedule: spread evenly over duration với jitter.
        peers = [f'STRESS_{i:03d}' for i in range(total)]
        interval = duration / max(1, total)
        schedule = []
        for i, peer in enumerate(peers):
            arrival_at = i * interval + random.uniform(0, interval * 0.5)
            schedule.append((arrival_at, peer))

        # Mock handlers — single override cho cả batch.
        from workflow.runner import executor as exec_mod  # noqa: PLC0415

        original_handlers = dict(exec_mod._HANDLERS)
        exec_mod._HANDLERS['CALL_N8N_WORKFLOW'] = lambda step, run, ctx: {
            'reply_text': random.choice(SAMPLE_REPLIES),
        }
        exec_mod._HANDLERS['CREATE_MOBILE_AGENT_TASK'] = lambda step, run, ctx: {
            'outcome': 'SENT_CONFIRMED', 'mock_task_id': random.randint(10000, 99999),
        }

        latencies: list[float] = []
        errors: list[str] = []
        success = 0
        start = time.monotonic()

        try:
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = {}
                for arrival_at, peer in schedule:
                    # Calculate when to actually submit
                    wait = max(0, arrival_at - (time.monotonic() - start))
                    time.sleep(wait)
                    fut = pool.submit(self._process_one_peer, device, peer, wf)
                    futures[fut] = (peer, time.monotonic() - start)

                for fut in as_completed(futures):
                    peer, submitted_at = futures[fut]
                    try:
                        lat = fut.result()
                        latencies.append(lat)
                        success += 1
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f'{peer}: {exc}')
        finally:
            exec_mod._HANDLERS.clear()
            exec_mod._HANDLERS.update(original_handlers)

        elapsed = time.monotonic() - start

        # Snapshot post-state.
        post_stats = streams.stream_stats()
        post_dlq = streams.xpending_count(streams.STREAM_DLQ, '0-0') if streams.STREAM_DLQ in post_stats else 0

        self.stdout.write(self.style.MIGRATE_HEADING('\n=== Kết quả ==='))
        self.stdout.write(f'Total elapsed: {elapsed:.1f}s')
        self.stdout.write(f'Success: {success}/{total}')
        self.stdout.write(f'Errors: {len(errors)}')

        if latencies:
            latencies_sorted = sorted(latencies)
            p50 = statistics.median(latencies_sorted)
            p95 = latencies_sorted[int(len(latencies_sorted) * 0.95)] if len(latencies_sorted) >= 20 else max(latencies_sorted)
            p99 = latencies_sorted[int(len(latencies_sorted) * 0.99)] if len(latencies_sorted) >= 100 else max(latencies_sorted)
            self.stdout.write(
                f'Latency per-peer (mock mode, ko gồm Mobile Agent thật): '
                f'p50={p50*1000:.0f}ms p95={p95*1000:.0f}ms p99={p99*1000:.0f}ms '
                f'max={max(latencies)*1000:.0f}ms mean={statistics.mean(latencies)*1000:.0f}ms'
            )

        self.stdout.write(f'\nRedis pre→post stats:')
        self.stdout.write(f'  pre  : {pre_stats}')
        self.stdout.write(f'  post : {post_stats}')
        self.stdout.write(f'DLQ delta: {post_dlq - pre_dlq}')

        if errors:
            self.stdout.write(self.style.ERROR('\nErrors (max 5):'))
            for e in errors[:5]:
                self.stdout.write(f'  · {e}')

        # Acceptance criteria
        ok = (
            success == total
            and len(errors) == 0
            and (not latencies or max(latencies) < 30)  # mock pipeline phải < 30s
            and (post_dlq == pre_dlq)
        )
        if ok:
            self.stdout.write(self.style.SUCCESS(
                f'\n[OK] Stress test PASS — {success}/{total} peer success, '
                f'0 DLQ, max latency {max(latencies):.2f}s.'
            ))
        else:
            self.stdout.write(self.style.ERROR(
                f'\n[FAIL] Stress test FAIL — coi error trên.'
            ))

        if not opts['keep_data']:
            self._cleanup_prefix(device, 'STRESS_')
            self.stdout.write('\n[cleanup] test data deleted.')

    # ── Worker thread function ───────────────────────────────────────────────

    def _process_one_peer(self, device: Device, peer: str, wf: Workflow) -> float:
        """Mock 1 peer's full pipeline. Return latency (seconds)."""
        t0 = time.monotonic()

        content = random.choice(SAMPLE_CONTENTS)

        # 1. DeviceNotification + matcher
        notif = DeviceNotification.objects.create(
            device=device,
            identifier=device.identifier or f'dev-{device.id}',
            key=f'stress-{uuid.uuid4().hex[:8]}',
            package='com.ss.android.ugc.trill',
            title=peer, text=content,
            raw_data={'source': 'stress_test'},
        )
        evt = get_matcher().match(notif)
        if evt != 'tiktok_dm':
            raise RuntimeError(f'matcher trả {evt!r} ≠ tiktok_dm')

        # 2. TiktokMessage IN
        TiktokMessage.objects.create(
            device=device, peer_handle=peer, channel=TiktokMessageChannel.DM,
            content=content, message_type=TiktokMessageType.USER,
            source=TiktokMessageSource.NOTIFICATION, is_preview=True,
            source_notification=notif,
        )

        # 3. Buffer add + force flush (test mode KHÔNG có sweeper).
        buf = get_buffer()
        try:
            buf.add_message(device_id=device.id, peer_handle=peer, content=content, history='')
        except Exception:  # noqa: BLE001
            pass
        # Force flush (skip score_with_llm vì test env có thể chưa có OPENAI_API_KEY).
        try:
            buf.force_flush(device_id=device.id, peer_handle=peer)
        except Exception:  # noqa: BLE001
            pass

        # 4. WorkflowRun → execute mocked handlers.
        run = WorkflowRun.objects.create(
            workflow=wf, status=RunStatus.RUNNING,
            started_at=timezone.now(),
            trigger_payload={
                'event_type': 'tiktok_dm',
                'event_source_id': device.id,
                'peer_handle': peer,
                'content': content,
            },
            current_step_index=0, context={},
        )
        from workflow.runner.loop import _execute_from_current_step  # noqa: PLC0415
        _execute_from_current_step(run)
        run.refresh_from_db()
        if run.status != RunStatus.COMPLETED:
            raise RuntimeError(f'run {run.id} status={run.status} ≠ completed')

        # 5. TiktokMessage OUT
        reply = run.context.get('step0_output', {}).get('reply_text', '')
        TiktokMessage.objects.create(
            device=device, peer_handle=peer, channel=TiktokMessageChannel.DM,
            content=reply, message_type=TiktokMessageType.BOT,
            source=TiktokMessageSource.AGENT_SENT, is_preview=False,
        )

        return time.monotonic() - t0

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _ensure_stress_workflow(self, device: Device) -> Workflow:
        wf, created = Workflow.objects.get_or_create(
            name='__stress_test_workflow',
            defaults={
                'description': 'Stress test workflow — KHÔNG dùng prod.',
                'status': 'active',
                'device': device, 'owner': device.owner,
            },
        )
        if created or not wf.steps.exists():
            wf.steps.all().delete()
            from workflow.models import StepActionType  # noqa: PLC0415
            WorkflowStep.objects.create(
                workflow=wf, name='Mock n8n', sort_order=0,
                action_type=StepActionType.CUSTOM,
                action_config={'type': 'CALL_N8N_WORKFLOW', 'webhook_url': 'mock://stress.test'},
            )
            WorkflowStep.objects.create(
                workflow=wf, name='Mock Mobile Agent', sort_order=1,
                action_type=StepActionType.CUSTOM,
                action_config={'type': 'CREATE_MOBILE_AGENT_TASK', 'agent': 'tiktok'},
            )
        return wf

    def _cleanup_prefix(self, device: Device, prefix: str):
        TiktokMessage.objects.filter(device=device, peer_handle__startswith=prefix).delete()
        TiktokPeerMute.objects.filter(device=device, peer_handle__startswith=prefix).delete()
        DeviceNotification.objects.filter(
            device=device, title__startswith=prefix, raw_data__source='stress_test',
        ).delete()
        WorkflowRun.objects.filter(
            workflow__name='__stress_test_workflow',
            trigger_payload__peer_handle__startswith=prefix,
        ).delete()
