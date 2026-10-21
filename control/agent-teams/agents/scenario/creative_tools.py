"""Creative Tools for Scenario Refinement."""

import contextvars
import json
import re
from typing import List, Optional

from utils import review_cache
from utils.cancel import is_cancelled  # T32 — né reviewer-call khi user đã huỷ

# ContextVars để truyền bối cảnh kịch bản và hàng đợi sự kiện SSE xuyên suốt Agno Thread
current_scenario_context_var = contextvars.ContextVar("current_scenario_context_var", default=None)
sse_queue_var = contextvars.ContextVar("sse_queue_var", default=None)
# v4.1 FIX — loop của FastAPI được capture ở async route. Tool chạy trong worker thread
# (asyncio.to_thread) KHÔNG có running loop, nên phải dùng loop này để call_soon_threadsafe.
sse_loop_var = contextvars.ContextVar("sse_loop_var", default=None)
# v5 — Honesty: ask_clarification/propose_options set biến này → route ưu tiên dùng cho 'final'.
reply_text_var = contextvars.ContextVar("reply_text_var", default=None)
# v5.1 — đánh dấu ĐÃ có hành động thật (phát creative_directing) trong lượt. Route dùng để
# bắt safety-net: nếu agent tự nhận "đã đổi/đã sửa" mà cờ này False → thay bằng câu trung thực.
action_taken_var = contextvars.ContextVar("action_taken_var", default=False)
# T34 (Đợt 8 bổ sung) — diagnose_scenario set 1 TÓM TẮT NGẮN; route ưu tiên dùng nó khi agent
# (gpt-4o-mini) vẫn dump lại toàn bộ findings dài dù ĐÃ có BẢNG chẩn đoán riêng (mechanism >
# prompt). Chỉ áp trên lượt THUẦN chẩn đoán (không kèm mutation).
diagnosis_summary_var = contextvars.ContextVar("diagnosis_summary_var", default=None)
# T32 (Đợt 8) — request_id của lượt (route set) để né reviewer-call khi user huỷ giữa chừng.
request_id_var = contextvars.ContextVar("request_id_var", default=None)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_scenario_context() -> dict:
    return current_scenario_context_var.get() or {}

def _push_sse_event(event_type: str, data: any):
    """Đẩy 1 SSE event vào queue theo cách THREAD-SAFE.

    v4.1 FIX: tool chạy trong worker thread của asyncio.to_thread → thread này KHÔNG
    có running loop, nên KHÔNG được dùng asyncio.get_running_loop() (sẽ raise RuntimeError
    và nuốt mất event). Dùng loop đã capture ở async route (sse_loop_var) +
    loop.call_soon_threadsafe() để đẩy an toàn từ worker thread về event loop FastAPI.
    """
    if event_type == "creative_directing":
        action_taken_var.set(True)   # có đề xuất thay đổi thật trong lượt này
    q = sse_queue_var.get()
    loop = sse_loop_var.get()
    if q is None or loop is None:
        return
    try:
        loop.call_soon_threadsafe(q.put_nowait, {"event": event_type, "data": data})
    except RuntimeError:
        pass

def _run_reviewer(reviewer_agent, prompt: str) -> dict:
    """Gọi reviewer agent và parse JSON kết quả.

    v4.1 — Content-addressed cache: review chỉ phụ thuộc (reviewer, nội dung shot
    nằm trong prompt) nên cache theo hash để shot không đổi không tốn LLM call lại.
    """
    # T32 — user đã huỷ lượt → né LLM call của reviewer (cost). Trả rỗng (kết quả bị bỏ qua
    # vì consumer-loop đã đóng stream). Là điểm DUY NHẤT có sub-LLM-call trong chat-stream.
    if is_cancelled(request_id_var.get()):
        return {}
    reviewer_id = getattr(reviewer_agent, "id", None) or getattr(reviewer_agent, "name", "") or "reviewer"
    cached = review_cache.get(reviewer_id, prompt)
    if cached is not None:
        return {**cached, "_cached": True}

    parsed: dict = {}
    try:
        resp = reviewer_agent.run(prompt)
        content = getattr(resp, "content", "") or ""
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            parsed = json.loads(m.group(1))
        else:
            start = content.find("{")
            if start != -1:
                depth = 0
                for i in range(start, len(content)):
                    if content[i] == "{":
                        depth += 1
                    elif content[i] == "}":
                        depth -= 1
                        if depth == 0:
                            parsed = json.loads(content[start:i + 1])
                            break
    except Exception:
        parsed = {}

    if parsed:
        review_cache.set(reviewer_id, prompt, parsed)
    return parsed

