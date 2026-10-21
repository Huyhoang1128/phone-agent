from django.contrib import admin
from .models import Profile, ProfileFile, ProfileAppInstallation


class ProfileFileInline(admin.TabularInline):
    model = ProfileFile
    extra = 0


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ['name', 'device', 'created_at']
    filter_horizontal = ['apps', 'credentials']
    inlines = [ProfileFileInline]


@admin.register(ProfileFile)
class ProfileFileAdmin(admin.ModelAdmin):
    list_display = ['profile', 'name', 'created_at']


@admin.register(ProfileAppInstallation)
class ProfileAppInstallationAdmin(admin.ModelAdmin):
    list_display = ['profile', 'app', 'device', 'status', 'updated_at']
    list_filter = ['status']
    search_fields = ['profile__name', 'app__name']
    readonly_fields = ['command_id', 'created_at', 'updated_at']
    raw_id_fields = ['profile', 'app', 'device', 'requested_by']
