from django.urls import path
from .views import (
    RegisterView, LoginView, MeView, ChatSettingsView, VersionedTokenRefreshView,
)

urlpatterns = [
    path('auth/register/', RegisterView.as_view(), name='auth-register'),
    path('auth/login/', LoginView.as_view(), name='auth-login'),
    path('auth/refresh/', VersionedTokenRefreshView.as_view(), name='auth-refresh'),
    path('auth/me/', MeView.as_view(), name='auth-me'),
    path('auth/chat-settings/', ChatSettingsView.as_view(), name='auth-chat-settings'),
]
