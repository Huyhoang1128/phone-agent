from datetime import timedelta, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests as http_requests_lib
from django.contrib.auth.models import User
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from agent_groups.models import AgentGroup, AgentGroupMember
from devices.models import Device
from profiles.models import Profile
from proxies.models import Proxy
from schedule.models import Schedule, ScheduleType
from task.models import Task, TaskStatus
from users.models import UserChatSettings
from webhooks.models import ExternalWebhook

from .models import (
    KeywordList,
    TiktokChannel,
    TiktokChannelVideo,
    TiktokCommentPlan,
    TiktokCommentPlanChatMessage,
    TiktokVideo,
    TiktokVideoInteraction,
    TiktokVideoUserComment,
)
from .views import TiktokVideoViewSet
from .video_understand import poll_pending_channel_video_understand_tasks


class TiktokCommentPlanningApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='owner', password='secret123')
        self.other_user = User.objects.create_user(username='other', password='secret123')
        self.client.force_authenticate(user=self.owner)

        self.video = TiktokVideo.objects.create(
            owner=self.owner,
            video_url='https://tiktok.com/@demo/video/1',
            caption='caption',
            content='content',
            existing_comments=[{'text': 'Nice video'}],
        )
        self.agent_group = AgentGroup.objects.create(name='Owner group', owner=self.owner)
        self.device = Device.objects.create(name='Owner device', owner=self.owner)
        self.profile = Profile.objects.create(name='Owner profile', owner=self.owner, device=self.device)
        AgentGroupMember.objects.create(group=self.agent_group, device=self.device, role='worker')

        self.other_group = AgentGroup.objects.create(name='Other group', owner=self.other_user)

    def _plan_chat_url(self):
        return f'/api/tiktok/{self.video.id}/plan-chat/'

    def _comment_plans_url(self):
        return f'/api/tiktok/{self.video.id}/comment-plans/'

    def _comment_plan_detail_url(self, plan_id):
        return f'/api/tiktok/{self.video.id}/comment-plans/{plan_id}/'

    def _dispatch_comments_url(self):
        return f'/api/tiktok/{self.video.id}/dispatch-comments/'

    def _dispatch_single_comment_url(self):
        return f'/api/tiktok/{self.video.id}/dispatch-single-comment/'

    def _approved_comments_url(self):
        return '/api/tiktok/approved-comments/'

    def _commented_interactions_url(self):
        return '/api/tiktok/commented-interactions/'

    def _fetch_comments_url(self):
        return f'/api/tiktok/{self.video.id}/fetch-comments/'

    @override_settings(OPENAI_API_KEY='test-key')
    @patch('openai.OpenAI')
    def test_full_comment_planning_flow(self, mock_openai):
        choice = SimpleNamespace(message=SimpleNamespace(content='Gợi ý kế hoạch comment'))
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(choices=[choice])
        mock_openai.return_value = mock_client

        chat_payload = {
            'agent_group': self.agent_group.id,
            'content': 'Lên kế hoạch comment cho video này',
            'sender': 'user',
        }
        chat_create = self.client.post(self._plan_chat_url(), chat_payload, format='json')
        self.assertEqual(chat_create.status_code, status.HTTP_201_CREATED)
        self.assertEqual(chat_create.data['sender'], 'user')
        self.assertEqual(chat_create.data['agent_group'], self.agent_group.id)

        chat_list = self.client.get(self._plan_chat_url())
        self.assertEqual(chat_list.status_code, status.HTTP_200_OK)
        self.assertEqual(len(chat_list.data), 2)
        self.assertEqual(chat_list.data[0]['sender'], 'user')
        self.assertEqual(chat_list.data[1]['sender'], 'assistant')

        plan_payload = {
            'agent_group': self.agent_group.id,
            'profile': self.profile.id,
            'device': self.device.id,
            'comment_content': 'Comment đầu tiên',
            'reply_to': 'comment gốc',
            'is_approved': False,
            'is_commented': False,
        }
        plan_create = self.client.post(self._comment_plans_url(), plan_payload, format='json')
        self.assertEqual(plan_create.status_code, status.HTTP_201_CREATED)
        self.assertEqual(plan_create.data['agent_group'], self.agent_group.id)
        self.assertEqual(plan_create.data['profile'], self.profile.id)
        self.assertEqual(plan_create.data['device'], self.device.id)
        self.assertEqual(plan_create.data['video_link'], self.video.video_url)

        plans_list = self.client.get(self._comment_plans_url())
        self.assertEqual(plans_list.status_code, status.HTTP_200_OK)
        self.assertEqual(len(plans_list.data), 1)

        plan_id = plan_create.data['id']
        plan_patch = self.client.patch(
            self._comment_plan_detail_url(plan_id),
            {'is_approved': True, 'is_commented': True},
            format='json',
        )
        self.assertEqual(plan_patch.status_code, status.HTTP_200_OK)
        self.assertTrue(plan_patch.data['is_approved'])
        self.assertTrue(plan_patch.data['is_commented'])

        plan_delete = self.client.delete(self._comment_plan_detail_url(plan_id))
        self.assertEqual(plan_delete.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(TiktokCommentPlan.objects.filter(id=plan_id).exists())

    def test_requires_authentication(self):
        self.client.force_authenticate(user=None)
        response = self.client.get(self._comment_plans_url())
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_comment_plan_detail_returns_404_for_missing_plan(self):
        response = self.client.patch(self._comment_plan_detail_url(999999), {'is_approved': True}, format='json')
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    @override_settings(OPENAI_API_KEY='')
    def test_plan_chat_returns_503_when_openai_key_missing(self):
        response = self.client.post(
            self._plan_chat_url(),
            {'content': 'Test message', 'sender': 'user'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    @override_settings(OPENAI_API_KEY='test-key')
    @patch('openai.OpenAI')
    def test_plan_chat_returns_502_when_openai_call_fails(self, mock_openai):
        mock_openai.side_effect = RuntimeError('boom')
        response = self.client.post(
            self._plan_chat_url(),
            {'content': 'Test message', 'sender': 'user'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)

    @override_settings(OPENAI_API_KEY='test-key')
    def test_plan_chat_returns_400_for_invalid_user_model(self):
        UserChatSettings.objects.create(user=self.owner, llm_model='unsupported-model')
        response = self.client.post(
            self._plan_chat_url(),
            {'content': 'Test message', 'sender': 'user'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Invalid model', response.data['detail'])

    def test_owner_scoping_blocks_other_user_resources(self):
        bad_plan = self.client.post(
            self._comment_plans_url(),
            {
                'agent_group': self.other_group.id,
                'comment_content': 'Comment',
            },
            format='json',
        )
        self.assertEqual(bad_plan.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('agent_group', bad_plan.data)

    @override_settings(OPENAI_API_KEY='test-key')
    def test_owner_scoping_blocks_other_user_chat_group(self):
        bad_chat = self.client.post(
            self._plan_chat_url(),
            {'agent_group': self.other_group.id, 'content': 'test', 'sender': 'user'},
            format='json',
        )
        self.assertEqual(bad_chat.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('agent_group', bad_chat.data)

    def test_video_is_not_accessible_to_other_owner(self):
        self.client.force_authenticate(user=self.other_user)
        response = self.client.get(self._comment_plans_url())
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    @patch('tiktok.views.http_requests.post')
    @patch('tiktok.views.logger')
    def test_dispatch_comments_calls_webhook(self, mock_logger, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {'ok': True}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(response.data['payload']['agent_group'], self.agent_group.id)
        self.assertEqual(response.data['payload']['devices'], [self.device.id])
        self.assertIn('comment_plans', response.data)
        self.assertEqual(mock_logger.info.call_count, 2)
        mock_logger.info.assert_any_call(
            'dispatch_comments: n8n webhook response status=%s body=%s',
            200,
            {'ok': True},
        )
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        self.assertIn('n8n.example.com', call_kwargs[0][0])

    @patch('tiktok.views.http_requests.post')
    def test_fetch_comments_parses_create_time_with_utc_timezone(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = {
            'comments': [
                {
                    'cid': 'comment-1',
                    'user': {'uid': 'user-1', 'nickname': 'nick'},
                    'text': 'hello',
                    'create_time': '1735689600',
                }
            ]
        }
        mock_post.return_value = mock_resp

        response = self.client.post(self._fetch_comments_url(), {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        comment = TiktokVideoUserComment.objects.get(video=self.video, cid='comment-1')
        self.assertTrue(timezone.is_aware(comment.create_time))
        self.assertEqual(comment.create_time.isoformat(), '2025-01-01T00:00:00+00:00')

    @patch('tiktok.views.http_requests.post')
    def test_fetch_comments_retries_with_random_active_proxy(self, mock_post):
        Proxy.objects.create(
            name='active-proxy',
            protocol='socks5',
            host='203.0.113.10',
            port=1305,
            username='demo_proxy_user',
            password='demo_proxy_pass',
            status=Proxy.STATUS_ACTIVE,
            owner=self.owner,
        )
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = {'comments': []}
        mock_post.side_effect = [
            http_requests_lib.exceptions.RequestException('timeout'),
            mock_resp,
        ]

        response = self.client.post(self._fetch_comments_url(), {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(mock_post.call_count, 2)
        first_payload = mock_post.call_args_list[0].kwargs['json']
        second_payload = mock_post.call_args_list[1].kwargs['json']
        self.assertNotIn('proxy', first_payload)
        self.assertEqual(second_payload['proxy'], '203.0.113.10:1305:demo_proxy_user:demo_proxy_pass')

    @patch('tiktok.views.http_requests.post')
    def test_fetch_comments_returns_400_when_upstream_rejects_payload(self, mock_post):
        bad_request_response = MagicMock()
        bad_request_response.status_code = 400
        bad_request_response.json.return_value = {'detail': 'Invalid video URL'}
        bad_request_response.text = '{"detail":"Invalid video URL"}'
        bad_request_response.raise_for_status.side_effect = http_requests_lib.exceptions.HTTPError(
            '400 Client Error',
            response=bad_request_response,
        )
        mock_post.return_value = bad_request_response

        response = self.client.post(self._fetch_comments_url(), {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Upstream detail: Invalid video URL', response.data['detail'])
        self.assertEqual(mock_post.call_count, 1)

    @patch('tiktok.views.http_requests.post')
    def test_fetch_comments_returns_502_when_request_fails_and_no_proxy_available(self, mock_post):
        mock_post.side_effect = http_requests_lib.exceptions.RequestException('timeout')

        response = self.client.post(self._fetch_comments_url(), {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(response.data['detail'], 'Failed to call comment fetching service. Please try again later.')
        self.assertEqual(mock_post.call_count, 1)

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_comments_saves_comment_plans_from_n8n_output(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'output': [
                {str(self.device.id): 'Bình luận đầu tiên'},
                {str(self.device.id): 'Trả lời bình luận 1'},
                {str(self.device.id): 'Trả lời bình luận 2'},
            ]
        }
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        plans = response.data['comment_plans']
        self.assertEqual(len(plans), 3)
        self.assertEqual(plans[0]['comment_content'], 'Bình luận đầu tiên')
        self.assertEqual(plans[0]['reply_to'], '')
        self.assertEqual(plans[1]['comment_content'], 'Trả lời bình luận 1')
        self.assertEqual(plans[1]['reply_to'], 'Bình luận đầu tiên')
        self.assertEqual(plans[2]['comment_content'], 'Trả lời bình luận 2')
        self.assertEqual(plans[2]['reply_to'], 'Bình luận đầu tiên')
        self.assertFalse(plans[0]['is_approved'])
        self.assertFalse(plans[0]['is_commented'])
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, owner=self.owner).count(), 3)

    @patch('tiktok.views.http_requests.post')
    def test_approve_all_comment_plans(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'output': [
                {str(self.device.id): 'Comment A'},
                {str(self.device.id): 'Comment B'},
            ]
        }
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, is_approved=False).count(), 2)

        approve_url = f'/api/tiktok/{self.video.id}/comment-plans/approve-all/'
        approve_response = self.client.post(approve_url)
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)
        self.assertEqual(approve_response.data['approved'], 2)
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, is_approved=False).count(), 0)
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, is_approved=True).count(), 2)
        self.assertEqual(Schedule.objects.filter(profile=self.profile).count(), 2)

    def test_approving_comment_plan_creates_schedules_for_profiles_on_device(self):
        self.device.device_serial_id = 'SERIAL-OWNER-001'
        self.device.save(update_fields=['device_serial_id', 'updated_at'])
        another_profile = Profile.objects.create(name='Second profile', owner=self.owner, device=self.device)
        plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            agent_group=self.agent_group,
            device=self.device,
            comment_content='Comment cần duyệt',
            is_approved=False,
            is_commented=False,
        )

        response = self.client.patch(
            self._comment_plan_detail_url(plan.id),
            {'is_approved': True},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data['is_approved'])

        schedules = Schedule.objects.filter(task__owner=self.owner).select_related('task', 'profile').order_by('id')
        self.assertEqual(schedules.count(), 2)
        self.assertEqual(
            {s.profile_id for s in schedules},
            {self.profile.id, another_profile.id},
        )
        for schedule in schedules:
            self.assertIn(self.video.video_url, schedule.task.description)
            self.assertIn('Comment cần duyệt', schedule.task.description)
            self.assertEqual(schedule.task.payload.get('agent'), 'tiktok')
            self.assertEqual(schedule.task.payload.get('video_url'), self.video.video_url)
            self.assertEqual(schedule.task.payload.get('comment_content'), 'Comment cần duyệt')
            self.assertEqual(schedule.schedule_type, ScheduleType.ONCE)
            self.assertEqual(schedule.task.status, 'pending')
            self.assertEqual(schedule.task.device_serial, 'SERIAL-OWNER-001')
        self.assertEqual(Task.objects.filter(owner=self.owner).count(), 2)
        plan.refresh_from_db()
        self.assertEqual(plan.profile_id, self.profile.id)

    @patch('profiles.utils.get_auto_schedule_params')
    def test_create_schedule_for_profile_prefers_future_run_at_from_auto_schedule(self, mock_auto):
        mock_auto.return_value = {'schedule_type': 'interval', 'run_at': '2099-01-01T10:00:00Z'}
        task = Task.objects.create(
            name='TikTok comment task',
            description='desc',
            task_type='generic',
            status='pending',
            payload={'agent': 'tiktok', 'profile_id': self.profile.id},
            owner=self.owner,
            device=self.device,
        )

        schedule = TiktokVideoViewSet._create_schedule_for_profile(task, self.profile)

        self.assertEqual(schedule.schedule_type, ScheduleType.ONCE)
        self.assertEqual(schedule.run_at.isoformat(), '2099-01-01T10:00:00+00:00')
        self.assertEqual(schedule.next_run_at, schedule.run_at)

    @patch('profiles.utils.get_auto_schedule_params', return_value=None)
    @patch('tiktok.views.timezone.now')
    def test_create_schedule_for_profile_fallbacks_to_next_routine_time(self, mock_now, _mock_auto):
        fixed_now = timezone.make_aware(datetime(2026, 1, 1, 15, 0, 0))
        mock_now.return_value = fixed_now
        from profiles.models import ProfileRoutine
        ProfileRoutine.objects.create(
            profile=self.profile,
            schedule_time=datetime(2026, 1, 1, 14, 0, 0).time(),
            action='Do something',
            cron_expression='0 14 * * *',
        )
        task = Task.objects.create(
            name='TikTok comment task',
            description='desc',
            task_type='generic',
            status='pending',
            payload={'agent': 'tiktok', 'profile_id': self.profile.id},
            owner=self.owner,
            device=self.device,
        )

        schedule = TiktokVideoViewSet._create_schedule_for_profile(task, self.profile)

        self.assertEqual(schedule.schedule_type, ScheduleType.ONCE)
        self.assertEqual(schedule.run_at, timezone.make_aware(datetime(2026, 1, 2, 14, 0, 0)))
        self.assertEqual(schedule.next_run_at, schedule.run_at)

    @patch('profiles.utils.get_auto_schedule_params', return_value=None)
    @patch('tiktok.views.timezone.now')
    def test_create_schedule_for_profile_prefers_future_routine_today(self, mock_now, _mock_auto):
        fixed_now = timezone.make_aware(datetime(2026, 1, 1, 15, 0, 0))
        mock_now.return_value = fixed_now
        from profiles.models import ProfileRoutine
        ProfileRoutine.objects.create(
            profile=self.profile,
            schedule_time=datetime(2026, 1, 1, 14, 0, 0).time(),
            action='Past routine',
            cron_expression='0 14 * * *',
        )
        ProfileRoutine.objects.create(
            profile=self.profile,
            schedule_time=datetime(2026, 1, 1, 16, 0, 0).time(),
            action='Future routine',
            cron_expression='0 16 * * *',
        )
        task = Task.objects.create(
            name='TikTok comment task',
            description='desc',
            task_type='generic',
            status='pending',
            payload={'agent': 'tiktok', 'profile_id': self.profile.id},
            owner=self.owner,
            device=self.device,
        )

        schedule = TiktokVideoViewSet._create_schedule_for_profile(task, self.profile)

        self.assertEqual(schedule.schedule_type, ScheduleType.ONCE)
        self.assertEqual(schedule.run_at, timezone.make_aware(datetime(2026, 1, 1, 16, 0, 0)))
        self.assertEqual(schedule.next_run_at, schedule.run_at)

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_comments_ignores_malformed_n8n_output(self, mock_post):
        """Non-dict items, non-int device IDs, non-string comments are silently skipped."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'output': [
                'not a dict',
                {str(self.device.id): 'Valid comment'},
                {'not_a_number': 'skipped'},
                {str(self.device.id): 42},  # non-string comment
            ]
        }
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(len(response.data['comment_plans']), 1)
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video).count(), 1)

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_comments_with_no_output_field_creates_no_plans(self, mock_post):
        """If n8n returns a response without 'output', no comment plans are created."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {'ok': True}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(response.data['comment_plans'], [])
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video).count(), 0)

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_comments_returns_502_on_webhook_failure(self, mock_post):
        mock_post.side_effect = http_requests_lib.exceptions.ConnectionError('unreachable')

        response = self.client.post(
            self._dispatch_comments_url(),
            {'agent_group': self.agent_group.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_dispatch_comments_rejects_other_user_group(self):
        response = self.client.post(
            self._dispatch_comments_url(),
            {'agent_group': self.other_group.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('agent_group', response.data)

    @override_settings(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL='https://example.com/single-comment')
    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_calls_single_webhook_and_saves_all_plans(self, mock_post):
        another_device = Device.objects.create(name='Owner device 2', owner=self.owner)
        AgentGroupMember.objects.create(group=self.agent_group, device=another_device, role='worker')

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'output': [
                {str(self.device.id): 'Bình luận đơn'},
                {str(another_device.id): 'Bình luận đơn 2'},
            ]
        }
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id, another_device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(len(response.data['comment_plans']), 2)
        self.assertEqual(response.data['comment_plans'][0]['comment_content'], 'Bình luận đơn')
        self.assertEqual(response.data['comment_plans'][1]['comment_content'], 'Bình luận đơn 2')
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, owner=self.owner).count(), 2)
        mock_post.assert_called_once()
        self.assertEqual(mock_post.call_args.args[0], 'https://example.com/single-comment')

    @override_settings(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL='https://example.com/single-comment')
    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_uses_external_webhook_from_db(self, mock_post):
        ExternalWebhook.objects.create(
            webhook_name='N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL',
            webhook_url='https://db.example.com/single-comment',
            is_active=True,
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {'output': [{str(self.device.id): 'Bình luận từ DB'}]}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        mock_post.assert_called_once()
        self.assertEqual(mock_post.call_args.args[0], 'https://db.example.com/single-comment')

    @override_settings(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL='https://example.com/single-comment')
    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_new_format_list_wrapper(self, mock_post):
        """n8n returns [{'output': [{'device_id': ..., 'comment': ...}]}] – new named-key list format."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {
                'output': [
                    {'device_id': self.device.id, 'comment': 'Bình luận đơn mới'},
                ]
            }
        ]
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(len(response.data['comment_plans']), 1)
        self.assertEqual(response.data['comment_plans'][0]['comment_content'], 'Bình luận đơn mới')
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, owner=self.owner).count(), 1)

    @override_settings(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL='https://example.com/single-comment')
    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_creates_multiple_plans_for_one_device(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'output': [
                {'device_id': self.device.id, 'comment': ['Bình luận 1', 'Bình luận 2', 'Bình luận 3']},
            ]
        }
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(len(response.data['comment_plans']), 3)
        self.assertEqual(
            [item['comment_content'] for item in response.data['comment_plans']],
            ['Bình luận 1', 'Bình luận 2', 'Bình luận 3'],
        )
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, owner=self.owner).count(), 3)

    @override_settings(N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL='https://example.com/single-comment')
    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_falls_back_to_settings_when_db_webhook_inactive(self, mock_post):
        ExternalWebhook.objects.create(
            webhook_name='N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_URL',
            webhook_url='https://db.example.com/single-comment',
            is_active=False,
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {'output': [{str(self.device.id): 'Bình luận fallback'}]}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        mock_post.assert_called_once()
        self.assertEqual(mock_post.call_args.args[0], 'https://example.com/single-comment')

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_comments_new_format_list_wrapper(self, mock_post):
        """n8n returns [{'output': [{'device_id': ..., 'comment': ...}, ...]}] – new named-key list format."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {
                'output': [
                    {'device_id': self.device.id, 'comment': 'Bình luận chính'},
                    {'device_id': self.device.id, 'comment': 'Trả lời 1'},
                ]
            }
        ]
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        response = self.client.post(
            self._dispatch_comments_url(),
            {
                'agent_group': self.agent_group.id,
                'video_url': self.video.video_url,
                'content': self.video.content,
                'keywords': self.video.keywords,
                'devices': [self.device.id],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        plans = response.data['comment_plans']
        self.assertEqual(len(plans), 2)
        self.assertEqual(plans[0]['comment_content'], 'Bình luận chính')
        self.assertEqual(plans[0]['reply_to'], '')
        self.assertEqual(plans[1]['comment_content'], 'Trả lời 1')
        self.assertEqual(plans[1]['reply_to'], 'Bình luận chính')
        self.assertEqual(TiktokCommentPlan.objects.filter(video=self.video, owner=self.owner).count(), 2)

    @patch('tiktok.views.http_requests.post')
    def test_dispatch_single_comment_returns_502_on_webhook_failure(self, mock_post):
        mock_post.side_effect = http_requests_lib.exceptions.ConnectionError('unreachable')

        response = self.client.post(
            self._dispatch_single_comment_url(),
            {'agent_group': self.agent_group.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_approved_comments_lists_only_owner_approved_plans_by_default(self):
        own_approved = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Approved comment',
            is_approved=True,
            is_commented=False,
        )
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Pending comment',
            is_approved=False,
            is_commented=False,
        )
        other_video = TiktokVideo.objects.create(
            owner=self.other_user,
            video_url='https://tiktok.com/@other/video/2',
        )
        TiktokCommentPlan.objects.create(
            video=other_video,
            owner=self.other_user,
            video_link=other_video.video_url,
            comment_content='Other user approved',
            is_approved=True,
            is_commented=True,
        )

        response = self.client.get(self._approved_comments_url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['id'], own_approved.id)
        self.assertTrue(response.data[0]['is_approved'])

    def test_approved_comments_supports_approval_status_filter(self):
        own_approved = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Approved comment',
            is_approved=True,
            is_commented=False,
        )
        own_pending = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Pending comment',
            is_approved=False,
            is_commented=False,
        )

        response_all = self.client.get(f'{self._approved_comments_url()}?approval_status=all')
        self.assertEqual(response_all.status_code, status.HTTP_200_OK)
        self.assertEqual({item['id'] for item in response_all.data}, {own_approved.id, own_pending.id})

        response_pending = self.client.get(f'{self._approved_comments_url()}?approval_status=pending')
        self.assertEqual(response_pending.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response_pending.data), 1)
        self.assertEqual(response_pending.data[0]['id'], own_pending.id)
        self.assertFalse(response_pending.data[0]['is_approved'])

    def test_approved_comments_supports_date_filters(self):
        now = timezone.now()
        old_plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Old approved comment',
            is_approved=True,
            is_commented=False,
        )
        new_plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='New approved comment',
            is_approved=True,
            is_commented=True,
        )
        old_plan.created_at = now - timedelta(days=2)
        old_plan.save(update_fields=['created_at'])
        new_plan.created_at = now
        new_plan.save(update_fields=['created_at'])

        date_from = (now - timedelta(days=1)).date().isoformat()
        date_to = now.date().isoformat()
        response = self.client.get(f'{self._approved_comments_url()}?date_from={date_from}&date_to={date_to}')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['id'], new_plan.id)

    def test_approved_comments_supports_profile_device_and_commented_filters(self):
        other_device = Device.objects.create(name='Owner device 2', owner=self.owner)
        other_profile = Profile.objects.create(name='Owner profile 2', owner=self.owner, device=other_device)

        target_plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Matched plan',
            is_approved=True,
            is_commented=True,
        )
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=other_profile,
            device=other_device,
            comment_content='Other profile plan',
            is_approved=True,
            is_commented=True,
        )
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Not commented yet',
            is_approved=True,
            is_commented=False,
        )

        response = self.client.get(
            f'{self._approved_comments_url()}?profile_id={self.profile.id}&device_id={self.device.id}&commented_status=commented',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['id'], target_plan.id)

    def test_commented_interactions_uses_profile_and_device_from_comment_plan_by_comment_link(self):
        plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Nội dung kế hoạch khác nội dung thực tế',
            comment_link='https://www.tiktok.com/@demo/video/1?comment=123',
            is_approved=True,
            is_commented=True,
        )
        TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            profile_username='agent_profile_01',
            comment_content='Nội dung thực tế',
            comment_link='https://www.tiktok.com/@demo/video/1?comment=123',
        )

        response = self.client.get(self._commented_interactions_url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['comment_plan_id'], plan.id)
        self.assertEqual(response.data[0]['profile'], self.profile.id)
        self.assertEqual(response.data[0]['profile_name'], self.profile.name)
        self.assertEqual(response.data[0]['device'], self.device.id)
        self.assertEqual(response.data[0]['device_name'], self.device.name)

    def test_commented_interactions_matches_comment_plan_with_trimmed_case_insensitive_content(self):
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='great video!',
            is_approved=True,
            is_commented=True,
        )
        TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            profile_username='agent_profile_01',
            comment_content='  GREAT VIDEO!  ',
        )

        response = self.client.get(self._commented_interactions_url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['profile'], self.profile.id)
        self.assertEqual(response.data[0]['device'], self.device.id)

    def test_commented_interactions_falls_back_to_video_comment_plan_assignment_when_no_exact_match(self):
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            comment_content='Unassigned plan',
            is_approved=True,
            is_commented=True,
        )
        TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Assigned plan',
            is_approved=True,
            is_commented=True,
        )
        TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            profile_username='agent_profile_01',
            comment_content='No direct match to any plan content',
        )

        response = self.client.get(self._commented_interactions_url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['profile'], self.profile.id)
        self.assertEqual(response.data[0]['profile_name'], self.profile.name)
        self.assertEqual(response.data[0]['device'], self.device.id)
        self.assertEqual(response.data[0]['device_name'], self.device.name)

    @override_settings(OPENAI_API_KEY='test-key')
    def test_sender_must_be_user_for_input_chat_message(self):
        response = self.client.post(
            self._plan_chat_url(),
            {'content': 'test', 'sender': 'assistant'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('sender', response.data)
        self.assertEqual(TiktokCommentPlanChatMessage.objects.count(), 0)

    # ── dig-comment tests ─────────────────────────────────────────────────────

    def _dig_comment_url(self):
        return f'/api/tiktok/{self.video.id}/dig-comment/'

    def _make_mock_comments_response(self, comments):
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = {'comments': comments}
        return mock_resp

    @patch('tiktok.views.http_requests.post')
    def test_dig_comment_finds_exact_match_and_updates_interaction_and_plan(self, mock_post):
        interaction = TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            comment_content='Đây là bình luận tuyệt vời!',
        )
        plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.owner,
            comment_content='Đây là bình luận tuyệt vời!',
        )
        comment_link = 'https://www.tiktok.com/@demo/video/1?comment=999'
        mock_post.return_value = self._make_mock_comments_response([
            {
                'cid': 'cid-001',
                'user': {'uid': 'u1', 'nickname': 'Nick'},
                'text': 'Đây là bình luận tuyệt vời!',
                'raw': {'share_info': {'url': comment_link}},
            },
        ])

        response = self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id, 'comment_plan_id': plan.id},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data['matched'])
        self.assertEqual(response.data['comment_link'], comment_link)
        self.assertEqual(response.data['interaction_id'], interaction.id)
        self.assertTrue(response.data['updated_plan'])

        interaction.refresh_from_db()
        self.assertEqual(interaction.comment_link, comment_link)

        plan.refresh_from_db()
        self.assertEqual(plan.comment_link, comment_link)

    @patch('tiktok.views.http_requests.post')
    def test_dig_comment_updates_interaction_only_when_no_plan_id(self, mock_post):
        interaction = TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            comment_content='Bình luận hay quá!',
        )
        comment_link = 'https://www.tiktok.com/@demo/video/1?comment=789'
        mock_post.return_value = self._make_mock_comments_response([
            {
                'cid': 'cid-002',
                'user': {'uid': 'u2', 'nickname': 'Nick2'},
                'text': 'Bình luận hay quá!',
                'raw': {'share_info': {'url': comment_link}},
            },
        ])

        response = self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data['matched'])
        self.assertEqual(response.data['comment_link'], comment_link)
        self.assertFalse(response.data['updated_plan'])

        interaction.refresh_from_db()
        self.assertEqual(interaction.comment_link, comment_link)

    @patch('tiktok.views.http_requests.post')
    def test_dig_comment_returns_not_matched_when_similarity_below_threshold(self, mock_post):
        interaction = TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            comment_content='Nội dung A rất khác biệt so với nội dung B',
        )
        mock_post.return_value = self._make_mock_comments_response([
            {
                'cid': 'cid-003',
                'user': {'uid': 'u3', 'nickname': 'Nick3'},
                'text': 'Completely different comment content here XYZ',
                'raw': {'share_info': {'url': 'https://tiktok.com/comment/1'}},
            },
        ])

        response = self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data['matched'])
        self.assertIsNone(response.data['comment_link'])

        interaction.refresh_from_db()
        self.assertEqual(interaction.comment_link, '')

    def test_dig_comment_requires_interaction_id(self):
        response = self.client.post(self._dig_comment_url(), {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('interaction_id', response.data['detail'])

    def test_dig_comment_returns_404_for_missing_or_wrong_video_interaction(self):
        other_video = TiktokVideo.objects.create(
            owner=self.owner,
            video_url='https://tiktok.com/@demo/video/999',
        )
        interaction = TiktokVideoInteraction.objects.create(
            video=other_video,
            interaction_type='comment',
            comment_content='some content',
        )

        response = self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    @patch('tiktok.views.http_requests.post')
    def test_dig_comment_upserts_fetched_comments_into_user_comments(self, mock_post):
        interaction = TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            comment_content='Video rất hay!',
        )
        mock_post.return_value = self._make_mock_comments_response([
            {
                'cid': 'cid-upsert-1',
                'user': {'uid': 'u10', 'nickname': 'NickA'},
                'text': 'Video rất hay!',
                'raw': {'share_info': {'url': 'https://tiktok.com/c/1'}},
            },
            {
                'cid': 'cid-upsert-2',
                'user': {'uid': 'u11', 'nickname': 'NickB'},
                'text': 'Another comment',
                'raw': {},
            },
        ])

        self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id},
            format='json',
        )

        self.assertEqual(
            TiktokVideoUserComment.objects.filter(video=self.video, cid__startswith='cid-upsert-').count(),
            2,
        )

    @patch('tiktok.views.http_requests.post')
    def test_dig_comment_returns_502_on_external_api_failure(self, mock_post):
        interaction = TiktokVideoInteraction.objects.create(
            video=self.video,
            interaction_type='comment',
            comment_content='some comment',
        )
        mock_post.side_effect = http_requests_lib.exceptions.RequestException('timeout')

        response = self.client.post(
            self._dig_comment_url(),
            {'interaction_id': interaction.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)


class KeywordListApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='keyword-owner', password='secret123')
        self.other_user = User.objects.create_user(username='keyword-other', password='secret123')
        self.client.force_authenticate(user=self.owner)
        self.keyword_list = KeywordList.objects.create(
            owner=self.owner,
            name='Travel ideas',
            topic='travel',
            keywords=['beach'],
        )

    def add_keyword_url(self):
        return f'/api/tiktok/keyword-lists/{self.keyword_list.id}/add-keyword/'

    def search_videos_url(self):
        return f'/api/tiktok/keyword-lists/{self.keyword_list.id}/search-videos/'

    def save_search_videos_url(self):
        return f'/api/tiktok/keyword-lists/{self.keyword_list.id}/save-search-videos/'

    def test_add_keyword_appends_unique_keywords(self):
        response = self.client.post(
            self.add_keyword_url(),
            {
                'keyword': '  City Break  ',
                'keywords': ['Food Tour', 'city break', ' ', 'food tour'],
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['added_keywords'], ['City Break', 'Food Tour'])

        self.keyword_list.refresh_from_db()
        self.assertEqual(self.keyword_list.keywords, ['beach', 'City Break', 'Food Tour'])
        self.assertEqual(
            response.data['keyword_list']['keywords'],
            ['beach', 'City Break', 'Food Tour'],
        )

    def test_add_keyword_requires_keyword_or_keywords(self):
        response = self.client.post(self.add_keyword_url(), {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'keyword or keywords is required.')

    def test_add_keyword_rejects_invalid_keywords_payload(self):
        response = self.client.post(
            self.add_keyword_url(),
            {'keywords': 'not-a-list'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'keywords must be a list of strings.')

    def test_add_keyword_returns_404_for_other_user(self):
        self.client.force_authenticate(user=self.other_user)

        response = self.client.post(
            self.add_keyword_url(),
            {'keyword': 'New keyword'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    @patch('tiktok.views.http_requests.post')
    def test_search_videos_returns_normalized_video_urls(self, mock_post):
        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {
            'keyword': 'nâng ngực',
            'count': 1,
            'partial': False,
            'videos': [
                {
                    'video_id': '7100000000000000001',
                    'desc': 'Video description',
                    'create_time': 1776934854,
                    'author': {
                        'uid': '6900000000000000001',
                        'unique_id': 'demo_creator',
                        'nickname': 'Demo Creator',
                    },
                    'stats': {'diggCount': '1480'},
                },
            ],
        }
        mock_post.return_value = mock_response

        response = self.client.post(
            self.search_videos_url(),
            {
                'keyword': 'nâng ngực',
                'count': 20,
                'cursor': 0,
                'num_sessions': 1,
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['keyword'], 'nâng ngực')
        self.assertEqual(len(response.data['videos']), 1)
        self.assertEqual(
            response.data['videos'][0]['video_url'],
            'https://www.tiktok.com/@demo_creator/video/7100000000000000001',
        )
        self.assertFalse(response.data['videos'][0]['is_existing'])
        mock_post.assert_called_once_with(
            'http://localhost:8000/videos/search',
            json={
                'keyword': 'nâng ngực',
                'count': 20,
                'cursor': 0,
                'num_sessions': 1,
            },
            headers={
                'accept': 'application/json',
                'Content-Type': 'application/json',
            },
            timeout=300,
        )

    @patch('tiktok.views.http_requests.post')
    def test_search_videos_retries_with_proxy_when_first_call_fails(self, mock_post):
        Proxy.objects.create(
            name='search-proxy',
            protocol='socks5',
            host='203.0.113.10',
            port=1305,
            username='demo_proxy_user',
            password='demo_proxy_pass',
            status=Proxy.STATUS_ACTIVE,
            owner=self.owner,
        )
        successful_response = MagicMock()
        successful_response.raise_for_status.return_value = None
        successful_response.json.return_value = {'videos': []}
        mock_post.side_effect = [
            http_requests_lib.exceptions.RequestException('timeout'),
            successful_response,
        ]

        response = self.client.post(
            self.search_videos_url(),
            {
                'keyword': 'nâng ngực',
                'count': 20,
                'cursor': 0,
                'num_sessions': 1,
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(mock_post.call_count, 2)
        first_payload = mock_post.call_args_list[0].kwargs['json']
        second_payload = mock_post.call_args_list[1].kwargs['json']
        self.assertNotIn('proxy', first_payload)
        self.assertEqual(second_payload['proxy'], '203.0.113.10:1305:demo_proxy_user:demo_proxy_pass')

    def test_save_search_videos_creates_new_video(self):
        payload = {
            'keyword': 'nâng ngực',
            'videos': [
                {
                    'video_id': '7100000000000000001',
                    'desc': 'Chị em hãy yêu bản thân mình nhé',
                    'author': {'unique_id': 'demo_creator'},
                },
            ],
        }
        response = self.client.post(self.save_search_videos_url(), payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['saved'], 1)
        self.assertEqual(response.data['existing'], 0)
        self.assertEqual(response.data['total'], 1)

        video = TiktokVideo.objects.get(owner=self.owner, video_url='https://www.tiktok.com/@demo_creator/video/7100000000000000001')
        self.assertEqual(video.keywords, ['nâng ngực'])
        self.assertEqual(video.caption, 'Chị em hãy yêu bản thân mình nhé')
        self.assertEqual(video.content, 'Chị em hãy yêu bản thân mình nhé')

    def test_save_search_videos_updates_existing_video_url_and_keywords(self):
        existing_video = TiktokVideo.objects.create(
            owner=self.owner,
            video_url='https://www.tiktok.com/@old-user/video/7100000000000000001?lang=en',
            keywords=['thẩm mỹ'],
        )
        payload = {
            'keyword': 'nâng ngực',
            'videos': [
                {
                    'video_id': '7100000000000000001',
                    'desc': 'Video description',
                    'author': {'unique_id': 'demo_creator'},
                },
            ],
        }

        response = self.client.post(self.save_search_videos_url(), payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['saved'], 0)
        self.assertEqual(response.data['existing'], 1)
        self.assertEqual(response.data['total'], 1)
        self.assertEqual(TiktokVideo.objects.filter(owner=self.owner).count(), 1)

        existing_video.refresh_from_db()
        self.assertEqual(
            existing_video.video_url,
            'https://www.tiktok.com/@demo_creator/video/7100000000000000001',
        )
        self.assertEqual(existing_video.keywords, ['thẩm mỹ', 'nâng ngực'])


class TiktokRecordInteractionApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='interaction-owner', password='secret123')
        self.client.force_authenticate(user=self.user)
        self.device = Device.objects.create(name='Interaction device', owner=self.user)
        self.profile = Profile.objects.create(name='Interaction profile', owner=self.user, device=self.device)
        self.video = TiktokVideo.objects.create(
            owner=self.user,
            video_url='https://www.tiktok.com/@demo/video/111',
        )

    def test_record_interaction_accepts_comment_link(self):
        response = self.client.post(
            '/api/tiktok/record-interaction/',
            {
                'video_url': self.video.video_url,
                'interaction_type': 'comment',
                'profile_username': 'agent_profile_01',
                'comment_content': 'Great video! 🔥',
                'comment_link': 'https://www.tiktok.com/@demo/video/111?comment=222',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['comment_link'], 'https://www.tiktok.com/@demo/video/111?comment=222')

        interaction = TiktokVideoInteraction.objects.get(id=response.data['id'])
        self.assertEqual(interaction.video_id, self.video.id)
        self.assertEqual(interaction.comment_link, 'https://www.tiktok.com/@demo/video/111?comment=222')

    def test_record_interaction_marks_approved_plan_as_commented_and_saves_comment_link(self):
        plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Great video! 🔥',
            is_approved=True,
            is_commented=False,
        )

        response = self.client.post(
            '/api/tiktok/record-interaction/',
            {
                'video_url': self.video.video_url,
                'interaction_type': 'comment',
                'profile_username': 'interaction-profile',
                'comment_content': 'Great video! 🔥',
                'comment_link': 'https://www.tiktok.com/@demo/video/111?comment=777',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        plan.refresh_from_db()
        self.video.refresh_from_db()
        self.assertTrue(plan.is_commented)
        self.assertEqual(plan.comment_link, 'https://www.tiktok.com/@demo/video/111?comment=777')
        self.assertEqual(self.video.status, 'commented')

    def test_record_interaction_marks_unapproved_plan_as_commented(self):
        plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video.video_url,
            profile=self.profile,
            device=self.device,
            comment_content='Unapproved comment',
            is_approved=False,
            is_commented=False,
        )

        response = self.client.post(
            '/api/tiktok/record-interaction/',
            {
                'video_url': self.video.video_url,
                'interaction_type': 'comment',
                'profile_username': 'interaction-profile',
                'comment_content': 'Unapproved comment',
                'comment_link': 'https://www.tiktok.com/@demo/video/111?comment=888',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        plan.refresh_from_db()
        self.video.refresh_from_db()
        self.assertTrue(plan.is_commented)
        self.assertEqual(plan.comment_link, 'https://www.tiktok.com/@demo/video/111?comment=888')
        self.assertEqual(self.video.status, 'commented')


class TiktokUpdateCommentPlanApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='update-plan-owner', password='secret123')
        self.other_user = User.objects.create_user(username='update-plan-other', password='secret123')
        self.client.force_authenticate(user=self.user)
        self.video_url = 'https://www.tiktok.com/@demo/video/999'
        self.video = TiktokVideo.objects.create(owner=self.user, video_url=self.video_url)
        self.plan_1 = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video_url,
            comment_content='Comment 1',
            is_approved=True,
            is_commented=False,
        )
        self.plan_2 = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video_url,
            comment_content='Comment 2',
            is_approved=True,
            is_commented=False,
        )

    def _url(self):
        return '/api/tiktok/update-comment-plan/'

    def test_requires_video_link_or_comment_plan_id(self):
        response = self.client.post(
            self._url(),
            {'comment_link': 'https://www.tiktok.com/@demo/video/999?comment=1'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'At least one of video_link or comment_plan_id is required.')

    def test_rejects_invalid_comment_plan_id(self):
        response = self.client.post(
            self._url(),
            {
                'comment_plan_id': 'abc',
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'comment_plan_id must be an integer.')

    def test_requires_at_least_one_updatable_field(self):
        response = self.client.post(
            self._url(),
            {'video_link': self.video_url},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'At least one of comment_link or is_commented is required.')

    def test_returns_404_when_no_matching_comment_plan(self):
        response = self.client.post(
            self._url(),
            {
                'video_link': 'https://www.tiktok.com/@demo/video/not-found',
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.data['detail'], 'No comment plan found with provided criteria.')

    def test_updates_by_comment_plan_id_only(self):
        response = self.client.post(
            self._url(),
            {
                'comment_plan_id': self.plan_1.id,
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['updated_count'], 1)

        self.plan_1.refresh_from_db()
        self.plan_2.refresh_from_db()
        self.assertTrue(self.plan_1.is_commented)
        self.assertFalse(self.plan_2.is_commented)

    def test_filters_by_video_link_and_comment_plan_id_together(self):
        response = self.client.post(
            self._url(),
            {
                'video_link': self.video_url,
                'comment_plan_id': self.plan_2.id,
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['updated_count'], 1)

        self.plan_1.refresh_from_db()
        self.plan_2.refresh_from_db()
        self.assertFalse(self.plan_1.is_commented)
        self.assertTrue(self.plan_2.is_commented)

    def test_updates_comment_link_and_is_commented_by_video_link(self):
        response = self.client.post(
            self._url(),
            {
                'video_link': self.video_url,
                'comment_link': 'https://www.tiktok.com/@demo/video/999?comment=987',
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['updated_count'], 2)

        self.plan_1.refresh_from_db()
        self.plan_2.refresh_from_db()
        self.assertTrue(self.plan_1.is_commented)
        self.assertTrue(self.plan_2.is_commented)
        self.assertEqual(self.plan_1.comment_link, 'https://www.tiktok.com/@demo/video/999?comment=987')
        self.assertEqual(self.plan_2.comment_link, 'https://www.tiktok.com/@demo/video/999?comment=987')

    def test_rejects_non_boolean_is_commented(self):
        response = self.client.post(
            self._url(),
            {
                'video_link': self.video_url,
                'is_commented': 'true',
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'is_commented must be a boolean.')

    def test_only_updates_current_user_comment_plans(self):
        other_video = TiktokVideo.objects.create(owner=self.other_user, video_url=self.video_url)
        other_plan = TiktokCommentPlan.objects.create(
            video=other_video,
            owner=self.other_user,
            video_link=self.video_url,
            comment_content='Other user comment',
            is_approved=True,
            is_commented=False,
        )

        response = self.client.post(
            self._url(),
            {
                'video_link': self.video_url,
                'is_commented': True,
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        other_plan.refresh_from_db()
        self.assertFalse(other_plan.is_commented)


class TiktokCommentPlanClusterExecutionTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='cluster-owner', password='secret123')
        self.client.force_authenticate(user=self.user)
        self.video = TiktokVideo.objects.create(
            owner=self.user,
            video_url='https://www.tiktok.com/@demo/video/cluster',
        )
        self.device = Device.objects.create(
            owner=self.user,
            name='Cluster device',
            device_serial_id='SERIAL-CLUSTER-001',
        )
        self.profile = Profile.objects.create(
            owner=self.user,
            device=self.device,
            name='Cluster profile',
        )
        self.root_plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video.video_url,
            device=self.device,
            profile=self.profile,
            comment_content='Root comment',
        )
        self.reply_plan = TiktokCommentPlan.objects.create(
            video=self.video,
            owner=self.user,
            video_link=self.video.video_url,
            device=self.device,
            profile=self.profile,
            comment_content='Reply comment',
            reply_to='Root comment',
        )

    def _execute_cluster_url(self, plan_id):
        return f'/api/tiktok/{self.video.id}/comment-plans/{plan_id}/execute-cluster/'

    def _task_detail_url(self, task_id):
        return f'/api/tasks/{task_id}/'

    def test_execute_cluster_schedules_first_plan_item(self):
        response = self.client.post(self._execute_cluster_url(self.root_plan.id), {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(response.data['root_plan_id'], self.root_plan.id)
        self.assertEqual(response.data['scheduled_plan_id'], self.root_plan.id)
        task = Task.objects.get(id=response.data['task_id'])
        self.assertEqual(task.status, TaskStatus.PENDING)
        self.assertEqual(task.payload.get('comment_plan_id'), self.root_plan.id)
        self.root_plan.refresh_from_db()
        self.assertEqual(self.root_plan.execution_status, TiktokCommentPlan.ExecutionStatus.SCHEDULED)

    def test_completed_cluster_item_schedules_next_item_in_5_minutes(self):
        execute = self.client.post(self._execute_cluster_url(self.root_plan.id), {}, format='json')
        first_task_id = execute.data['task_id']

        complete = self.client.patch(
            self._task_detail_url(first_task_id),
            {'status': TaskStatus.COMPLETED},
            format='json',
        )
        self.assertEqual(complete.status_code, status.HTTP_200_OK)

        self.root_plan.refresh_from_db()
        self.reply_plan.refresh_from_db()
        self.assertTrue(self.root_plan.is_commented)
        self.assertEqual(self.reply_plan.execution_status, TiktokCommentPlan.ExecutionStatus.IDLE)

        fetch_task = Task.objects.exclude(id=first_task_id).get()
        self.assertTrue(fetch_task.payload.get('is_fetch_link'))
        self.assertEqual(fetch_task.payload.get('comment_plan_id'), self.root_plan.id)

    def test_fetch_link_completed_marks_root_completed_and_schedules_reply(self):
        execute = self.client.post(self._execute_cluster_url(self.root_plan.id), {}, format='json')
        first_task_id = execute.data['task_id']

        self.client.patch(
            self._task_detail_url(first_task_id),
            {'status': TaskStatus.COMPLETED},
            format='json',
        )
        fetch_task = Task.objects.exclude(id=first_task_id).get()

        self.client.patch(
            self._task_detail_url(fetch_task.id),
            {'status': TaskStatus.COMPLETED},
            format='json',
        )

        self.root_plan.refresh_from_db()
        self.reply_plan.refresh_from_db()
        self.assertEqual(self.root_plan.execution_status, TiktokCommentPlan.ExecutionStatus.COMPLETED)
        self.assertEqual(self.reply_plan.execution_status, TiktokCommentPlan.ExecutionStatus.SCHEDULED)

        reply_task = Task.objects.exclude(id__in=[first_task_id, fetch_task.id]).get()
        self.assertEqual(reply_task.payload.get('comment_plan_id'), self.reply_plan.id)
        schedule = Schedule.objects.get(task=reply_task)
        self.assertGreaterEqual(schedule.run_at, timezone.now() + timedelta(minutes=4, seconds=30))

    def test_failed_item_retries_then_marks_cluster_failed_after_limit(self):
        execute = self.client.post(self._execute_cluster_url(self.root_plan.id), {}, format='json')
        task_id = execute.data['task_id']

        for expected_retry in range(1, 5):
            failed = self.client.patch(
                self._task_detail_url(task_id),
                {'status': TaskStatus.FAILED},
                format='json',
            )
            self.assertEqual(failed.status_code, status.HTTP_200_OK)
            self.root_plan.refresh_from_db()
            self.reply_plan.refresh_from_db()
            self.assertEqual(self.root_plan.execution_retry_count, expected_retry)
            if expected_retry <= 3:
                self.assertEqual(self.root_plan.execution_status, TiktokCommentPlan.ExecutionStatus.SCHEDULED)
                task_id = Task.objects.order_by('-id').first().id
            else:
                self.assertEqual(self.root_plan.execution_status, TiktokCommentPlan.ExecutionStatus.FAILED)
                self.assertEqual(self.reply_plan.execution_status, TiktokCommentPlan.ExecutionStatus.FAILED)


class TiktokChannelCrawlApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='crawl-owner', password='secret123')
        self.client.force_authenticate(user=self.owner)
        self.url = '/api/tiktok/channel-crawl/'
        self.channel_url = 'https://www.tiktok.com/@demo_channel'

    @patch('tiktok.views.http_requests.post')
    def test_returns_cached_data_when_recent_and_no_cache_not_set(self, mock_post):
        channel = TiktokChannel.objects.create(
            channel_url=self.channel_url,
            last_crawled_at=timezone.now() - timedelta(hours=1),
            last_crawl_video_count=2,
        )
        TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@demo_channel/video/1',
            title='Video 1',
            description='Desc 1',
            hashtags=['a'],
            duration=10,
            view_count=100,
            like_count=10,
            last_crawled_at=timezone.now() - timedelta(hours=1),
        )
        TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@demo_channel/video/2',
            title='Video 2',
            description='Desc 2',
            hashtags=['b'],
            duration=20,
            view_count=200,
            like_count=20,
            last_crawled_at=timezone.now() - timedelta(hours=1),
        )

        response = self.client.post(
            self.url,
            {'channel_url': self.channel_url, 'max_videos': 1},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data['cache_hit'])
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['videos'][0]['comment_count'], 0)
        self.assertEqual(response.data['videos'][0]['share_count'], 0)
        self.assertIsNone(response.data['videos'][0]['published_at'])
        self.assertEqual(response.data['videos'][0]['analyzed_content'], '')
        mock_post.assert_not_called()

    @patch('tiktok.views.http_requests.post')
    def test_no_cache_refreshes_and_upserts_videos(self, mock_post):
        channel = TiktokChannel.objects.create(
            channel_url=self.channel_url,
            last_crawled_at=timezone.now() - timedelta(hours=1),
            last_crawl_video_count=1,
        )
        TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@demo_channel/video/1',
            title='Old title',
            description='Old description',
            hashtags=['old'],
            duration=11,
            view_count=111,
            like_count=11,
            last_crawled_at=timezone.now() - timedelta(hours=1),
        )

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            'channel_url': self.channel_url,
            'count': 2,
            'videos': [
                {
                    'url': 'https://www.tiktok.com/@demo_channel/video/1',
                    'title': 'New title',
                    'description': 'New description',
                    'hashtags': ['new'],
                    'duration': 22,
                    'view_count': 222,
                    'like_count': 22,
                    'comment_count': 9,
                    'share_count': 3,
                    'timestamp': 1_700_000_000,
                },
                {
                    'url': 'https://www.tiktok.com/@demo_channel/video/2',
                    'title': 'Video 2',
                    'description': '',
                    'hashtags': [],
                    'duration': 33,
                    'view_count': 333,
                    'like_count': 33,
                },
            ],
        }
        mock_post.return_value = mock_resp

        response = self.client.post(
            f'{self.url}?no-cache=true',
            {'channel_url': self.channel_url, 'max_videos': 100},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data['cache_hit'])
        self.assertEqual(response.data['count'], 2)
        self.assertEqual(TiktokChannelVideo.objects.filter(channel=channel).count(), 2)

        updated = TiktokChannelVideo.objects.get(video_url='https://www.tiktok.com/@demo_channel/video/1')
        self.assertEqual(updated.title, 'New title')
        self.assertEqual(updated.description, 'New description')
        self.assertEqual(updated.hashtags, ['new'])
        self.assertEqual(updated.duration, 22)
        self.assertEqual(updated.view_count, 222)
        self.assertEqual(updated.like_count, 22)
        self.assertEqual(updated.comment_count, 9)
        self.assertEqual(updated.share_count, 3)
        self.assertIsNotNone(updated.published_at)

    @patch('tiktok.views.http_requests.post')
    def test_channel_crawl_retries_with_proxy_when_first_call_fails(self, mock_post):
        Proxy.objects.create(
            name='crawl-proxy',
            protocol='socks5',
            host='203.0.113.10',
            port=1305,
            username='demo_proxy_user',
            password='demo_proxy_pass',
            status=Proxy.STATUS_ACTIVE,
            owner=self.owner,
        )
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = {
            'channel_url': self.channel_url,
            'count': 0,
            'videos': [],
        }
        mock_post.side_effect = [
            http_requests_lib.exceptions.RequestException('timeout'),
            mock_resp,
        ]

        response = self.client.post(
            f'{self.url}?no-cache=true',
            {'channel_url': self.channel_url, 'max_videos': 5},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(mock_post.call_count, 2)
        first_payload = mock_post.call_args_list[0].kwargs['json']
        second_payload = mock_post.call_args_list[1].kwargs['json']
        self.assertNotIn('proxy', first_payload)
        self.assertEqual(second_payload['proxy'], '203.0.113.10:1305:demo_proxy_user:demo_proxy_pass')

    @patch('tiktok.views.http_requests.post')
    def test_process_channel_video_starts_external_analysis(self, mock_post):
        channel = TiktokChannel.objects.create(channel_url=self.channel_url)
        video = TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@demo_channel/video/3',
            title='Video 3',
        )
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = {'task_id': 'task-123'}
        mock_post.return_value = mock_resp

        response = self.client.post(f'/api/tiktok/channel-videos/{video.id}/process-video/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['task_id'], 'task-123')
        video.refresh_from_db()
        self.assertEqual(video.video_process_task_id, 'task-123')

    def test_update_channel_video_content_by_task_id(self):
        channel = TiktokChannel.objects.create(channel_url=self.channel_url)
        video = TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@demo_channel/video/4',
            title='Video 4',
            video_process_task_id='task-xyz',
        )

        response = self.client.post(
            '/api/tiktok/channel-video/update-content/',
            {
                'video_process_task_id': 'task-xyz',
                'content': 'Nội dung video đã được hiểu.',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        video.refresh_from_db()
        self.assertEqual(video.analyzed_content, 'Nội dung video đã được hiểu.')
        self.assertTrue(video.is_understand_video)


class TiktokChannelVideoUnderstandPollingTests(APITestCase):
    @patch('tiktok.video_understand.http_requests.get')
    def test_polling_updates_video_when_task_succeeded(self, mock_get):
        channel = TiktokChannel.objects.create(channel_url='https://www.tiktok.com/@polling_demo')
        video = TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@polling_demo/video/10',
            video_process_task_id='task-abc',
            is_understand_video=False,
        )

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {
            'status': 'succeeded',
            'result': {
                'style_analysis': 'Phong cách nhẹ nhàng',
                'video_analysis': {
                    'main_story': 'Main story',
                    'emotional_tone': 'Happy',
                    'key_value': 'Value',
                    'audience_insight': 'Insight',
                },
                'rewritten_content': {
                    'text_overlay': 'Overlay text',
                    'content_text': 'Long content text',
                    'background_description': 'Background desc',
                },
            },
        }
        mock_get.return_value = mock_resp

        stats = poll_pending_channel_video_understand_tasks()

        self.assertEqual(stats['scanned'], 1)
        self.assertEqual(stats['updated'], 1)
        video.refresh_from_db()
        self.assertTrue(video.is_understand_video)
        self.assertEqual(video.understand_text_overlay, 'Overlay text')
        self.assertEqual(video.understand_content_text, 'Long content text')
        self.assertEqual(video.understand_background_description, 'Background desc')
        self.assertEqual(video.understand_style_analysis, 'Phong cách nhẹ nhàng')
        self.assertEqual(video.understand_video_analysis['main_story'], 'Main story')
        self.assertEqual(video.analyzed_content, 'Long content text')

    @patch('tiktok.video_understand.http_requests.get')
    def test_polling_skips_non_succeeded_tasks(self, mock_get):
        channel = TiktokChannel.objects.create(channel_url='https://www.tiktok.com/@polling_demo_2')
        video = TiktokChannelVideo.objects.create(
            channel=channel,
            video_url='https://www.tiktok.com/@polling_demo_2/video/11',
            video_process_task_id='task-pending',
            is_understand_video=False,
        )

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {'status': 'running'}
        mock_get.return_value = mock_resp

        stats = poll_pending_channel_video_understand_tasks()

        self.assertEqual(stats['scanned'], 1)
        self.assertEqual(stats['updated'], 0)
        video.refresh_from_db()
        self.assertFalse(video.is_understand_video)


class TiktokChannelKeywordExtractionApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='keyword-owner', password='secret123')
        self.client.force_authenticate(user=self.owner)
        self.url = '/api/tiktok/channel-extract-keywords/'
        self.channel_url = 'https://www.tiktok.com/@keyword_channel'
        self.channel = TiktokChannel.objects.create(channel_url=self.channel_url)
        TiktokChannelVideo.objects.create(
            channel=self.channel,
            video_url='https://www.tiktok.com/@keyword_channel/video/1',
            title='Review điện thoại flagship',
            description='So sánh camera ban đêm và hiệu năng.',
            understand_content_text='Đánh giá pin, màn hình và trải nghiệm gaming.',
        )
        TiktokChannelVideo.objects.create(
            channel=self.channel,
            video_url='https://www.tiktok.com/@keyword_channel/video/2',
            title='Mẹo quay video cinematic',
            description='Thiết lập ánh sáng và bố cục khung hình.',
            understand_content_text='Hướng dẫn edit bằng capcut.',
        )

    @override_settings(GROQ_API_KEY='groq-test-key')
    @patch('groq.Groq')
    def test_extracts_keywords_from_channel_context(self, mock_groq):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"keywords": ["Camera", "CapCut", "camera"]}'))]
        )
        mock_groq.return_value = mock_client

        response = self.client.post(
            self.url,
            {'channel_url': self.channel_url, 'max_videos': 2},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['keywords'], ['Camera', 'CapCut'])
        self.assertEqual(response.data['count'], 2)
        call_messages = mock_client.chat.completions.create.call_args.kwargs['messages']
        self.assertIn('Review điện thoại flagship', call_messages[1]['content'])
        self.assertIn('So sánh camera ban đêm và hiệu năng.', call_messages[1]['content'])
        self.assertIn('Đánh giá pin, màn hình và trải nghiệm gaming.', call_messages[1]['content'])

    def test_requires_groq_api_key(self):
        with override_settings(GROQ_API_KEY=''):
            response = self.client.post(
                self.url,
                {'channel_url': self.channel_url},
                format='json',
            )

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertIn('Groq API key', response.data['detail'])

    @override_settings(GROQ_API_KEY='groq-test-key')
    @patch('groq.Groq')
    def test_returns_502_when_groq_response_is_invalid(self, mock_groq):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='not-json'))]
        )
        mock_groq.return_value = mock_client

        response = self.client.post(
            self.url,
            {'channel_url': self.channel_url, 'max_videos': 2},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)

    @override_settings(GROQ_API_KEY='groq-test-key')
    @patch('groq.Groq')
    def test_returns_empty_keywords_when_groq_response_is_empty(self, mock_groq):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=''))]
        )
        mock_groq.return_value = mock_client

        response = self.client.post(
            self.url,
            {'channel_url': self.channel_url, 'max_videos': 2},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['keywords'], [])
