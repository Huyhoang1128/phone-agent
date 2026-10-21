from django.contrib.auth.models import User
from django.db import models


class FacebookPageStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    PAUSED = 'paused', 'Paused'
    ARCHIVED = 'archived', 'Archived'


class FacebookPage(models.Model):
    """A Facebook fan page (entity) the user operates or tracks.

    Mirrors the ownership model of ``tiktok.TiktokVideo``: owner-scoped with an
    optional team_id for sharing.
    """

    name = models.CharField(max_length=255)
    page_url = models.URLField(max_length=2048, blank=True, default='')
    page_uid = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook page ID or username (the part after facebook.com/)',
    )
    page_token = models.TextField(blank=True, default='')
    category = models.CharField(max_length=255, blank=True, default='')
    description = models.TextField(blank=True, default='')
    follower_count = models.BigIntegerField(default=0)
    status = models.CharField(
        max_length=20,
        choices=FacebookPageStatus.choices,
        default=FacebookPageStatus.ACTIVE,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_pages',
    )
    team_id = models.IntegerField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Page #{self.id} – {self.name}"


class FacebookGroupStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    PAUSED = 'paused', 'Paused'
    ARCHIVED = 'archived', 'Archived'


class FacebookGroup(models.Model):
    """A Facebook Group the user manages."""

    name = models.CharField(max_length=255)
    group_url = models.URLField(max_length=2048, blank=True, default='')
    group_uid = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook group ID or username',
    )
    description = models.TextField(blank=True, default='')
    member_count = models.BigIntegerField(default=0)
    group_token = models.TextField(
        blank=True,
        default='',
        help_text='User access token with publish_to_groups for posting via Graph API',
    )
    admin_profile = models.ForeignKey(
        'profiles.Profile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_admin_groups',
    )
    # FB account that has admin rights in this group. Used as the device
    # operator for:
    #   * approving/rejecting member-pending posts (phase 2)
    #   * seeding via like / comment / reply (phase 3)
    # ``admin_profile`` above stays as the personality/agent profile that
    # drives AI-generated comment content.
    admin_fb_profile = models.ForeignKey(
        'FacebookProfile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='admin_groups',
        help_text='Tài khoản FB cá nhân làm admin group — duyệt post + seeding qua phoneagent.',
    )
    # FB profile mặc định dùng để ĐĂNG bài cho group này. Khác hẳn admin
    # profile (chỉ duyệt). Mọi row trong FacebookGroupScheduledPost tạo qua
    # CSV import sẽ inherit FK này; user có thể đổi từng row sau đó.
    default_poster_fb_profile = models.ForeignKey(
        'FacebookProfile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='default_poster_groups',
        help_text='Tài khoản FB sẽ tap nút Đăng (ẩn danh) khi cron fire. Khác với admin (chỉ duyệt).',
    )
    status = models.CharField(
        max_length=20,
        choices=FacebookGroupStatus.choices,
        default=FacebookGroupStatus.ACTIVE,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_groups',
    )
    team_id = models.IntegerField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Group #{self.id} – {self.name}"


class FacebookPostStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    LIKED = 'liked', 'Liked'
    COMMENTED = 'commented', 'Commented'
    SHARED = 'shared', 'Shared'


