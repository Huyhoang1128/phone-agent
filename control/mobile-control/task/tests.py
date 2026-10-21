from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from devices.models import Device
from profiles.models import Profile
from schedule.models import Schedule, ScheduleStatus, ScheduleType
from .models import Task, TaskKind, TaskStep, TaskStepStatus
from .registry import register


class TaskApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='task-owner', password='secret123')
        self.client.force_authenticate(user=self.user)

    def test_create_task_sets_owner_to_authenticated_user(self):
        payload = {
            'name': 'Publish Content',
            'description': 'Scheduled publish task',
            'task_type': 'generic',
            'status': 'pending',
            'payload': {'source': 'content-publish'},
        }

        response = self.client.post('/api/tasks/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['owner_id'], self.user.id)
        created_task = Task.objects.get(id=response.data['id'])
        self.assertEqual(created_task.owner_id, self.user.id)

    def test_list_tasks_is_paginated_and_supports_filters(self):
        Task.objects.create(
            name='Alpha task',
            description='Matches search',
            status='pending',
            owner=self.user,
        )
        Task.objects.create(
            name='Beta task',
            description='Should be hidden by status filter',
            status='running',
            owner=self.user,
        )
        for idx in range(12):
            Task.objects.create(
                name=f'Extra task {idx}',
                description='Bulk task',
                status='pending',
                owner=self.user,
            )

        response = self.client.get('/api/tasks/?page=1&page_size=5&status=pending&search=Alpha')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(len(response.data['results']), 1)
        self.assertEqual(response.data['results'][0]['name'], 'Alpha task')

    def test_list_tasks_clamps_out_of_range_page_to_last_page(self):
        for idx in range(12):
            Task.objects.create(
                name=f'Task {idx}',
                description='Pagination test',
                status='pending',
                owner=self.user,
            )

        response = self.client.get('/api/tasks/?page=999&page_size=5')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['count'], 12)
        self.assertEqual(len(response.data['results']), 2)
        self.assertTrue(all(item['name'].startswith('Task ') for item in response.data['results']))

    @patch('task.views.send_task_execution_message', return_value=True)
    def test_run_uses_task_device_and_payload_profile_and_syncs_once_schedule(self, mock_send):
        device = Device.objects.create(name='D1', owner=self.user, device_serial_id='SERIAL-001')
        profile = Profile.objects.create(name='P1', owner=self.user, device=device)
        task = Task.objects.create(
            name='Comment task',
            description='Run comment',
            status='pending',
            owner=self.user,
            device=device,
            device_serial=device.device_serial_id,
            payload={'agent': 'tiktok', 'profile_id': profile.id},
        )
        run_at = timezone.now() + timedelta(hours=2)
        schedule = Schedule.objects.create(
            task=task,
            profile=profile,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_called_once_with(task, devices_id=[device.id], profile_id=profile.id)
        task.refresh_from_db()
        self.assertEqual(task.status, 'running')
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, ScheduleStatus.COMPLETED)
        self.assertFalse(schedule.is_active)
        self.assertIsNone(schedule.next_run_at)
        self.assertIsNotNone(schedule.last_run_at)

    @patch('task.views.send_task_execution_message', return_value=True)
    def test_run_syncs_only_schedule_for_selected_profile(self, mock_send):
        device = Device.objects.create(name='D2', owner=self.user, device_serial_id='SERIAL-002')
        profile_a = Profile.objects.create(name='PA', owner=self.user, device=device)
        profile_b = Profile.objects.create(name='PB', owner=self.user, device=device)
        task = Task.objects.create(
            name='Comment task',
            description='Run comment',
            status='pending',
            owner=self.user,
            device=device,
            payload={'agent': 'tiktok', 'profile_id': profile_a.id},
        )
        run_at_a = timezone.now() + timedelta(hours=1)
        run_at_b = timezone.now() + timedelta(hours=2)
        schedule_a = Schedule.objects.create(
            task=task,
            profile=profile_a,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at_a,
            next_run_at=run_at_a,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )
        schedule_b = Schedule.objects.create(
            task=task,
            profile=profile_b,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at_b,
            next_run_at=run_at_b,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )

        response = self.client.post(
            f'/api/tasks/{task.id}/run/',
            {'profile_id': profile_b.id},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_called_once_with(task, devices_id=[device.id], profile_id=profile_b.id)
        schedule_a.refresh_from_db()
        schedule_b.refresh_from_db()
        self.assertEqual(schedule_a.status, ScheduleStatus.ACTIVE)
        self.assertTrue(schedule_a.is_active)
        self.assertEqual(schedule_b.status, ScheduleStatus.COMPLETED)
        self.assertFalse(schedule_b.is_active)

    @patch('task.views.send_task_execution_message', return_value=True)
    def test_run_without_profile_still_syncs_latest_once_schedule(self, mock_send):
        device = Device.objects.create(name='D3', owner=self.user, device_serial_id='SERIAL-003')
        profile = Profile.objects.create(name='PC', owner=self.user, device=device)
        task = Task.objects.create(
            name='Manual run task',
            description='Run from task detail',
            status='pending',
            owner=self.user,
            device=device,
            payload={'agent': 'generic'},
        )
        run_at = timezone.now() + timedelta(hours=3)
        schedule = Schedule.objects.create(
            task=task,
            profile=profile,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
            status=ScheduleStatus.ACTIVE,
            is_active=True,
        )

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_called_once_with(task, devices_id=[device.id], profile_id=None)
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, ScheduleStatus.COMPLETED)
        self.assertFalse(schedule.is_active)
        self.assertIsNone(schedule.next_run_at)
        self.assertIsNotNone(schedule.last_run_at)

    @patch('task.views.send_task_execution_message', return_value=True)
    def test_app_task_run_sends_kafka(self, mock_send):
        device = Device.objects.create(name='D4', owner=self.user, device_serial_id='SERIAL-004')
        task = Task.objects.create(
            name='App task',
            description='Kafka app task',
            status='pending',
            task_kind=TaskKind.APP,
            owner=self.user,
            device=device,
            payload={'agent': 'generic'},
        )

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_called_once_with(task, devices_id=[device.id], profile_id=None)
        task.refresh_from_db()
        self.assertEqual(task.status, 'running')

    @patch('task.views.send_task_execution_message')
    def test_system_task_run_executes_handler(self, mock_send):
        handler_name = 'test_system_success'

        @register(handler_name)
        def _handler(task_obj, step_obj):
            return {'ok': True, 'step_id': step_obj.id, 'task_id': task_obj.id}

        task = Task.objects.create(
            name='System task',
            description='run internal handler',
            status='pending',
            task_kind=TaskKind.SYSTEM,
            owner=self.user,
        )
        step = TaskStep.objects.create(task=task, handler=handler_name, order=0)

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_not_called()
        task.refresh_from_db()
        step.refresh_from_db()
        self.assertEqual(task.status, 'completed')
        self.assertEqual(step.status, TaskStepStatus.COMPLETED)
        self.assertEqual(step.result.get('ok'), True)
        self.assertEqual(step.result.get('step_id'), step.id)

    @patch('task.views.send_task_execution_message')
    def test_system_task_fallback_on_first_step_failure(self, mock_send):
        first_name = 'test_system_first_fail'
        second_name = 'test_system_second_success'

        @register(first_name)
        def _first_handler(_task_obj, _step_obj):
            raise RuntimeError('first failed')

        @register(second_name)
        def _second_handler(_task_obj, _step_obj):
            return {'ok': True}

        task = Task.objects.create(
            name='System fallback task',
            description='fallback',
            status='pending',
            task_kind=TaskKind.SYSTEM,
            owner=self.user,
        )
        first_step = TaskStep.objects.create(task=task, handler=first_name, order=0)
        second_step = TaskStep.objects.create(task=task, handler=second_name, order=1)

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_not_called()
        task.refresh_from_db()
        first_step.refresh_from_db()
        second_step.refresh_from_db()
        self.assertEqual(task.status, 'completed')
        self.assertEqual(first_step.status, TaskStepStatus.FAILED)
        self.assertEqual(second_step.status, TaskStepStatus.COMPLETED)

    @patch('task.views.send_task_execution_message')
    def test_system_task_all_steps_fail(self, mock_send):
        first_name = 'test_system_all_fail_1'
        second_name = 'test_system_all_fail_2'

        @register(first_name)
        def _first_handler(_task_obj, _step_obj):
            raise RuntimeError('first failed')

        @register(second_name)
        def _second_handler(_task_obj, _step_obj):
            raise RuntimeError('second failed')

        task = Task.objects.create(
            name='System all fail task',
            description='all fail',
            status='pending',
            task_kind=TaskKind.SYSTEM,
            owner=self.user,
        )
        first_step = TaskStep.objects.create(task=task, handler=first_name, order=0)
        second_step = TaskStep.objects.create(task=task, handler=second_name, order=1)

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_not_called()
        task.refresh_from_db()
        first_step.refresh_from_db()
        second_step.refresh_from_db()
        self.assertEqual(task.status, 'failed')
        self.assertEqual(first_step.status, TaskStepStatus.FAILED)
        self.assertEqual(second_step.status, TaskStepStatus.FAILED)

    @patch('task.views.send_task_execution_message')
    def test_system_task_unknown_handler_falls_to_next(self, mock_send):
        second_name = 'test_system_unknown_fallback_success'

        @register(second_name)
        def _second_handler(_task_obj, _step_obj):
            return {'ok': True}

        task = Task.objects.create(
            name='System unknown handler task',
            description='unknown fallback',
            status='pending',
            task_kind=TaskKind.SYSTEM,
            owner=self.user,
        )
        first_step = TaskStep.objects.create(task=task, handler='not_registered_handler', order=0)
        second_step = TaskStep.objects.create(task=task, handler=second_name, order=1)

        response = self.client.post(f'/api/tasks/{task.id}/run/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mock_send.assert_not_called()
        task.refresh_from_db()
        first_step.refresh_from_db()
        second_step.refresh_from_db()
        self.assertEqual(task.status, 'completed')
        self.assertEqual(first_step.status, TaskStepStatus.FAILED)
        self.assertIn('not registered', first_step.error)
        self.assertEqual(second_step.status, TaskStepStatus.COMPLETED)
