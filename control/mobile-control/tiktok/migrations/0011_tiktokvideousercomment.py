from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0010_tiktokcommentplan_comment_link'),
    ]

    operations = [
        migrations.CreateModel(
            name='TiktokVideoUserComment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('cid', models.CharField(help_text='TikTok comment ID', max_length=64)),
                ('user_id', models.CharField(help_text='TikTok user ID (string)', max_length=64)),
                ('nickname', models.CharField(blank=True, default='', max_length=255)),
                ('text', models.TextField()),
                ('create_time', models.DateTimeField(blank=True, null=True)),
                ('parent_cid', models.CharField(
                    blank=True,
                    default='',
                    help_text='Parent comment ID for replies; empty for top-level comments',
                    max_length=64,
                )),
                ('video', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='user_comments',
                    to='tiktok.tiktokvideo',
                )),
            ],
            options={
                'ordering': ['create_time', 'id'],
                'unique_together': {('video', 'cid')},
            },
        ),
    ]