def _find_and_patch_shot(shot_id: int, patch_data: dict) -> dict:
    context = _get_scenario_context()
    shots = context.get("shots") or []
    for s in shots:
        if s.get("shot_id") == shot_id:
            patched = dict(s)
            patched.update(patch_data)
            return patched
    return patch_data

def _push_artistic_check(reviewer: str, shot_id, review: dict):
    """v5 — Phát artistic_check theo contract CHUẨN: FE đọc trực tiếp `score`+`warnings`,
    vẫn kèm `scores` (raw) + `issues` để backward-compat."""
    scores = review.get("scores", {}) or {}
    nums = [v for v in scores.values() if isinstance(v, (int, float))]
    avg = round(sum(nums) / len(nums), 1) if nums else 0.0
    issues = review.get("issues", []) or []
    _push_sse_event("artistic_check", {
        "reviewer": reviewer,
        "shot_id": shot_id,
        "score": avg,          # điểm trung bình — FE dùng trực tiếp
        "scores": scores,      # raw per-dimension
        "warnings": issues,    # FE dùng trực tiếp
        "issues": issues,      # backward-compat
        "fixes": review.get("fixes", []) or [],
        "cached": bool(review.get("_cached")),
    })

# ---------------------------------------------------------------------------
# Creative Tools
# ---------------------------------------------------------------------------

def direct_character_acting(
    shot_id: int,
    character_name: str,
    facial_expression: str,
    body_language: str,
    kinetic_action: str
) -> dict:
    """Điều phối diễn xuất của nhân vật trong phân cảnh (biểu cảm gương mặt, tư thế và hành động vi mô).

    Args:
        shot_id: ID của phân cảnh cần chỉnh sửa (ví dụ: 1, 2, 3...)
        character_name: Tên của nhân vật trong phân cảnh (phải trùng khớp với global_character_registry hoặc = 'None')
        facial_expression: Mô tả chi tiết biểu cảm gương mặt (ví dụ: 'mỉm cười nhẹ', 'nhăn trán lo lắng')
        body_language: Mô tả tư thế cơ thể và cử chỉ (ví dụ: 'khoanh tay đứng thẳng', 'nghiêng người nhẹ')
        kinetic_action: Hành động vi mô cụ thể trong phân cảnh (chỉ duy nhất một hành động đơn giản)
    """
    patch = {
        "character_in_frame": character_name,
        "character_pose": f"{facial_expression}, {body_language}".strip(", "),
        "kinetic_action": kinetic_action
    }
    
    _push_sse_event("creative_directing", {
        "tool": "direct_character_acting",
        "shot_id": shot_id,
        "patch": patch
    })

    # Review-on-the-fly
    from agents.scenario import scenario_kinetic_reviewer
    patched_shot = _find_and_patch_shot(shot_id, patch)
    prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong bối cảnh kịch bản).\n"
        f"shot:\n{json.dumps(patched_shot, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_reviewer(scenario_kinetic_reviewer, prompt)
    
    _push_artistic_check("Kinetic Reviewer", shot_id, review)

    return {
        "status": "success",
        "shot_id": shot_id,
        "patch": patch,
        "review": review
    }

def adjust_scenic_atmosphere(
    shot_id: int,
    background_setting: str,
    lighting_style: str,
    prop_details: str
) -> dict:
    """Điều chỉnh không khí nghệ thuật, bối cảnh, ánh sáng và chi tiết đạo cụ trong phân cảnh.

    Args:
        shot_id: ID của phân cảnh cần chỉnh sửa
        background_setting: Mô tả chi tiết không gian/bối cảnh (ví dụ: 'Phòng khách chung cư ngập nắng')
        lighting_style: Mô tả ánh sáng và tông màu (ví dụ: 'Ánh sáng tự nhiên cửa sổ, warm tone')
        prop_details: Chi tiết các đạo cụ xuất hiện (ví dụ: 'Hộp sữa chua đặt trên đĩa sứ trắng, cạnh thìa')
    """
    patch = {
        "background": background_setting,
        "texture_and_lighting": lighting_style,
        "prop_description": prop_details
    }
    
    _push_sse_event("creative_directing", {
        "tool": "adjust_scenic_atmosphere",
        "shot_id": shot_id,
        "patch": patch
    })

    # Review-on-the-fly
    from agents.scenario import scenario_cinematic_reviewer
    patched_shot = _find_and_patch_shot(shot_id, patch)
    prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong bối cảnh kịch bản).\n"
        f"shot:\n{json.dumps(patched_shot, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_reviewer(scenario_cinematic_reviewer, prompt)
    
    _push_artistic_check("Cinematic Reviewer", shot_id, review)

    return {
        "status": "success",
        "shot_id": shot_id,
        "patch": patch,
        "review": review
    }

