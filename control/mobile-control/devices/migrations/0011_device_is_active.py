# Generated for TCS-v2 Sprint 2 (#2): Device soft-delete flag.
# Xem docs/Chatbot_Tiktok/tcs_v2_sprint_2_soft_delete_device.md.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0010_device_worker_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='is_active',
            field=models.BooleanField(
                default=True,
                db_index=True,
                help_text='Soft-delete flag. False = đã xóa (filtered khỏi list UI mặc định).',
            ),
        ),
    ]
