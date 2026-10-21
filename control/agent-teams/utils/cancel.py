"""v3.2.1 BUG-J / Option 3D — Cross-service cancel signal cho scenario pipeline.

Django (mobile-control/content_scenario/views.py) SET key `scenario:cancel:{rid}`
trên Redis khi user click Hủy. Orchestrator của agent_teams CHECK key này trước
mỗi LLM call boundary — nếu set thì raise ScenarioCancelled → return early →
tiết kiệm ~50-70% LLM API cost.

Architecture:

    FE click Hủy
      ↓
    POST /content-scenarios/cancel/ {request_id}
      ↓
    Django views.py:cancel_scenario  →  Redis SET scenario:cancel:{rid}=1 (TTL 60s)
      ↓                                       ↑
    AbortController.abort() FE                │ (cross-service Redis)
                                              │
    agent_teams orchestrator                  ↓
      → check_cancel(request_id) trước mỗi layer
        → raise ScenarioCancelled nếu key set
        → route catch → trả về HTTP 499 (Client Closed Request)
        → Django catch → no save, no audit

Hành vi nếu Redis unavailable (vd dev compose không có redis service):
- check_cancel: no-op (không raise) → pipeline chạy bình thường, không cancel.
- signal_cancel: no-op → không lưu signal.
- Đảm bảo cancel là BEST-EFFORT — Redis fail KHÔNG break pipeline.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Redis client lazy-init. None nếu Redis không khả dụng (skip cancel check).
_redis_client = None  # type: ignore
_redis_init_failed = False


def _client():
    """Lazy-init Redis client. Trả None nếu init fail."""
    global _redis_client, _redis_init_failed
    if _redis_init_failed:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as redis_pkg  # local import — soft dep
        url = os.environ.get('REDIS_URL', 'redis://redis:6379/0')
        _redis_client = redis_pkg.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        # Ping để verify connectivity ngay (fail fast nếu redis down)
        _redis_client.ping()
        logger.info('[cancel] Redis client initialized at %s', url)
        return _redis_client
    except Exception as exc:  # noqa: BLE001
        logger.warning('[cancel] Redis init failed (cancel signal DISABLED): %s', exc)
        _redis_init_failed = True
        return None


def _key(request_id: str) -> str:
    """Redis key namespace cho scenario cancel signals."""
    return f'scenario:cancel:{request_id}'


class ScenarioCancelled(Exception):
    """Raised từ orchestrator khi check_cancel phát hiện user đã cancel.

    Route catcher convert → HTTP 499 (Client Closed Request).
    Orchestrator caller cleanup partial state nếu có (vd reset Agno session).
    """
    def __init__(self, request_id: str, layer: str = ''):
        self.request_id = request_id
        self.layer = layer
        super().__init__(
            f'Scenario request {request_id!r} cancelled at layer {layer!r}'
        )


def check_cancel(request_id: Optional[str], layer: str = ''):
    """Raise ScenarioCancelled nếu Redis có cancel flag cho request_id.

    Safe khi:
    - request_id rỗng/None: no-op (vd dev test không pass request_id)
    - Redis unavailable: no-op (best-effort)
    """
    if not request_id:
        return
    client = _client()
    if client is None:
        return
    try:
        if client.get(_key(request_id)):
            logger.info('[cancel] Detected cancel for request_id=%s at layer=%s', request_id, layer)
            raise ScenarioCancelled(request_id, layer)
    except ScenarioCancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        # Redis lookup fail → no-op (don't block pipeline)
        logger.warning('[cancel] check_cancel(%s) Redis error: %s', request_id, exc)


def signal_cancel(request_id: str, ttl_seconds: int = 60) -> bool:
    """SET Redis cancel flag cho request_id. TTL phòng stale flags.

    Trả True nếu set thành công, False nếu Redis fail.
    Used bởi Django POST /scenarios/cancel/ endpoint.
    """
    if not request_id:
        return False
    client = _client()
    if client is None:
        return False
    try:
        client.set(_key(request_id), '1', ex=ttl_seconds)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning('[cancel] signal_cancel(%s) Redis error: %s', request_id, exc)
        return False


def is_cancelled(request_id: Optional[str]) -> bool:
    """Check signal mà KHÔNG raise — dùng cho audit/debug.

    Khác check_cancel: không raise exception, chỉ trả bool.
    """
    if not request_id:
        return False
    client = _client()
    if client is None:
        return False
    try:
        return bool(client.get(_key(request_id)))
    except Exception:  # noqa: BLE001
        return False
