from django.contrib import admin, messages
from django.http import HttpResponse, HttpResponseRedirect
from django.middleware.csrf import get_token
from django.urls import path, reverse
from django.utils.html import format_html

from .models import (
    FacebookCommentPlan,
    FacebookGroupScheduledPost,
    FacebookPage,
    FacebookPost,
    FacebookPostInteraction,
    FacebookProfileScheduledMediaAction,
    FacebookProfileScheduledPost,
    FacebookScheduledPost,
    FacebookScheduledPostStatus,
    FbHackKey,
)


def _run_global_published_media_cleanup() -> tuple[int, int]:
    """Sweep all 4 surfaces for PUBLISHED rows (across ALL users), free S3.

    Returns ``(scanned, deleted)``. Reuses
    :func:`facebook.s3_utils.cleanup_post_media` so the cross-table reference
    check applies (URLs still used by another PENDING/PUBLISHING row are
    skipped) and only real S3 objects count.
    """
    from .s3_utils import cleanup_post_media

    scanned = 0
    deleted = 0
    list_models = (
        FacebookScheduledPost,
        FacebookGroupScheduledPost,
        FacebookProfileScheduledPost,
    )
    for model in list_models:
        for row in model.objects.filter(
            status=FacebookScheduledPostStatus.PUBLISHED,
        ).only('id', 'image_urls'):
            scanned += 1
            try:
                deleted += cleanup_post_media(row.image_urls, exclude=row)
            except Exception:
                pass
    for action_row in FacebookProfileScheduledMediaAction.objects.filter(
        status=FacebookScheduledPostStatus.PUBLISHED,
    ).only('id', 'image_url'):
        scanned += 1
        try:
            deleted += cleanup_post_media(action_row.image_url, exclude=action_row)
        except Exception:
            pass
    return scanned, deleted


@admin.register(FacebookPage)
class FacebookPageAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'page_url', 'category', 'follower_count', 'status', 'owner', 'team_id', 'created_at')
    list_filter = ('status',)
    search_fields = ('name', 'page_url', 'page_uid', 'category', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(FacebookPost)
class FacebookPostAdmin(admin.ModelAdmin):
    list_display = ('id', 'page', 'post_url', 'status', 'owner', 'created_at', 'updated_at')
    list_filter = ('status',)
    search_fields = ('post_url', 'content', 'caption', 'page__name', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(FacebookPostInteraction)
class FacebookPostInteractionAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'post', 'interaction_type', 'profile_username',
        'comment_link', 'interacted_at', 'created_at',
    )
    list_filter = ('interaction_type',)
    search_fields = ('post__post_url', 'profile_username', 'comment_content')
    readonly_fields = ('created_at',)


@admin.register(FacebookCommentPlan)
class FacebookCommentPlanAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'post_id', 'owner', 'device_id', 'execution_status',
        'is_approved', 'is_commented', 'comment_content_short', 'comment_link', 'updated_at',
    )
    list_filter = ('execution_status', 'is_commented', 'is_approved')
    search_fields = ('comment_content', 'reply_to', 'comment_link', 'owner__username')
    readonly_fields = ('created_at', 'updated_at')
    list_per_page = 50

    @admin.display(description='comment_content')
    def comment_content_short(self, obj):
        return (obj.comment_content or '')[:60]


