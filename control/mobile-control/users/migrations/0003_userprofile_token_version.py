from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0002_userchatsettings'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='token_version',
            field=models.PositiveIntegerField(default=1),
        ),
    ]
