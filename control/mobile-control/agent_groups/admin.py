from django.contrib import admin
from .models import AgentGroup, AgentGroupMember, AgentGroupPlan


class AgentGroupMemberInline(admin.TabularInline):
    model = AgentGroupMember
    extra = 0
    readonly_fields = ['added_at']


@admin.register(AgentGroup)
class AgentGroupAdmin(admin.ModelAdmin):
    list_display = ['name', 'owner', 'team', 'member_count', 'created_at']
    search_fields = ['name', 'description']
    inlines = [AgentGroupMemberInline]

    def member_count(self, obj):
        return obj.members.count()
    member_count.short_description = 'Members'


@admin.register(AgentGroupMember)
class AgentGroupMemberAdmin(admin.ModelAdmin):
    list_display = ['group', 'device', 'role', 'added_at']
    list_filter = ['role']


@admin.register(AgentGroupPlan)
class AgentGroupPlanAdmin(admin.ModelAdmin):
    list_display = ['id', 'group', 'goal_preview', 'status', 'created_by', 'created_at']
    list_filter = ['status']
    search_fields = ['goal', 'group__name']
    readonly_fields = ['created_at', 'updated_at']

    def goal_preview(self, obj):
        return obj.goal[:80] + '\u2026' if len(obj.goal) > 80 else obj.goal
    goal_preview.short_description = 'Goal'