def align_audio_visual_sync(
    shot_id: int,
    voice_over_text: str,
    estimated_seconds: int,
    music_hint: str
) -> dict:
    """Đồng bộ hóa lời thoại (voice over), thời lượng phân cảnh và âm thanh/nhạc nền để đảm bảo nhịp điệu phim.

    Args:
        shot_id: ID của phân cảnh cần chỉnh sửa
        voice_over_text: Lời thoại đọc trong phân cảnh (không chứa dấu '-', độ dài vừa phải ~25 từ)
        estimated_seconds: Thời lượng dự kiến cho phân cảnh (giây, thường từ 3 đến 8 giây)
        music_hint: Gợi ý hiệu ứng âm thanh/nhạc nền
    """
    patch = {
        "voice_over": voice_over_text,
        "music_hint": music_hint
    }
    
    _push_sse_event("creative_directing", {
        "tool": "align_audio_visual_sync",
        "shot_id": shot_id,
        "patch": patch
    })

    # Review-on-the-fly
    from agents.scenario import scenario_style_reviewer
    patched_shot = _find_and_patch_shot(shot_id, patch)
    prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong bối cảnh kịch bản).\n"
        f"shot:\n{json.dumps(patched_shot, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_reviewer(scenario_style_reviewer, prompt)
    
    _push_artistic_check("Style Reviewer", shot_id, review)

    return {
        "status": "success",
        "shot_id": shot_id,
        "patch": patch,
        "review": review
    }

def apply_creative_transition(
    from_shot_id: int,
    to_shot_id: int,
    transition_type: str,
    creative_description: str
) -> dict:
    """Thiết lập cách chuyển cảnh nghệ thuật (Transition) giữa hai phân cảnh liền kề để tạo sự liền mạch.

    Args:
        from_shot_id: ID của phân cảnh trước
        to_shot_id: ID của phân cảnh sau
        transition_type: Loại chuyển cảnh (hợp lệ: NEW_SCENE | FRAME_ANCHOR | B_ROLL_CUT)
        creative_description: Giải thích ý đồ chuyển cảnh nghệ thuật (ví dụ: 'Cắt match-cut động tác tay')
    """
    patch = {
        "continuity_mode": transition_type,
        "anchor_source_shot": from_shot_id if transition_type == "FRAME_ANCHOR" else None,
        "prompt_injection": f"Continuing from shot {from_shot_id}, " if transition_type == "FRAME_ANCHOR" else ""
    }
    
    _push_sse_event("creative_directing", {
        "tool": "apply_creative_transition",
        "from_shot_id": from_shot_id,
        "to_shot_id": to_shot_id,
        "patch": patch
    })

    # Review-on-the-fly
    from agents.scenario import scenario_continuity_reviewer
    patched_shot = _find_and_patch_shot(to_shot_id, patch)
    prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong bối cảnh kịch bản).\n"
        f"shot:\n{json.dumps(patched_shot, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_reviewer(scenario_continuity_reviewer, prompt)
    
    _push_artistic_check("Continuity Reviewer", to_shot_id, review)

    return {
        "status": "success",
        "patch": patch,
        "review": review
    }

