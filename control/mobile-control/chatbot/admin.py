"""Admin for chatbot domain models (Phase 2.6 — moved từ `tiktok/admin.py`)."""
from django.contrib import admin

from .models import TiktokMessage, TiktokPeerMute


@admin.register(TiktokMessage)
class TiktokMessageAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'device', 'peer_handle', 'channel', 'message_type',
        'source', 'delivery_badge', 'content_preview', 'is_active', 'created_at',
    )
    list_filter = (
        'channel', 'message_type', 'source', 'delivery_status',
        'is_active', 'is_preview',
    )
    search_fields = ('peer_handle', 'content', 'video_id', 'error_reason')
    readonly_fields = ('created_at',)
    list_select_related = ('device', 'source_notification', 'source_task')
    raw_id_fields = ('device', 'source_notification', 'source_task')
    ordering = ('-created_at',)

    @admin.display(description='Content')
    def content_preview(self, obj):
        return (obj.content or '')[:60]

    @admin.display(description='Delivery')
    def delivery_badge(self, obj):
        from django.utils.html import format_html  # noqa: PLC0415
        d = obj.delivery_status
        if not d:
            return '—'
        color = {
            'pending': '#f39c12',  # orange
            'sent': '#27ae60',     # green
            'failed': '#c0392b',   # red
            'unknown': '#7f8c8d',  # grey
        }.get(d, '#000')
        label = {
            'pending': '⏳ Pending',
            'sent': '✅ Sent',
            'failed': '❌ Failed',
            'unknown': '⚠ Unknown',
        }.get(d, d)
        return format_html(
            '<span style="color:{};font-weight:600">{}</span>', color, label,
        )


@admin.register(TiktokPeerMute)
class TiktokPeerMuteAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'device', 'peer_handle', 'muted_until', 'is_active_display',
        'created_by', 'created_at',
    )
    list_filter = ('muted_until',)
    search_fields = ('peer_handle', 'note')
    readonly_fields = ('created_at', 'updated_at')
    raw_id_fields = ('device', 'created_by')

    @admin.display(boolean=True, description='Active?')
    def is_active_display(self, obj):
        return obj.is_active
