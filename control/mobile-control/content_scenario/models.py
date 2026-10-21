"""AI Scenario v3 — Django models.

Schema phân tầng theo `docs/Gen_Scenario/ai-scenario-v3-thiet-ke.md` §6, §12.

Cấu trúc (4 model):

    ContentScenario       (1 row = 1 kịch bản)
        ├── ContentScenarioShot          (N row, 1/shot, FK self-ref cho anchor)
        ├── ContentScenarioChatMessage   (chat thread refine với sticky context)
        └── ContentScenarioAuditLog      (mọi update/refine/restore)

Mode lock: v3.1 MVP **bỏ field `mode`** (Chốt #6); để default `ai_video` lưu sẵn,
v3.2 mở khi Media Server xong sẽ thêm `real_footage` + schema biến thể.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import models

from mbcontrol.constants import TeamPermission


# ─── Enums ───────────────────────────────────────────────────────────────────


class ScenarioGenre(models.TextChoices):
    """4 genre cho tone seeding marketing (OQ8 v3.1 MVP)."""
    SEEDING = 'seeding', 'Seeding'           # default — giật hook, GenZ TikTok
    TESTIMONIAL = 'testimonial', 'Testimonial'  # nhân chứng, kể chuyện thật
    EDUCATIONAL = 'educational', 'Educational'  # giảng giải sản phẩm
    BRAND_STORY = 'brand_story', 'Brand story'  # câu chuyện thương hiệu, cảm xúc


class ScenarioMode(models.TextChoices):
    """Mode cho v3.3+ (Media Server xong). v3.1 MVP luôn = AI_VIDEO."""
    AI_VIDEO = 'ai_video', 'AI video'              # default — sinh prompt cho AI render
    REAL_FOOTAGE = 'real_footage', 'Real footage'   # v3.3 — neo vào kho clip thật


class ContinuityMode(models.TextChoices):
    """Cờ điều phối downstream AI Gen Video (metadata trong JSON, không render
    ở v3.1). Xem [Phân_Tích_Scriptwriting_Format.md] về Frame-Anchoring graph."""
    NEW_SCENE = 'NEW_SCENE', 'New scene'             # Text-to-Video / khởi tạo bối cảnh mới
    FRAME_ANCHOR = 'FRAME_ANCHOR', 'Frame anchor'    # Image-to-Video từ frame cuối shot trước
    B_ROLL_CUT = 'B_ROLL_CUT', 'B-roll cut'          # cảnh chuyển/giấu lỗi (sản phẩm close-up)


class BrandMention(models.TextChoices):
    """Mức độ nhắc brand trong shot. Brand Reviewer chấm để tránh spam vs câm."""
    NONE = 'none', 'None'
    SOFT = 'soft', 'Soft'
    STRONG = 'strong', 'Strong'


class FunnelPart(models.TextChoices):
    """Phần AIDA shot thuộc về. Ép sinh đủ phễu Hook→Vấn đề→Giải pháp→CTA."""
    HOOK = 'Hook', 'Hook'
    PROBLEM = 'Vấn đề', 'Vấn đề'
    SOLUTION = 'Giải pháp', 'Giải pháp'
    CTA = 'CTA', 'CTA'
    B_ROLL = 'B-roll', 'B-roll'


class AuditAction(models.TextChoices):
    """Hành động được audit. Mirror pattern của ContentScriptAuditLog (v2).

    v3.2 thêm 5 action: insert_shot, delete_shot, reorder_shots, optimize_whole,
    generate_variant — phục vụ Nhóm A toolkit refine đầy đủ + Nhóm C UX.
    v3.2.1 Phase 4 thêm 2 action: approval_approved, approval_rejected.
    """
    GENERATE = 'generate', 'Generate'
    UPDATE_SHOT = 'update_shot', 'Update shot'
    REFINE_SHOT = 'refine_shot', 'Refine shot'
    UPDATE_CHARACTER = 'update_character', 'Update character'
    RESTORE_SHOT = 'restore_shot', 'Restore shot'
    RESTORE_ALL = 'restore_all', 'Restore all'
    # v3.2 — Nhóm A graph mutation + optimize_whole + Nhóm C generate_variant
    INSERT_SHOT = 'insert_shot', 'Insert shot'
    DELETE_SHOT = 'delete_shot', 'Delete shot'
    REORDER_SHOTS = 'reorder_shots', 'Reorder shots'
    OPTIMIZE_WHOLE = 'optimize_whole', 'Optimize whole scenario'
    GENERATE_VARIANT = 'generate_variant', 'Generate variant'
    # v3.2.1 Phase 4 — Human approval lifecycle
    APPROVAL_APPROVED = 'approval_approved', 'Approval approved'
    APPROVAL_REJECTED = 'approval_rejected', 'Approval rejected'
    # v3.2.2 Phase 0 — fix bug #2 (xoá character không có modal)
    DELETE_CHARACTER = 'delete_character', 'Delete character'


class ChatSender(models.TextChoices):
    USER = 'USER', 'User'
    ASSISTANT = 'ASSISTANT', 'Assistant'


class ApprovalStatus(models.TextChoices):
    """Trạng thái pending approval (v3.2.1 Phase 4)."""
    PENDING = 'pending', 'Pending'
    APPROVED = 'approved', 'Approved'
    REJECTED = 'rejected', 'Rejected'
    EXECUTED = 'executed', 'Executed'
    FAILED = 'failed', 'Failed'  # approved nhưng exec lỗi


# ─── Models ──────────────────────────────────────────────────────────────────


class ContentScenario(models.Model):
    """1 kịch bản phân tầng v3 = 1 row.

    `shots[]` lưu ở bảng riêng `ContentScenarioShot` (graph dependency qua
    `anchor_source_shot` FK self-ref). `character_registry` lưu inline JSON
    vì không có FK references từ shot tới character.
    """

    # ─── Identity / multi-tenant (anti-IDOR qua OwnedResourceMixin) ───────
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='content_scenarios',
    )
    team = models.ForeignKey(
        'teams.Team', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='content_scenarios',
    )
    team_permission = models.CharField(
        max_length=10, choices=TeamPermission.choices, default=TeamPermission.VIEW,
    )

    # ─── Input snapshot (cho audit + re-generate variant v3.2) ─────────────
    title = models.CharField(max_length=255, blank=True, default='')
    brief = models.TextField(blank=True, default='')
    # OQ1: 10-120s; OQ2 default = duration / 5
    duration_target_seconds = models.PositiveIntegerField(default=30)
    shot_count_target = models.PositiveIntegerField(default=6)
    # OQ8: genre dropdown trong modal
    genre = models.CharField(
        max_length=32, choices=ScenarioGenre.choices, default=ScenarioGenre.SEEDING,
    )
    # Snapshot file user upload (tên thôi, không lưu binary)
    source_file_name = models.CharField(max_length=255, blank=True, default='')
    # Output Layer 2 Parser Agent (IntentJSON) — None nếu user không upload file
    intent_json = models.JSONField(default=dict, blank=True)

    # ─── State (output Layer 3 ScripterAgent — registry + shots) ───────────
    # shots[] đẩy sang bảng ContentScenarioShot. character_registry inline JSON.
    character_registry = models.JSONField(default=list, blank=True)

    # v3.3 placeholder (v3.1 MVP luôn = AI_VIDEO, không expose trên FE)
    mode = models.CharField(
        max_length=20, choices=ScenarioMode.choices, default=ScenarioMode.AI_VIDEO,
    )

    # ─── Restore + Audit (Chốt #8) ─────────────────────────────────────────
    # Snapshot {character_registry, shots[]} lúc generate xong cho Restore.
    # Ghi 1 lần trong save action, KHÔNG bao giờ ghi lại từ refine/update.
    origin_data = models.JSONField(default=dict, blank=True)

    # ─── AI video render (via video-agent-worker over Kafka) ───────────────
    # Set when "Tạo video" publishes a task; the task_status consumer fills the
    # result. video_status: '' | processing | completed | failed | cancelled.
    video_task_id = models.CharField(max_length=64, blank=True, default='', db_index=True)
    video_status = models.CharField(max_length=20, blank=True, default='')
    video_url = models.TextField(blank=True, default='')  # raw Cloudfly URL; presigned on read
    video_error = models.TextField(blank=True, default='')

    # ─── Meta ──────────────────────────────────────────────────────────────
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['owner', '-created_at']),
            models.Index(fields=['team', '-created_at']),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f'Scenario#{self.pk} {self.title[:40]}'


class ContentScenarioShot(models.Model):
    """1 shot trong kịch bản. Có graph dependency qua `anchor_source_shot`.

    Lưu ý: schema §6.1 tài liệu yêu cầu `shot_id` (số trong kịch bản) khác với
    `pk` (DB primary key). `shot_id` là logical ID dùng cho `anchor_source_id`
    reference trong JSON output. v3.2 khi delete_shot xảy ra → CODE phải
    re-validate orphan của `anchor_source_shot`.
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='shots',
    )

    # Logical shot identity (xuất hiện trong ScenarioJSON output)
    shot_id = models.PositiveIntegerField()         # unique trong scenario
    shot_order = models.PositiveIntegerField()      # thứ tự render (= shot_id ở v3.1, có thể khác ở v3.2 reorder)

    character_in_frame = models.CharField(max_length=64, blank=True, default='')  # '' = None

    # ─── Continuity graph (metadata cho AI Video downstream) ──────────────
    continuity_mode = models.CharField(
        max_length=16, choices=ContinuityMode.choices, default=ContinuityMode.NEW_SCENE,
    )
    # FK self-ref. ON DELETE SET NULL để v3.2 delete_shot không cascade phá vỡ
    # toàn bộ graph; CODE sẽ phát hiện orphan + convert sang NEW_SCENE.
    anchor_source_shot = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='anchored_by',
    )
    prompt_injection = models.CharField(max_length=255, blank=True, default='')

    # ─── SETTING / AT RISE (Scriptwriting Format) ─────────────────────────
    background = models.TextField(blank=True, default='')
    character_pose = models.TextField(blank=True, default='')

    # ─── Stage Directions (kỹ thuật hoá — micro-direction cho AI Video) ───
    kinetic_action = models.TextField(blank=True, default='')          # CHỈ 1 hành động/shot
    camera_articulation = models.TextField(blank=True, default='')
    prop_description = models.TextField(blank=True, default='')
    texture_and_lighting = models.TextField(blank=True, default='')

    # ─── Dialogue (≤5s ≈ 25 từ tiếng Việt; OQ7 hybrid CODE warning) ───────
    voice_over = models.TextField(blank=True, default='')
    music_hint = models.CharField(max_length=255, blank=True, default='')

    # ─── Marketing metadata (đặc thù v3 seeding, không có ở AI Video gốc) ─
    funnel_part = models.CharField(
        max_length=32, choices=FunnelPart.choices, blank=True, default='',
    )
    brand_mention = models.CharField(
        max_length=16, choices=BrandMention.choices, default=BrandMention.NONE,
    )

    # OQ7: soft warning từ CODE-enforce voice over duration (≥30 từ)
    warnings = models.JSONField(default=list, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('scenario', 'shot_id')]
        ordering = ['scenario', 'shot_order']
        indexes = [
            models.Index(fields=['scenario', 'shot_order']),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f'Shot#{self.shot_id} of Scenario#{self.scenario_id}'


class ContentScenarioChatMessage(models.Model):
    """Chat thread refine cho 1 scenario. Reuse pattern v2 nhưng schema mới:

    - `target_shots` (list[int]) thay `frame_target` (int) — multi-shot refine
    - `target_character` (str) — sticky context cho `apply_character_patch`
    - `attached_patches` (list[dict]) — patch trong bubble, Apply mới ghi DB
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='chat_messages',
    )
    owner = models.ForeignKey(User, on_delete=models.CASCADE)

    sender = models.CharField(max_length=16, choices=ChatSender.choices)
    body = models.TextField()

    # ─── Sticky context (mở rộng từ `frame_target` của v2) ────────────────
    target_shots = models.JSONField(default=list, blank=True)        # [int]
    target_character = models.CharField(max_length=64, blank=True, default='')

    # ─── Tool calling output (chỉ có ở ASSISTANT turn khi AI gọi tool) ────
    # Schema: [{shot_id, before:{...}, after:{...}} | {character_name, before, after}]
    attached_patches = models.JSONField(default=list, blank=True)

    # ─── v5.1 — Structured actions KHÔNG phải patch diff (để FE render lại sau reload) ──
    # Schema item: {kind:'options'|'clarification'|'structural'|'treatment', ...}
    structured_actions = models.JSONField(default=list, blank=True)

    # ─── T11 — Điểm review-on-the-fly (artistic_check) để FE render lại bảng điểm sau reload ──
    # Schema item: {reviewer, shot_id, score, scores:{...}, warnings:[...], issues:[...], fixes:[...], cached}
    artistic_checks = models.JSONField(default=list, blank=True)

    # ─── T20 (R6) — Vòng đời đề xuất: khoá-đề-xuất → trạng thái resolved (bền sau reload, chống re-apply) ──
    # Schema: {"<key do FE đặt>": {"status": "applied"|"rejected", "at": "<iso>"}}. FE tự quy ước `key`
    # ổn định cho từng đề xuất (vd "patch-0"/"action-1"); BE chỉ lưu opaque.
    resolved_actions = models.JSONField(default=dict, blank=True)

    llm_model = models.CharField(max_length=64, blank=True, default='')

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['scenario', 'created_at']),
            models.Index(fields=['owner', 'scenario', 'created_at']),
        ]


class ContentScenarioAuditLog(models.Model):
    """Audit mọi update/refine/restore. Cứu user nếu 2 người cùng edit ghi đè
    (last-write-wins) — admin tra `previous_value` restore.
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='audits',
    )
    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
    )
    action = models.CharField(max_length=32, choices=AuditAction.choices)

    # Logical shot_id (không phải pk) cho audit per-shot
    shot_id = models.PositiveIntegerField(null=True, blank=True)
    # Tên character cho audit `update_character`
    character_name = models.CharField(max_length=64, blank=True, default='')

    fields_changed = models.JSONField(default=dict, blank=True)
    previous_value = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['scenario', '-created_at']),
            models.Index(fields=['actor', '-created_at']),
        ]


