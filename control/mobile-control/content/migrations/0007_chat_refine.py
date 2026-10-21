# Manually authored migration for Phase 3 — chat-based AI refine.
# Adds:
#   - Content.origin_frames (snapshot for Restore)
#   - Content.mode (real_footage | ai_video; drives edit-lock)
#   - ContentScriptChatMessage (1 thread/Content)
#   - ContentScriptAuditLog (every update/refine/restore logged)
#
# Spec: docs/Gen_Scenario/chat-refine-design.md §4

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0006_featuresystemprompt'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='content',
            name='origin_frames',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='content',
            name='mode',
            field=models.CharField(
                blank=True,
                choices=[('real_footage', 'Real footage'), ('ai_video', 'AI video')],
                default='real_footage',
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name='ContentScriptChatMessage',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('sender', models.CharField(
                    choices=[('USER', 'User'), ('ASSISTANT', 'Assistant')],
                    max_length=16,
                )),
                ('body', models.TextField()),
                ('frame_target', models.PositiveIntegerField(blank=True, null=True)),
                ('llm_model', models.CharField(blank=True, default='', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('content', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='script_chat_messages',
                    to='content.content',
                )),
                ('owner', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='content_script_chat_messages',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'ordering': ['created_at'],
                'indexes': [
                    models.Index(fields=['content', '-created_at'], name='content_csc_msg_content_idx'),
                ],
            },
        ),
        migrations.CreateModel(
            name='ContentScriptAuditLog',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(
                    choices=[
                        ('update', 'Update field'),
                        ('refine', 'AI refine'),
                        ('restore_frame', 'Restore frame from origin'),
                        ('restore_all', 'Restore all frames from origin'),
                    ],
                    max_length=32,
                )),
                ('frame_index', models.PositiveIntegerField(blank=True, null=True)),
                ('fields_changed', models.JSONField(blank=True, default=dict)),
                ('previous_value', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(
                    null=True,
                    on_delete=models.deletion.SET_NULL,
                    related_name='+',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('content', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='script_audits',
                    to='content.content',
                )),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['content', '-created_at'], name='content_csa_log_content_idx'),
                ],
            },
        ),
    ]
