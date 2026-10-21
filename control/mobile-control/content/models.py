import hashlib

from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone
from mbcontrol.constants import TeamPermission


class ContentSourceType(models.TextChoices):
    """Where the content record came from.

    MANUAL    — created via the "Nội dung mới" button (operator typed it in).
    GENERATED — produced by the "Gen Content" AI flow, derived from a parent
                xlsx scenario. Carries kb_name / od_number / frames metadata.
    """
    MANUAL = 'manual', 'Manual'
    GENERATED = 'generated', 'AI-generated'


class ContentMode(models.TextChoices):
    """Generation mode passed to n8n (and stored so the editor can lock
    structural fields appropriately).

    REAL_FOOTAGE — kịch bản đi kèm clip kho thật (Footage/Time/Note do
                   match-engine / catalog quyết → KHOÁ ở editor).
    AI_VIDEO     — clip sẽ sinh bằng AI → mọi field mở edit.
    """
    REAL_FOOTAGE = 'real_footage', 'Real footage'
    AI_VIDEO = 'ai_video', 'AI video'


class Content(models.Model):
    title = models.CharField(max_length=255)
    video_url = models.URLField(max_length=2048, blank=True, default='')
    image_urls = models.JSONField(default=list, blank=True, null=True)
    text_content = models.TextField(blank=True, null=True, default='')
    file_url = models.URLField(max_length=2048, blank=True, null=True, default='')
    script = models.TextField(blank=True, default='')
    # ── Generation provenance (only meaningful for source_type='generated') ──
    source_type = models.CharField(
        max_length=20,
        choices=ContentSourceType.choices,
        default=ContentSourceType.MANUAL,
    )
    # e.g. "KB1", "KB2" — slot of the generated record within its batch.
    kb_name = models.CharField(max_length=64, blank=True, default='')
    # e.g. "OD 365" — order number from the source scenario.
    od_number = models.CharField(max_length=64, blank=True, default='')
    # Name of the xlsx file used as the template. We deliberately do NOT
    # upload that file to storage in v1 — only the filename is kept for
    # provenance ("which template did this come from?").
    parent_scenario_filename = models.CharField(max_length=255, blank=True, default='')
    # Raw frame list as returned by the n8n webhook. Each frame is a dict
    # carrying Phần / Frame / Voice / Text / Visual / Music /
    # Footage / Source / Time / Note.
    frames = models.JSONField(default=list, blank=True)
    # IMMUTABLE snapshot of frames at the moment of generation. The "Khôi
    # phục bản gốc" button in ContentDetailPage restores from here. We
    # intentionally never write back to this column from the editor or
    # /refine-frame so it always represents the n8n original.
    origin_frames = models.JSONField(default=list, blank=True)
    # Mode the script was generated in. Drives edit-lock behaviour
    # (real_footage → Footage/Time/Note read-only).
    mode = models.CharField(
        max_length=20,
        choices=ContentMode.choices,
        default=ContentMode.REAL_FOOTAGE,
        blank=True,
    )
    # ─────────────────────────────────────────────────────────────────────────
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='contents')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='contents')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title


class ContentScriptChatMessage(models.Model):
    """One turn of the AI-refine chat panel attached to a Content (= 1 KB).

    1 Content has 1 thread (each KB của 1 batch nằm trong 1 Content row riêng,
    nên thread không cần kb_name routing — đã ngầm định qua FK).
    """
    class SenderType(models.TextChoices):
        USER = 'USER', 'User'
        ASSISTANT = 'ASSISTANT', 'Assistant'

    content = models.ForeignKey(
        Content,
        on_delete=models.CASCADE,
        related_name='script_chat_messages',
    )
    owner = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='content_script_chat_messages',
    )
    sender = models.CharField(max_length=16, choices=SenderType.choices)
    body = models.TextField()
    # User dùng nút "💬 Hỏi AI về frame này" → FE đính kèm frame_target;
    # system prompt sẽ chèn nội dung frame đó vào context để AI trả lời sát.
    frame_target = models.PositiveIntegerField(null=True, blank=True)
    llm_model = models.CharField(max_length=64, blank=True, default='')
    # When ASSISTANT triggered the apply_frame_patch tool, this stores the
    # candidate frame patches (one per frame_index) so the FE can render an
    # Apply/Discard card inline in the bubble. Schema:
    #   [{"frame_index": 1,
    #     "before": {"Voice": "...", "Text": "...", "Visual": "...", "Music": "..."},
    #     "after":  {"Voice": "...", "Text": "...", "Visual": "...", "Music": "..."}}]
    # Empty list = no patch (plain advice turn).
    attached_patches = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['content', '-created_at']),
        ]

    def __str__(self):
        return f"[{self.sender}] {self.content_id}: {self.body[:40]}"


