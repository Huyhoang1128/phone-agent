"""Failure logger — ghi log đầy đủ cho mỗi task FAIL (skip log nếu success).

Mục đích: thu thập đủ data để debug ROOT CAUSE của task fail nhanh chóng,
KHÔNG cần đợi user gửi screenshot/log từng lần.

Output:
    {WORKER_ROOT}/logs/failures/task_{id}_{ts}_{outcome}.log

Format file:
    === Task Metadata ===
    Task ID: 28
    Device: 416H4EFS222CS
    Created: 2026-06-08T11:00:36
    Goal: ...
    Payload: {...}

    === Outcome ===
    Status: failed | cancelled | error
    Reason: <error msg / traceback>
    Duration: 72.4s

    === Event Log ({N} events) ===
    [00:00.5] [plan] 1. Close notification panel...
    [00:01.2] [action] Tap home button
    [00:02.0] [agent] Closed notification panel
    ...

    === Final UI State (optional) ===
    <last UI dump if available>

Usage trong task_executor.py:
    from failure_log import TaskFailureLogger
    flog = TaskFailureLogger(task_id=..., device_serial=..., body=body, goal=goal)
    flog.add_event(timestamp_offset, kind, text)
    ...
    flog.finalize(status='failed', reason=str(exc))  # write file
    # hoặc nếu success:
    flog.discard()  # KHÔNG write
"""
from __future__ import annotations

import json
import logging
import os
import time
import traceback
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Root dir = parent của file này = worker root.
_WORKER_ROOT = Path(__file__).parent
_FAILURE_LOG_DIR = _WORKER_ROOT / "logs" / "failures"

# Cap file size để tránh log quá dài (vd executor loop vô hạn).
_MAX_EVENTS_KEPT = 500
_MAX_EVENT_TEXT_LEN = 2000  # truncate mỗi event nếu quá dài

# Cap retention — xóa file cũ hơn N ngày (cleanup chạy lúc startup).
_RETENTION_DAYS = 14


