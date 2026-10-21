from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase
from unittest.mock import patch

from devices.models import Device
from facebook.models import FacebookPage, FacebookScheduledPost, FacebookScheduledPostStatus
from profiles.models import Profile
from task.models import Task

from .models import Schedule
from .scheduler import _execute_schedule, _poll_facebook_scheduled_posts


class ScheduleApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='schedule-owner', password='secret123')
        self.client.force_authenticate(user=self.user)

        self.profile_a = Profile.objects.create(name='Profile A', owner=self.user)
        self.profile_b = Profile.objects.create(name='Profile B', owner=self.user)
        self.task = Task.objects.create(name='Task', owner=self.user)

        self.schedule_a = Schedule.objects.create(
            task=self.task,
            profile=self.profile_a,
            schedule_type='once',
            run_at='2026-01-01T00:00:00Z',
            next_run_at='2026-01-01T00:00:00Z',
        )
        self.schedule_b = Schedule.objects.create(
            task=self.task,
            profile=self.profile_b,
            schedule_type='once',
            run_at='2026-01-02T00:00:00Z',
            next_run_at='2026-01-02T00:00:00Z',
        )

    def test_list_schedules_can_filter_by_profile_id(self):
        response = self.client.get(f'/api/schedules/?profile_id={self.profile_a.id}')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['id'], self.schedule_a.id)
        self.assertEqual(response.data[0]['profile'], self.profile_a.id)

    def test_list_schedules_with_invalid_profile_id_returns_empty(self):
        response = self.client.get('/api/schedules/?profile_id=invalid')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, [])

    def test_schedule_created_from_api_task_is_visible_to_owner(self):
        task_response = self.client.post(
            '/api/tasks/',
            {
                'name': 'Queued Publish',
                'description': 'Publish queue item',
                'task_type': 'generic',
                'status': 'pending',
                'payload': {'source': 'content-publish'},
            },
            format='json',
        )
        self.assertEqual(task_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(task_response.data['owner_id'], self.user.id)

        schedule_response = self.client.post(
            '/api/schedules/',
            {
                'task': task_response.data['id'],
                'profile': self.profile_a.id,
                'schedule_type': 'once',
                'run_at': '2026-02-01T00:00:00Z',
                'max_retries': 0,
                'retry_delay_seconds': 60,
            },
            format='json',
        )
        self.assertEqual(schedule_response.status_code, status.HTTP_201_CREATED)

        list_response = self.client.get('/api/schedules/')
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        self.assertIn(schedule_response.data['id'], [item['id'] for item in list_response.data])


class SchedulerExecutionTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='scheduler-user', password='secret123')
        self.device = Device.objects.create(
            name='Device A',
            device_type='personal',
            status='online',
            owner=self.user,
            device_serial_id='SERIAL-001',
        )
        self.task = Task.objects.create(
            name='Task',
            description='Run scheduled task',
            payload={'agent': 'tiktok'},
            owner=self.user,
        )
        self.profile = Profile.objects.create(
            name='Profile A',
            owner=self.user,
            device=self.device,
        )
        self.schedule = Schedule.objects.create(
            task=self.task,
            profile=self.profile,
            schedule_type='once',
            run_at=timezone.now(),
            next_run_at=timezone.now(),
        )

    @patch('mbcontrol.kafka_utils.send_task_execution_message', return_value=True)
    def test_execute_schedule_dispatches_kafka_with_profile_device(self, mock_send):
        _execute_schedule(self.schedule.id)

        self.task.refresh_from_db()
        self.schedule.refresh_from_db()
        execution = self.schedule.executions.first()

        self.assertEqual(self.task.status, 'running')
        self.assertEqual(self.schedule.status, 'completed')
        self.assertEqual(execution.result_status, 'success')
        mock_send.assert_called_once_with(
            self.task,
            devices_id=[self.device.id],
            profile_id=self.profile.id,
        )

    @patch('mbcontrol.kafka_utils.send_task_execution_message', return_value=True)
    def test_execute_schedule_uses_task_device_when_profile_device_missing(self, mock_send):
        self.profile.device = None
        self.profile.save(update_fields=['device', 'updated_at'])
        self.task.device = self.device
        self.task.save(update_fields=['device', 'updated_at'])

        _execute_schedule(self.schedule.id)

        mock_send.assert_called_once_with(
            self.task,
            devices_id=[self.device.id],
            profile_id=self.profile.id,
        )

    @patch('mbcontrol.kafka_utils.send_task_execution_message', return_value=True)
    def test_execute_schedule_dispatches_with_empty_devices_when_no_device_available(self, mock_send):
        self.profile.device = None
        self.profile.save(update_fields=['device', 'updated_at'])
        self.task.device = None
        self.task.save(update_fields=['device', 'updated_at'])

        _execute_schedule(self.schedule.id)

        mock_send.assert_called_once_with(
            self.task,
            devices_id=[],
            profile_id=self.profile.id,
        )


class FacebookScheduledPollTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='fb-scheduler-user', password='secret123')
        self.page = FacebookPage.objects.create(name='FB Page A', owner=self.user)

    @patch('facebook.views._publish_to_facebook')
    def test_poll_facebook_scheduled_posts_publishes_only_due_pending_posts(self, mock_publish):
        due_post = FacebookScheduledPost.objects.create(
            page=self.page,
            content='Due post',
            scheduled_at=timezone.now() - timedelta(minutes=1),
            status=FacebookScheduledPostStatus.PENDING,
            owner=self.user,
        )
        FacebookScheduledPost.objects.create(
            page=self.page,
            content='Future post',
            scheduled_at=timezone.now() + timedelta(minutes=10),
            status=FacebookScheduledPostStatus.PENDING,
            owner=self.user,
        )
        FacebookScheduledPost.objects.create(
            page=self.page,
            content='Already published',
            scheduled_at=timezone.now() - timedelta(minutes=10),
            status=FacebookScheduledPostStatus.PUBLISHED,
            owner=self.user,
        )

        _poll_facebook_scheduled_posts()

        mock_publish.assert_called_once()
        called_post = mock_publish.call_args[0][0]
        self.assertEqual(called_post.id, due_post.id)
