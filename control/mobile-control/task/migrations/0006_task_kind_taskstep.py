import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('task', '0005_task_query_indexes'),
    ]

    operations = [
        migrations.AddField(
            model_name='task',
            name='task_kind',
            field=models.CharField(
                choices=[('app', 'App Task'), ('system', 'System Task')],
                default='app',
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name='TaskStep',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('handler', models.CharField(max_length=100)),
                ('params', models.JSONField(blank=True, default=dict)),
                ('order', models.PositiveIntegerField(default=0)),
                ('status', models.CharField(
                    choices=[
                        ('pending', 'Pending'),
                        ('running', 'Running'),
                        ('completed', 'Completed'),
                        ('failed', 'Failed'),
                        ('skipped', 'Skipped'),
                    ],
                    default='pending',
                    max_length=20,
                )),
                ('result', models.JSONField(blank=True, default=dict)),
                ('error', models.TextField(blank=True, default='')),
                ('executed_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('task', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='steps', to='task.task')),
            ],
            options={
                'ordering': ['order', 'id'],
            },
        ),
    ]