def refine_shot_camera(
    shot_id: int,
    camera_angle: str,
    camera_movement: str,
    visual_depth_hint: str
) -> dict:
    """Chỉ định chi tiết cú máy, góc máy và chiều sâu hình ảnh để phục vụ việc render video nghệ thuật.

    Args:
        shot_id: ID của phân cảnh cần chỉnh sửa
        camera_angle: Góc đặt máy quay (ví dụ: 'Close-up', 'Medium shot', 'Wide shot')
        camera_movement: Chuyển động của camera (ví dụ: 'STATIC', 'Slow zoom-in', 'Pan left')
        visual_depth_hint: Mô tả tiêu cự/chiều sâu (ví dụ: 'Làm mờ hậu cảnh', 'Focus rõ sản phẩm')
    """
    patch = {
        "camera_articulation": f"{camera_angle}, {camera_movement}. {visual_depth_hint}".strip(". ")
    }
    
    _push_sse_event("creative_directing", {
        "tool": "refine_shot_camera",
        "shot_id": shot_id,
        "patch": patch
    })

    # Review-on-the-fly
    from agents.scenario import scenario_cinematic_reviewer
    patched_shot = _find_and_patch_shot(shot_id, patch)
    prompt = (
        "Chấm điểm + góp ý fixes cho 1 shot sau (trong bối cảnh kịch bản).\n"
        f"shot:\n{json.dumps(patched_shot, ensure_ascii=False, indent=2)}\n\n"
        "Trả JSON {scores, issues, fixes}."
    )
    review = _run_reviewer(scenario_cinematic_reviewer, prompt)
    
    _push_artistic_check("Cinematic Reviewer", shot_id, review)

    return {
        "status": "success",
        "shot_id": shot_id,
        "patch": patch,
        "review": review
    }

def propose_creative_treatment(
    creative_goal: str,
    artistic_analysis: str,
    creative_steps: List[dict]
) -> dict:
    """Đề xuất một giải pháp đạo diễn/kịch bản TỔNG THỂ tác động lên NHIỀU phân cảnh (treatment).

    DÙNG cho mọi yêu cầu ĐA-BƯỚC / diện rộng: "thêm đất diễn cho nhân vật X", "đưa X vào câu
    chuyện", "cập nhật nhiều cảnh", "làm hook kịch tính hơn toàn bộ", "tăng chiều sâu xuyên suốt".
    KHÔNG xé lẻ thành nhiều tool riêng — gói TẤT CẢ bước vào MỘT treatment để chạy nhất quán.

    Args:
        creative_goal: Mục tiêu chung (ví dụ: 'Tạo đất diễn cho nhân vật Chuyên gia').
        artistic_analysis: Phân tích nghệ thuật vì sao cần thay đổi.
        creative_steps: DANH SÁCH ĐẦY ĐỦ các bước. Mỗi bước:
            {
              'step_number': int,
              'action': 'edit' | 'insert',   # 'edit'=sửa cảnh có sẵn; 'insert'=CHÈN cảnh MỚI
              'step_goal': str,
              'affected_shot_ids': list[int], # BẮT BUỘC khi action='edit' (các cảnh bị sửa)
              'after_shot_id': int,           # BẮT BUỘC khi action='insert' (chèn SAU cảnh này; 0=đầu)
              'creative_description': str      # mô tả nội dung/ý đồ để hệ thống dựng
            }
        LƯU Ý: nếu yêu cầu vừa THÊM cảnh mới vừa SỬA cảnh có sẵn → liệt kê ĐỦ cả 2 loại bước.
    """
    _push_sse_event("creative_directing", {
        "tool": "propose_creative_treatment",
        "creative_goal": creative_goal,
        "artistic_analysis": artistic_analysis,
        "creative_steps": creative_steps
    })

    return {
        "status": "success",
        "creative_goal": creative_goal,
        "artistic_analysis": artistic_analysis,
        "creative_steps": creative_steps
    }

# ---------------------------------------------------------------------------
# v5 — Nhóm Quan sát (Perception) — "ĐÔI MẮT": đọc & chẩn đoán, KHÔNG sửa (T25, Đợt 8)
# ---------------------------------------------------------------------------

# Diễn giải tiếng Việt cho từng focus (đưa vào event để FE hiển thị).
_DIAGNOSE_FOCUS_LABEL = {
    "continuity": "Liên mạch & chuyển cảnh",
    "cinematic": "Hình ảnh & cú máy",
    "kinetic": "Diễn xuất & hành động",
    "style": "Lời thoại & văn phong",
    "brand": "Claim quảng cáo & thương hiệu",
}

# Trường shot đưa vào prompt chẩn đoán (lean — bỏ field DB không liên quan sáng tạo).
_DIAGNOSE_SHOT_FIELDS = (
    "shot_id", "shot_order", "funnel_part", "character_in_frame", "continuity_mode",
    "anchor_source_id", "voice_over", "kinetic_action", "character_pose",
    "camera_articulation", "background", "texture_and_lighting", "prop_description",
)

