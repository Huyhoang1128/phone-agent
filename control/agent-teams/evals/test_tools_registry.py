"""
Unit tests for tools_registry helpers.

Run with:
    pytest evals/test_tools_registry.py -v
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestValidateToolParams(unittest.TestCase):
    """Tests for validate_tool_params."""

    def setUp(self):
        from tools_registry import validate_tool_params
        self.validate = validate_tool_params

    def test_valid_params_do_not_raise(self):
        self.validate("github", {"access_token": "ghp_abc123"})

    def test_missing_required_param_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate("github", {})
        self.assertIn("access_token", str(ctx.exception))
        self.assertIn("github", str(ctx.exception))

    def test_missing_required_param_message_lists_key(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate("github", {"unrelated_key": "value"})
        self.assertIn("access_token", str(ctx.exception))

    def test_unknown_tool_does_not_raise(self):
        # Unknown tools have no schema → nothing required → no error
        self.validate("nonexistent_tool", {})

    def test_none_value_treated_as_missing(self):
        with self.assertRaises(ValueError):
            self.validate("github", {"access_token": None})

    def test_empty_string_treated_as_missing(self):
        with self.assertRaises(ValueError):
            self.validate("github", {"access_token": ""})


class TestCreateGithubToolsKeyNormalization(unittest.TestCase):
    """Tests for _create_github_tools accepting both key formats."""

    def _call_with_mock_import(self, params):
        """Call _create_github_tools with a mocked agno.tools.github module."""
        mock_github_module = MagicMock()
        mock_tool_instance = MagicMock()
        mock_github_module.GithubTools.return_value = mock_tool_instance
        with patch.dict("sys.modules", {"agno.tools.github": mock_github_module}):
            from tools_registry import _create_github_tools
            result = _create_github_tools(params)
        return result, mock_github_module

    def test_canonical_key_access_token(self):
        result, mock_mod = self._call_with_mock_import({"access_token": "ghp_abc"})
        self.assertIsNotNone(result)
        mock_mod.GithubTools.assert_called_once_with(access_token="ghp_abc")

    def test_legacy_key_github_access_token(self):
        result, mock_mod = self._call_with_mock_import({"GITHUB_ACCESS_TOKEN": "ghp_xyz"})
        self.assertIsNotNone(result)
        mock_mod.GithubTools.assert_called_once_with(access_token="ghp_xyz")

    def test_canonical_key_takes_precedence_over_legacy(self):
        """When both keys are present, access_token wins."""
        result, mock_mod = self._call_with_mock_import(
            {"access_token": "ghp_primary", "GITHUB_ACCESS_TOKEN": "ghp_secondary"}
        )
        self.assertIsNotNone(result)
        mock_mod.GithubTools.assert_called_once_with(access_token="ghp_primary")

    def test_empty_params_returns_none(self):
        from tools_registry import _create_github_tools
        result = _create_github_tools({})
        self.assertIsNone(result)


class TestBuildUserToolsPerUser(unittest.TestCase):
    """build_user_tools must create independent tool instances per user."""

    def test_different_users_get_independent_tools(self):
        from tools_registry import build_user_tools

        user1_row = MagicMock()
        user1_row.enabled = True
        user1_row.tool_name = "github"
        user1_row.params = {"access_token": "ghp_user1"}

        user2_row = MagicMock()
        user2_row.enabled = True
        user2_row.tool_name = "github"
        user2_row.params = {"access_token": "ghp_user2"}

        mock_tool_1 = MagicMock()
        mock_tool_2 = MagicMock()

        def _fake_list_user_tools(user_id):
            return [user1_row] if user_id == "u1" else [user2_row]

        def _fake_create(tool_name, params):
            if params.get("access_token") == "ghp_user1":
                return mock_tool_1
            return mock_tool_2

        mock_models = MagicMock()
        mock_models.list_user_tools.side_effect = _fake_list_user_tools

        with (
            patch.dict("sys.modules", {"models": mock_models}),
            patch("tools_registry.create_tool_instance", side_effect=_fake_create),
        ):
            tools_u1 = build_user_tools("u1")
            tools_u2 = build_user_tools("u2")

        self.assertEqual(tools_u1, [mock_tool_1])
        self.assertEqual(tools_u2, [mock_tool_2])
        self.assertIsNot(tools_u1[0], tools_u2[0])

    def test_disabled_tool_not_included(self):
        from tools_registry import build_user_tools

        disabled_row = MagicMock()
        disabled_row.enabled = False
        disabled_row.tool_name = "github"
        disabled_row.params = {"access_token": "ghp_disabled"}

        mock_models = MagicMock()
        mock_models.list_user_tools.return_value = [disabled_row]

        with patch.dict("sys.modules", {"models": mock_models}):
            tools = build_user_tools("u99")

        self.assertEqual(tools, [])


class TestValidateDnseToolParams(unittest.TestCase):
    """Tests for validate_tool_params with the dnse tool."""

    def setUp(self):
        from tools_registry import validate_tool_params
        self.validate = validate_tool_params

    def test_valid_params_do_not_raise(self):
        self.validate("dnse", {"api_key": "my-key", "api_secret": "my-secret"})

    def test_missing_api_key_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate("dnse", {"api_secret": "my-secret"})
        self.assertIn("api_key", str(ctx.exception))

    def test_missing_api_secret_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate("dnse", {"api_key": "my-key"})
        self.assertIn("api_secret", str(ctx.exception))

    def test_empty_params_raises_with_both_keys(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate("dnse", {})
        msg = str(ctx.exception)
        self.assertIn("api_key", msg)
        self.assertIn("api_secret", msg)


class TestCreateDnseTools(unittest.TestCase):
    """Tests for _create_dnse_tools key validation and instantiation."""

    def _call_with_mock(self, params):
        mock_dnse_module = MagicMock()
        mock_instance = MagicMock()
        mock_dnse_module.DnseTools.return_value = mock_instance
        with patch.dict(
            "sys.modules",
            {"agents.tools.dnse_tools": mock_dnse_module},
        ):
            from tools_registry import _create_dnse_tools
            result = _create_dnse_tools(params)
        return result, mock_dnse_module

    def test_valid_params_creates_instance(self):
        result, mock_mod = self._call_with_mock(
            {"api_key": "key123", "api_secret": "secret456"}
        )
        self.assertIsNotNone(result)
        mock_mod.DnseTools.assert_called_once_with(
            api_key="key123", api_secret="secret456"
        )

    def test_missing_api_key_returns_none(self):
        from tools_registry import _create_dnse_tools
        result = _create_dnse_tools({"api_secret": "secret456"})
        self.assertIsNone(result)

    def test_missing_api_secret_returns_none(self):
        from tools_registry import _create_dnse_tools
        result = _create_dnse_tools({"api_key": "key123"})
        self.assertIsNone(result)

    def test_empty_params_returns_none(self):
        from tools_registry import _create_dnse_tools
        result = _create_dnse_tools({})
        self.assertIsNone(result)


class TestDnseToolsAuthHeaders(unittest.TestCase):
    """Tests for DnseTools authentication header generation."""

    @classmethod
    def _load_dnse_mod(cls, mod_name="dnse_tools_direct"):
        """Load dnse_tools and its common dependency via importlib."""
        import importlib.util
        import sys

        # Load common.py first and register it under the package path
        common_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "agents", "tools", "common.py",
        )
        common_spec = importlib.util.spec_from_file_location("agents.tools.common", common_path)
        common_mod = importlib.util.module_from_spec(common_spec)
        common_spec.loader.exec_module(common_mod)
        sys.modules["agents.tools.common"] = common_mod

        # Load dnse_tools.py with correct package so relative imports resolve
        module_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "agents", "tools", "dnse_tools.py",
        )
        spec = importlib.util.spec_from_file_location(mod_name, module_path)
        dnse_mod = importlib.util.module_from_spec(spec)
        dnse_mod.__package__ = "agents.tools"
        spec.loader.exec_module(dnse_mod)
        return dnse_mod

    def test_auth_headers_contain_required_keys(self):
        import base64
        import hashlib
        import hmac
        from urllib import parse
        from unittest.mock import patch as _patch

        api_key = "key-abc"
        api_secret = "secret-xyz"
        date_value = "Thu, 01 Jan 2026 00:00:00 +0000"
        method = "GET"
        path = "/accounts"

        # Build expected signature using the same scheme as build_signature in common.py
        header_key = "date"
        signature_string = (
            f"(request-target): {method.lower()} {path}\n"
            f"{header_key}: {date_value}"
        )
        mac = hmac.new(
            api_secret.encode("utf-8"),
            signature_string.encode("utf-8"),
            hashlib.sha256,
        )
        encoded = base64.b64encode(mac.digest()).decode("utf-8")
        expected_signature = parse.quote(encoded, safe="")

        dnse_mod = self._load_dnse_mod("dnse_tools_direct_v1")

        class _FakeDatetime:
            @staticmethod
            def now(tz=None):
                class _FakeNow:
                    def strftime(self, fmt):
                        return date_value
                return _FakeNow()

        with _patch.object(dnse_mod, "datetime", _FakeDatetime):
            with _patch.object(dnse_mod, "uuid4", return_value=None):
                instance = dnse_mod.DnseTools.__new__(dnse_mod.DnseTools)
                instance._api_key = api_key
                instance._api_secret = api_secret
                instance._algorithm = "hmac-sha256"
                instance._hmac_nonce_enabled = False
                headers = instance._auth_headers(method, path)

        self.assertIn("Date", headers)
        self.assertEqual(headers["Date"], date_value)
        self.assertIn("X-Signature", headers)
        self.assertIn(f'keyId="{api_key}"', headers["X-Signature"])
        self.assertIn(f'signature="{expected_signature}"', headers["X-Signature"])
        self.assertIn("x-api-key", headers)
        self.assertEqual(headers["x-api-key"], api_key)

    def test_auth_headers_signature_format(self):
        """X-Signature header must follow the Signature scheme format."""
        from unittest.mock import patch as _patch

        api_key = "k1"
        api_secret = "s1"
        date_value = "Thu, 01 Jan 2026 00:00:00 +0000"

        dnse_mod = self._load_dnse_mod("dnse_tools_direct_v2")

        class _FakeDatetime:
            @staticmethod
            def now(tz=None):
                class _FakeNow:
                    def strftime(self, fmt):
                        return date_value
                return _FakeNow()

        with _patch.object(dnse_mod, "datetime", _FakeDatetime):
            with _patch.object(dnse_mod, "uuid4", return_value=None):
                instance = dnse_mod.DnseTools.__new__(dnse_mod.DnseTools)
                instance._api_key = api_key
                instance._api_secret = api_secret
                instance._algorithm = "hmac-sha256"
                instance._hmac_nonce_enabled = False
                headers = instance._auth_headers("POST", "/registration/send-email-otp")

        sig = headers["X-Signature"]
        self.assertTrue(sig.startswith("Signature "), msg=f"X-Signature must start with 'Signature ': {sig}")
        self.assertIn('algorithm="hmac-sha256"', sig)
        self.assertIn('headers="(request-target) date"', sig)
        self.assertIn('keyId="k1"', sig)


if __name__ == "__main__":
    unittest.main()
