"""
User-tool management routes
============================

Endpoints for listing available tools, querying/toggling per-user tool status,
and updating tool-specific parameters (e.g. API keys).

All endpoints require a valid JWT (same auth mechanism as the rest of the API).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from tools_registry import AVAILABLE_TOOLS, create_tool_instance, validate_tool_params

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/user/tools", tags=["user-tools"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ToolParamMeta(BaseModel):
    type: str
    description: str
    required: bool
    secret: bool


class ToolInfo(BaseModel):
    tool_name: str
    name: str
    description: str
    icon: Optional[str] = None
    params_schema: Dict[str, ToolParamMeta]
    enabled: bool
    params: Dict[str, Any]


class EnableToolRequest(BaseModel):
    """Body for POST /user/tools/{tool_name}/enable."""

    params: Dict[str, Any] = {}


class UpdateParamsRequest(BaseModel):
    """Body for PUT /user/tools/{tool_name}/params."""

    params: Dict[str, Any]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return str(user_id)


def _mask_secrets(params: Dict[str, Any], tool_name: str) -> Dict[str, Any]:
    """Replace secret param values with a masked placeholder for API responses.

    Only fields declared in the tool's params schema are returned; any extra
    keys stored in the database (e.g. from a legacy configuration) are silently
    dropped so they are never accidentally exposed.
    """
    meta = AVAILABLE_TOOLS.get(tool_name, {}).get("params", {})
    masked = {}
    for key, field_meta in meta.items():
        value = params.get(key)
        if field_meta.get("secret") is True and value:
            masked[key] = "***"
        else:
            masked[key] = value
    return masked


def _tool_to_response(
    tool_name: str,
    db_row,  # UserTool | None
) -> dict:
    registry_entry = AVAILABLE_TOOLS[tool_name]
    enabled = db_row.enabled if db_row is not None else False
    raw_params: Dict[str, Any] = (db_row.params or {}) if db_row is not None else {}
    return {
        "tool_name": tool_name,
        "name": registry_entry["name"],
        "description": registry_entry["description"],
        "icon": registry_entry.get("icon"),
        "params_schema": registry_entry.get("params", {}),
        "enabled": enabled,
        "params": _mask_secrets(raw_params, tool_name),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", summary="List all available tools with current status for this user")
async def list_tools(request: Request):
    """Return all tools in the registry together with the user's current configuration."""
    user_id = _require_user_id(request)

    from models import list_user_tools  # noqa: PLC0415

    db_rows = {row.tool_name: row for row in list_user_tools(user_id)}

    return [
        _tool_to_response(tool_name, db_rows.get(tool_name))
        for tool_name in AVAILABLE_TOOLS
    ]


@router.get("/{tool_name}", summary="Get a single tool's status for this user")
async def get_tool(tool_name: str, request: Request):
    """Return configuration for a single *tool_name* for the authenticated user."""
    user_id = _require_user_id(request)

    if tool_name not in AVAILABLE_TOOLS:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found.")

    from models import get_user_tool  # noqa: PLC0415

    row = get_user_tool(user_id, tool_name)
    return _tool_to_response(tool_name, row)


@router.post("/{tool_name}/enable", summary="Enable a tool for this user")
async def enable_tool(
    tool_name: str,
    body: EnableToolRequest,
    request: Request,
):
    """Enable *tool_name* for the authenticated user and (optionally) set params."""
    user_id = _require_user_id(request)

    if tool_name not in AVAILABLE_TOOLS:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found.")

    # Validate required params against the schema before anything else
    try:
        validate_tool_params(tool_name, body.params)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Validate that provided params can produce a working tool instance
    # (only if any params were supplied)
    if body.params:
        test_instance = create_tool_instance(tool_name, body.params)
        if test_instance is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Could not instantiate tool '{tool_name}' with the provided params. "
                    "Check that all required parameters are correct."
                ),
            )

    from models import upsert_user_tool, get_user_tool  # noqa: PLC0415

    # Merge with existing params so we don't accidentally wipe keys not supplied
    existing = get_user_tool(user_id, tool_name)
    merged_params = {**(existing.params or {} if existing else {}), **body.params}

    row = upsert_user_tool(
        user_id=user_id,
        tool_name=tool_name,
        enabled=True,
        params=merged_params,
    )
    return _tool_to_response(tool_name, row)


@router.post("/{tool_name}/disable", summary="Disable a tool for this user")
async def disable_tool(tool_name: str, request: Request):
    """Disable *tool_name* for the authenticated user."""
    user_id = _require_user_id(request)

    if tool_name not in AVAILABLE_TOOLS:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found.")

    from models import set_user_tool_enabled  # noqa: PLC0415

    row = set_user_tool_enabled(user_id, tool_name, enabled=False)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"Tool '{tool_name}' has not been configured for this user.",
        )
    return _tool_to_response(tool_name, row)


@router.put("/{tool_name}/params", summary="Update parameters for a tool")
async def update_tool_params(
    tool_name: str,
    body: UpdateParamsRequest,
    request: Request,
):
    """Update the stored parameters (e.g. API key) for *tool_name*.

    The tool must already exist for this user (call ``/enable`` first).
    """
    user_id = _require_user_id(request)

    if tool_name not in AVAILABLE_TOOLS:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found.")

    from models import get_user_tool, upsert_user_tool  # noqa: PLC0415

    existing = get_user_tool(user_id, tool_name)
    if existing is None:
        raise HTTPException(
            status_code=404,
            detail=f"Tool '{tool_name}' has not been configured for this user. Enable it first.",
        )

    # Merge new params on top of existing
    merged_params = {**(existing.params or {}), **body.params}

    # Validate required params against the schema after merging
    try:
        validate_tool_params(tool_name, merged_params)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    row = upsert_user_tool(
        user_id=user_id,
        tool_name=tool_name,
        enabled=existing.enabled,
        params=merged_params,
    )
    return _tool_to_response(tool_name, row)
