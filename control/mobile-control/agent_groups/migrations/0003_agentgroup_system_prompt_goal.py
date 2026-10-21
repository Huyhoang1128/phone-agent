from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent_groups', '0002_shared_resources'),
    ]

    operations = [
        migrations.AddField(
            model_name='agentgroup',
            name='system_prompt',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='agentgroup',
            name='goal',
            field=models.TextField(blank=True, default=''),
        ),
    ]
