from django.contrib import admin

from .models import (
    Character,
    Content,
    ContentScriptAuditLog,
    ContentScriptChatMessage,
    CrawlContentSnapshot,
    CrawlRun,
    CrawlRunItem,
    CrawlSource,
    ImageGenerationLog,
)


@admin.register(Character)
class CharacterAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'owner', 'team', 'media_count', 'scenes_count', 'created_at')
    search_fields = ('name', 'owner__username', 'team__name')
    list_filter = ('team_permission',)
    readonly_fields = ('source_image_url', 'media', 'scenes', 'created_at', 'updated_at')

    def media_count(self, obj):
        return len(obj.media) if obj.media else 0
    media_count.short_description = 'Media'

    def scenes_count(self, obj):
        return len(obj.scenes) if obj.scenes else 0
    scenes_count.short_description = 'Scenes'


@admin.register(Content)
class ContentAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'kb_name', 'od_number', 'mode', 'source_type', 'owner', 'team', 'created_at')
    search_fields = ('title', 'script', 'text_content', 'kb_name', 'od_number', 'owner__username', 'team__name')
    list_filter = ('team_permission', 'source_type', 'mode')
    readonly_fields = ('origin_frames', 'created_at', 'updated_at')


@admin.register(ContentScriptChatMessage)
class ContentScriptChatMessageAdmin(admin.ModelAdmin):
    """Read-mostly view — for debugging chat threads. Don't edit in admin
    (would orphan the OpenAI round-trip context that produced the reply)."""
    list_display = ('id', 'content', 'sender', 'frame_target', 'owner', 'llm_model', 'created_at')
    list_filter = ('sender', 'llm_model')
    search_fields = ('body', 'content__title', 'content__kb_name', 'owner__username')
    readonly_fields = ('content', 'owner', 'sender', 'body', 'frame_target', 'llm_model', 'created_at')
    list_per_page = 50


@admin.register(ContentScriptAuditLog)
class ContentScriptAuditLogAdmin(admin.ModelAdmin):
    """Forensic trail — used to rebuild a frame when last-write-wins
    accidentally erases someone's work. Never edit; only read."""
    list_display = ('id', 'content', 'action', 'frame_index', 'actor', 'created_at')
    list_filter = ('action',)
    search_fields = ('content__title', 'content__kb_name', 'actor__username')
    readonly_fields = (
        'content', 'actor', 'action', 'frame_index',
        'fields_changed', 'previous_value', 'created_at',
    )
    list_per_page = 100


@admin.register(CrawlSource)
class CrawlSourceAdmin(admin.ModelAdmin):
    list_display = ('id', 'url', 'source_type', 'device', 'crawl_frequency_minutes', 'is_active', 'owner', 'team', 'created_at')
    search_fields = ('url', 'owner__username', 'team__name')
    list_filter = ('source_type', 'is_active', 'team_permission')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(CrawlRun)
class CrawlRunAdmin(admin.ModelAdmin):
    list_display = ('id', 'source_url', 'status', 'item_count', 'new_item_count', 'updated_item_count', 'started_at', 'finished_at')
    search_fields = ('source_url', 'triggered_by', 'error_message')
    list_filter = ('status',)
    readonly_fields = ('created_at', 'updated_at')


@admin.register(CrawlContentSnapshot)
class CrawlContentSnapshotAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'content_type', 'source_index_url', 'content_url', 'latest_run', 'last_updated_at')
    search_fields = ('title', 'content_url', 'source_index_url', 'checksum', 'version')
    list_filter = ('content_type',)
    readonly_fields = ('dedupe_key', 'created_at', 'updated_at')


@admin.register(CrawlRunItem)
class CrawlRunItemAdmin(admin.ModelAdmin):
    list_display = ('id', 'crawl_run', 'snapshot', 'is_new', 'is_updated', 'discovered_at')
    list_filter = ('is_new', 'is_updated')
    search_fields = ('snapshot__title', 'snapshot__content_url', 'crawl_run__source_url')


@admin.register(ImageGenerationLog)
class ImageGenerationLogAdmin(admin.ModelAdmin):
    """Sao kê lượt sinh ảnh. Lọc theo ``tenant`` để biết mỗi công ty tiêu bao nhiêu —
    bộ đếm số dòng của Django admin chính là số lượt (lọc thêm ``success`` để ra số
    ảnh thật sự sinh được)."""

    list_display = ('id', 'created_at', 'tenant', 'owner', 'provider', 'success')
    list_filter = ('tenant', 'provider', 'success')
    search_fields = ('owner__username', 'tenant')
    date_hierarchy = 'created_at'  # bấm theo năm/tháng/ngày để chốt số liệu từng tháng
    # Bản ghi tài chính: chỉ đọc, không cho sửa tay.
    readonly_fields = ('owner', 'tenant', 'provider', 'success', 'created_at')

    def has_add_permission(self, request):
        return False