# T29 (Đợt 8 bổ sung) — findings GHÉP CẶP (problem + suggestion 1 mục) + NHÃN transition rõ.
# Trị clarity cho non-IT: lỗi CHUYỂN CẢNH = "shot N→M" (vd 'shot 1→2'); lỗi TRONG shot = "shot N".
# Bỏ ambiguity "[shot N]" lẻ + bỏ việc cảnh báo/fix nằm 2 list rời (phải cross-reference).
_TRANSITION_TARGET_RE = re.compile(r"\d+\s*(?:→|->|–|—|-|\bto\b|\bsang\b)\s*\d+", re.IGNORECASE)


def _classify_target(target: str) -> str:
    """'transition' nếu nhãn nhắc 2 shot (N→M); ngược lại 'shot'."""
    return "transition" if _TRANSITION_TARGET_RE.search(str(target or "")) else "shot"


def _clean_target(target) -> str:
    """Chuẩn hoá nhãn: bỏ ngoặc/space thừa; số trần ('1→2'/'6') → thêm tiền tố 'shot '."""
    t = str(target or "").strip().strip("[]()").strip()
    if not t:
        return "kịch bản"
    if re.fullmatch(r"\d+(?:\s*(?:→|->|–|—|-)\s*\d+)?", t):
        t = "shot " + t
    return t


def _normalize_findings(review: dict) -> List[dict]:
    """Trả findings ghép cặp [{target, target_kind, problem, suggestion}] từ output reviewer.
    Ưu tiên field `findings` (mới); nếu reviewer còn trả `issues`/`fixes` cũ → TỰ GHÉP theo nhãn
    target trong tiền tố '[...]' (robust với gpt-4o-mini lúc không theo format mới)."""
    out: List[dict] = []
    raw = review.get("findings")
    if isinstance(raw, list):
        for f in raw:
            if not isinstance(f, dict):
                continue
            problem = str(f.get("problem") or "").strip()
            suggestion = str(f.get("suggestion") or "").strip()
            if not (problem or suggestion):
                continue
            target = _clean_target(f.get("target"))
            out.append({"target": target, "target_kind": _classify_target(target),
                        "problem": problem, "suggestion": suggestion})
    if out:
        return out

    # Fallback: ghép issues/fixes cũ theo nhãn target ('[shot N]' / '[shot N→M]').
    def _split_tag(s):
        s = str(s or "").strip()
        m = re.match(r"^\s*[\[\(]([^\]\)]+)[\]\)]\s*(.*)$", s)
        if m:
            return _clean_target(m.group(1)), m.group(2).strip()
        return "kịch bản", s

    by_target: dict = {}
    order: List[str] = []
    for it in (review.get("issues") or []):
        tg, txt = _split_tag(it)
        if not txt:
            continue
        if tg not in by_target:
            by_target[tg] = {"target": tg, "target_kind": _classify_target(tg),
                             "problem": "", "suggestion": ""}
            order.append(tg)
        by_target[tg]["problem"] = (by_target[tg]["problem"] + " " + txt).strip()
    for fx in (review.get("fixes") or []):
        tg, txt = _split_tag(fx)
        if not txt:
            continue
        if tg not in by_target:
            by_target[tg] = {"target": tg, "target_kind": _classify_target(tg),
                             "problem": "", "suggestion": ""}
            order.append(tg)
        by_target[tg]["suggestion"] = (by_target[tg]["suggestion"] + " " + txt).strip()
    return [by_target[t] for t in order]


