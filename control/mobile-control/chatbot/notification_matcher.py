"""Khớp DeviceNotification với preset trong notification_presets.yaml.

Mục đích: gán `event_type` (vd 'tiktok_dm', 'tiktok_follow') cho payload trước
khi `dispatch_event(SystemEvent.DEVICE_NOTIFY, ...)`. `WorkflowTrigger` có thể
khai báo `event_filter = {"event_type": "tiktok_dm"}` để chỉ trigger cho 1
loại notification cụ thể.

Xem `docs/Chatbot_Tiktok/design.md` mục 6 cho thiết kế.
"""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Optional

import yaml

logger = logging.getLogger(__name__)

PRESETS_PATH = Path(__file__).resolve().parent / 'notification_presets.yaml'

# Sentinel cho preset có action=SKIP (negative match — KHÔNG emit event).
_SKIP_ACTION = 'SKIP'

# Priority mặc định khi preset không khai báo (match cuối cùng).
_DEFAULT_PRIORITY = 1000


class NotificationMatcher:
    """Load + match preset từ YAML. Thread-safe lazy load + lock cho reload."""

    def __init__(self, presets_path: Path = PRESETS_PATH):
        self._presets_path = presets_path
        self._presets: list[dict] = []
        self._compiled: list[dict] = []
        self._lock = threading.Lock()
        self.reload()

    def reload(self) -> None:
        """Đọc lại YAML và compile regex. Gọi từ management command khi cần
        hot-update mà không restart backend."""
        with self._lock:
            with open(self._presets_path, encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}
            presets = data.get('presets', []) or []
            # Sort ASC theo priority (small priority → match trước).
            presets.sort(key=lambda p: p.get('priority', _DEFAULT_PRIORITY))
            self._presets = presets
            self._compiled = [self._compile(p) for p in presets]
            logger.info(
                'NotificationMatcher reloaded: %d presets from %s',
                len(self._compiled), self._presets_path,
            )

    @staticmethod
    def _compile(preset: dict) -> dict:
        """Compile regex strings trong preset để skip re-compile mỗi lần match."""
        out = dict(preset)  # shallow copy
        out['_pkg_re'] = re.compile(preset['package_regex']) if 'package_regex' in preset else None
        out['_title_re'] = re.compile(preset['title_regex']) if 'title_regex' in preset else None
        out['_text_re'] = re.compile(preset['text_regex']) if 'text_regex' in preset else None
        out['_title_blacklist_re'] = [re.compile(p) for p in preset.get('title_blacklist', []) or []]
        out['_text_blacklist_re'] = [re.compile(p) for p in preset.get('text_blacklist', []) or []]
        return out

    def match(self, notif) -> Optional[str]:
        """Trả về `event_type` (id preset POSITIVE) nếu match.

        Trả về None khi:
        - Match preset NEGATIVE (`action: SKIP`) → ý nghĩa: notification này là
          marketing/system, KHÔNG emit event.
        - Không match preset nào → notification lạ, KHÔNG emit event (giống skip).

        Args:
            notif: DeviceNotification instance hoặc dict có keys
                   `package`, `title`, `text`.
        """
        package, title, text = self._extract_fields(notif)

        for preset in self._compiled:
            if not self._package_matches(preset, package):
                continue
            if not self._content_matches(preset, title, text):
                continue
            if preset.get('action') == _SKIP_ACTION:
                logger.debug(
                    'NotificationMatcher: SKIP preset=%s package=%r title=%r',
                    preset.get('id'), package, title,
                )
                return None
            event_type = preset['id']
            logger.debug(
                'NotificationMatcher: matched preset=%s package=%r title=%r',
                event_type, package, title,
            )
            return event_type

        logger.debug(
            'NotificationMatcher: no match package=%r title=%r text=%r',
            package, title, text[:60] if text else '',
        )
        return None

    # ── Helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _extract_fields(notif) -> tuple[str, str, str]:
        """Lấy (package, title, text) — chấp nhận DeviceNotification instance
        hoặc plain dict (cho unit test)."""
        if isinstance(notif, dict):
            return (
                notif.get('package', '') or '',
                notif.get('title', '') or '',
                notif.get('text', '') or '',
            )
        return (
            getattr(notif, 'package', '') or '',
            getattr(notif, 'title', '') or '',
            getattr(notif, 'text', '') or '',
        )

    @staticmethod
    def _package_matches(preset: dict, package: str) -> bool:
        pkg_re = preset.get('_pkg_re')
        if pkg_re is None:
            return True
        return bool(pkg_re.search(package))

    @staticmethod
    def _content_matches(preset: dict, title: str, text: str) -> bool:
        # Positive regex checks
        title_re = preset.get('_title_re')
        if title_re is not None and not title_re.search(title):
            return False
        text_re = preset.get('_text_re')
        if text_re is not None and not text_re.search(text):
            return False
        # Blacklist checks
        for pattern in preset.get('_title_blacklist_re', []):
            if pattern.search(title):
                return False
        for pattern in preset.get('_text_blacklist_re', []):
            if pattern.search(text):
                return False
        # Heuristic — text length cap (DM thường ngắn)
        max_len = preset.get('text_max_length')
        if max_len is not None and len(text) > max_len:
            return False
        return True


# ── Singleton (lazy) ───────────────────────────────────────────────────────
# Lazy init để tránh load YAML khi Django import models (vd lúc makemigrations
# không cần matcher). Chỉ load khi _save_notification gọi tới.

_matcher_lock = threading.Lock()
_matcher: NotificationMatcher | None = None


def get_matcher() -> NotificationMatcher:
    """Return process-wide singleton matcher."""
    global _matcher
    if _matcher is None:
        with _matcher_lock:
            if _matcher is None:
                _matcher = NotificationMatcher()
    return _matcher


def reload_presets() -> None:
    """Public hook để management command reload YAML mà không restart backend."""
    get_matcher().reload()
