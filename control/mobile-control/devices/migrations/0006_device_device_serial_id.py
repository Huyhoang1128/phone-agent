from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0005_device_identifier_unique'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='device_serial_id',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
