from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0011_tiktokvideousercomment'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideousercomment',
            name='comment_link',
            field=models.URLField(
                blank=True,
                help_text='Share URL for this comment (from raw.share_info.url)',
                max_length=2048,
                null=True,
            ),
        ),
    ]
