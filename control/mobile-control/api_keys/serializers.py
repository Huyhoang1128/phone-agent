from rest_framework import serializers

from .models import ApiKey


class ApiKeySerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    # full_key is returned only on creation; otherwise None
    full_key = serializers.SerializerMethodField()

    class Meta:
        model = ApiKey
        fields = [
            'id', 'name', 'key_prefix', 'full_key',
            'owner_id', 'is_active', 'last_used_at', 'created_at',
        ]
        read_only_fields = ['id', 'key_prefix', 'full_key', 'owner_id', 'last_used_at', 'created_at']

    def get_full_key(self, obj):
        # Expose the raw key only immediately after creation
        return getattr(obj, '_raw_key', None)
