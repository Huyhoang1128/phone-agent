# Poster split — admin only approves, a separate FB profile actually posts.
#   * FacebookGroup.default_poster_fb_profile (FK → FacebookProfile) — inherits
#     onto every CSV-imported scheduled post.
#   * FacebookGroupScheduledPost.poster_fb_profile (FK → FacebookProfile) — the
#     account that taps Post (anonymously). Cron dispatches a phoneagent task
#     to this profile's device instead of calling Graph API.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0020_facebookgrouppendingmemberpost'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookgroup',
            name='default_poster_fb_profile',
            field=models.ForeignKey(
                blank=True,
                help_text='Tài khoản FB sẽ tap nút Đăng (ẩn danh) khi cron fire. Khác với admin (chỉ duyệt).',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='default_poster_groups',
                to='facebook.facebookprofile',
            ),
        ),
        migrations.AddField(
            model_name='facebookgroupscheduledpost',
            name='poster_fb_profile',
            field=models.ForeignKey(
                blank=True,
                help_text='Tài khoản FB sẽ thực sự đăng bài này lên app (ẩn danh).',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='poster_group_scheduled_posts',
                to='facebook.facebookprofile',
            ),
        ),
    ]
