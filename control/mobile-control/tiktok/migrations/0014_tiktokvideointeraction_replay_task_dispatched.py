from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0013_tiktokcommentplan_execution_last_error_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideointeraction',
            name='replay_task_dispatched',
            field=models.BooleanField(default=False),
        ),
    ]
