from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('task', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Schedule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('task', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='schedules',
                    to='task.task',
                )),
                ('schedule_type', models.CharField(
                    choices=[('once', 'Once'), ('interval', 'Interval'), ('cron', 'Cron')],
                    max_length=20,
                )),
                ('run_at', models.DateTimeField(blank=True, null=True)),
                ('interval_seconds', models.PositiveIntegerField(blank=True, null=True)),
                ('cron_expression', models.CharField(blank=True, default='', max_length=100)),
                ('max_retries', models.PositiveIntegerField(default=0)),
                ('retry_delay_seconds', models.PositiveIntegerField(default=60)),
                ('is_active', models.BooleanField(default=True)),
                ('status', models.CharField(
                    choices=[
                        ('active', 'Active'),
                        ('paused', 'Paused'),
                        ('completed', 'Completed'),
                        ('failed', 'Failed'),
                    ],
                    default='active',
                    max_length=20,
                )),
                ('next_run_at', models.DateTimeField(blank=True, null=True)),
                ('last_run_at', models.DateTimeField(blank=True, null=True)),
                ('retry_count', models.PositiveIntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='ScheduleExecution',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('schedule', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='executions',
                    to='schedule.schedule',
                )),
                ('started_at', models.DateTimeField(auto_now_add=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('result_status', models.CharField(
                    choices=[
                        ('success', 'Success'),
                        ('failure', 'Failure'),
                        ('retry', 'Retry'),
                    ],
                    default='success',
                    max_length=20,
                )),
                ('error_message', models.TextField(blank=True, default='')),
            ],
            options={
                'ordering': ['-started_at'],
            },
        ),
    ]
