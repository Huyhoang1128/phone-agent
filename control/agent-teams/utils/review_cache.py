"""Content-addressed cache cho kết quả Reviewer (Review-on-the-fly) — v4.1.

Prompt review (xem agents/scenario/creative_tools.py:_run_reviewer) CHỈ chứa nội
dung shot đã patch, KHÔNG kèm full scenario ⇒ review là hàm thuần của
(reviewer_id, nội-dung-shot). Vì vậy cache theo content hash là chính xác: shot
không đổi được review lại sẽ trả cache, tiết kiệm đúng 1 LLM call mỗi lần trùng.

Best-effort như utils/cancel.py:
- Redis nếu khả dụng (chia sẻ giữa các worker FastAPI).
- Fallback in-memory LRU khi Redis down (vẫn giúp trong cùng tiến trình).
- MỌI lỗi cache KHÔNG được break luồng refine (chỉ log + bỏ qua).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger(__name__)

_TTL_SECONDS = int(os.environ.get("REVIEW_CACHE_TTL_SECONDS", "3600"))
_MEM_MAX = int(os.environ.get("REVIEW_CACHE_MEM_MAX", "512"))

# Redis lazy-init (None nếu không khả dụng → dùng in-memory).
_redis_client = None  # type: ignore
_redis_init_failed = False
_mem_cache: "OrderedDict[str, str]" = OrderedDict()


def _client():
    """Lazy-init Redis client. Trả None nếu init fail (fallback in-memory)."""
    global _redis_client, _redis_init_failed
    if _redis_init_failed:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as redis_pkg  # soft dep
        url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
        _redis_client = redis_pkg.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        _redis_client.ping()
        logger.info("[review_cache] Redis initialized at %s", url)
        return _redis_client
    except Exception as exc:  # noqa: BLE001
        logger.warning("[review_cache] Redis init failed (dùng in-memory LRU): %s", exc)
        _redis_init_failed = True
        return None


def _key(reviewer_id: str, payload: str) -> str:
    digest = hashlib.sha256(f"{reviewer_id}\n{payload}".encode("utf-8")).hexdigest()
    return f"scenario:review:{digest}"


def get(reviewer_id: str, payload: str) -> Optional[dict]:
    """Trả review đã cache cho (reviewer_id, payload) hoặc None nếu miss."""
    k = _key(reviewer_id, payload)
    client = _client()
    if client is not None:
        try:
            raw = client.get(k)
            return json.loads(raw) if raw else None
        except Exception as exc:  # noqa: BLE001
            logger.warning("[review_cache] get error: %s", exc)
    # Fallback in-memory
    raw_mem = _mem_cache.get(k)
    if raw_mem is None:
        return None
    _mem_cache.move_to_end(k)
    try:
        return json.loads(raw_mem)
    except Exception:  # noqa: BLE001
        return None


def set(reviewer_id: str, payload: str, review: dict, ttl: int = _TTL_SECONDS) -> None:
    """Lưu review vào cache. Bỏ qua review rỗng (không cache lỗi parse)."""
    if not review:
        return
    k = _key(reviewer_id, payload)
    try:
        raw = json.dumps(review, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return
    client = _client()
    if client is not None:
        try:
            client.set(k, raw, ex=ttl)
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("[review_cache] set error: %s", exc)
    # Fallback in-memory (LRU cap)
    _mem_cache[k] = raw
    _mem_cache.move_to_end(k)
    while len(_mem_cache) > _MEM_MAX:
        _mem_cache.popitem(last=False)
