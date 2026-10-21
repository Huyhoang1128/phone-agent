"""Initial migration cho content_scenario app (AI Scenario v3).

Tạo 4 bảng:
- content_scenario_contentscenario
- content_scenario_contentscenarioshot
- content_scenario_contentscenariochatmessage
- content_scenario_contentscenarioauditlog
"""
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import mbcontrol.constants


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('teams', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # ─── ContentScenario ────────────────────────────────────────────────
        migrations.CreateModel(
            name='ContentScenario',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('team_permission', models.CharField(
                    choices=mbcontrol.constants.TeamPermission.choices,
                    default=mbcontrol.constants.TeamPermission.VIEW,
                    max_length=10,
                )),
                ('title', models.CharField(blank=True, default='', max_length=255)),
                ('brief', models.TextField(blank=True, default='')),
                ('duration_target_seconds', models.PositiveIntegerField(default=30)),
                ('shot_count_target', models.PositiveIntegerField(default=6)),
                ('genre', models.CharField(
                    choices=[
                        ('seeding', 'Seeding'),
                        ('testimonial', 'Testimonial'),
                        ('educational', 'Educational'),
                        ('brand_story', 'Brand story'),
                    ],
                    default='seeding',
                    max_length=32,
                )),
                ('source_file_name', models.CharField(blank=True, default='', max_length=255)),
                ('intent_json', models.JSONField(blank=True, default=dict)),
                ('character_registry', models.JSONField(blank=True, default=list)),
                ('mode', models.CharField(
                    choices=[
                        ('ai_video', 'AI video'),
                        ('real_footage', 'Real footage'),
                    ],
                    default='ai_video',
                    max_length=20,
                )),
                ('origin_data', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='content_scenarios',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('team', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='content_scenarios',
                    to='teams.team',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),

        # ─── ContentScenarioShot ────────────────────────────────────────────
        migrations.CreateModel(
            name='ContentScenarioShot',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('shot_id', models.PositiveIntegerField()),
                ('shot_order', models.PositiveIntegerField()),
                ('character_in_frame', models.CharField(blank=True, default='', max_length=64)),
                ('continuity_mode', models.CharField(
                    choices=[
                        ('NEW_SCENE', 'New scene'),
                        ('FRAME_ANCHOR', 'Frame anchor'),
                        ('B_ROLL_CUT', 'B-roll cut'),
                    ],
                    default='NEW_SCENE',
                    max_length=16,
                )),
                ('prompt_injection', models.CharField(blank=True, default='', max_length=255)),
                ('background', models.TextField(blank=True, default='')),
                ('character_pose', models.TextField(blank=True, default='')),
                ('kinetic_action', models.TextField(blank=True, default='')),
                ('camera_articulation', models.TextField(blank=True, default='')),
                ('prop_description', models.TextField(blank=True, default='')),
                ('texture_and_lighting', models.TextField(blank=True, default='')),
                ('voice_over', models.TextField(blank=True, default='')),
                ('music_hint', models.CharField(blank=True, default='', max_length=255)),
                ('funnel_part', models.CharField(
                    blank=True,
                    choices=[
                        ('Hook', 'Hook'),
                        ('Vấn đề', 'Vấn đề'),
                        ('Giải pháp', 'Giải pháp'),
                        ('CTA', 'CTA'),
                        ('B-roll', 'B-roll'),
                    ],
                    default='',
                    max_length=32,
                )),
                ('brand_mention', models.CharField(
                    choices=[
                        ('none', 'None'),
                        ('soft', 'Soft'),
                        ('strong', 'Strong'),
                    ],
                    default='none',
                    max_length=16,
                )),
                ('warnings', models.JSONField(blank=True, default=list)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('anchor_source_shot', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='anchored_by',
                    to='content_scenario.contentscenarioshot',
                )),
                ('scenario', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='shots',
                    to='content_scenario.contentscenario',
                )),
            ],
            options={
                'ordering': ['scenario', 'shot_order'],
                'unique_together': {('scenario', 'shot_id')},
            },
        ),

        # ─── ContentScenarioChatMessage ─────────────────────────────────────
        migrations.CreateModel(
            name='ContentScenarioChatMessage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('sender', models.CharField(
                    choices=[('USER', 'User'), ('ASSISTANT', 'Assistant')],
                    max_length=16,
                )),
                ('body', models.TextField()),
                ('target_shots', models.JSONField(blank=True, default=list)),
                ('target_character', models.CharField(blank=True, default='', max_length=64)),
                ('attached_patches', models.JSONField(blank=True, default=list)),
                ('llm_model', models.CharField(blank=True, default='', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('owner', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    to=settings.AUTH_USER_MODEL,
                )),
                ('scenario', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='chat_messages',
                    to='content_scenario.contentscenario',
                )),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),

        # ─── ContentScenarioAuditLog ────────────────────────────────────────
        migrations.CreateModel(
            name='ContentScenarioAuditLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(
                    choices=[
                        ('generate', 'Generate'),
                        ('update_shot', 'Update shot'),
                        ('refine_shot', 'Refine shot'),
                        ('update_character', 'Update character'),
                        ('restore_shot', 'Restore shot'),
                        ('restore_all', 'Restore all'),
                    ],
                    max_length=32,
                )),
                ('shot_id', models.PositiveIntegerField(blank=True, null=True)),
                ('character_name', models.CharField(blank=True, default='', max_length=64)),
                ('fields_changed', models.JSONField(blank=True, default=dict)),
                ('previous_value', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    to=settings.AUTH_USER_MODEL,
                )),
                ('scenario', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='audits',
                    to='content_scenario.contentscenario',
                )),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),

        # ─── Indexes ───────────────────────────────────────────────────────
        migrations.AddIndex(
            model_name='contentscenario',
            index=models.Index(fields=['owner', '-created_at'], name='cs_owner_created_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenario',
            index=models.Index(fields=['team', '-created_at'], name='cs_team_created_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenarioshot',
            index=models.Index(fields=['scenario', 'shot_order'], name='cs_shot_scen_order_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenariochatmessage',
            index=models.Index(fields=['scenario', 'created_at'], name='cs_chat_scen_created_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenariochatmessage',
            index=models.Index(fields=['owner', 'scenario', 'created_at'], name='cs_chat_owner_scen_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenarioauditlog',
            index=models.Index(fields=['scenario', '-created_at'], name='cs_audit_scen_created_idx'),
        ),
        migrations.AddIndex(
            model_name='contentscenarioauditlog',
            index=models.Index(fields=['actor', '-created_at'], name='cs_audit_actor_created_idx'),
        ),
    ]
