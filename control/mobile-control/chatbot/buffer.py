"""TikTok AdaptiveMessageBuffer (Phase 2.2.3 — port từ chatbot prod).

Mục đích: gom nhiều DM ngắn rời rạc của cùng user trong 1 conversation
(vd "em hỏi giá ngực" → "khoảng bao nhiêu" → "cho em sđt") thành 1 flush
event duy nhất → giảm số task LLM + reply 1 lần đầy đủ thay vì 3 lần lẻ.

Cơ chế 3-tier hybrid (port từ `chatbot/core-chat/adaptive_message_buffer.py`):
1. **Fast heuristic** (< 1ms): từ kết thúc nguy hiểm ("và", "với", ...) →
   chưa xong; dấu câu rõ → có thể xong.
2. **AI Turn Scorer** (gpt-4o-mini, threshold 0.82): khi heuristic không
   quyết được, gọi LLM đánh giá xác suất user đã hoàn ý.
3. **Hard timeout adaptive** (5/4/3/3s tùy số msg, max 10s): fallback khi
   user gõ nửa chừng rồi bỏ đi.

4 BUG fix giữ nguyên từ chatbot prod (xem [discussion.md Update 6 mục 9.4]):
- BUG 1: scorer chạy NGOÀI Redis lock (phase 1 push → phase 2 score → phase 3 re-lock flush)
- BUG 2: `scored_key` flag 30s expire → tránh scorer + timeout cùng flush 2 lần
- BUG 3: rebuild full conversation history khi flush (đẩy đủ context cho LLM kế)
- BUG 4: combine bằng `'\\n'.join()` không phải space (LLM parse rõ message boundaries)

Adapt cho TikTok (so với chatbot prod):
- Redis key prefix: `tiktok:buffer:*` thay vì `chatbot:buffer:*`
- Composite key (device_id, peer_handle) thay vì (chatbot_id, customer_id)
- Hard timeout giảm: 5/4/3/3s (chatbot 7/6/5/4)
- Scorer prompt thêm hint cho emoji-heavy + sticker/voice
- Flush callback gọi `dispatch_event` (KHÔNG direct n8n call)

Phase 2.2 MVP: implement core 3-tier + flush. Background timeout sweeper sẽ
add ở Phase 2.3.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass
class BufferConfig:
    # Threshold AI scorer để flush. 0.82 (như chatbot prod) — strict đủ tránh
    # flush sớm khi user còn đang gõ.
    reply_threshold: float = 0.82
    # Hard max wait timeout (vd user gõ nửa chừng rồi rời) — safety net.
    max_wait_seconds: float = 10.0
    # Max msg/buffer — flush ngay khi đủ N msg (tránh chờ vô hạn).
    max_buffer_size: int = 15
    # Model dùng cho scorer LLM.
    scorer_model: str = 'gpt-4o-mini'
    scorer_timeout_seconds: float = 10.0


def get_adaptive_timeout(msg_count: int) -> float:
    """Timeout tùy số msg trong buffer (port từ chatbot prod, giảm cho TikTok).

    Càng nhiều msg → càng có thể đoán user đã gõ xong → giảm timeout.
    """
    return {1: 5.0, 2: 4.0, 3: 3.0}.get(msg_count, 3.0)


DEFAULT_CONFIG = BufferConfig()


# ── Redis keys (prefix tiktok:buffer:* — adapt cho TikTok) ───────────────────


def _msgs_key(device_id: int, peer_handle: str) -> str:
    return f'tiktok:buffer:msgs:{device_id}:{peer_handle}'


def _meta_key(device_id: int, peer_handle: str) -> str:
    return f'tiktok:buffer:meta:{device_id}:{peer_handle}'


def _lock_key(device_id: int, peer_handle: str) -> str:
    return f'tiktok:buffer:lock:{device_id}:{peer_handle}'


def _scored_key(device_id: int, peer_handle: str) -> str:
    """BUG 2 fix — flag 30s expire để tránh scorer + timeout đôi flush."""
    return f'tiktok:buffer:scored:{device_id}:{peer_handle}'


# ── Fast heuristic (< 1ms) ──────────────────────────────────────────────────


# Từ kết thúc "nguy hiểm" — gợi ý user CHƯA xong (đang gõ tiếp). Port + bổ sung
# từ chatbot prod, thêm slang TikTok ("rep", "tym").
_DANGER_ENDINGS = {
    'và', 'với', 'rồi', 'còn', 'nữa', 'độ', 'số', 'bị', 'vùng', 'thì', 'là',
    'để', 'cho', 'cũng', 'rep', 'kèo',
}

# Emoji + sticker markers — cần xử lý đặc biệt (Phase 2.2.5 edge case sẽ refine).
# Bao gồm: emoji main blocks + variation selectors (FE0F) + ZWJ (200D) + skin tones.
_EMOJI_PATTERN = re.compile(
    r'[\U0001F300-\U0001F9FF'    # emoji + supplemental + extended (main)
    r'\U0001FA00-\U0001FAFF'      # symbols & pictographs extended-A
    r'\U0001F000-\U0001F02F'      # mahjong/dominos/playing cards
    r'☀-➿'              # misc symbols + dingbats
    r'️‍'               # variation selector-16 + ZWJ
    r'\U0001F3FB-\U0001F3FF'      # skin tone modifiers
    r']'
)

# Sticker / Voice markers từ TikTok notification.
_STICKER_MARKER = '[Sticker]'
_VOICE_MARKER = '[Voice message]'


def fast_heuristic(text: str) -> float | None:
    """Heuristic nhanh — trả về score 0-1 hoặc None nếu cần gọi LLM.

    Rules port + adapt cho TikTok:
    - Sticker → score 1.0 (luôn flush — sticker là 1 turn riêng)
    - Voice → score 1.0 (flush + ở Phase 2.2.5 mark cần human review)
    - Empty/whitespace only → score 0.0 (chưa hoàn chỉnh)
    - Emoji-only → score 0.3 (đợi tiếp)
    - Kết thúc bằng từ nguy hiểm (`và`, `với`, ...) → score 0.1
    - Kết thúc bằng `?` rõ ràng → score 0.95
    - Kết thúc bằng `.`/`!` → score 0.85
    - Còn lại → None (gọi LLM scorer)
    """
    if not text:
        return 0.0
    stripped = text.strip()
    if not stripped:
        return 0.0

    # Sticker / Voice — turn riêng, flush ngay.
    if _STICKER_MARKER in text or _VOICE_MARKER in text:
        return 1.0

    # Emoji-only — chưa hoàn chỉnh.
    no_emoji = _EMOJI_PATTERN.sub('', stripped).strip()
    if not no_emoji:
        return 0.3

    # Kết thúc câu hỏi rõ ràng — flush ngay.
    if stripped.endswith('?') or stripped.endswith('？'):
        return 0.95

    # Từ kết thúc nguy hiểm.
    last_word = stripped.rstrip('.,!;:…')
    last_word = last_word.split()[-1].lower() if last_word else ''
    if last_word in _DANGER_ENDINGS:
        return 0.1

    # Câu hoàn chỉnh có dấu câu cuối.
    if stripped.endswith(('.', '!', '。', '！')):
        return 0.85

    return None  # → gọi LLM scorer


# ── AI Turn Scorer ──────────────────────────────────────────────────────────


_SCORER_SYSTEM_PROMPT = """Bạn là AI phân tích DM TikTok. Đánh giá user đã hoàn thành ý chưa.