def diagnose_scenario(focus: str = "continuity", shot_ids: Optional[List[int]] = None) -> dict:
    """ĐỌC & CHẨN ĐOÁN kịch bản hiện tại (CHỈ đọc — KHÔNG sửa gì) để THẨM ĐỊNH chất lượng.

    Đây là "ĐÔI MẮT" của bạn. BẮT BUỘC gọi tool này TRƯỚC KHI kết luận bất cứ điều gì về
    chất lượng/độ mượt/liên mạch/diễn xuất — TUYỆT ĐỐI KHÔNG phán chung chung kiểu giáo khoa
    ("nên dùng fade", "đảm bảo nhân vật liên kết") khi CHƯA soi dữ liệu thật.

    DÙNG khi user yêu cầu THẨM ĐỊNH/ĐÁNH GIÁ/KIỂM TRA: "kiểm tra xem có đúng không", "đánh giá
    lại continuity", "soi giúp mình kịch bản", "đã mượt chưa", "Reviewer nói X — có phải không".

    Tool chạy đúng chuyên gia duyệt (theo `focus`) trên (các) shot và trả `findings` GHÉP CẶP
    (mỗi mục = {target, problem, suggestion}; `target`='shot N→M' cho lỗi CHUYỂN CẢNH giữa 2 shot,
    'shot N' cho lỗi TRONG 1 shot). SAU KHI có kết quả, hãy TRẢ LỜI user bằng kết luận CÓ DẪN CHỨNG
    (nêu rõ CHUYỂN CẢNH/shot nào chưa ổn và vì sao); nếu cần thì đề xuất sửa GẮN shot cụ thể. Được
    phép nói thẳng khi bạn thấy Reviewer cảnh báo quá tay (có chính kiến).

    Args:
        focus: khía cạnh cần soi — 'continuity' (chuyển cảnh/liên mạch/nhân vật — MẶC ĐỊNH),
            'cinematic' (góc máy/ánh sáng/bối cảnh), 'kinetic' (diễn xuất/hành động),
            'style' (thoại/độ dài/tone), 'brand' (claim quảng cáo/thương hiệu).
        shot_ids: danh sách shot_id cần soi. Để RỖNG = soi TOÀN BỘ kịch bản.
    """
    # Lazy import (tránh circular: agents.scenario import creative_tools qua refiner).
    from agents.scenario import REVIEWER_BY_FOCUS, scenario_continuity_reviewer

    focus = (focus or "continuity").strip().lower()
    reviewer = REVIEWER_BY_FOCUS.get(focus)
    if reviewer is None:
        focus, reviewer = "continuity", scenario_continuity_reviewer

    context = _get_scenario_context()
    all_shots = context.get("shots") or []
    target_ids = set(shot_ids or [])
    lean = []
    for s in all_shots:
        if not isinstance(s, dict):
            continue
        if target_ids and s.get("shot_id") not in target_ids:
            continue
        lean.append({k: s.get(k) for k in _DIAGNOSE_SHOT_FIELDS if s.get(k) not in (None, "")})

    examined = [s.get("shot_id") for s in lean]
    if not lean:
        return {
            "status": "empty",
            "focus": focus,
            "message": "Không có phân cảnh nào khớp để soi (kịch bản trống hoặc shot_ids không tồn tại).",
        }

    reviewer_name = getattr(reviewer, "name", "Reviewer")
    prompt = (
        "Soi & chấm dưới góc nhìn chuyên môn của bạn cho CÁC shot dưới đây — đánh giá CẢ sự "
        "liên mạch GIỮA các shot (không chỉ từng shot rời rạc). Với MỖI vấn đề, GHÉP LUÔN cách "
        "sửa tương ứng vào CÙNG 1 mục (problem + suggestion), và GẮN NHÃN rõ phân cảnh liên quan:\n"
        "- Lỗi CHUYỂN CẢNH giữa 2 shot → target = 'shot N→M' (vd 'shot 1→2').\n"
        "- Lỗi nằm TRONG 1 shot → target = 'shot N' (vd 'shot 6').\n"
        f"shots:\n{json.dumps(lean, ensure_ascii=False, indent=2)}\n\n"
        'Trả CHỈ JSON: {"scores": {...}, "findings": [{"target": "shot N→M | shot N", '
        '"problem": "vấn đề ngắn gọn", "suggestion": "cách sửa cụ thể"}]}.'
    )
    review = _run_reviewer(reviewer, prompt)

    scores = review.get("scores", {}) or {}
    nums = [v for v in scores.values() if isinstance(v, (int, float))]
    avg = round(sum(nums) / len(nums), 1) if nums else 0.0
    findings = _normalize_findings(review)
    # Legacy issues/fixes DERIVE từ findings (back-compat: FE chưa lên T30 + telemetry cũ).
    issues = [f"[{f['target']}] {f['problem']}" for f in findings if f["problem"]]
    fixes = [f"[{f['target']}] {f['suggestion']}" for f in findings if f["suggestion"]]

    # T34 — tóm tắt NGẮN (route dùng khi agent vẫn dump dài; BẢNG đã lo chi tiết).
    _focus_label = _DIAGNOSE_FOCUS_LABEL.get(focus, focus).lower()
    if findings:
        diagnosis_summary_var.set(
            f"Mình đã soi {_focus_label} và thấy {len(findings)} điểm cần lưu ý "
            f"({', '.join(f['target'] for f in findings)}). Chi tiết + cách sửa nằm ở bảng "
            "chẩn đoán bên dưới. Bạn muốn mình xử lý chỗ nào?"
        )
    else:
        diagnosis_summary_var.set(
            f"Mình đã soi {_focus_label} — không thấy vấn đề đáng kể, phần này khá ổn."
        )

    payload = {
        "focus": focus,
        "focus_label": _DIAGNOSE_FOCUS_LABEL.get(focus, focus),
        "reviewer": reviewer_name,
        "shots_examined": examined,
        "score": avg,
        "scores": scores,
        "findings": findings,   # T29 — CANONICAL: ghép cặp {target, target_kind, problem, suggestion}
        "issues": issues,       # legacy derived (back-compat FE chưa lên T30)
        "fixes": fixes,         # legacy derived
        "cached": bool(review.get("_cached")),
    }
    # Phát event 'diagnosis' (Django forward verbatim + persist kind:'diagnosis'). KHÔNG phải
    # 'creative_directing' nên KHÔNG set action_taken (chẩn đoán = đọc, không phải hành động).
    _push_sse_event("diagnosis", payload)

    return {"status": "success", **payload}

