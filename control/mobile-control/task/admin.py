from django.contrib import admin

from .models import Task, TaskStep


class TaskStepInline(admin.TabularInline):
    model = TaskStep
    extra = 0
    fields = ('handler', 'order', 'status', 'executed_at')
    readonly_fields = ('status', 'executed_at', 'created_at', 'updated_at')


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'task_kind', 'task_type', 'status', 'created_at', 'updated_at')
    list_filter = ('task_kind', 'task_type', 'status')
    search_fields = ('name', 'description')
    readonly_fields = ('created_at', 'updated_at')
    inlines = [TaskStepInline]
