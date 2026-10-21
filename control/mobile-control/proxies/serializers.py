from rest_framework import serializers
from .models import Proxy


class ProxySerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = Proxy
        fields = [
            'id', 'name', 'protocol', 'host', 'port', 'username', 'password', 'status',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'team_id', 'team_name', 'created_at', 'updated_at']
        extra_kwargs = {'password': {'write_only': True}}
