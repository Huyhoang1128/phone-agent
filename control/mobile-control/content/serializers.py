from django.db.models import Q
from rest_framework import serializers

from devices.models import Device
from .models import (
    Character,
    CharacterScheduledPost,
    Content,
    ContentScriptChatMessage,
    CrawlContentSnapshot,
    CrawlRun,
    CrawlSource,
    FeatureSystemPrompt,
)


class ContentSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)

    class Meta:
        model = Content
        fields = [
            'id',
            'title',
            'video_url',
            'image_urls',
            'text_content',
            'file_url',
            'script',
            'source_type',
            'kb_name',
            'od_number',
            'parent_scenario_filename',
            'frames',
            'origin_frames',
            'mode',
            'owner_id',
            'team_id',
            'team_name',
            'team_permission',
            'created_at',
            'updated_at',
        ]
        # source_type is decided by the server (the create endpoints set it
        # explicitly), so the rest of the generation metadata can only be
        # written by the dedicated save-generated endpoint, never by the
        # generic PATCH on an existing Content.
        #
        # origin_frames + mode are set by save_generated (and never by FE
        # PATCH) so they remain an immutable record of "what n8n gave us".
        read_only_fields = [
            'id', 'source_type', 'origin_frames', 'mode',
            'owner_id', 'team_id', 'team_name',
            'created_at', 'updated_at',
        ]


class ContentScriptChatMessageSerializer(serializers.ModelSerializer):
    """One chat message in the AI-refine panel. Owner/sender/created_at are
    server-controlled; only `body` and `frame_target` come from the client.
    `llm_model` is filled in by the view after the OpenAI round-trip."""

    class Meta:
        model = ContentScriptChatMessage
        fields = [
            'id',
            'content',
            'owner',
            'sender',
            'body',
            'frame_target',
            'llm_model',
            'attached_patches',
            'created_at',
        ]
        read_only_fields = [
            'id', 'content', 'owner', 'sender', 'llm_model',
            'attached_patches', 'created_at',
        ]


class CrawlRunSerializer(serializers.ModelSerializer):
    crawl_source_id = serializers.IntegerField(source='crawl_source.id', read_only=True, allow_null=True)
    duration_seconds = serializers.SerializerMethodField()

    class Meta:
        model = CrawlRun
        fields = [
            'id',
            'crawl_source_id',
            'source_url',
            'status',
            'started_at',
            'finished_at',
            'duration_seconds',
            'item_count',
            'new_item_count',
            'updated_item_count',
            'triggered_by',
            'error_message',
            'summary',
            'created_at',
            'updated_at',
        ]
        read_only_fields = fields

    def get_duration_seconds(self, obj):
        if not obj.finished_at or not obj.started_at:
            return None
        return max(int((obj.finished_at - obj.started_at).total_seconds()), 0)


class CrawlContentSnapshotSerializer(serializers.ModelSerializer):
    crawl_source_id = serializers.IntegerField(source='crawl_source.id', read_only=True, allow_null=True)
    content_id = serializers.IntegerField(source='content.id', read_only=True, allow_null=True)
    latest_run_id = serializers.IntegerField(source='latest_run.id', read_only=True, allow_null=True)
    media_count = serializers.SerializerMethodField()

    class Meta:
        model = CrawlContentSnapshot
        fields = [
            'id',
            'crawl_source_id',
            'content_id',
            'latest_run_id',
            'source_index_url',
            'content_url',
            'content_type',
            'title',
            'summary',
            'content_body',
            'payload',
            'media_file_urls',
            'media_count',
            'checksum',
            'version',
            'first_crawled_at',
            'crawled_at',
            'last_updated_at',
            'created_at',
            'updated_at',
        ]
        read_only_fields = fields

    def get_media_count(self, obj):
        media = obj.media_file_urls if isinstance(obj.media_file_urls, list) else []
        return len(media)


class CrawlSourceSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    device_id = serializers.PrimaryKeyRelatedField(
        source='device',
        queryset=Device.objects.all(),
        allow_null=True,
        required=False,
    )
    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    snapshot_count = serializers.SerializerMethodField()
    run_count = serializers.SerializerMethodField()
    successful_run_count = serializers.SerializerMethodField()
    failed_run_count = serializers.SerializerMethodField()
    latest_run_id = serializers.SerializerMethodField()
    latest_run_status = serializers.SerializerMethodField()
    latest_run_started_at = serializers.SerializerMethodField()
    latest_run_finished_at = serializers.SerializerMethodField()
    latest_run_item_count = serializers.SerializerMethodField()
    last_success_at = serializers.SerializerMethodField()
    last_failure_at = serializers.SerializerMethodField()

    class Meta:
        model = CrawlSource
        fields = [
            'id',
            'url',
            'source_type',
            'device_id',
            'device_name',
            'crawl_frequency_minutes',
            'is_active',
            'owner_id',
            'team_id',
            'team_name',
            'team_permission',
            'snapshot_count',
            'run_count',
            'successful_run_count',
            'failed_run_count',
            'latest_run_id',
            'latest_run_status',
            'latest_run_started_at',
            'latest_run_finished_at',
            'latest_run_item_count',
            'last_success_at',
            'last_failure_at',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'owner_id',
            'team_id',
            'team_name',
            'device_name',
            'snapshot_count',
            'run_count',
            'successful_run_count',
            'failed_run_count',
            'latest_run_id',
            'latest_run_status',
            'latest_run_started_at',
            'latest_run_finished_at',
            'latest_run_item_count',
            'last_success_at',
            'last_failure_at',
            'created_at',
            'updated_at',
        ]

    def _snapshot_queryset(self, obj):
        return CrawlContentSnapshot.objects.filter(
            Q(crawl_source=obj) | Q(source_index_url=obj.url)
        ).distinct()

    def _latest_run(self, obj):
        return obj.crawl_runs.order_by('-started_at', '-created_at').first()

    def get_snapshot_count(self, obj):
        return self._snapshot_queryset(obj).count()

    def get_run_count(self, obj):
        return obj.crawl_runs.count()

    def get_successful_run_count(self, obj):
        return obj.crawl_runs.filter(status='success').count()

    def get_failed_run_count(self, obj):
        return obj.crawl_runs.filter(status='failed').count()

    def get_latest_run_id(self, obj):
        latest = self._latest_run(obj)
        return latest.id if latest else None

    def get_latest_run_status(self, obj):
        latest = self._latest_run(obj)
        return latest.status if latest else None

    def get_latest_run_started_at(self, obj):
        latest = self._latest_run(obj)
        return latest.started_at if latest else None

    def get_latest_run_finished_at(self, obj):
        latest = self._latest_run(obj)
        return latest.finished_at if latest else None

    def get_latest_run_item_count(self, obj):
        latest = self._latest_run(obj)
        return latest.item_count if latest else 0

    def get_last_success_at(self, obj):
        run = obj.crawl_runs.filter(status='success').order_by('-started_at', '-created_at').first()
        return run.finished_at or run.started_at if run else None

    def get_last_failure_at(self, obj):
        run = obj.crawl_runs.filter(status='failed').order_by('-started_at', '-created_at').first()
        return run.finished_at or run.started_at if run else None


class FeatureSystemPromptSerializer(serializers.ModelSerializer):
    user_id = serializers.IntegerField(source='user.id', read_only=True, allow_null=True)
    is_default = serializers.SerializerMethodField()

    class Meta:
        model = FeatureSystemPrompt
        fields = [
            'id',
            'feature_id',
            'system_prompt',
            'user_id',
            'is_default',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'user_id', 'is_default', 'created_at', 'updated_at']

    def get_is_default(self, obj):
        return obj.user_id is None


