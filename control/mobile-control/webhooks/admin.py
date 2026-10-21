from django.contrib import admin

from .models import ExternalWebhook, Webhook


@admin.register(Webhook)
class WebhookAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'url', 'is_active', 'owner', 'created_at')
    list_filter = ('is_active',)
    search_fields = ('name', 'url', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(ExternalWebhook)
class ExternalWebhookAdmin(admin.ModelAdmin):
    list_display = ('id', 'webhook_name', 'webhook_url', 'is_active', 'created_at')
    list_filter = ('is_active',)
    search_fields = ('webhook_name', 'webhook_url')
    readonly_fields = ('created_at', 'updated_at')
