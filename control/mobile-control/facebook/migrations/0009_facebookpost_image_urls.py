from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0008_facebookscheduledpost_image_description'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookpost',
            name='image_urls',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='List of image URLs to attach to this post',
            ),
        ),
        migrations.AlterField(
            model_name='facebookpost',
            name='image_url',
            field=models.URLField(
                blank=True,
                default='',
                help_text='Legacy single image; mirrors image_urls[0]',
                max_length=2048,
            ),
        ),
    ]
