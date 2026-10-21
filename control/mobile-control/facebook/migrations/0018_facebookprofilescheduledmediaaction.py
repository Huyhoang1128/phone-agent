# Adds FacebookProfileScheduledMediaAction for scheduled avatar / cover /
# story changes imported from Google Sheets alongside content posts.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0017_facebookprofilescheduledpost_ai_prompt_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='FacebookProfileScheduledMediaAction',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action_type', models.CharField(
                    choices=[
                        ('change_avatar', 'Change avatar'),
                        ('change_cover', 'Change cover'),
                        ('post_story', 'Post story'),
                    ],
                    max_length=20,
                )),
                ('image_url', models.TextField(help_text='S3 (or public) URL of the image to upload')),
                ('scheduled_at', models.DateTimeField(db_index=True, help_text='When to execute this action')),
                ('status', models.CharField(
                    choices=[
                        ('pending', 'Pending'),
                        ('publishing', 'Publishing'),
                        ('published', 'Published'),
                        ('failed', 'Failed'),
                        ('cancelled', 'Cancelled'),
                    ],
                    db_index=True,
                    default='pending',
                    max_length=20,
                )),
                ('error_msg', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='facebook_profile_scheduled_media_actions',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('profile', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='scheduled_media_actions',
                    to='facebook.facebookprofile',
                )),
            ],
            options={
                'ordering': ['scheduled_at'],
            },
        ),
    ]
