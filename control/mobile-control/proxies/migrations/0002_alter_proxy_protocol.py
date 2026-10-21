from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('proxies', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='proxy',
            name='protocol',
            field=models.CharField(choices=[('socks5', 'SOCKS5'), ('http', 'HTTP')], default='socks5', max_length=20),
        ),
    ]
