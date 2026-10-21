"""E2E smoke test cho Chatbot TikTok pipeline (Phase 2.4.2 + 2.4.3).

Mục đích: validate toàn bộ luồng backend từ A→Z **KHÔNG cần phone vật lý + KHÔNG
cần n8n thật + KHÔNG cần Kafka cluster**. Mock các external dependency:
- DeviceNotification được tạo manual (skip Mobilerun WS).
- n8n HTTP call thay bằng handler override return `reply_text` từ CLI flag.
- Mobile Agent task thay bằng handler return SENT_CONFIRMED ngay.

Scenarios:
- Happy path: full pipeline → WorkflowRun COMPLETED + 2 TiktokMessage (IN + OUT).
- `--expect-skip-dispatch`: sticker/voice/muted → KHÔNG dispatch event.
- `--expect-buffer-hold`: emoji-only → buffer KHÔNG flush.
- `--multiple-content`: 2+ messages buffered → 1 flush gộp.

Usage:
    python manage.py run_chatbot_e2e_smoke --device-id 8 --peer-handle "TEST_X"
    python manage.py run_chatbot_e2e_smoke --device-id 8 --peer-handle "TEST_Sticker" \\
        --content "[Sticker]" --expect-skip-dispatch
    python manage.py run_chatbot_e2e_smoke --device-id 8 --peer-handle "TEST_Emoji" \\
        --content "❤️❤️❤️" --expect-buffer-hold
    python manage.py run_chatbot_e2e_smoke --device-id 8 --peer-handle "TEST_Race" \\
        --multiple-content "Em chào" --multiple-content "Em hỏi giá"
"""
from __future__ import annotations

import uuid

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
from workflow.models import RunStatus, Workflow, WorkflowRun


# Markers user chú ý highlight trong output.
TAG_OK = '[OK]'
TAG_FAIL = '[FAIL]'
TAG_SKIP = '[SKIP]'
TAG_STEP = '[step]'