# ---------------------------------------------------------------------------
# v5 — Nhóm Diễn viên (Cast)
# ---------------------------------------------------------------------------

def manage_character(
    character_name: str,
    new_name: str = "",
    age: str = "",
    outfit_style: str = "",
    ethnicity: str = "",
    voice_id_hint: str = ""
) -> dict:
    """Sửa, đổi tên, HOẶC THÊM MỚI 1 nhân vật trong dàn diễn viên (character registry).

    Dùng cho MỌI thao tác nhân vật:
    - SỬA/ĐỔI TÊN nhân vật ĐÃ CÓ: 'đổi tên Linh thành Châu Anh', 'cho Linh mặc áo dài',
      'làm nhân vật trẻ hơn'. Khi đổi tên, hệ thống tự đồng bộ tên ở mọi phân cảnh.
    - THÊM nhân vật MỚI: 'thêm 1 nhân vật mới tên Mai', 'tạo nhân vật chuyên gia'. Khi đó
      đặt `character_name` = TÊN nhân vật mới và điền age/outfit_style/ethnicity/voice_id_hint.
      Hệ thống TỰ NHẬN biết nhân vật chưa có trong registry → tạo mới (không cần tool riêng).

    Args:
        character_name: Tên nhân vật. Với SỬA = tên HIỆN TẠI (trùng registry); với THÊM = tên MỚI.
        new_name: CHỈ điền khi ĐỔI TÊN nhân vật đã có (tên đích).
        age: Độ tuổi (ví dụ '25 tuổi').
        outfit_style: Trang phục.
        ethnicity: Sắc tộc/ngoại hình.
        voice_id_hint: Gợi ý giọng.
    """
    changes = {}
    if new_name:
        changes["name"] = new_name
    if age:
        changes["age"] = age
    if outfit_style:
        changes["outfit_style"] = outfit_style
    if ethnicity:
        changes["ethnicity"] = ethnicity
    if voice_id_hint:
        changes["voice_id_hint"] = voice_id_hint

    # v5.1 — phân biệt THÊM MỚI vs SỬA: nếu character_name CHƯA có trong registry → nhân vật mới.
    # (Django sẽ tự re-check authoritative; cờ này giúp FE render đúng thẻ ngay lúc live.)
    registry = _get_scenario_context().get("character_registry") or []
    is_new = not any(
        isinstance(c, dict) and (c.get("name") or "").strip().lower() == character_name.strip().lower()
        for c in registry
    )
    # Nhân vật mới: đảm bảo patch có 'name' để dựng add_character (FE/Django cần field name).
    if is_new and "name" not in changes:
        changes["name"] = character_name

    _push_sse_event("creative_directing", {
        "tool": "manage_character",
        "kind": "character",
        "character_name": character_name,
        "patch": changes,
        "is_new": is_new,
    })
    return {"status": "success", "character_name": character_name, "patch": changes, "is_new": is_new}

# ---------------------------------------------------------------------------
# v5 — Nhóm Đối thoại & Đồng sáng tạo (Communication) — honesty structural
# ---------------------------------------------------------------------------

def respond_with_text(message: str) -> dict:
    """Kênh DUY NHẤT để nói chuyện/tư vấn/giải thích/xác nhận với user (KHÔNG sửa kịch bản).

    BẮT BUỘC dùng tool này cho MỌI lời nói với user. TUYỆT ĐỐI không viết câu trả lời
    dưới dạng văn bản tự do ngoài tool. Khi CHƯA làm được điều user yêu cầu, dùng tool
    này nói THẬT (không được tự nhận 'đã xong').

    Args:
        message: Nội dung gửi user (ngôn ngữ đạo diễn, ngắn gọn ≤200 từ, không kèm JSON).
    """
    reply_text_var.set(message)
    _push_sse_event("reply", {"message": message})
    return {"status": "success", "message": message}


