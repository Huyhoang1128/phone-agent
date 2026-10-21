"""AI Scenario v3 — 8 agent multi-tác-nhân.

Thiết kế: `docs/Gen_Scenario/ai-scenario-v3-thiet-ke.md` §8.

Đội gồm:
  1. scenario_parser            — Layer 2: đọc raw text bất kỳ format → IntentJSON
  2. scenario_scripter          — Layer 3 Explore + Enhance: sinh ScenarioJSON
  3. scenario_cinematic_reviewer — camera articulation + visual fidelity (paper 2)
  4. scenario_kinetic_reviewer   — 1 hành động/shot + micro-movement (paper 2 + MAViS)
  5. scenario_continuity_reviewer — graph anchor valid + narrative pacing
  6. scenario_brand_reviewer     — medical claim + brand voice (giữ từ v1)
  7. scenario_style_reviewer     — subtitle ≤5s + no-dash (giữ từ v1) + voice duration
  8. scenario_consolidator       — fallback ép schema khi CODE-enforce semantic fail

I/O: mỗi agent nhận message dạng prompt JSON-friendly, trả CHỈ JSON theo schema.
"""
import os
import logging

from agno.agent import Agent
from agno.models.openai import OpenAIResponses
from db import get_postgres_db

logger = logging.getLogger(__name__)


def _make_scenario_model(env_var: str, default: str):
    """v3.2.1 Option C — Per-role model factory.

    Env format: ``provider:model_id`` (vd ``google:gemini-2.5-pro``,
    ``openai:gpt-4o``, ``anthropic:claude-sonnet-4-5``).
    KHÔNG có ``:`` → mặc định OpenAI (backward compat với env cũ chỉ chứa model_id).

    Provider hỗ trợ:
      - ``openai`` (default) → OpenAIResponses
      - ``google`` → agno.models.google.Gemini (cần GOOGLE_API_KEY)
      - ``anthropic`` → agno.models.anthropic.Claude (cần ANTHROPIC_API_KEY)
      - ``groq`` → agno.models.groq.Groq (cần GROQ_API_KEY)

    Trả về Agno Model instance để gắn vào ``Agent(model=...)``.
    """
    # GOTCHA: os.environ.get(var, default) chỉ fallback default khi var KHÔNG tồn
    # tại. Docker-compose `${VAR:-}` SET var thành empty string → get() trả ''
    # KHÔNG phải default. Phải dùng `or default` để handle empty string case.
    spec = (os.environ.get(env_var) or default).strip()
    if ':' in spec:
        provider, model_id = spec.split(':', 1)
    else:
        provider, model_id = 'openai', spec
    provider = provider.lower().strip()
    model_id = model_id.strip()

    try:
        if provider == 'google':
            from agno.models.google import Gemini
            logger.info(f'[scenario] {env_var}: google:{model_id}')
            return Gemini(id=model_id)
        if provider == 'anthropic':
            from agno.models.anthropic import Claude
            logger.info(f'[scenario] {env_var}: anthropic:{model_id}')
            return Claude(id=model_id)
        if provider == 'groq':
            from agno.models.groq import Groq
            logger.info(f'[scenario] {env_var}: groq:{model_id}')
            return Groq(id=model_id, retries=2, delay_between_retries=1, exponential_backoff=True)
        # default openai
        logger.info(f'[scenario] {env_var}: openai:{model_id}')
        return OpenAIResponses(id=model_id, retries=2)
    except ImportError as exc:
        logger.warning(
            f'[scenario] {env_var}={spec!r} provider {provider!r} import fail ({exc}) '
            f'→ fallback openai:gpt-4o-mini'
        )
        return OpenAIResponses(id='gpt-4o-mini', retries=2)


