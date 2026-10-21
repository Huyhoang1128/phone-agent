from django.contrib import admin
from .models import Device, DeviceNotification


@admin.register(Device)
class DeviceAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'device_type', 'status', 'identifier', 'device_serial_id', 'created_at')
    list_filter = ('device_type', 'status')
    search_fields = ('name', 'identifier', 'device_serial_id')


@admin.register(DeviceNotification)
class DeviceNotificationAdmin(admin.ModelAdmin):
    list_display = ('id', 'identifier', 'device_id', 'package', 'title', 'is_ongoing', 'received_at')
    list_filter = ('is_ongoing', 'package')
    search_fields = ('identifier', 'package', 'title', 'text', 'key')
    readonly_fields = ('raw_data', 'received_at')
    ordering = ('-received_at',)
