"""Serializers cho AI Scenario v3.

Phân biệt:
- `ContentScenarioSerializer` (list/detail) — full include shots + audits count.
- `ContentScenarioShotSerializer` — phẳng cho 1 shot (read + write per-field).
- `ContentScenarioChatMessageSerializer` — chat thread refine.
- `ContentScenarioAuditLogSerializer` — read-only audit row.

Lưu ý: `origin_data` + `intent_json` luôn read-only ở FE (server set khi
generate/save). FE chỉ PATCH `title`, `brief` metadata trên detail.
"""
from __future__ import annotations

from rest_framework import serializers

from .models import (
    ContentScenario,
    ContentScenarioAuditLog,
    ContentScenarioChatMessage,
    ContentScenarioShot,
)


# ─── Shot ────────────────────────────────────────────────────────────────────


class ContentScenarioShotSerializer(serializers.ModelSerializer):
    """1 shot — nested trong ContentScenario.

    `anchor_source_id` xuất ra dưới dạng số shot_id (logical), không phải DB pk.
    Khi gen JSON, view tự convert FK → logical.
    """
    anchor_source_id = serializers.SerializerMethodField()

    class Meta:
        model = ContentScenarioShot
        fields = [
            'id',                     # DB pk (FE dùng cho PATCH endpoint)
            'shot_id',                # logical, dùng cho anchor reference
            'shot_order',
            'character_in_frame',
            'continuity_mode',
            'anchor_source_id',       # logical, computed below
            'prompt_injection',
            'background',
            'character_pose',
            'kinetic_action',
            'camera_articulation',
            'prop_description',
            'texture_and_lighting',
            'voice_over',
            'music_hint',
            'funnel_part',
            'brand_mention',
            'warnings',
        ]
        read_only_fields = ['id', 'warnings']

    def get_anchor_source_id(self, obj: ContentScenarioShot) -> int | None:
        return obj.anchor_source_shot.shot_id if obj.anchor_source_shot else None


# ─── Scenario ────────────────────────────────────────────────────────────────


class ContentScenarioSerializer(serializers.ModelSerializer):
    """List/detail của 1 kịch bản. Nested shots full khi detail; rút gọn khi list."""
    owner_id = serializers.IntegerField(source='owner.id', read_only=True, allow_null=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    shots = ContentScenarioShotSerializer(many=True, read_only=True)
    shot_count = serializers.SerializerMethodField()

    class Meta:
        model = ContentScenario
        fields = [
            'id',
            'title',
            'brief',
            'duration_target_seconds',
            'shot_count_target',
            'shot_count',
            'genre',
            'source_file_name',
            'intent_json',
            'character_registry',
            'mode',
            'origin_data',
            'shots',
            'owner_id',
            'team_id',
            'team_name',
            'team_permission',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id', 'intent_json', 'character_registry', 'mode', 'origin_data',
            'shots', 'shot_count',
            'owner_id', 'team_id', 'team_name',
            'created_at', 'updated_at',
        ]

    def get_shot_count(self, obj: ContentScenario) -> int:
        return obj.shots.count()


class ContentScenarioListSerializer(serializers.ModelSerializer):
    """List view — rút gọn, không nested shots (perf)."""
    owner_id = serializers.IntegerField(source='owner.id', read_only=True, allow_null=True)
    team_id = serializers.IntegerField(source='team.id', read_only=True, allow_null=True)
    team_name = serializers.CharField(source='team.name', read_only=True, allow_null=True)
    shot_count = serializers.SerializerMethodField()

    class Meta:
        model = ContentScenario
        fields = [
            'id', 'title', 'brief',
            'duration_target_seconds', 'shot_count_target', 'shot_count',
            'genre', 'mode',
            'owner_id', 'team_id', 'team_name', 'team_permission',
            'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_shot_count(self, obj: ContentScenario) -> int:
        return obj.shots.count()


# ─── Chat / Audit ────────────────────────────────────────────────────────────


class ContentScenarioChatMessageSerializer(serializers.ModelSerializer):
    """1 chat message trong refine thread.

    Client chỉ ghi `body`, `target_shots`, `target_character`. Sender,
    llm_model, attached_patches do server set sau OpenAI round-trip.
    """
    class Meta:
        model = ContentScenarioChatMessage
        fields = [
            'id', 'scenario', 'owner', 'sender', 'body',
            'target_shots', 'target_character',
            'attached_patches', 'structured_actions', 'artistic_checks',
            'resolved_actions', 'llm_model', 'created_at',
        ]
        read_only_fields = [
            'id', 'scenario', 'owner', 'sender',
            'attached_patches', 'structured_actions', 'artistic_checks',
            'resolved_actions', 'llm_model', 'created_at',
        ]


class ContentScenarioAuditLogSerializer(serializers.ModelSerializer):
    """Audit log read-only."""
    actor_id = serializers.IntegerField(source='actor.id', read_only=True, allow_null=True)
    actor_username = serializers.CharField(source='actor.username', read_only=True, allow_null=True)

    class Meta:
        model = ContentScenarioAuditLog
        fields = [
            'id', 'scenario', 'action', 'shot_id', 'character_name',
            'fields_changed', 'previous_value',
            'actor_id', 'actor_username',
            'created_at',
        ]
        read_only_fields = fields