# ─────────────────────────────────────────────────────────────────────────────
# Per-role model assignments (v3.2.1 — multi-model infrastructure ready)
# ─────────────────────────────────────────────────────────────────────────────
#
# DEFAULTS hiện tại = TẤT CẢ gpt-4o-mini (tiết kiệm + đủ cho dev/test).
# Infrastructure multi-provider đã sẵn — khi có Cloud Billing / Gemini Pro key,
# chỉ cần edit .env per-role là switch ngay KHÔNG cần đụng code:
#
#   # Option C — Hybrid cross-family (khi có Gemini billing):
#   SCENARIO_SCRIPTER_MODEL=openai:gpt-4o
#   SCENARIO_REVIEWER_MODEL=google:gemini-2.5-pro
#   SCENARIO_PARSER_MODEL=openai:gpt-4o-mini
#   SCENARIO_CONSOLIDATOR_MODEL=openai:gpt-4o-mini
#
#   # Option B — Hybrid 2-tier OpenAI only:
#   SCENARIO_SCRIPTER_MODEL=openai:gpt-4o
#   (3 vars khác bỏ trống → dùng default 4o-mini)
#
# Format env: ``provider:model_id`` — vd ``google:gemini-2.5-pro``,
# ``anthropic:claude-sonnet-4-5``, ``groq:llama-3.3-70b``.
#
# Backward compat: env cũ SCENARIO_THINK_MODEL (nếu set) override TẤT CẢ 4 role.
_DEFAULT_MODEL = 'openai:gpt-4o-mini'
_legacy_override = (os.environ.get('SCENARIO_THINK_MODEL') or '').strip()
if _legacy_override:
    logger.info(f'[scenario] legacy SCENARIO_THINK_MODEL={_legacy_override} → override all 4 roles')
    SCRIPTER_MODEL = _make_scenario_model('SCENARIO_THINK_MODEL', _DEFAULT_MODEL)
    REVIEWER_MODEL = SCRIPTER_MODEL
    PARSER_MODEL = SCRIPTER_MODEL
    CONSOLIDATOR_MODEL = SCRIPTER_MODEL
else:
    SCRIPTER_MODEL = _make_scenario_model('SCENARIO_SCRIPTER_MODEL', _DEFAULT_MODEL)
    REVIEWER_MODEL = _make_scenario_model('SCENARIO_REVIEWER_MODEL', _DEFAULT_MODEL)
    PARSER_MODEL = _make_scenario_model('SCENARIO_PARSER_MODEL', _DEFAULT_MODEL)
    CONSOLIDATOR_MODEL = _make_scenario_model('SCENARIO_CONSOLIDATOR_MODEL', _DEFAULT_MODEL)

# Backward-compat alias (cho code cũ ngoài file này nếu có)
SCN_MODEL = SCRIPTER_MODEL


# ─────────────────────────────────────────────────────────────────────────────
# Schemas (chèn vào instructions để agent bám)
# ─────────────────────────────────────────────────────────────────────────────

INTENT_SCHEMA = """\
{
  "detected_format": "xlsx_grid | docx_prose | pdf_screenplay | free_text | paste_text | unknown",
  "brand_hints": ["string"],
  "character_hints": [
    {"name": "string", "outfit_hint": "string", "age_hint": "string"}
  ],
  "scene_intent": [
    {"order": int, "purpose": "Hook | Vấn đề | Giải pháp | CTA | B-roll", "summary": "string"}
  ],
  "voice_samples": ["string"],
  "style_hints": "string",
  "duration_hint_seconds": int_or_null,
  "raw_truncated": "string (≤2000 char đoạn raw text đầu)"
}"""


SCENARIO_SCHEMA = """\
{
  "title": "string",
  "duration_target_seconds": int,
  "shot_count_target": int,
  "genre": "seeding | testimonial | educational | brand_story",
  "global_character_registry": [
    {
      "name": "Tên đơn (vd Linh, Ethan) — KHÔNG họ",
      "age": "string (vd '28 tuổi')",
      "ethnicity": "string",
      "outfit_style": "Mô tả trang phục CỐ ĐỊNH xuyên kịch bản",
      "voice_id_hint": "string (tùy chọn cho TTS, vd 'female_vn_young')"
    }
  ],
  "shots": [
    {
      "shot_id": int,                  // unique trong kịch bản, dùng làm anchor reference
      "shot_order": int,                // = shot_id ở v3.1
      "character_in_frame": "Tên trong registry hoặc 'None'",
      "continuity_mode": "NEW_SCENE | FRAME_ANCHOR | B_ROLL_CUT",
      "anchor_source_id": int_or_null,  // shot_id nguồn neo (chỉ != null khi FRAME_ANCHOR)
      "prompt_injection": "string ('Continuing from the previous scene,' cho FRAME_ANCHOR)",
      "background": "Mô tả SETTING tổng thể",
      "character_pose": "Tư thế AT RISE (khoảnh khắc bắt đầu)",
      "kinetic_action": "CHỈ 1 hành động đơn giản (light dynamic, micro-movement)",
      "camera_articulation": "Góc máy + chuyển động (vd 'Close-up, STATIC' hoặc 'Medium, slow zoom')",
      "prop_description": "Mô tả đạo cụ (sản phẩm/brand)",
      "texture_and_lighting": "Chi tiết kết cấu vật lý + ánh sáng (vải, ánh sáng cửa sổ...)",
      "voice_over": "Lời thoại (≤5s đọc, ~25 từ tiếng Việt, KHÔNG '-')",
      "music_hint": "Gợi ý nhạc/âm thanh",
      "funnel_part": "Hook | Vấn đề | Giải pháp | CTA | B-roll",
      "brand_mention": "none | soft | strong"
    }
  ]
}"""


