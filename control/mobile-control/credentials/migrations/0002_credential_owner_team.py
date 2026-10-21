from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('auth', '0012_alter_user_first_name_max_length'),
        ('credentials', '0001_initial'),
        ('teams', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='credential',
            name='owner',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name='credentials', to='auth.user',
            ),
        ),
        migrations.AddField(
            model_name='credential',
            name='team',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name='credentials', to='teams.team',
            ),
        ),
        migrations.AddField(
            model_name='credential',
            name='team_permission',
            field=models.CharField(
                choices=[('view', 'View'), ('edit', 'Edit')],
                default='view',
                max_length=10,
            ),
        ),
    ]
