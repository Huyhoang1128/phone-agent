from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('facebook', '0027_fbhackkey'),
    ]

    operations = [
        migrations.AddField(
            model_name='facebookscheduledpostcommentplan',
            name='root_plan',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='replies',
                to='facebook.facebookscheduledpostcommentplan',
            ),
        ),
    ]
