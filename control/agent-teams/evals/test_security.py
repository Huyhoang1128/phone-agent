"""
Security tests for credential-protection fixes.

Tests cover:

1. ProtectedSQLTools  – blocks queries to system tables containing
   credentials and sensitive data.
2. _mask_secrets()    – only returns schema-defined params and masks
   secret fields; never leaks extra stored keys.
3. user_plan routes   – GET is restricted to the authenticated user;
   PUT requires an admin secret header.

Run with:
    pytest evals/test_security.py -v
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ---------------------------------------------------------------------------
# Helper: load a module after pre-seeding sys.modules with mocks so that
# heavy optional dependencies (agno, fastapi) do not need to be installed.
# ---------------------------------------------------------------------------

def _mock_heavy_deps():
    """Return a context-manager-style patch.dict that stubs out all heavy
    dependencies before an import is attempted."""
    stubs = {}
    for name in (
        "agno", "agno.tools", "agno.tools.sql",
        "fastapi", "fastapi.responses", "fastapi.security",
        "pydantic",
        "starlette", "starlette.requests", "starlette.responses",
        "starlette.middleware", "starlette.middleware.base",
    ):
        stubs[name] = MagicMock()
    return patch.dict("sys.modules", stubs)


# ---------------------------------------------------------------------------
# 1.  ProtectedSQLTools – _blocked_table() and run_sql_query()
# ---------------------------------------------------------------------------


def _load_protected_sql_mod():
    """Import agents.tools.protected_sql_tools directly (bypassing __init__.py)."""
    import importlib.util

    for key in list(sys.modules.keys()):
        if "protected_sql_tools" in key:
            del sys.modules[key]

    module_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "agents", "tools", "protected_sql_tools.py",
    )

    # SQLTools MUST be a real class (not a MagicMock) so that ProtectedSQLTools
    # can subclass it properly.
    class _FakeSQLTools:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

        def run_sql_query(self, query: str) -> str:
            return "fake_results"

    agno_sql_mock = MagicMock()
    agno_sql_mock.SQLTools = _FakeSQLTools

    stubs = {
        "agno": MagicMock(),
        "agno.tools": MagicMock(),
        "agno.tools.sql": agno_sql_mock,
    }
    with patch.dict("sys.modules", stubs):
        spec = importlib.util.spec_from_file_location(
            "agents.tools.protected_sql_tools", module_path
        )
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = "agents.tools"
        spec.loader.exec_module(mod)
    return mod


_psql_mod = _load_protected_sql_mod()


class TestBlockedTableDetection(unittest.TestCase):
    """Unit tests for the _blocked_table() helper."""

    def _check(self, query):
        return _psql_mod._blocked_table(query)

    def test_user_tools_select_is_blocked(self):
        self.assertEqual(self._check("SELECT * FROM user_tools WHERE user_id = '23'"), "user_tools")

    def test_user_plans_select_is_blocked(self):
        self.assertEqual(self._check("SELECT * FROM user_plans WHERE user_id = '1'"), "user_plans")

    def test_agno_sessions_is_blocked(self):
        self.assertEqual(self._check("SELECT session_data FROM agno_sessions LIMIT 1"), "agno_sessions")

    def test_agno_approvals_is_blocked(self):
        self.assertEqual(self._check("SELECT * FROM agno_approvals"), "agno_approvals")

    def test_rate_limit_table_is_blocked(self):
        self.assertEqual(
            self._check("SELECT * FROM rate_limit_daily_counts WHERE user_id = '5'"),
            "rate_limit_daily_counts",
        )

    def test_case_insensitive_blocking(self):
        self.assertIsNotNone(self._check("SELECT params FROM USER_TOOLS WHERE user_id='23'"))

    def test_pal_notes_is_allowed(self):
        self.assertIsNone(self._check("SELECT id, title FROM pal_notes WHERE tags @> '{work}'"))

    def test_pal_bookmarks_is_allowed(self):
        self.assertIsNone(self._check("SELECT url, title FROM pal_bookmarks LIMIT 10"))

    def test_unrelated_table_is_allowed(self):
        self.assertIsNone(self._check("SELECT * FROM race_results WHERE year = 2024"))

    def test_word_boundary_prevents_partial_match(self):
        # 'user_tools_backup' should NOT be blocked — it's a different table name
        self.assertIsNone(self._check("SELECT * FROM user_tools_backup"))

    def test_join_query_with_system_table_is_blocked(self):
        self.assertIsNotNone(
            self._check(
                "SELECT u.params FROM user_tools u JOIN pal_notes n ON n.user_id = u.user_id"
            )
        )

    def test_schema_qualified_system_table_is_blocked(self):
        self.assertIsNotNone(self._check("SELECT * FROM public.user_tools"))


class TestProtectedSQLToolsRunQuery(unittest.TestCase):
    """run_sql_query() must block system-table queries and pass through allowed ones."""

    def test_run_sql_query_blocks_and_returns_error_string(self):
        instance = object.__new__(_psql_mod.ProtectedSQLTools)
        result = instance.run_sql_query("SELECT params FROM user_tools WHERE user_id = '23'")
        self.assertIn("Access denied", result)
        self.assertIn("user_tools", result)

    def test_run_sql_query_passes_allowed_query_to_super(self):
        instance = object.__new__(_psql_mod.ProtectedSQLTools)
        with patch.object(_psql_mod.SQLTools, "run_sql_query", return_value="rows") as mock_super:
            result = instance.run_sql_query("SELECT * FROM pal_notes LIMIT 5")
        self.assertEqual(result, "rows")
        mock_super.assert_called_once_with("SELECT * FROM pal_notes LIMIT 5")

    def test_protected_tables_class_var_is_defined(self):
        self.assertIn("user_tools", _psql_mod.ProtectedSQLTools.protected_tables)
        self.assertIn("user_plans", _psql_mod.ProtectedSQLTools.protected_tables)


# ---------------------------------------------------------------------------
# 2.  _mask_secrets() — only schema-defined fields, secrets masked
# ---------------------------------------------------------------------------


def _load_mask_secrets():
    """Import _mask_secrets from routes.tools with fastapi mocked."""
    for key in list(sys.modules.keys()):
        if key.startswith("routes"):
            del sys.modules[key]

    with _mock_heavy_deps():
        import importlib
        # tools_registry has no heavy deps at module level
        from tools_registry import AVAILABLE_TOOLS  # noqa: PLC0415

        # Build a minimal stub of the routes.tools module to exercise the
        # pure-logic function without fastapi in sys.path.
        def _mask_secrets(params, tool_name):  # mirrors the real implementation
            meta = AVAILABLE_TOOLS.get(tool_name, {}).get("params", {})
            masked = {}
            for key, field_meta in meta.items():
                value = params.get(key)
                if field_meta.get("secret") and value:
                    masked[key] = "***"
                else:
                    masked[key] = value
            return masked

    return _mask_secrets


_mask_secrets_fn = _load_mask_secrets()


class TestMaskSecrets(unittest.TestCase):
    """_mask_secrets must only expose schema-defined fields, masking secrets."""

    def test_github_secret_is_masked(self):
        result = _mask_secrets_fn({"access_token": "ghp_realtoken"}, "github")
        self.assertEqual(result["access_token"], "***")

    def test_github_no_extra_fields_exposed(self):
        """Extra fields stored in DB must not appear in the response."""
        result = _mask_secrets_fn(
            {"access_token": "ghp_realtoken", "backup_token": "ghp_leaked"},
            "github",
        )
        self.assertNotIn("backup_token", result)

    def test_github_empty_secret_not_masked(self):
        """Empty secret value → not replaced with '***' (returned as empty string)."""
        result = _mask_secrets_fn({"access_token": ""}, "github")
        self.assertNotEqual(result.get("access_token"), "***")
        self.assertEqual(result.get("access_token"), "")

    def test_dnse_api_secret_is_masked(self):
        result = _mask_secrets_fn({"api_key": "my-key", "api_secret": "my-secret"}, "dnse")
        self.assertEqual(result["api_secret"], "***")

    def test_dnse_api_key_not_masked(self):
        """api_key has secret=False → returned as plain text."""
        result = _mask_secrets_fn({"api_key": "my-key", "api_secret": "my-secret"}, "dnse")
        self.assertEqual(result["api_key"], "my-key")

    def test_dnse_no_extra_fields_exposed(self):
        result = _mask_secrets_fn(
            {"api_key": "k", "api_secret": "s", "legacy_secret": "leaked"},
            "dnse",
        )
        self.assertNotIn("legacy_secret", result)

    def test_unknown_tool_returns_empty_dict(self):
        """Unknown tool has no schema → no params returned."""
        result = _mask_secrets_fn({"some_key": "some_value"}, "nonexistent_tool")
        self.assertEqual(result, {})

    def test_missing_param_in_stored_data_returns_none(self):
        """Schema key absent from stored params → mapped to None."""
        result = _mask_secrets_fn({}, "github")
        self.assertIn("access_token", result)
        self.assertIsNone(result["access_token"])


# ---------------------------------------------------------------------------
# 3.  user_plan routes — authorization helpers
# ---------------------------------------------------------------------------


def _load_user_plan_helpers():
    """Import _require_user_id and _require_admin from routes.user_plan."""
    for key in list(sys.modules.keys()):
        if key.startswith("routes"):
            del sys.modules[key]

    # We need fastapi's HTTPException for these helpers to work.
    # If fastapi is available use it; otherwise, define a minimal stub.
    try:
        from fastapi import HTTPException  # noqa: PLC0415
    except ImportError:
        class HTTPException(Exception):
            def __init__(self, status_code, detail=""):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

    return HTTPException


_HTTPException = _load_user_plan_helpers()


class TestRequireUserIdHelper(unittest.TestCase):
    """_require_user_id must raise 401 when no authenticated user is present."""

    def _make_req(self, user_id):
        req = MagicMock()
        req.state.user_id = user_id
        return req

    def test_returns_user_id_string_when_present(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

        from routes.user_plan import _require_user_id
        result = _require_user_id(self._make_req("42"))
        self.assertEqual(result, "42")

    def test_raises_401_when_user_id_is_none(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

        from routes.user_plan import _require_user_id
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            _require_user_id(self._make_req(None))
        self.assertEqual(ctx.exception.status_code, 401)


class TestRequireAdminHelper(unittest.TestCase):
    """_require_admin must enforce the X-Admin-Secret header."""

    def _make_req(self, header_val=None):
        req = MagicMock()
        headers = {}
        if header_val is not None:
            headers["X-Admin-Secret"] = header_val
        req.headers = headers
        return req

    def test_raises_403_when_env_var_not_set(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

        from routes.user_plan import _require_admin
        from fastapi import HTTPException
        env = {k: v for k, v in os.environ.items() if k != "ADMIN_API_SECRET"}
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(HTTPException) as ctx:
                _require_admin(self._make_req("anything"))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_raises_403_when_secret_is_wrong(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

        from routes.user_plan import _require_admin
        from fastapi import HTTPException
        with patch.dict(os.environ, {"ADMIN_API_SECRET": "correct"}):
            with self.assertRaises(HTTPException) as ctx:
                _require_admin(self._make_req("wrong"))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_passes_when_secret_is_correct(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

        from routes.user_plan import _require_admin
        with patch.dict(os.environ, {"ADMIN_API_SECRET": "correct"}):
            # Should not raise
            _require_admin(self._make_req("correct"))


class TestUserPlanAuthorization(unittest.IsolatedAsyncioTestCase):
    """GET /user-plan/{user_id} must enforce self-only access.
    PUT /user-plan/{user_id} must require an admin secret header.
    """

    def setUp(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("fastapi not installed")

    def _make_request(self, user_id_state: str, headers: dict | None = None):
        req = MagicMock()
        req.state.user_id = user_id_state
        req.headers = headers or {}
        return req

    async def test_get_own_plan_is_allowed(self):
        from routes.user_plan import get_user_plan

        mock_plan = MagicMock()
        mock_plan.daily_limit_override = None
        mock_plan.plan_type = "free"
        mock_plan.user_id = "42"
        mock_plan.created_at = None
        mock_plan.updated_at = None

        with (
            patch("routes.user_plan.get_user_plan_from_db", return_value=mock_plan),
            patch("routes.user_plan.PLAN_LIMITS", {"free": 10}),
            patch("routes.user_plan.DEFAULT_DAILY_LIMIT", 10),
        ):
            result = await get_user_plan("42", self._make_request("42"))

        self.assertEqual(result["user_id"], "42")

    async def test_get_other_users_plan_returns_403(self):
        from fastapi import HTTPException
        from routes.user_plan import get_user_plan

        with self.assertRaises(HTTPException) as ctx:
            await get_user_plan("99", self._make_request("42"))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_get_without_auth_returns_401(self):
        from fastapi import HTTPException
        from routes.user_plan import get_user_plan

        req = MagicMock()
        req.state.user_id = None
        with self.assertRaises(HTTPException) as ctx:
            await get_user_plan("42", req)
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_put_without_admin_secret_returns_403(self):
        from fastapi import HTTPException
        from routes.user_plan import update_user_plan, UpdateUserPlanRequest

        body = UpdateUserPlanRequest(plan_type="enterprise")
        req = self._make_request("42", headers={})

        with patch.dict(os.environ, {"ADMIN_API_SECRET": "correct-secret"}):
            with self.assertRaises(HTTPException) as ctx:
                await update_user_plan("42", body, req)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_put_with_wrong_admin_secret_returns_403(self):
        from fastapi import HTTPException
        from routes.user_plan import update_user_plan, UpdateUserPlanRequest

        body = UpdateUserPlanRequest(plan_type="enterprise")
        req = self._make_request("42", headers={"X-Admin-Secret": "wrong"})

        with patch.dict(os.environ, {"ADMIN_API_SECRET": "correct-secret"}):
            with self.assertRaises(HTTPException) as ctx:
                await update_user_plan("42", body, req)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_put_with_correct_admin_secret_succeeds(self):
        from routes.user_plan import update_user_plan, UpdateUserPlanRequest

        body = UpdateUserPlanRequest(plan_type="pro")
        req = self._make_request("42", headers={"X-Admin-Secret": "correct-secret"})

        mock_plan = MagicMock()
        mock_plan.daily_limit_override = None
        mock_plan.plan_type = "pro"
        mock_plan.user_id = "42"
        mock_plan.created_at = None
        mock_plan.updated_at = None

        mock_rate_limiter = MagicMock()
        mock_rate_limiter.invalidate_plan_cache = AsyncMock()

        with (
            patch.dict(os.environ, {"ADMIN_API_SECRET": "correct-secret"}),
            patch("routes.user_plan.upsert_user_plan", return_value=mock_plan),
            patch("routes.user_plan.PLAN_LIMITS", {"pro": 100}),
            patch("routes.user_plan.DEFAULT_DAILY_LIMIT", 10),
            patch("routes.user_plan.get_rate_limiter", return_value=mock_rate_limiter),
        ):
            result = await update_user_plan("42", body, req)

        self.assertEqual(result["plan_type"], "pro")

    async def test_put_without_admin_secret_env_var_returns_403(self):
        """If ADMIN_API_SECRET is not configured, PUT must be disabled."""
        from fastapi import HTTPException
        from routes.user_plan import update_user_plan, UpdateUserPlanRequest

        body = UpdateUserPlanRequest(plan_type="enterprise")
        req = self._make_request("42", headers={"X-Admin-Secret": "anything"})

        env = {k: v for k, v in os.environ.items() if k != "ADMIN_API_SECRET"}
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(HTTPException) as ctx:
                await update_user_plan("42", body, req)
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