class ContentScriptAuditLog(models.Model):
    """Audit trail cho mọi update/refine/restore trên frames. Dùng để cứu user
    khi gặp last-write-wins (2 user cùng edit) và để admin tra lịch sử."""
    class Action(models.TextChoices):
        UPDATE = 'update', 'Update field'
        REFINE = 'refine', 'AI refine'
        RESTORE_FRAME = 'restore_frame', 'Restore frame from origin'
        RESTORE_ALL = 'restore_all', 'Restore all frames from origin'

    content = models.ForeignKey(
        Content,
        on_delete=models.CASCADE,
        related_name='script_audits',
    )
    actor = models.ForeignKey(
        User,
        null=True,
        on_delete=models.SET_NULL,
        related_name='+',
    )
    action = models.CharField(max_length=32, choices=Action.choices)
    frame_index = models.PositiveIntegerField(null=True, blank=True)
    fields_changed = models.JSONField(default=dict, blank=True)
    previous_value = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['content', '-created_at']),
        ]

    def __str__(self):
        return f"{self.action} on Content #{self.content_id} frame={self.frame_index}"


class CrawlSourceType(models.TextChoices):
    WEB = 'web', 'Web (No sign-in required)'
    FACEBOOK = 'facebook', 'Facebook'
    TIKTOK = 'tiktok', 'TikTok'
    YOUTUBE = 'youtube', 'YouTube'
    THREADS = 'threads', 'Threads'


class CrawlRunStatus(models.TextChoices):
    RUNNING = 'running', 'Running'
    SUCCESS = 'success', 'Success'
    FAILED = 'failed', 'Failed'


