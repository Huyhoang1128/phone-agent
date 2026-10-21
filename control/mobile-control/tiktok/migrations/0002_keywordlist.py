import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tiktok', '0001_initial'),
        ('teams', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='KeywordList',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('topic', models.CharField(blank=True, default='', max_length=512)),
                ('keywords', models.JSONField(default=list, help_text='Deduplicated list of generated keywords')),
                ('team_permission', models.CharField(
                    choices=[('view', 'View'), ('edit', 'Edit')],
                    default='view',
                    max_length=10,
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='tiktok_keyword_lists',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('team', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='tiktok_keyword_lists',
                    to='teams.team',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