def ask_clarification(question: str, options: Optional[List[str]] = None) -> dict:
    """Hỏi lại user khi yêu cầu MƠ HỒ (thiếu thông tin để hành động chắc chắn).

    Args:
        question: Câu hỏi làm rõ.
        options: 2-3 gợi ý hướng để user chọn nhanh (optional).
    """
    opts = options or []
    reply_text_var.set(question)
    _push_sse_event("clarification", {"question": question, "options": opts})
    return {"status": "success", "question": question, "options": opts}


def propose_options(intro: str, options: List[dict]) -> dict:
    """Đề xuất 2-3 phương án sáng tạo cho user chọn (khi user hỏi mở 'có ý tưởng gì?').

    Args:
        intro: Câu dẫn ngắn.
        options: Danh sách phương án, mỗi cái dạng {'label': str, 'description': str}.
    """
    reply_text_var.set(intro)
    _push_sse_event("options", {"intro": intro, "options": options})
    return {"status": "success", "intro": intro, "options": options}

# ---------------------------------------------------------------------------
# v5 — Nhóm Dựng phim (Structure) — đề xuất thao tác cấu trúc; FE duyệt rồi gọi endpoint
# tương ứng (op khớp url_path Django: insert-shot/delete-shot/reorder-shots/move-shot/
# duplicate-shot). args khớp payload endpoint để FE forward thẳng.
# ---------------------------------------------------------------------------

def _push_structural(tool: str, op: str, args: dict, impact: str):
    _push_sse_event("creative_directing", {
        "tool": tool, "kind": "structural", "op": op, "args": args, "impact": impact,
    })

def add_shot(after_shot_id: int, brief: str) -> dict:
    """Đề xuất CHÈN một phân cảnh mới sau phân cảnh `after_shot_id` (0 = chèn đầu kịch bản).

    Args:
        after_shot_id: id phân cảnh đứng ngay TRƯỚC vị trí chèn (0 = đầu).
        brief: mô tả ngắn nội dung/ý đồ phân cảnh mới để hệ thống dựng.
    """
    args = {"after_shot_id": after_shot_id, "brief": brief}
    _push_structural("add_shot", "insert-shot", args, "safe")
    return {"status": "success", "op": "insert-shot", "args": args}

def remove_shot(shot_id: int) -> dict:
    """Đề xuất XOÁ một phân cảnh (thao tác phá huỷ — cần user duyệt)."""
    args = {"shot_id": shot_id}
    _push_structural("remove_shot", "delete-shot", args, "destructive")
    return {"status": "success", "op": "delete-shot", "args": args}

def reorder_shots(new_order: List[int]) -> dict:
    """Đề xuất ĐẢO THỨ TỰ các phân cảnh.

    Args:
        new_order: danh sách shot_id theo thứ tự mới mong muốn.
    """
    args = {"new_order": new_order}
    _push_structural("reorder_shots", "reorder-shots", args, "destructive")
    return {"status": "success", "op": "reorder-shots", "args": args}

def move_shot(shot_id: int, new_position: int) -> dict:
    """Đề xuất DI CHUYỂN một phân cảnh tới vị trí mới (1-based), không đổi nội dung."""
    args = {"shot_id": shot_id, "new_position": new_position}
    _push_structural("move_shot", "move-shot", args, "safe")
    return {"status": "success", "op": "move-shot", "args": args}

def duplicate_shot(shot_id: int) -> dict:
    """Đề xuất NHÂN ĐÔI một phân cảnh (bản sao chèn ngay sau bản gốc)."""
    args = {"shot_id": shot_id}
    _push_structural("duplicate_shot", "duplicate-shot", args, "safe")
    return {"status": "success", "op": "duplicate-shot", "args": args}

creative_tools = [
    direct_character_acting,
    adjust_scenic_atmosphere,
    align_audio_visual_sync,
    apply_creative_transition,
    refine_shot_camera,
    propose_creative_treatment,
    diagnose_scenario,
    manage_character,
    ask_clarification,
    propose_options,
    add_shot,
    remove_shot,
    reorder_shots,
    move_shot,
    duplicate_shot,
]
