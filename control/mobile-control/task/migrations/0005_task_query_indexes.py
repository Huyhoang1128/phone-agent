from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('task', '0004_task_result'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='task',
            index=models.Index(fields=['owner', '-created_at'], name='task_task_owner_0cb429_idx'),
        ),
        migrations.AddIndex(
            model_name='task',
            index=models.Index(fields=['team', '-created_at'], name='task_task_team_eb05de_idx'),
        ),
    ]
