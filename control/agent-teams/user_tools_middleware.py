"""
User-tool injection middleware
================================

Before each ``POST /agents/{agent_id}/runs`` request the middleware:

1. Identifies the target agent and the authenticated user.
2. Loads the user's enabled tools from the database.
3. Adds those tools to the agent for the duration of the run.
4. Restores the original tool list after the run completes (or fails).

Thread-safety
-------------
An ``asyncio.Lock`` is kept per agent so that concurrent requests for *different*
users cannot interleave their tool-list modifications.  Users whose agents have
no extra tools skip the lock entirely.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

# Matches  POST /agents/{agent_id}/runs
_AGENT_RUN_RE = re.compile(r"^/agents/([^/]+)/runs$")


class UserToolsMiddleware(BaseHTTPMiddleware):
    """Inject per-user optional tools into an agent run and restore them after."""

    def __init__(self, app, agents: Optional[Dict[str, Any]] = None):
        super().__init__(app)
        # Map of agent_id -> agent instance
        self._agents: Dict[str, Any] = agents or {}
        # Per-agent asyncio lock to serialize tool-list mutations
        self._locks: Dict[str, asyncio.Lock] = {}

    def _get_lock(self, agent_id: str) -> asyncio.Lock:
        if agent_id not in self._locks:
            self._locks[agent_id] = asyncio.Lock()
        return self._locks[agent_id]

    async def dispatch(self, request: Request, call_next) -> Response:
        # Only intercept agent-run POST requests
        match = _AGENT_RUN_RE.match(request.url.path)
        if not match or request.method != "POST":
            return await call_next(request)

        agent_id = match.group(1)
        user_id: Optional[str] = getattr(request.state, "user_id", None)

        if not user_id or agent_id not in self._agents:
            return await call_next(request)

        # Load user-specific tools (only enabled ones)
        try:
            from tools_registry import build_user_tools  # noqa: PLC0415

            extra_tools: List[Any] = build_user_tools(user_id)
        except Exception as exc:
            logger.warning(
                "UserToolsMiddleware: could not load tools for user %s – %s",
                user_id,
                exc,
            )
            return await call_next(request)

        if not extra_tools:
            # No user-specific tools – skip lock overhead entirely
            return await call_next(request)

        agent = self._agents[agent_id]
        lock = self._get_lock(agent_id)

        async with lock:
            # Snapshot the current tool list
            original_tools: List[Any] = list(getattr(agent, "tools", []) or [])

            # Inject extra tools
            for tool in extra_tools:
                try:
                    agent.add_tool(tool)
                except Exception as exc:
                    logger.warning(
                        "UserToolsMiddleware: add_tool failed for agent '%s', "
                        "tool '%s' – %s",
                        agent_id,
                        type(tool).__name__,
                        exc,
                    )

            try:
                response = await call_next(request)
            finally:
                # Always restore original tools
                try:
                    agent.set_tools(original_tools)
                except Exception as exc:
                    logger.warning(
                        "UserToolsMiddleware: set_tools failed for agent '%s' – %s",
                        agent_id,
                        exc,
                    )

        return response
