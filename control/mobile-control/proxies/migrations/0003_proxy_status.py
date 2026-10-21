from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('proxies', '0002_alter_proxy_protocol'),
    ]

    operations = [
        migrations.AddField(
            model_name='proxy',
            name='status',
            field=models.CharField(
                choices=[('active', 'Active'), ('inactive', 'Inactive')],
                default='active',
                max_length=20,
            ),
        ),
    ]
