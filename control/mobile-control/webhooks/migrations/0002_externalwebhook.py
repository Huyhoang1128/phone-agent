from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('webhooks', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='ExternalWebhook',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('webhook_name', models.CharField(max_length=255, unique=True)),
                ('webhook_url', models.URLField(max_length=2048)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['webhook_name'],
            },
        ),
    ]
