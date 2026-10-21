from django.contrib import admin
from .models import MobileApp


@admin.register(MobileApp)
class MobileAppAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'package_name', 'platform', 'version', 'created_at')
    list_filter = ('platform',)
    search_fields = ('name', 'package_name')
