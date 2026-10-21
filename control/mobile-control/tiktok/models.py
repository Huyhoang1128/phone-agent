from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone

from mbcontrol.constants import TeamPermission


class TiktokVideoStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    LIKED = 'liked', 'Liked'
    COMMENTED = 'commented', 'Commented'
    SHARED = 'shared', 'Shared'
    REPOSTED = 'reposted', 'Reposted'


class TiktokVideo(models.Model):
    keywords = models.JSONField(default=list, help_text='List of keywords for this video')
    video_url = models.URLField(max_length=2048, blank=True, default='')
    caption = models.TextField(null=True, blank=True)
    content = models.TextField(blank=True, default='')
    video_process_task_id = models.CharField(max_length=255, null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=TiktokVideoStatus.choices,
        default=TiktokVideoStatus.PENDING,
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_videos',
    )
    team_id = models.IntegerField(null=True, blank=True, db_index=True)
    existing_comments = models.JSONField(
        default=list,
        blank=True,
        help_text='Existing comments on the video from other people (not from agents)',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"TikTok #{self.id} – {self.status}"


class TiktokInteractionType(models.TextChoices):
    LIKE = 'like', 'Like'
    COMMENT = 'comment', 'Comment'
    REPOST = 'repost', 'Repost'
    REPLY = 'reply', 'Reply'


class TiktokVideoInteraction(models.Model):
    video = models.ForeignKey(
        TiktokVideo,
        on_delete=models.CASCADE,
        related_name='interactions',
    )
    interaction_type = models.CharField(
        max_length=10,
        choices=TiktokInteractionType.choices,
    )
    profile_username = models.CharField(max_length=255, blank=True, default='')
    profile_avatar_url = models.URLField(max_length=2048, blank=True, default='')
    comment_content = models.TextField(blank=True, default='')
    comment_link = models.URLField(max_length=2048, blank=True, default='')
    interacted_at = models.DateTimeField(null=True, blank=True)
    # True once a "replay task" has been dispatched for this interaction; shared
    # across users so the row highlight is consistent for everyone.
    replay_task_dispatched = models.BooleanField(default=False)
    # True once a "dig comment" lookup has been run for this interaction; shared
    # across users so the row highlight is consistent for everyone.
    dig_comment_dispatched = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.interaction_type} on TikTok #{self.video_id} by {self.profile_username}"


