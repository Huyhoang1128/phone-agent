from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('content', '0018_imagegenerationlog_provider'),
    ]

    operations = [
        migrations.AddField(
            model_name='imagegenerationlog',
            name='tenant',
            field=models.CharField(blank=True, db_index=True, default='', max_length=32),
        ),
        migrations.AddIndex(
            model_name='imagegenerationlog',
            index=models.Index(fields=['tenant', 'created_at'],
                               name='content_ima_tenant_d1d073_idx'),
        ),
    ]