Trả về JSON CHỈ:
{"score": <0.0-1.0>, "reason": "<lý do ngắn>"}

Score:
- 0.0-0.3: chắc chắn chưa xong (đang gõ tiếp) → KHÔNG flush
- 0.4-0.6: ambiguous → KHÔNG flush
- 0.7-1.0: xong, có thể reply → flush

Đặc thù TikTok DM:
- Emoji-heavy ("❤️❤️", "🤣") → đợi tiếp (score < 0.5)
- Slang/abbrev ("v1", "v2" = vòng 1/2; "rep" = reply; "kèo" = đề nghị)
- Tin ngắn (< 50 chars) bình thường, ưu tiên đợi thêm
- Buffer 1 tin → score TỐI ĐA 0.4 (không đủ context)

QUY TẮC BẮT BUỘC:
- Buffer 1 msg + không có "?" hay "ạ" cuối → score ≤ 0.4
- Tin cuối kết thúc bằng "và/với/rồi/còn" → score ≤ 0.3
- Có "?" hoặc "ạ"/"nhé" cuối tin cuối → score ≥ 0.7
"""


_SCORER_USER_TEMPLATE = """Conversation context (history gần đây):
{history}

Buffer hiện tại ({n_msgs} tin user gõ liên tiếp):
{buffered_messages}

QUAN TRỌNG: Đọc TOÀN BỘ {n_msgs} tin như 1 câu hoàn chỉnh, KHÔNG đánh giá từng tin riêng.
Thời gian từ msg đầu: {elapsed:.1f}s | từ msg cuối: {since_last:.1f}s

