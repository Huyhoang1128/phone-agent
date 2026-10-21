from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0002_keywordlist'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideo',
            name='caption',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tiktokvideo',
            name='video_process_task_id',
            field=models.CharField(blank=True, max_length=255, null=True),
        ),
    ]
