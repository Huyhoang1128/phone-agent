from rest_framework import serializers
from .models import Device, DeviceNotification, DeviceUsageSession


class ActiveSessionSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    display_name = serializers.SerializerMethodField()

    class Meta:
        model = DeviceUsageSession
        fields = ['id', 'user_id', 'username', 'display_name', 'claimed_at']

    def get_display_name(self, obj):
        profile = getattr(obj.user, 'profile', None)
        if profile and getattr(profile, 'display_name', None):
            return profile.display_name
        return obj.user.get_full_name() or obj.user.username


class DeviceProfileSerializer(serializers.Serializer):
    """Minimal profile info attached to each device (avoids a circular import)."""
    id = serializers.IntegerField()
    name = serializers.CharField()


class DeviceSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    active_session = serializers.SerializerMethodField()
    available = serializers.SerializerMethodField()
    profiles = serializers.SerializerMethodField()

    class Meta:
        model = Device
        fields = [
            # identifier may be supplied by the add-device form (pre-filled from the
            # connected-devices list) or set later by the ADB worker.
            # device_serial_id is the hardware serial entered via the UI form.
            'id', 'name', 'device_type', 'status', 'identifier', 'device_serial_id',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'screen_width', 'screen_height', 'hardware_info',
            'active_session', 'available', 'profiles',
            'worker_id', 'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'owner_id', 'team_id', 'team_name', 'active_session', 'available',
            'profiles', 'is_active', 'created_at', 'updated_at',
        ]
        extra_kwargs = {
            # TCS-v2 Sprint 1 (#17): Bypass DRF UniqueValidator để view.create
            # upsert logic chạy được. DRF auto-sinh UniqueValidator từ Model's
            # `UniqueConstraint(fields=['identifier'], condition=Q(identifier__gt=''))`
            # nhưng BỎ QUA condition → fire validator trên row trùng identifier
            # KHI ĐANG MUỐN UPDATE row đó. View `create` có upsert path: nếu
            # identifier/serial trùng → UPDATE thay INSERT.
            #
            # DB-level UniqueConstraint vẫn enforce nếu race condition; view
            # catch IntegrityError → trả 409 với message tiếng Việt.
            # Xem docs/Chatbot_Tiktok/tcs_v2_sprint_1_device_upsert.md.
            'identifier': {'validators': []},
        }

    def get_active_session(self, obj):
        session = obj.usage_sessions.filter(released_at__isnull=True).first()
        if session is None:
            return None
        return ActiveSessionSerializer(session).data

    def get_available(self, obj):
        """True if the device's identifier is currently plugged in (per Redis)."""
        connected = self.context.get('connected_serials')
        if connected is None:
            # Fall back to an explicit lookup if context wasn't pre-populated.
            from mbcontrol.redis_utils import get_connected_device_serials
            connected = set(get_connected_device_serials())
            self.context['connected_serials'] = connected
        serial = (obj.device_serial_id or '').strip()
        return bool(serial) and serial in connected

    def get_profiles(self, obj):
        """Return basic info for all profiles linked to this device."""
        qs = obj.profiles.only('id', 'name')
        return DeviceProfileSerializer(qs, many=True).data


class DeviceNotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceNotification
        fields = [
            'id', 'device_id', 'identifier',
            'package', 'title', 'text', 'notification_id',
            'tag', 'is_ongoing', 'post_time', 'key',
            'event_timestamp', 'raw_data', 'received_at',
        ]
        read_only_fields = fields
