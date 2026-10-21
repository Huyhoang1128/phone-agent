from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='Device',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('device_type', models.CharField(choices=[('personal', 'Personal Phone'), ('emulator', 'Temporary Emulator'), ('agent', 'Agent Phone'), ('mobilerun', 'Mobilerun Phone')], default='personal', max_length=20)),
                ('status', models.CharField(choices=[('online', 'Online'), ('offline', 'Offline'), ('connected', 'Connected')], default='offline', max_length=20)),
                ('identifier', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
