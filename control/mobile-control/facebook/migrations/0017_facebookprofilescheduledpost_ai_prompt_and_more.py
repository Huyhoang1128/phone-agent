# Adds AI rewrite fields to FacebookProfileScheduledPost.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0016_alter_facebookgroupscheduledpost_status_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookprofilescheduledpost',
            name='ai_prompt',
            field=models.TextField(
                blank=True,
                default='',
                help_text=(
                    'Prompt người dùng cấp khi import để AI rewrite content theo phong '
                    'cách mong muốn (mặc định: phong cách bác sĩ y khoa). Rỗng = không '
                    'enable AI rewrite cho row này.'
                ),
            ),
        ),
        migrations.AddField(
            model_name='facebookprofilescheduledpost',
            name='ai_rewritten_content',
            field=models.TextField(
                blank=True,
                default='',
                help_text=(
                    'Bản nháp do AI rewrite. User review → accept → backend chuyển vào '
                    '`content` để publish. Khi accept xong field này clear.'
                ),
            ),
        ),
    ]
