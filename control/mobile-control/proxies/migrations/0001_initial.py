import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('teams', '__first__'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Proxy',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('protocol', models.CharField(choices=[('socks5', 'SOCKS5')], default='socks5', max_length=20)),
                ('host', models.CharField(max_length=255)),
                ('port', models.PositiveIntegerField(blank=True, null=True)),
                ('username', models.CharField(blank=True, default='', max_length=255)),
                ('password', models.CharField(blank=True, default='', max_length=255)),
                ('team_permission', models.CharField(choices=[('view', 'View'), ('edit', 'Edit')], default='view', max_length=10)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='proxies', to=settings.AUTH_USER_MODEL)),
                ('team', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='proxies', to='teams.team')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