class ContentScenarioPendingApproval(models.Model):
    """Pending approval cho DANGEROUS tool actions (v3.2.1 Phase 4).

    Khi AI gọi 1 trong {delete_shot, optimize_whole, reorder_shots}, BE KHÔNG
    execute mà tạo 1 row pending → FE hiện modal → user approve/reject →
    POST /approvals/{id}/resolve/ → BE execute (nếu approve) hoặc mark rejected.

    Owner isolation (anti-IDOR): chỉ owner gốc của scenario mới được approve.
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='pending_approvals',
    )
    owner = models.ForeignKey(User, on_delete=models.CASCADE)

    # Tool name (= tên trong DANGEROUS_TOOLS set của views.py)
    tool_name = models.CharField(max_length=64)
    # Args giống schema OpenAI tool call (shot_id, new_order, variant_brief...)
    tool_args = models.JSONField(default=dict)

    # Link tới chat message ASSISTANT đã đề xuất (cho audit trail)
    chat_message = models.ForeignKey(
        ContentScenarioChatMessage, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='proposed_approvals',
        help_text='Chat message ASSISTANT đã đề xuất action này',
    )

    status = models.CharField(
        max_length=16, choices=ApprovalStatus.choices, default=ApprovalStatus.PENDING,
    )
    # Lưu kết quả execute (success: shot_id mới / error message)
    execution_result = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='resolved_scenario_approvals',
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['scenario', 'status', '-created_at']),
            models.Index(fields=['owner', 'status', '-created_at']),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f'Approval#{self.pk} [{self.status}] {self.tool_name}'


# ─── v3.2.2 Phase 1 — Telemetry: log mỗi chat turn của AI Refine ─────────────


class AiRefineEvent(models.Model):
    """Telemetry 1 row mỗi turn AI Refine (KHÔNG log mỗi tool_call để tránh nổ).

    Mục đích:
      - Đo tool frequency (apply_shot_patch vs propose_options vs read_*)
      - Token cost per turn → optimize prompt
      - Read tool usage → biết AI có cần context retrieval thường xuyên ko
      - Loop iterations → debug multi-turn behaviour

    KHÔNG log cho mỗi read tool call (sẽ là Phase 2+ nếu cần dashboard real-time).
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='ai_refine_events',
        null=True, blank=True,  # nullable cho draft preview chat
    )
    owner = models.ForeignKey(User, on_delete=models.CASCADE,
                               related_name='ai_refine_events')
    # Tool names được gọi trong turn này (list, có thể rỗng nếu chỉ trả text)
    tool_names = models.JSONField(default=list, blank=True)
    # Số read tool calls (subset của tool_names)
    read_tool_count = models.IntegerField(default=0)
    # Số iterations của OpenAI loop (1 = không có multi-turn)
    loop_iterations = models.IntegerField(default=1)
    # Token usage
    tokens_input = models.IntegerField(default=0)
    tokens_output = models.IntegerField(default=0)
    # LLM model dùng (gpt-4o-mini default, có thể override env)
    llm_model = models.CharField(max_length=80, blank=True)
    # Outcome counters cho phân tích (patches/structured_actions/proposed_options/clarification)
    patches_count = models.IntegerField(default=0)
    structured_actions_count = models.IntegerField(default=0)
    has_proposed_options = models.BooleanField(default=False)
    has_clarification = models.BooleanField(default=False)
    # User context tại turn này (mirror sticky)
    target_shots = models.JSONField(default=list, blank=True)
    target_character = models.CharField(max_length=120, blank=True)
    # Latency total turn (ms)
    duration_ms = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['scenario', '-created_at']),
            models.Index(fields=['owner', '-created_at']),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f'AiRefineEvent#{self.pk} sc={self.scenario_id} tools={len(self.tool_names)}'


