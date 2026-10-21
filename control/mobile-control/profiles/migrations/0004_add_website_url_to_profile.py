from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('profiles', '0003_add_goal_to_profile'),
    ]

    operations = [
        migrations.AddField(
            model_name='profile',
            name='website_url',
            field=models.URLField(blank=True, default=''),
        ),
    ]