User đã hoàn ý chưa?"""


def score_with_llm(
    config: BufferConfig,
    history: str,
    buffered_messages: list[str],
    elapsed: float,
    since_last: float,
) -> tuple[float, str]:
    """Gọi OpenAI gpt-4o-mini scorer. Trả về (score, reason).

    Cache 2s tự để client-side (caller có thể cache nếu muốn).
    Fallback score=0.5 + reason='llm_error' nếu LLM fail.
    """
    api_key = getattr(settings, 'OPENAI_API_KEY', '') or ''
    if not api_key:
        logger.warning('OPENAI_API_KEY chưa set → scorer fallback score=0.5')
        return 0.5, 'no_api_key'

    try:
        from openai import OpenAI  # noqa: PLC0415

        client = OpenAI(api_key=api_key, timeout=config.scorer_timeout_seconds)
        user_msg = _SCORER_USER_TEMPLATE.format(
            history=history or '(rỗng)',
            n_msgs=len(buffered_messages),
            buffered_messages='\n'.join(f'  - {m}' for m in buffered_messages),
            elapsed=elapsed,
            since_last=since_last,
        )

        resp = client.chat.completions.create(
            model=config.scorer_model,
            messages=[
                {'role': 'system', 'content': _SCORER_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_msg},
            ],
            temperature=0,
            max_tokens=120,
            response_format={'type': 'json_object'},
        )
        content = resp.choices[0].message.content or '{}'
        data = json.loads(content)
        score = float(data.get('score', 0.5))
        reason = str(data.get('reason', ''))[:200]
        return max(0.0, min(1.0, score)), reason
    except Exception as exc:  # noqa: BLE001
        logger.warning('AI scorer failed: %s → fallback 0.5', exc, exc_info=True)
        return 0.5, f'error: {exc!r}'


# ── AdaptiveMessageBuffer ───────────────────────────────────────────────────


class AdaptiveMessageBuffer:
    """Buffer cho TikTok DM với 3-tier scoring + Redis state.

    Usage:
        buffer = get_buffer()
        should_flush, flushed_msgs = buffer.add_message(
            device_id=8, peer_handle='Bob', content='Em hỏi giá',
            history='[prev conversation text]',
        )
        if should_flush:
            # Caller dispatch_event với combined_content = '\\n'.join(flushed_msgs)
            ...
    """

    def __init__(self, config: BufferConfig | None = None):
        self.config = config or DEFAULT_CONFIG
        self._client_lock = threading.Lock()
        self._client = None

    def _redis(self):
        if self._client is None:
            with self._client_lock:
                if self._client is None:
                    import redis  # noqa: PLC0415
                    self._client = redis.Redis.from_url(
                        settings.REDIS_URL, decode_responses=True
                    )
        return self._client

    def add_message(
        self,
        device_id: int,
        peer_handle: str,
        content: str,
        history: str = '',
    ) -> tuple[bool, list[str]]:
        """Thêm 1 msg vào buffer + check có nên flush không.

        Returns:
            (should_flush, flushed_messages)
            - should_flush=False, flushed=[]: msg đã add, buffer đang đợi tiếp
            - should_flush=True, flushed=[...]: buffer đã drain, caller dispatch

        Implementation theo BUG 1 fix (chatbot prod):
        - Phase 1: lock + push msg (atomic)
        - Phase 2: NO LOCK — fast heuristic + (nếu cần) AI scorer
        - Phase 3: re-lock + flush (atomic) — re-check scored flag để tránh
          race với background timeout sweeper.
        """
        r = self._redis()
        msgs_key = _msgs_key(device_id, peer_handle)
        meta_key = _meta_key(device_id, peer_handle)
        scored_key = _scored_key(device_id, peer_handle)

        now = time.time()

        # ── BYPASS MODE: env CHATBOT_BUFFER_DISABLE_SCORING=true ──────────
        # Flush ngay mỗi tin (instant reply, KHÔNG đợi gom tin). Dùng cho dev
        # test hoặc khi user xác nhận đã có code xịn hơn cho buffer logic.
        # Vẫn push vào Redis list để giữ history cross-message, sau đó drain
        # ngay → return (True, [content]) cho caller dispatch.
        from django.conf import settings as _dj_settings  # noqa: PLC0415
        if getattr(_dj_settings, 'CHATBOT_BUFFER_DISABLE_SCORING', False):
            # Atomic: push msg vào list, drain ngay, cleanup meta/scored
            with r.lock(_lock_key(device_id, peer_handle), timeout=5):
                r.rpush(msgs_key, content)
                flushed = r.lrange(msgs_key, 0, -1)
                r.delete(msgs_key, meta_key, scored_key)
            logger.info(
                'Buffer BYPASS (CHATBOT_BUFFER_DISABLE_SCORING=true) device=%s peer=%s '
                'flush_count=%s — KHÔNG gọi LLM scorer',
                device_id, peer_handle, len(flushed),
            )
            return True, flushed

        # ── Phase 1: push msg + update meta ────────────────────────────────
        with r.lock(_lock_key(device_id, peer_handle), timeout=5):
            r.rpush(msgs_key, content)
            meta_raw = r.get(meta_key)
            if meta_raw:
                meta = json.loads(meta_raw)
                meta['last_message_time'] = now
                meta['msg_count'] = r.llen(msgs_key)
            else:
                meta = {
                    'first_message_time': now,
                    'last_message_time': now,
                    'msg_count': 1,
                }
            r.set(meta_key, json.dumps(meta), ex=300)  # 5min TTL safety
            current_msgs = r.lrange(msgs_key, 0, -1)

        msg_count = len(current_msgs)
        elapsed = now - meta['first_message_time']
        since_last = 0.0  # vừa add nên = 0

        # ── Phase 2: scoring NGOÀI lock (BUG 1) ────────────────────────────
        score, reason = self._compute_score(
            current_msgs, history, elapsed, since_last,
        )
        logger.debug(
            'Buffer device=%s peer=%s msg_count=%s score=%.2f reason=%s',
            device_id, peer_handle, msg_count, score, reason,
        )

        # Hard timeout / max size — always flush.
        adaptive_timeout = get_adaptive_timeout(msg_count)
        force_flush = (
            elapsed >= max(adaptive_timeout, self.config.max_wait_seconds)
            or msg_count >= self.config.max_buffer_size
        )

        should_flush = score >= self.config.reply_threshold or force_flush

        if not should_flush:
            return False, []

        # ── Phase 3: re-lock + atomic flush (BUG 2 — scored flag) ──────────
        with r.lock(_lock_key(device_id, peer_handle), timeout=5):
            # Re-check scored flag — nếu sweeper khác đã claim → skip.
            if r.get(scored_key):
                logger.debug(
                    'Buffer device=%s peer=%s đã được flush bởi process khác — skip',
                    device_id, peer_handle,
                )
                return False, []

            flushed_msgs = r.lrange(msgs_key, 0, -1)
            if not flushed_msgs:
                return False, []

            # Set scored flag 30s + drain buffer.
            r.set(scored_key, '1', ex=30)
            r.delete(msgs_key, meta_key)

        logger.info(
            'Buffer FLUSH device=%s peer=%s msgs=%d score=%.2f reason=%s',
            device_id, peer_handle, len(flushed_msgs), score, reason,
        )
        return True, flushed_msgs

    def _compute_score(
        self,
        msgs: list[str],
        history: str,
        elapsed: float,
        since_last: float,
    ) -> tuple[float, str]:
        """3-tier scoring: heuristic on last msg → LLM scorer fallback."""
        if not msgs:
            return 0.0, 'empty_buffer'

        last_msg = msgs[-1]

        # Tier 1: fast heuristic on last msg.
        heuristic_score = fast_heuristic(last_msg)
        if heuristic_score is not None:
            return heuristic_score, f'heuristic({last_msg[:30]!r})'

        # Tier 2: AI LLM scorer.
        return score_with_llm(
            self.config, history, msgs, elapsed, since_last,
        )

    def force_flush(
        self, device_id: int, peer_handle: str,
    ) -> list[str]:
        """Drain buffer ngay không qua scoring — dùng cho background sweeper
        khi check timeout hết hạn."""
        r = self._redis()
        msgs_key = _msgs_key(device_id, peer_handle)
        meta_key = _meta_key(device_id, peer_handle)
        scored_key = _scored_key(device_id, peer_handle)

        with r.lock(_lock_key(device_id, peer_handle), timeout=5):
            if r.get(scored_key):
                return []
            flushed = r.lrange(msgs_key, 0, -1)
            if not flushed:
                return []
            r.set(scored_key, '1', ex=30)
            r.delete(msgs_key, meta_key)
        logger.info(
            'Buffer FORCE_FLUSH device=%s peer=%s msgs=%d',
            device_id, peer_handle, len(flushed),
        )
        return flushed

    def clear(self, device_id: int, peer_handle: str) -> None:
        """Reset buffer state — dùng khi peer bị mute, hoặc test cleanup."""
        r = self._redis()
        keys = [
            _msgs_key(device_id, peer_handle),
            _meta_key(device_id, peer_handle),
            _lock_key(device_id, peer_handle),
            _scored_key(device_id, peer_handle),
        ]
        r.delete(*keys)


# ── Singleton ────────────────────────────────────────────────────────────────

_buffer_lock = threading.Lock()
_buffer: AdaptiveMessageBuffer | None = None


def get_buffer() -> AdaptiveMessageBuffer:
    global _buffer
    if _buffer is None:
        with _buffer_lock:
            if _buffer is None:
                _buffer = AdaptiveMessageBuffer()
    return _buffer
