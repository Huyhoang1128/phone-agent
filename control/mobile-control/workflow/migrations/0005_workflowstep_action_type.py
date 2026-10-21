from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflow', '0004_workflowstep'),
    ]

    operations = [
        migrations.AddField(
            model_name='workflowstep',
            name='action_type',
            field=models.CharField(
                choices=[
                    ('create_task', 'Create Task'),
                    ('create_schedule', 'Create Schedule'),
                    ('custom', 'Custom'),
                ],
                default='custom',
                max_length=50,
            ),
        ),
    ]
