# Phase 1 of the FB Group admin-link feature:
#   * FacebookGroup.admin_fb_profile (FK → FacebookProfile) — the FB account
#     that has admin rights in the group.
#   * FacebookGroupScheduledPost.is_approved — gate for the publish_due cron.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0018_facebookprofilescheduledmediaaction'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookgroup',
            name='admin_fb_profile',
            field=models.ForeignKey(
                blank=True,
                help_text='Tài khoản FB cá nhân làm admin group — duyệt post + seeding qua phoneagent.',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='admin_groups',
                to='facebook.facebookprofile',
            ),
        ),
        migrations.AddField(
            model_name='facebookgroupscheduledpost',
            name='is_approved',
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text='Admin FB profile đã duyệt — cron chỉ fire khi True.',
            ),
        ),
    ]
