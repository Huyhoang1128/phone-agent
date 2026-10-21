import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0007_add_screen_size_hardware_info'),
    ]

    operations = [
        migrations.CreateModel(
            name='DeviceNotification',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('identifier', models.CharField(db_index=True, max_length=255)),
                ('package', models.CharField(blank=True, default='', max_length=255)),
                ('title', models.CharField(blank=True, default='', max_length=512)),
                ('text', models.TextField(blank=True, default='')),
                ('notification_id', models.BigIntegerField(blank=True, null=True)),
                ('tag', models.CharField(blank=True, default='', max_length=255)),
                ('is_ongoing', models.BooleanField(default=False)),
                ('post_time', models.BigIntegerField(blank=True, null=True)),
                ('key', models.CharField(blank=True, default='', max_length=512)),
                ('event_timestamp', models.BigIntegerField(blank=True, null=True)),
                ('raw_data', models.JSONField(default=dict)),
                ('received_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                (
                    'device',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='notifications',
                        to='devices.device',
                    ),
                ),
            ],
            options={
                'ordering': ['-received_at'],
            },
        ),
    ]
