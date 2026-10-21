from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0009_tiktokvideointeraction_comment_link'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokcommentplan',
            name='comment_link',
            field=models.URLField(blank=True, default='', max_length=2048),
        ),
    ]