class CharacterSerializer(serializers.ModelSerializer):
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    media_count = serializers.SerializerMethodField()
    scenes_count = serializers.SerializerMethodField()
    videos_count = serializers.SerializerMethodField()

    class Meta:
        model = Character
        fields = [
            'id',
            'name',
            'source_image_url',
            'face_prompt',
            'nation',
            'subject',
            'hair',
            'nails',
            'face_makeup',
            'media',
            'media_count',
            'scenes',
            'scenes_count',
            'videos',
            'videos_count',
            'owner_id',
            'team_id',
            'team_name',
            'team_permission',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            # subject/hair/nails/face_makeup stay WRITABLE: the brief builder edits
            # them per character and PATCHes them back, so the same person can be
            # reused verbatim across every scene.
            'id', 'source_image_url', 'face_prompt', 'nation',
            'media', 'media_count',
            'scenes', 'scenes_count', 'videos', 'videos_count',
            'owner_id', 'team_id', 'team_name', 'created_at', 'updated_at',
        ]

    @staticmethod
    def _visible(items):
        """Items không bị ẩn (soft-hide từng ảnh). Ảnh ``hidden`` vẫn nằm trong
        DB nhưng bị lọc khỏi API — không hiển thị, không dùng để đăng bài."""
        return [
            m for m in (items or [])
            if not (isinstance(m, dict) and m.get('hidden'))
        ]

    def get_media_count(self, obj):
        return len(self._visible(obj.media))

    def get_scenes_count(self, obj):
        return len(self._visible(obj.scenes))

    def get_videos_count(self, obj):
        return len(obj.videos) if obj.videos else 0

    def to_representation(self, instance):
        """Sign S3 image URLs so the browser can fetch private-bucket objects.

        The Cloudfly bucket is private (same as Facebook post images), so the
        raw ``CLOUDFLY_PUBLIC_BASE_URL/{key}`` URLs return 403 in the browser —
        they must be presigned on read, exactly like ``FacebookPostSerializer``.
        """
        data = super().to_representation(instance)
        from facebook.s3_utils import get_presigned_image_url

        def _sign_list(items):
            # Ảnh đã ẩn (soft-hide từng ảnh) bị lọc bỏ ở đây → không lộ ra UI
            # và không dùng để đăng bài; item vẫn còn trong DB để có thể bỏ ẩn.
            return [
                {**m, 'url': get_presigned_image_url(m['url'])}
                if isinstance(m, dict) and m.get('url') else m
                for m in self._visible(items)
            ]

        if data.get('source_image_url'):
            data['source_image_url'] = get_presigned_image_url(data['source_image_url'])
        data['media'] = _sign_list(data.get('media'))
        data['scenes'] = _sign_list(data.get('scenes'))
        return data


class CharacterScheduledPostSerializer(serializers.ModelSerializer):
    """Read view for a queued character photo-post. Image URLs are presigned on
    read so the management UI can preview them (same private-bucket rule as
    :class:`CharacterSerializer`)."""
    owner_id = serializers.IntegerField(source='owner.id', read_only=True)
    character_name = serializers.CharField(source='character.name', read_only=True)
    device_name = serializers.CharField(source='device.name', read_only=True, allow_null=True)
    profile_name = serializers.CharField(source='profile.name', read_only=True, allow_null=True)
    fb_profile_name = serializers.CharField(source='fb_profile.name', read_only=True, allow_null=True)
    fb_page_name = serializers.CharField(source='fb_page.name', read_only=True, allow_null=True)
    fb_group_name = serializers.CharField(source='fb_group.name', read_only=True, allow_null=True)

    class Meta:
        model = CharacterScheduledPost
        fields = [
            'id', 'character', 'character_name', 'platform',
            'image_urls', 'caption', 'hashtags',
            'device', 'device_name', 'profile', 'profile_name',
            'fb_profile', 'fb_profile_name', 'fb_page', 'fb_page_name',
            'fb_group', 'fb_group_name',
            'scheduled_at', 'status', 'error_msg', 'task',
            'owner_id', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def to_representation(self, instance):
        data = super().to_representation(instance)
        from facebook.s3_utils import get_presigned_image_url
        data['image_urls'] = [get_presigned_image_url(u) if u else u for u in (data.get('image_urls') or [])]
        return data
