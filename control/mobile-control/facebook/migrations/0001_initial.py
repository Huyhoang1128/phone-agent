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
            name='FacebookPage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('page_url', models.URLField(blank=True, default='', max_length=2048)),
                ('page_uid', models.CharField(blank=True, default='', help_text='Facebook page ID or username (the part after facebook.com/)', max_length=255)),
                ('category', models.CharField(blank=True, default='', max_length=255)),
                ('description', models.TextField(blank=True, default='')),
                ('follower_count', models.BigIntegerField(default=0)),
                ('status', models.CharField(
                    choices=[
                        ('active', 'Active'),
                        ('paused', 'Paused'),
                        ('archived', 'Archived'),
                    ],
                    default='active',
                    max_length=20,
                )),
                ('team_id', models.IntegerField(blank=True, db_index=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='facebook_pages',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
