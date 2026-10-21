from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase

from devices.models import Device
from task.models import Task
from .kafka_utils import send_task_execution_message


class KafkaUtilsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='kafka-owner', password='secret123')
        self.device = Device.objects.create(
            name='Kafka Device',
            owner=self.user,
            device_serial_id='SERIAL-KAFKA-001',
        )

    @patch('mbcontrol.redis_utils.get_device_worker_id', return_value=None)
    @patch('mbcontrol.kafka_utils.send_message', return_value=True)
    def test_send_task_execution_message_uses_payload_app_when_present(self, mock_send_message, _mock_worker_id):
        task = Task.objects.create(
            name='Replay comment',
            description='Replay tiktok comment',
            status='pending',
            owner=self.user,
            payload={'app': 'tiktok', 'source': 'tiktok-comment-replay'},
        )

        delivered = send_task_execution_message(task, devices_id=[self.device.id], profile_id=None)

        self.assertTrue(delivered)
        _, message = mock_send_message.call_args[0][:2]
        self.assertEqual(message['app'], 'tiktok')

    @patch('mbcontrol.redis_utils.get_device_worker_id', return_value=None)
    @patch('mbcontrol.kafka_utils.send_message', return_value=True)
    def test_send_task_execution_message_falls_back_to_agent_for_app(self, mock_send_message, _mock_worker_id):
        task = Task.objects.create(
            name='Like video',
            description='Like tiktok video',
            status='pending',
            owner=self.user,
            payload={'agent': 'tiktok', 'source': 'tiktok-like'},
        )

        delivered = send_task_execution_message(task, devices_id=[self.device.id], profile_id=None)

        self.assertTrue(delivered)
        _, message = mock_send_message.call_args[0][:2]
        self.assertEqual(message['app'], 'tiktok')
