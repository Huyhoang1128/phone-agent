from rest_framework import serializers

from .models import Webhook


class WebhookSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)

    class Meta:
        model = Webhook
        fields = [
            'id', 'name', 'url', 'secret', 'events',
            'is_active', 'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'created_at', 'updated_at']
        extra_kwargs = {'secret': {'write_only': True}}