class KeywordList(models.Model):
    """A saved list of AI-generated keywords grouped under a topic."""

    name = models.CharField(max_length=255)
    topic = models.CharField(max_length=512, blank=True, default='')
    keywords = models.JSONField(default=list, help_text='Deduplicated list of generated keywords')
    dispatched_keywords = models.JSONField(
        default=list,
        blank=True,
        help_text='Keywords that have already been dispatched to an agent group',
    )
    saved_keywords = models.JSONField(
        default=list,
        blank=True,
        help_text='Keywords whose search videos have been saved via "Save all"; '
                  'shared across users so the keyword highlight is consistent for everyone',
    )
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_keyword_lists',
    )
    team = models.ForeignKey(
        'teams.Team',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_keyword_lists',
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
        return f"{self.name} ({len(self.keywords)} keywords)"


class TiktokCommentPlan(models.Model):
    class ExecutionStatus(models.TextChoices):
        IDLE = 'idle', 'Idle'
        SCHEDULED = 'scheduled', 'Scheduled'
        RUNNING = 'running', 'Running'
        COMPLETED = 'completed', 'Completed'
        FAILED = 'failed', 'Failed'

    video = models.ForeignKey(
        TiktokVideo,
        on_delete=models.CASCADE,
        related_name='comment_plans',
    )
    video_link = models.URLField(max_length=2048, blank=True, default='')
    agent_group = models.ForeignKey(
        'agent_groups.AgentGroup',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_comment_plans',
    )
    profile = models.ForeignKey(
        'profiles.Profile',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_comment_plans',
    )
    device = models.ForeignKey(
        'devices.Device',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_comment_plans',
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
        related_name='tiktok_comment_plans',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"TikTok comment plan #{self.id} for video #{self.video_id}"


class TiktokVideoUserComment(models.Model):
    """A comment scraped from TikTok and stored for a given video."""

    video = models.ForeignKey(
        TiktokVideo,
        on_delete=models.CASCADE,
        related_name='user_comments',
    )
    cid = models.CharField(max_length=64, help_text='TikTok comment ID')
    user_id = models.CharField(max_length=64, help_text='TikTok user ID (string)')
    nickname = models.CharField(max_length=255, blank=True, default='')
    text = models.TextField()
    create_time = models.DateTimeField(null=True, blank=True)
    parent_cid = models.CharField(
        max_length=64,
        blank=True,
        default='',
        help_text='Parent comment ID for replies; empty for top-level comments',
    )
    comment_link = models.URLField(
        max_length=2048,
        null=True,
        blank=True,
        help_text='Share URL for this comment (from raw.share_info.url)',
    )

    class Meta:
        ordering = ['create_time', 'id']
        unique_together = [('video', 'cid')]

    def __str__(self):
        return f"Comment {self.cid} on TikTok #{self.video_id} by {self.user_id}"


class TiktokCommentPlanChatMessage(models.Model):
    class SenderType(models.TextChoices):
        USER = 'user', 'User'
        ASSISTANT = 'assistant', 'Assistant'

    video = models.ForeignKey(
        TiktokVideo,
        on_delete=models.CASCADE,
        related_name='comment_plan_chat_messages',
    )
    agent_group = models.ForeignKey(
        'agent_groups.AgentGroup',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_comment_plan_chat_messages',
    )
    sender = models.CharField(max_length=20, choices=SenderType.choices, default=SenderType.USER)
    content = models.TextField()
    owner = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tiktok_comment_plan_chat_messages',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f"TikTok plan chat #{self.id} ({self.sender}) for video #{self.video_id}"


class TiktokChannel(models.Model):
    channel_url = models.URLField(max_length=2048, primary_key=True)
    last_crawled_at = models.DateTimeField(null=True, blank=True)
    last_crawl_video_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return self.channel_url


class TiktokChannelVideo(models.Model):
    channel = models.ForeignKey(
        TiktokChannel,
        on_delete=models.CASCADE,
        related_name='videos',
    )
    video_url = models.URLField(max_length=2048, unique=True)
    title = models.CharField(max_length=500, blank=True, default='')
    description = models.TextField(blank=True, default='')
    hashtags = models.JSONField(default=list, blank=True)
    duration = models.PositiveIntegerField(default=0)
    view_count = models.BigIntegerField(default=0)
    like_count = models.BigIntegerField(default=0)
    comment_count = models.BigIntegerField(default=0)
    share_count = models.BigIntegerField(default=0)
    published_at = models.DateTimeField(null=True, blank=True)
    video_process_task_id = models.CharField(max_length=255, null=True, blank=True)
    analyzed_content = models.TextField(blank=True, default='')
    is_understand_video = models.BooleanField(default=False, db_index=True)
    understand_text_overlay = models.TextField(blank=True, default='')
    understand_content_text = models.TextField(blank=True, default='')
    understand_background_description = models.TextField(blank=True, default='')
    understand_style_analysis = models.TextField(blank=True, default='')
    understand_video_analysis = models.JSONField(null=True, blank=True)
    last_crawled_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-last_crawled_at', '-updated_at']
        indexes = [
            models.Index(fields=['channel', '-last_crawled_at']),
        ]

    def __str__(self):
        return self.video_url


# Chatbot TikTok models (TiktokMessage, TiktokPeerMute) đã được move sang
# `chatbot/` app trong Phase 2.6 refactor. Xem chatbot/models.py.
