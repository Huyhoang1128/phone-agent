import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('profiles', '0009_profileappinstallation'),
        ('facebook', '0009_facebookpost_image_urls'),
    ]

    operations = [
        migrations.CreateModel(
            name='FacebookGroup',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('group_url', models.URLField(blank=True, default='', max_length=2048)),
                ('group_uid', models.CharField(blank=True, default='', help_text='Facebook group ID or username', max_length=255)),
                ('description', models.TextField(blank=True, default='')),
                ('member_count', models.BigIntegerField(default=0)),
                ('status', models.CharField(choices=[('active', 'Active'), ('paused', 'Paused'), ('archived', 'Archived')], default='active', max_length=20)),
                ('team_id', models.IntegerField(blank=True, db_index=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('admin_profile', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='facebook_admin_groups', to='profiles.profile')),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='facebook_groups', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='FacebookGroupAutomationTask',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('task_type', models.CharField(choices=[('auto_post', 'Auto Post'), ('auto_comment', 'Auto Comment'), ('approve_posts', 'Approve Posts'), ('welcome_post', 'Welcome Post')], default='auto_post', max_length=30)),
                ('content_template', models.TextField(blank=True, default='')),
                ('schedule_type', models.CharField(choices=[('manual', 'Manual'), ('interval', 'Interval'), ('cron', 'Cron')], default='manual', max_length=20)),
                ('interval_minutes', models.PositiveIntegerField(blank=True, null=True)),
                ('cron_expression', models.CharField(blank=True, default='', max_length=255)),
                ('status', models.CharField(choices=[('active', 'Active'), ('paused', 'Paused')], default='active', max_length=20)),
                ('last_run_at', models.DateTimeField(blank=True, null=True)),
                ('next_run_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='automation_tasks', to='facebook.facebookgroup')),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='facebook_group_automation_tasks', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
