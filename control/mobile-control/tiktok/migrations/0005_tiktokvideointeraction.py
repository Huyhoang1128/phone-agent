import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0004_keywordlist_dispatched_keywords'),
    ]

    operations = [
        migrations.CreateModel(
            name='TiktokVideoInteraction',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('interaction_type', models.CharField(
                    choices=[('like', 'Like'), ('comment', 'Comment')],
                    max_length=10,
                )),
                ('profile_username', models.CharField(blank=True, default='', max_length=255)),
                ('profile_avatar_url', models.URLField(blank=True, default='', max_length=2048)),
                ('comment_content', models.TextField(blank=True, default='')),
                ('interacted_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('video', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='interactions',
                    to='tiktok.tiktokvideo',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
