from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0003_userprofile_token_version'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='ai_tenant',
            field=models.CharField(
                blank=True,
                db_index=True,
                default='',
                help_text=(
                    'Slug công ty để chọn key AI khi sinh ảnh (vd "ctya"). Phải khớp '
                    'AI_TENANT_OPENAI_KEYS trong .env. Để trống = dùng key mặc định của server.'
                ),
                max_length=32,
            ),
        ),
    ]
