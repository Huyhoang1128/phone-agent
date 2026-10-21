from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0018_tiktokchannelvideo_understand_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokchannelvideo',
            name='share_count',
            field=models.BigIntegerField(default=0),
        ),
    ]