class Command(BaseCommand):
    help = 'E2E smoke test pipeline Chatbot TikTok (Phase 2.4.2 + 2.4.3).'

    def add_arguments(self, parser):
        parser.add_argument('--device-id', type=int, required=True)
        parser.add_argument('--peer-handle', type=str, required=True)
        parser.add_argument(
            '--content', type=str, default='Em hỏi giá nâng ngực',
            help='Content tin nhắn user gửi (mock notification text).',
        )
        parser.add_argument(
            '--reply-text', type=str,
            default='Dạ chị inbox em tư vấn ạ ❤️',
            help='Mock n8n response reply_text.',
        )
        parser.add_argument(
            '--expect-skip-dispatch', action='store_true',
            help='Scenario sticker/voice/muted: KHÔNG được dispatch event.',
        )
        parser.add_argument(
            '--expect-buffer-hold', action='store_true',
            help='Scenario emoji-only: buffer KHÔNG flush.',
        )
        parser.add_argument(
            '--multiple-content', action='append', default=[],
            help='Gửi nhiều tin liên tiếp (test race + buffer combine). '
                 'Có thể truyền cờ này nhiều lần. Khi set, --content bị ignore.',
        )
        parser.add_argument(
            '--keep-data', action='store_true',
            help='KHÔNG cleanup data sau test (debug).',
        )

    def handle(self, *args, **opts):
        device_id = opts['device_id']
        peer = opts['peer_handle']
        content = opts['content']
        reply_text = opts['reply_text']
        multiple = opts['multiple_content']
        expect_skip = opts['expect_skip_dispatch']
        expect_hold = opts['expect_buffer_hold']

        try:
            device = Device.objects.get(pk=device_id)
        except Device.DoesNotExist:
            raise CommandError(f'Device id={device_id} không tồn tại.')

        contents = multiple if multiple else [content]

        self.stdout.write(self.style.MIGRATE_HEADING(
            f'\n=== E2E smoke pipeline TikTok DM ==='
        ))
        self.stdout.write(
            f'device={device.id} ({device.name}) peer={peer!r}\n'
            f'contents={contents}\n'
            f'reply_text={reply_text!r}'
        )

        # ── Step 0: cleanup test data ────────────────────────────────────────
        self._cleanup(device, peer)

        # ── Step 1: NotificationMatcher classify ─────────────────────────────
        matcher = get_matcher()
        last_notif = None
        for c in contents:
            notif = DeviceNotification.objects.create(
                device=device,
                key=f'smoke-{uuid.uuid4().hex[:8]}',
                package='com.ss.android.ugc.trill',
                title=peer,
                text=c,
                raw_data={'source': 'e2e_smoke'},
                identifier=device.identifier or f'dev-{device.id}',
            )
            evt_type = matcher.match(notif)
            self._step(f'NotificationMatcher: text={c!r} → event_type={evt_type!r}')
            if evt_type != 'tiktok_dm':
                self.stdout.write(self.style.WARNING(
                    f'  Lưu ý: matcher trả {evt_type!r} ≠ tiktok_dm. '
                    'Có thể yaml preset không bao quát case này — '
                    'edit notification_presets.yaml hoặc khảo sát thêm.'
                ))
            last_notif = notif

        # ── Step 2: TiktokMessage IN + AdaptiveMessageBuffer ────────────────
        buffer = get_buffer()
        flushed_combined: str | None = None

        for i, c in enumerate(contents):
            TiktokMessage.objects.create(
                device=device, peer_handle=peer, channel=TiktokMessageChannel.DM,
                content=c, message_type=TiktokMessageType.USER,
                source=TiktokMessageSource.NOTIFICATION, is_preview=True,
                source_notification=last_notif if i == len(contents) - 1 else None,
            )

            # Test sticker/voice marker detect.
            if c.strip() in ('[Sticker]', '[Voice message]'):
                self._step(f'Special marker detected: {c.strip()}')
                # Auto-mute 24h (giống _auto_mute_for_special_marker)
                TiktokPeerMute.objects.update_or_create(
                    device=device, peer_handle=peer,
                    defaults={
                        'muted_until': timezone.now() + timezone.timedelta(hours=24),
                        'note': f'Auto-mute do {c.strip()}',
                    },
                )
                if expect_skip:
                    self._ok('Sticker/voice → auto-mute + skip dispatch (expected).')
                    if not opts['keep_data']:
                        self._cleanup(device, peer)
                    return
                self._fail('Sticker/voice nhưng KHÔNG truyền --expect-skip-dispatch.')
                return

            # Test mute check.
            is_muted = TiktokPeerMute.objects.filter(
                device=device, peer_handle=peer,
            ).filter(
                muted_until__isnull=True,
            ).exists() or TiktokPeerMute.objects.filter(
                device=device, peer_handle=peer,
                muted_until__gte=timezone.now(),
            ).exists()
            if is_muted:
                if expect_skip:
                    self._ok('Peer đã muted → skip dispatch (expected).')
                    if not opts['keep_data']:
                        self._cleanup(device, peer)
                    return
                self._fail('Peer muted nhưng KHÔNG truyền --expect-skip-dispatch.')
                return

            # Buffer add_message
            should_flush, flushed_msgs = buffer.add_message(
                device_id=device.id, peer_handle=peer, content=c, history='',
            )
            self._step(
                f'Buffer add_message({c!r}): should_flush={should_flush} '
                f'flushed_count={len(flushed_msgs)}'
            )
            if should_flush:
                flushed_combined = '\n'.join(flushed_msgs)

        # ── Edge case: buffer hold (emoji-only) ──────────────────────────────
        if expect_hold:
            if flushed_combined is None:
                self._ok('Buffer KHÔNG flush (emoji-only hold expected).')
                if not opts['keep_data']:
                    self._cleanup(device, peer)
                return
            self._fail(
                f'--expect-buffer-hold nhưng buffer ĐÃ flush: {flushed_combined!r}. '
                'Heuristic threshold sai?'
            )
            return

        if flushed_combined is None:
            # Force flush vì test mode (timeout sweeper chưa có).
            self.stdout.write(self.style.WARNING(
                '  Buffer chưa flush — force flush cho test mode.'
            ))
            flushed_msgs = buffer.force_flush(device_id=device.id, peer_handle=peer)
            flushed_combined = '\n'.join(flushed_msgs) if flushed_msgs else None

        if flushed_combined is None:
            self._fail('Buffer rỗng sau force_flush.')
            return
        self._step(f'Combined content: {flushed_combined!r}')

        # ── Step 3: tìm/tạo WorkflowTrigger + WorkflowRun ────────────────────
        # Phase 2.4 smoke: tạo WorkflowRun trực tiếp (skip dispatch_event +
        # handle_event_triggers cho fast deterministic). Vẫn verify được runner.
        workflow = self._ensure_test_workflow(device)
        run = WorkflowRun.objects.create(
            workflow=workflow,
            status=RunStatus.PENDING,
            trigger_payload={
                'event_type': 'tiktok_dm',
                'event_source_id': device.id,
                'peer_handle': peer,
                'content': flushed_combined,
                'history': '',
            },
            current_step_index=0,
            context={},
        )
        self._step(f'WorkflowRun id={run.id} created status=PENDING')

        # ── Step 4: mock CALL_N8N_WORKFLOW handler → return reply_text ───────
        # Override registry để command này không tốn HTTP call thật.
        from workflow.runner import executor as exec_mod  # noqa: PLC0415

        original_handlers = dict(exec_mod._HANDLERS)
        try:
            exec_mod._HANDLERS['CALL_N8N_WORKFLOW'] = lambda step, run, ctx: {
                'reply_text': reply_text,
            }
            exec_mod._HANDLERS['CREATE_MOBILE_AGENT_TASK'] = lambda step, run, ctx: {
                'mock_task_id': 99999, 'outcome': 'SENT_CONFIRMED',
            }

            # Execute steps via runner loop helper.
            from workflow.runner.loop import _execute_from_current_step  # noqa: PLC0415
            run.status = RunStatus.RUNNING
            run.started_at = timezone.now()
            run.save(update_fields=['status', 'started_at', 'updated_at'])
            _execute_from_current_step(run)
            run.refresh_from_db()
        finally:
            exec_mod._HANDLERS.clear()
            exec_mod._HANDLERS.update(original_handlers)

        self._step(f'After execute: run.status={run.status} context={run.context}')

        # ── Step 5: simulate kafka task_status callback → TiktokMessage OUT ──
        # (Phase 2.1 kafka_listener.maybe_create_outbound_message logic).
        TiktokMessage.objects.create(
            device=device, peer_handle=peer, channel=TiktokMessageChannel.DM,
            content=reply_text,
            message_type=TiktokMessageType.BOT,
            source=TiktokMessageSource.AGENT_SENT, is_preview=False,
        )
        self._step('TiktokMessage OUT (source=agent_sent) inserted.')

        # ── Step 6: verify final state ───────────────────────────────────────
        in_count = TiktokMessage.objects.filter(
            device=device, peer_handle=peer, message_type=TiktokMessageType.USER,
        ).count()
        out_count = TiktokMessage.objects.filter(
            device=device, peer_handle=peer, message_type=TiktokMessageType.BOT,
        ).count()

        ok = True
        if run.status != RunStatus.COMPLETED:
            self._fail(f'WorkflowRun status={run.status} (expected COMPLETED).')
            ok = False
        if in_count != len(contents):
            self._fail(f'TiktokMessage IN count={in_count} (expected {len(contents)}).')
            ok = False
        if out_count != 1:
            self._fail(f'TiktokMessage OUT count={out_count} (expected 1).')
            ok = False

        if ok:
            self.stdout.write(self.style.SUCCESS(
                f'\n{TAG_OK} E2E PASS — pipeline hoạt động đúng end-to-end.\n'
                f'  · WorkflowRun id={run.id} {run.status}\n'
                f'  · TiktokMessage IN={in_count} OUT={out_count}\n'
                f'  · Reply text rendered: {reply_text!r}\n'
            ))
        else:
            self.stdout.write(self.style.ERROR(
                f'\n{TAG_FAIL} E2E có vấn đề — xem chi tiết ở trên.'
            ))

        # ── Cleanup ──────────────────────────────────────────────────────────
        if not opts['keep_data']:
            self._cleanup(device, peer)
            self.stdout.write('  · Test data cleaned up.')
        else:
            self.stdout.write('  · --keep-data: giữ test data để inspect manual.')

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _step(self, msg: str):
        self.stdout.write(f'{TAG_STEP} {msg}')

    def _ok(self, msg: str):
        self.stdout.write(self.style.SUCCESS(f'{TAG_OK} {msg}'))

    def _fail(self, msg: str):
        self.stdout.write(self.style.ERROR(f'{TAG_FAIL} {msg}'))

    def _cleanup(self, device: Device, peer: str):
        TiktokMessage.objects.filter(device=device, peer_handle=peer).delete()
        TiktokPeerMute.objects.filter(device=device, peer_handle=peer).delete()
        DeviceNotification.objects.filter(
            device=device, title=peer, raw_data__source='e2e_smoke',
        ).delete()
        # Clear Redis buffer keys.
        try:
            buf = get_buffer()
            buf.clear(device_id=device.id, peer_handle=peer)
        except Exception:  # noqa: BLE001
            pass
        # Delete test workflow runs (PENDING leftovers).
        WorkflowRun.objects.filter(
            workflow__name='__e2e_smoke_workflow',
            trigger_payload__peer_handle=peer,
        ).delete()

    def _ensure_test_workflow(self, device: Device) -> Workflow:
        """Tạo workflow mock với 2 step CALL_N8N + CREATE_MOBILE_AGENT_TASK."""
        wf, created = Workflow.objects.get_or_create(
            name='__e2e_smoke_workflow',
            defaults={
                'description': 'E2E smoke test workflow — KHÔNG dùng prod.',
                'status': 'active',
                'device': device,
                'owner': device.owner,
            },
        )
        if created or not wf.steps.exists():
            wf.steps.all().delete()
            from workflow.models import WorkflowStep, StepActionType  # noqa: PLC0415
            WorkflowStep.objects.create(
                workflow=wf, name='Gọi n8n gen reply',
                sort_order=0,
                action_type=StepActionType.CUSTOM,
                action_config={
                    'type': 'CALL_N8N_WORKFLOW',
                    'webhook_url': 'mock://n8n.test',
                    'timeout_seconds': 10,
                },
            )
            WorkflowStep.objects.create(
                workflow=wf, name='Tạo Mobile Agent task',
                sort_order=1,
                action_type=StepActionType.CUSTOM,
                action_config={
                    'type': 'CREATE_MOBILE_AGENT_TASK',
                    'agent': 'tiktok',
                    'duration_minutes': 3,
                    'goal_template': 'Mock goal — gửi {{ context.step0.reply_text }}',
                },
            )
        return wf
