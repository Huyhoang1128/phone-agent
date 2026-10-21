"""v3.2 migration: bổ sung 5 AuditAction enum mới
(insert_shot, delete_shot, reorder_shots, optimize_whole, generate_variant).

`choices` chỉ là constraint Python-level, không enforced ở DB column. Migration
này chỉ alter cho Django biết model đã update; thực tế DB schema không đổi.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content_scenario', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='contentscenarioauditlog',
            name='action',
            field=models.CharField(
                choices=[
                    ('generate', 'Generate'),
                    ('update_shot', 'Update shot'),
                    ('refine_shot', 'Refine shot'),
                    ('update_character', 'Update character'),
                    ('restore_shot', 'Restore shot'),
                    ('restore_all', 'Restore all'),
                    ('insert_shot', 'Insert shot'),
                    ('delete_shot', 'Delete shot'),
                    ('reorder_shots', 'Reorder shots'),
                    ('optimize_whole', 'Optimize whole scenario'),
                    ('generate_variant', 'Generate variant'),
                ],
                max_length=32,
            ),
        ),
    ]
