# Pending posts can come from 2 tabs in the FB admin queue:
#   * "Bài viết đang chờ" (post approval queue)  → pending_tab='approval'
#   * "Có thể là spam" (FB auto-flagged)         → pending_tab='maybe_spam'
# The worker uses this field to navigate to the correct tab before tapping
# Phê duyệt / Từ chối.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0022_profile_target_group'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookgrouppendingmemberpost',
            name='pending_tab',
            field=models.CharField(
                choices=[
                    ('approval', 'Bài viết đang chờ'),
                    ('maybe_spam', 'Có thể là spam'),
                ],
                db_index=True,
                default='approval',
                max_length=20,
            ),
        ),
    ]
