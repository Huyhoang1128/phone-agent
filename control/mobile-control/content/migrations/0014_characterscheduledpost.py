import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("content", "0013_character_hidden_imagegenlog"),
        ("devices", "0011_device_is_active"),
        ("facebook", "0018_facebookprofilescheduledmediaaction"),
        ("profiles", "0012_profile_topics_and_topic_audit_logs"),
        ("task", "0007_rename_task_task_owner_0cb429_idx_task_task_owner_i_90ed30_idx_and_more"),
        ("teams", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="CharacterScheduledPost",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "platform",
                    models.CharField(
                        choices=[
                            ("tiktok", "TikTok"),
                            ("facebook_profile", "Facebook cá nhân"),
                            ("facebook_page", "Facebook Page"),
                            ("facebook_group", "Facebook Group"),
                        ],
                        max_length=32,
                    ),
                ),
                ("image_urls", models.JSONField(blank=True, default=list)),
                ("caption", models.TextField(blank=True, default="")),
                ("hashtags", models.JSONField(blank=True, default=list)),
                (
                    "scheduled_at",
                    models.DateTimeField(
                        db_index=True, help_text="When to publish this post"
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("publishing", "Publishing"),
                            ("published", "Published"),
                            ("failed", "Failed"),
                            ("cancelled", "Cancelled"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("error_msg", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "character",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="scheduled_posts",
                        to="content.character",
                    ),
                ),
                (
                    "device",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="devices.device",
                    ),
                ),
                (
                    "fb_group",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="facebook.facebookgroup",
                    ),
                ),
                (
                    "fb_page",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="facebook.facebookpage",
                    ),
                ),
                (
                    "fb_profile",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="facebook.facebookprofile",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="character_scheduled_posts",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "profile",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="profiles.profile",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="task.task",
                    ),
                ),
                (
                    "team",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="character_scheduled_posts",
                        to="teams.team",
                    ),
                ),
            ],
            options={
                "ordering": ["scheduled_at", "id"],
            },
        ),
    ]