class CrawlSource(models.Model):
    url = models.URLField(max_length=2048)
    source_type = models.CharField(
        max_length=20,
        choices=CrawlSourceType.choices,
        default=CrawlSourceType.WEB,
    )
    device = models.ForeignKey(
        'devices.Device',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_sources',
    )
    crawl_frequency_minutes = models.PositiveIntegerField(default=60)
    is_active = models.BooleanField(default=True)
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_sources',
    )
    team = models.ForeignKey(
        'teams.Team',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_sources',
    )
    team_permission = models.CharField(
        max_length=10,
        choices=TeamPermission.choices,
        default=TeamPermission.VIEW,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"[{self.source_type}] {self.url}"


class CrawlRun(models.Model):
    crawl_source = models.ForeignKey(
        CrawlSource,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_runs',
    )
    source_url = models.URLField(max_length=2048)
    status = models.CharField(max_length=20, choices=CrawlRunStatus.choices, default=CrawlRunStatus.RUNNING)
    started_at = models.DateTimeField(default=timezone.now)
    finished_at = models.DateTimeField(null=True, blank=True)
    item_count = models.PositiveIntegerField(default=0)
    new_item_count = models.PositiveIntegerField(default=0)
    updated_item_count = models.PositiveIntegerField(default=0)
    triggered_by = models.CharField(max_length=255, blank=True, default='')
    error_message = models.TextField(blank=True, default='')
    summary = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-started_at', '-created_at']

    def __str__(self):
        return f"{self.source_url} [{self.status}]"


class CrawlContentSnapshot(models.Model):
    crawl_source = models.ForeignKey(
        CrawlSource,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_snapshots',
    )
    content = models.ForeignKey(
        Content,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='crawl_snapshots',
    )
    latest_run = models.ForeignKey(
        CrawlRun,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='latest_snapshots',
    )
    source_index_url = models.URLField(max_length=2048)
    content_url = models.URLField(max_length=2048)
    content_type = models.CharField(max_length=50, blank=True, default='page')
    title = models.CharField(max_length=255, blank=True, default='')
    summary = models.TextField(blank=True, default='')
    content_body = models.TextField(blank=True, default='')
    payload = models.JSONField(default=dict, blank=True)
    media_file_urls = models.JSONField(default=list, blank=True)
    checksum = models.CharField(max_length=255, blank=True, default='')
    version = models.CharField(max_length=255, blank=True, default='')
    dedupe_key = models.CharField(max_length=64, unique=True, editable=False)
    first_crawled_at = models.DateTimeField(default=timezone.now)
    crawled_at = models.DateTimeField(default=timezone.now)
    last_updated_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-last_updated_at', '-updated_at']
        indexes = [
            models.Index(fields=['source_index_url']),
            models.Index(fields=['content_url']),
            models.Index(fields=['-last_updated_at']),
        ]

    def __str__(self):
        return self.title or self.content_url

    def build_dedupe_key(self):
        raw = '||'.join([
            (self.source_index_url or '').strip(),
            (self.content_url or '').strip(),
            (self.content_type or '').strip(),
        ])
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    def save(self, *args, **kwargs):
        self.dedupe_key = self.build_dedupe_key()
        if not self.first_crawled_at:
            self.first_crawled_at = timezone.now()
        if not self.crawled_at:
            self.crawled_at = timezone.now()
        if not self.last_updated_at:
            self.last_updated_at = self.crawled_at
        super().save(*args, **kwargs)


class CrawlRunItem(models.Model):
    crawl_run = models.ForeignKey(CrawlRun, on_delete=models.CASCADE, related_name='items')
    snapshot = models.ForeignKey(CrawlContentSnapshot, on_delete=models.CASCADE, related_name='run_items')
    is_new = models.BooleanField(default=False)
    is_updated = models.BooleanField(default=False)
    discovered_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['id']
        unique_together = [('crawl_run', 'snapshot')]

    def __str__(self):
        return f"run={self.crawl_run_id} snapshot={self.snapshot_id}"


class Character(models.Model):
    """A saved face-swap character — source image + all generated media stored in S3."""
    name = models.CharField(max_length=255)
    source_image_url = models.URLField(max_length=2048, blank=True, default='')
    # The LLM-generated identity prompt that created this character. Persisted so
    # "add media" later reuses the exact same description, keeping the person
    # consistent across new scenes instead of falling back to a generic prompt.
    face_prompt = models.TextField(blank=True, default='')
    # The character's nationality / home country (e.g. "Việt Nam", "Philippines"),
    # captured at creation. Persisted so every later scene generation — including
    # "add media" on a saved character — grounds the setting in the right country
    # instead of drifting (a Filipino character no longer gets a Vietnamese park).
    nation = models.CharField(max_length=100, blank=True, default='')
    # ── Structured appearance blocks ──────────────────────────────────────
    # A photoshoot-brief prompt splits into blocks that stay CONSTANT for the
    # character (these four) and blocks that change per scene (posture, location,
    # lighting…). Storing them separately lets the wizard show one editable box
    # per block, and lets every scene reuse the character verbatim.
    # ``face_prompt`` above remains the legacy single-blob description: characters
    # created before this split have only that, so readers fall back to it when
    # these four are empty.
    subject = models.TextField(blank=True, default='', help_text='Skin tone and build. Tasteful, non-sexual.')
    hair = models.TextField(blank=True, default='', help_text='Length, texture, colour, bangs.')
    nails = models.TextField(blank=True, default='', help_text='Length, shape, colour, tips.')
    face_makeup = models.TextField(blank=True, default='', help_text='Makeup tones, eyes, lips, highlighter.')
    # The character's media set: source image + face-swapped results.
    # Each item: {"url": "https://...", "created_at": "<ISO 8601>"}
    media = models.JSONField(default=list, blank=True)
    # Separate store for the raw AI-generated scene images (before face-swap).
    # Same item shape as ``media``.
    scenes = models.JSONField(default=list, blank=True)
    # Generated videos (genvideo) kept for this character. Each item:
    # {"url": "https://...", "created_at": "<ISO 8601>"}. URLs are external
    # (genvideo), NOT the private S3 bucket, so they are not presigned on read.
    videos = models.JSONField(default=list, blank=True)
    # Soft-delete: "delete" from the UI just hides the character; the row and its
    # S3 media stay in the DB (recoverable, and keeps usage history intact).
    hidden = models.BooleanField(default=False, db_index=True)
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='characters')
    team = models.ForeignKey('teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='characters')
    team_permission = models.CharField(max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class CharacterPostPlatform(models.TextChoices):
    """Which social platform a character photo-post targets.

    Each value maps to a distinct dispatch path in
    ``content.views._dispatch_character_post``:
      - TIKTOK / FACEBOOK_PROFILE → phoneagent device automation (Kafka task)
      - FACEBOOK_PAGE / FACEBOOK_GROUP → Facebook Graph API (server-side)
    """
    TIKTOK = 'tiktok', 'TikTok'
    FACEBOOK_PROFILE = 'facebook_profile', 'Facebook cá nhân'
    FACEBOOK_PAGE = 'facebook_page', 'Facebook Page'
    FACEBOOK_GROUP = 'facebook_group', 'Facebook Group'


class CharacterScheduledPostStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    PUBLISHING = 'publishing', 'Publishing'
    PUBLISHED = 'published', 'Published'
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'


class CharacterScheduledPost(models.Model):
    """A character photo-post queued for automatic publishing at a set time.

    One row = one post to one platform target. The scheduler poller
    (``schedule.scheduler._poll_character_scheduled_posts``) re-presigns the
    stored image URLs fresh at publish time and reuses the same dispatch path
    as the immediate ``CharacterViewSet.post_photos`` endpoint, so scheduled
    and instant posts behave identically across all platforms.
    """
    character = models.ForeignKey(
        Character, on_delete=models.CASCADE, related_name='scheduled_posts',
    )
    platform = models.CharField(max_length=32, choices=CharacterPostPlatform.choices)
    # Stored (raw) media URLs. Re-presigned at publish time so the device /
    # Graph API always gets a fresh, unexpired link no matter how far out the
    # post is scheduled.
    image_urls = models.JSONField(default=list, blank=True)
    caption = models.TextField(blank=True, default='')
    hashtags = models.JSONField(default=list, blank=True)
    # Target — only the FK matching ``platform`` is populated.
    device = models.ForeignKey(
        'devices.Device', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    profile = models.ForeignKey(
        'profiles.Profile', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    fb_profile = models.ForeignKey(
        'facebook.FacebookProfile', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    fb_page = models.ForeignKey(
        'facebook.FacebookPage', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    fb_group = models.ForeignKey(
        'facebook.FacebookGroup', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    scheduled_at = models.DateTimeField(db_index=True, help_text='When to publish this post')
    status = models.CharField(
        max_length=20,
        choices=CharacterScheduledPostStatus.choices,
        default=CharacterScheduledPostStatus.PENDING,
        db_index=True,
    )
    error_msg = models.TextField(blank=True, default='')
    task = models.ForeignKey(
        'task.Task', null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='character_scheduled_posts',
    )
    team = models.ForeignKey(
        'teams.Team', null=True, blank=True, on_delete=models.SET_NULL, related_name='character_scheduled_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at', 'id']

    def __str__(self):
        return f"CharacterScheduledPost #{self.id} {self.platform} @ {self.scheduled_at} [{self.status}]"


class FeatureSystemPrompt(models.Model):
    """System prompt configuration scoped by (feature_id, user).

    - user is NULL: default prompt for the feature
    - user is set : user override for that feature
    """

    feature_id = models.CharField(max_length=100)
    user = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='feature_system_prompts',
    )
    system_prompt = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['feature_id', 'user_id']
        constraints = [
            models.UniqueConstraint(
                fields=['feature_id', 'user'],
                name='uniq_feature_system_prompt_per_user',
            ),
        ]

    def __str__(self):
        owner = self.user.username if self.user_id else 'default'
        return f"{self.feature_id}::{owner}"


class ImageGenerationLog(models.Model):
    """One row per image-generation API call (OpenAI gpt-image or a fal.ai model —
    Grok/Seedream), for per-account daily usage reporting (how many calls were
    made, how many images were produced) and per-provider cost tracking."""

    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='image_gen_logs',
    )
    # True when the call returned an image; False when it failed / was blocked.
    success = models.BooleanField(default=True)
    # 'openai' / 'grok' / 'seedream45' (ImageProvider values — see fal_utils.FAL_MODELS
    # and ContentViewSet.generate_image). null on rows written before this field
    # existed: those predate provider tracking, NOT necessarily 'openai' (fal.ai
    # models were already in use), so leave them unknown rather than backfill a guess.
    provider = models.CharField(max_length=32, null=True, blank=True)
    # Công ty (tenant) đã gọi lượt này — sao chép từ ``UserProfile.ai_tenant`` của
    # owner tại thời điểm gọi. Lưu ĐÈ (denormalise) chứ không join qua owner mỗi lần
    # truy vấn, vì đây là bản ghi tài chính: chuyển một tài khoản sang công ty khác
    # về sau KHÔNG được làm đổi hoá đơn của những tháng đã qua. Rỗng = tài khoản chưa
    # gán công ty (dùng key mặc định của server).
    #
    #   SELECT tenant, COUNT(*) FROM content_imagegenerationlog
    #    WHERE success AND created_at >= '2026-08-01' GROUP BY tenant;
    tenant = models.CharField(max_length=32, blank=True, default='', db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['owner', 'created_at']),
            # Sao kê theo công ty theo tháng — cột dẫn đầu là tenant vì mọi câu truy
            # vấn đối chiếu hoá đơn đều lọc/nhóm theo nó trước.
            models.Index(fields=['tenant', 'created_at']),
        ]

    def __str__(self):
        who = self.owner.username if self.owner_id else 'anon'
        where = f'@{self.tenant}' if self.tenant else ''
        return f"imagegen::{who}{where}::{'ok' if self.success else 'fail'}"
