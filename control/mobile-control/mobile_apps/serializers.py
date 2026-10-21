from django.conf import settings
from rest_framework import serializers
from .models import MobileApp
from .s3_utils import upload_apk_to_s3


def _s3_enabled() -> bool:
    """True when S3 storage is turned on for APK uploads (CLOUDFLY_ENABLED)."""
    return bool(getattr(settings, 'CLOUDFLY_ENABLED', False))


class MobileAppSerializer(serializers.ModelSerializer):
    apk_file_url = serializers.SerializerMethodField()
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = MobileApp
        fields = [
            'id', 'name', 'package_name', 'platform', 'apk_file',
            'apk_file_url', 'version', 'description',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'apk_file_url', 'owner_id', 'team_id', 'team_name', 'created_at', 'updated_at']
        extra_kwargs = {'apk_file': {'write_only': True, 'required': False}}

    def get_apk_file_url(self, obj):
        # Prefer the S3 URL when available
        if obj.apk_url:
            return obj.apk_url

        if obj.apk_file:
            request = self.context.get('request')
            try:
                url = obj.apk_file.url
            except Exception:
                return None
            if request:
                return request.build_absolute_uri(url)
            return url
        return None

    def _handle_apk_upload(self, validated_data: dict) -> dict:
        """Upload apk_file to S3 (if configured) and store the URL in apk_url.

        Any S3 error is surfaced as a DRF ValidationError so the client
        receives a meaningful HTTP 400 response.
        """
        apk_file = validated_data.get('apk_file')
        if not apk_file:
            return validated_data

        if _s3_enabled():
            from rest_framework.exceptions import ValidationError
            # Fail loudly if S3 is enabled but not actually configured, rather
            # than silently falling back to local disk (leader's requirement:
            # the APK file must live on S3, the DB only keeps the URL).
            if not (settings.CLOUDFLY_ACCESS_KEY and settings.CLOUDFLY_SECRET_KEY):
                raise ValidationError({
                    'apk_file': 'S3 storage is enabled but Cloudfly credentials '
                                'are not configured on the server.'
                })
            try:
                s3_url = upload_apk_to_s3(apk_file, apk_file.name)
            except Exception as exc:
                raise ValidationError({'apk_file': str(exc)}) from exc
            validated_data['apk_url'] = s3_url
            # Don't persist the file locally when S3 is used
            validated_data.pop('apk_file')

        return validated_data

    def create(self, validated_data):
        validated_data = self._handle_apk_upload(validated_data)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        validated_data = self._handle_apk_upload(validated_data)
        return super().update(instance, validated_data)
