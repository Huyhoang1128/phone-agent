from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0011_character_videos'),
    ]

    operations = [
        migrations.AddField(
            model_name='character',
            name='face_prompt',
            field=models.TextField(blank=True, default=''),
        ),
    ]
