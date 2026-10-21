from rest_framework import serializers

from .models import Website, WebsitePost


class WebsiteSerializer(serializers.ModelSerializer):
    # Application password is write-only — never returned. `has_credentials`
    # tells the UI whether one is stored.
    wp_app_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, style={'input_type': 'password'},
    )
    has_credentials = serializers.SerializerMethodField()

    class Meta:
        model = Website
        fields = [
            'id', 'name', 'site_type', 'base_url', 'wp_username', 'wp_app_password',
            'has_credentials', 'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def get_has_credentials(self, obj):
        return bool(obj.wp_username and obj.wp_app_password)

    def update(self, instance, validated_data):
        # Don't wipe the stored password when the client omits it / sends blank.
        pw = validated_data.get('wp_app_password', None)
        if not pw:
            validated_data.pop('wp_app_password', None)
        return super().update(instance, validated_data)


class WebsitePostSerializer(serializers.ModelSerializer):
    website_name = serializers.CharField(source='website.name', read_only=True)

    class Meta:
        model = WebsitePost
        fields = [
            'id', 'website', 'website_name', 'title', 'content', 'excerpt', 'slug',
            'image_url', 'featured_media_id', 'categories', 'tags', 'wp_status', 'status',
            'scheduled_at', 'wp_post_id', 'post_url', 'error_msg', 'source_images',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'website_name', 'status', 'wp_post_id', 'post_url', 'error_msg',
            'source_images', 'created_at', 'updated_at',
        ]

    def validate_website(self, value):
        request = self.context.get('request')
        if request is not None and value.owner_id != request.user.id:
            raise serializers.ValidationError('Website không thuộc về bạn.')
        return value
