from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0019_tiktokchannelvideo_share_count'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideointeraction',
            name='dig_comment_dispatched',
            field=models.BooleanField(default=False),
        ),
    ]
