from django.contrib import admin

from .models import ApiKey


@admin.register(ApiKey)
class ApiKeyAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'key_prefix', 'owner', 'is_active', 'created_at')
    list_filter = ('is_active',)
    search_fields = ('name', 'key_prefix', 'owner__username')
    readonly_fields = ('key_hash', 'key_prefix', 'created_at', 'last_used_at')
