import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent_groups', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='AgentGroupSharedMemory',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(max_length=255)),
                ('value', models.TextField(blank=True, default='')),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='shared_memories', to='agent_groups.agentgroup')),
            ],
            options={
                'ordering': ['key'],
                'unique_together': {('group', 'key')},
            },
        ),
        migrations.CreateModel(
            name='AgentGroupSharedFile',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('file', models.FileField(upload_to='agent_group_files/')),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='shared_files', to='agent_groups.agentgroup')),
            ],
            options={
                'ordering': ['-uploaded_at'],
            },
        ),
        migrations.CreateModel(
            name='AgentGroupSharedState',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(max_length=255)),
                ('value', models.JSONField(blank=True, default=dict)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='shared_states', to='agent_groups.agentgroup')),
            ],
            options={
                'ordering': ['key'],
                'unique_together': {('group', 'key')},
            },
        ),
    ]
