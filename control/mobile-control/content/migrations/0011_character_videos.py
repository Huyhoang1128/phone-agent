from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0010_character_scenes'),
    ]

    operations = [
        migrations.AddField(
            model_name='character',
            name='videos',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
