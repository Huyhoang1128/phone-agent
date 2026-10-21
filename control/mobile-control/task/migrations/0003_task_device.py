from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0009_add_devicenotification_identifier_key_unique'),
        ('task', '0002_task_owner_team'),
    ]

    operations = [
        migrations.AddField(
            model_name='task',
            name='device',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='tasks',
                to='devices.device',
            ),
        ),
        migrations.AddField(
            model_name='task',
            name='device_serial',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