class FacebookPost(models.Model):
    """A post belonging to a Facebook page. Analog of ``tiktok.TiktokVideo``."""

    page = models.ForeignKey(
        FacebookPage,
        on_delete=models.CASCADE,
        related_name='posts',
    )
    post_url = models.URLField(max_length=2048, blank=True, default='')
    image_url = models.URLField(max_length=2048, blank=True, default='', help_text='Legacy single image; mirrors image_urls[0]')
    image_urls = models.JSONField(default=list, blank=True, help_text='List of image URLs to attach to this post')
    caption = models.TextField(null=True, blank=True)
    content = models.TextField(blank=True, default='')
    keywords = models.JSONField(default=list, blank=True, help_text='Keywords/tags for this post')
    status = models.CharField(
        max_length=20,
        choices=FacebookPostStatus.choices,
        default=FacebookPostStatus.PENDING,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Post #{self.id} on page #{self.page_id} – {self.status}"


class FacebookInteractionType(models.TextChoices):
    LIKE = 'like', 'Like'
    COMMENT = 'comment', 'Comment'
    SHARE = 'share', 'Share'
    REPLY = 'reply', 'Reply'


class FacebookPostInteraction(models.Model):
    """An interaction (like/comment/share) recorded on a Facebook post.

    Analog of ``tiktok.TiktokVideoInteraction``.
    """

    post = models.ForeignKey(
        FacebookPost,
        on_delete=models.CASCADE,
        related_name='interactions',
    )
    interaction_type = models.CharField(
        max_length=10,
        choices=FacebookInteractionType.choices,
    )
    profile_username = models.CharField(max_length=255, blank=True, default='')
    profile_avatar_url = models.URLField(max_length=2048, blank=True, default='')
    comment_content = models.TextField(blank=True, default='')
    comment_link = models.URLField(max_length=2048, blank=True, default='')
    interacted_at = models.DateTimeField(null=True, blank=True)
    # Shared highlight flags (consistent across users), like the TikTok page.
    replay_task_dispatched = models.BooleanField(default=False)
    dig_comment_dispatched = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.interaction_type} on FB post #{self.post_id} by {self.profile_username}"


class FacebookCommentPlan(models.Model):
    """A planned comment for a Facebook post. Analog of ``tiktok.TiktokCommentPlan``."""

    class ExecutionStatus(models.TextChoices):
        IDLE = 'idle', 'Idle'
        SCHEDULED = 'scheduled', 'Scheduled'
        RUNNING = 'running', 'Running'
        COMPLETED = 'completed', 'Completed'
        FAILED = 'failed', 'Failed'

    post = models.ForeignKey(
        FacebookPost,
        on_delete=models.CASCADE,
        related_name='comment_plans',
    )
    post_link = models.URLField(max_length=2048, blank=True, default='')
    agent_group = models.ForeignKey(
        'agent_groups.AgentGroup',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_comment_plans',
    )
    profile = models.ForeignKey(
        'profiles.Profile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_comment_plans',
    )
    device = models.ForeignKey(
        'devices.Device',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_comment_plans',
    )
    comment_content = models.TextField(blank=True, default='')
    comment_link = models.URLField(max_length=2048, blank=True, default='')
    reply_to = models.TextField(blank=True, default='')
    is_approved = models.BooleanField(default=False)
    is_commented = models.BooleanField(default=False)
    execution_status = models.CharField(
        max_length=20,
        choices=ExecutionStatus.choices,
        default=ExecutionStatus.IDLE,
    )
    execution_retry_count = models.PositiveIntegerField(default=0)
    execution_last_error = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_comment_plans',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB comment plan #{self.id} for post #{self.post_id}"


class FacebookScheduledPostStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    # PUBLISHING is set after the post has been dispatched to a phoneagent
    # Task but the agent has not yet confirmed the result. Cron skips these
    # so the same post is not re-dispatched while in flight.
    PUBLISHING = 'publishing', 'Publishing'
    PUBLISHED = 'published', 'Published'
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'


class FacebookScheduledPost(models.Model):
    """A post queued for automatic publishing to a Facebook page via the Graph API.

    The content (text + image S3 URLs) is stored here.  A management command
    (``publish_facebook_posts``) calls the Facebook Graph API when
    ``scheduled_at`` is reached and ``status`` is still ``pending``.
    """

    page = models.ForeignKey(
        FacebookPage,
        on_delete=models.CASCADE,
        related_name='scheduled_posts',
    )
    content = models.TextField(blank=True, default='')
    image_urls = models.JSONField(
        default=list,
        blank=True,
        help_text='List of S3 (or public) image URLs to attach to this post',
    )
    image_description = models.TextField(
        blank=True,
        default='',
        help_text='Optional image prompt/description for future image generation',
    )
    topic = models.CharField(
        max_length=64,
        blank=True,
        default='',
        help_text='Topic/category tag (free text; UI suggests an enum list)',
    )
    scheduled_at = models.DateTimeField(
        help_text='When to publish this post to Facebook',
        db_index=True,
    )
    status = models.CharField(
        max_length=20,
        choices=FacebookScheduledPostStatus.choices,
        default=FacebookScheduledPostStatus.PENDING,
        db_index=True,
    )
    fb_post_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook post ID returned by the Graph API after publishing',
    )
    buffed_like_total = models.PositiveIntegerField(
        default=0,
        help_text='Cumulative number of reactions ordered via hacklike for this post.',
    )
    buffed_at = models.DateTimeField(
        null=True, blank=True,
        help_text='Last time reactions were buffed for this post.',
    )
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_scheduled_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at']

    def __str__(self):
        return f"Scheduled post #{self.id} for page #{self.page_id} at {self.scheduled_at} [{self.status}]"


