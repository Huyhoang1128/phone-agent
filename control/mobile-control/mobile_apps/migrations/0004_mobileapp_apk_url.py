from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('mobile_apps', '0003_mobileapp_owner_team'),
    ]

    operations = [
        migrations.AddField(
            model_name='mobileapp',
            name='apk_url',
            field=models.TextField(blank=True, default=''),
        ),
    ]
