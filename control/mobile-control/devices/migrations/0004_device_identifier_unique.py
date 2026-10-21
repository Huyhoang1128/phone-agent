from django.db import migrations, models
from django.db.models import Count, Q


def deduplicate_identifiers(apps, schema_editor):
    """
    For every non-empty identifier that appears on more than one Device row,
    keep only the most-recently-updated row and delete the older duplicates.

    This runs before the unique constraint is added so the constraint can
    be applied cleanly to an already-deduplicated table.
    """
    Device = apps.get_model('devices', 'Device')

    duplicated_identifiers = (
        Device.objects
        .exclude(identifier='')
        .values('identifier')
        .annotate(cnt=Count('id'))
        .filter(cnt__gt=1)
        .values_list('identifier', flat=True)
    )

    for identifier in duplicated_identifiers:
        # Order: newest updated_at first; on tie use highest pk.
        # Fetch only PKs to avoid loading full model objects into memory.
        pks = list(
            Device.objects
            .filter(identifier=identifier)
            .order_by('-updated_at', '-pk')
            .values_list('pk', flat=True)
        )
        # Keep pks[0] (the most recently updated), delete the rest.
        Device.objects.filter(pk__in=pks[1:]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0003_deviceusagesession'),
    ]

    operations = [
        # Remove existing duplicate rows before adding the constraint.
        # Note: This is intentionally kept separate from the AddConstraint
        # operation (which is in 0005) to avoid PostgreSQL's "pending trigger
        # events" error that occurs when creating an index in the same
        # transaction that performed DELETE operations.
        migrations.RunPython(deduplicate_identifiers, migrations.RunPython.noop),
    ]
