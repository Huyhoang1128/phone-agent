"""AI Scenario v3 — Orchestrator (Layer 3 pipeline).

Pipeline:
    Layer 3.1 EXPLORE  : scenario_scripter sinh ScenarioJSON (1 LLM call)
    Layer 3.2 EXAMINE  : 5 Reviewer SONG SONG asyncio.gather (~3-5s tổng)
    Layer 3.3 ENHANCE  : scenario_scripter sửa theo fixes (1 LLM call, cap I=1)
    Layer 3.4 ENFORCE  : CODE deterministic (xem enforce.py)
    Layer 3.5 CONSOLIDATE: fallback LLM nếu enforce phát hiện semantic violation

Tổng ~15-20s/lần generate. Có file → +5s Layer 2 parse_intent.

Cũng có:
    - parse_intent()         : Layer 2 wrapper cho scenario_parser
    - refine_one_shot()      : sub-pipeline cho 1 shot (Reviser + 1 Reviewer + Reviser + enforce)
    - refine_one_character() : Reviser cho character registry (nhẹ, không reviewer)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from agents.scenario import (
    REVIEWER_BY_FOCUS,
    REVIEWERS,
    scenario_consolidator,
    scenario_parser,
    scenario_scripter,
    scenario_style_reviewer,
)
from utils.cancel import check_cancel  # v3.2.1 Option 3D — TRUE cancel signal check

from .enforce import enforce_character, enforce_scenario, enforce_shot

logger = logging.getLogger(__name__)

# Cap I + threshold (Chốt #15 v3.2 Round 12).
# v3.1 MVP: I=1. v3.2: I=2 + threshold skip vòng 2 khi AI nail nhanh.
# Override qua env SCENARIO_MAX_ITER / SCENARIO_SKIP_THRESHOLD.
import os
MAX_ENHANCE_ITERATIONS = int(os.environ.get("SCENARIO_MAX_ITER", "2"))
THRESHOLD_SKIP_ENHANCE = float(os.environ.get("SCENARIO_SKIP_THRESHOLD", "3.5"))

# Threshold để chạy Consolidator fallback (Q10): nếu warnings có semantic
# violation mà CODE không tự sửa được → gọi LLM consolidator.
SEMANTIC_VIOLATION_KEYWORDS = ("nhiều hành động", "chưa khai báo trong registry")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_json(content: str) -> dict | None:
    """Parse JSON từ output LLM (có thể bọc ```json hoặc kèm chữ)."""
    if not content:
        return None
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start = content.find("{")
    if start != -1:
        depth = 0
        for i in range(start, len(content)):
            if content[i] == "{":
                depth += 1
            elif content[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(content[start:i + 1])
                    except json.JSONDecodeError:
                        break
    return None


def _run_sync(
    agent,
    prompt: str,
    *,
    session_id: str = "",
    user_id: str = "",
) -> dict | None:
    """Gọi 1 agent đồng bộ, parse JSON output.

    v3.2.1 Phase 2: optional session_id + user_id để agent dùng Agno session/memory
    (chỉ áp dụng cho stateful agent như scripter; reviewer/parser stateless bỏ qua).
    """
    try:
        run_kwargs: dict = {}
        if session_id:
            run_kwargs["session_id"] = session_id
        if user_id:
            run_kwargs["user_id"] = user_id
        resp = agent.run(prompt, **run_kwargs)
        return _parse_json(getattr(resp, "content", "") or "")
    except TypeError:
        # Agno version cũ không support session_id/user_id kwargs → fallback
        try:
            resp = agent.run(prompt)
            return _parse_json(getattr(resp, "content", "") or "")
        except Exception:  # noqa: BLE001
            logger.exception("Agent %s run failed (fallback)", getattr(agent, "id", "?"))
            return None
    except Exception:  # noqa: BLE001
        logger.exception("Agent %s run failed", getattr(agent, "id", "?"))
        return None


async def _run_async(agent, prompt: str, *, session_id: str = "", user_id: str = "") -> dict | None:
    """Wrap agent.run() async qua to_thread (agno là sync)."""
    return await asyncio.to_thread(
        _run_sync, agent, prompt, session_id=session_id, user_id=user_id
    )


def _character_registry_block(scenario_context: dict | None) -> str:
    """v3.2.1 Phase 2.3 — Format character registry thành block constraint chèn vào prompt.

    Pattern Context Provider của Agno (simplified): mọi prompt liên quan scenario
    đều có block này ở đầu → scripter KHÔNG bịa character ngoài registry.
    """
    if not isinstance(scenario_context, dict):
        return ""
    registry = (
        scenario_context.get("character_registry")
        or scenario_context.get("global_character_registry")
        or []
    )
    if not registry:
        return ""
    lines = ["NHÂN VẬT XUYÊN KỊCH BẢN (BẮT BUỘC dùng đúng tên + outfit + age, KHÔNG bịa):"]
    for c in registry:
        if not isinstance(c, dict):
            continue
        name = (c.get("name") or "").strip()
        if not name:
            continue
        bits = [name]
        if c.get("age"):
            bits.append(str(c["age"]))
        if c.get("ethnicity"):
            bits.append(str(c["ethnicity"]))
        if c.get("outfit_style"):
            bits.append(str(c["outfit_style"]))
        lines.append(f"  - {' · '.join(bits)}")
    return "\n".join(lines) + "\n\n"


# ─────────────────────────────────────────────────────────────────────────────
# Layer 2: Parser Agent
# ─────────────────────────────────────────────────────────────────────────────

def parse_intent(raw_text: str, brief: str) -> dict:
    """Layer 2: trích IntentJSON từ raw_text + brief. Trả {} nếu fail soft."""
    if not raw_text:
        return {}
    prompt = (
        f"user_brief:\n{brief or '(không có)'}\n\n"
        f"raw_text:\n{raw_text[:50000]}\n\n"
        "Hãy phân tích và trả về INTENT JSON đúng schema."
    )
    return _run_sync(scenario_parser, prompt) or {}


# ─────────────────────────────────────────────────────────────────────────────
# Layer 3: Scripter + 5 Reviewer + Enforce
# ─────────────────────────────────────────────────────────────────────────────

def _build_scripter_prompt(
    brief: str,
    duration: int,
    shot_count: int,
    genre: str,
    brand_prompt: str,
    intent_json: dict,
    raw_text: str,
) -> str:
    """System-like prompt cho Scripter EXPLORE step."""
    return (
        f"brand_voice (BẮT BUỘC bám theo):\n{brand_prompt}\n\n"
        f"genre: {genre}\n"
        f"duration_target_seconds: {duration}\n"
        f"shot_count_target: {shot_count}\n\n"
        f"user_brief:\n{brief}\n\n"
        f"intent_json (từ Parser Agent Layer 2, tham khảo ý đồ):\n"
        f"{json.dumps(intent_json, ensure_ascii=False, indent=2) if intent_json else '(none)'}\n\n"
        f"raw_text_fallback (chỉ dùng khi intent_json rỗng):\n"
        f"{raw_text[:2000] if raw_text and not intent_json else '(none)'}\n\n"
        f"Hãy SINH KỊCH BẢN PHÂN TẦNG (JSON ScenarioJSON) đúng số shot = {shot_count}."
    )


def _build_reviewer_prompt(scenario_json: dict) -> str:
    return (
        "Chấm điểm + góp ý fixes cho ScenarioJSON sau (trả JSON {scores, issues, fixes}):\n"
        + json.dumps(scenario_json, ensure_ascii=False, indent=2)
    )


def _build_enhance_prompt(draft: dict, feedback: str) -> str:
    return (
        "Bản nháp:\n"
        + json.dumps(draft, ensure_ascii=False, indent=2)
        + "\n\nFEEDBACK gộp từ 5 Reviewer (BẮT BUỘC sửa theo):\n"
        + feedback
        + "\n\nXuất lại ScenarioJSON HOÀN CHỈNH đã sửa."
    )


def _build_consolidator_prompt(scenario_json: dict, enforce_warnings: list[str]) -> str:
    return (
        "scenario_json hiện tại (đã qua CODE-enforce nhưng còn lỗi semantic):\n"
        + json.dumps(scenario_json, ensure_ascii=False, indent=2)
        + "\n\nenforce_warnings (BẮT BUỘC sửa):\n"
        + "\n".join(f"- {w}" for w in enforce_warnings)
        + "\n\nSửa MINIMAL — chỉ những chỗ liên quan warning. Trả lại ScenarioJSON đầy đủ."
    )


async def _run_5_reviewer_async(scenario_json: dict) -> tuple[list[str], float]:
    """Gọi 5 Reviewer song song qua asyncio.gather. Gom fixes + tính avg score.

    Returns: (fixes_list, avg_score across all reviewers' all dimensions).
    v3.2: avg_score dùng cho threshold skip vòng 2 Enhance (Chốt #15).
    """
    prompt = _build_reviewer_prompt(scenario_json)
    results = await asyncio.gather(
        *(_run_async(rv, prompt) for rv in REVIEWERS),
        return_exceptions=True,
    )
    fixes: list[str] = []
    all_scores: list[float] = []
    for r in results:
        if isinstance(r, Exception) or not isinstance(r, dict):
            continue
        for f in (r.get("fixes") or []):
            if str(f).strip():
                fixes.append(str(f).strip())
        # Aggregate scores cho threshold check
        scores_dict = r.get("scores") or {}
        if isinstance(scores_dict, dict):
            for v in scores_dict.values():
                try:
                    all_scores.append(float(v))
                except (TypeError, ValueError):
                    continue
    avg_score = sum(all_scores) / len(all_scores) if all_scores else 0.0
    return fixes, avg_score


def _has_semantic_violation(warnings: list[str]) -> bool:
    return any(any(kw in w for kw in SEMANTIC_VIOLATION_KEYWORDS) for w in warnings)


def _run_reviewers_sync(draft: dict) -> tuple[list[str], float]:
    """Sync wrapper cho _run_5_reviewer_async (handle event loop edge case)."""
    try:
        return asyncio.run(_run_5_reviewer_async(draft))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_run_5_reviewer_async(draft))
        finally:
            loop.close()


def generate_from_brief(
    brief: str,
    duration_target_seconds: int = 30,
    shot_count_target: int = 6,
    genre: str = "seeding",
    brand_prompt: str = "",
    intent_json: dict | None = None,
    raw_text: str = "",
    *,
    session_id: str = "",
    user_id: str = "",
    request_id: str = "",
) -> dict:
    """Sinh ScenarioJSON từ brief + intent + brand.

    v3.2 (Chốt #15): cap I=2 + threshold ≥3.5/5:
      - vòng 1 Enhance: LUÔN chạy (nếu có fixes)
      - vòng 2 Enhance: chỉ chạy nếu sau vòng 1 reviewers chấm < threshold

    Returns: {
        "scenario": <ScenarioJSON>,
        "warnings": [...],
        "iterations_used": int,
        "final_avg_score": float,
    }
    """
    intent_json = intent_json or {}

    # v3.2.1 Option 3D: check_cancel ở các layer boundary. Mỗi check ~1ms (Redis GET).
    # Nếu user click Hủy giữa LLM call (vd Scripter đang chạy ~5s), call đó tiếp tục
    # đến hết — KHÔNG cancel mid-LLM-call (vì OpenAI API không support). Layer NEXT
    # sẽ check signal → raise ScenarioCancelled → return early → save cost từ đó.

    # 3.1 EXPLORE
    check_cancel(request_id, layer="pre_explore")
    explore_prompt = _build_scripter_prompt(
        brief, duration_target_seconds, shot_count_target,
        genre, brand_prompt, intent_json, raw_text,
    )
    draft = _run_sync(
        scenario_scripter, explore_prompt,
        session_id=session_id, user_id=user_id,
    ) or {}

    # 3.2 + 3.3 EXAMINE + ENHANCE loop (cap I, threshold skip)
    # Reviewers stateless → KHÔNG pass session_id (tránh polluting scripter memory).
    iterations_used = 0
    final_avg_score = 0.0
    for iteration in range(1, MAX_ENHANCE_ITERATIONS + 1):
        check_cancel(request_id, layer=f"pre_examine_iter_{iteration}")
        fixes, avg_score = _run_reviewers_sync(draft)
        final_avg_score = avg_score
        if not fixes:
            # Reviewer hoàn toàn happy → không cần enhance
            iterations_used = iteration - 1
            break
        # ENHANCE theo fixes
        check_cancel(request_id, layer=f"pre_enhance_iter_{iteration}")
        feedback = "\n".join(f"- {x}" for x in fixes[:30])
        enhanced = _run_sync(
            scenario_scripter, _build_enhance_prompt(draft, feedback),
            session_id=session_id, user_id=user_id,
        )
        if enhanced:
            draft = enhanced
        iterations_used = iteration
        # Threshold check: nếu avg ≥ threshold sau vòng này → skip vòng tiếp
        if iteration < MAX_ENHANCE_ITERATIONS and avg_score >= THRESHOLD_SKIP_ENHANCE:
            logger.info(
                "scenario gen: skip iter %d/%d (avg %.2f ≥ threshold %.2f)",
                iteration + 1, MAX_ENHANCE_ITERATIONS, avg_score, THRESHOLD_SKIP_ENHANCE,
            )
            break

    # 3.4 ENFORCE CODE (no LLM call, no cancel check needed — chạy nhanh)
    enforced, warnings = enforce_scenario(draft)

    # 3.5 CONSOLIDATE fallback (chỉ nếu có semantic violation)
    if _has_semantic_violation(warnings):
        check_cancel(request_id, layer="pre_consolidate")
        consolidated = _run_sync(
            scenario_consolidator,
            _build_consolidator_prompt(enforced, warnings),
        )
        if consolidated:
            enforced, warnings_after = enforce_scenario(consolidated)
            warnings = warnings_after  # replace với new warnings

    # Inject input metadata
    enforced.setdefault("title", _suggest_title(brief, intent_json))
    enforced["duration_target_seconds"] = duration_target_seconds
    enforced["shot_count_target"] = shot_count_target
    enforced["genre"] = genre

    return {
        "scenario": enforced,
        "warnings": warnings,
        # v3.2 telemetry — FE/admin có thể display để debug/tune
        "iterations_used": iterations_used,
        "final_avg_score": round(final_avg_score, 2),
    }


def _suggest_title(brief: str, intent_json: dict) -> str:
    """Title fallback từ brief (50 ký tự đầu) hoặc intent."""
    if intent_json.get("brand_hints"):
        brand = intent_json["brand_hints"][0]
        return f"{brand} — AI Scenario"
    return (brief or "AI Scenario")[:80]


# ─────────────────────────────────────────────────────────────────────────────
# optimize_whole_scenario — full 3E re-run trên scenario có sẵn (v3.2 Nhóm A)
# ─────────────────────────────────────────────────────────────────────────────


def optimize_whole_scenario(
    scenario: dict,
    brand_prompt: str = "",
    variant_brief: str = "",
    *,
    session_id: str = "",
    user_id: str = "",
    request_id: str = "",
) -> dict:
    """Chạy lại full 3E pipeline trên 1 scenario có sẵn (v3.2 — tool thứ 6 trong toolkit).

    Khác `generate_from_brief`:
      - Input là scenario có sẵn (đầy đủ registry + shots) thay vì brief thuần
      - Optional `variant_brief` (vd "tone bí ẩn hơn") chèn vào prompt
      - Giữ structure (số shot, registry) nhưng cho phép viết lại content

    Returns: {scenario, warnings, iterations_used, final_avg_score}.
    """
    if not isinstance(scenario, dict) or not scenario.get("shots"):
        raise ValueError("scenario phải là dict có 'shots'.")

    # 3.1 EXPLORE — Scripter viết lại với brand + variant brief
    # v3.2.1 Phase 2.3: chèn character constraint block đầu prompt.
    char_block = _character_registry_block(
        {"global_character_registry": scenario.get("global_character_registry")
         or scenario.get("character_registry") or []}
    )
    check_cancel(request_id, layer="optimize_pre_explore")
    explore_prompt = (
        f"{char_block}"
        f"brand_voice (BẮT BUỘC bám theo):\n{brand_prompt}\n\n"
        f"variant_brief: {variant_brief or '(không có — chỉ optimize chất lượng tổng)'}\n\n"
        f"genre: {scenario.get('genre', 'seeding')}\n"
        f"duration_target_seconds: {scenario.get('duration_target_seconds', 30)}\n"
        f"shot_count_target: {scenario.get('shot_count_target', len(scenario.get('shots') or []))}\n\n"
        f"scenario hiện tại (giữ structure + registry, viết lại content cho hay hơn):\n"
        f"{json.dumps(scenario, ensure_ascii=False, indent=2)}\n\n"
        "Trả lại ScenarioJSON HOÀN CHỈNH đã optimize (giữ shot_id, character names, "
        "anchor graph; cải thiện voice_over + camera + kinetic + visual cho cuốn hơn). "
        "Nếu có variant_brief, áp tone đó."
    )
    draft = _run_sync(
        scenario_scripter, explore_prompt,
        session_id=session_id, user_id=user_id,
    ) or scenario

    # 3.2 + 3.3 EXAMINE + ENHANCE (cap I + threshold)
    iterations_used = 0
    final_avg_score = 0.0
    for iteration in range(1, MAX_ENHANCE_ITERATIONS + 1):
        check_cancel(request_id, layer=f"optimize_pre_examine_iter_{iteration}")
        fixes, avg_score = _run_reviewers_sync(draft)
        final_avg_score = avg_score
        if not fixes:
            iterations_used = iteration - 1
            break
        check_cancel(request_id, layer=f"optimize_pre_enhance_iter_{iteration}")
        feedback = "\n".join(f"- {x}" for x in fixes[:30])
        enhanced = _run_sync(
            scenario_scripter, _build_enhance_prompt(draft, feedback),
            session_id=session_id, user_id=user_id,
        )
        if enhanced:
            draft = enhanced
        iterations_used = iteration
        if iteration < MAX_ENHANCE_ITERATIONS and avg_score >= THRESHOLD_SKIP_ENHANCE:
            break

    # 3.4 ENFORCE + 3.5 Consolidator fallback
    enforced, warnings = enforce_scenario(draft)
    if _has_semantic_violation(warnings):
        check_cancel(request_id, layer="optimize_pre_consolidate")
        consolidated = _run_sync(
            scenario_consolidator,
            _build_consolidator_prompt(enforced, warnings),
        )
        if consolidated:
            enforced, warnings = enforce_scenario(consolidated)

    return {
        "scenario": enforced,
        "warnings": warnings,
        "iterations_used": iterations_used,
        "final_avg_score": round(final_avg_score, 2),
    }


# ─────────────────────────────────────────────────────────────────────────────
# refine_one_shot — sub-pipeline cho 1 shot
# ─────────────────────────────────────────────────────────────────────────────

def refine_one_shot(
    shot: dict,
    scenario_context: dict,
    brief: str,
    fields: list[str] | None = None,
    reviewer_focus: str = "style",
    *,
    session_id: str = "",
    user_id: str = "",
    request_id: str = "",
) -> dict:
    """Refine 1 shot: Reviser → 1 Reviewer (focus) → Reviser → CODE-enforce.

    Returns: {"shot": <new shot dict>, "warnings": [...]}.
    """
    fields = fields or []
    reviewer = REVIEWER_BY_FOCUS.get(reviewer_focus, scenario_style_reviewer)

    # v3.2.1 Phase 2.3: character registry constraint block đầu prompt.
    char_block = _character_registry_block(scenario_context)

    # v3.2.1 Option 3D: check_cancel ở các layer của refine sub-pipeline
    check_cancel(request_id, layer="refine_shot_pre_explore")

    # EXPLORE — sửa shot với brief
    explore_prompt = (
        f"{char_block}"
        f"scenario_context:\n{json.dumps(scenario_context, ensure_ascii=False, indent=2)[:3000]}\n\n"
        f"original_shot:\n{json.dumps(shot, ensure_ascii=False, indent=2)}\n\n"
        f"brief (yêu cầu sửa):\n{brief}\n\n"
        f"fields_focus (nếu khác rỗng, chỉ sửa các field này): {fields or '(tất các field nội dung)'}\n\n"
        "Sửa shot này. Trả JSON CHỈ 1 shot (đúng schema field của Shot trong ScenarioJSON), "
        "KHÔNG bọc trong scenario/shots. Không bịa character ngoài registry."
    )
    candidate = _run_sync(
        scenario_scripter, explore_prompt,
        session_id=session_id, user_id=user_id,
    ) or shot

    # EXAMINE — 1 reviewer (stateless, không pass session)
    check_cancel(request_id, layer="refine_shot_pre_examine")
    examine_prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong context kịch bản gốc).\n"
        f"shot:\n{json.dumps(candidate, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_sync(reviewer, examine_prompt) or {}
    fixes = [str(x).strip() for x in (review.get("fixes") or []) if str(x).strip()]

    # ENHANCE
    if fixes:
        check_cancel(request_id, layer="refine_shot_pre_enhance")
        feedback = "\n".join(f"- {x}" for x in fixes[:15])
        enhance_prompt = (
            f"{char_block}"
            f"shot hiện tại:\n{json.dumps(candidate, ensure_ascii=False, indent=2)}\n\n"
            f"FEEDBACK reviewer (BẮT BUỘC sửa):\n{feedback}\n\n"
            "Trả lại shot đã sửa (chỉ 1 shot)."
        )
        enhanced = _run_sync(
            scenario_scripter, enhance_prompt,
            session_id=session_id, user_id=user_id,
        )
        if isinstance(enhanced, dict):
            # Có thể agent trả {shots: [{...}]} — unwrap nếu cần
            candidate = enhanced.get("shots", [enhanced])[0] if "shots" in enhanced else enhanced

    # ENFORCE
    valid_chars = {c.get("name") for c in (scenario_context.get("character_registry") or []) if c.get("name")}
    enforced_shot, warnings = enforce_shot(candidate, valid_chars)

    return {"shot": enforced_shot, "warnings": warnings}


# ─────────────────────────────────────────────────────────────────────────────
# refine_one_character — đơn giản, không reviewer
# ─────────────────────────────────────────────────────────────────────────────

def refine_one_character(
    character: dict,
    scenario_context: dict,
    brief: str,
    fields: list[str] | None = None,
    *,
    session_id: str = "",
    user_id: str = "",
) -> dict:
    """Refine 1 character (outfit/age/ethnicity...). 1 LLM call, không reviewer.

    Returns: {"character": <new character dict>}.
    """
    fields = fields or []
    prompt = (
        f"scenario_context (title + genre):\n{json.dumps(scenario_context, ensure_ascii=False)[:500]}\n\n"
        f"original_character:\n{json.dumps(character, ensure_ascii=False, indent=2)}\n\n"
        f"brief:\n{brief}\n\n"
        f"fields_focus: {fields or '(tất các field outfit/age/ethnicity/voice_id_hint)'}\n\n"
        "Sửa character. Trả JSON CHỈ object character (name + age + ethnicity + outfit_style + voice_id_hint)."
    )
    candidate = _run_sync(
        scenario_scripter, prompt,
        session_id=session_id, user_id=user_id,
    ) or character
    enforced_char = enforce_character(candidate)
    # Đảm bảo name không đổi (id stable)
    enforced_char["name"] = character.get("name") or enforced_char.get("name", "")
    return {"character": enforced_char}
