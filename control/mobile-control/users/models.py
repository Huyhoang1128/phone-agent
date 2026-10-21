from django.contrib.auth.models import User
from django.db import models


class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    display_name = models.CharField(max_length=255, blank=True, default='')
    avatar_url = models.URLField(blank=True, default='')
    # Session epoch. Every issued JWT carries this number; auth compares the
    # token's copy against this value on each request. Bumping it (e.g. on a
    # password change) instantly invalidates all previously-issued tokens for
    # this user — the revocation JWT lacks on its own.
    token_version = models.PositiveIntegerField(default=1)
    # Công ty (tenant) mà tài khoản này thuộc về, quyết định DÙNG KEY AI NÀO khi
    # sinh ảnh — một máy chủ đang phục vụ nhiều công ty, mỗi công ty tự trả tiền
    # bằng key riêng. Slug phải khớp một mục trong ``settings.AI_TENANT_OPENAI_KEYS``
    # (vd 'ctya'). Để TRỐNG = dùng key mặc định OPENAI_API_KEY của server, tức là
    # hành vi cũ — nhờ vậy mọi tài khoản đang chạy không bị ảnh hưởng.
    #
    # Chỉ lưu SLUG ở đây, không lưu key: key nằm trong biến môi trường để không lọt
    # vào bản dump DB. Việc phân giải slug → key nằm trong ``content.ai_tenant``.
    ai_tenant = models.CharField(
        max_length=32,
        blank=True,
        default='',
        db_index=True,
        help_text=(
            'Slug công ty để chọn key AI khi sinh ảnh (vd "ctya"). Phải khớp '
            'AI_TENANT_OPENAI_KEYS trong .env. Để trống = dùng key mặc định của server.'
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Profile({self.user.username})"


class UserChatSettings(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='chat_settings')
    templates = models.JSONField(default=list, blank=True)
    llm_model = models.CharField(max_length=200, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"ChatSettings({self.user.username})"
