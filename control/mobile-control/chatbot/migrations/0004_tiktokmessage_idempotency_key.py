# Generated for TCS-v2 Sprint 4 (#1): TiktokMessage.idempotency_key.
# Xem docs/Chatbot_Tiktok/tcs_v2_sprint_4_idempotency_key.md.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('chatbot', '0003_alter_tiktokmessage_source'),
    ]

    operations = [
        # Add field idempotency_key (NULL cho rows cũ, backward compat).
        migrations.AddField(
            model_name='tiktokmessage',
            name='idempotency_key',
            field=models.CharField(
                blank=True,
                db_index=True,
                help_text='SHA256 hash 32 chars đầu của (device_id + peer + reply + run + step).',
                max_length=64,
                null=True,
            ),
        ),
        # Drop constraint cũ — không đủ chống dup khi worker retry tạo task mới.
        migrations.RemoveConstraint(
            model_name='tiktokmessage',
            name='tiktokmsg_unique_per_task',
        ),
        # Add constraint mới — conditional unique trên idempotency_key
        # (NULL rows không bị enforce → backward compat hoàn toàn).
        migrations.AddConstraint(
            model_name='tiktokmessage',
            constraint=models.UniqueConstraint(
                condition=models.Q(idempotency_key__isnull=False),
                fields=['idempotency_key'],
                name='tiktokmsg_unique_idempotency_key',
            ),
        ),
    ]
