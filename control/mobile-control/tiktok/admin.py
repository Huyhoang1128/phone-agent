from django.contrib import admin

from .models import (
    KeywordList,
    TiktokChannel,
    TiktokChannelVideo,
    TiktokCommentPlan,
    TiktokVideo,
    TiktokVideoInteraction,
)


@admin.register(TiktokVideo)
class TiktokVideoAdmin(admin.ModelAdmin):
    list_display = ('id', 'status', 'video_url', 'owner', 'team_id', 'created_at', 'updated_at')
    list_filter = ('status',)
    search_fields = ('video_url', 'content', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(TiktokVideoInteraction)
class TiktokVideoInteractionAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'video', 'interaction_type', 'profile_username',
        'comment_link', 'interacted_at', 'created_at',
    )
    list_filter = ('interaction_type',)
    search_fields = ('video__video_url', 'profile_username', 'comment_content')
    readonly_fields = ('created_at',)


@admin.register(TiktokCommentPlan)
class TiktokCommentPlanAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'video_id', 'owner', 'device_id', 'execution_status',
        'is_commented', 'reply_to_short', 'comment_content_short', 'comment_link', 'updated_at',
    )
    list_filter = ('execution_status', 'is_commented', 'is_approved')
    search_fields = ('comment_content', 'reply_to', 'comment_link', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')
    list_per_page = 50

    @admin.display(description='reply_to')
    def reply_to_short(self, obj):
        return (obj.reply_to or '')[:60]

    @admin.display(description='comment_content')
    def comment_content_short(self, obj):
        return (obj.comment_content or '')[:60]


@admin.register(KeywordList)
class KeywordListAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'topic', 'owner', 'team', 'team_permission', 'created_at')
    list_filter = ('team_permission',)
    search_fields = ('name', 'topic', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(TiktokChannel)
class TiktokChannelAdmin(admin.ModelAdmin):
    list_display = ('channel_url', 'last_crawled_at', 'last_crawl_video_count', 'updated_at')
    search_fields = ('channel_url',)
    readonly_fields = ('created_at', 'updated_at')


@admin.register(TiktokChannelVideo)
class TiktokChannelVideoAdmin(admin.ModelAdmin):
    list_display = (
        'id',
        'channel',
        'video_url',
        'duration',
        'view_count',
        'like_count',
        'comment_count',
        'video_process_task_id',
        'last_crawled_at',
    )
    search_fields = ('video_url', 'title', 'description', 'analyzed_content', 'channel__channel_url')
    list_filter = ('channel',)
    readonly_fields = ('created_at', 'updated_at')


# Chatbot TikTok admin (TiktokMessage, TiktokPeerMute) đã được move sang
# chatbot/admin.py trong Phase 2.6 refactor.
