"""AI Scenario v3 — FastAPI routes (4 endpoint).

Django proxy gọi qua HTTP với JWT forward. JWT verify ở GoJWTMiddleware
(cùng DJANGO_SECRET_KEY).
"""
from __future__ import annotations

import logging
import asyncio
import json
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from teams.scenario import (
    generate_from_brief,
    optimize_whole_scenario,
    parse_intent,
    refine_one_character,
    refine_one_shot,
)
from utils.cancel import ScenarioCancelled, is_cancelled
from agents.scenario import scenario_chat_refiner
from agents.scenario.creative_tools import (
    current_scenario_context_var,
    sse_queue_var,
    sse_loop_var,
    reply_text_var,
    action_taken_var,
    diagnosis_summary_var,
    request_id_var,
    _push_sse_event,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/scenario", tags=["scenario"])


# ─── Parse Intent ────────────────────────────────────────────────────────────


class ParseIntentRequest(BaseModel):
    raw_text: str = Field(..., description="Raw text extract từ file (Layer 1 đã làm ở Django)")
    brief: str = Field("", description="User brief để Parser hiểu ngữ cảnh")


class ParseIntentResponse(BaseModel):
    intent_json: dict


@router.post("/parse-intent", response_model=ParseIntentResponse)
def parse_intent_route(req: ParseIntentRequest) -> ParseIntentResponse:
    """Layer 2 — trả IntentJSON. Fail soft: trả {} nếu Parser lỗi."""
    try:
        intent = parse_intent(req.raw_text, req.brief)
    except Exception as exc:  # noqa: BLE001
        logger.exception("parse-intent failed")
        raise HTTPException(status_code=502, detail=f"Parser lỗi: {str(exc)[:200]}")
    return ParseIntentResponse(intent_json=intent or {})


# ─── Generate ─────────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    brief: str = Field(..., description="User brief (bắt buộc)")
    duration_target_seconds: int = Field(30, ge=10, le=120)
    shot_count_target: int = Field(6, ge=1, le=20)
    genre: str = Field("seeding")
    brand_prompt: str = Field("", description="Brand voice 3-lớp đã resolved ở Django")
    intent_json: dict = Field(default_factory=dict)
    raw_text: str = Field("", description="Fallback nếu intent_json rỗng")
    # v3.2.1 Phase 2 — Agno session/memory continuity
    session_id: str = Field("", description="Agno session ID (deterministic per user×scenario)")
    user_id: str = Field("", description="Agno user ID (cho cross-session memory)")
    # v3.2.1 Option 3D — TRUE cancel signal qua Redis
    request_id: str = Field("", description="UUID client gửi để cancel mid-pipeline qua Redis")


class GenerateResponse(BaseModel):
    scenario: dict
    warnings: list[str]
    iterations_used: int = 0
    final_avg_score: float = 0.0


@router.post("/generate", response_model=GenerateResponse)
def generate_route(req: GenerateRequest) -> GenerateResponse:
    """Layer 3 — Sinh ScenarioJSON từ brief. ~15-20s/lần.

    v3.2.1 Option 3D: pass request_id để orchestrator check Redis cancel signal
    trước mỗi LLM call → raise ScenarioCancelled nếu user đã hủy → HTTP 499.
    """
    try:
        result = generate_from_brief(
            brief=req.brief,
            duration_target_seconds=req.duration_target_seconds,
            shot_count_target=req.shot_count_target,
            genre=req.genre,
            brand_prompt=req.brand_prompt,
            intent_json=req.intent_json,
            raw_text=req.raw_text,
            session_id=req.session_id,
            user_id=req.user_id,
            request_id=req.request_id,
        )
    except ScenarioCancelled as exc:
        # v3.2.1 3D: user cancel mid-pipeline qua Redis signal
        logger.info("scenario generate cancelled: %s", exc)
        raise HTTPException(status_code=499, detail=f"Cancelled at layer {exc.layer!r}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("scenario generate failed")
        raise HTTPException(status_code=502, detail=f"Scripter lỗi: {str(exc)[:200]}")
    return GenerateResponse(**result)


# ─── Refine Shot ──────────────────────────────────────────────────────────────


class RefineShotRequest(BaseModel):
    shot: dict
    scenario_context: dict = Field(default_factory=dict)
    brief: str = ""
    fields: list[str] = Field(default_factory=list)
    reviewer_focus: str = Field("style")
    # v3.2.1 Phase 2
    session_id: str = Field("", description="Agno session ID")
    user_id: str = Field("", description="Agno user ID")
    # v3.2.1 Option 3D
    request_id: str = Field("", description="UUID client gửi để cancel mid-pipeline")


class RefineShotResponse(BaseModel):
    shot: dict
    warnings: list[str]


@router.post("/refine-shot", response_model=RefineShotResponse)
def refine_shot_route(req: RefineShotRequest) -> RefineShotResponse:
    """Sub-pipeline refine 1 shot: ~15s (3 LLM call). Dùng cho chat tool calling."""
    try:
        result = refine_one_shot(
            shot=req.shot,
            scenario_context=req.scenario_context,
            brief=req.brief,
            fields=req.fields,
            reviewer_focus=req.reviewer_focus,
            session_id=req.session_id,
            user_id=req.user_id,
            request_id=req.request_id,
        )
    except ScenarioCancelled as exc:
        logger.info("refine-shot cancelled: %s", exc)
        raise HTTPException(status_code=499, detail=f"Cancelled at layer {exc.layer!r}")
    except Exception as exc:  # noqa: BLE001
        logger.exception("refine-shot failed")
        raise HTTPException(status_code=502, detail=f"Refine shot lỗi: {str(exc)[:200]}")
    return RefineShotResponse(**result)


# ─── Optimize Whole Scenario (v3.2 Nhóm A) ──────────────────────────────────


class OptimizeWholeRequest(BaseModel):
    scenario: dict = Field(..., description="ScenarioJSON đầy đủ (registry + shots)")
    brand_prompt: str = Field("", description="Brand voice resolved 3-lớp ở Django")
    variant_brief: str = Field(
        "",
        description="Optional tone variant: 'bí ẩn hơn', '60s thay 30s'",
    )
    # v3.2.1 Phase 2
    session_id: str = Field("", description="Agno session ID")
    user_id: str = Field("", description="Agno user ID")
    # v3.2.1 Option 3D
    request_id: str = Field("", description="UUID client gửi để cancel mid-pipeline")


class OptimizeWholeResponse(BaseModel):
    scenario: dict
    warnings: list[str]
    iterations_used: int = 0
    final_avg_score: float = 0.0


@router.post("/optimize-whole", response_model=OptimizeWholeResponse)
def optimize_whole_route(req: OptimizeWholeRequest) -> OptimizeWholeResponse:
    """Re-run full 3E pipeline trên scenario có sẵn. ~30s (5-7 LLM call)."""
    try:
        result = optimize_whole_scenario(
            scenario=req.scenario,
            brand_prompt=req.brand_prompt,
            variant_brief=req.variant_brief,
            session_id=req.session_id,
            user_id=req.user_id,
            request_id=req.request_id,
        )
    except ScenarioCancelled as exc:
        logger.info("optimize-whole cancelled: %s", exc)
        raise HTTPException(status_code=499, detail=f"Cancelled at layer {exc.layer!r}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("optimize-whole failed")
        raise HTTPException(status_code=502, detail=f"Optimize whole lỗi: {str(exc)[:200]}")
    return OptimizeWholeResponse(**result)


# ─── Refine Character ─────────────────────────────────────────────────────────


class RefineCharacterRequest(BaseModel):
    character: dict
    scenario_context: dict = Field(default_factory=dict)
    brief: str = ""
    fields: list[str] = Field(default_factory=list)
    # v3.2.1 Phase 2
    session_id: str = Field("", description="Agno session ID")
    user_id: str = Field("", description="Agno user ID")


class RefineCharacterResponse(BaseModel):
    character: dict


@router.post("/refine-character", response_model=RefineCharacterResponse)
def refine_character_route(req: RefineCharacterRequest) -> RefineCharacterResponse:
    """Refine 1 character registry — 1 LLM call, ~5s."""
    try:
        result = refine_one_character(
            character=req.character,
            scenario_context=req.scenario_context,
            brief=req.brief,
            fields=req.fields,
            session_id=req.session_id,
            user_id=req.user_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("refine-character failed")
        raise HTTPException(status_code=502, detail=f"Refine character lỗi: {str(exc)[:200]}")
    return RefineCharacterResponse(**result)


class RefineChatRequest(BaseModel):
    message: str = Field(..., description="Tin nhắn chat của user")
    scenario_context: dict = Field(..., description="Toàn bộ kịch bản hiện tại (shots + character registry)")
    target_shots: list[int] = Field(default_factory=list, description="Các shot đang được chọn/focus")
    target_character: str = Field("", description="Nhân vật đang được chọn/focus")
    history: list[dict] = Field(
        default_factory=list,
        description="Lịch sử hội thoại gần đây (cũ→mới), [{role:'user'|'assistant', content:str}]. "
        "Django là nguồn sự thật (agent-teams stateless: agentdb không có session table → "
        "Agno auto-memory NO-OP). Dùng để agent hiểu tham chiếu ('nhân vật thứ 2', 'như trên').",
    )
    session_id: str = Field("", description="Agno session ID")
    user_id: str = Field("", description="Agno user ID")
    request_id: str = Field("", description="Request ID để cancel signal")


_LEAN_SHOT_FIELDS = (
    "shot_id", "shot_order", "funnel_part", "character_in_frame", "continuity_mode",
    "voice_over", "kinetic_action", "camera_articulation", "background",
    "character_pose", "prop_description", "texture_and_lighting", "music_hint", "brand_mention",
)


def _lean_scenario_for_prompt(ctx: dict) -> dict:
    """Chỉ giữ trường SÁNG TẠO cần cho prompt — bỏ origin_data + metadata (team, ids,
    timestamps, intent_json...). Tránh prompt phình + agent echo field DB + lười gọi tool.
    (KHÔNG đụng current_scenario_context_var — tool vẫn đọc context đầy đủ.)"""
    if not isinstance(ctx, dict):
        return {}
    return {
        "title": ctx.get("title"),
        "brief": ctx.get("brief"),
        "genre": ctx.get("genre"),
        "duration_target_seconds": ctx.get("duration_target_seconds"),
        "character_registry": ctx.get("character_registry") or [],
        "shots": [
            {k: s.get(k) for k in _LEAN_SHOT_FIELDS if s.get(k) not in (None, "")}
            for s in (ctx.get("shots") or []) if isinstance(s, dict)
        ],
    }


# T38 (Đợt 9 · P1) — verb "đã <làm>" DÙNG CHUNG cho phát hiện (_claims_done) + làm mềm
# (_soften_done_claims). Bao CẢ 2 biến thể dấu tiếng Việt: "xóa" (dấu trên o) LẪN "xoá" (dấu
# trên a) → x[oó][aá]. Thêm điều\s*chỉnh / loại bỏ / gỡ / bổ sung (smoke Đợt 9 lọt:
# "đã xóa thành công", "đã điều chỉnh"). "điều chỉnh" đặt TRƯỚC "chỉnh".
_DONE_VERBS = (
    r"đổi|sửa|thay|cập\s*nhật|x[oó][aá]|thêm|bổ\s*sung|điều\s*chỉnh|chỉnh|"
    r"chuyển|di\s*chuyển|nhân\s*đôi|tạo|áp\s*dụng|thực\s*hiện|hoàn(?:\s*(?:thành|tất))?|"
    r"loại\s*bỏ|gỡ\s*bỏ|gỡ|update"
)

_CLAIMS_DONE_PAT = re.compile(r"đã\s+(?:được\s+)?(?:" + _DONE_VERBS + r")", re.IGNORECASE)


def _claims_done(text: str) -> bool:
    """True nếu câu trả lời TỰ NHẬN đã thực hiện thay đổi (để bắt bịa khi không có action)."""
    return bool(text and _CLAIMS_DONE_PAT.search(text))


# T2 honesty — đổi "đã <làm>" → "đề xuất <làm>" khi action mới là ĐỀ XUẤT chờ Duyệt.
# T38 — dùng _DONE_VERBS chung + NUỐT hậu tố "thành công"/"xong" (vd "đã xóa thành công"
# → "đề xuất xóa") để không còn ngầm khẳng định ĐÃ hoàn tất.
_DONE_TO_PROPOSE_PAT = re.compile(
    r"đã\s+(?:được\s+)?(" + _DONE_VERBS + r")(?:\s+(?:thành\s*công|xong))?",
    re.IGNORECASE,
)


def _soften_done_claims(text: str) -> str:
    """Lớp chốt trung thực (deterministic): khi agent ĐÃ phát đề xuất (proposal chờ user
    Duyệt) nhưng câu chữ khẳng định "đã <làm>" → đổi sang "đề xuất <làm>". Tránh khẳng định
    sai là đã hoàn tất (thực tế chỉ áp dụng SAU khi user bấm Duyệt). Model-independent —
    bắt được cả khi gpt-4o-mini ngỗ ngược không tuân prompt."""
    if not text:
        return text

    def _repl(m: "re.Match") -> str:
        verb = m.group(1)
        prefix = "Đề xuất " if m.group(0)[:1] == "Đ" else "đề xuất "
        return prefix + verb

    return _DONE_TO_PROPOSE_PAT.sub(_repl, text)


# T26 (Đợt 8) — chống "đề xuất rỗng": agent hay mời "bạn duyệt để mình áp dụng" NHƯNG lượt này
# KHÔNG phát đề xuất nào (không có thẻ để bấm) → "nút ma" khiến user non-IT bấm hụt. Prompt-only
# không đủ với gpt-4o-mini → chặn deterministic: đổi sang lời mời hành động ở LƯỢT SAU. Chỉ áp
# khi action_taken=False (lượt chẩn đoán/tư vấn, chưa có proposal/thẻ).
_EMPTY_CTA_PAT = re.compile(
    r"(?:bạn\s+)?(?:có\s+)?(?:muốn\s+)?(?:duyệt|phê\s*duyệt|đồng\s*ý)\s+để\s+(?:mình|tôi)\s+"
    r"(?:áp\s*dụng|thực\s*hiện|sửa|chỉnh)[^.?!\n]*[.?!]?"
    r"|bạn\s+(?:có\s+)?muốn\s+(?:mình|tôi)\s+(?:áp\s*dụng|thực\s*hiện|sửa|chỉnh)[^.?!\n]*[.?!]?",
    re.IGNORECASE,
)


def _soften_empty_cta(text: str) -> str:
    """Đổi lời mời 'bạn duyệt để mình áp dụng…' (khi lượt này CHƯA phát đề xuất/thẻ nào) thành
    lời mời hành động ở lượt sau — honest, không 'nút ma'. Gọi khi action_taken=False."""
    if not text:
        return text
    return _EMPTY_CTA_PAT.sub(
        'Nếu muốn mình áp dụng (các) chỉnh sửa này, bạn nhắn "áp dụng" nhé.', text
    ).strip()


# T12 — phát hiện lỗi nhà cung cấp LLM (quota/429, rate-limit, auth) cho MỌI provider
# (OpenAI/Gemini/Groq) → trả thông điệp THÂN THIỆN cho FE thay vì dump tiếng Anh khó hiểu.
_LLM_ERR_SIGNATURES = re.compile(
    r"exceeded your current quota|resource_exhausted|insufficient_quota|"
    r"check your plan and billing|rate.?limit|too many requests|"
    r"invalid api key|incorrect api key|api key not valid|"
    r"authenticationerror|ratelimiterror|permission_denied|"
    r"error code:\s*429|\b429\b|\b401\b|\b403\b",
    re.IGNORECASE,
)


def _looks_like_llm_error(text) -> bool:
    """True nếu text trông như thông điệp LỖI của nhà cung cấp LLM (không phải nội dung sáng tạo)."""
    return bool(text and _LLM_ERR_SIGNATURES.search(str(text)))


def _friendly_llm_error(source) -> dict:
    """Phân loại lỗi LLM → payload event 'error' thân thiện: {code, message, detail}.
    code ∈ quota_exceeded | rate_limited | auth_error | engine_error (FE render theo code)."""
    s = str(source or "")
    low = s.lower()
    if ("quota" in low or "resource_exhausted" in low or "insufficient_quota" in low
            or "billing" in low):
        code, message = "quota_exceeded", (
            "Hệ thống AI đã hết hạn mức sử dụng (quota) tạm thời. "
            "Vui lòng thử lại sau ít phút, hoặc liên hệ quản trị để nâng hạn mức."
        )
    elif ("rate" in low and "limit" in low) or "too many requests" in low:
        code, message = "rate_limited", (
            "Bạn đang gửi yêu cầu quá nhanh. Vui lòng chờ một lát rồi thử lại."
        )
    elif ("api key" in low or "authentication" in low or "permission_denied" in low
          or " 401" in low or " 403" in low):
        code, message = "auth_error", (
            "Cấu hình khóa AI không hợp lệ hoặc thiếu quyền. Vui lòng liên hệ quản trị."
        )
    else:
        code, message = "engine_error", "Hệ thống AI gặp sự cố tạm thời. Vui lòng thử lại."
    return {"code": code, "message": message, "detail": s[:300]}


def _sanitize_reply(text: str) -> str:
    """Phòng thủ cho text 'final': bỏ khối code/JSON thô + cap độ dài → tránh dump lọt ra."""
    if not text:
        return "Mình đã ghi nhận. Bạn nói rõ hơn nếu muốn mình điều chỉnh điều gì nhé."
    text = re.sub(r"```[\s\S]*?```", "", text)        # bỏ code fence
    text = re.sub(r"\{[\s\S]{200,}?\}", "", text)      # bỏ khối JSON lớn (>200 ký tự)
    text = text.strip()
    if len(text) > 1200:
        text = text[:1200].rstrip() + "…"
    return text or "Mình đã ghi nhận yêu cầu của bạn."


@router.post("/refine-chat-stream")
async def refine_chat_stream(req: RefineChatRequest):
    """Refine Chat Stream SSE endpoint using Agno Agent and ContextVars."""
    queue = asyncio.Queue()
    current_scenario_context_var.set(req.scenario_context)
    sse_queue_var.set(queue)
    diagnosis_summary_var.set(None)   # T34 — reset per-request (tránh rò summary lượt trước)
    request_id_var.set(req.request_id)   # T32 — để _run_reviewer né LLM-call khi user huỷ
    # v4.1 FIX — capture loop ở đây (async context CÓ running loop) để worker thread
    # (asyncio.to_thread bên dưới) đẩy SSE event qua call_soon_threadsafe an toàn.
    sse_loop_var.set(asyncio.get_running_loop())

    prompt_parts = []
    # Lịch sử hội thoại (Django gửi — agent stateless nên đây là "trí nhớ" của agent).
    # Đặt ĐẦU prompt để agent hiểu tham chiếu trước khi đọc yêu cầu mới.
    if req.history:
        hist_lines = []
        for h in req.history:
            if not isinstance(h, dict):
                continue
            content = (h.get("content") or "").strip()
            if not content:
                continue
            who = "Người dùng" if h.get("role") == "user" else "Bạn (Đạo diễn)"
            hist_lines.append(f"{who}: {content}")
        if hist_lines:
            prompt_parts.append(
                "LỊCH SỬ HỘI THOẠI GẦN ĐÂY (trí nhớ của bạn — đặc biệt các gợi ý/lựa chọn BẠN đã đưa ra "
                "trước đó). Dùng nó để hiểu các tham chiếu như 'nhân vật thứ 2', 'cái như trên', "
                "'option bạn vừa đề xuất'. TUYỆT ĐỐI KHÔNG hỏi lại điều user đã nói hoặc bạn đã đề xuất:\n"
                + "\n".join(hist_lines)
            )
    if req.target_shots:
        prompt_parts.append(
            f"⚠️ RÀNG BUỘC PHẠM VI: Người dùng đang CHỈ ĐỊNH phân cảnh {req.target_shots}. CHỈ được "
            f"sửa/đề xuất thay đổi đúng (các) phân cảnh này. TUYỆT ĐỐI KHÔNG đụng tới phân cảnh khác, "
            f"KHÔNG dùng propose_creative_treatment cho toàn kịch bản — trừ khi người dùng nói RÕ "
            f"'toàn bộ'/'tất cả các cảnh'/'cả kịch bản'."
        )
    if req.target_character:
        prompt_parts.append(
            f"⚠️ RÀNG BUỘC NHÂN VẬT: Người dùng đang thao tác với nhân vật '{req.target_character}'. "
            f"Mọi yêu cầu về 'nhân vật' (đổi tên/sửa trang phục/tuổi/...) mà KHÔNG nêu rõ tên nhân vật "
            f"khác → BẮT BUỘC áp dụng cho ĐÚNG nhân vật '{req.target_character}'. TUYỆT ĐỐI KHÔNG "
            f"nhầm sang nhân vật khác (kể cả nhân vật vừa được nhắc trong lịch sử)."
        )

    prompt_parts.append(
        "Kịch bản hiện tại (chỉ để THAM KHẢO, TUYỆT ĐỐI không chép lại JSON/dữ liệu này vào câu trả lời):\n"
        f"{json.dumps(_lean_scenario_for_prompt(req.scenario_context), ensure_ascii=False, indent=2)}\n\n"
        f"Yêu cầu của người dùng: '{req.message}'"
    )
    prompt = "\n".join(prompt_parts)

    async def sse_generator():
        import contextvars
        ctx = contextvars.copy_context()

        def run_agent():
            try:
                # v4.1 FIX — đẩy event qua _push_sse_event (thread-safe, dùng sse_loop_var)
                # thay cho put_nowait trực tiếp (không thread-safe khi gọi từ worker thread).
                ctx.run(_push_sse_event, "thinking", {
                    "thinking_process": "Đạo diễn đang phân tích bối cảnh và yêu cầu của bạn..."
                })

                resp = ctx.run(
                    scenario_chat_refiner.run,
                    prompt,
                    session_id=req.session_id,
                    user_id=req.user_id
                )
                reply = ctx.run(reply_text_var.get) or _sanitize_reply(getattr(resp, "content", "") or "")
                action_taken = ctx.run(action_taken_var.get)
                # v5.1 — agent MÔ TẢ đã làm nhưng CHƯA gọi tool (quên hành động) → ép chạy lại 1 lần.
                if not action_taken and _claims_done(reply):
                    retry_prompt = prompt + (
                        "\n\nLƯU Ý: Bạn vừa mô tả thay đổi nhưng CHƯA gọi công cụ nào. Hãy GỌI NGAY "
                        "công cụ tương ứng để thực hiện (vd manage_character để đổi tên/sửa nhân vật; "
                        "các tool shot/cấu trúc cho phân cảnh). KHÔNG chỉ mô tả bằng lời."
                    )
                    resp = ctx.run(scenario_chat_refiner.run, retry_prompt,
                                   session_id=req.session_id, user_id=req.user_id)
                    reply = ctx.run(reply_text_var.get) or _sanitize_reply(getattr(resp, "content", "") or "")
                    action_taken = ctx.run(action_taken_var.get)
                # Safety net cuối: vẫn claim đã làm mà không có action → câu trung thực (không bịa).
                if not action_taken and _claims_done(reply):
                    reply = "Mình chưa áp dụng được thay đổi đó. Bạn thử gửi lại yêu cầu giúp mình nhé."
                elif action_taken:
                    # T2 honesty: action là ĐỀ XUẤT chờ Duyệt → đổi "đã <làm>" thành "đề xuất <làm>".
                    reply = _soften_done_claims(reply)
                else:
                    # T26 — lượt KHÔNG có đề xuất (chẩn đoán/tư vấn) → đừng treo "bạn duyệt" vào
                    # hư không (không có thẻ để bấm). Đổi sang mời hành động ở lượt sau.
                    reply = _soften_empty_cta(reply)
                # T34 — đã có BẢNG chẩn đoán riêng mà agent vẫn dump lại findings dài (gpt-4o-mini
                # không nghe prompt) → thay bằng tóm tắt NGẮN. Chỉ trên lượt THUẦN chẩn đoán
                # (không kèm mutation) để không nuốt lời mô tả thay đổi.
                _diag_summary = ctx.run(diagnosis_summary_var.get)
                if _diag_summary and not action_taken and len(reply or "") > 400:
                    reply = _diag_summary
                # T12 — đôi khi nhà cung cấp trả lỗi (quota/429) DƯỚI DẠNG nội dung reply (không raise).
                # Phát hiện → báo lỗi thân thiện thay vì hiển thị nguyên văn tiếng Anh như câu trả lời.
                if _looks_like_llm_error(reply):
                    ctx.run(_push_sse_event, "error", _friendly_llm_error(reply))
                else:
                    # T10 — đính model thật vào 'final' để Django ghi telemetry đúng (thay hardcode).
                    _model_id = getattr(getattr(scenario_chat_refiner, "model", None), "id", "") or ""
                    ctx.run(_push_sse_event, "final", {"assistant": reply, "llm_model": _model_id})
            except Exception as e:
                logger.exception("Agno Agent run failed")
                # T12 — lỗi RAISE (quota/auth/...) → phân loại thân thiện cho FE.
                ctx.run(_push_sse_event, "error", _friendly_llm_error(e))
            finally:
                ctx.run(_push_sse_event, "done", {})

        agent_task = asyncio.create_task(asyncio.to_thread(run_agent))

        try:
            while True:
                # T32 — poll cờ huỷ song song với chờ event: nếu không có event trong 0.5s thì
                # check is_cancelled(request_id). User huỷ → phát 'cancelled' + đóng stream gọn
                # (agent thread vẫn chạy hết nền — không kill được — nhưng event bị bỏ qua).
                try:
                    event_data = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if is_cancelled(req.request_id):
                        yield ("event: cancelled\ndata: "
                               + json.dumps({"message": "Đã dừng theo yêu cầu của bạn."},
                                            ensure_ascii=False) + "\n\n")
                        agent_task.cancel()
                        break
                    continue
                evt = event_data.get("event", "message")
                data_str = json.dumps(event_data.get("data", {}), ensure_ascii=False)
                yield f"event: {evt}\ndata: {data_str}\n\n"

                if evt in ("done", "error"):
                    break
        except asyncio.CancelledError:
            agent_task.cancel()
            raise

    return StreamingResponse(sse_generator(), media_type="text/event-stream")
