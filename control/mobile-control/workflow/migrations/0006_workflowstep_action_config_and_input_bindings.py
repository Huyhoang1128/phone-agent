from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflow', '0005_workflowstep_action_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='workflowstep',
            name='action_config',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name='workflowstep',
            name='input_bindings',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
