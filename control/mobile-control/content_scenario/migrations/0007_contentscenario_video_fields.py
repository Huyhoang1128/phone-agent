from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content_scenario', '0006_contentscenarioplan'),
    ]

    operations = [
        migrations.AddField(
            model_name='contentscenario',
            name='video_task_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
        migrations.AddField(
            model_name='contentscenario',
            name='video_status',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
        migrations.AddField(
            model_name='contentscenario',
            name='video_url',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='contentscenario',
            name='video_error',
            field=models.TextField(blank=True, default=''),
        ),
    ]
