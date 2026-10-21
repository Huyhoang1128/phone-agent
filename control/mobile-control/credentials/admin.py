from django.contrib import admin
from .models import Credential


@admin.register(Credential)
class CredentialAdmin(admin.ModelAdmin):
    list_display = ('id', 'app_name', 'username', 'created_at')
    list_filter = ('app_name',)
    search_fields = ('app_name', 'username')
