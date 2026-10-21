import json
from unittest.mock import patch, MagicMock, AsyncMock
from asgiref.sync import async_to_sync
import time
from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.test import APITestCase
from .models import ContentScenario, ContentScenarioShot, ContentScenarioChatMessage, AuditAction, ChatSender

class ScenarioChatGatewayTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='director', password='password123')
        self.client.force_authenticate(user=self.user)
        
        # Create a content scenario
        self.scenario = ContentScenario.objects.create(
            owner=self.user,
            title="Kịch bản Test Seeding",
            brief="Giới thiệu sản phẩm mới",
            duration_target_seconds=30,
            shot_count_target=3,
        )
        
        # Create a shot
        self.shot = ContentScenarioShot.objects.create(
            scenario=self.scenario,
            shot_id=1,
            shot_order=1,
            kinetic_action="Đứng yên",
            voice_over="Xin chào",
        )

    @patch('httpx.AsyncClient.send', new_callable=AsyncMock)
    def test_script_chat_stream_proxies_to_fastapi_and_saves_db(self, mock_send):
        # v4.1 — proxy đã chuyển sang httpx async + StreamingHttpResponse async.
        # Mock httpx.AsyncClient.send → fake response phát SSE lines (str, như aiter_lines thật).
        events_str = [
            'event: thinking',
            'data: {"thinking_process": "Đạo diễn đang suy nghĩ..."}',
            '',
            'event: creative_directing',
            'data: {"tool": "direct_character_acting", "shot_id": 1, "patch": {"kinetic_action": "Mỉm cười nhẹ"}}',
            '',
            'event: final',
            'data: {"assistant": "Tôi đã chỉnh sửa hành động của nhân vật ở shot 1.", "llm_model": "gpt-4o-mini"}',
            '',
            'event: done',
            'data: {}',
            ''
        ]

        async def _aiter_lines():
            for line in events_str:
                yield line

        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.aiter_lines = _aiter_lines  # gọi → trả async generator
        fake_resp.aclose = AsyncMock()
        mock_send.return_value = fake_resp

        # Call the endpoint (sync DRF client; view trả StreamingHttpResponse async)
        response = self.client.post(
            f'/api/content-scenarios/{self.scenario.id}/script-chat-stream/',
            {'body': 'Sửa shot 1 diễn xuất'},
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response['Content-Type'], 'text/event-stream')

        # Drain content async. async_to_sync khiến sync_to_async(thread_sensitive) bên trong
        # view chạy trên CHÍNH thread test → cùng DB connection/transaction → assert DB chuẩn.
        async def _drain(resp):
            parts = []
            async for chunk in resp:
                parts.append(chunk if isinstance(chunk, bytes) else str(chunk).encode('utf-8'))
            return b"".join(parts)

        content_bytes = async_to_sync(_drain)(response)
        self.assertIn('creative_directing'.encode('utf-8'), content_bytes)
        self.assertIn('final'.encode('utf-8'), content_bytes)

        # Verify database records created
        user_msg = ContentScenarioChatMessage.objects.filter(scenario=self.scenario, sender=ChatSender.USER).first()
        self.assertIsNotNone(user_msg)
        self.assertEqual(user_msg.body, 'Sửa shot 1 diễn xuất')

        asst_msg = ContentScenarioChatMessage.objects.filter(scenario=self.scenario, sender=ChatSender.ASSISTANT).first()
        self.assertIsNotNone(asst_msg)
        self.assertEqual(asst_msg.body, "Tôi đã chỉnh sửa hành động của nhân vật ở shot 1.")
        self.assertEqual(len(asst_msg.attached_patches), 1)
        self.assertEqual(asst_msg.attached_patches[0]['shot_id'], 1)
        self.assertEqual(asst_msg.attached_patches[0]['after']['kinetic_action'], "Mỉm cười nhẹ")

        # T17 (R5) — patch chỉ là ĐỀ XUẤT chờ Duyệt → KHÔNG ghi audit ở propose-time.
        # Audit/lịch sử shot CHỈ ghi lúc APPLY thật (update-shot / plan-execute).
        self.assertFalse(
            self.scenario.audits.filter(action=AuditAction.REFINE_SHOT).exists(),
            'Patch đề xuất không được ghi audit trước khi user Duyệt',
        )

    @patch('requests.post')
    def test_script_chat_sync_proxies_to_fastapi_and_saves_db(self, mock_post):
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        events_str = [
            'event: final',
            'data: {"assistant": "Tư vấn cho kịch bản.", "llm_model": "gpt-4o-mini"}',
            '',
            'event: done',
            'data: {}',
            ''
        ]
        events = [e.encode('utf-8') for e in events_str]
        mock_response.iter_lines.return_value = events
        mock_post.return_value = mock_response

        response = self.client.post(
            f'/api/content-scenarios/{self.scenario.id}/script-chat/',
            {'body': 'Bạn có gợi ý gì không?'},
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIn('assistant_message', response.data)
        self.assertEqual(response.data['assistant_message']['body'], "Tư vấn cho kịch bản.")
