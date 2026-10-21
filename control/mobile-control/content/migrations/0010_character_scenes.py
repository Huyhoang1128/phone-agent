from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0009_character'),
    ]

    operations = [
        migrations.AddField(
            model_name='character',
            name='scenes',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
