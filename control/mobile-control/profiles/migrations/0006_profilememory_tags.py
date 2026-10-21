from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('profiles', '0005_profile_memory'),
    ]

    operations = [
        migrations.AddField(
            model_name='profilememory',
            name='tags',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
