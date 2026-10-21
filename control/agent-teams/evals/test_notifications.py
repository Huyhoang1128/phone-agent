"""
Unit tests for the scheduler notification hook.

Run with:
    pytest evals/test_notifications.py -v
"""

import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _make_run_output(session_id=None, content="Task completed"):
    """Return a minimal RunOutput-like mock."""
    run_output = MagicMock()
    run_output.content = content
    run_output.session_id = session_id
    return run_output


class TestSendSchedulerNotificationDeeplink(unittest.IsolatedAsyncioTestCase):
    """Tests that send_scheduler_notification includes the correct deeplink."""

    async def _call_hook(self, run_output, metadata=None, user_id="42"):
        """Import and invoke the hook with the given arguments."""
        from agents.hooks.notifications import send_scheduler_notification

        with (
            patch.dict(
                os.environ,
                {
                    "BACKEND_API_URL": "https://example.com",
                    "SERVER_API_KEY": "test-key",
                },
            ),
            patch("httpx.AsyncClient") as mock_client_cls,
        ):
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.raise_for_status = MagicMock()

            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client_cls.return_value = mock_client

            await send_scheduler_notification.__wrapped__(
                run_output=run_output,
                metadata=metadata or {"source": "scheduler"},
                user_id=user_id,
            )

            return mock_client.post

    async def test_deeplink_included_when_session_id_present(self):
        """Notification payload should contain deeplink when session_id exists."""
        run_output = _make_run_output(session_id="abc-123")
        post_mock = await self._call_hook(run_output)

        post_mock.assert_called_once()
        _, kwargs = post_mock.call_args
        payload = kwargs["json"]
        self.assertIn("url", payload)
        self.assertEqual(payload["url"], "deeplove://chat/session/abc-123")

    async def test_deeplink_none_when_session_id_absent(self):
        """Notification payload deeplink should be None when session_id is absent."""
        run_output = _make_run_output(session_id=None)
        post_mock = await self._call_hook(run_output)

        post_mock.assert_called_once()
        _, kwargs = post_mock.call_args
        payload = kwargs["json"]
        self.assertIn("url", payload)
        self.assertIsNone(payload["url"])

    async def test_deeplink_format_uses_deeplove_scheme(self):
        """Deeplink must use the deeplove:// scheme and chat/session path."""
        session_id = "session-xyz-789"
        run_output = _make_run_output(session_id=session_id)
        post_mock = await self._call_hook(run_output)

        _, kwargs = post_mock.call_args
        deeplink = kwargs["json"]["url"]
        self.assertTrue(
            deeplink.startswith("deeplove://chat/session/"),
            f"Expected deeplink to start with 'deeplove://chat/session/', got: {deeplink}",
        )
        self.assertIn(session_id, deeplink)

    async def test_non_scheduler_source_skips_notification(self):
        """Hook should not send a notification for non-scheduler sources."""
        run_output = _make_run_output(session_id="abc-123")
        post_mock = await self._call_hook(
            run_output, metadata={"source": "user"}
        )
        post_mock.assert_not_called()

    async def test_empty_content_uses_default_message(self):
        """Payload message must not be empty; a default must be used when content is absent."""
        run_output = _make_run_output(session_id=None, content="")
        post_mock = await self._call_hook(run_output)

        post_mock.assert_called_once()
        _, kwargs = post_mock.call_args
        payload = kwargs["json"]
        self.assertIn("message", payload)
        self.assertTrue(
            payload["message"],
            "message field must not be empty when run_output.content is empty",
        )

    async def test_none_content_uses_default_message(self):
        """Payload message must not be empty; a default must be used when content is None."""
        run_output = _make_run_output(session_id=None, content=None)
        post_mock = await self._call_hook(run_output)

        post_mock.assert_called_once()
        _, kwargs = post_mock.call_args
        payload = kwargs["json"]
        self.assertIn("message", payload)
        self.assertTrue(
            payload["message"],
            "message field must not be empty when run_output.content is None",
        )


if __name__ == "__main__":
    unittest.main()
