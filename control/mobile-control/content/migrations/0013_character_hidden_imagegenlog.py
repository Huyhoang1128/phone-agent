import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('content', '0012_character_face_prompt'),
    ]

    operations = [
        migrations.AddField(
            model_name='character',
            name='hidden',
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.CreateModel(
            name='ImageGenerationLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('success', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='image_gen_logs', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='imagegenerationlog',
            index=models.Index(fields=['owner', 'created_at'], name='content_ima_owner_i_idx'),
        ),
    ]