class FacebookGroupPost(models.Model):
    """A post belonging to a Facebook group. Mirror of FacebookPost."""

    group = models.ForeignKey(
        FacebookGroup,
        on_delete=models.CASCADE,
        related_name='posts',
    )
    post_url = models.URLField(max_length=2048, blank=True, default='')
    image_url = models.URLField(max_length=2048, blank=True, default='', help_text='Legacy single image; mirrors image_urls[0]')
    image_urls = models.JSONField(default=list, blank=True, help_text='List of image URLs to attach to this post')
    caption = models.TextField(null=True, blank=True)
    content = models.TextField(blank=True, default='')
    keywords = models.JSONField(default=list, blank=True, help_text='Keywords/tags for this post')
    status = models.CharField(
        max_length=20,
        choices=FacebookPostStatus.choices,
        default=FacebookPostStatus.PENDING,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_group_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Group Post #{self.id} on group #{self.group_id} – {self.status}"


class FacebookGroupScheduledPost(models.Model):
    """A post queued for automatic publishing to a Facebook group via Graph API.

    Mirror of FacebookScheduledPost — content + image URLs are stored here; a
    publisher picks up rows whose ``scheduled_at`` has elapsed.
    """

    group = models.ForeignKey(
        FacebookGroup,
        on_delete=models.CASCADE,
        related_name='scheduled_posts',
    )
    content = models.TextField(blank=True, default='')
    image_urls = models.JSONField(
        default=list,
        blank=True,
        help_text='List of S3 (or public) image URLs to attach to this post',
    )
    image_description = models.TextField(
        blank=True,
        default='',
        help_text='Optional image prompt/description for future image generation',
    )
    topic = models.CharField(
        max_length=64,
        blank=True,
        default='',
        help_text='Topic/category tag (free text; UI suggests an enum list)',
    )
    scheduled_at = models.DateTimeField(
        help_text='When to publish this post to the Facebook group',
        db_index=True,
    )
    status = models.CharField(
        max_length=20,
        choices=FacebookScheduledPostStatus.choices,
        default=FacebookScheduledPostStatus.PENDING,
        db_index=True,
    )
    # Approval workflow: admin FB profile must approve a post before the cron
    # picks it up. The cron filter is ``status=PENDING AND is_approved=True
    # AND scheduled_at <= now``. Posts default to False — created in a
    # "chờ duyệt" state until the admin explicitly accepts.
    is_approved = models.BooleanField(
        default=False,
        db_index=True,
        help_text='Admin FB profile đã duyệt — cron chỉ fire khi True.',
    )
    # Tài khoản FB tap nút Đăng. Phải khác admin. Inherit từ
    # group.default_poster_fb_profile khi CSV import; có thể edit từng row.
    # Nullable: row cũ + CSV import vào group chưa cấu hình poster vẫn tạo
    # được, nhưng publish_due sẽ fail với error_msg rõ ràng.
    poster_fb_profile = models.ForeignKey(
        'FacebookProfile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='poster_group_scheduled_posts',
        help_text='Tài khoản FB sẽ thực sự đăng bài này lên app (ẩn danh).',
    )
    fb_post_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook post ID/URL returned after publishing',
    )
    buffed_like_total = models.PositiveIntegerField(
        default=0,
        help_text='Cumulative number of reactions ordered via hacklike for this post.',
    )
    buffed_at = models.DateTimeField(
        null=True, blank=True,
        help_text='Last time reactions were buffed for this post.',
    )
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_group_scheduled_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at']

    def __str__(self):
        return f"Scheduled group post #{self.id} for group #{self.group_id} at {self.scheduled_at} [{self.status}]"


