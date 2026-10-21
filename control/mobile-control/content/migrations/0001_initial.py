from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import mbcontrol.constants


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('teams', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Content',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('title', models.CharField(max_length=255)),
                ('video_url', models.URLField(blank=True, default='', max_length=2048)),
                ('script', models.TextField(blank=True, default='')),
                ('team_permission', models.CharField(
                    choices=mbcontrol.constants.TeamPermission.choices,
                    default=mbcontrol.constants.TeamPermission.VIEW,
                    max_length=10,
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='contents',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('team', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='contents',
                    to='teams.team',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
