from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='MobileApp',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('package_name', models.CharField(blank=True, default='', max_length=255)),
                ('platform', models.CharField(choices=[('android', 'Android'), ('ios', 'iOS')], default='android', max_length=10)),
                ('apk_file', models.FileField(blank=True, null=True, upload_to='apks/')),
                ('version', models.CharField(blank=True, default='', max_length=50)),
                ('description', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
