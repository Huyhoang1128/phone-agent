"""
ScriptStudio Orchestrator (code-điều-phối, deterministic)
=========================================================
Thay coordinate-team (leader LLM hay diễn-giải-lại + rơi ràng buộc) bằng luồng CODE
gọi từng agent theo thứ tự cố định + CODE ÉP HỢP ĐỒNG cứng.

Luồng (1 vòng examine→enhance ~ cap I=2):
  1. EXPLORE : Reviser viết lại (nhận existing_script + brief + cờ TRỰC TIẾP)
  2. EXAMINE : 4 Reviewer chấm + góp 'fixes'
  3. ENHANCE : Reviser sửa theo fixes
  4. ENFORCE : CODE giữ nguyên Footage/Time/Note/khung khi allow_structure_change=false
               (LLM chỉ đóng góp Voice/Text) + chuẩn hoá (Source="", bỏ gạch ngang).

→ Hợp đồng bất khả xâm phạm (đúng "AI sinh nội dung, CODE cập nhật").
Xem docs/gen-content-AI-scriptstudio-thiet-ke.md
"""

from __future__ import annotations

import json
import re

from agents.script_studio import (
    brand_reviewer,
    content_reviewer,
    script_reviser,
    structure_reviewer,
    style_reviewer,
)

REVIEWERS = [structure_reviewer, content_reviewer, style_reviewer, brand_reviewer]
FRAME_KEYS = ["Phần", "Frame", "Voice", "Text", "Visual", "Footage", "Source", "Time", "Music", "Note"]

