from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0028_facebookscheduledpostcommentplan_root_plan'),
    ]

    operations = [
        migrations.CreateModel(
            name='FacebookProfileScheduledPostUserComment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('cid', models.CharField(help_text='Facebook comment ID', max_length=128)),
                ('user_id', models.CharField(blank=True, default='', help_text='Facebook user ID (string)', max_length=128)),
                ('nickname', models.CharField(blank=True, default='', max_length=255)),
                ('text', models.TextField(blank=True, default='')),
                ('create_time', models.DateTimeField(blank=True, null=True)),
                ('parent_cid', models.CharField(blank=True, default='', help_text='Parent comment ID for replies; empty for top-level comments', max_length=128)),
                ('comment_link', models.URLField(blank=True, help_text='Share URL for this comment', max_length=2048, null=True)),
                ('scheduled_post', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='user_comments', to='facebook.facebookprofilescheduledpost')),
            ],
            options={
                'ordering': ['create_time', 'id'],
                'unique_together': {('scheduled_post', 'cid')},
            },
        ),
    ]
