from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0006_alter_tiktokvideointeraction_interaction_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='tiktokvideo',
            name='existing_comments',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Existing comments on the video from other people (not from agents)',
            ),
        ),
    ]