# Mapping focus → 1 reviewer agent. Used by refine_one_frame() (single-frame
# refine) so user can hand-pick the lens they care about most for this
# specific frame, rather than running all 4 reviewers (overkill for 1 frame).
REVIEWER_BY_FOCUS = {
    "style": style_reviewer,
    "brand": brand_reviewer,
    "content": content_reviewer,
    "structure": structure_reviewer,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _parse_json(content: str) -> dict | None:
    """Parse JSON từ output LLM (có thể bọc ```json hoặc kèm chữ). None nếu thất bại."""
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


def _run(agent, prompt: str) -> dict | None:
    """Gọi 1 agent, trả dict đã parse (hoặc None)."""
    try:
        resp = agent.run(prompt)
        return _parse_json(getattr(resp, "content", "") or "")
    except Exception:  # noqa: BLE001 — 1 agent lỗi không làm sập cả luồng
        return None


_DASH_EM = re.compile(r"\s*[—–]\s*")     # em/en dash
_DASH_HYPHEN = re.compile(r"\s+-\s+")     # gạch nối có khoảng trắng (KHÔNG đụng "Q-Lean")
_MULTISPACE = re.compile(r"\s{2,}")


def _clean_text(s) -> str:
    """Bỏ gạch ngang dùng làm dấu câu → '...' (giữ gạch nối trong từ như Q-Lean)."""
    s = str(s or "")
    s = _DASH_EM.sub("... ", s)
    s = _DASH_HYPHEN.sub("... ", s)
    return _MULTISPACE.sub(" ", s).strip()


def _norm_frame(f: dict) -> dict:
    return {
        "Phần": str(f.get("Phần", "")),
        "Frame": f.get("Frame", ""),
        "Voice": _clean_text(f.get("Voice", "")),
        "Text": _clean_text(f.get("Text", "")),
        "Visual": _clean_text(f.get("Visual", "")),
        "Footage": str(f.get("Footage", "")),
        "Source": "",
        "Time": str(f.get("Time", "")),
        "Music": str(f.get("Music", "")),
        "Note": str(f.get("Note", "")),
    }


def _enforce_contract(original: dict, draft: dict | None, allow_structure_change: bool) -> dict:
    """CODE ép hợp đồng. allow_structure_change=false → giữ NGUYÊN khung+Footage+Time+Note
    của bản gốc, CHỈ lấy Voice/Text từ bản AI (khớp theo số Frame, fallback theo index)."""
    kb = str(original.get("kb_name", ""))
    od = str(original.get("od_number", ""))
    orig_frames = original.get("frames") or []
    draft_frames = (draft or {}).get("frames") or []

    if allow_structure_change:
        src = draft_frames or orig_frames
        return {"kb_name": kb, "od_number": od,
                "frames": [_norm_frame(f) for f in src if isinstance(f, dict)]}

    # giữ khung: map draft theo số Frame để lấy Voice/Text
    by_num: dict[str, dict] = {}
    for i, f in enumerate(draft_frames):
        if isinstance(f, dict):
            by_num[str(f.get("Frame", i + 1))] = f

    out = []
    for i, of in enumerate(orig_frames):
        df = by_num.get(str(of.get("Frame", i + 1)))
        if df is None and i < len(draft_frames) and isinstance(draft_frames[i], dict):
            df = draft_frames[i]
        df = df or {}
        out.append(_norm_frame({
            "Phần": of.get("Phần", ""),
            "Frame": of.get("Frame", i + 1),
            "Voice": df.get("Voice", of.get("Voice", "")),  # AI; fallback gốc
            "Text": df.get("Text", of.get("Text", "")),
            "Visual": df.get("Visual", of.get("Visual", "")),  # AI cải thiện; fallback gốc
            "Footage": of.get("Footage", ""),                # GIỮ gốc
            "Source": "",
            "Time": of.get("Time", ""),                      # GIỮ gốc
            "Music": df.get("Music", of.get("Music", "")),   # AI cải thiện; fallback gốc
            "Note": of.get("Note", ""),                      # GIỮ gốc
        }))
    return {"kb_name": kb, "od_number": od, "frames": out}


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def _explore_prompt(existing: dict, brief: str, mode: str, asc: bool) -> str:
    return (
        f"mode: {mode}\n"
        f"allow_structure_change: {str(asc).lower()}\n"
        f"optimization_brief: {brief or '(không có yêu cầu cụ thể — cứ tối ưu hook, mạch truyện, CTA, giọng văn)'}\n"
        f"existing_script:\n{json.dumps(existing, ensure_ascii=False, indent=2)}\n\n"
        "Hãy VIẾT LẠI và trả về JSON kịch bản đã tối ưu (đúng schema)."
    )


def _reviewer_prompt(draft: dict) -> str:
    return ("Chấm điểm + góp ý (trả JSON {scores, issues, fixes}) cho bản nháp kịch bản sau:\n"
            + json.dumps(draft, ensure_ascii=False, indent=2))


def _enhance_prompt(draft: dict, feedback: str, asc: bool) -> str:
    return (
        f"allow_structure_change: {str(asc).lower()}\n"
        "Bản nháp hiện tại:\n" + json.dumps(draft, ensure_ascii=False, indent=2)
        + "\n\nFEEDBACK từ các Reviewer (BẮT BUỘC sửa theo):\n" + feedback
        + "\n\nXuất lại JSON kịch bản hoàn chỉnh đã sửa (đúng schema)."
    )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
def optimize_script(
    existing_script: dict,
    mode: str = "real_footage",
    allow_structure_change: bool = False,
    optimization_brief: str = "",
) -> dict:
    """Tối ưu 1 kịch bản frame có sẵn. Luôn trả về dict đúng schema (code-enforced)."""
    if not isinstance(existing_script, dict) or not existing_script.get("frames"):
        raise ValueError("existing_script phải là object có 'frames'.")

    # 1) EXPLORE
    draft = _run(script_reviser, _explore_prompt(existing_script, optimization_brief, mode, allow_structure_change))
    draft = draft or existing_script

    # 2) EXAMINE (4 reviewer)
    fixes: list[str] = []
    for rv in REVIEWERS:
        out = _run(rv, _reviewer_prompt(draft)) or {}
        for x in (out.get("fixes") or []):
            if str(x).strip():
                fixes.append(str(x).strip())

    # 3) ENHANCE (1 vòng, nếu có góp ý)
    if fixes:
        feedback = "\n".join(f"- {x}" for x in fixes[:30])
        enhanced = _run(script_reviser, _enhance_prompt(draft, feedback, allow_structure_change))
        draft = enhanced or draft

    # 4) ENFORCE hợp đồng + chuẩn hoá (CODE)
    return _enforce_contract(existing_script, draft, allow_structure_change)


# ---------------------------------------------------------------------------
# refine_one_frame — pipeline gọn (3 LLM call ~5-6s) cho 1 frame
# Spec: docs/Gen_Scenario/chat-refine-design.md §5 (OQ7)
# ---------------------------------------------------------------------------
def _refine_explore_prompt(
    frame: dict,
    full_kb: dict,
    brief: str,
    chat_summary: str,
    mode: str,
    asc: bool,
) -> str:
    """Reviser prompt cho refine 1 frame. Đưa cả KB context để Reviser giữ mạch
    truyện, nhưng nhấn mạnh 'chỉ viết lại frame X'."""
    target_num = frame.get("Frame", "?")
    return (
        f"mode: {mode}\n"
        f"allow_structure_change: {str(asc).lower()}\n"
        f"target_frame_number: {target_num}\n"
        f"optimization_brief: {brief or '(không có brief cụ thể — cải thiện hook/giọng/nhịp cho frame này)'}\n"
        f"recent_chat_with_user (tham khảo ý đồ user, KHÔNG copy nguyên văn):\n"
        f"{chat_summary or '(không có)'}\n\n"
        "Bối cảnh CẢ KB (để bạn giữ mạch truyện, KHÔNG sửa frame khác):\n"
        f"{json.dumps(full_kb, ensure_ascii=False, indent=2)}\n\n"
        f"NHIỆM VỤ: VIẾT LẠI DUY NHẤT frame có Frame={target_num} cho hay hơn.\n"
        "Trả JSON đúng schema (kb_name, od_number, frames=[1 object cho frame được sửa]).\n"
        "KHÔNG xuất các frame khác. KHÔNG kèm giải thích, KHÔNG bọc ```."
    )


def _pick_frame(parsed: dict | None, target_num) -> dict | None:
    """Lấy frame có Frame==target_num từ parsed dict; fallback frame đầu nếu
    không tìm thấy. None nếu parsed rỗng."""
    if not isinstance(parsed, dict):
        return None
    frames = parsed.get("frames") or []
    if not isinstance(frames, list) or not frames:
        return None
    if target_num is not None:
        for f in frames:
            if isinstance(f, dict) and str(f.get("Frame", "")) == str(target_num):
                return f
    # fallback
    return frames[0] if isinstance(frames[0], dict) else None


def _enforce_single_frame(original: dict, candidate: dict | None, asc: bool) -> dict:
    """CODE ép hợp đồng cho 1 frame. allow_structure_change=false (mặc định) →
    GIỮ NGUYÊN Footage/Time/Note/Phần/Frame của bản gốc, chỉ lấy
    Voice/Text/Visual/Music từ AI candidate."""
    candidate = candidate or {}
    merged = {
        "Phần": str(original.get("Phần", "")),
        "Frame": original.get("Frame", ""),
        "Voice": _clean_text(candidate.get("Voice", original.get("Voice", ""))),
        "Text": _clean_text(candidate.get("Text", original.get("Text", ""))),
        "Visual": _clean_text(candidate.get("Visual", original.get("Visual", ""))),
        "Music": str(candidate.get("Music", original.get("Music", ""))),
        "Footage": str(original.get("Footage", "")),
        "Source": "",
        "Time": str(original.get("Time", "")),
        "Note": str(original.get("Note", "")),
    }
    if asc:
        # allow_structure_change=true → AI có thể đổi Footage/Time/Note (ai_video)
        for k in ("Footage", "Time", "Note", "Phần"):
            if k in candidate:
                merged[k] = str(candidate.get(k) or "")
    return merged


def refine_one_frame(
    frame: dict,
    kb_context: dict | None = None,
    brief: str = "",
    reviewer_focus: str = "style",
    recent_chat: list | None = None,
    mode: str = "real_footage",
    allow_structure_change: bool = False,
) -> dict:
    """Pipeline gọn: Reviser(brief) → 1 reviewer được chỉ định → Reviser(fixes)
    → CODE ép hợp đồng. ~5-6s cho 1 frame (3 LLM call).

    Trả về: {"frame": <frame mới đã enforce>}.

    Args:
      frame: frame gốc cần sửa (object có Phần/Frame/Voice/Text/Visual/Music/...).
      kb_context: ngữ cảnh cả KB ({kb_name, od_number, frames}). Reviser dùng để
                  giữ mạch truyện. Có thể None — khi đó chỉ thấy frame đơn.
      brief: yêu cầu tối ưu (user nhập trong RefineModal).
      reviewer_focus: 'style' | 'brand' | 'content' | 'structure'. Default 'style'.
      recent_chat: list[{sender, body}] — 5-6 turn chat gần nhất để Reviser nắm ý.
      mode: 'real_footage' | 'ai_video'. Ảnh hưởng allow_structure_change.
      allow_structure_change: false → giữ Footage/Time/Note/Phần/Frame của gốc.
    """
    if not isinstance(frame, dict):
        raise ValueError("frame phải là dict.")

    target_num = frame.get("Frame")
    full_kb = {
        "kb_name": (kb_context or {}).get("kb_name", ""),
        "od_number": (kb_context or {}).get("od_number", ""),
        "frames": (kb_context or {}).get("frames") or [frame],
    }
    chat_summary = ""
    if recent_chat:
        lines = []
        for m in (recent_chat or [])[:6]:
            sender = str(m.get("sender", "?") if isinstance(m, dict) else "?")[:16]
            body = str(m.get("body", "") if isinstance(m, dict) else "")[:200]
            if body:
                lines.append(f"- {sender}: {body}")
        chat_summary = "\n".join(lines)

    # 1) EXPLORE — Reviser tạo bản đầu
    draft_parsed = _run(
        script_reviser,
        _refine_explore_prompt(frame, full_kb, brief, chat_summary, mode, allow_structure_change),
    )
    candidate = _pick_frame(draft_parsed, target_num) or frame

    # 2) EXAMINE — chọn 1 reviewer theo focus
    reviewer = REVIEWER_BY_FOCUS.get(reviewer_focus, style_reviewer)
    review = _run(reviewer, _reviewer_prompt({
        "kb_name": full_kb["kb_name"],
        "od_number": full_kb["od_number"],
        "frames": [candidate],
    })) or {}
    fixes = [str(x).strip() for x in (review.get("fixes") or []) if str(x).strip()]

    # 3) ENHANCE — Reviser sửa theo fixes (1 vòng, tối đa 10 góp ý)
    if fixes:
        feedback = "\n".join(f"- {x}" for x in fixes[:10])
        enhanced = _run(script_reviser, _enhance_prompt(
            {
                "kb_name": full_kb["kb_name"],
                "od_number": full_kb["od_number"],
                "frames": [candidate],
            },
            feedback,
            allow_structure_change,
        ))
        candidate = _pick_frame(enhanced, target_num) or candidate

    # 4) ENFORCE — CODE ép hợp đồng (giữ Footage/Time/Note nếu real_footage)
    new_frame = _enforce_single_frame(frame, candidate, allow_structure_change)
    return {"frame": new_frame}


if __name__ == "__main__":
    # Test: python -m teams.script_studio.orchestrator
    sample = {
        "kb_name": "KB3", "od_number": "OD 365",
        "frames": [
            {"Phần": "Mở", "Frame": 1, "Voice": "Cuộc hành trình để trở thành một phiên bản đẹp hơn không bao giờ đơn giản.",
             "Text": "", "Footage": "Sau phẫu", "Source": "", "Time": "Lấy từ 0:01", "Note": "Chỉnh màu"},
            {"Phần": "Thân", "Frame": 2, "Voice": "Nó chính là sự đánh đổi giữa thời gian, công sức, tiền bạc và cả những lo lắng khó chia sẻ.",
             "Text": "", "Footage": "Thay băng", "Source": "", "Time": "Lấy từ 1:02", "Note": "Chỉnh màu"},
            {"Phần": "Kết", "Frame": 3, "Voice": "Khách hàng lựa chọn Dr Đình Khanh không chỉ vì kỹ năng mà còn bởi sự cam kết.",
             "Text": "", "Footage": "BS động viên", "Source": "", "Time": "Lấy từ 0:02", "Note": "Chỉnh màu"},
        ],
    }
    import time
    t = time.time()
    result = optimize_script(sample, optimization_brief="Hook 3s đầu mạnh hơn, giọng gần gũi.")
    print(f"[{time.time()-t:.1f}s]")
    print(json.dumps(result, ensure_ascii=False, indent=2))
