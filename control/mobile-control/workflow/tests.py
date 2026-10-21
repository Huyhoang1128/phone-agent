from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Workflow


class WorkflowStepApiTests(APITestCase):
    PASSWORD = 'S3cureTestPass#123'

    def setUp(self):
        self.user = User.objects.create_user(username='workflow-step-owner', password=self.PASSWORD)
        self.client.force_authenticate(user=self.user)
        self.workflow = Workflow.objects.create(name='Workflow Steps', owner=self.user)

    def test_create_step_without_workflow_field_uses_nested_workflow(self):
        payload = {
            'name': 'Open app',
            'description': 'Launch the target application.',
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/steps/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['workflow'], self.workflow.id)
        self.assertEqual(response.data['sort_order'], 1)

    def test_create_step_auto_increments_sort_order(self):
        self.client.post(
            f'/api/workflows/{self.workflow.id}/steps/',
            {'name': 'Step 1'},
            format='json',
        )

        response = self.client.post(
            f'/api/workflows/{self.workflow.id}/steps/',
            {'name': 'Step 2'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['sort_order'], 2)

    def test_create_step_with_action_config_and_input_bindings(self):
        payload = {
            'name': 'Create task from trigger',
            'action_type': 'create_task',
            'action_config': {
                'task': {
                    'name': 'Triggered task',
                    'description': 'Created from workflow trigger.',
                    'task_type': 'generic',
                    'status': 'pending',
                    'payload': {'channel': 'workflow'},
                    'device_id': None,
                }
            },
            'input_bindings': [
                {
                    'source_type': 'trigger',
                    'source_path': 'message.text',
                    'target_path': 'task.description',
                }
            ],
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/steps/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['action_config']['task']['name'], 'Triggered task')
        self.assertEqual(response.data['input_bindings'][0]['source_path'], 'message.text')

    def test_create_schedule_step_accepts_inline_task_and_schedule_config(self):
        payload = {
            'name': 'Create schedule',
            'action_type': 'create_schedule',
            'action_config': {
                'task': {
                    'name': 'Scheduled task',
                    'description': '',
                    'task_type': 'generic',
                    'status': 'pending',
                    'payload': {'foo': 'bar'},
                },
                'schedule': {
                    'profile_id': None,
                    'schedule_type': 'interval',
                    'interval_seconds': 300,
                    'max_retries': 2,
                    'retry_delay_seconds': 60,
                    'is_active': True,
                },
            },
            'input_bindings': [
                {
                    'source_type': 'trigger',
                    'source_path': 'schedule_after_seconds',
                    'target_path': 'schedule.interval_seconds',
                }
            ],
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/steps/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['action_config']['schedule']['schedule_type'], 'interval')
        self.assertEqual(response.data['input_bindings'][0]['target_path'], 'schedule.interval_seconds')

    def test_create_task_step_rejects_invalid_binding_target(self):
        payload = {
            'name': 'Invalid binding target',
            'action_type': 'create_task',
            'input_bindings': [
                {
                    'source_type': 'trigger',
                    'source_path': 'payload.message',
                    'target_path': 'schedule.run_at',
                }
            ],
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/steps/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('input_bindings', response.data)


class WorkflowTriggerApiTests(APITestCase):
    PASSWORD = 'S3cureTestPass#123'

    def setUp(self):
        self.user = User.objects.create_user(username='workflow-owner', password=self.PASSWORD)
        self.client.force_authenticate(user=self.user)
        self.workflow = Workflow.objects.create(name='Workflow A', owner=self.user)

    def test_create_trigger_without_workflow_field_uses_nested_workflow(self):
        event_source_id = 1
        payload = {
            'trigger_type': 'event',
            'is_active': True,
            'event_name': 'device.notify',
            'event_source_type': 'device',
            'event_source_id': event_source_id,
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/triggers/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['workflow'], self.workflow.id)

    def test_create_periodic_trigger_without_workflow_field_uses_nested_workflow(self):
        payload = {
            'trigger_type': 'periodic',
            'is_active': True,
            'periodic_schedule_type': 'interval',
            'interval_seconds': 60,
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/triggers/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['workflow'], self.workflow.id)

    def test_create_webhook_trigger_without_workflow_field_uses_nested_workflow(self):
        payload = {
            'trigger_type': 'webhook',
            'is_active': True,
            'webhook_secret': 'WebhookSecret#123',
        }

        response = self.client.post(f'/api/workflows/{self.workflow.id}/triggers/', payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['workflow'], self.workflow.id)

    def test_reject_create_second_trigger_for_same_workflow(self):
        first_payload = {
            'trigger_type': 'periodic',
            'is_active': True,
            'periodic_schedule_type': 'interval',
            'interval_seconds': 60,
        }
        second_payload = {
            'trigger_type': 'webhook',
            'is_active': True,
            'webhook_secret': 'WebhookSecret#456',
        }

        first_response = self.client.post(
            f'/api/workflows/{self.workflow.id}/triggers/',
            first_payload,
            format='json',
        )
        second_response = self.client.post(
            f'/api/workflows/{self.workflow.id}/triggers/',
            second_payload,
            format='json',
        )

        self.assertEqual(first_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(second_response.data['detail'], 'A workflow can only have one trigger.')
