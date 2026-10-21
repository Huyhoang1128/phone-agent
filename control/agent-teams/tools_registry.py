"""
Optional-tool registry
======================

Defines the catalogue of *optional* tools that an admin or the user themselves
can enable on a per-user basis.  Each entry describes:

* human-readable metadata (name, description)
* the parameters the tool expects (so the API can expose them)
* a ``create`` factory that instantiates the tool from stored params

To add a new optional tool:
1. Add an entry to ``AVAILABLE_TOOLS``.
2. Implement a branch (or a separate factory function) inside ``create_tool_instance``.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool catalogue
# ---------------------------------------------------------------------------

AVAILABLE_TOOLS: Dict[str, Dict[str, Any]] = {
    "github": {
        "name": "GitHub Tools",
        "description": (
            "Interact with GitHub repositories – list repos, read/write files, "
            "manage issues and pull requests."
        ),
        "icon": None,
        "params": {
            "access_token": {
                "type": "string",
                "description": "GitHub Personal Access Token (classic or fine-grained).",
                "required": True,
                "secret": True,
            },
        },
        "pip_package": "PyGithub",
    },
    "dnse": {
        "name": "DNSE Trading Tools",
        "description": (
            "Giao dịch chứng khoán và lấy dữ liệu thị trường qua DNSE Open API – "
            "tra cứu tài khoản, đặt/sửa/hủy lệnh, lịch sử giao dịch và thông tin mã CK."
        ),
        "icon": None,
        "params": {
            "api_key": {
                "type": "string",
                "description": "DNSE API Key (X-API-Key).",
                "required": True,
                "secret": False,
            },
            "api_secret": {
                "type": "string",
                "description": "DNSE API Secret dùng để tạo chữ ký HMAC-SHA256 (X-Signature).",
                "required": True,
                "secret": True,
            },
        },
    },
}

# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_tool_instance(tool_name: str, params: Dict[str, Any]):
    """Return an instantiated tool object ready to be added to an agent.

    Returns ``None`` (with a warning) if the tool cannot be instantiated.
    """
    if tool_name == "github":
        return _create_github_tools(params)
    if tool_name == "dnse":
        return _create_dnse_tools(params)

    logger.warning("tools_registry: unknown tool '%s' – skipping", tool_name)
    return None


def _create_github_tools(params: Dict[str, Any]):
    # Accept both the canonical key ("access_token") and the legacy env-var style
    # key ("GITHUB_ACCESS_TOKEN") so that tokens stored under either name work.
    access_token: str = params.get("access_token") or params.get("GITHUB_ACCESS_TOKEN", "")
    if not access_token:
        logger.warning("tools_registry: github tool has no access_token – skipping")
        return None
    try:
        from agno.tools.github import GithubTools  # noqa: PLC0415

        return GithubTools(access_token=access_token)
    except ImportError:
        logger.warning(
            "tools_registry: GithubTools not available – install PyGithub"
        )
        return None
    except Exception as exc:
        logger.warning("tools_registry: failed to create GithubTools – %s", exc)
        return None


def _create_dnse_tools(params: Dict[str, Any]):
    api_key: str = params.get("api_key", "")
    api_secret: str = params.get("api_secret", "")
    if not api_key or not api_secret:
        logger.warning("tools_registry: dnse tool missing api_key or api_secret – skipping")
        return None
    try:
        from agents.tools.dnse_tools import DnseTools  # noqa: PLC0415

        return DnseTools(api_key=api_key, api_secret=api_secret)
    except Exception as exc:
        logger.warning("tools_registry: failed to create DnseTools – %s", exc)
        return None


def validate_tool_params(tool_name: str, params: Dict[str, Any]) -> None:
    """Raise ``ValueError`` if any required param is missing from *params*.

    Checks each param declared as ``required: True`` in the tool's
    ``params`` schema.  Raises ``ValueError`` with a human-readable message
    listing the missing keys so callers can surface it to the user.
    """
    schema = AVAILABLE_TOOLS.get(tool_name, {}).get("params", {})
    missing = [
        key
        for key, meta in schema.items()
        if meta.get("required") and (key not in params or params[key] is None or params[key] == "")
    ]
    if missing:
        raise ValueError(
            f"Missing required parameter(s) for tool '{tool_name}': "
            + ", ".join(missing)
        )



def build_user_tools(user_id: str) -> List[Any]:
    """Load enabled UserTool records for *user_id* and return instantiated tools."""
    from models import list_user_tools  # noqa: PLC0415 (avoid circular import at module level)

    rows = list_user_tools(user_id)
    instances = []
    for row in rows:
        if not row.enabled:
            continue
        if row.tool_name not in AVAILABLE_TOOLS:
            logger.debug(
                "tools_registry: tool '%s' for user %s not in registry – skipping",
                row.tool_name,
                user_id,
            )
            continue
        tool = create_tool_instance(row.tool_name, row.params or {})
        if tool is not None:
            instances.append(tool)
    return instances
