from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('websites', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='websitepost',
            name='source_images',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
