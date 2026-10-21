from django.contrib import admin

from .models import Workflow, WorkflowRun, WorkflowStep, WorkflowTrigger


class WorkflowStepInline(admin.TabularInline):
    model = WorkflowStep
    extra = 0
    readonly_fields = ('created_at', 'updated_at')
    show_change_link = True


class WorkflowTriggerInline(admin.TabularInline):
    model = WorkflowTrigger
    extra = 0
    readonly_fields = ('webhook_token', 'next_run_at', 'last_triggered_at', 'created_at', 'updated_at')
    show_change_link = True


class WorkflowRunInline(admin.TabularInline):
    model = WorkflowRun
    extra = 0
    readonly_fields = ('run_number', 'status', 'triggered_by', 'started_at', 'finished_at', 'created_at')
    can_delete = False
    show_change_link = True


@admin.register(Workflow)
class WorkflowAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'status', 'owner', 'team', 'created_at', 'updated_at')
    list_filter = ('status',)
    search_fields = ('name', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')
    inlines = [WorkflowStepInline, WorkflowTriggerInline, WorkflowRunInline]


@admin.register(WorkflowStep)
class WorkflowStepAdmin(admin.ModelAdmin):
    list_display = ('id', 'workflow', 'sort_order', 'name', 'created_at', 'updated_at')
    list_filter = ('workflow',)
    search_fields = ('workflow__name', 'name', 'description')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(WorkflowTrigger)
class WorkflowTriggerAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'workflow', 'trigger_type', 'is_active',
        'periodic_schedule_type', 'event_name',
        'next_run_at', 'last_triggered_at',
    )
    list_filter = ('trigger_type', 'is_active', 'periodic_schedule_type')
    search_fields = ('workflow__name', 'event_name', 'webhook_token')
    readonly_fields = ('webhook_token', 'next_run_at', 'last_triggered_at', 'created_at', 'updated_at')


@admin.register(WorkflowRun)
class WorkflowRunAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'workflow', 'run_number', 'status', 'triggered_by',
        'started_at', 'finished_at', 'created_at',
    )
    list_filter = ('status', 'triggered_by')
    search_fields = ('workflow__name',)
    readonly_fields = ('run_number', 'started_at', 'finished_at', 'created_at', 'updated_at')
