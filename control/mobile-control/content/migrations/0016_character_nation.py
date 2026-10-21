from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0015_rename_content_csa_log_content_idx_content_con_content_6e47ce_idx_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='character',
            name='nation',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
    ]
