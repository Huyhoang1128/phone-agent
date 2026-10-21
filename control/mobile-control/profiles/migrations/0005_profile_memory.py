from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('profiles', '0004_add_website_url_to_profile'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProfileMemory',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(max_length=255)),
                ('value', models.TextField(blank=True, default='')),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('profile', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='memories', to='profiles.profile')),
            ],
            options={
                'ordering': ['key'],
                'unique_together': {('profile', 'key')},
            },
        ),
    ]