class FacebookGroupPendingMemberPostStatus(models.TextChoices):
    QUEUED = 'queued', 'Queued'  # freshly scraped, awaiting admin decision
    PROCESSING = 'processing', 'Processing'  # phoneagent dispatched, in flight
    APPROVED = 'approved', 'Approved'
    REJECTED = 'rejected', 'Rejected'
    FAILED = 'failed', 'Failed'  # phoneagent reported failure


class FacebookGroupPendingTab(models.TextChoices):
    """Which admin queue tab the pending post came from inside the FB app.

    FB splits member submissions across two admin tabs:
      * ``approval``     — "Bài viết đang chờ" (group has Post Approval enabled;
                           every member post lands here pending admin OK).
      * ``maybe_spam``   — "Có thể là spam" (FB's automated spam classifier flagged
                           the post; admin must approve or reject manually).

    Default is ``approval`` for backward-compat with rows created before this
    field was added.
    """
    APPROVAL = 'approval', 'Bài viết đang chờ'
    MAYBE_SPAM = 'maybe_spam', 'Có thể là spam'


class FacebookGroupPendingMemberPost(models.Model):
    """A post a member submitted to a Facebook group that's awaiting admin
    approval inside the FB app.

    Rows are populated by a phoneagent "fetch pending posts" task — the agent
    opens the group's Pending Posts tab, scrapes the visible list, and the
    devices_worker upserts these rows from the Kafka result payload. Admin
    decisions (approve / reject) dispatch a second phoneagent task that
    drives the FB app UI; this row's status mirrors that task's outcome.
    """

    group = models.ForeignKey(
        FacebookGroup,
        on_delete=models.CASCADE,
        related_name='pending_member_posts',
    )
    # FB's internal post id (scraped). Stable identifier the worker uses to
    # locate the post during approve/reject. Empty if the scraper couldn't
    # extract one; in that case approve/reject by content fingerprint.
    post_fb_id = models.CharField(max_length=255, blank=True, default='', db_index=True)
    post_url = models.URLField(max_length=2048, blank=True, default='')
    author_name = models.CharField(max_length=255, blank=True, default='')
    author_uid = models.CharField(max_length=255, blank=True, default='')
    content = models.TextField(blank=True, default='')
    image_urls = models.JSONField(default=list, blank=True)
    posted_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=FacebookGroupPendingMemberPostStatus.choices,
        default=FacebookGroupPendingMemberPostStatus.QUEUED,
        db_index=True,
    )
    # Source tab in the FB admin queue. Determines which tab the worker must
    # tap before locating + approving/rejecting this post.
    pending_tab = models.CharField(
        max_length=20,
        choices=FacebookGroupPendingTab.choices,
        default=FacebookGroupPendingTab.APPROVAL,
        db_index=True,
    )
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_group_pending_member_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-posted_at', '-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['group', 'post_fb_id'],
                condition=models.Q(post_fb_id__gt=''),
                name='uniq_fb_pending_post_per_group',
            ),
        ]

    def __str__(self):
        return (
            f"Pending member post #{self.id} on group #{self.group_id} "
            f"by {self.author_name or '?'} [{self.status}]"
        )


class FacebookProfileStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    PAUSED = 'paused', 'Paused'
    ARCHIVED = 'archived', 'Archived'


class FacebookProfile(models.Model):
    """A Facebook personal profile the user operates or tracks."""

    name = models.CharField(max_length=255)
    profile_url = models.URLField(max_length=2048, blank=True, default='')
    profile_uid = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook user ID or username',
    )
    profile_token = models.TextField(
        blank=True,
        default='',
        help_text='User access token (deprecated path — kept for backward-compat only; '
                  'publishing now goes through the phoneagent task dispatch below).',
    )
    # ── Phoneagent publishing target ───────────────────────────────────────
    # Each FB profile is pinned to one Android device on which the FB app is
    # logged in to the matching account. Backend dispatches a Task to that
    # device's Kafka worker when a scheduled post is due.
    device = models.ForeignKey(
        'devices.Device',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_profiles',
        help_text='The device that has this FB account logged in. Required for publishing.',
    )
    account_name = models.CharField(
        max_length=128,
        blank=True,
        default='',
        help_text='The FB account display name as seen on the device (matches '
                  'profile_name argument of the facebook_profile_post skill, '
                  'e.g. "Profile A"). Required for publishing.',
    )
    description = models.TextField(blank=True, default='')
    friend_count = models.BigIntegerField(default=0)
    status = models.CharField(
        max_length=20,
        choices=FacebookProfileStatus.choices,
        default=FacebookProfileStatus.ACTIVE,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_profiles',
    )
    team_id = models.IntegerField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Profile #{self.id} – {self.name}"


