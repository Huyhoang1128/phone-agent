"""
ScriptStudio routes
===================
Endpoint tối ưu kịch bản Gen Content bằng đội AI (code-điều-phối, deterministic).
Yêu cầu JWT như phần còn lại của API. Django proxy gọi endpoint này.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from teams.script_studio import optimize_script, refine_one_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/script-studio", tags=["script-studio"])


class OptimizeRequest(BaseModel):
    existing_script: dict = Field(..., description="Kịch bản frame cần tối ưu (kb_name/od_number/frames).")
    mode: str = Field("real_footage", description="real_footage | ai_video")
    allow_structure_change: bool = Field(
        False, description="False (mặc định): giữ nguyên khung+Footage+Time+Note, chỉ viết lại Voice/Text."
    )
    optimization_brief: str = Field("", description="Yêu cầu tối ưu (vd: hook mạnh hơn, giọng GenZ).")


class OptimizeResponse(BaseModel):
    optimized_script: dict


@router.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    """Chạy luồng Reviser → 4 Reviewer → Enhance → CODE ép hợp đồng. Trả kịch bản tối ưu."""
    try:
        result = optimize_script(
            existing_script=req.existing_script,
            mode=req.mode,
            allow_structure_change=req.allow_structure_change,
            optimization_brief=req.optimization_brief,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("script-studio optimize failed")
        raise HTTPException(status_code=502, detail=f"ScriptStudio lỗi: {str(exc)[:200]}")
    return OptimizeResponse(optimized_script=result)


# ─── Refine 1 frame (chat-refine UX) ─────────────────────────────────────────

class RefineFrameRequest(BaseModel):
    frame: dict = Field(..., description="Frame gốc cần sửa (Phần/Frame/Voice/Text/Visual/Music/Footage/...).")
    kb_context: dict | None = Field(
        None,
        description="Ngữ cảnh cả KB ({kb_name, od_number, frames}) để Reviser giữ mạch truyện."
    )
    brief: str = Field("", description="Brief tối ưu từ user (≤ 1000 char).")
    reviewer_focus: str = Field(
        "style",
        description="'style' | 'brand' | 'content' | 'structure'. Default style.",
    )
    recent_chat: list[dict] = Field(
        default_factory=list,
        description="6 turn chat gần nhất ({sender, body}). Tham khảo ý đồ user.",
    )
    mode: str = Field("real_footage", description="real_footage | ai_video")
    allow_structure_change: bool = Field(
        False,
        description="False (mặc định): giữ Footage/Time/Note của frame gốc, chỉ sửa Voice/Text/Visual/Music."
    )


class RefineFrameResponse(BaseModel):
    frame: dict


@router.post("/refine-frame", response_model=RefineFrameResponse)
def refine_frame(req: RefineFrameRequest) -> RefineFrameResponse:
    """Pipeline gọn cho 1 frame: Reviser → 1 reviewer (chỉ định) → Reviser → CODE
    ép hợp đồng. ~5-6s, 3 LLM call. Dùng cho UX 'Tối ưu frame này' trong
    ContentDetailPage."""
    try:
        result = refine_one_frame(
            frame=req.frame,
            kb_context=req.kb_context,
            brief=req.brief,
            reviewer_focus=req.reviewer_focus,
            recent_chat=req.recent_chat,
            mode=req.mode,
            allow_structure_change=req.allow_structure_change,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("script-studio refine_frame failed")
        raise HTTPException(status_code=502, detail=f"ScriptStudio refine lỗi: {str(exc)[:200]}")
    # result = {"frame": {...}}
    return RefineFrameResponse(frame=result["frame"])
