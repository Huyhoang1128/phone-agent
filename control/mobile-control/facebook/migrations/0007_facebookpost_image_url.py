from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0006_facebookscheduledpost'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookpost',
            name='image_url',
            field=models.URLField(blank=True, default='', max_length=2048),
        ),
    ]
