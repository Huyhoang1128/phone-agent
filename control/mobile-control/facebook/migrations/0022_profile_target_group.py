# Profile scheduled posts can re-route into a group (anonymous, using the
# profile as poster). Adds:
#   * FacebookProfileScheduledPost.target_group → FacebookGroup (nullable)
#   * FacebookProfileScheduledPost.is_approved (default True for timeline; CSV
#     import flips to False when target_group is set, like the group flow).

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0021_group_poster_fb_profile'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookprofilescheduledpost',
            name='target_group',
            field=models.ForeignKey(
                blank=True,
                help_text='Nếu set, bài đăng vào group này (ẩn danh) thay vì timeline.',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='profile_scheduled_posts',
                to='facebook.facebookgroup',
            ),
        ),
        migrations.AddField(
            model_name='facebookprofilescheduledpost',
            name='is_approved',
            field=models.BooleanField(
                db_index=True,
                default=True,
                help_text='Khi target_group set, admin group phải duyệt; với timeline mặc định True.',
            ),
        ),
    ]
