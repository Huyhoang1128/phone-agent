from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0004_device_identifier_unique'),
    ]

    operations = [
        # Enforce uniqueness for non-empty identifiers at the database level.
        # Empty-string identifiers (devices not yet assigned an identifier) are
        # excluded from the constraint so multiple such rows can coexist.
        # This is in a separate migration from the deduplication RunPython
        # (which is in 0004) to avoid PostgreSQL's "pending trigger events"
        # error that occurs when creating an index in the same transaction
        # that performed DELETE operations.
        migrations.AddConstraint(
            model_name='device',
            constraint=models.UniqueConstraint(
                fields=['identifier'],
                condition=Q(identifier__gt=''),
                name='devices_device_identifier_nonempty_unique',
            ),
        ),
    ]