class FacebookProfilePost(models.Model):
    """A post belonging to a Facebook personal profile. Mirror of FacebookGroupPost."""

    profile = models.ForeignKey(
        FacebookProfile,
        on_delete=models.CASCADE,
        related_name='posts',
    )
    post_url = models.URLField(max_length=2048, blank=True, default='')
    image_url = models.URLField(max_length=2048, blank=True, default='', help_text='Legacy single image; mirrors image_urls[0]')
    image_urls = models.JSONField(default=list, blank=True, help_text='List of image URLs to attach to this post')
    caption = models.TextField(null=True, blank=True)
    content = models.TextField(blank=True, default='')
    keywords = models.JSONField(default=list, blank=True, help_text='Keywords/tags for this post')
    status = models.CharField(
        max_length=20,
        choices=FacebookPostStatus.choices,
        default=FacebookPostStatus.PENDING,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_profile_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB Profile Post #{self.id} on profile #{self.profile_id} – {self.status}"


class FacebookProfileScheduledPost(models.Model):
    """A post queued for automatic publishing to a Facebook profile.

    Mirror of FacebookGroupScheduledPost.
    """

    profile = models.ForeignKey(
        FacebookProfile,
        on_delete=models.CASCADE,
        related_name='scheduled_posts',
    )
    content = models.TextField(blank=True, default='')
    image_urls = models.JSONField(
        default=list,
        blank=True,
        help_text='List of S3 (or public) image URLs to attach to this post',
    )
    image_description = models.TextField(
        blank=True,
        default='',
        help_text='Optional image prompt/description for future image generation',
    )
    topic = models.CharField(
        max_length=64,
        blank=True,
        default='',
        help_text='Topic/category tag (free text; UI suggests an enum list)',
    )
    ai_prompt = models.TextField(
        blank=True,
        default='',
        help_text=(
            'Prompt người dùng cấp khi import để AI rewrite content theo phong '
            'cách mong muốn (mặc định: phong cách bác sĩ y khoa). Rỗng = không '
            'enable AI rewrite cho row này.'
        ),
    )
    ai_rewritten_content = models.TextField(
        blank=True,
        default='',
        help_text=(
            'Bản nháp do AI rewrite. User review → accept → backend chuyển vào '
            '`content` để publish. Khi accept xong field này clear.'
        ),
    )
    scheduled_at = models.DateTimeField(
        help_text='When to publish this post',
        db_index=True,
    )
    status = models.CharField(
        max_length=20,
        choices=FacebookScheduledPostStatus.choices,
        default=FacebookScheduledPostStatus.PENDING,
        db_index=True,
    )
    # Optional re-route: when set, the post is published into this group
    # anonymously using ``profile`` as the poster, instead of onto the
    # profile's own timeline. NULL = legacy behaviour (post on timeline).
    target_group = models.ForeignKey(
        FacebookGroup,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='profile_scheduled_posts',
        help_text='Nếu set, bài đăng vào group này (ẩn danh) thay vì timeline.',
    )
    # Mirror of FacebookGroupScheduledPost.is_approved — gates cron only when
    # target_group is set. For NULL target (timeline) the field is always
    # treated as True at write time so the cron still fires.
    is_approved = models.BooleanField(
        default=True,
        db_index=True,
        help_text='Khi target_group set, admin group phải duyệt; với timeline mặc định True.',
    )
    fb_post_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Facebook post URL/ID returned after publishing',
    )
    buffed_like_total = models.PositiveIntegerField(
        default=0,
        help_text='Cumulative number of reactions ordered via hacklike for this post.',
    )
    buffed_at = models.DateTimeField(
        null=True, blank=True,
        help_text='Last time reactions were buffed for this post.',
    )
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_profile_scheduled_posts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at']

    def __str__(self):
        return f"Scheduled profile post #{self.id} for profile #{self.profile_id} at {self.scheduled_at} [{self.status}]"


