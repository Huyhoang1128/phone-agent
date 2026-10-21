"""Template render + JSONPath response mapping cho action handlers.

Phase 2.2 dùng implementation đơn giản (không kéo Jinja2 / jsonpath-ng dependency):
- Template: `{{ trigger.peer_handle }}` / `{{ context.step1.reply_text }}` —
  dot-notation truy cập dict lồng nhau.
- Response mapping: `$.reply_text` / `$.data.reply_text` — JSONPath đơn giản
  chỉ hỗ trợ dot path từ root.

Nếu sau này cần template phức tạp (loops, conditions) → switch Jinja2 trong
Phase L. Hiện tại đủ cho payload n8n straightforward.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


# Match `{{ path.to.value }}` — whitespace tolerant.
_TEMPLATE_PATTERN = re.compile(r'\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}')


def render_value(value: Any, ctx: dict[str, Any]) -> Any:
    """Render 1 value đệ quy.

    Rules:
    - str: substitute `{{ path }}` tokens. Nếu STRING ONLY là 1 token (vd
      `'{{ trigger.foo }}'`) → trả về raw value (giữ type — list/dict/int).
      Nếu mixed (vd `'Hello {{ trigger.name }}'`) → trả về string sau replace.
    - dict: render đệ quy mọi value.
    - list: render đệ quy mọi item.
    - None / int / bool / float: trả về nguyên giá trị.
    """
    if isinstance(value, str):
        return _render_string(value, ctx)
    if isinstance(value, dict):
        return {k: render_value(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [render_value(item, ctx) for item in value]
    return value


def _render_string(s: str, ctx: dict[str, Any]) -> Any:
    """Render 1 string. Trả về raw type nếu string là 1 token đơn nhất."""
    # Case: toàn bộ string là 1 token → preserve raw type.
    stripped = s.strip()
    full_match = _TEMPLATE_PATTERN.fullmatch(stripped)
    if full_match is not None:
        path = full_match.group(1)
        return _resolve(path, ctx, default=None)

    # Case: mixed string → substitute tokens trong string.
    def _repl(m: re.Match) -> str:
        path = m.group(1)
        resolved = _resolve(path, ctx, default='')
        # Coerce list/dict → repr cho mixed string (rare case).
        if not isinstance(resolved, (str, int, float, bool)):
            return str(resolved)
        return str(resolved)

    return _TEMPLATE_PATTERN.sub(_repl, s)


def _resolve(path: str, ctx: dict[str, Any], default: Any = None) -> Any:
    """Dot-path access vào dict lồng nhau.

    Examples:
        ctx = {'trigger': {'peer_handle': 'Bob'}, 'context': {'step1': {'reply': 'Hi'}}}
        _resolve('trigger.peer_handle', ctx) → 'Bob'
        _resolve('context.step1.reply', ctx) → 'Hi'
        _resolve('foo.bar', ctx) → None (default)
    """
    parts = path.split('.')
    cur: Any = ctx
    for part in parts:
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return default
        else:
            return default
        if cur is None:
            return default
    return cur


# ── JSONPath response mapping (đơn giản — chỉ dot path từ root) ────────────


_JSONPATH_PREFIX = '$.'


def extract_response_field(response_body: dict[str, Any], path: str) -> Any:
    """Extract 1 field từ HTTP response body theo JSONPath đơn giản.

    Format hỗ trợ:
    - `$.reply_text` → response_body['reply_text']
    - `$.data.reply_text` → response_body['data']['reply_text']
    - `$.choices.0.text` → response_body['choices'][0]['text']

    Trả về None nếu path không tồn tại.
    """
    if not path or not isinstance(path, str):
        return None
    if path.startswith(_JSONPATH_PREFIX):
        path = path[len(_JSONPATH_PREFIX):]
    elif path.startswith('$'):
        path = path[1:].lstrip('.')
    return _resolve(path, response_body, default=None)


def split_into_bubbles(text: str) -> list[str]:
    """Tách 1 reply text thành danh sách bubble theo `[SPLIT]` marker.

    Pattern port từ chatbot prod (`core-chat/redis_stream_consumer.py:948-962`).
    LLM (vd n8n agent) chèn `[SPLIT]` giữa các ý để bot có thể gửi nhiều tin
    nhắn rời, mô phỏng cách người gõ. Fallback split bằng `\n\n` nếu KHÔNG
    có `[SPLIT]` marker → tách theo paragraph.

    Examples:
        >>> split_into_bubbles('Hi[SPLIT]How are you?')
        ['Hi', 'How are you?']
        >>> split_into_bubbles('Para 1\\n\\nPara 2')
        ['Para 1', 'Para 2']
        >>> split_into_bubbles('Single')
        ['Single']
        >>> split_into_bubbles('')
        []

    Note: Phase 2.2 MVP — utility this, nhưng workflow runner CHƯA hỗ trợ
    dynamic multi-bubble step (cần PAUSED_SAME_STEP sentinel infra). Phase 2.3
    sẽ wire khi build UI Inbox cần render multi-bubble. Hiện tại user thiết kế
    workflow với 1 step / bubble (static).
    """
    if not text:
        return []
    if '[SPLIT]' in text:
        # Có marker → chỉ dùng [SPLIT], KHÔNG fallback \n\n.
        return [b.strip() for b in text.split('[SPLIT]') if b.strip()]
    # Không có marker → fallback paragraph break.
    bubbles = [b.strip() for b in text.split('\n\n') if b.strip()]
    if bubbles:
        return bubbles
    # Single paragraph — return as 1 bubble (nếu sau strip không rỗng).
    stripped = text.strip()
    return [stripped] if stripped else []


def apply_response_mapping(response_body: Any, mapping: dict[str, str]) -> dict[str, Any]:
    """Apply `response_mapping` config → trả về dict các field đã extract.

    Args:
        response_body: parsed JSON từ HTTP response (dict thường).
        mapping: vd `{'reply_text': '$.reply_text', 'reply_image': '$.image_url'}`.

    Returns:
        `{'reply_text': '...', 'reply_image': '...' or None}`. Nếu
        `response_body` không phải dict → return dict các value None.
    """
    if not mapping:
        return {}
    if not isinstance(response_body, dict):
        # n8n có thể return plain string — wrap thành dict để mapping `$.` work.
        if isinstance(response_body, str):
            return {key: response_body for key in mapping}
        return {key: None for key in mapping}

    out: dict[str, Any] = {}
    for key, path in mapping.items():
        out[key] = extract_response_field(response_body, path)
    return out
