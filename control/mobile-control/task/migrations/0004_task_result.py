from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('task', '0003_task_device'),
    ]

    operations = [
        migrations.AddField(
            model_name='task',
            name='result',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