class FacebookProfileMediaActionType(models.TextChoices):
    CHANGE_AVATAR = 'change_avatar', 'Change avatar'
    CHANGE_COVER = 'change_cover', 'Change cover'
    POST_STORY = 'post_story', 'Post story'


class FacebookProfileScheduledMediaAction(models.Model):
    """A single avatar/cover/story change queued for automatic execution on
    a Facebook profile.

    Sheet rows may set up to three of these per scheduled_at: one avatar
    change, one cover change, one story. They run as separate phoneagent
    tasks alongside the regular content post.
    """

    profile = models.ForeignKey(
        FacebookProfile,
        on_delete=models.CASCADE,
        related_name='scheduled_media_actions',
    )
    action_type = models.CharField(
        max_length=20,
        choices=FacebookProfileMediaActionType.choices,
    )
    image_url = models.TextField(
        help_text='S3 (or public) URL of the image to upload',
    )
    scheduled_at = models.DateTimeField(
        help_text='When to execute this action',
        db_index=True,
    )
    status = models.CharField(
        max_length=20,
        choices=FacebookScheduledPostStatus.choices,
        default=FacebookScheduledPostStatus.PENDING,
        db_index=True,
    )
    error_msg = models.TextField(blank=True, default='')
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='facebook_profile_scheduled_media_actions',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_at']

    def __str__(self):
        return (
            f"Scheduled {self.action_type} #{self.id} for profile "
            f"#{self.profile_id} at {self.scheduled_at} [{self.status}]"
        )


class FacebookPostUserComment(models.Model):
    """A comment scraped from a Facebook post via the external crawler.

    Analog of ``tiktok.TiktokVideoUserComment``.
    """

    post = models.ForeignKey(
        FacebookPost,
        on_delete=models.CASCADE,
        related_name='user_comments',
    )
    cid = models.CharField(max_length=128, help_text='Facebook comment ID')
    user_id = models.CharField(max_length=128, blank=True, default='', help_text='Facebook user ID (string)')
    nickname = models.CharField(max_length=255, blank=True, default='')
    text = models.TextField(blank=True, default='')
    create_time = models.DateTimeField(null=True, blank=True)
    parent_cid = models.CharField(
        max_length=128,
        blank=True,
        default='',
        help_text='Parent comment ID for replies; empty for top-level comments',
    )
    comment_link = models.URLField(
        max_length=2048,
        null=True,
        blank=True,
        help_text='Share URL for this comment',
    )

    class Meta:
        ordering = ['create_time', 'id']
        unique_together = [('post', 'cid')]

    def __str__(self):
        return f"Comment {self.cid} on FB post #{self.post_id} by {self.user_id}"


class FacebookProfileScheduledPostUserComment(models.Model):
    """A real comment scraped from a published FacebookProfileScheduledPost.

    Analog of ``FacebookPostUserComment`` / ``tiktok.TiktokVideoUserComment`` but
    keyed to a scheduled profile post (the published timeline/group post)."""

    scheduled_post = models.ForeignKey(
        'FacebookProfileScheduledPost',
        on_delete=models.CASCADE,
        related_name='user_comments',
    )
    cid = models.CharField(max_length=128, help_text='Facebook comment ID')
    user_id = models.CharField(max_length=128, blank=True, default='', help_text='Facebook user ID (string)')
    nickname = models.CharField(max_length=255, blank=True, default='')
    text = models.TextField(blank=True, default='')
    create_time = models.DateTimeField(null=True, blank=True)
    parent_cid = models.CharField(
        max_length=128,
        blank=True,
        default='',
        help_text='Parent comment ID for replies; empty for top-level comments',
    )
    comment_link = models.URLField(
        max_length=2048,
        null=True,
        blank=True,
        help_text='Share URL for this comment',
    )

    class Meta:
        ordering = ['create_time', 'id']
        unique_together = [('scheduled_post', 'cid')]

    def __str__(self):
        return f"Comment {self.cid} on FB scheduled post #{self.scheduled_post_id}"


class FacebookSeedingActionStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    DISPATCHED = 'dispatched', 'Dispatched'
    DONE = 'done', 'Done'
    FAILED = 'failed', 'Failed'


class FacebookSeedingInteractionType(models.TextChoices):
    LIKE = 'like', 'Like'
    COMMENT = 'comment', 'Comment'
    REPLY = 'reply', 'Reply'


class _FacebookSeedingActionBase(models.Model):
    """Common fields for Profile- and Group-post seeding actions.

    Abstract base — two concrete subclasses bind to FacebookProfilePost and
    FacebookGroupPost. Worker performs the action via the actor FB profile
    (NOT the post owner) so seeding looks like multi-user engagement.
    """

    actor_fb_profile = models.ForeignKey(
        FacebookProfile,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        help_text='Tài khoản FB sẽ thực hiện like/comment/reply.',
    )
    interaction_type = models.CharField(
        max_length=16,
        choices=FacebookSeedingInteractionType.choices,
    )
    comment_content = models.TextField(
        blank=True,
        default='',
        help_text='Nội dung comment/reply. Bỏ trống cho like.',
    )
    reply_target_username = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Reply only: tên hiển thị của user có comment được reply.',
    )
    reply_target_snippet = models.CharField(
        max_length=512,
        blank=True,
        default='',
        help_text='Reply only: đoạn text của comment gốc để worker disambiguate.',
    )
    ai_prompt = models.TextField(
        blank=True,
        default='',
        help_text='Prompt dùng để AI generate comment_content (optional).',
    )
    status = models.CharField(
        max_length=16,
        choices=FacebookSeedingActionStatus.choices,
        default=FacebookSeedingActionStatus.PENDING,
        db_index=True,
    )
    fb_comment_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='FB comment URL/ID sau khi seed thành công.',
    )
    error_msg = models.TextField(blank=True, default='')
    task = models.ForeignKey(
        'task.Task',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        help_text='Task phoneagent đang/đã chạy seeding này.',
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        ordering = ['-created_at']


class FacebookProfilePostSeedingAction(_FacebookSeedingActionBase):
    post = models.ForeignKey(
        FacebookProfilePost,
        on_delete=models.CASCADE,
        related_name='seeding_actions',
    )

    class Meta(_FacebookSeedingActionBase.Meta):
        abstract = False

    def __str__(self):
        return (
            f"ProfilePostSeedingAction #{self.id} on post #{self.post_id} "
            f"by actor #{self.actor_fb_profile_id} – {self.interaction_type}/{self.status}"
        )


class FacebookGroupPostSeedingAction(_FacebookSeedingActionBase):
    post = models.ForeignKey(
        FacebookGroupPost,
        on_delete=models.CASCADE,
        related_name='seeding_actions',
    )

    class Meta(_FacebookSeedingActionBase.Meta):
        abstract = False

    def __str__(self):
        return (
            f"GroupPostSeedingAction #{self.id} on post #{self.post_id} "
            f"by actor #{self.actor_fb_profile_id} – {self.interaction_type}/{self.status}"
        )


class FacebookScheduledPostCommentPlan(models.Model):
    """A planned comment on a published ``FacebookProfileScheduledPost``.

    Facebook mirror of ``tiktok.TiktokCommentPlan``: comments are generated in
    bulk via the same N8N webhook (keyed by device), reviewed/approved, then each
    is posted by the Facebook account logged in on that device
    (``actor_fb_profile``) as a phoneagent task targeting the post's published URL.
    """

    class ExecutionStatus(models.TextChoices):
        IDLE = 'idle', 'Idle'
        SCHEDULED = 'scheduled', 'Scheduled'
        RUNNING = 'running', 'Running'
        COMPLETED = 'completed', 'Completed'
        FAILED = 'failed', 'Failed'

    scheduled_post = models.ForeignKey(
        FacebookProfileScheduledPost,
        on_delete=models.CASCADE,
        related_name='comment_plans',
    )
    post_link = models.URLField(max_length=2048, blank=True, default='')
    agent_group = models.ForeignKey(
        'agent_groups.AgentGroup',
        null=True, blank=True, on_delete=models.SET_NULL,
        related_name='fb_comment_plans',
    )
    device = models.ForeignKey(
        'devices.Device',
        null=True, blank=True, on_delete=models.SET_NULL,
        related_name='fb_comment_plans',
    )
    actor_fb_profile = models.ForeignKey(
        FacebookProfile,
        null=True, blank=True, on_delete=models.SET_NULL,
        related_name='+',
        help_text='FB account that posts the comment (resolved from the device).',
    )
    comment_content = models.TextField(blank=True, default='')
    comment_link = models.URLField(max_length=2048, blank=True, default='')
    reply_to = models.TextField(blank=True, default='')
    # Stable cluster linkage: a reply points to its opener plan by FK. Matching
    # on ``reply_to`` text == opener ``comment_content`` is fragile (editing the
    # comment / AI rewrite / text drift breaks the cluster), so sequencing keys
    # on this FK instead. NULL for openers (reply_to='') and for legacy rows
    # created before this field (those fall back to text matching).
    root_plan = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.CASCADE,
        related_name='replies',
    )
    is_approved = models.BooleanField(default=False)
    is_commented = models.BooleanField(default=False)
    execution_status = models.CharField(
        max_length=20, choices=ExecutionStatus.choices, default=ExecutionStatus.IDLE,
    )
    execution_retry_count = models.PositiveIntegerField(default=0)
    execution_last_error = models.TextField(blank=True, default='')
    task = models.ForeignKey(
        'task.Task', on_delete=models.SET_NULL, null=True, blank=True, related_name='+',
    )
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='fb_comment_plans',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"FB comment plan #{self.id} for scheduled post #{self.scheduled_post_id}"


