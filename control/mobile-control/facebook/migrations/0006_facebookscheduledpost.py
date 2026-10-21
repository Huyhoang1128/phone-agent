from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0005_facebookpage_page_token'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='FacebookScheduledPost',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('content', models.TextField(blank=True, default='')),
                ('image_urls', models.JSONField(blank=True, default=list, help_text='List of S3 (or public) image URLs to attach to this post')),
                ('scheduled_at', models.DateTimeField(db_index=True, help_text='When to publish this post to Facebook')),
                ('status', models.CharField(
                    choices=[('pending', 'Pending'), ('published', 'Published'), ('failed', 'Failed'), ('cancelled', 'Cancelled')],
                    db_index=True,
                    default='pending',
                    max_length=20,
                )),
                ('fb_post_id', models.CharField(blank=True, default='', help_text='Facebook post ID returned by the Graph API after publishing', max_length=255)),
                ('error_msg', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='facebook_scheduled_posts',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('page', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='scheduled_posts',
                    to='facebook.facebookpage',
                )),
            ],
            options={
                'ordering': ['scheduled_at'],
            },
        ),
    ]
