"""CODE-enforce schema cho ScenarioJSON (Layer 3.4 trong pipeline).

Vai trò:
  - Sanitize (dash "-" → "...", source="", strip whitespace)
  - Validate enum (continuity_mode, funnel_part, brand_mention, genre)
  - Validate graph (anchor_source_id phải trỏ tới shot tồn tại)
  - Auto-fill prompt_injection cho FRAME_ANCHOR
  - Validate character_in_frame ∈ registry hoặc "None"
  - Detect semantic violations (kinetic_action có >1 hành động, voice_over >30 từ)

Trả: (enforced_json, warnings: list[str])

Nếu warnings non-empty + có violation semantic mà CODE không tự sửa được
(vd "kinetic có 3 hành động") → orchestrator gọi Consolidator fallback.
"""
from __future__ import annotations

import re

DASH_EM_RE = re.compile(r"\s*[—–]\s*")           # em/en dash
DASH_HYPHEN_RE = re.compile(r"\s+-\s+")           # gạch nối có khoảng (giữ Q-Lean)
MULTISPACE_RE = re.compile(r"\s{2,}")

VOICE_OVER_WORD_WARN = 30                          # OQ7

ALLOWED_CONTINUITY = {"NEW_SCENE", "FRAME_ANCHOR", "B_ROLL_CUT"}
ALLOWED_FUNNEL = {"Hook", "Vấn đề", "Giải pháp", "CTA", "B-roll", ""}
ALLOWED_BRAND_MENTION = {"none", "soft", "strong"}
ALLOWED_GENRE = {"seeding", "testimonial", "educational", "brand_story"}


def _clean_text(s) -> str:
    """Bỏ gạch ngang dùng làm dấu câu → '...'. Giữ gạch nối từ ghép (Q-Lean)."""
    s = str(s or "")
    s = DASH_EM_RE.sub("... ", s)
    s = DASH_HYPHEN_RE.sub("... ", s)
    return MULTISPACE_RE.sub(" ", s).strip()


def _enforce_enum(value: str, allowed: set, default: str) -> str:
    return value if value in allowed else default


def _word_count(text: str) -> int:
    return len(str(text or "").split())


