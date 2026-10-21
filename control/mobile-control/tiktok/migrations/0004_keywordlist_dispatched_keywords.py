from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0003_tiktokvideo_caption_video_process_task_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='keywordlist',
            name='dispatched_keywords',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Keywords that have already been dispatched to an agent group',
            ),
        ),
    ]
