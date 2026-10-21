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
            name='Website',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('site_type', models.CharField(choices=[('wordpress', 'WordPress')], default='wordpress', max_length=20)),
                ('base_url', models.URLField(max_length=500)),
                ('wp_username', models.CharField(blank=True, default='', max_length=255)),
                ('wp_app_password', models.TextField(blank=True, default='')),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='websites', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-created_at']},
        ),
        migrations.CreateModel(
            name='WebsitePost',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('title', models.CharField(max_length=500)),
                ('content', models.TextField(blank=True, default='')),
                ('excerpt', models.TextField(blank=True, default='')),
                ('slug', models.CharField(blank=True, default='', max_length=255)),
                ('image_url', models.URLField(blank=True, default='', max_length=2048)),
                ('featured_media_id', models.IntegerField(blank=True, null=True)),
                ('categories', models.JSONField(blank=True, default=list)),
                ('tags', models.JSONField(blank=True, default=list)),
                ('wp_status', models.CharField(choices=[('publish', 'Publish'), ('draft', 'Draft')], default='publish', max_length=10)),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('published', 'Published'), ('failed', 'Failed'), ('cancelled', 'Cancelled')], default='pending', max_length=20)),
                ('scheduled_at', models.DateTimeField(blank=True, null=True)),
                ('wp_post_id', models.CharField(blank=True, default='', max_length=64)),
                ('post_url', models.URLField(blank=True, default='', max_length=2048)),
                ('error_msg', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='website_posts', to=settings.AUTH_USER_MODEL)),
                ('website', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='posts', to='websites.website')),
            ],
            options={'ordering': ['scheduled_at', '-created_at']},
        ),
        migrations.AddIndex(
            model_name='websitepost',
            index=models.Index(fields=['status', 'scheduled_at'], name='websites_we_status_idx'),
        ),
    ]
