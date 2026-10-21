import asyncio
from unittest.mock import patch, AsyncMock
from django.test import SimpleTestCase
from django.conf import settings
from stream.consumers import _forward_to_n8n

class TikTokNotificationForwardingTests(SimpleTestCase):
    @patch('httpx.AsyncClient.get')
    @patch('httpx.AsyncClient.post')
    async def test_does_not_forward_if_webhook_url_not_configured(self, mock_post, mock_get):
        with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_URL', ''):
            await _forward_to_n8n(
                device_obj=None,
                identifier='test-device',
                package='com.ss.android.ugc.trill',
                title='Sender Name',
                text='Message Content',
                post_time=123456789
            )
        mock_get.assert_not_called()
        mock_post.assert_not_called()

    @patch('httpx.AsyncClient.get')
    @patch('httpx.AsyncClient.post')
    async def test_does_not_forward_for_non_tiktok_packages(self, mock_post, mock_get):
        with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_URL', 'https://example.com/webhook'):
            await _forward_to_n8n(
                device_obj=None,
                identifier='test-device',
                package='com.facebook.orca',
                title='Sender Name',
                text='Message Content',
                post_time=123456789
            )
        mock_get.assert_not_called()
        mock_post.assert_not_called()

    @patch('httpx.AsyncClient.get')
    async def test_forwards_tiktok_notification_via_get_by_default(self, mock_get):
        # Mock successful response
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        webhook_url = 'https://example.com/webhook'
        with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_URL', webhook_url):
            with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_METHOD', 'GET'):
                await _forward_to_n8n(
                    device_obj=None,
                    identifier='test-device',
                    package='com.ss.android.ugc.trill',
                    title='Ái Nhiên',
                    text='Chào bạn',
                    post_time=123456789
                )

        mock_get.assert_called_once()
        called_url, called_kwargs = mock_get.call_args
        self.assertEqual(called_url[0], webhook_url)
        params = called_kwargs['params']
        self.assertEqual(params['package'], 'com.ss.android.ugc.trill')
        self.assertEqual(params['sender'], 'Ái Nhiên')
        self.assertEqual(params['message'], 'Chào bạn')
        self.assertEqual(params['post_time'], 123456789)

    @patch('httpx.AsyncClient.post')
    async def test_forwards_tiktok_notification_via_post_when_configured(self, mock_post):
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        webhook_url = 'https://example.com/webhook'
        with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_URL', webhook_url):
            with patch.object(settings, 'N8N_TIKTOK_CHAT_WEBHOOK_METHOD', 'POST'):
                await _forward_to_n8n(
                    device_obj=None,
                    identifier='test-device',
                    package='com.zhiliaoapp.musically',
                    title='John',
                    text='Hello',
                    post_time=987654321
                )

        mock_post.assert_called_once()
        called_url, called_kwargs = mock_post.call_args
        self.assertEqual(called_url[0], webhook_url)
        json_data = called_kwargs['json']
        self.assertEqual(json_data['package'], 'com.zhiliaoapp.musically')
        self.assertEqual(json_data['sender'], 'John')
        self.assertEqual(json_data['message'], 'Hello')
        self.assertEqual(json_data['post_time'], 987654321)
