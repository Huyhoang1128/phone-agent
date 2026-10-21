# Phase 2: FacebookGroupPendingMemberPost — snapshot of members' pending
# posts in a Facebook Group, populated by phoneagent scraping the FB app.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0019_facebookgroup_admin_fb_profile_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='FacebookGroupPendingMemberPost',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('post_fb_id', models.CharField(blank=True, db_index=True, default='', max_length=255)),
                ('post_url', models.URLField(blank=True, default='', max_length=2048)),
                ('author_name', models.CharField(blank=True, default='', max_length=255)),
                ('author_uid', models.CharField(blank=True, default='', max_length=255)),
                ('content', models.TextField(blank=True, default='')),
                ('image_urls', models.JSONField(blank=True, default=list)),
                ('posted_at', models.DateTimeField(blank=True, null=True)),
                ('status', models.CharField(
                    choices=[
                        ('queued', 'Queued'),
                        ('processing', 'Processing'),
                        ('approved', 'Approved'),
                        ('rejected', 'Rejected'),
                        ('failed', 'Failed'),
                    ],
                    db_index=True,
                    default='queued',
                    max_length=20,
                )),
                ('error_msg', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('group', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='pending_member_posts',
                    to='facebook.facebookgroup',
                )),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='facebook_group_pending_member_posts',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'ordering': ['-posted_at', '-created_at'],
            },
        ),
        migrations.AddConstraint(
            model_name='facebookgrouppendingmemberpost',
            constraint=models.UniqueConstraint(
                condition=models.Q(('post_fb_id__gt', '')),
                fields=('group', 'post_fb_id'),
                name='uniq_fb_pending_post_per_group',
            ),
        ),
    ]
