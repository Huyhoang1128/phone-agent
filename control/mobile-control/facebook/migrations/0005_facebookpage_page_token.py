from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0004_facebookpostusercomment'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookpage',
            name='page_token',
            field=models.TextField(blank=True, default=''),
        ),
    ]