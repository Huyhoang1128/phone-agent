from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import mbcontrol.constants


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0001_initial'),
        ('devices', '0010_device_worker_id'),
        ('teams', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='CrawlSource',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('url', models.URLField(max_length=2048)),
                ('source_type', models.CharField(
                    choices=[
                        ('web', 'Web (No sign-in required)'),
                        ('facebook', 'Facebook'),
                        ('tiktok', 'TikTok'),
                        ('youtube', 'YouTube'),
                        ('threads', 'Threads'),
                    ],
                    default='web',
                    max_length=20,
                )),
                ('crawl_frequency_minutes', models.PositiveIntegerField(default=60)),
                ('is_active', models.BooleanField(default=True)),
                ('team_permission', models.CharField(
                    choices=mbcontrol.constants.TeamPermission.choices,
                    default=mbcontrol.constants.TeamPermission.VIEW,
                    max_length=10,
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('device', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='crawl_sources',
                    to='devices.device',
                )),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='crawl_sources',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('team', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='crawl_sources',
                    to='teams.team',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
