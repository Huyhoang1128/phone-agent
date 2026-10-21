from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0007_facebookpost_image_url'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookscheduledpost',
            name='image_description',
            field=models.TextField(
                blank=True,
                default='',
                help_text='Optional image prompt/description for future image generation',
            ),
        ),
    ]
