from django.contrib.auth.models import User
from django.db import models


class WebsiteType(models.TextChoices):
    WORDPRESS = 'wordpress', 'WordPress'


class Website(models.Model):
    """A website the user can publish posts to. v1 supports WordPress via its
    REST API (Application Password / Basic Auth)."""

    name = models.CharField(max_length=255)
    site_type = models.CharField(max_length=20, choices=WebsiteType.choices, default=WebsiteType.WORDPRESS)
    base_url = models.URLField(max_length=500)
    # WordPress auth: username + Application Password (used as HTTP Basic Auth).
    # wp_app_password is write-only in the API (never serialized back).
    # TODO: encrypt at rest (no field-encryption helper in the project yet).
    wp_username = models.CharField(max_length=255, blank=True, default='')
    wp_app_password = models.TextField(blank=True, default='')
    is_active = models.BooleanField(default=True)
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='websites',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.name} ({self.base_url})'


class WebsitePostStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'        # waiting to be published (manual or scheduled)
    PUBLISHED = 'published', 'Published'  # successfully pushed to the website
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'


class WordPressStatus(models.TextChoices):
    PUBLISH = 'publish', 'Publish'  # live on the site
    DRAFT = 'draft', 'Draft'        # saved as draft for manual review


class WebsitePost(models.Model):
    """A post to publish to a Website. Pushed to WordPress with the chosen
    ``wp_status`` (publish | draft). ``status`` tracks our pipeline state."""

    website = models.ForeignKey(Website, on_delete=models.CASCADE, related_name='posts')
    title = models.CharField(max_length=500)
    content = models.TextField(blank=True, default='')
    excerpt = models.TextField(blank=True, default='')
    slug = models.CharField(max_length=255, blank=True, default='')
    image_url = models.URLField(max_length=2048, blank=True, default='')
    # WordPress media ID for the featured image (set when the user uploads a
    # local file straight to the site's media library). Takes priority over
    # image_url at publish time (no re-download needed).
    featured_media_id = models.IntegerField(null=True, blank=True)
    # WordPress taxonomy term IDs (resolved against the target site).
    categories = models.JSONField(default=list, blank=True)
    tags = models.JSONField(default=list, blank=True)
    # Images resolved from the import Sheet (thumbnail + in-article cells, Drive
    # folders expanded) and uploaded to the WP media library. Shown as a tray in
    # the editor so the user picks which one to insert where — not auto-embedded.
    source_images = models.JSONField(default=list, blank=True)
    # WordPress publish state for this post: publish (live) or draft.
    wp_status = models.CharField(max_length=10, choices=WordPressStatus.choices, default=WordPressStatus.PUBLISH)
    status = models.CharField(max_length=20, choices=WebsitePostStatus.choices, default=WebsitePostStatus.PENDING)
    scheduled_at = models.DateTimeField(null=True, blank=True)
    wp_post_id = models.CharField(max_length=64, blank=True, default='')
    post_url = models.URLField(max_length=2048, blank=True, default='')
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='website_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at', '-created_at']
        indexes = [
            models.Index(fields=['status', 'scheduled_at'], name='websites_we_status_idx'),
        ]

    def __str__(self):
        return f'{self.title} → website#{self.website_id}'
