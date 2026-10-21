from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('profiles', '0008_profileroutine'),
        ('schedule', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='schedule',
            name='profile',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='schedules',
                to='profiles.profile',
            ),
        ),
    ]
