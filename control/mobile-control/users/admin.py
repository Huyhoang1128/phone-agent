from django import forms
from django.conf import settings
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import User

from .models import UserChatSettings, UserProfile


def _configured_tenants():
    """Các slug công ty ĐÃ có key trên server (đọc từ .env qua settings)."""
    return sorted((getattr(settings, 'AI_TENANT_OPENAI_KEYS', None) or {}).keys())


class UserProfileForm(forms.ModelForm):
    """Chặn gõ sai slug công ty NGAY LÚC LƯU.

    Gõ sai một chữ (vd 'sk ' có dấu cách, hay 'SK' khi .env ghi 'sk') thì tài khoản đó
    sẽ ăn lỗi 503 "công ty chưa cấu hình key" lúc sinh ảnh — mà lỗi hiện ra ở tận màn
    hình người dùng, cách xa chỗ gõ sai. Báo ngay tại form, kèm danh sách slug hợp lệ.
    """

    class Meta:
        model = UserProfile
        fields = '__all__'

    def clean_ai_tenant(self):
        value = (self.cleaned_data.get('ai_tenant') or '').strip()
        if not value:
            return ''  # để trống là hợp lệ: dùng key mặc định của server
        valid = _configured_tenants()
        if value not in valid:
            raise forms.ValidationError(
                'Công ty «%(v)s» chưa có key trên server nên tài khoản này sẽ không sinh '
                'được ảnh. Slug đang có: %(valid)s. Muốn thêm công ty mới thì bổ sung vào '
                'AI_TENANT_OPENAI_KEYS trong .env rồi khởi động lại backend.',
                params={'v': value, 'valid': ', '.join(valid) or '(chưa cấu hình công ty nào)'},
            )
        return value


class UserProfileInline(admin.StackedInline):
    """Gán công ty NGAY TRONG trang sửa tài khoản — không phải mở thêm trang khác."""

    model = UserProfile
    form = UserProfileForm
    can_delete = False
    verbose_name_plural = 'Công ty (dùng key AI nào) & hồ sơ'
    fields = ('ai_tenant', 'display_name', 'avatar_url')


class UserAdmin(DjangoUserAdmin):
    """User admin gốc của Django + cột/ô lọc theo CÔNG TY.

    Nhờ vậy tạo tài khoản cho một công ty là làm trọn trong trang này, và nhìn danh
    sách là biết ngay tài khoản nào thuộc công ty nào.
    """

    inlines = [UserProfileInline]
    list_display = DjangoUserAdmin.list_display + ('company',)
    list_filter = DjangoUserAdmin.list_filter + ('profile__ai_tenant',)
    search_fields = DjangoUserAdmin.search_fields + ('profile__ai_tenant',)
    list_select_related = ('profile',)

    @admin.display(description='Công ty', ordering='profile__ai_tenant')
    def company(self, obj):
        profile = getattr(obj, 'profile', None)
        return (getattr(profile, 'ai_tenant', '') or '') if profile else '— (chưa có hồ sơ)'

    def get_inline_instances(self, request, obj=None):
        """Trang THÊM MỚI giữ nguyên như Django gốc (chỉ username + mật khẩu).

        Django's UserAdmin vốn đã tự chuyển sang trang sửa ngay sau khi tạo tài khoản,
        nên khối "Công ty" xuất hiện ở đó là đủ. Để nó ở cả trang thêm thì form tạo tài
        khoản bị thêm một khối bắt buộc mà chưa có hồ sơ nào để sửa.
        """
        if obj is None:
            return []
        return super().get_inline_instances(request, obj)


# django.contrib.auth đăng ký User trước (nó đứng trên 'users' trong INSTALLED_APPS),
# nên phải bỏ đăng ký cũ rồi đăng ký bản có thêm công ty. try/except để nếu thứ tự nạp
# đổi thì admin vẫn dùng được thay vì sập cả trang.
try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:  # pragma: no cover
    pass
admin.site.register(User, UserAdmin)


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    """Danh sách hồ sơ — dùng khi cần gán công ty cho NHIỀU tài khoản một lượt
    (``list_editable`` cho sửa trực tiếp trên danh sách rồi bấm Save một lần)."""

    form = UserProfileForm
    list_display = ('id', 'user', 'display_name', 'ai_tenant', 'token_version', 'updated_at')
    list_editable = ('ai_tenant',)
    list_filter = ('ai_tenant',)
    search_fields = ('user__username', 'user__email', 'display_name', 'ai_tenant')
    # token_version là con dấu thu hồi phiên đăng nhập (đổi mật khẩu → kill mọi session).
    # Sửa tay ở đây là đá người dùng ra khỏi hệ thống, nên để chỉ-đọc.
    readonly_fields = ('token_version', 'created_at', 'updated_at')


@admin.register(UserChatSettings)
class UserChatSettingsAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'llm_model', 'updated_at')
    search_fields = ('user__username',)
    readonly_fields = ('created_at', 'updated_at')