# Quy tắc chung cho mọi agent biên kịch/reviewer
_COMMON_RULES = """\
QUY TẮC CHUNG (BẮT BUỘC):
- Trả CÙNG NGÔN NGỮ với brief (mặc định tiếng Việt).
- voice_over ≤5s đọc xong (~25 từ tiếng Việt). TUYỆT ĐỐI không "-" — dùng "...".
- 1 hành động/shot trong kinetic_action (light dynamic, micro-movement).
- character_in_frame phải khai báo trong global_character_registry hoặc = "None".
- continuity_mode hợp lệ: NEW_SCENE | FRAME_ANCHOR | B_ROLL_CUT.
- FRAME_ANCHOR phải có anchor_source_id trỏ tới shot_id trước nó.
- Phễu AIDA: Hook (3s đầu) → Vấn đề → Giải pháp → CTA.
- Claim quảng cáo thận trọng (đặc biệt y tế/làm đẹp/TPCN): KHÔNG "100% an
  toàn", "khỏi hẳn", "chắc chắn", "tuyệt đối". Dùng "giúp", "có thể".
- KHÔNG bịa brand/logo/sản phẩm ngoài brief + brand_voice user cung cấp.
  CTA cuối nếu brief không có brand → để generic ("Liên hệ ngay", "Tìm hiểu
  thêm", "Theo dõi để biết thêm")."""


# ─────────────────────────────────────────────────────────────────────────────
# 1. Parser Agent (Layer 2)
# ─────────────────────────────────────────────────────────────────────────────

