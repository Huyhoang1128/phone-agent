import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='TiktokVideo',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('keywords', models.JSONField(default=list, help_text='List of keywords for this video')),
                ('video_url', models.URLField(blank=True, default='', max_length=2048)),
                ('content', models.TextField(blank=True, default='')),
                ('status', models.CharField(
                    choices=[
                        ('pending', 'Pending'),
                        ('liked', 'Liked'),
                        ('commented', 'Commented'),
                        ('shared', 'Shared'),
                        ('reposted', 'Reposted'),
                    ],
                    default='pending',
                    max_length=20,
                )),
                ('team_id', models.IntegerField(blank=True, db_index=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='tiktok_videos',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
