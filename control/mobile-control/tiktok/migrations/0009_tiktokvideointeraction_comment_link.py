from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0008_tiktokcommentplan_tiktokcommentplanchatmessage'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideointeraction',
            name='comment_link',
            field=models.URLField(blank=True, default='', max_length=2048),
        ),
    ]