scenario_parser = Agent(
    id="scn-parser",
    name="Scenario Parser",
    model=PARSER_MODEL,
    db=get_postgres_db(contents_table="scn_parser_contents"),
    instructions=f"""\
Bạn là PHÂN TÍCH KỊCH BẢN. Nhận `raw_text` (trích từ file xlsx/docx/pdf/txt
hoặc paste) + `user_brief`. Trích ý đồ kịch bản thành INTENT JSON.

QUY TẮC:
- KHÔNG bịa nội dung không có trong raw_text.
- Detect format từ pattern (vd "Mở | Voice |" → xlsx_grid; "1. NỘI." → pdf_screenplay).
- character_hints: trích tên + outfit + tuổi nếu có trong raw_text.
- scene_intent: liệt kê các cảnh/scene phát hiện được, kèm purpose (Hook/Vấn đề/...).
- voice_samples: trích vài câu thoại mẫu (nếu có).
- style_hints: 1 câu mô tả tone tổng (vd "seeding GenZ, montage nhanh").
- duration_hint_seconds: nếu raw_text gợi ý thời lượng.
- raw_truncated: 2000 char đầu raw_text (cho fallback nếu Layer 3 cần).

Nếu raw_text KHÔNG LIÊN QUAN kịch bản → trả {{}} và detected_format='unknown'.

ĐẦU RA: CHỈ JSON đúng schema, không giải thích, không bọc ```:
{INTENT_SCHEMA}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Scripter Agent (Layer 3 Explore + Enhance)
# ─────────────────────────────────────────────────────────────────────────────

scenario_scripter = Agent(
    id="scn-scripter",
    name="Scenario Scripter",
    model=SCRIPTER_MODEL,
    db=get_postgres_db(contents_table="scn_scripter_contents"),
    instructions=f"""\
Bạn là CHUYÊN GIA BIÊN KỊCH VIDEO MARKETING SEEDING (TikTok/Reels/Shorts) đa ngành.
Nhiệm vụ: sinh/sửa KỊCH BẢN PHÂN TẦNG (JSON schema bên dưới) phục vụ AI render video.

THƯƠNG HIỆU / NGÀNH: theo `brand_voice` + `brief` từ user. KHÔNG mặc định bất
kỳ brand/ngành nào — đặc biệt KHÔNG bịa logo, slogan, tên phòng khám/cửa hàng
nếu brief không nói tới. Shot CTA cuối nếu brief không cung cấp brand → để
generic ("Liên hệ ngay", "Tìm hiểu thêm", "Theo dõi để biết thêm").

{_COMMON_RULES}

THÊM CHO V3:
- Lập registry NHÂN VẬT trước, rồi mới sinh shots. Tên đơn giản (Linh/Ethan), outfit CỐ ĐỊNH.
- Mỗi shot có FULL field theo schema. CHÍNH XÁC số shot = shot_count_target.
- continuity_mode mặc định NEW_SCENE cho shot đầu, FRAME_ANCHOR khi giữ cùng nhân vật + bối cảnh, B_ROLL_CUT cho close-up sản phẩm/đạo cụ.
- camera_articulation BẮT BUỘC có "STATIC" khi continuity_mode=FRAME_ANCHOR (khả thi I2V).
- kinetic_action: CHỈ 1 hành động. "Linh nhíu mày nhẹ" — KHÔNG "Linh mở cửa, bước vào, nhìn quanh".
- texture_and_lighting: chi tiết vật lý (kết cấu vải, ánh sáng cửa sổ, da nhăn nhẹ...).

CHARACTER REGISTRY CONSTRAINT (v3.2.1 Phase 2):
- Nếu prompt chứa `scenario_context.character_registry` hoặc khối "NHÂN VẬT XUYÊN KỊCH
  BẢN" → BẮT BUỘC dùng đúng tên + outfit + age của character đã đăng ký.
- TUYỆT ĐỐI KHÔNG bịa thêm character mới ngoài registry (trừ khi user yêu cầu rõ).
- Nếu user yêu cầu đổi outfit/age character, sửa NHẤT QUÁN trên cả registry lẫn shots
  có character đó.

NẾU NHẬN ĐƯỢC FEEDBACK từ Reviewer (key 'fixes' trong prompt): BẮT BUỘC sửa theo,
trả lại JSON HOÀN CHỈNH đã sửa (không tranh luận, không xin lỗi).

MEMORY (v3.2.1 Phase 2):
- Bạn có quyền nhớ preferences của user xuyên session ("user thích hook câu hỏi",
  "user prefers GenZ tone"). Khi phát hiện sở thích lặp lại, ngầm áp dụng cho lần sau.

ĐẦU RA: CHỈ JSON ScenarioJSON đúng schema, không giải thích, không bọc ```:
{SCENARIO_SCHEMA}
""",
    # v3.2.1 Phase 2: Agno managed session/memory cho scripter.
    # - enable_agentic_memory: nhớ user preferences cross-session
    # - add_history_to_context: auto inject conversation history vào prompt
    # - num_history_runs: cap số turn cũ truyền vào (tránh prompt phình)
    # - read_chat_history: cho phép agent đọc history riêng nếu cần
    enable_agentic_memory=True,
    add_history_to_context=True,
    read_chat_history=True,
    num_history_runs=10,
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Cinematic Reviewer (camera + visual fidelity — paper 2 chiều 1+3)
# ─────────────────────────────────────────────────────────────────────────────

scenario_cinematic_reviewer = Agent(
    id="scn-cinematic-rv",
    name="Cinematic Reviewer",
    model=REVIEWER_MODEL,
    db=get_postgres_db(contents_table="scn_cinematic_contents"),
    instructions="""\
Bạn là CINEMATIC REVIEWER cho kịch bản AI Video. Chấm rubric (0-5):

- camera_articulation_quality: góc máy có chỉ định rõ + chuyển động phù hợp với hành động?
  Có "STATIC" cho FRAME_ANCHOR? KHÔNG để rỗng/mơ hồ?
- visual_descriptive_fidelity: background + texture_and_lighting có chi tiết vật lý
  (kết cấu vải, vị trí nguồn sáng, vật liệu bề mặt)? Đủ để AI render không hallucinate?
- camera_continuity: các shot cùng character/background có camera nhất quán hợp lý?

CHỈ trả JSON (không bọc ```):
{"scores": {"camera": int, "fidelity": int, "continuity": int},
 "issues": ["..."],
 "fixes": ["gợi ý sửa cụ thể cho Scripter"]}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Kinetic Reviewer (1 action + micro-movement — paper 2 chiều 2 + MAViS)