class FbHackKey(models.Model):
    """A third-party 'hacklike' (hacklike17.com) API token the user pastes in,
    used by the FB reaction-boost (🚀) feature on scheduled-post rows.

    The RAW token is stored because we must forward it to the external service,
    but the serializer never returns it — only ``key_masked``.
    """
    name = models.CharField(max_length=255)
    token = models.TextField(help_text='Raw hacklike17 API token (forwarded to the external service).')
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name='fb_hack_keys',
    )
    is_active = models.BooleanField(default=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'FbHackKey #{self.id} {self.name!r}'

    @property
    def key_masked(self) -> str:
        t = self.token or ''
        if not t:
            return ''
        if len(t) <= 8:
            return t[:2] + '••••'
        return f'{t[:6]}••••{t[-2:]}'


class HostedMediaCache(models.Model):
    """Maps an external media source URL (a Drive download link, a public CDN
    URL) to the SeaweedFS URL it was already re-hosted to — so the same source is
    downloaded from the origin exactly ONCE and every later scheduled post reuses
    the hosted copy.

    Vì sao cần: trước đây MỖI bài lịch tự tải lại video từ Drive từ đầu (không có
    dedup). Khi cùng một video được lịch cho hàng loạt bài, Drive thấy file bị kéo
    liên tục và bật throttle "downloaded too many times" — tốc độ rớt xuống ~80
    KB/s và bài thất bại với ``Read timed out`` (đo thực tế 07/2026: Drive 82 KB/s
    vs SeaweedFS 28 MB/s cho cùng file 49MB). Cache theo file id để chỉ tải 1 lần,
    tránh cả lãng phí băng thông lẫn việc kích throttle.
    See ``facebook.views._resolve_scheduled_post_media_for_publish``.
    """

    source_key = models.CharField(
        max_length=64,
        unique=True,
        help_text='sha256 hex của source_url (khoá dedup, an toàn index).',
    )
    source_url = models.TextField(
        help_text='URL nguồn ngoài (Drive/CDN) — lưu để tra cứu/debug.',
    )
    hosted_url = models.TextField(
        help_text='URL SeaweedFS mà nguồn đã được re-host tới.',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'HostedMediaCache #{self.id} {self.source_url[:60]!r} -> {self.hosted_url[:60]!r}'
