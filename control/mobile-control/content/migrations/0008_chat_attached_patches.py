# Phase 5 — AI chat self-applies refine via function calling.
# Adds the candidate-patch column so assistant turns can carry a
# before/after diff that the FE renders inline (Apply/Discard buttons),
# replacing the old standalone refine modal + separate API endpoint.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0007_chat_refine'),
    ]

    operations = [
        migrations.AddField(
            model_name='contentscriptchatmessage',
            name='attached_patches',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
