# Flow simplification 2026-06-12: drop the self-approval gate on profile
# scheduled posts. Used to be: user imports → user clicks Duyệt → cron fires.
# Now: user imports → user clicks Đăng → task dispatches immediately.
# Real moderation happens later via FB's own group admin queue (Phase 2 +
# maybe_spam tab workflow).
#
# Migration:
#   * Backfill: any existing row with is_approved=False (set by older CSV
#     import when target_group was non-NULL) becomes is_approved=True so it
#     can be picked up by the cron now that the gate is gone.
#   * The is_approved field itself is left in place to avoid a destructive
#     schema change — it's just always True from here on, and the UI no
#     longer surfaces it.

from django.db import migrations


def _backfill_is_approved(apps, schema_editor):
    Model = apps.get_model('facebook', 'FacebookProfileScheduledPost')
    Model.objects.filter(is_approved=False).update(is_approved=True)


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0023_pending_tab'),
    ]

    operations = [
        migrations.RunPython(_backfill_is_approved, migrations.RunPython.noop),
    ]
