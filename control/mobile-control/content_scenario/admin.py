"""Admin chỉ-đọc cho debug/audit. Production không expose qua admin UI thường;
dùng Restore/AuditLog endpoint của ContentScenarioViewSet là chính."""
from django.contrib import admin

from .models import (
    ContentScenario,
    ContentScenarioAuditLog,
    ContentScenarioChatMessage,
    ContentScenarioShot,
)


@admin.register(ContentScenario)
class ContentScenarioAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'owner', 'team', 'genre', 'duration_target_seconds',
                    'shot_count_target', 'created_at')
    list_filter = ('genre', 'mode', 'created_at')
    search_fields = ('title', 'brief')
    readonly_fields = ('origin_data', 'intent_json', 'created_at', 'updated_at')


@admin.register(ContentScenarioShot)
class ContentScenarioShotAdmin(admin.ModelAdmin):
    list_display = ('id', 'scenario', 'shot_id', 'shot_order', 'continuity_mode',
                    'funnel_part', 'character_in_frame')
    list_filter = ('continuity_mode', 'funnel_part', 'brand_mention')
    search_fields = ('voice_over', 'kinetic_action')


@admin.register(ContentScenarioChatMessage)
class ContentScenarioChatMessageAdmin(admin.ModelAdmin):
    list_display = ('id', 'scenario', 'sender', 'owner', 'created_at')
    list_filter = ('sender', 'created_at')


@admin.register(ContentScenarioAuditLog)
class ContentScenarioAuditLogAdmin(admin.ModelAdmin):
    list_display = ('id', 'scenario', 'action', 'shot_id', 'character_name',
                    'actor', 'created_at')
    list_filter = ('action', 'created_at')
    readonly_fields = ('previous_value', 'fields_changed', 'created_at')
