from unittest.mock import patch, MagicMock

from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.test import APITestCase
from mbcontrol.constants import TeamPermission
from task.models import Task
from schedule.models import Schedule
from teams.models import Team, TeamMembership
from .models import Profile, ProfileRoutine, ProfileContentItem


class ProfileRoutineApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='tester', password='pass1234')
        self.client.force_authenticate(user=self.user)
        self.profile = Profile.objects.create(name='Profile A', owner=self.user)

    def test_create_list_and_delete_routine(self):
        create_res = self.client.post(
            f'/api/profiles/{self.profile.id}/routines/',
            {
                'schedule_time': '08:30:00',
                'action': 'Go to work',
                'cron_expression': '30 8 * * 1-5',
            },
            format='json',
        )
        self.assertEqual(create_res.status_code, status.HTTP_201_CREATED)
        self.assertEqual(ProfileRoutine.objects.count(), 1)

        list_res = self.client.get(f'/api/profiles/{self.profile.id}/routines/')
        self.assertEqual(list_res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(list_res.data), 1)
        self.assertEqual(list_res.data[0]['action'], 'Go to work')

        routine_id = create_res.data['id']
        delete_res = self.client.delete(f'/api/profiles/{self.profile.id}/routines/{routine_id}/')
        self.assertEqual(delete_res.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(ProfileRoutine.objects.count(), 0)

    def test_create_routine_rejects_invalid_cron(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/routines/',
            {
                'schedule_time': '08:30:00',
                'action': 'Go to work',
                'cron_expression': 'invalid cron',
            },
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('cron_expression', res.data)


class ProfileAddScheduleApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='sched_tester', password='pass1234')
        self.client.force_authenticate(user=self.user)
        self.profile = Profile.objects.create(name='Profile B', owner=self.user)
        self.task = Task.objects.create(name='My Task', owner=self.user)

    # ── Manual schedule ─────────────────────────────────────────────────────────

    def test_add_cron_schedule_manual(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {
                'task_id': self.task.id,
                'auto_schedule': False,
                'schedule_type': 'cron',
                'cron_expression': '0 9 * * *',
            },
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Schedule.objects.count(), 1)
        schedule = Schedule.objects.first()
        self.assertEqual(schedule.schedule_type, 'cron')
        self.assertEqual(schedule.cron_expression, '0 9 * * *')
        self.assertEqual(schedule.profile_id, self.profile.id)
        self.assertEqual(schedule.task_id, self.task.id)

    def test_add_interval_schedule_manual(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {
                'task_id': self.task.id,
                'auto_schedule': False,
                'schedule_type': 'interval',
                'interval_seconds': 3600,
            },
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        schedule = Schedule.objects.first()
        self.assertEqual(schedule.schedule_type, 'interval')
        self.assertEqual(schedule.interval_seconds, 3600)

    def test_add_once_schedule_manual(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {
                'task_id': self.task.id,
                'auto_schedule': False,
                'schedule_type': 'once',
                'run_at': '2030-01-01T10:00:00Z',
            },
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        schedule = Schedule.objects.first()
        self.assertEqual(schedule.schedule_type, 'once')

    def test_missing_task_id_returns_400(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'auto_schedule': False, 'schedule_type': 'cron', 'cron_expression': '0 9 * * *'},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_nonexistent_task_returns_404(self):
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'task_id': 99999, 'auto_schedule': False, 'schedule_type': 'cron', 'cron_expression': '0 9 * * *'},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_invalid_schedule_params_returns_400(self):
        # cron schedule without cron_expression
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'task_id': self.task.id, 'auto_schedule': False, 'schedule_type': 'cron'},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    # ── Auto schedule ───────────────────────────────────────────────────────────

    @patch('profiles.views.ProfileViewSet._auto_schedule_params')
    def test_auto_schedule_uses_openai_result(self, mock_auto):
        mock_auto.return_value = {
            'schedule_type': 'cron',
            'cron_expression': '0 22 * * *',
        }
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'task_id': self.task.id, 'auto_schedule': True},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        mock_auto.assert_called_once_with(self.profile)
        schedule = Schedule.objects.first()
        self.assertEqual(schedule.schedule_type, 'cron')
        self.assertEqual(schedule.cron_expression, '0 22 * * *')

    def test_auto_schedule_no_api_key_returns_503(self):
        from django.test import override_settings
        with override_settings(OPENAI_API_KEY=''):
            res = self.client.post(
                f'/api/profiles/{self.profile.id}/add_schedule/',
                {'task_id': self.task.id, 'auto_schedule': True},
                format='json',
            )
        self.assertEqual(res.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    @patch('profiles.views.ProfileViewSet._auto_schedule_params')
    def test_auto_schedule_openai_error_returns_502(self, mock_auto):
        from rest_framework.response import Response as DRFResponse
        mock_auto.return_value = DRFResponse(
            {'detail': 'Failed to generate schedule parameters via OpenAI.'},
            status=status.HTTP_502_BAD_GATEWAY,
        )
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'task_id': self.task.id, 'auto_schedule': True},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_502_BAD_GATEWAY)

    @patch('profiles.views.ProfileViewSet._auto_schedule_params')
    def test_auto_schedule_uses_routines_as_context(self, mock_auto):
        """Verify that routines are fetched and passed to _auto_schedule_params."""
        ProfileRoutine.objects.create(
            profile=self.profile,
            schedule_time='09:00:00',
            action='Morning task',
            cron_expression='0 9 * * *',
        )
        mock_auto.return_value = {'schedule_type': 'interval', 'interval_seconds': 86400}
        res = self.client.post(
            f'/api/profiles/{self.profile.id}/add_schedule/',
            {'task_id': self.task.id, 'auto_schedule': True},
            format='json',
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        mock_auto.assert_called_once()

    @patch('profiles.views.ProfileViewSet._auto_schedule_params')
    @patch('openai.OpenAI')
    def test_auto_schedule_internal_openai_call(self, mock_openai_cls, mock_auto):
        """Verifies that a valid auto_schedule response creates a schedule entry."""
        mock_auto.return_value = {'schedule_type': 'cron', 'cron_expression': '0 3 * * *'}

        from django.test import override_settings
        with override_settings(OPENAI_API_KEY='test-key'):
            res = self.client.post(
                f'/api/profiles/{self.profile.id}/add_schedule/',
                {'task_id': self.task.id, 'auto_schedule': True},
                format='json',
            )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        schedule = Schedule.objects.first()
        self.assertIsNotNone(schedule)
        self.assertEqual(schedule.schedule_type, 'cron')


class ProfileTopicHistoryApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='topic_tester', password='pass1234')
        self.client.force_authenticate(user=self.user)

    def test_create_profile_persists_initial_topic_history(self):
        response = self.client.post(
            '/api/profiles/',
            {'name': 'Topic Profile', 'topic': 'fitness'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['topic'], 'fitness')
        self.assertEqual(len(response.data['topic_history']), 1)
        self.assertEqual(response.data['topic_history'][0]['topic'], 'fitness')

    def test_update_profile_appends_topic_history_when_topic_changes(self):
        profile = Profile.objects.create(name='Topic Profile', owner=self.user, topic='fitness', topic_history=[{'topic': 'fitness'}])
        response = self.client.patch(
            f'/api/profiles/{profile.id}/',
            {'topic': 'finance'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['topic'], 'finance')
        self.assertEqual([item['topic'] for item in response.data['topic_history']], ['fitness', 'finance'])

    @patch('profiles.views.generate_profile_topics')
    def test_generate_topics_returns_five_topics_and_audits(self, mock_generate):
        profile = Profile.objects.create(
            name='Topic Profile',
            owner=self.user,
            personality='Friendly and practical',
            topics=['fitness'],
        )
        mock_generate.return_value = ['travel tips', 'healthy meals', 'book reviews', 'fitness hacks', 'budget planning']

        response = self.client.post(
            f'/api/profiles/{profile.id}/generate-topics/',
            {'existing_topics': ['fitness']},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data['topics']), 5)
        profile.refresh_from_db()
        self.assertEqual(profile.topic_audit_logs[-1]['action'], 'generate_topics')

    @patch('profiles.views.generate_profile_topics')
    def test_generate_topics_returns_503_when_openai_not_configured(self, mock_generate):
        profile = Profile.objects.create(name='Topic Profile', owner=self.user, personality='Friendly and practical')
        mock_generate.return_value = None

        response = self.client.post(
            f'/api/profiles/{profile.id}/generate-topics/',
            {},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_topic_actions_append_audit_log(self):
        profile = Profile.objects.create(name='Topic Profile', owner=self.user, topics=['fitness'])
        response = self.client.post(
            f'/api/profiles/{profile.id}/topic-actions/',
            {'action': 'remove_generated_topic', 'topic': 'daily workout'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        profile.refresh_from_db()
        self.assertEqual(profile.topic_audit_logs[-1]['action'], 'remove_generated_topic')

    def test_apply_generated_topics_action_persists_topics_to_profile(self):
        profile = Profile.objects.create(name='Topic Profile', owner=self.user, topic='fitness', topics=['fitness'])
        response = self.client.post(
            f'/api/profiles/{profile.id}/topic-actions/',
            {'action': 'apply_generated_topics', 'topics': ['travel', ' fitness ', '', 'travel']},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        profile.refresh_from_db()
        self.assertEqual(profile.topics, ['fitness', 'travel'])
        self.assertEqual(profile.topic, 'fitness')
        self.assertEqual(profile.topic_audit_logs[-1]['action'], 'apply_generated_topics')

    def test_update_topics_logs_audit_and_syncs_primary_topic(self):
        profile = Profile.objects.create(name='Topic Profile', owner=self.user, topic='fitness', topics=['fitness'])
        response = self.client.patch(
            f'/api/profiles/{profile.id}/',
            {'topics': ['finance', 'travel']},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['topic'], 'finance')
        self.assertEqual(response.data['topics'], ['finance', 'travel'])
        self.assertEqual(response.data['topic_audit_logs'][-1]['action'], 'update_topics')


class ProfileContentWarehouseApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='content_tester', password='pass1234')
        self.other_user = User.objects.create_user(username='content_other', password='pass1234')
        self.client.force_authenticate(user=self.user)
        self.profile = Profile.objects.create(name='Content Profile', owner=self.user, topic='travel')
        self.other_profile = Profile.objects.create(name='Other Content Profile', owner=self.other_user, topic='finance')
        self.team = Team.objects.create(name='Content Team', created_by=self.user)
        TeamMembership.objects.create(team=self.team, user=self.user)
        TeamMembership.objects.create(team=self.team, user=self.other_user)
        self.profile.team = self.team
        self.profile.team_permission = TeamPermission.EDIT
        self.profile.save(update_fields=['team', 'team_permission'])

    def test_content_items_are_scoped_per_profile(self):
        ProfileContentItem.objects.create(profile=self.profile, owner=self.user, title='Mine', source_url='https://youtube.com/a')
        ProfileContentItem.objects.create(profile=self.other_profile, owner=self.other_user, title='Other', source_url='https://youtube.com/b')

        response = self.client.get(f'/api/profiles/{self.profile.id}/content-items/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['title'], 'Mine')

    def test_create_content_item_auto_tags_profile_topic(self):
        response = self.client.post(
            f'/api/profiles/{self.profile.id}/content-items/',
            {
                'title': 'Clip A',
                'source_url': 'https://youtube.com/watch?v=abc',
                'video_url': 'https://cdn.example.com/abc.mp4',
                'description': 'Clip for profile',
                'tags': ['viral'],
                'metadata': {'clip_id': 1},
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(set(response.data['tags']), {'viral', 'travel'})

    def test_content_items_are_isolated_per_user_within_shared_profile(self):
        ProfileContentItem.objects.create(profile=self.profile, owner=self.user, title='Owner item')
        ProfileContentItem.objects.create(profile=self.profile, owner=self.other_user, title='Shared member item')

        owner_response = self.client.get(f'/api/profiles/{self.profile.id}/content-items/')
        self.assertEqual(owner_response.status_code, status.HTTP_200_OK)
        self.assertEqual([item['title'] for item in owner_response.data], ['Owner item'])

        self.client.force_authenticate(user=self.other_user)
        member_response = self.client.get(f'/api/profiles/{self.profile.id}/content-items/')
        self.assertEqual(member_response.status_code, status.HTTP_200_OK)
        self.assertEqual([item['title'] for item in member_response.data], ['Shared member item'])

    def test_list_content_items_returns_empty_when_user_has_none(self):
        ProfileContentItem.objects.create(profile=self.profile, owner=self.user, title='Owner item')

        self.client.force_authenticate(user=self.other_user)
        response = self.client.get(f'/api/profiles/{self.profile.id}/content-items/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, [])

    def test_delete_content_item_rejects_other_user_item(self):
        item = ProfileContentItem.objects.create(profile=self.profile, owner=self.user, title='Owner item')

        self.client.force_authenticate(user=self.other_user)
        response = self.client.delete(f'/api/profiles/{self.profile.id}/content-items/{item.id}/')
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(ProfileContentItem.objects.filter(id=item.id).exists())
