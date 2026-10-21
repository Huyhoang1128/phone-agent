"""User-related API routes."""

import time

from agno.scheduler import ScheduleManager
from db import db_url, get_postgres_db
from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter(prefix="/user", tags=["user"])


def _to_timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return int(value.timestamp())


@router.get("/schedules")
async def get_user_schedules(
    request: Request,
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=100, ge=1, le=1000),
):
    """Return all schedules that belong to the currently authenticated user."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")

    t0 = time.monotonic()
    mgr = ScheduleManager(get_postgres_db())
    all_schedules = mgr.list()

    # Filter to schedules owned by this user (user_id stored in payload)
    user_schedules = [
        s for s in all_schedules
        if isinstance(s.payload, dict) and str(s.payload.get("user_id", "")) == str(user_id)
    ]
    search_time_ms = int((time.monotonic() - t0) * 1000)

    total_count = len(user_schedules)
    total_pages = max(1, (total_count + limit - 1) // limit)
    start = (page - 1) * limit
    paged = user_schedules[start: start + limit]

    data = [
        {
            "id": str(s.id),
            "name": s.name,
            "description": getattr(s, "description", None),
            "method": s.method,
            "endpoint": s.endpoint,
            "payload": s.payload,
            "cron_expr": s.cron_expr,
            "timezone": s.timezone,
            "timeout_seconds": s.timeout_seconds,
            "max_retries": s.max_retries,
            "retry_delay_seconds": s.retry_delay_seconds,
            "enabled": s.enabled,
            "next_run_at": _to_timestamp(s.next_run_at),
            "created_at": _to_timestamp(s.created_at),
            "updated_at": _to_timestamp(s.updated_at),
        }
        for s in paged
    ]

    return {
        "data": data,
        "meta": {
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "total_count": total_count,
            "search_time_ms": search_time_ms,
        },
    }


@router.get("/usage")
async def get_user_usage(request: Request):
    """Return the current rate-limit usage stats for the authenticated user."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")

    from rate_limiter import get_rate_limiter

    stats = await get_rate_limiter().get_usage(user_id=str(user_id), db_url=db_url)
    return stats
