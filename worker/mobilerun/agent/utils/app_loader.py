"""
AppLoader — discovers and loads per-app tools and skills from the ``apps/`` directory.

Each app lives in ``apps/<app_name>/`` and may contain:

- ``tools.py``    — exports ``TOOLS: dict``  (custom tool definitions)
- ``skills/``     — directory of ``*.md`` files; each file documents how to combine
                    tools to accomplish a specific goal.  These are loaded as plain
                    text and injected into the Manager's system prompt so it can
                    plan using the documented workflows.
- ``metadata.yaml``  — optional metadata (``package_name``, ``description``)
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import yaml

logger = logging.getLogger("mobilerun")

# Default location for the apps directory (relative to cwd)
_DEFAULT_APPS_DIR = "apps"


def _load_module_from_path(module_name: str, file_path: Path) -> Any:
    """Dynamically import a Python module from an absolute file path."""
    spec = importlib.util.spec_from_file_location(module_name, str(file_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {file_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _load_metadata(app_dir: Path) -> Dict[str, Any]:
    """Load ``metadata.yaml`` from an app directory (returns empty dict if absent)."""
    meta_path = app_dir / "metadata.yaml"
    if not meta_path.exists():
        return {}
    try:
        with open(meta_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data
    except Exception as e:
        logger.warning(f"Failed to read metadata.yaml in {app_dir}: {e}")
        return {}


def discover_app_dir(
    app_name: Optional[str] = None,
    package_name: Optional[str] = None,
    apps_dir: Optional[str] = None,
) -> Optional[Path]:
    """Find the app directory that matches *app_name* or *package_name*.

    Search order:
    1. ``apps_dir/<app_name>`` — direct match by directory name (if *app_name* given)
    2. Scan all subdirectories of ``apps_dir`` and match ``metadata.yaml``
       ``package_name`` field (if *package_name* given).

    Only directories that are immediate children of ``apps_dir`` are considered;
    the resolved path is validated to be within ``apps_dir`` to prevent
    path-traversal when ``app_name`` contains ``..`` or similar sequences.

    Args:
        app_name: Directory name under ``apps/`` (e.g. ``"tiktok"``).
        package_name: Android/iOS package identifier
            (e.g. ``"com.zhiliaoapp.musically"``).
        apps_dir: Absolute or relative path to the apps root directory.
            Defaults to ``"apps"`` relative to the current working directory.

    Returns:
        ``Path`` to the matched app directory, or ``None`` if not found.
    """
    base = Path(apps_dir or _DEFAULT_APPS_DIR)
    if not base.is_absolute():
        base = Path.cwd() / base

    if not base.exists():
        logger.debug(f"Apps directory not found: {base}")
        return None

    # Resolve base once to use as the trust boundary for path validation
    resolved_base = base.resolve()

    # 1. Direct match by directory name
    if app_name:
        candidate = (base / app_name).resolve()
        # Validate that candidate is directly inside resolved_base (no path traversal)
        try:
            candidate.relative_to(resolved_base)
        except ValueError:
            logger.warning(
                f"App name '{app_name}' resolves outside apps_dir, ignoring"
            )
            return None
        if candidate.is_dir() and candidate.parent == resolved_base:
            logger.debug(f"Found app directory by name: {candidate}")
            return candidate

    # 2. Scan directories for package_name match
    if package_name:
        for entry in sorted(base.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            # Validate each entry is directly under base
            try:
                entry.resolve().relative_to(resolved_base)
            except ValueError:
                continue
            meta = _load_metadata(entry)
            if meta.get("package_name") == package_name:
                logger.debug(
                    f"Found app directory by package_name '{package_name}': {entry}"
                )
                return entry

    return None


def load_app_tools(app_dir: Path) -> Dict[str, Any]:
    """Load custom tool definitions from ``<app_dir>/tools.py``.

    The module must expose a ``TOOLS`` dict in the standard mobilerun
    custom-tools format::

        TOOLS = {
            "my_tool": {
                "parameters": {"arg": {"type": "string", "required": True}},
                "description": "...",
                "function": my_func,
                # Optional: called automatically after the agent completes
                # successfully, if this tool was invoked during the session.
                # Signature: async (device_serial_id: str, payload: dict, task_id: int) -> bool
                "post_process": my_post_process_fn,
            }
        }

    Returns:
        Tool definitions dict, empty dict if the file is absent or has no ``TOOLS``.
    """
    tools_path = app_dir / "tools.py"
    if not tools_path.exists():
        return {}

    try:
        module_name = f"apps.{app_dir.name}.tools"
        module = _load_module_from_path(module_name, tools_path)
        tools = getattr(module, "TOOLS", {})
        if not isinstance(tools, dict):
            logger.warning(f"TOOLS in {tools_path} is not a dict, ignoring")
            return {}
        logger.debug(f"Loaded {len(tools)} tool(s) from {tools_path}")
        return tools
    except Exception as e:
        logger.warning(f"Failed to load tools from {tools_path}: {e}")
        return {}


def load_app_skill_guides(app_dir: Path) -> str:
    """Load skill guide markdown files from ``<app_dir>/skills/``.

    Each ``*.md`` file in the ``skills/`` subdirectory documents a multi-step
    workflow (skill) that the Manager can use for planning.  All files are
    concatenated into a single string separated by blank lines, ready to be
    injected into the Manager's system prompt.

    Files are sorted alphabetically so the order is deterministic.

    Args:
        app_dir: Path to the app directory (e.g. ``apps/tiktok``).

    Returns:
        Combined skill guide text, or empty string if no ``skills/`` directory
        or no ``.md`` files are found.
    """
    skills_dir = app_dir / "skills"
    if not skills_dir.exists() or not skills_dir.is_dir():
        return ""

    md_files = sorted(skills_dir.glob("*.md"))
    if not md_files:
        return ""

    parts: list[str] = []
    for md_path in md_files:
        try:
            content = md_path.read_text(encoding="utf-8").strip()
            if content:
                parts.append(content)
        except Exception as e:
            logger.warning(f"Failed to read skill guide {md_path}: {e}")

    if not parts:
        return ""

    combined = "\n\n---\n\n".join(parts)
    logger.info(
        f"📖 Loaded {len(parts)} skill guide(s) from {skills_dir} "
        f"({len(combined)} chars)",
        extra={"color": "green"},
    )
    return combined


def load_app_bundle(
    app_name: Optional[str] = None,
    package_name: Optional[str] = None,
    apps_dir: Optional[str] = None,
) -> Tuple[Dict[str, Any], str, Dict[str, Any]]:
    """High-level helper: discover app directory and load tools + skill guides + metadata.

    Args:
        app_name: App directory name (e.g. ``"tiktok"``).
        package_name: Package name for directory lookup (e.g. ``"com.zhiliaoapp.musically"``).
        apps_dir: Root apps directory path.

    Returns:
        ``(tools, skill_guides, metadata)`` where:
        - ``tools`` is a dict of custom tool definitions (may be empty)
        - ``skill_guides`` is a single string containing all markdown skill files
          concatenated (may be empty)
        - ``metadata`` is the parsed ``metadata.yaml`` dict (may be empty)
    """
    app_dir = discover_app_dir(
        app_name=app_name,
        package_name=package_name,
        apps_dir=apps_dir,
    )

    if app_dir is None:
        return {}, "", {}

    tools = load_app_tools(app_dir)
    skill_guides = load_app_skill_guides(app_dir)
    metadata = _load_metadata(app_dir)

    logger.info(
        f"📦 Loaded app bundle from '{app_dir.name}': "
        f"{len(tools)} tool(s), "
        f"{'skill guides loaded' if skill_guides else 'no skill guides'}",
        extra={"color": "green"},
    )
    return tools, skill_guides, metadata
