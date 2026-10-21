from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0008_chat_attached_patches'),
        ('teams', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Character',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('source_image_url', models.URLField(blank=True, default='', max_length=2048)),
                ('media', models.JSONField(blank=True, default=list)),
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
                    related_name='characters',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('team', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='characters',
                    to='teams.team',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