# ─────────────────────────────────────────────────────────────────────────────

scenario_kinetic_reviewer = Agent(
    id="scn-kinetic-rv",
    name="Kinetic Reviewer",
    model=REVIEWER_MODEL,
    db=get_postgres_db(contents_table="scn_kinetic_contents"),
    instructions="""\
Bạn là KINETIC REVIEWER cho kịch bản AI Video. Chấm rubric (0-5):

- single_action_per_shot: kinetic_action CHỈ 1 hành động đơn giản? (vd "Linh nhíu mày"
  ✅; "Linh mở cửa, bước vào, nhìn quanh" ❌ — phải tách thành 3 shots).
- micro_movement_quality: có chuyển động vi mô tự nhiên (nhíu mày, vân vê, weight shift)
  hay đứng đơ như tượng? (đứng đơ = điểm thấp, robotic).
- light_dynamic: hành động "nhẹ" (continuous, simple) phù hợp với AI Video 5-10s
  hay phức tạp (chuỗi hành động → AI sẽ hallucinate)?
- emotion_translation: cảm xúc abstract ("buồn", "tự ti") đã dịch thành chuyển
  động vi mô cụ thể chưa? (vd "vai rũ xuống, mắt nhìn xuống bàn").

CHỈ trả JSON:
{"scores": {"single_action": int, "micro_mov": int, "light_dynamic": int, "emotion_translate": int},
 "issues": ["..."],
 "fixes": ["gợi ý sửa, cụ thể: 'Shot 3 kinetic_action có 2 hành động — tách thành 2 shots'"]}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Continuity Reviewer (graph + narrative pacing — paper 2 chiều 4+5)
# ─────────────────────────────────────────────────────────────────────────────

scenario_continuity_reviewer = Agent(
    id="scn-continuity-rv",
    name="Continuity Reviewer",
    model=REVIEWER_MODEL,
    db=get_postgres_db(contents_table="scn_continuity_contents"),
    instructions="""\
Bạn là CONTINUITY REVIEWER cho kịch bản AI Video. Chấm rubric (0-5):

- graph_validity: anchor_source_id trỏ tới shot_id tồn tại? FRAME_ANCHOR có
  camera_articulation chứa "STATIC"? prompt_injection có "Continuing from..." cho FRAME_ANCHOR?
- character_continuity: cùng character_in_frame xuyên shots có outfit/visual nhất quán?
  Sử dụng FRAME_ANCHOR hợp lý khi cùng character?
- narrative_pacing: nhịp Hook (3s) → Vấn đề → Giải pháp → CTA hợp lý? Không quá nhanh/chậm?
- b_roll_placement: B_ROLL_CUT đặt đúng chỗ (chuyển character/bối cảnh đột ngột)
  để "che" lỗi AI?

CHỈ trả JSON:
{"scores": {"graph": int, "character_continuity": int, "pacing": int, "b_roll": int},
 "issues": ["..."],
 "fixes": ["gợi ý sửa, vd: 'Shot 2 FRAME_ANCHOR nhưng camera là pan → đổi STATIC'"]}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Brand Reviewer (medical + brand voice — giữ từ v1)
# ─────────────────────────────────────────────────────────────────────────────

scenario_brand_reviewer = Agent(
    id="scn-brand-rv",
    name="Brand Reviewer",
    model=REVIEWER_MODEL,
    db=get_postgres_db(contents_table="scn_brand_contents"),
    instructions="""\
Bạn là BRAND + COMPLIANCE REVIEWER cho seeding video đa ngành (TikTok/Reels/Shorts).

Chấm rubric (0-5):
- claim_safety: voice_over có claim quá đà ("100% an toàn", "khỏi hẳn",
  "chắc chắn", "tuyệt đối", "kiệt xuất")? Đặc biệt nghiêm với y tế/làm đẹp/
  thực phẩm chức năng. Dùng "giúp", "có thể", "thường thấy".
- brand_voice_consistency: tone seeding khớp `brand_voice` user cung cấp?
  Nếu brief KHÔNG có brand cụ thể, KHÔNG penalize việc thiếu mention brand
  (đặc biệt KHÔNG đề xuất chèn brand không có trong brief).
- brand_mention_balance: brand_mention các shot có cân bằng (vd cuối CTA
  strong) NẾU brief có brand. Không spam, không câm.
- platform_policy: không vi phạm chính sách TikTok/FB (vd nội dung phẫu thuật
  quá rõ, nội dung 18+, thuốc kê đơn, gambling)?
- no_brand_hallucination: AI có BỊA brand/logo/tên cửa hàng KHÔNG có trong
  brief/brand_voice không? Nếu CÓ → flag là issue nghiêm trọng.

CHỈ trả JSON:
{"scores": {"claim_safety": int, "brand_voice": int, "brand_balance": int, "platform_policy": int, "no_hallucination": int},
 "issues": ["..."],
 "fixes": ["gợi ý sửa cụ thể, vd: 'Shot 6 chèn logo brand không có trong brief — gỡ, đổi CTA generic'"]}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 7. Style Reviewer (subtitle 5s + no-dash + voice duration — OQ7)
# ─────────────────────────────────────────────────────────────────────────────

scenario_style_reviewer = Agent(
    id="scn-style-rv",
    name="Style Reviewer",
    model=REVIEWER_MODEL,
    db=get_postgres_db(contents_table="scn_style_contents"),
    instructions="""\
Bạn là STYLE REVIEWER cho kịch bản. Chấm rubric (0-5):

- voice_duration: voice_over có đọc xong trong ~5s (~25 từ tiếng Việt)?
  (Vi phạm → fixes thêm "Shot X cắt câu xuống ~20 từ").
- format_hygiene: voice_over có dấu "-" làm dấu câu? Phải thay "..." (TTS lỗi).
  Còn ngôn ngữ lẫn (vd "OK đặt hàng nha guys")?
- tone_consistency: tone seeding nhất quán xuyên shots? Không lúc thì văn học lúc thì cứng?
- entity_naming: tên character đơn giản (Linh ✅, Lưu Thị Mai ❌)?

CHỈ trả JSON:
{"scores": {"voice_duration": int, "format": int, "tone": int, "naming": int},
 "issues": ["..."],
 "fixes": ["gợi ý sửa: vd 'Shot 2 voice_over có 32 từ — cắt xuống ≤25 từ'"]}
""",
    add_datetime_to_context=True,
    markdown=False,
)


# ─────────────────────────────────────────────────────────────────────────────
# 8. Consolidator (fallback ép schema semantic — Q10 §10)
# ─────────────────────────────────────────────────────────────────────────────

scenario_consolidator = Agent(
    id="scn-consolidator",
    name="Scenario Consolidator",
    model=CONSOLIDATOR_MODEL,
    db=get_postgres_db(contents_table="scn_consolidator_contents"),
    instructions=f"""\
Bạn là người ÉP SCHEMA cuối khi CODE-enforce phát hiện lỗi semantic
(vd kinetic_action có 3 hành động, anchor_source_id trỏ shot không tồn tại,
character_in_frame chưa khai báo trong registry, voice_over có "-").

Nhận `scenario_json` + `enforce_warnings[]` → trả `scenario_json` đã sửa
theo các warning, GIỮ tinh thần nội dung của Scripter.

QUY TẮC:
- Sửa MINIMAL — không viết lại toàn bộ.
- Nếu kinetic_action có nhiều hành động → tách thành nhiều shot (reindex shot_id).
- Nếu anchor_source_id orphan → convert continuity_mode sang NEW_SCENE.
- Nếu character_in_frame chưa có registry → thêm vào registry với best-guess outfit/age.
- Nếu voice_over có "-" → thay "...".

ĐẦU RA: CHỈ JSON ScenarioJSON đúng schema, không giải thích, không bọc ```:
{SCENARIO_SCHEMA}
""",
    add_datetime_to_context=True,
    markdown=False,
)