@admin.register(FacebookScheduledPost)
class FacebookScheduledPostAdmin(admin.ModelAdmin):
    list_display = ('id', 'page', 'scheduled_at', 'status', 'image_description_short', 'fb_post_id', 'owner', 'created_at')
    list_filter = ('status',)
    search_fields = ('content', 'image_description', 'page__name', 'owner__username', 'fb_post_id')
    readonly_fields = ('fb_post_id', 'error_msg', 'created_at', 'updated_at')
    ordering = ['scheduled_at']

    @admin.display(description='image_description')
    def image_description_short(self, obj):
        return (obj.image_description or '')[:60]

    # Inject a banner with the cleanup link at the top of the changelist
    # (superuser-only — non-staff can't even reach the admin).
    change_list_template = 'admin/facebook/facebookscheduledpost/change_list.html'

    def changelist_view(self, request, extra_context=None):
        extra_context = extra_context or {}
        extra_context['show_cleanup_link'] = request.user.is_superuser
        extra_context['cleanup_url'] = reverse(
            'admin:facebook_cleanup_all_published_media',
        )
        return super().changelist_view(request, extra_context=extra_context)

    def get_urls(self):
        urls = super().get_urls()
        custom = [
            path(
                'cleanup-all-published-media/',
                self.admin_site.admin_view(self.cleanup_all_published_media_view),
                name='facebook_cleanup_all_published_media',
            ),
        ]
        return custom + urls

    def cleanup_all_published_media_view(self, request):
        """Superuser-only sweep of S3 media for ALL users' PUBLISHED posts."""
        if not request.user.is_superuser:
            messages.error(request, 'Yêu cầu quyền superuser.')
            return HttpResponseRedirect(reverse('admin:index'))

        if request.method == 'POST':
            scanned, deleted = _run_global_published_media_cleanup()
            messages.success(
                request,
                f'Cleanup xong: quét {scanned} row PUBLISHED, xoá {deleted} file S3.',
            )
            return HttpResponseRedirect(request.path)

        back_url = reverse('admin:facebook_facebookscheduledpost_changelist')
        html = format_html(
            """
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><title>Dọn S3 — toàn bộ user</title>
            <style>
              body {{ font-family: sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; }}
              h1 {{ font-size: 20px; }}
              .warn {{ background: #fff4d4; border: 1px solid #e0a800; padding: 12px; border-radius: 6px; }}
              button {{ background: #b00; color: #fff; border: 0; padding: 10px 18px; font-size: 14px; cursor: pointer; border-radius: 4px; }}
              button:hover {{ background: #900; }}
              a.back {{ display: inline-block; margin-left: 12px; color: #555; }}
            </style></head><body>
            <h1>Dọn S3 media — TOÀN BỘ user</h1>
            <p class="warn">
              ⚠ Hành động này sweep 4 surface (page/group/profile/media-action) cho
              <strong>tất cả user</strong>, chỉ giữ media của row PENDING/PUBLISHING.
              Bài đăng trên Facebook không bị ảnh hưởng — chỉ xoá file gốc trên Cloudfly.
              <strong>KHÔNG thể undo.</strong>
            </p>
            <p>Đăng nhập: <strong>{user}</strong> (superuser).</p>
            <form method="post">
              <input type="hidden" name="csrfmiddlewaretoken" value="{csrf}">
              <button type="submit" onclick="return confirm('Xác nhận dọn S3 cho TOÀN BỘ user?');">
                🗑 Dọn S3 (tất cả user)
              </button>
              <a class="back" href="{back}">← Huỷ</a>
            </form>
            </body></html>
            """,
            user=request.user.username,
            csrf=get_token(request),
            back=back_url,
        )
        return HttpResponse(html)


@admin.register(FacebookProfileScheduledPost)
class FacebookProfileScheduledPostAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'profile', 'scheduled_at', 'status', 'content_short',
        'target_group', 'fb_post_id', 'owner', 'created_at',
    )
    list_filter = ('status',)
    search_fields = ('content', 'image_description', 'profile__name', 'owner__username', 'fb_post_id')
    readonly_fields = ('fb_post_id', 'error_msg', 'created_at', 'updated_at')
    ordering = ['scheduled_at']
    list_per_page = 50

    @admin.display(description='content')
    def content_short(self, obj):
        return (obj.content or '')[:60]


@admin.register(FbHackKey)
class FbHackKeyAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'key_masked', 'owner', 'is_active', 'last_used_at', 'created_at')
    list_filter = ('is_active',)
    search_fields = ('name', 'owner__username')
    readonly_fields = ('last_used_at', 'created_at', 'updated_at')
