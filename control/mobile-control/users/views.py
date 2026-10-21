from django.contrib.auth.models import User
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .models import UserProfile, UserChatSettings
from .serializers import RegisterSerializer, UserSerializer, UpdateMeSerializer, UserChatSettingsSerializer
from .tokens import tokens_for_user


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        tokens = tokens_for_user(user)
        return Response(
            {
                'user': UserSerializer(user).data,
                'access': tokens['access'],
                'refresh': tokens['refresh'],
            },
            status=status.HTTP_201_CREATED,
        )


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        from django.contrib.auth import authenticate
        username = request.data.get('username') or request.data.get('email', '')
        password = request.data.get('password', '')

        # Allow login by email
        if '@' in username:
            try:
                user_obj = User.objects.get(email=username)
                username = user_obj.username
            except User.DoesNotExist:
                pass

        user = authenticate(request, username=username, password=password)
        if user is None:
            return Response({'detail': 'Invalid credentials.'}, status=status.HTTP_401_UNAUTHORIZED)
        if not user.is_active:
            return Response({'detail': 'Account is disabled.'}, status=status.HTTP_403_FORBIDDEN)

        # Ensure profile exists
        UserProfile.objects.get_or_create(user=user)

        tokens = tokens_for_user(user)
        return Response(
            {
                'user': UserSerializer(user).data,
                'access': tokens['access'],
                'refresh': tokens['refresh'],
            }
        )


class VersionedTokenRefreshView(TokenRefreshView):
    """Refresh access tokens, but reject refresh tokens whose ``token_version``
    no longer matches the user's — so a revoked session cannot mint new access
    tokens. The freshly issued access/refresh inherit ``token_version`` from the
    incoming refresh automatically (SimpleJWT copies non-registered claims)."""

    def post(self, request, *args, **kwargs):
        raw = request.data.get('refresh')
        if raw:
            try:
                token = RefreshToken(raw)
            except TokenError as exc:
                raise InvalidToken(str(exc))

            token_version = token.get('token_version')
            user_id = token.get(jwt_settings.USER_ID_CLAIM)
            current_version = (
                UserProfile.objects
                .filter(user_id=user_id)
                .values_list('token_version', flat=True)
                .first()
            )
            if current_version is None:
                current_version = 1
            if token_version is None or token_version != current_version:
                raise InvalidToken('Session has been revoked, please log in again.')

        return super().post(request, *args, **kwargs)


class MeView(generics.RetrieveUpdateAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_serializer_class(self):
        if self.request.method in ('PATCH', 'PUT'):
            return UpdateMeSerializer
        return UserSerializer

    def get_object(self):
        UserProfile.objects.get_or_create(user=self.request.user)
        return self.request.user


class ChatSettingsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        settings_obj, _ = UserChatSettings.objects.get_or_create(user=request.user)
        serializer = UserChatSettingsSerializer(settings_obj)
        return Response(serializer.data)

    def put(self, request):
        settings_obj, _ = UserChatSettings.objects.get_or_create(user=request.user)
        serializer = UserChatSettingsSerializer(settings_obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)