def enforce_scenario(scenario: dict) -> tuple[dict, list[str]]:
    """Ép ScenarioJSON về đúng schema. Trả (enforced, warnings)."""
    warnings: list[str] = []

    if not isinstance(scenario, dict):
        return {}, ["scenario không phải dict"]

    # Top-level
    enforced: dict = {
        "title": str(scenario.get("title") or "")[:255],
        "duration_target_seconds": int(scenario.get("duration_target_seconds") or 30),
        "shot_count_target": int(scenario.get("shot_count_target") or 6),
        "genre": _enforce_enum(scenario.get("genre", ""), ALLOWED_GENRE, "seeding"),
    }

    # Registry
    registry_in = scenario.get("global_character_registry") or []
    if not isinstance(registry_in, list):
        registry_in = []
    enforced["global_character_registry"] = []
    valid_character_names: set[str] = set()
    for c in registry_in:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        enforced["global_character_registry"].append({
            "name": name,
            "age": str(c.get("age") or "").strip(),
            "ethnicity": str(c.get("ethnicity") or "").strip(),
            "outfit_style": str(c.get("outfit_style") or "").strip(),
            "voice_id_hint": str(c.get("voice_id_hint") or "").strip(),
        })
        valid_character_names.add(name)

    # Shots — pass 1: enforce per-shot fields
    shots_in = scenario.get("shots") or []
    if not isinstance(shots_in, list):
        shots_in = []

    enforced_shots: list[dict] = []
    valid_shot_ids: set[int] = set()
    for i, s in enumerate(shots_in, start=1):
        if not isinstance(s, dict):
            continue

        shot_id = int(s.get("shot_id") or i)
        # Đảm bảo unique — nếu trùng, reindex
        while shot_id in valid_shot_ids:
            shot_id += 1
        valid_shot_ids.add(shot_id)

        # character_in_frame validation
        char_in_frame = str(s.get("character_in_frame") or "").strip()
        if char_in_frame and char_in_frame != "None" and char_in_frame not in valid_character_names:
            warnings.append(
                f"Shot {shot_id}: character_in_frame={char_in_frame!r} chưa khai báo trong registry"
            )
            # Không tự sửa — để Consolidator fallback handle

        # continuity_mode
        continuity = _enforce_enum(
            s.get("continuity_mode", ""), ALLOWED_CONTINUITY, "NEW_SCENE",
        )

        # voice_over duration check (OQ7 soft warning)
        voice_over_clean = _clean_text(s.get("voice_over"))
        wc = _word_count(voice_over_clean)
        if wc > VOICE_OVER_WORD_WARN:
            warnings.append(
                f"Shot {shot_id}: voice_over có {wc} từ (>{VOICE_OVER_WORD_WARN}) — có thể vượt 5s khi TTS"
            )

        # kinetic_action — detect multi-action (semantic violation)
        kinetic = _clean_text(s.get("kinetic_action"))
        if _looks_multi_action(kinetic):
            warnings.append(
                f"Shot {shot_id}: kinetic_action có thể chứa nhiều hành động — nên tách shot"
            )

        # funnel_part
        funnel = _enforce_enum(
            s.get("funnel_part", ""), ALLOWED_FUNNEL, "",
        )

        # brand_mention
        brand_mention = _enforce_enum(
            s.get("brand_mention", "none"), ALLOWED_BRAND_MENTION, "none",
        )

        enforced_shots.append({
            "shot_id": shot_id,
            "shot_order": int(s.get("shot_order") or shot_id),
            "character_in_frame": char_in_frame,
            "continuity_mode": continuity,
            "anchor_source_id": s.get("anchor_source_id"),  # validate pass 2
            "prompt_injection": str(s.get("prompt_injection") or "").strip(),
            "background": _clean_text(s.get("background")),
            "character_pose": _clean_text(s.get("character_pose")),
            "kinetic_action": kinetic,
            "camera_articulation": _clean_text(s.get("camera_articulation")),
            "prop_description": _clean_text(s.get("prop_description")),
            "texture_and_lighting": _clean_text(s.get("texture_and_lighting")),
            "voice_over": voice_over_clean,
            "music_hint": str(s.get("music_hint") or "").strip(),
            "funnel_part": funnel,
            "brand_mention": brand_mention,
        })

    # Pass 2: validate anchor_source_id + auto-fill prompt_injection
    for s in enforced_shots:
        anchor_id = s.get("anchor_source_id")
        if s["continuity_mode"] == "FRAME_ANCHOR":
            if anchor_id is None or int(anchor_id) not in valid_shot_ids:
                warnings.append(
                    f"Shot {s['shot_id']}: FRAME_ANCHOR nhưng anchor_source_id orphan/null "
                    f"→ convert sang NEW_SCENE"
                )
                s["continuity_mode"] = "NEW_SCENE"
                s["anchor_source_id"] = None
                s["prompt_injection"] = ""
            else:
                s["anchor_source_id"] = int(anchor_id)
                # Auto-fill prompt_injection nếu thiếu
                if not s["prompt_injection"]:
                    s["prompt_injection"] = "Continuing from the previous scene,"
                # Warn nếu camera không STATIC
                cam = s["camera_articulation"].lower()
                if "static" not in cam and "tĩnh" not in cam:
                    warnings.append(
                        f"Shot {s['shot_id']}: FRAME_ANCHOR nhưng camera không STATIC — "
                        f"khả thi I2V thấp"
                    )
        else:
            s["anchor_source_id"] = None
            if s["continuity_mode"] in ("NEW_SCENE", "B_ROLL_CUT"):
                s["prompt_injection"] = ""

    enforced["shots"] = enforced_shots
    return enforced, warnings


def _looks_multi_action(text: str) -> bool:
    """Heuristic: kinetic_action có nhiều hành động khi có dấu phẩy nối verbs +
    text đủ dài. Vd 'Linh mở cửa, bước vào, vẫy tay' (3 hành động).

    Lưu ý: không catch hết — Kinetic Reviewer (LLM) là lớp chính catch lỗi này.
    Heuristic chỉ để cảnh báo case rõ ràng.
    """
    if not text:
        return False
    # Đếm phẩy "ngắt hành động" (heuristic)
    commas = text.count(",")
    return commas >= 2 and len(text.split()) > 12


def enforce_shot(shot: dict, valid_character_names: set[str] | None = None) -> tuple[dict, list[str]]:
    """Ép 1 shot riêng lẻ (cho refine_one_shot output). Reuse logic của
    enforce_scenario nhưng scope hẹp."""
    fake_scenario = {
        "global_character_registry": [{"name": n} for n in (valid_character_names or set())],
        "shots": [shot],
    }
    enforced, warnings = enforce_scenario(fake_scenario)
    return (enforced["shots"][0] if enforced.get("shots") else {}), warnings


def enforce_character(character: dict) -> dict:
    """Ép 1 character entry — sanitize string fields."""
    if not isinstance(character, dict):
        return {}
    return {
        "name": str(character.get("name") or "").strip(),
        "age": str(character.get("age") or "").strip(),
        "ethnicity": str(character.get("ethnicity") or "").strip(),
        "outfit_style": str(character.get("outfit_style") or "").strip(),
        "voice_id_hint": str(character.get("voice_id_hint") or "").strip(),
    }
