from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0005_tiktokvideointeraction'),
    ]

    operations = [
        migrations.AlterField(
            model_name='tiktokvideointeraction',
            name='interaction_type',
            field=models.CharField(
                choices=[
                    ('like', 'Like'),
                    ('comment', 'Comment'),
                    ('repost', 'Repost'),
                    ('reply', 'Reply'),
                ],
                max_length=10,
            ),
        ),
    ]
