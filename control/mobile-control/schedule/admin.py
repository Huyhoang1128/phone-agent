from django.contrib import admin

from .models import Schedule, ScheduleExecution


class ScheduleExecutionInline(admin.TabularInline):
    model = ScheduleExecution
    extra = 0
    readonly_fields = ('started_at', 'finished_at', 'result_status', 'error_message')
    can_delete = False


@admin.register(Schedule)
class ScheduleAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'task', 'profile', 'schedule_type', 'status', 'is_active',
        'next_run_at', 'last_run_at', 'retry_count',
    )
    list_filter = ('schedule_type', 'status', 'is_active', 'profile')
    search_fields = ('task__name', 'profile__name')
    readonly_fields = ('created_at', 'updated_at', 'last_run_at', 'next_run_at', 'retry_count')
    inlines = [ScheduleExecutionInline]


@admin.register(ScheduleExecution)
class ScheduleExecutionAdmin(admin.ModelAdmin):
    list_display = ('id', 'schedule', 'started_at', 'finished_at', 'result_status')
    list_filter = ('result_status',)
    readonly_fields = ('started_at', 'finished_at')
