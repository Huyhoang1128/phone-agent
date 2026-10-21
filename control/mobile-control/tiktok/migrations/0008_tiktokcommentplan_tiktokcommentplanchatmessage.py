from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('agent_groups', '0004_agentgroupplan'),
        ('devices', '0010_device_worker_id'),
        ('profiles', '0007_alter_profilememory_id'),
        ('tiktok', '0007_tiktokvideo_existing_comments'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='TiktokCommentPlan',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('video_link', models.URLField(blank=True, default='', max_length=2048)),
                ('comment_content', models.TextField(blank=True, default='')),
                ('reply_to', models.TextField(blank=True, default='')),
                ('is_approved', models.BooleanField(default=False)),
                ('is_commented', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                (
                    'agent_group',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plans',
                        to='agent_groups.agentgroup',
                    ),
                ),
                (
                    'device',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plans',
                        to='devices.device',
                    ),
                ),
                (
                    'owner',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plans',
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    'profile',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plans',
                        to='profiles.profile',
                    ),
                ),
                (
                    'video',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='comment_plans',
                        to='tiktok.tiktokvideo',
                    ),
                ),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='TiktokCommentPlanChatMessage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('sender', models.CharField(choices=[('user', 'User'), ('assistant', 'Assistant')], default='user', max_length=20)),
                ('content', models.TextField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                (
                    'agent_group',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plan_chat_messages',
                        to='agent_groups.agentgroup',
                    ),
                ),
                (
                    'owner',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='tiktok_comment_plan_chat_messages',
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    'video',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='comment_plan_chat_messages',
                        to='tiktok.tiktokvideo',
                    ),
                ),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
    ]