# ─── v3.2.2 Phase 2 — Plan & Execute (multi-step) ───────────────────────────


class PlanStatus(models.TextChoices):
    PROPOSED = 'proposed', 'Proposed'         # AI vừa propose, chờ user approve
    EXECUTING = 'executing', 'Executing'      # Đang chạy execute
    COMPLETED = 'completed', 'Completed'      # Tất cả step done
    CANCELLED = 'cancelled', 'Cancelled'      # User cancel hoặc reject
    FAILED = 'failed', 'Failed'               # Có step fail (best-effort: vẫn keep done steps)


class ContentScenarioPlan(models.Model):
    """1 row = 1 plan đa bước do AI propose, user approve trước khi execute.

    Plan = sequence các step, mỗi step là 1 tool call (apply_shot_patch /
    insert_shot / batch_update_shots ...). Khi user approve, BE chạy từng step
    tuần tự (sync trong v3.2.2 — Daphne SSE buffer chưa fix), update
    `steps[i].status` + `step.result` để FE poll/refresh.

    Rollback policy: best-effort — steps đã apply giữ nguyên (đã có audit log
    cho restore manual). KHÔNG atomic transaction toàn plan (risky cho LLM-gen
    actions, có thể block DB lâu).
    """
    scenario = models.ForeignKey(
        ContentScenario, on_delete=models.CASCADE, related_name='plans',
    )
    owner = models.ForeignKey(User, on_delete=models.CASCADE,
                               related_name='content_scenario_plans')
    goal = models.CharField(max_length=500)
    analysis = models.TextField(blank=True)
    # steps = list[{description, tool_name, tool_args_preview, status, result, error}]
    # status enum: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
    steps = models.JSONField(default=list)
    status = models.CharField(
        max_length=20, choices=PlanStatus.choices, default=PlanStatus.PROPOSED,
    )
    # Đếm step done / failed cho stats
    completed_steps = models.IntegerField(default=0)
    failed_steps = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    executed_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['scenario', 'status', '-created_at']),
            models.Index(fields=['owner', '-created_at']),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f'Plan#{self.pk} sc={self.scenario_id} [{self.status}] steps={len(self.steps)}'