class TaskFailureLogger:
    """Per-task accumulator cho failure log.

    Lifecycle:
      1. __init__: tạo instance lúc task start
      2. add_event(kind, text): mỗi lần có plan/action/agent event
      3. attach_ui_dump(elements): optional, snapshot UI lúc fail
      4. finalize(status, reason) HOẶC discard():
         - finalize → ghi file (chỉ khi status != 'completed' / 'success')
         - discard → KHÔNG ghi gì (success case)
    """

    def __init__(
        self,
        *,
        task_id: Any,
        device_serial: str,
        body: dict,
        goal: str = '',
        app: str = '',
    ):
        self.task_id = task_id
        self.device_serial = device_serial or '<unknown>'
        self.body = body or {}
        self.goal = goal
        self.app = app
        self.start_ts = time.time()
        self.events: list[dict] = []  # {ts_offset, kind, text}
        self.ui_dump: str | None = None  # optional last UI state
        self._finalized = False

    def add_event(self, kind: str, text: str) -> None:
        """Thêm 1 event vào buffer. kind ∈ {plan, action, agent, log, raw, ...}"""
        if self._finalized:
            return
        if len(self.events) >= _MAX_EVENTS_KEPT:
            # Cap để tránh OOM nếu executor loop vô hạn
            return
        if text and len(text) > _MAX_EVENT_TEXT_LEN:
            text = text[:_MAX_EVENT_TEXT_LEN] + f' …[truncated {len(text) - _MAX_EVENT_TEXT_LEN} chars]'
        self.events.append({
            'ts_offset': time.time() - self.start_ts,
            'kind': kind,
            'text': text or '',
        })

    def attach_ui_dump(self, ui_dump: str) -> None:
        """Snapshot UI elements lúc fail (nếu có)."""
        if self._finalized:
            return
        # Cap size — UI dump có thể 10-100KB
        if ui_dump and len(ui_dump) > 20000:
            ui_dump = ui_dump[:20000] + f'\n…[truncated {len(ui_dump) - 20000} chars]'
        self.ui_dump = ui_dump

    def finalize(self, *, status: str, reason: str = '', exc: BaseException | None = None) -> str | None:
        """Ghi file log nếu status là fail/cancelled/error.

        Returns: path file đã ghi, hoặc None nếu skip (success case).
        """
        if self._finalized:
            return None
        self._finalized = True

        # Chỉ log nếu là failure outcome
        FAIL_STATUSES = {'failed', 'cancelled', 'error', 'unknown'}
        normalized_status = (status or '').lower().strip()
        if normalized_status not in FAIL_STATUSES:
            return None  # skip — task success

        duration = time.time() - self.start_ts

        # Build file content
        lines: list[str] = []
        lines.append('=' * 70)
        lines.append('TASK FAILURE LOG')
        lines.append('=' * 70)
        lines.append('')
        lines.append('=== Task Metadata ===')
        lines.append(f'Task ID:        {self.task_id}')
        lines.append(f'Device Serial:  {self.device_serial}')
        lines.append(f'App:            {self.app or "(unspecified)"}')
        lines.append(f'Started:        {time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.start_ts))}')
        lines.append(f'Duration:       {duration:.1f}s')
        lines.append('')
        lines.append('=== Goal ===')
        lines.append(self.goal or '(empty)')
        lines.append('')
        lines.append('=== Payload ===')
        try:
            lines.append(json.dumps(self.body.get('payload') or {}, ensure_ascii=False, indent=2))
        except Exception:  # noqa: BLE001
            lines.append(str(self.body.get('payload') or {}))
        lines.append('')
        lines.append('=== Outcome ===')
        lines.append(f'Status:  {normalized_status}')
        lines.append(f'Reason:  {reason or "(no reason given)"}')
        if exc is not None:
            lines.append('')
            lines.append('--- Traceback ---')
            try:
                tb = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))
                lines.append(tb)
            except Exception:  # noqa: BLE001
                lines.append(f'(failed to format traceback for {exc!r})')
        lines.append('')
        lines.append(f'=== Event Log ({len(self.events)} events) ===')
        for ev in self.events:
            ts = ev['ts_offset']
            mm = int(ts // 60)
            ss = ts - mm * 60
            lines.append(f'[{mm:02d}:{ss:05.2f}] [{ev["kind"]}] {ev["text"]}')
        if not self.events:
            lines.append('(no events recorded)')
        lines.append('')
        if self.ui_dump:
            lines.append('=== Final UI Dump (snapshot) ===')
            lines.append(self.ui_dump)
            lines.append('')

        # Write file
        try:
            _FAILURE_LOG_DIR.mkdir(parents=True, exist_ok=True)
            ts_str = time.strftime('%Y%m%d_%H%M%S', time.localtime(self.start_ts))
            safe_task_id = str(self.task_id).replace('/', '_').replace('\\', '_')[:30]
            fname = f'task_{safe_task_id}_{ts_str}_{normalized_status}.log'
            fpath = _FAILURE_LOG_DIR / fname
            fpath.write_text('\n'.join(lines), encoding='utf-8')
            logger.warning('Task FAIL log written: %s', fpath)
            return str(fpath)
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to write failure log: %s', exc, exc_info=True)
            return None

    def discard(self) -> None:
        """Skip log — gọi khi task success."""
        self._finalized = True
        self.events.clear()
        self.ui_dump = None


def cleanup_old_failure_logs() -> int:
    """Xóa file log cũ hơn _RETENTION_DAYS ngày. Trả số file đã xóa.

    Gọi 1 lần lúc worker startup để tránh bloat disk.
    """
    if not _FAILURE_LOG_DIR.exists():
        return 0
    cutoff = time.time() - _RETENTION_DAYS * 86400
    removed = 0
    try:
        for fpath in _FAILURE_LOG_DIR.glob('task_*.log'):
            try:
                if fpath.stat().st_mtime < cutoff:
                    fpath.unlink()
                    removed += 1
            except Exception:  # noqa: BLE001
                pass
        if removed:
            logger.info('Cleaned %d failure logs older than %d days', removed, _RETENTION_DAYS)
    except Exception as exc:  # noqa: BLE001
        logger.warning('cleanup_old_failure_logs error: %s', exc)
    return removed
