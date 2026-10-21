from django.contrib.auth.models import User
from rest_framework import serializers
from .models import UserProfile, UserChatSettings


class UserProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserProfile
        fields = ['display_name', 'avatar_url']


class UserSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(source='profile.display_name', default='')
    avatar_url = serializers.URLField(source='profile.avatar_url', default='')

    class Meta:
        model = User
        fields = ['id', 'username', 'email', 'first_name', 'last_name', 'display_name', 'avatar_url']
        read_only_fields = ['id']


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=6)
    display_name = serializers.CharField(required=False, default='')

    class Meta:
        model = User
        fields = ['username', 'email', 'password', 'first_name', 'last_name', 'display_name']

    def create(self, validated_data):
        display_name = validated_data.pop('display_name', '')
        password = validated_data.pop('password')
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        UserProfile.objects.create(user=user, display_name=display_name)
        return user


class UpdateMeSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(source='profile.display_name', required=False)
    avatar_url = serializers.URLField(source='profile.avatar_url', required=False)

    class Meta:
        model = User
        fields = ['first_name', 'last_name', 'email', 'display_name', 'avatar_url']

    def update(self, instance, validated_data):
        profile_data = validated_data.pop('profile', {})
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        profile, _ = UserProfile.objects.get_or_create(user=instance)
        for attr, value in profile_data.items():
            setattr(profile, attr, value)
        profile.save()
        return instance


class UserChatSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserChatSettings
        fields = ['templates', 'llm_model']
