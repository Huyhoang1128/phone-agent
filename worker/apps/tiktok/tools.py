"""
TikTok custom tools.

Low-level, single-purpose helpers that the agent can call directly.
These tools are deterministic wrappers around common TikTok UI actions.
If the UI has changed or an obstacle is detected (e.g. an ad popup) the
tool returns a descriptive failure message so the LLM executor can
decide how to recover.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import shutil
import time
from pathlib import Path

from mobilerun.agent.utils.actions import download_file
from task_context import get_raw_context

logger = logging.getLogger("mobilerun")

_DOWNLOADS_DIR = Path(__file__).parents[2] / "downloads"

_BT_NODE_RE = re.compile(r'<node\s+([^>]*?)/?>')
_BT_BOUNDS_RE = re.compile(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def _api_base() -> str:
    """Host backend dashboard, đọc từ env ``API_BASE_URL`` (đổi domain chỉ cần sửa .env)."""
    return os.environ.get("API_BASE_URL", "http://localhost:8030").rstrip("/")


def _find_element_by_keywords(elements, *keywords: str):
    """Return the first UI element whose text/content-desc contains any keyword."""
    for el in elements or []:
        label = (
            (el.get("text") or "")
            + " "
            + (el.get("content-desc") or "")
            + " "
            + (el.get("resource-id") or "")
        ).lower()
        if any(kw.lower() in label for kw in keywords):
            return el
    return None


def _find_element_exact(elements, *values: str):
    """Return the first UI element whose text or description exactly matches any value.

    Mirrors the n8n JavaScript pattern ``el.text === "..."`` so state detection
    uses the same strict equality that the reference workflow relies on.
    """
    for el in elements or []:
        text = el.get("text") or ""
        desc = el.get("content-desc") or el.get("description") or ""
        if any(text == v or desc == v for v in values):
            return el
    return None


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


async def open_comment_section(*, ctx, **kwargs) -> str:
    """Open the comment section on the current TikTok video.

    Taps the comment icon (speech-bubble) visible on the right side of the
    screen.  Returns a clear failure reason if the element cannot be found
    so the executor can fall back to a coordinate click or re-try.
    """
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        comment_el = _find_element_by_keywords(
            elements, "comment", "bình luận", "評論", "评论"
        )
        if comment_el is None:
            return (
                "Failed: Comment button not found in UI. "
                "Current elements hint: "
                + ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in (elements or [])[:8]
                )
            )

        idx = comment_el.get("index")
        if idx is None:
            return "Failed: Comment element has no index attribute"

        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        return "Comment section opened successfully"
    except Exception as e:
        return f"Failed: Unexpected error opening comment section — {e}"


async def dismiss_popup(*, ctx, **kwargs) -> str:
    """Dismiss a popup, advertisement, or overlay on the TikTok screen.

    Tries common dismiss patterns in order:
    1. Close / X button
    2. Skip / Not now button
    3. Back button (system)

    Returns a clear success/failure message so the executor knows
    whether to continue with the original task.
    """
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        # Priority order: explicit close controls first
        dismiss_el = _find_element_by_keywords(
            elements,
            "close",
            "dismiss",
            "skip",
            "not now",
            "đóng",
            "bỏ qua",
            "x",
            "cancel",
            "no thanks",
            "đã hiểu",
            "không cho phép"
        )

        if dismiss_el is not None:
            idx = dismiss_el.get("index")
            if idx is not None:
                x, y = ui_state.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                return f"Popup dismissed via element: {dismiss_el.get('text') or dismiss_el.get('content-desc', 'unknown')}"

        # Fallback: press back
        await ctx.driver.press_button("back")
        return "Popup dismissed via back button"

    except Exception as e:
        return f"Failed: Could not dismiss popup — {e}"


async def type_comment(text: str, *, ctx, **kwargs) -> str:
    """Type a comment text into the TikTok comment input field.

    Finds the comment input, focuses it, and types the given text.
    Does NOT submit (tap the post button) — call ``post_comment`` afterwards.
    """
    if not text or not text.strip():
        return "Failed: Comment text cannot be empty"

    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        input_el = _find_element_by_keywords(
            elements,
            "add comment",
            "write a comment",
            "comment…",
            "nhập bình luận",
            "thêm bình luận",
            "EditText",
            "comment_text",
        )

        if input_el is None:
            return (
                "Failed: Comment input field not found. "
                "The comment section may not be open yet."
            )

        idx = input_el.get("index")
        if idx is None:
            return "Failed: Comment input element has no index"

        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await ctx.driver.input_text(text)
        return f"Typed comment: {text[:80]}"

    except Exception as e:
        return f"Failed: Error typing comment — {e}"


async def post_comment(*, ctx, **kwargs) -> str:
    """Tap the Post / Send button to submit the typed comment."""
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        post_el = None
        
        # Ưu tiên tìm theo resource ID chuẩn xác của nút Post trên TikTok (cn4)
        for el in elements:
            rid = el.get("resourceId") or ""
            if "id/cn4" in rid or "id/chc" in rid or "id/cno" in rid:
                post_el = el
                break
        
        if post_el is None:
            marker_el = None
            for el in elements:
                rid = (el.get("resourceId") or "").lower()
                cls = (el.get("className") or "").lower()
                text = (el.get("text") or "").strip().lower()
                if "id/ku3" in rid or ("imageview" in cls and text == "nhắc đến người khác"):
                    marker_el = el
                    break

            def _parse_bounds(el):
                m = re.findall(r"\d+", el.get("bounds", "") or "")
                return tuple(map(int, m)) if len(m) == 4 else None

            if marker_el is not None:
                mb = _parse_bounds(marker_el)
                if mb:
                    mx1, my1, mx2, my2 = mb
                    marker_bottom = my2
                    marker_cx = (mx1 + mx2) // 2
                else:
                    midx = marker_el.get("index")
                    marker_cx, marker_cy = ui_state.get_element_coords(midx) if midx is not None else (0, 0)
                    marker_bottom = marker_cy or 0

                # collect button candidates that are below the marker
                candidates = []
                for el in elements:
                    cls = (el.get("className") or "").lower()
                    if "button" not in cls:
                        continue
                    b = _parse_bounds(el)
                    if b:
                        ex1, ey1, ex2, ey2 = b
                        if ey1 >= marker_bottom:
                            cx = (ex1 + ex2) // 2
                            candidates.append((abs(cx - marker_cx), ey1, el))
                    else:
                        idx = el.get("index")
                        if idx is None:
                            continue
                        cx, cy = ui_state.get_element_coords(idx)
                        if cy >= marker_bottom:
                            candidates.append((abs(cx - marker_cx), cy, el))

                if candidates:
                    candidates.sort(key=lambda t: (t[0], t[1]))  # prefer nearer-x, then nearer-y
                    post_el = candidates[0][2]

        # Nếu không tìm thấy bằng marker và  ID, fallback về cách tìm bằng từ khóa
        if post_el is None:
            post_el = _find_element_by_keywords(
                elements, "post", "send", "đăng", "submit", "gửi"
            )

        if post_el is None:
            return (
                "Failed: Post button (id/cn4) not found. "
                "Make sure a comment has been typed first."
            )

        idx = post_el.get("index")
        if idx is None:
            return "Failed: Post button has no index attribute"

        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        return "Comment posted successfully"

    except Exception as e:
        return f"Failed: Error posting comment — {e}"


async def ensure_screen_on(*, ctx, **kwargs) -> str:
    """Wake up the device screen if it is off and unlock it, then return to home screen.

    Sends the power key (keyevent 26) if the screen is off, performs a swipe
    to dismiss the lock screen, and presses Home so the device is ready for
    further interaction.  If the screen is already on it just presses Home.
    """
    try:
        raw = await ctx.driver.device.shell(
            "dumpsys power | grep -c 'mWakefulness=Awake'"
        )
        is_awake = raw.strip() == "1"

        if not is_awake:
            # Press power button to wake the screen
            await ctx.driver.device.shell("input keyevent 26")
            await asyncio.sleep(1)
            # Go home so any previous app doesn't interfere with unlock
            await ctx.driver.device.shell("input keyevent 3")
            await asyncio.sleep(1)
            # Swipe from bottom to top of the screen to dismiss the lock screen.
            # These coordinates (start_y=1400, end_y=300) work on most 1080p/1440p
            # phones; adjust if your device has a very tall or short display.
            _SWIPE_X = 300
            _SWIPE_START_Y = 1400
            _SWIPE_END_Y = 300
            await ctx.driver.device.shell(
                f"input swipe {_SWIPE_X} {_SWIPE_START_Y} {_SWIPE_X} {_SWIPE_END_Y}"
            )
            await asyncio.sleep(2)
            # Second swipe in case the first one only woke the display
            await ctx.driver.device.shell(
                f"input swipe {_SWIPE_X - 50} {_SWIPE_START_Y} {_SWIPE_X} {_SWIPE_END_Y}"
            )
            await asyncio.sleep(1)
            return "Screen was off — woke up and unlocked the device"
        else:
            # Screen is already on; just go home
            await ctx.driver.device.shell("input keyevent 3")
            await asyncio.sleep(1)
            return "Screen was already on — pressed Home"

    except Exception as e:
        return f"Failed: Could not ensure screen is on — {e}"


async def run_adb_command(command: str, *, ctx, **kwargs) -> str:
    """Run an arbitrary ADB shell command on the connected Android device.

    Internal helper used by other tools to execute device shell commands.
    Executes *command* via ``adb shell`` and returns the combined stdout output.

    Args:
        command: The shell command to execute on the device (without the
                 leading ``adb shell`` prefix).

    Returns:
        The command's stdout as a string, or a descriptive failure message.
    """
    if not command or not command.strip():
        return "Failed: ADB command cannot be empty"

    try:
        result = await ctx.driver.device.shell(command.strip())
        return result if result else "(command completed with no output)"
    except Exception as e:
        return f"Failed: ADB command error — {e}"


async def open_file_manager_at_video(target_file: str = "video.mp4", *, ctx, **kwargs) -> str:
    """Open a file manager and navigate to DCIM/Camera where *target_file* is stored.

    *target_file* defaults to ``video.mp4`` (the video flow); the photo flow
    passes ``image_1.`` so the same navigation logic confirms our downloaded
    images are visible before sharing.

    Tries two approaches in order:
    - Approach A: Open Google Files / Samsung My Files by package name, then
      navigate Bộ nhớ trong → DCIM → Camera.
    - Approach B (fallback): ADB intent to the system storage root, then
      navigate DCIM → Camera (with an optional Bộ nhớ trong step if DCIM is
      not immediately visible).

    Each navigation step scrolls once before giving up.
    """
    _SCROLL_DOWN = "input swipe 540 1400 540 400"

    async def _find_and_tap(keyword: str, step: str) -> str | None:
        """Find element, scroll once if not visible, then tap. Returns None on success."""
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        el = _find_element_by_keywords(els, keyword)
        if el is None:
            await run_adb_command(_SCROLL_DOWN, ctx=ctx)
            await asyncio.sleep(1.5)
            ui = await ctx.state_provider.get_state()
            els = ui.elements if ui else []
            el = _find_element_by_keywords(els, keyword)
            if el is None:
                hint = ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in els[:8]
                )
                return f"Failed: '{keyword}' not found at step [{step}]. Visible: {hint}"
        idx = el.get("index")
        if idx is None:
            return f"Failed: '{keyword}' element has no index at step [{step}]"
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2)
        return None

    async def _confirm_camera_folder() -> str:
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        if _find_element_by_keywords(els, target_file):
            return "File manager opened at DCIM/Camera"
        hint = ", ".join(
            (e.get("text") or e.get("content-desc") or "?")[:30]
            for e in els[:8]
        )
        return f"Failed: '{target_file}' not visible in Camera folder. Visible: {hint}"

    async def _find_and_tap_with_retry(keyword: str, step: str, max_retries: int = 3) -> str | None:
        """Same as _find_and_tap but retries up to max_retries times with scrolling between attempts."""
        for attempt in range(max_retries):
            ui = await ctx.state_provider.get_state()
            els = ui.elements if ui else []
            el = _find_element_by_keywords(els, keyword)
            if el is not None:
                idx = el.get("index")
                if idx is None:
                    return f"Failed: '{keyword}' element has no index at step [{step}]"
                x, y = ui.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                await asyncio.sleep(2)
                logger.info("[open_file_manager] Tapped '%s' on attempt %d", keyword, attempt + 1)
                return None
            # Element not found — scroll and retry
            logger.info("[open_file_manager] '%s' not found on attempt %d, scrolling...", keyword, attempt + 1)
            await run_adb_command(_SCROLL_DOWN, ctx=ctx)
            await asyncio.sleep(1.5)
        # All retries exhausted
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        hint = ", ".join(
            (e.get("text") or e.get("content-desc") or "?")[:30]
            for e in els[:8]
        )
        return f"Failed: '{keyword}' not found at step [{step}] after {max_retries} attempts. Visible: {hint}"

    async def _try_approach_a() -> str:
        """Open Google Files / Samsung My Files → Bộ nhớ trong → DCIM → Camera."""
        result = await run_adb_command(
            "am start -n com.google.android.apps.nbu.files/.home.HomeActivity",
            ctx=ctx,
        )
        if result.startswith("Failed:"):
            result = await run_adb_command(
                "am start -n com.sec.android.app.myfiles/.home.HomeActivity",
                ctx=ctx,
            )
        if result.startswith("Failed:"):
            return "Failed: Google Files and Samsung My Files not available"
        await asyncio.sleep(3)

        for keyword, step in [
            ("Bộ nhớ trong", "Bộ nhớ trong"),
            ("DCIM", "DCIM"),
            ("Camera", "Camera"),
        ]:
            # Use retry-based tap for Camera since it may need multiple scroll attempts
            err = await _find_and_tap_with_retry(keyword, step, max_retries=3)
            if err:
                return err

        return await _confirm_camera_folder()

    async def _try_approach_b() -> str:
        """ADB intent to storage root → optional Bộ nhớ trong → DCIM → Camera."""
        result = await run_adb_command(
            "am start -a android.intent.action.VIEW "
            "-d 'content://com.android.externalstorage.documents/root/primary' "
            "--activity-single-top",
            ctx=ctx,
        )
        if result.startswith("Failed:"):
            return result
        await asyncio.sleep(3)

        # Some devices land directly at DCIM level; others show "Bộ nhớ trong" first.
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        if not _find_element_by_keywords(els, "DCIM"):
            await _find_and_tap_with_retry("Bộ nhớ trong", "Bộ nhớ trong (optional)", max_retries=2)

        for keyword, step in [("DCIM", "DCIM"), ("Camera", "Camera")]:
            err = await _find_and_tap_with_retry(keyword, step, max_retries=3)
            if err:
                return err

        return await _confirm_camera_folder()

    try:
        result_a = await _try_approach_a()
        if not result_a.startswith("Failed:"):
            return result_a
        logger.info("[open_file_manager_at_video] Approach A failed (%s) — trying ADB intent fallback", result_a)
        return await _try_approach_b()
    except Exception as e:
        return f"Failed: Could not open file manager — {e}"


async def _select_tiktok_in_share_sheet(ctx) -> str:
    """From an already-open Android share sheet, find and tap TikTok.

    Tries the visible row first, then a horizontal scroll (app row) and a
    vertical scroll (list-style sheet).  Returns a success message or a
    ``Failed: ...`` reason.  Shared by the video and photo share flows.
    """
    raw_size = await ctx.driver.device.shell("wm size")
    sw, sh = 1080, 2400
    for line in raw_size.splitlines():
        if "size" in line.lower():
            parts = line.split(":")[-1].strip().split("x")
            if len(parts) == 2:
                try:
                    sw, sh = int(parts[0]), int(parts[1])
                except ValueError:
                    pass
            break

    def _find_tiktok_el(elements):
        for e in (elements or []):
            if "tiktok" in ((e.get("text") or "") + " " + (e.get("content-desc") or "")).lower():
                return e
        return None

    ui = await ctx.state_provider.get_state()
    els = ui.elements if ui else []
    tiktok_el = _find_tiktok_el(els)

    if tiktok_el is None:
        logger.info("[share_sheet] TikTok chưa thấy, thử scroll ngang...")
        await ctx.driver.swipe(int(sw * 0.8), int(sh * 0.65), int(sw * 0.2), int(sh * 0.65), 400)
        await asyncio.sleep(1)
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        tiktok_el = _find_tiktok_el(els)

    if tiktok_el is None:
        logger.info("[share_sheet] Vẫn chưa thấy, thử scroll dọc...")
        await ctx.driver.swipe(int(sw * 0.5), int(sh * 0.72), int(sw * 0.5), int(sh * 0.35), 400)
        await asyncio.sleep(1)
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        tiktok_el = _find_tiktok_el(els)

    if tiktok_el is None:
        return (
            "Failed: TikTok not found in the share sheet after scrolling. "
            "Share sheet elements hint: "
            + ", ".join((e.get("text") or e.get("content-desc") or "?")[:30] for e in (els or [])[:12])
        )

    tiktok_idx = tiktok_el.get("index")
    if tiktok_idx is None:
        return "Failed: TikTok element in share sheet has no index attribute"

    x, y = ui.get_element_coords(tiktok_idx)
    await ctx.driver.tap(x, y)
    await asyncio.sleep(4)
    return "Đã chọn TikTok từ share sheet"


async def share_video_file_to_tiktok(*, ctx, **kwargs) -> str:
    """Long-press video.mp4 in the file manager, tap Share, then select TikTok.

    Expects the file manager to already be open and showing the
    DCIM/Camera folder (use ``tiktok_open_file_manager_at_video`` to open the
    file manager and navigate automatically to DCIM/Camera).  The function:

    1. Finds the UI element with text ``video.mp4``.
    2. Long-presses it to reveal the context menu.
    3. Taps the Share / Chia sẻ option. Icon shares
    4. Selects TikTok from the Android share sheet.

    Returns a success message or a descriptive failure reason at the step
    where the flow broke.
    """
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        # ── 1. Find video.mp4 ────────────────────────────────────────────────
        video_el = _find_element_by_keywords(elements, "video.mp4")
        if video_el is None:
            return (
                "Failed: 'video.mp4' not found in the current view. "
                "Make sure the file manager is open at DCIM/Camera. "
                "Visible elements hint: "
                + ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in (elements or [])[:8]
                )
            )

        idx = video_el.get("index")
        if idx is None:
            return "Failed: video.mp4 element has no index attribute"

        # ── 2. Long-press to reveal context menu ─────────────────────────────
        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.swipe(x, y, x, y, 1000)
        await asyncio.sleep(2)

        # ── 3. Tap Share / Chia sẻ ───────────────────────────────────────────
        ui_state2 = await ctx.state_provider.get_state()
        elements2 = ui_state2.elements if ui_state2 else []
        share_el = _find_element_by_keywords(elements2, "share", "chia sẻ", "Chia sẻ")
        logger.info(f"=====================\nContext menu elements after long-press: {share_el}\n=====================")
        if share_el is None:
            return (
                "Failed: Share option not found in context menu. "
                "Context menu elements hint: "
                + ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in (elements2 or [])[:8]
                )
            )

        share_idx = share_el.get("index")
        if share_idx is None:
            return "Failed: Share element has no index attribute"

        x2, y2 = ui_state2.get_element_coords(share_idx)
        await ctx.driver.tap(x2, y2)
        await asyncio.sleep(3)

        # ── 4. Select TikTok from share sheet ────────────────────────────────
        result = await _select_tiktok_in_share_sheet(ctx)
        if result.startswith("Failed"):
            return result
        return "Chọn cách thức chia sẻ: 'Video', hoặc 'Tin nhắn'"
    except Exception as e:
        return f"Failed: Unexpected error during share flow — {e}"


async def open_file_manager_at_images(*, ctx, **kwargs) -> str:
    """Open the file manager at DCIM/Camera for the photo flow.

    Thin wrapper over ``open_file_manager_at_video`` that confirms our first
    downloaded image (``image_1.*``) is visible instead of ``video.mp4``.  The
    match is extension-agnostic (``image_1.``) because downloads may be saved as
    .jpg/.png/.webp/.gif depending on the source.
    """
    return await open_file_manager_at_video(target_file="image_1.", ctx=ctx)


async def share_images_file_to_tiktok(count: int = 0, *, ctx, **kwargs) -> str:
    """Multi-select image_1.* … image_<count>.* in the file manager, then
    Share → TikTok.

    Expects the file manager already open at DCIM/Camera (call
    ``tiktok_open_file_manager_at_images`` first).  Selects ONLY the files this
    worker downloaded (named ``image_<n>.*``), so any videos or other photos
    in the Camera folder are never touched.  If *count* is 0 it counts the
    ``image_*`` files on the device.

    Flow: long-press ``image_1.*`` to enter multi-select → tap each
    ``image_2.*`` … ``image_<count>.*`` (scrolling to find them) → tap
    Share/Chia sẻ → pick TikTok.  Then call
    ``tiktok_set_photo_caption_and_post`` to finish.

    Matching is by the ``image_<n>.`` prefix (extension-agnostic) since
    downloads may be .jpg/.png/.webp/.gif; the trailing dot keeps ``image_1.``
    from also matching ``image_10.``.
    """
    _SCROLL_DOWN = "input swipe 540 1400 540 600"

    if not count or count <= 0:
        ls = await ctx.driver.device.shell("ls /sdcard/DCIM/Camera/image_* 2>/dev/null")
        count = len([ln for ln in ls.splitlines() if ln.strip() and "No such" not in ln])
    if count <= 0:
        return (
            "Failed: [bước 0] Không có ảnh image_* trên thiết bị. "
            "Gọi tiktok_download_images_to_device trước."
        )

    async def _find_name(name: str):
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        return ui, els, _find_element_by_keywords(els, name)

    try:
        # ── 1. Long-press image_1.* để vào chế độ chọn nhiều ─────────────────
        ui, els, el = await _find_name("image_1.")
        if el is None:
            return (
                "Failed: [bước 1] Không thấy 'image_1.*' trong thư mục. "
                "Đảm bảo file manager đang ở DCIM/Camera (gọi tiktok_open_file_manager_at_images). "
                "Hint: "
                + ", ".join((e.get("text") or e.get("content-desc") or "?")[:30] for e in (els or [])[:8])
            )
        idx = el.get("index")
        if idx is None:
            return "Failed: [bước 1] 'image_1.*' không có index"
        x, y = ui.get_element_coords(idx)
        await ctx.driver.swipe(x, y, x, y, 1000)  # long-press
        await asyncio.sleep(2)

        # ── 2. Chọn thêm image_2.* … image_N.* theo tên (cuộn nếu khuất) ─────
        selected = 1
        for i in range(2, count + 1):
            name = f"image_{i}."
            for _attempt in range(3):
                ui, els, el = await _find_name(name)
                if el is not None:
                    j = el.get("index")
                    if j is None:
                        break
                    tx, ty = ui.get_element_coords(j)
                    await ctx.driver.tap(tx, ty)
                    await asyncio.sleep(0.6)
                    selected += 1
                    break
                await run_adb_command(_SCROLL_DOWN, ctx=ctx)
                await asyncio.sleep(1.2)

        # ── 3. Tap Share / Chia sẻ ───────────────────────────────────────────
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        share_el = _find_element_by_keywords(els, "share", "chia sẻ", "gửi")
        if share_el is None:
            return (
                f"Failed: [bước 3] Không thấy nút Share/Chia sẻ (đã chọn {selected}/{count} ảnh). "
                "Hint: "
                + ", ".join((e.get("text") or e.get("content-desc") or "?")[:30] for e in (els or [])[:10])
            )
        sidx = share_el.get("index")
        if sidx is None:
            return "Failed: [bước 3] Nút Share không có index"
        sx, sy = ui.get_element_coords(sidx)
        await ctx.driver.tap(sx, sy)
        await asyncio.sleep(3)

        # ── 4. Chọn TikTok ở share sheet ─────────────────────────────────────
        result = await _select_tiktok_in_share_sheet(ctx)
        if result.startswith("Failed"):
            return result

        # ── 5. Chọn kiểu chia sẻ "Ảnh" (KHÔNG phải "Tin nhắn") ───────────────
        # TikTok hỏi: chia sẻ thành bài "Ảnh" hay gửi "Tin nhắn". Chọn "Ảnh" để
        # vào trình soạn bài (giống bước "Video" của flow video).
        await asyncio.sleep(2)
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        photo_choice = _find_element_exact(els, "Ảnh", "Photo", "Photos")
        if photo_choice is not None:
            pidx = photo_choice.get("index")
            if pidx is not None:
                px, py = ui.get_element_coords(pidx)
                await ctx.driver.tap(px, py)
                await asyncio.sleep(3)

        return (
            f"Đã chọn {selected}/{count} ảnh và mở trình soạn ảnh TikTok. "
            "Gọi tiktok_set_photo_caption_and_post để nhập caption + hashtag và đăng."
        )
    except Exception as e:
        return f"Failed: [bước ?] Lỗi khi share ảnh sang TikTok — {e}"


async def complete_video_upload(caption: str = "", hashtags=None, *, ctx, **kwargs) -> str:
    """Complete the TikTok video upload by tapping Next, typing caption/hashtags, and Post.

    Expects TikTok's upload editor to already be open (the video should be
    pre-loaded after ``tiktok_share_video_file_to_tiktok``).  The function:

    1. Optionally taps the "Video" tab if it is visible.
    2. Taps "Tiếp" / "Next".
    3. Types the caption and hashtags (if provided).
    4. Taps "Đăng" / "Post".
    5. Confirms the "Đăng video" / "Posting video" progress screen is shown.

    Returns a success message once the upload is queued, or a failure
    reason at the step where the flow broke.
    """
    try:
        # ── 1. Resolve caption + hashtags ─────────────────────────────────────
        if not caption or hashtags is None:
            _raw = get_raw_context()
            _payload = _raw.get("payload") or {}
            if not caption:
                caption = (
                    _payload.get("caption")
                    or _payload.get("content")
                    or _payload.get("content_text")
                    or ""
                ).strip()
            if hashtags is None:
                hashtags = _payload.get("hashtags") or _payload.get("tags") or []

        if isinstance(hashtags, str):
            raw_tags = _parse_str_list(hashtags, sep=r"[,\s]+")
        else:
            raw_tags = _parse_str_list(hashtags)
        norm_tags = [t if t.startswith("#") else "#" + t.lstrip("#") for t in raw_tags]

        full_caption = caption.strip()
        if norm_tags:
            full_caption = (full_caption + " " + " ".join(norm_tags)).strip()

        # ── 1.5. Optionally tap "Video" tab ───────────────────────────────────
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        video_tab = _find_element_by_keywords(elements, "video")
        if video_tab is not None:
            vt_idx = video_tab.get("index")
            if vt_idx is not None:
                x, y = ui_state.get_element_coords(vt_idx)
                await ctx.driver.tap(x, y)
                await asyncio.sleep(2)

        # ── 2. Tap "Tiếp" / "Next" ───────────────────────────────────────────
        ui_state2 = await ctx.state_provider.get_state()
        elements2 = ui_state2.elements if ui_state2 else []
        next_el = _find_element_by_keywords(elements2, "tiếp", "next")
        if next_el is None:
            return (
                "Failed: 'Next' / 'Tiếp' button not found. "
                "TikTok upload editor may not be open yet. "
                "Visible elements hint: "
                + ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in (elements2 or [])[:8]
                )
            )

        next_idx = next_el.get("index")
        if next_idx is None:
            return "Failed: Next element has no index attribute"

        x2, y2 = ui_state2.get_element_coords(next_idx)
        await ctx.driver.tap(x2, y2)
        await asyncio.sleep(3)

        # ── 2.5. Type caption + hashtags (if any) ───────────────────────────
        if full_caption:
            try:
                def _caption_pt(xml):
                    edits = []
                    for m in _BT_NODE_RE.finditer(xml):
                        attrs = m.group(1)
                        if 'class="android.widget.EditText"' not in attrs:
                            continue
                        b = _BT_BOUNDS_RE.search(attrs)
                        if not b:
                            continue
                        x1, y1, x2, y2 = map(int, b.groups())
                        tm = re.search(r'text="([^"]*)"', attrs)
                        edits.append((y1, (x1 + x2) // 2, (y1 + y2) // 2, tm.group(1) if tm else ""))
                    if not edits:
                        return None
                    for _y, cx, cy, t in edits:
                        if re.search(r"(?i)description|mô tả|chú thích|caption", t):
                            return (cx, cy)
                    edits.sort()
                    return (edits[-1][1], edits[-1][2])

                xml = await _bt_dump_ui(ctx)
                cap_pt = _caption_pt(xml)
                if cap_pt is None:
                    # Retry once if UI took a moment to load
                    await asyncio.sleep(1.5)
                    xml = await _bt_dump_ui(ctx)
                    cap_pt = _caption_pt(xml)

                if cap_pt is not None:
                    await ctx.driver.tap(*cap_pt)
                    await asyncio.sleep(1.0)
                    # Trailing space closes the autocomplete panel
                    await ctx.driver.input_text(full_caption + " ")
                    await asyncio.sleep(1.0)
                    await ctx.driver.press_button("back")
                    await asyncio.sleep(1.2)
                    logger.info("complete_video_upload: đã gõ caption %r", full_caption[:60])
                else:
                    logger.warning("complete_video_upload: không tìm thấy ô caption để nhập.")
            except Exception as _cap_err:
                logger.warning("complete_video_upload: bỏ qua gõ caption — %s", _cap_err)

        # ── 3. Tap "Đăng" / "Post" ───────────────────────────────────────────
        ui_state3 = await ctx.state_provider.get_state()
        elements3 = ui_state3.elements if ui_state3 else []
        post_el = _find_element_by_keywords(elements3, "đăng", "post")
        if post_el is None:
            return (
                "Failed: 'Post' / 'Đăng' button not found on caption screen. "
                "Visible elements hint: "
                + ", ".join(
                    (e.get("text") or e.get("content-desc") or "?")[:30]
                    for e in (elements3 or [])[:8]
                )
            )

        post_idx = post_el.get("index")
        if post_idx is None:
            return "Failed: Post element has no index attribute"

        x3, y3 = ui_state3.get_element_coords(post_idx)
        await ctx.driver.tap(x3, y3)
        await asyncio.sleep(3)

        # ── 4. Confirm "Đăng video" / "Posting video" screen ─────────────────
        ui_state4 = await ctx.state_provider.get_state()
        elements4 = ui_state4.elements if ui_state4 else []
        confirm_el = _find_element_by_keywords(
            elements4, "đăng video", "posting video", "posting", "đang đăng"
        )
        if confirm_el is not None:
            return f"Video upload queued successfully — 'Posting video' screen confirmed. Caption: {full_caption[:60]!r}"

        return (
            "Post button tapped — upload likely queued "
            f"(posting confirmation screen not detected, but this may be normal). Caption: {full_caption[:60]!r}"
        )

    except Exception as e:
        return f"Failed: Unexpected error completing video upload — {e}"


async def download_video_to_device(url: str, *, ctx, **kwargs) -> str:
    """Download a video from *url* and save it to /sdcard/DCIM/Camera/video.mp4.

    Uses the standard ``download_file`` tool to save the video to the local
    downloads directory, then pushes it to the connected Android device via
    ADB and notifies the media scanner so the file appears in gallery apps.

    Args:
        url: Public HTTP/HTTPS URL of the MP4 video to download.

    Returns:
        A plain-text result string describing success or the failure reason.
    """
    if not url or not url.strip():
        return "Failed: Video URL cannot be empty"

    clean_url = url.strip()
    if not clean_url.lower().startswith(("http://", "https://")):
        return f"Failed: URL must start with http:// or https:// — got: {clean_url[:60]}"

    local_path: str | None = None
    try:
        serial: str = getattr(ctx.driver, "_serial", None) or ""

        device_dir = _DOWNLOADS_DIR / re.sub(r"[^\w\-]", "_", os.path.basename(serial)) if serial else _DOWNLOADS_DIR
        device_dir.mkdir(parents=True, exist_ok=True)
        local_path = str(device_dir / "video.mp4")

        # Xóa video cũ trước khi tải mới để tránh dùng lại file lỗi/cũ
        if os.path.exists(local_path):
            os.remove(local_path)

        # ── 1. TikTok page URL → dùng yt-dlp ────────────────────────────────
        # aiohttp không thể download TikTok page URL — WAF trả về HTML.
        # yt-dlp xử lý redirect, cookie, signature tự động.
        # shutil.which tìm trong $PATH trước; fallback về đường dẫn cứng trên máy chủ.
        _YTDLP = shutil.which("yt-dlp") or "/opt/conda/bin/yt-dlp"
        is_tiktok_page = bool(re.search(r"tiktok\.com/@[^/]+/video/\d+", clean_url))

        if is_tiktok_page:
            cmd_ytdlp = (
                f'{_YTDLP} -f "best[ext=mp4]/best" '
                f'--merge-output-format mp4 '
                f'--force-overwrites '
                f'-o {local_path!r} '
                f'--no-playlist '
                f'{clean_url!r}'
            )
            proc = await asyncio.create_subprocess_shell(
                cmd_ytdlp,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            except asyncio.TimeoutError:
                proc.kill()
                return "Failed: yt-dlp timed out after 120 seconds"

            if proc.returncode != 0:
                err = stderr.decode(errors="replace").strip()[-300:]
                return f"Failed: yt-dlp could not download video — {err}"

        else:
            # ── 1b. Direct CDN URL → aiohttp ────────────────────────────────
            import aiohttp
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
                "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
                "Referer": "https://www.google.com/",
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(clean_url, timeout=300) as response:
                    if response.status != 200:
                        return f"Failed: Could not download video — HTTP {response.status}"

                    content_type = response.headers.get("Content-Type", "")
                    if "text/html" in content_type or "text/plain" in content_type:
                        return (
                            f"Failed: URL returned a webpage instead of a video "
                            f"(Content-Type: {content_type}). Use a direct CDN URL or a TikTok page URL."
                        )

                    with open(local_path, "wb") as f:
                        while True:
                            chunk = await response.content.read(8192)
                            if not chunk:
                                break
                            f.write(chunk)

        file_size = os.path.getsize(local_path)
        if file_size == 0:
            return "Failed: Downloaded file is empty"

        # Validate magic bytes — MP4/MOV containers have 'ftyp','mdat','moov','wide' at offset 4
        with open(local_path, "rb") as f:
            magic = f.read(12)
        if len(magic) >= 8 and magic[4:8] not in (b"ftyp", b"mdat", b"moov", b"wide"):
            snippet = magic[:16].decode("utf-8", errors="replace")
            return (
                f"Failed: Downloaded file is not a valid video (magic: {snippet!r}). "
                "yt-dlp may have failed silently."
            )

        # ── 2. Ensure destination directory exists and clear its contents ────
        await ctx.driver.device.shell("mkdir -p /sdcard/DCIM/Camera")
        await ctx.driver.device.shell("rm -f /sdcard/DCIM/Camera/*")

        # ── 3. Push the file to the device via ADB ───────────────────────────
        serial_flag = f"-s {serial}" if serial else ""
        cmd = f"adb {serial_flag} push {local_path} /sdcard/DCIM/Camera/video.mp4"

        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            return "Failed: ADB push timed out after 120 seconds"

        if proc.returncode != 0:
            err = stderr.decode(errors="replace").strip()
            return f"Failed: ADB push error — {err}"

        # ── 4. Notify media scanner ───────────────────────────────────────────
        await ctx.driver.device.shell(
            "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE "
            "-d file:///sdcard/DCIM/Camera/video.mp4"
        )

        return (
            f"Video downloaded ({file_size // 1024} KB) and saved to "
            "/sdcard/DCIM/Camera/video.mp4 successfully"
        )

    except Exception as e:
        return f"Failed: Could not download and save video — {e}"


async def get_upload_state(*, ctx, **kwargs) -> str:
    """Identify the current screen state in the TikTok video upload flow.

    Inspects the live UI element tree and matches it against every known
    checkpoint in the share-to-TikTok workflow.  Returns a structured text
    summary containing:

    * ``state`` — machine-readable state name (see list below)
    * ``description`` — human-readable explanation
    * ``element`` — text of the key landmark element that was matched
    * ``next_action`` — what the agent should do to advance

    Known states (in flow order):
    1. ``file_manager_root``   — file manager open at primary storage root
    2. ``file_manager_dcim``   — DCIM folder is visible; needs to be tapped
    3. ``file_manager_camera`` — Camera sub-folder is visible; needs to be tapped
    4. ``file_manager_video``  — video.mp4 is visible; needs long-press
    5. ``context_menu_share``  — long-press context menu shows "Chia sẻ" / "Share"
    6. ``share_sheet``         — Android share sheet open; "TikTok" is visible
    7. ``tiktok_upload_editor``— TikTok editor open; "Tiếp" / "Next" button visible
    8. ``tiktok_caption_screen``— caption screen; "Đăng" / "Post" button visible
    9. ``tiktok_posting``      — "Đăng video" / "Posting video" indicator visible
    10. ``unknown``            — none of the above landmarks found

    Use this tool at any point to recover from an unexpected state before
    deciding whether to continue the upload or fall back and restart.
    """
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        def _el_info(el) -> str:
            """Return a short description of an element's key attributes."""
            text = el.get("text") or el.get("content-desc") or el.get("description") or ""
            center = el.get("center")
            coords = f" @ ({center['x']}, {center['y']})" if center else ""
            return f'"{text}"{coords}'

        # ── State detection (most specific / latest in flow first) ──────────

        # 9. TikTok "Đăng video" / "Posting video" progress screen
        posting_el = _find_element_exact(elements, "Đăng video", "Posting video")
        if posting_el is not None:
            return (
                "state: tiktok_posting\n"
                f"description: TikTok is currently uploading — 'Posting video' screen is active.\n"
                f"element: {_el_info(posting_el)}\n"
                "next_action: Wait for the upload to finish. Task is essentially done."
            )

        # 8. TikTok caption screen — "Đăng" (Post) button
        # Guard: must NOT be "Đăng video" (already handled above)
        post_el = _find_element_exact(elements, "Đăng", "Post")
        if post_el is not None:
            return (
                "state: tiktok_caption_screen\n"
                "description: TikTok caption / description screen is open.\n"
                f"element: {_el_info(post_el)}\n"
                "next_action: Tap 'Đăng' / 'Post' to submit the video."
            )

        # 7. TikTok upload editor — "Tiếp" (Next) button
        next_el = _find_element_exact(elements, "Tiếp", "Next")
        if next_el is not None:
            return (
                "state: tiktok_upload_editor\n"
                "description: TikTok upload editor is open with the video pre-loaded.\n"
                f"element: {_el_info(next_el)}\n"
                "next_action: Optionally tap the 'Video' tab if visible, then tap 'Tiếp' / 'Next'."
            )

        # 6. Android share sheet — "TikTok" option
        tiktok_el = _find_element_exact(elements, "TikTok")
        if tiktok_el is not None:
            return (
                "state: share_sheet\n"
                "description: Android share sheet is open and TikTok is visible.\n"
                f"element: {_el_info(tiktok_el)}\n"
                "next_action: Tap 'TikTok' to open it with the video pre-loaded."
            )

        # 5. Long-press context menu — "Chia sẻ" / "Share" option
        share_el = _find_element_exact(elements, "Chia sẻ", "Share")
        if share_el is not None:
            return (
                "state: context_menu_share\n"
                "description: File context menu is open after long-pressing video.mp4.\n"
                f"element: {_el_info(share_el)}\n"
                "next_action: Tap 'Chia sẻ' / 'Share' to open the Android share sheet."
            )

        # 4. File manager shows video.mp4
        video_file_el = _find_element_exact(elements, "video.mp4")
        if video_file_el is not None:
            return (
                "state: file_manager_video\n"
                "description: File manager is open at DCIM/Camera and video.mp4 is visible.\n"
                f"element: {_el_info(video_file_el)}\n"
                "next_action: Long-press 'video.mp4' to reveal the context menu, then tap Share."
            )

        # 3. File manager shows Camera folder (inside DCIM)
        camera_el = _find_element_exact(elements, "Camera")
        if camera_el is not None:
            return (
                "state: file_manager_camera\n"
                "description: File manager is open at DCIM; the Camera sub-folder is visible.\n"
                f"element: {_el_info(camera_el)}\n"
                "next_action: Tap 'Camera' to open the Camera folder and find video.mp4."
            )

        # 2. File manager shows DCIM folder (at primary storage root)
        dcim_el = _find_element_exact(elements, "DCIM")
        if dcim_el is not None:
            return (
                "state: file_manager_dcim\n"
                "description: File manager is open at the storage root and DCIM is visible.\n"
                f"element: {_el_info(dcim_el)}\n"
                "next_action: Tap 'DCIM' to open that folder."
            )

        # 1. File manager root (open but no recognisable sub-folder landmark yet)
        fm_el = _find_element_by_keywords(
            elements,
            "files",
            "storage",
            "internal storage",
            "documents",
            "externalstorage",
        )
        if fm_el is not None:
            return (
                "state: file_manager_root\n"
                "description: File manager appears to be open at primary storage root.\n"
                f"element: {_el_info(fm_el)}\n"
                "next_action: Navigate to DCIM > Camera to find video.mp4."
            )

        # 10. Unknown — dump first 12 elements as hint
        hints = ", ".join(
            (e.get("text") or e.get("content-desc") or "?")[:30]
            for e in (elements or [])[:12]
        )
        return (
            "state: unknown\n"
            "description: Cannot identify the current upload state from visible UI elements.\n"
            "element: none\n"
            f"next_action: Inspect the screen and decide whether to restart the upload flow. "
            f"Visible elements hint: {hints}"
        )

    except Exception as e:
        return f"Failed: Could not determine upload state — {e}"


# ---------------------------------------------------------------------------
# Browse helpers (_bt_ prefix — internal use by browse_tiktok)
# ---------------------------------------------------------------------------


def _bt_find_bounds(
    xml: str,
    *,
    text: str = "",
    resource_id: str = "",
    class_name: str = "",
    content_desc: str = "",
    text_contains: str = "",
    content_desc_contains: str = "",
    within_y: tuple[int, int] | None = None,
) -> tuple[int, int] | None:
    """Return center (x, y) of the first UIAutomator node matching the given attributes."""
    for m in _BT_NODE_RE.finditer(xml):
        attrs = m.group(1)
        if text and f'text="{text}"' not in attrs:
            continue
        if text_contains:
            tm = re.search(r'text="([^"]*)"', attrs)
            if not tm or text_contains not in tm.group(1):
                continue
        if content_desc_contains:
            cm = re.search(r'content-desc="([^"]*)"', attrs)
            if not cm or content_desc_contains not in cm.group(1):
                continue
        if resource_id and f'resource-id="{resource_id}"' not in attrs:
            continue
        if class_name and f'class="{class_name}"' not in attrs:
            continue
        if content_desc and f'content-desc="{content_desc}"' not in attrs:
            continue
        b = _BT_BOUNDS_RE.search(attrs)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        if within_y and not (within_y[0] <= cy <= within_y[1]):
            continue
        return cx, cy
    return None


_TIKTOK_PKG = "com.ss.android.ugc.trill"
_TIKTOK_ACTIVITY = "com.ss.android.ugc.aweme.splash.SplashActivity"



async def _bt_dump_ui(ctx) -> str:
    """Dump the current screen UI to XML and return the raw XML string."""
    await ctx.driver.device.shell("uiautomator dump /sdcard/browse_ui.xml")
    await asyncio.sleep(0.5)
    return await ctx.driver.device.shell("cat /sdcard/browse_ui.xml")


async def _bt_view_profile(ctx, w: int, h: int, log_fn) -> bool:
    """Tap creator avatar → view profile → scroll → watch 1-3 videos → back to feed."""
    try:
        xml = await _bt_dump_ui(ctx)
        pt = (
            _bt_find_bounds(xml, resource_id="com.ss.android.ugc.trill:id/user_avatar")
            or _bt_find_bounds(xml, content_desc_contains="Hồ sơ")
            or _bt_find_bounds(xml, content_desc_contains="Profile")
        )
        if pt is None:
            return False

        await ctx.driver.tap(pt[0], pt[1])
        await asyncio.sleep(random.uniform(2.5, 4.0))
        log_fn("Đã vào profile")

        # Try to tap Follow button (exact text, not "Đã follow")
        try:
            xml_p = await _bt_dump_ui(ctx)
            for fm in _BT_NODE_RE.finditer(xml_p):
                fa = fm.group(1)
                tm = re.search(r'text="([^"]*)"', fa)
                if not tm or tm.group(1).strip() != "Follow":
                    continue
                bm = _BT_BOUNDS_RE.search(fa)
                if bm:
                    fx = (int(bm.group(1)) + int(bm.group(3))) // 2
                    fy = (int(bm.group(2)) + int(bm.group(4))) // 2
                    await ctx.driver.tap(fx, fy)
                    await asyncio.sleep(1.5)
                    log_fn(f"Đã follow ({fx},{fy})")
                    break
        except Exception:
            pass

        # Scroll profile 1-3 times
        for _ in range(random.randint(1, 3)):
            x1 = int(w * 0.5) + random.randint(-20, 20)
            x2 = int(w * 0.5) + random.randint(-20, 20)
            y1 = int(h * random.uniform(0.70, 0.85))
            y2 = int(h * random.uniform(0.25, 0.40))
            await ctx.driver.swipe(x1, y1, x2, y2, random.randint(300, 600))
            await asyncio.sleep(random.uniform(0.8, 2.0))

        # Tap a random video in the 3-column grid (starts ~y=42% after scroll)
        col = random.randint(0, 2)
        row = random.randint(0, 1)
        await ctx.driver.tap(int(w * (0.17 + col * 0.33)), int(h * (0.42 + row * 0.22)))
        await asyncio.sleep(random.uniform(2.5, 4.0))

        # Watch + swipe through 1-3 videos
        vids = random.randint(1, 3)
        for i in range(vids):
            watch = random.uniform(4.0, 10.0)
            await asyncio.sleep(watch)
            log_fn(f"Xem video profile #{i + 1} ({watch:.0f}s)")
            if i < vids - 1:
                sx = int(w * 0.5) + random.randint(-30, 30)
                await ctx.driver.swipe(
                    sx, int(h * random.uniform(0.78, 0.88)),
                    sx, int(h * random.uniform(0.08, 0.18)),
                    random.randint(220, 520),
                )
                await asyncio.sleep(random.uniform(0.8, 1.5))

        # Back: video → profile → feed
        await ctx.driver.press_button("back")
        await asyncio.sleep(random.uniform(1.0, 1.8))
        await ctx.driver.press_button("back")
        await asyncio.sleep(random.uniform(1.0, 2.0))
        log_fn(f"Rời profile, xem {vids} video")
        return True
    except Exception:
        return False


async def browse_tiktok(
    duration_minutes: float = 0,
    video_count: int = 0,
    *,
    ctx,
    **kwargs,
) -> str:
    """Lướt TikTok tự động — mở app, lướt feed, thả tim ngẫu nhiên.

    Dừng khi hết duration_minutes HOẶC đủ video_count (điều kiện nào tới trước).
    Nếu cả hai đều 0, mặc định lướt 10 phút.
    """
    def _log(msg: str) -> None:
        logger.info("[browse_tiktok] %s", msg)

    # Screen size
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for line in raw_size.splitlines():
        if "size" in line.lower():
            parts = line.split(":")[-1].strip().split("x")
            if len(parts) == 2:
                try:
                    w, h = int(parts[0]), int(parts[1])
                except ValueError:
                    pass
            break

    # Stop conditions
    if duration_minutes <= 0 and video_count <= 0:
        duration_minutes = 10.0
    total_seconds = duration_minutes * 60 if duration_minutes > 0 else float("inf")

    # Ensure screen is on and unlocked before doing anything
    await ensure_screen_on(ctx=ctx)

    # Open TikTok
    launch_result = await ctx.driver.start_app(_TIKTOK_PKG, _TIKTOK_ACTIVITY)
    if launch_result.startswith("Failed"):
        # Force-stop then retry once
        await ctx.driver.device.shell(f"am force-stop {_TIKTOK_PKG}")
        await asyncio.sleep(1.5)
        launch_result = await ctx.driver.start_app(_TIKTOK_PKG, _TIKTOK_ACTIVITY)
        if launch_result.startswith("Failed"):
            return f"Failed: Không mở được TikTok sau 2 lần thử — {launch_result}"
    await asyncio.sleep(random.uniform(3.5, 5.0))

    start_time = time.monotonic()
    watched = 0
    likes = 0
    profiles_viewed = 0
    scroll_backs = 0
    livestream_views = 0
    ads_skipped = 0

    like_bucket = 0
    likes_in_bucket = 0
    like_target = random.randint(2, 3)

    def _elapsed() -> float:
        return time.monotonic() - start_time

    def _should_stop() -> bool:
        if _elapsed() >= total_seconds:
            return True
        if video_count > 0 and watched >= video_count:
            return True
        return False

    while not _should_stop():
        like_bucket += 1
        remaining = total_seconds - _elapsed()
        if total_seconds != float("inf") and remaining < 5:
            break

        # Detect off-feed (SparkActivity / webview / out-of-app / notifications)
        try:
            win = await ctx.driver.device.shell("dumpsys window")
            focus_line = next((ln for ln in win.splitlines() if "mCurrentFocus=" in ln), "")
            fl_lower = focus_line.lower()

            # Lock screen — wake nếu tắt, rồi swipe lên để mở khoá
            if "keyguard" in fl_lower:
                _log("Màn hình bị khóa — mở khoá")
                is_awake = (await ctx.driver.device.shell(
                    "dumpsys power | grep -c 'mWakefulness=Awake'"
                )).strip() == "1"
                if not is_awake:
                    await ctx.driver.device.shell("input keyevent 26")
                    await asyncio.sleep(1.0)
                await ctx.driver.device.shell(f"input swipe {w//2} {int(h*0.85)} {w//2} {int(h*0.15)}")
                await asyncio.sleep(1.5)
                continue

            # Notification shade — collapse (shade chỉ hiện khi screen on)
            if "notificationshade" in fl_lower:
                _log("Notification shade — đóng")
                await ctx.driver.device.shell("cmd statusbar collapse")
                await asyncio.sleep(1.0)
                continue

            # SparkActivity webview trap — back về feed
            if "sparkactivity" in fl_lower:
                _log("Kẹt ở SparkActivity — back về feed")
                for _ in range(4):
                    await ctx.driver.press_button("back")
                    await asyncio.sleep(random.uniform(1.0, 1.6))
                    win2 = await ctx.driver.device.shell("dumpsys window")
                    fl2 = next((ln for ln in win2.splitlines() if "mCurrentFocus=" in ln), "")
                    if "sparkactivity" not in fl2.lower():
                        break
                continue

            # Permission dialog (contacts/mic/...) hoặc TikTok in-app dialog ("Đã hiểu", v.v.)
            if (
                any(k in fl_lower for k in ("permissioncontroller", "packageinstaller", "grantpermissions"))
                or (_TIKTOK_PKG in fl_lower and "dialog" in fl_lower)
            ):
                _log(f"Dialog/popup — gọi dismiss_popup ({focus_line.strip()})")
                await dismiss_popup(ctx=ctx)
                await asyncio.sleep(1.0)
                continue

            # TikTok bị đẩy ra background hoàn toàn — dùng mFocusedApp (không bị overlay che)
            app_line = next((ln for ln in win.splitlines() if "mFocusedApp=" in ln), "")
            if app_line and "null" not in app_line and _TIKTOK_PKG not in app_line.lower():
                # Double-check: wait and re-read in case of transient system dialog/transition
                _log(f"TikTok có vẻ out of foreground ({app_line.strip()}) — chờ xác nhận")
                await asyncio.sleep(1.5)
                win2 = await ctx.driver.device.shell("dumpsys window")
                app_line2 = next((ln for ln in win2.splitlines() if "mFocusedApp=" in ln), "")
                if app_line2 and _TIKTOK_PKG not in app_line2.lower():
                    # System picker/chooser opened by TikTok — back để về TikTok
                    _SYSTEM_PICKERS = ("photopicker", "providers.media", "filepicker",
                                       "intentresolver", "chooser", "documentsprovider")
                    if any(p in app_line2.lower() for p in _SYSTEM_PICKERS):
                        _log(f"System picker do TikTok mở — back để đóng ({app_line2.strip()})")
                        await ctx.driver.press_button("back")
                        await asyncio.sleep(1.5)
                        continue
                    _log(f"TikTok out of foreground — relaunch ({app_line2.strip()})")
                    relaunch_result = await ctx.driver.start_app(_TIKTOK_PKG, _TIKTOK_ACTIVITY)
                    if relaunch_result.startswith("Failed"):
                        return (
                            f"Failed: TikTok bị out of foreground và không relaunch được — {relaunch_result}. "
                            f"Đã lướt được: {watched} video, {likes} like, {round(_elapsed()/60,1)} phút."
                        )
                    await asyncio.sleep(random.uniform(3.5, 5.0))
                else:
                    _log("TikTok trở lại foreground — tiếp tục")
                continue
        except Exception:
            pass

        # Detect livestream
        is_live = False
        try:
            win = await ctx.driver.device.shell("dumpsys window")
            if any(m in win.lower() for m in ("liveactivity", "liveplayactivity", "live.live", ".live.")):
                is_live = True
            if not is_live:
                xml = await _bt_dump_ui(ctx)
                is_live = any(m in xml for m in (
                    "Trực tiếp", "TRỰC TIẾP", "Gửi quà", "Send Gift",
                    "đang phát trực tiếp", "Nói gì đó",
                ))
        except Exception:
            pass

        if is_live:
            livestream_views += 1
            _log("Livestream — bỏ qua")
            # Back trước để chắc chắn thoát live room, rồi swipe sang video tiếp
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.0)
            sx = int(w * 0.5) + random.randint(-30, 30)
            await ctx.driver.swipe(
                sx, int(h * random.uniform(0.78, 0.88)),
                sx, int(h * random.uniform(0.08, 0.18)),
                random.randint(220, 520),
            )
            await asyncio.sleep(random.uniform(0.8, 1.5))
            continue

        # Detect ads và in-app popup — dùng chung 1 UI dump
        try:
            xml_ad = await _bt_dump_ui(ctx)
            if xml_ad:
                # TikTok in-app popup ("Đã hiểu", "OK", v.v.) — tap để dismiss
                pt_dismiss = (
                    _bt_find_bounds(xml_ad, text="Đã hiểu")
                )
                if pt_dismiss:
                    _log(f"In-app popup — tap dismiss tại {pt_dismiss}")
                    await ctx.driver.tap(*pt_dismiss)
                    await asyncio.sleep(1.0)
                    continue

                # Quảng cáo — swipe qua
                if any(m in xml_ad for m in (
                    "Quảng cáo", "Sponsored", "Tìm hiểu thêm",
                    "Mua ngay", "Shop now", "Learn more",
                )):
                    ads_skipped += 1
                    _log("Quảng cáo — skip")
                    sx = int(w * 0.5) + random.randint(-30, 30)
                    await ctx.driver.swipe(
                        sx, int(h * random.uniform(0.78, 0.88)),
                        sx, int(h * random.uniform(0.08, 0.18)),
                        random.randint(220, 520),
                    )
                    await asyncio.sleep(random.uniform(0.8, 1.5))
                    continue
        except Exception:
            pass

        # Normal video — watch
        watched += 1
        video_length = random.uniform(8, 25)
        min_watch = video_length * 0.55
        roll = random.random()
        if roll < 0.15:
            watch_time = random.uniform(video_length, video_length * 1.5)  # xem hết + replay
        elif roll < 0.50:
            watch_time = random.uniform(min_watch, video_length)           # xem gần hết
        else:
            watch_time = random.uniform(min_watch * 0.6, min_watch)        # xem lướt qua
        if total_seconds != float("inf"):
            watch_time = min(watch_time, max(remaining - 3, 5))

        segments = max(1, int(watch_time / random.uniform(4, 8)))
        per_seg = watch_time / segments
        for _ in range(segments):
            await asyncio.sleep(per_seg * random.uniform(0.9, 1.1))

        _log(f"Video #{watched} — xem {watch_time:.0f}s")

        # Like: 2-3 per 10 videos (~35% chance per eligible video)
        if like_bucket >= 10:
            like_bucket = 0
            likes_in_bucket = 0
            like_target = random.randint(2, 3)
        if likes_in_bucket < like_target and random.random() < 0.35:
            cx = int(w * random.uniform(0.35, 0.55))
            cy = int(h * random.uniform(0.35, 0.50))
            await ctx.driver.tap(cx, cy)
            await asyncio.sleep(random.uniform(0.08, 0.16))
            await ctx.driver.tap(cx, cy)
            await asyncio.sleep(random.uniform(0.6, 1.4))
            likes += 1
            likes_in_bucket += 1
            _log(f"Like #{watched} ({likes_in_bucket}/{like_target} trong bucket)")

        # View profile (~20%)
        if random.random() < 0.20 and not _should_stop():
            if await _bt_view_profile(ctx, w, h, _log):
                profiles_viewed += 1

        # Scroll back to previous video (~3%)
        if watched > 3 and random.random() < 0.03 and not _should_stop():
            sx = int(w * 0.5) + random.randint(-20, 20)
            await ctx.driver.swipe(
                sx, int(h * random.uniform(0.18, 0.28)),
                sx, int(h * random.uniform(0.72, 0.82)),
                random.randint(260, 500),
            )
            await asyncio.sleep(random.uniform(1.5, 3.5))
            scroll_backs += 1
            sx2 = int(w * 0.5) + random.randint(-30, 30)
            await ctx.driver.swipe(
                sx2, int(h * random.uniform(0.78, 0.88)),
                sx2, int(h * random.uniform(0.08, 0.18)),
                random.randint(220, 520),
            )
            await asyncio.sleep(random.uniform(1.0, 2.0))
            continue

        # Natural pause then swipe to next video
        await asyncio.sleep(random.uniform(0.5, 2.5))
        sx = int(w * 0.5) + random.randint(-30, 30)
        await ctx.driver.swipe(
            sx, int(h * random.uniform(0.78, 0.88)),
            sx, int(h * random.uniform(0.08, 0.18)),
            random.randint(220, 520),
        )
        await asyncio.sleep(random.uniform(1.0, 2.5))

    actual_minutes = round(_elapsed() / 60, 1)
    return (
        f"Hoàn thành lướt TikTok: {actual_minutes} phút, "
        f"{watched} video, {likes} like, "
        f"{profiles_viewed} profile, {livestream_views} live, "
        f"{ads_skipped} quảng cáo bỏ qua, {scroll_backs} scroll back"
    )


# ---------------------------------------------------------------------------
# Precondition helpers
# ---------------------------------------------------------------------------


def screen_guard(*required_keywords: str):
    """Return a precondition callable that passes when any keyword is found on screen.

    The returned coroutine inspects the live UI element tree and checks whether
    at least one of *required_keywords* appears in any visible element's text,
    content-desc, or resource-id.  If none are found it returns a descriptive
    failure message so the LLM knows which screen it needs to navigate to first.

    Args:
        *required_keywords: One or more strings to search for.  The check
            passes as soon as the first matching element is found.

    Returns:
        An ``async (ctx) -> (bool, str)`` callable suitable for the
        ``precondition`` field of a tool entry.
    """
    async def check(ctx) -> tuple[bool, str]:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        for kw in required_keywords:
            if _find_element_by_keywords(elements, kw):
                return True, ""
        visible = ", ".join(
            (e.get("text") or e.get("content-desc") or "?")[:20]
            for e in (elements or [])[:6]
        )
        return (
            False,
            f"Screen does not contain required element(s) {list(required_keywords)}. "
            f"Visible: [{visible}]",
        )
    return check


def activity_guard(activity_name: str):
    """Return a precondition callable that passes when the foreground activity matches.

    Reads ``phone_state`` from the current UI snapshot (populated by the
    Android state provider) and checks whether *activity_name* is a substring
    of the current activity/package reported by the device.

    Args:
        activity_name: Substring to look for in the current activity name
            (e.g. ``"com.ss.android.ugc"``).

    Returns:
        An ``async (ctx) -> (bool, str)`` callable suitable for the
        ``precondition`` field of a tool entry.
    """
    async def check(ctx) -> tuple[bool, str]:
        ui_state = await ctx.state_provider.get_state()
        phone_state = (ui_state.phone_state if ui_state else {}) or {}
        current = phone_state.get("activity") or phone_state.get("package") or ""
        ok = activity_name in current
        return ok, (
            "" if ok else
            f"Expected activity containing '{activity_name}', got '{current}'"
        )
    return check


async def send_webhook_callback(video_url: str, content: str, keyword: str = "", task_id: int = 0, *, ctx, **kwargs) -> str:
    """
    Gửi link video TikTok và mô tả gốc về Dashboard để tạo một bản ghi mới.
    
    Args:
        video_url: Đường link video TikTok đã copy.
        content: Nội dung caption/mô tả gốc của video.
        keyword: Từ khóa đã dùng để tìm kiếm video này.
        task_id: ID của task gốc (không bắt buộc nếu tạo mới).
    """
    import re
    import aiohttp

    # Pull task metadata from the injected async context so tools do not depend
    # on the LLM passing these values explicitly.
    from task_context import get_raw_context
    _raw = get_raw_context()
    _payload = _raw.get("payload") or {}

    # Use context values as fallbacks when the LLM omits arguments.
    if not keyword:
        keyword = _payload.get("keyword", "")
    if not task_id:
        task_id = _raw.get("task_id", 0) or 0
    list_id: int = kwargs.get("list_id") or _payload.get("list_id", 0) or 0
        
    try:
        # 1. Try to get clipboard content using multiple ADB methods
        clipboard = ""
        
        # Method A: cmd clipboard get (Modern Android)
        res_cmd = await run_adb_command("cmd clipboard get", ctx=ctx)
        if res_cmd and "No shell command" not in res_cmd and "permission" not in res_cmd.lower():
            clipboard = res_cmd.strip()
            
        # Method B: dumpsys clipboard (Fallback)
        if not clipboard:
            dumpsys_out = await run_adb_command("dumpsys clipboard", ctx=ctx)
            match = re.search(r'text/plain\s+["\']([^"\']+)["\']', dumpsys_out)
            if match:
                clipboard = match.group(1)
            else:
                # Just grab any URL from the dumpsys output
                urls = re.findall(r'(https?://[^\s"\'\)]+)', dumpsys_out)
                clipboard = urls[0] if urls else ""
                
        # Clean and extract the actual link
        urls = re.findall(r'(https?://(?:vt\.|www\.)?tiktok\.com/[^\s/]+/?|https?://[^\s]+)', clipboard)
        if not urls:
            return f"Failed: Could not find any valid URL in clipboard. Got: {clipboard[:50]}..."
            
        video_url = urls[0].strip()
        
        # 2. Call the Dashboard API (POST to create a NEW record)
        payload_dashboard = {
            "video_url": video_url,
            "caption": content,
            "keywords": [keyword] if keyword else [], # Save the keyword used for search
            "status": "pending",
            "task_id": task_id,
            "list_id": list_id,
        }
        
        # Base URL for creating new records
        dashboard_url = f"{_api_base()}/api/tiktok/"
        ext_api_key = os.getenv("TIKTOK_API_KEY", "")
        
        headers = {
            "Authorization": f"Api-Key {ext_api_key}",
            "Content-Type": "application/json"
        }
        
        async with aiohttp.ClientSession() as session:
            # Use POST to create a new entry
            async with session.post(dashboard_url, json=payload_dashboard, headers=headers, timeout=30) as resp:
                status = resp.status

        return f"Success! New video record created for '{keyword}'. URL: {video_url}. Status: {status}."
        
    except Exception as e:
        return f"Failed: Unexpected error sending webhook — {e}"


async def open_video_and_comment(
    *,
    ctx,
    video_link: str = "",
    comment_context: str = "",
    **kwargs,
) -> str:
    """Mở video TikTok rồi đăng comment.

    Bước 1: Lấy video_link + comment_context — ưu tiên tham số trực tiếp, fallback sang payload.
    Bước 2: Mở video bằng ADB deep link (am start VIEW).
    Bước 3: Guard check + tap nút comment/bình luận.
    Bước 4: Guard check + nhập nội dung comment.
    Bước 5: Guard check + tap nút Post/Gửi.
    Trả về kết quả hoặc 'Failed: [bước N] ...' để LLM biết retry đúng chỗ.
    """
    from task_context import get_raw_context

    # ── Bước 1: Lấy video_link + comment_context ────────────────────────────
    # Ưu tiên 1: tham số LLM truyền vào trực tiếp
    # Ưu tiên 2: fallback đọc payload
    # Ưu tiên 3: trả lỗi rõ để LLM gọi lại với tham số đầy đủ
    if not video_link or not comment_context:
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        if not video_link:
            video_link = (_payload.get("video_link") or _payload.get("video_url") or "").strip()
        if not comment_context:
            comment_context = (_payload.get("comment_context") or _payload.get("comment_content") or "").strip()

    comment_text = comment_context

    logger.info("[open_video_and_comment] Bước 1: video_link=%s comment_len=%d", video_link[:80], len(comment_text))

    if not video_link:
        return (
            "Failed: [bước 1] Không tìm thấy 'video_link' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số video_link."
        )
    if not comment_text:
        return (
            "Failed: [bước 1] Không tìm thấy 'comment_context' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số comment_context."
        )
    if not video_link.startswith("http"):
        return f"Failed: [bước 1] video_link không hợp lệ: {video_link[:80]}"

    # ── Bước 2: Mở video TikTok bằng ADB deep link ──────────────────────────
    adb_cmd = f"am start -a android.intent.action.VIEW -d '{video_link}'"
    logger.info("[open_video_and_comment] Bước 2: %s", adb_cmd)
    try:
        result = await ctx.driver.device.shell(adb_cmd)
        logger.info("[open_video_and_comment] Bước 2 kết quả: %s", result.strip()[:120])
    except Exception as e:
        return f"Failed: [bước 2] ADB deep link lỗi — {e}"

    await asyncio.sleep(4.0)

    # ── Bước 2.5: Tap trung tâm màn hình để vào full player ─────────────────
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for _line in raw_size.splitlines():
        if "size" in _line.lower():
            _parts = _line.split(":")[-1].strip().split("x")
            if len(_parts) == 2:
                try:
                    w, h = int(_parts[0]), int(_parts[1])
                except ValueError:
                    pass
            break
    await ctx.driver.tap(w // 2, h // 2)
    logger.info("[open_video_and_comment] Bước 2.5: Tap center (%d, %d) để vào full player", w // 2, h // 2)
    await asyncio.sleep(1.5)

    # ── Bước 3: Guard check video + tap nút comment ──────────────────────────
    guard3 = screen_guard("Bình luận", "Comment", "comment")
    ok3, msg3 = await guard3(ctx)
    if not ok3:
        return f"Failed: [bước 3] Video chưa load xong hoặc màn hình sai — {msg3}"
    logger.info("[open_video_and_comment] Bước 3: Screen guard passed, gọi open_comment_section")
    r3 = await open_comment_section(ctx=ctx)
    logger.info("[open_video_and_comment] Bước 3 kết quả: %s", r3)
    if "Failed" in r3:
        return f"Failed: [bước 3] {r3}"
    await asyncio.sleep(2.0)

    # ── Bước 4: Guard check comment section + nhập text ──────────────────────
    guard4 = screen_guard("add comment", "write a comment", "nhập bình luận", "comment_text", "Thêm bình luận")
    ok4, msg4 = await guard4(ctx)
    if not ok4:
        return f"Failed: [bước 4] Comment section chưa mở — {msg4}"
    logger.info("[open_video_and_comment] Bước 4: Screen guard passed, gọi type_comment")
    r4 = await type_comment(text=comment_text, ctx=ctx)
    logger.info("[open_video_and_comment] Bước 4 kết quả: %s", r4[:80])
    if "Failed" in r4:
        return f"Failed: [bước 4] {r4}"
    await asyncio.sleep(0.8)

    # ── Bước 5: Guard check nút Post + đăng comment ──────────────────────────
    guard5 = screen_guard("post", "send", "đăng", "gửi", "Đăng", "Post")
    ok5, msg5 = await guard5(ctx)
    if not ok5:
        logger.warning("[open_video_and_comment] Bước 5: guard fail (%s) — có thể là icon, vẫn thử post_comment", msg5)
    r5 = await post_comment(ctx=ctx)
    logger.info("[open_video_and_comment] Bước 5 kết quả: %s", r5)
    if "Failed" in r5:
        return f"Failed: [bước 5] {r5}. Tip: Nút 'Đăng' có thể không có chữ mà là một ICON (hình mũi tên hoặc máy bay giấy)."
    await asyncio.sleep(1.5)

    # ── Bước 6: Đóng comment section bằng Back ───────────────────────────────
    await ctx.driver.press_button("back")
    await asyncio.sleep(0.5)

    # ── Bước 7: Ghi lại tương tác lên Dashboard ─────────────────────────────
    logger.info("[open_video_and_comment] Bước 7: Ghi tương tác lên Dashboard")
    record_result = await record_comment_interaction(ctx=ctx, video_link=video_link, comment_context=comment_text)
    logger.info("[open_video_and_comment] Bước 7 kết quả: %s", record_result[:120])

    logger.info("[open_video_and_comment] Hoàn thành — comment đã đăng lên %s", video_link[:80])
    return f"Comment đã đăng thành công lên video {video_link[:80]!r}: {comment_text[:60]!r} | {record_result}"


async def find_comment_link(video_link: str, comment_text: str) -> str | None:
    """Quét toàn bộ comment của video_link, tìm comment khớp comment_text, trả về link.

    Dùng scrape_comments.py để intercept TikTok API trên browser (Playwright/server).
    Trả về link_comment nếu tìm thấy, None nếu không.
    """
    try:
        from scrape_comments import scrape_comments as _scrape
    except ImportError as e:
        logger.error("[find_comment_link] Không import được scrape_comments: %s", e)
        return None

    try:
        logger.info("[find_comment_link] Bắt đầu quét comment video: %s", video_link[:80])
        rows = await _scrape(video_link)
        logger.info("[find_comment_link] Quét xong — tổng %d comments", len(rows))
    except Exception as e:
        logger.error("[find_comment_link] Lỗi khi scrape: %s", e)
        return None

    if not rows:
        logger.warning("[find_comment_link] Không có comment nào — video có thể private hoặc bị chặn")
        return None

    needle = comment_text.strip().lower()

    # Ưu tiên exact match trước
    for row in rows:
        if row.get("text", "") == comment_text:
            logger.info("[find_comment_link] Exact match: @%s → %s", row.get("username"), row.get("link_comment"))
            return row.get("link_comment")

    # Fallback: normalized match
    for row in rows:
        if row.get("text", "").strip().lower() == needle:
            logger.info("[find_comment_link] Normalized match: @%s → %s", row.get("username"), row.get("link_comment"))
            return row.get("link_comment")

    logger.warning("[find_comment_link] Không tìm thấy comment khớp trong %d rows. needle=%r", len(rows), needle[:60])
    return None


async def scrape_and_find_comment_link(*, ctx, **kwargs) -> str:
    """Tool: Quét comment video TikTok và tìm link của comment vừa đăng.

    Đọc video_link và comment_context từ task payload (không cần LLM truyền tham số).
    Chờ 30s để TikTok index comment mới trước khi quét.
    Trả về [FOUND COMMENT LINK] hoặc [COMMENT NOT FOUND] để LLM báo cáo kết quả.
    """
    from task_context import get_raw_context

    _raw = get_raw_context()
    _payload = _raw.get("payload") or {}
    video_link = (_payload.get("video_link") or _payload.get("video_url") or "").strip()
    comment_text = (_payload.get("comment_context") or _payload.get("comment_content") or "").strip()

    logger.info("[scrape_and_find_comment_link] video_link=%s comment_text=%r", video_link[:80], comment_text[:60])

    if not video_link:
        return "Failed: Payload thiếu 'video_link' — không thể quét comment."
    if not comment_text:
        return "Failed: Payload thiếu 'comment_context' — không biết tìm comment nào."

    logger.info("[scrape_and_find_comment_link] Chờ 30s để TikTok index comment mới...")
    await asyncio.sleep(30.0)

    link = await find_comment_link(video_link, comment_text)

    if link:
        logger.info("[scrape_and_find_comment_link] [FOUND COMMENT LINK]: %s", link)
        return f"[FOUND COMMENT LINK]: {link}"
    else:
        logger.warning("[scrape_and_find_comment_link] [COMMENT NOT FOUND] — comment chưa index hoặc text không khớp")
        return "[COMMENT NOT FOUND]: không tìm thấy link — comment có thể chưa được index hoặc text không khớp chính xác"


async def update_comment_plan(
    *,
    video_link: str = "",
    comment_link: str = "",
    is_commented: bool | None = None,
    comment_plan_id: int | None = None,
) -> str:
    """Cập nhật comment_link và/hoặc is_commented lên Dashboard (update-comment-plan API).

    POST /api/tiktok/update-comment-plan/
    """
    import aiohttp

    api_url = f"{_api_base()}/api/tiktok/update-comment-plan/"
    api_keys = [
        k for k in [
            os.getenv("TIKTOK_EXT_API_KEY", "").strip().strip('"').strip("'"),
            os.getenv("TIKTOK_API_KEY", "").strip().strip('"').strip("'"),
        ] if k
    ]
    body: dict = {}
    if video_link:
        body["video_link"] = video_link
    if comment_plan_id is not None:
        body["comment_plan_id"] = comment_plan_id
    if comment_link:
        body["comment_link"] = comment_link
    if is_commented is not None:
        body["is_commented"] = is_commented

    last_status, last_text = None, ""
    logger.info("[update_comment_plan] request body=%s", body)
    for idx, api_key in enumerate(api_keys):
        headers = {
            "Authorization": f"Api-Key {api_key}",
            "Content-Type": "application/json",
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(api_url, json=body, headers=headers, timeout=30) as resp:
                    last_status = resp.status
                    last_text = await resp.text()
            logger.info("[update_comment_plan] key#%d status=%d body=%s", idx + 1, last_status, last_text[:200])

            if last_status == 200:
                return f"[COMMENT PLAN UPDATED] status={last_status}"
            if last_status in (401, 403, 404):
                logger.warning("[update_comment_plan] key#%d status=%d, thử key tiếp theo...", idx + 1, last_status)
                continue  # thử key khác
            # Lỗi khác (400...) — không cần thử key khác
            return f"[UPDATE FAILED] HTTP {last_status}: {last_text[:200]}"
        except Exception as e:
            logger.error("[update_comment_plan] key#%d lỗi: %s", idx + 1, e)
            last_text = str(e)

    return f"[UPDATE FAILED] Tất cả API key đều thất bại. Last status={last_status}: {last_text[:200]}"


async def record_comment_interaction(
    *,
    ctx,
    video_link: str = "",
    comment_context: str = "",
    comment_link: str = "",
    profile_username: str = "",
    **kwargs,
) -> str:
    """Ghi lại tương tác comment lên Dashboard sau khi agent đã đăng comment thành công.

    Ưu tiên tham số truyền vào, fallback sang task payload.
    Gọi POST /api/tiktok/record-interaction/ với interaction_type='comment'.
    """
    import aiohttp
    from datetime import datetime, timezone
    from task_context import get_raw_context

    _raw = get_raw_context()
    _profile_id = _raw.get("profile_id", "")
    _payload = _raw.get("payload") or {}
    if not video_link:
        video_link = (_payload.get("video_link") or _payload.get("video_url") or "").strip()
    if not comment_context:
        comment_context = (_payload.get("comment_context") or _payload.get("comment_content") or "").strip()
    comment_text = comment_context
    if not profile_username:
        profile_username = _profile_id or _payload.get("profile_id", "") or _payload.get("username", "")

    logger.info(
        "[record_comment_interaction] video_link=%s comment=%r profile=%s link=%s",
        video_link[:80], comment_text[:60], profile_username, comment_link[:],
    )

    if not video_link:
        return "Failed: Payload thiếu 'video_link' — không thể record interaction."
    if not comment_text:
        return "Failed: Payload thiếu 'comment_context' — không thể record interaction."

    api_url = f"{_api_base()}/api/tiktok/record-interaction/"
    api_key = os.getenv("TIKTOK_API_KEY", "").strip().strip('"').strip("'")
    headers = {
        "Authorization": f"Api-Key {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "video_url": video_link,
        "interaction_type": "comment",
        "profile_username": profile_username or "profile1",
        "comment_content": comment_text,
        "interacted_at": datetime.now(tz=timezone.utc).isoformat(),
    }
    if comment_link:
        body["comment_link"] = comment_link

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(api_url, json=body, headers=headers, timeout=30) as resp:
                status = resp.status
                resp_text = await resp.text()

        logger.info("[record_comment_interaction] Dashboard response: %d %s", status, resp_text[:200])

        if status in (200, 201):
            _comment_plan_id = _payload.get("comment_plan_id")
            update_result = await update_comment_plan(
                video_link=video_link,
                is_commented=True,
                comment_plan_id=_comment_plan_id,
            )
            logger.info("[record_comment_interaction] update-plan: %s", update_result)
            return (
                f"[INTERACTION RECORDED] comment đã được ghi lên Dashboard. "
                f"video={video_link[:80]!r} comment={comment_text[:60]!r} status={status}"
            )
        else:
            return (
                f"[RECORD FAILED] Dashboard trả về HTTP {status}: {resp_text[:200]}"
            )
    except Exception as e:
        logger.error("[record_comment_interaction] Lỗi gọi API: %s", e)
        return f"[RECORD FAILED] Lỗi kết nối Dashboard: {e}"


async def report_copy_success(ctx, **kwargs) -> str:
    """Công cụ để Bot báo cáo đã copy link thành công và đồng bộ ngay lập tức lên Dashboard.
    
    Được thiết kế để chạy ngay trong lúc agent đang hoạt động, giúp đẩy link lên 
    Dashboard tức thì, cho phép agent tiếp tục xử lý các video tiếp theo.
    """
    raw = get_raw_context()
    device_serial_id = getattr(ctx.driver, "_serial", None) or ""
    payload = raw.get("payload") or {}
    task_id = raw.get("task_id", 0)

    # Thực hiện đồng bộ clipboard ngay lập tức thay vì đợi hậu xử lý
    success = await post_process_sync_clipboard(device_serial_id, payload, task_id)
    
    if success:
        return (
            "✅ [SUCCESS] Link đã được đồng bộ lên Dashboard thành công. "
            "Nếu bạn cần lấy thêm video cho từ khóa này, hãy lướt xuống video tiếp theo và tiếp tục quy trình Copy Link. "
            "Nếu đã đủ số lượng yêu cầu, bạn có thể kết thúc task."
        )
    else:
        return (
            "⚠️ [WARNING] Đã ghi nhận copy link nhưng đồng bộ lên Dashboard thất bại. "
            "Vui lòng thử nhấn 'Sao chép liên kết' (Copy Link) lại một lần nữa để chắc chắn link đã nằm trong clipboard."
        )


async def _resolve_short_url(url: str) -> str:
    """Follow redirects to get the full canonical URL from a short TikTok URL, stripping query params."""
    import aiohttp
    from urllib.parse import urlparse, urlunparse
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                parsed = urlparse(str(resp.url))
                return urlunparse(parsed._replace(query="", fragment=""))
    except Exception as e:
        logger.warning("Không thể resolve URL %s: %s — dùng URL gốc", url, e)
        return url


async def post_process_sync_clipboard(device_serial_id: str, payload: dict, task_id: int = 0) -> bool:
    """Hậu xử lý: Lấy link từ thiết bị thông qua ADB và gửi lên Dashboard.

    Được đăng ký là ``post_process`` của công cụ ``tiktok_report_copy_success`` và sẽ được
    gọi tự động bởi task_executor sau khi agent hoàn thành nhiệm vụ thành công.

    Args:
        device_serial_id: Serial ID của thiết bị Android.
        payload: Toàn bộ payload của task (chứa keyword và các thông tin khác).
        task_id: ID của task đang thực thi.
    """
    import json
    import aiohttp

    keyword = payload.get("keyword") or ""
    logger.info("Bắt đầu hậu xử lý đồng bộ link cho thiết bị %s", device_serial_id)
    try:
        clipboard = ""
        # Sử dụng ADB được viết sẵn của Mobilerun Portal để đọc clipboard
        cmd = f"adb -s {device_serial_id} shell content query --uri content://com.mobilerun.portal/getclipboard"
        process = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await process.communicate()
        res_cmd = stdout.decode("utf-8", errors="ignore").strip()

        # Parse JSON từ kết quả trả về (VD: Row: 0 result={"status":"success","result":"https:\/\/vt.tiktok.com\/..."})
        if "tiktok.com" in res_cmd:
            json_start = res_cmd.find("{")
            if json_start >= 0:
                try:
                    data = json.loads(res_cmd[json_start:])
                    if data.get("status") == "success":
                        clipboard = data.get("result", "")
                except Exception as e:
                    logger.error("Lỗi parse JSON từ clipboard: %s", e)

        # Nếu link dạng rút gọn hoặc chứa escape slash, ta làm sạch nó
        clipboard = clipboard.replace("\\/", "/")

        # Lọc lấy đúng link TikTok
        urls = re.findall(r"(https?://(?:vt\.|www\.)?tiktok\.com/[^\s/]+/?|https?://[^\s]+)", clipboard)
        if not urls:
            logger.warning("Thất bại: Không tìm thấy link TikTok trong clipboard. Sample: %s", res_cmd[:100])
            return False

        video_url = await _resolve_short_url(urls[0].strip())
        logger.info("Đã trích xuất và resolve link: %s", video_url)

        # Gửi lên Dashboard
        payload_dashboard = {
            "video_url": video_url,
            "caption": "",
            "keywords": [keyword] if keyword else [],
            "status": "pending",
        }
        dashboard_url = f"{_api_base()}/api/tiktok/"
        ext_api_key = os.getenv("TIKTOK_EXT_API_KEY") or os.getenv("TIKTOK_API_KEY")
        headers = {
            "Authorization": f"Api-Key {ext_api_key}",
            "Content-Type": "application/json",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(dashboard_url, json=payload_dashboard, headers=headers, timeout=30) as resp:
                status = resp.status

        logger.info("Đã đồng bộ link lên Dashboard. Status code: %s", status)
        return status in [200, 201]
    except Exception as e:
        logger.error("Lỗi khi chạy hậu xử lý đồng bộ link: %s", e)
        return False


# Whitelist resource IDs
_USERNAME_RIDS = ["title"]
_COMMENT_RIDS = ["eim", "eio", "emz"]  # giữ lại để fallback nếu cần

# Pattern lọc textview không phải comment (dùng cho block-title approach)
_DATE_RE = re.compile(r'^[·\s]*\d{2,4}-\d{2}(-\d{2})?$|^\d+ (ngày|phút|giờ|tuần|tháng|giây|năm)')
_NON_COMMENT_PREFIXES = ("·", "tác giả", "tìm kiếm", "thêm bình luận")


def _resolve_search_name(search_username: str) -> str:
    """Phân giải tên hiển thị qua tag_mapping.yaml, bỏ @ prefix.

    VD: "bác sĩ Hoàng" → resolve → "@Bs Hoàng" → bỏ @ → "Bs Hoàng"
    Fallback: nếu không có trong mapping → dùng trực tiếp search_username.
    """
    resolved = resolve_tag_username(tag_display_name=search_username)
    if resolved:
        return resolved.lstrip("@")
    return search_username


# Regex bắt quoted string: cả ngoặc kép thường "..." và smart quotes “...”
_QUOTED_RE = re.compile(r'["“”]([^"“”]+)["“”]')


def _expand_tag_mentions(keyword: str) -> str:
    """Thành phần tên trong ngoặc kép → @username từ tag_mapping.

    VD: '...bên "BS A" rồi...' → '...bên @BS A review rồi...'
    Nếu tên không có trong mapping thì giữ nguyên ngoặc kép.
    """
    def _replace(match):
        quoted = match.group(1).strip()
        resolved = resolve_tag_username(tag_display_name=quoted)
        if resolved:
            logger.info("[expand_tag_mentions] '%s' → '%s'", quoted, resolved)
            return resolved  # VD: '@BS A review'
        return match.group(0)  # giữ nguyên nếu không tìm thấy

    return _QUOTED_RE.sub(_replace, keyword)


def _collect_comment_pairs(ui_state) -> list[dict]:
    """Quét màn hình, thu thập và ghép cặp username ↔ comment theo tọa độ Y.

    Returns:
        [{"owner": ..., "text": ..., "el": element}, ...]
    """
    elements = ui_state.elements if ui_state else []

    # Bước 1: Thu thập tất cả element có index + Y, sort theo Y
    indexed = []
    for el in elements:
        idx = el.get("index")
        if idx is None:
            continue
        text = (el.get("text") or "").strip()
        if not text:  # chỉ bỏ qua text rỗng hoàn toàn, cho phép cả 1 ký tự như "."
            continue
        rid = (el.get("resourceId") or "").lower()
        cls = (el.get("className") or "").lower()
        rid_short = rid.split("/")[-1] if "/" in rid else rid
        _, ey = ui_state.get_element_coords(idx)
        indexed.append({"el": el, "text": text, "cls": cls, "rid_short": rid_short, "y": ey})

    # Sort theo Y từ trên xuống
    indexed.sort(key=lambda e: e["y"])

    # Bước 2: Tìm vị trí các anchor title (mỗi title = đầu 1 block comment)
    title_positions = [i for i, e in enumerate(indexed) if e["rid_short"] == "title"]
    if not title_positions:
        return []

    # Bước 3: Duyệt từng block, tìm textview comment đầu tiên
    pairs = []
    for block_num, start in enumerate(title_positions):
        owner_text = indexed[start]["text"]
        end = title_positions[block_num + 1] if block_num + 1 < len(title_positions) else len(indexed)
        block_elements = indexed[start + 1: end]

        for entry in block_elements:
            if entry["cls"] != "textview":
                continue
            if entry["text"].lower().startswith(_NON_COMMENT_PREFIXES):
                continue
            if _DATE_RE.match(entry["text"]):
                continue
            # Đây là comment của block này
            pairs.append({"owner": owner_text, "text": entry["text"], "el": entry["el"]})
            logger.info("[GHÉP CẶP] owner=%r → comment=%r", owner_text, entry["text"])
            break

    return pairs


async def _read_clipboard(ctx) -> str:
    """Đọc clipboard qua portal app."""
    try:
        portal_cmd = "content query --uri content://com.mobilerun.portal/getclipboard"
        res_portal = await ctx.driver.device.shell(portal_cmd)
        if "result=" in res_portal:
            import json
            json_start = res_portal.find("{")
            if json_start >= 0:
                data = json.loads(res_portal[json_start:])
                if data.get("status") == "success":
                    return data.get("result", "")
    except Exception:
        pass
    return ""


async def _copy_comment_by_element(el, ui_state, ctx) -> dict:
    """Long-press comment → copy text + copy link.

    Flow:
      1. Long-press → Tap "Sao chép" → parse clipboard → profile_username + comment_content
      2. Long-press → Tap "Chia sẻ với" → Tap "Sao chép liên kết" → comment_link

    Returns:
        {"profile_username": ..., "comment_content": ..., "comment_link": ..., "raw": ...}
        Hoặc {} nếu thất bại.
    """
    idx = el.get("index")
    if idx is None:
        return {}

    x, y = ui_state.get_element_coords(idx)
    text_preview = (el.get("text") or "")[:30]

    # Tính tọa độ tap an toàn: góc trên-trái comment, dưới avatar
    bounds_str = el.get("bounds", "")
    if bounds_str:
        try:
            left, top, right, bottom = map(int, bounds_str.split(","))
            visible_height = bottom - top

            # Nếu comment mới nhô ra ít (< 100px), cuộn thêm nhẹ để hiện đầy đủ
            if visible_height < 100:
                logger.info(
                    "[copy_comment] Comment chưa hiện đủ (height=%dpx < 100), cuộn nhẹ thêm...",
                    visible_height,
                )
                # Cuộn nhẹ 200px — vừa đủ để comment hiện ra, không quá đà
                await ctx.driver.swipe(360, 1400, 360, 1200, 500)
                await asyncio.sleep(1.5)

                # Re-scan UI để lấy bounds mới
                target_text = (el.get("text") or "").strip()
                found_after_scroll = False

                ui_state_new = await ctx.state_provider.get_state()
                if ui_state_new:
                    for new_el in (ui_state_new.elements or []):
                        if (new_el.get("text") or "").strip() == target_text:
                            new_bounds = new_el.get("bounds", "")
                            if new_bounds:
                                left, top, right, bottom = map(int, new_bounds.split(","))
                                bounds_str = new_bounds
                                found_after_scroll = True
                                logger.info("[copy_comment] Re-scan OK: %s (height=%d)", new_bounds, bottom - top)
                            break

                # Nếu cuộn quá đà → comment biến mất → cuộn ngược lại 150px
                if not found_after_scroll:
                    logger.warning("[copy_comment] ⚠️ Cuộn quá đà, comment mất — cuộn ngược lại...")
                    await ctx.driver.swipe(360, 1200, 360, 1350, 500)
                    await asyncio.sleep(1.5)
                    ui_state_new2 = await ctx.state_provider.get_state()
                    if ui_state_new2:
                        for new_el in (ui_state_new2.elements or []):
                            if (new_el.get("text") or "").strip() == target_text:
                                new_bounds = new_el.get("bounds", "")
                                if new_bounds:
                                    left, top, right, bottom = map(int, new_bounds.split(","))
                                    bounds_str = new_bounds
                                    logger.info("[copy_comment] Cuộn ngược OK: %s (height=%d)", new_bounds, bottom - top)
                                break

            tap_x = left               # ngoài cùng bên trái, ngay dưới avatar
            tap_y = top + 10           # vừa vào dòng đầu tiên của comment
            logger.info("[copy_comment] Safe tap: bounds=%s → (%d, %d) (left, top+10)", bounds_str, tap_x, tap_y)
        except (ValueError, TypeError):
            tap_x, tap_y = x, y  # fallback về center nếu parse lỗi
    else:
        tap_x, tap_y = x, y  # fallback về center nếu không có bounds

    # ── Bước 1: Long-press → "Sao chép" → lấy text (retry tối đa 2 lần) ─────
    raw_clipboard = ""
    for attempt in range(1, 3):  # thử lần 1 và lần 2
        logger.info("[copy_comment] Bước 1 (lần %d): Long-press (%d, %d) — %s", attempt, tap_x, tap_y, text_preview)
        await ctx.driver.swipe(tap_x, tap_y, tap_x, tap_y, 1500)
        await asyncio.sleep(2.5)  # chờ lâu hơn để menu hiện ra

        ui_menu = await ctx.state_provider.get_state()
        menu_elements = ui_menu.elements if ui_menu else []
        copy_el = _find_element_by_keywords(menu_elements, "sao chép", "copy", "Copy", "Sao chép")

        if not copy_el:
            logger.info("[copy_comment] ❌ Không thấy menu 'Sao chép' (lần %d) — nhấn back", attempt)
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.5)
            continue

        logger.info("[copy_comment] Tap 'Sao chép' (lần %d)...", attempt)
        c_idx = copy_el.get("index")
        cx, cy = ui_menu.get_element_coords(c_idx)
        await ctx.driver.tap(cx, cy)
        await asyncio.sleep(3.0)  # chờ lâu hơn để clipboard ghi xong

        raw_clipboard = await _read_clipboard(ctx)
        if raw_clipboard:
            break  # thành công, thoát vòng retry
        logger.warning("[copy_comment] ⚠️ Clipboard rỗng (lần %d), thử lại...", attempt)

    if not raw_clipboard:
        logger.warning("[copy_comment] ⚠️ Clipboard vẫn rỗng sau 2 lần thử")
        return {}


    logger.info("[copy_comment] ✅ Clipboard text: %s", raw_clipboard[:60])

    # Parse: "@username:comment content" → tách username + content
    profile_username = ""
    comment_content = raw_clipboard
    if raw_clipboard.startswith("@"):
        # Tìm dấu ":" đầu tiên sau @
        colon_idx = raw_clipboard.find(":", 1)
        if colon_idx > 0:
            profile_username = raw_clipboard[1:colon_idx].strip()
            comment_content = raw_clipboard[colon_idx + 1:].strip()

    logger.info("[copy_comment] Parse → user=%r content=%r", profile_username[:30], comment_content[:40])

    # Chờ 15s để toast clipboard biến mất trước khi long-press lần 2
    logger.info("[copy_comment] Đợi 15s để toast clipboard biến mất...")
    await asyncio.sleep(15.0)

    # ── Bước 2: Long-press → "Chia sẻ với" → "Sao chép liên kết" (retry 3 lần)
    comment_link = ""
    for attempt in range(1, 4):
        logger.info("[copy_comment] Bước 2 (lần %d/3): Long-press để lấy comment link", attempt)
        await ctx.driver.swipe(tap_x, tap_y, tap_x, tap_y, 1500)
        await asyncio.sleep(2.0)

        ui_menu2 = await ctx.state_provider.get_state()
        menu_elements2 = ui_menu2.elements if ui_menu2 else []
        share_el = _find_element_by_keywords(
            menu_elements2, "chia sẻ với", "Chia sẻ với", "Share with", "share with"
        )

        if not share_el:
            logger.warning("[copy_comment] ⚠️ Không thấy 'Chia sẻ với' — thử lại")
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.0)
            continue

        s_idx = share_el.get("index")
        sx, sy = ui_menu2.get_element_coords(s_idx)
        logger.info("[copy_comment] Tap 'Chia sẻ với' tại (%d, %d)", sx, sy)
        await ctx.driver.tap(sx, sy)
        await asyncio.sleep(2.0)

        # Tìm "Sao chép liên kết"
        ui_menu3 = await ctx.state_provider.get_state()
        menu_elements3 = ui_menu3.elements if ui_menu3 else []
        copy_link_el = _find_element_by_keywords(
            menu_elements3,
            "sao chép liên kết", "Sao chép liên kết",
            "copy link", "Copy link", "Copy Link",
        )

        if not copy_link_el:
            logger.warning("[copy_comment] ⚠️ Không thấy 'Sao chép liên kết' — thử lại")
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.0)
            continue

        cl_idx = copy_link_el.get("index")
        clx, cly = ui_menu3.get_element_coords(cl_idx)
        logger.info("[copy_comment] Tap 'Sao chép liên kết' tại (%d, %d)", clx, cly)
        await ctx.driver.tap(clx, cly)
        await asyncio.sleep(2.0)

        link_clipboard = await _read_clipboard(ctx)

        # Kiểm tra: clipboard phải là URL (chứa http)
        if link_clipboard and "http" in link_clipboard.lower():
            comment_link = link_clipboard
            logger.info("[copy_comment] ✅ Comment link (lần %d): %s", attempt, comment_link[:80])
            break
        else:
            logger.warning(
                "[copy_comment] ⚠️ Clipboard không phải URL (lần %d): %s — thử lại",
                attempt, link_clipboard[:60] if link_clipboard else "(rỗng)",
            )

    if not comment_link:
        logger.warning("[copy_comment] ❌ Không lấy được comment link sau 3 lần thử")

    return {
        "profile_username": profile_username,
        "comment_content": comment_content,
        "comment_link": comment_link,
        "raw": raw_clipboard,
    }


async def tiktok_copy_video_comments(
    video_link: str = "",
    count: int = 10,
    search_username: str = "",
    search_keyword: str = "",
    *,
    ctx,
    **kwargs,
) -> str:
    """Thu thập comment từ video TikTok — hỗ trợ copy hàng loạt hoặc tìm theo mục tiêu.

    Args:
        video_link: Link video TikTok (nếu rỗng sẽ dùng payload).
        count: Số lượng comment cần lấy (mặc định 10).
        search_username: Tên hiển thị của user cần tìm (VD: "bác sĩ Hoàng").
        search_keyword: Từ khóa trong nội dung comment cần tìm.
    """
    from task_context import get_raw_context

    _raw = get_raw_context()
    _payload = _raw.get("payload") or {}
    if not video_link:
        video_link = (_payload.get("video_link") or _payload.get("video_url") or "").strip()
    _comment_plan_id: int | None = _payload.get("comment_plan_id") or None

    if not video_link:
        return "Failed: Thiếu video_link. Hãy truyền tham số hoặc kiểm tra payload."

    # ── Xác định mode ────────────────────────────────────────────────────────
    mode = "find" if (search_username or search_keyword) else "bulk"
    max_swipes = 100 if mode == "find" else 15

    # Trong mode FIND, nếu count không được chỉ định rõ (vẫn là giá trị mặc định 10)
    # thì mặc định tìm 1 comment thôi — tìm thấy là dừng ngay.
    if mode == "find" and count == 10:
        count = 1

    search_name = ""
    if search_username:
        search_name = _resolve_search_name(search_username)
        logger.info("[tiktok_copy_video_comments] Resolved: '%s' → '%s'", search_username, search_name)

    logger.info(
        "[tiktok_copy_video_comments] mode=%s count=%d search_name=%r keyword=%r video=%s",
        mode, count, search_name, search_keyword, video_link[:60],
    )

    # ── Bước 1: Mở video ─────────────────────────────────────────────────────
    adb_cmd = f"am start -a android.intent.action.VIEW -d '{video_link}'"
    await ctx.driver.device.shell(adb_cmd)
    await asyncio.sleep(4.0)

    # ── Bước 2: Tap center để vào full player ────────────────────────────────
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for _line in raw_size.splitlines():
        if "size" in _line.lower():
            _parts = _line.split(":")[-1].strip().split("x")
            if len(_parts) == 2:
                try:
                    w, h = int(_parts[0]), int(_parts[1])
                except ValueError:
                    pass
            break
    await ctx.driver.tap(w // 2, h // 2)
    logger.info("[tiktok_copy_video_comments] Tap center (%d, %d)", w // 2, h // 2)
    await asyncio.sleep(1.5)

    # ── Bước 3: Guard check + mở comment section ────────────────────────────
    guard3 = screen_guard("Bình luận", "Comment", "comment")
    ok3, msg3 = await guard3(ctx)
    if not ok3:
        return f"Failed: [bước 3] Video chưa load xong hoặc màn hình sai — {msg3}"

    r_open = await open_comment_section(ctx=ctx)
    if "Failed" in r_open:
        return f"Failed: [bước 3] {r_open}"
    await asyncio.sleep(2.5)

    guard4 = screen_guard("add comment", "write a comment", "nhập bình luận", "comment_text", "Thêm bình luận", "Bình luận", "Comment")
    ok4, msg4 = await guard4(ctx)
    if not ok4:
        return f"Failed: [bước 4] Comment section chưa mở — {msg4}"

    # ── Bước 5: Vòng lặp thu thập ───────────────────────────────────────────
    collected_comments = []
    seen_texts = set()
    swipe_count = 0
    no_new_comments_streak = 0

    while len(collected_comments) < count and swipe_count < max_swipes:
        ui_state = await ctx.state_provider.get_state()
        seen_before = len(seen_texts)

        if mode == "find":
            # ── MODE FIND ────────────────────────────────────────────────────
            pairs = _collect_comment_pairs(ui_state)
            logger.info("[tiktok_copy_video_comments] Tìm thấy %d cặp (username ↔ comment)", len(pairs))

            # Check pairs cho match
            for pair in pairs:
                if pair["text"] in seen_texts:
                    continue
                seen_texts.add(pair["text"])

                # Kiểm tra điều kiện tìm kiếm
                if search_name and search_name.lower() not in pair["owner"].lower():
                    continue
                if search_keyword:
                    _norm = lambda s: re.sub(r'\s+', ' ', s).strip().lower()
                    # Expand "quoted names" → @username từ tag_mapping trước khi so sánh
                    expanded_kw = _expand_tag_mentions(search_keyword)
                    kw = _norm(expanded_kw)
                    txt = _norm(pair["text"])
                    logger.info("[kw_match] kw=%r | txt=%r", kw, txt)
                    # Match nếu thoả 1 trong 3 điều kiện:
                    # 1. Keyword (sau expand) có trong text
                    # 2. Text là prefix của keyword (TikTok cắt ngắn)
                    # 3. 40 ký tự đầu của keyword xuất hiện trong text
                    kw_prefix = kw[:40]
                    if kw not in txt and not kw.startswith(txt) and kw_prefix not in txt:
                        continue

                # Match! Copy comment + link
                logger.info(
                    "[tiktok_copy_video_comments] 🎯 Match: owner=%r text=%r",
                    pair["owner"], pair["text"],
                )
                result = await _copy_comment_by_element(pair["el"], ui_state, ctx)

                if result:
                    collected_comments.append(result)
                    seen_texts.add(result.get("raw", ""))

                    # Push lên Dashboard
                    try:
                        record_result = await record_comment_interaction(
                            ctx=ctx,
                            video_link=video_link,
                            comment_context=result["comment_content"],
                            comment_link=result.get("comment_link", ""),
                            profile_username=result.get("profile_username", ""),
                        )
                        logger.info("[tiktok_copy_video_comments] Dashboard record: %s", record_result[:])

                        # Cập nhật comment_link vào comment plan
                        if result.get("comment_link"):
                            update_result = await update_comment_plan(
                                video_link=video_link,
                                comment_link=result["comment_link"],
                                comment_plan_id=_comment_plan_id,
                            )
                            logger.info("[tiktok_copy_video_comments] Dashboard update-plan: %s", update_result[:])
                    except Exception as e:
                        logger.warning("[tiktok_copy_video_comments] Dashboard push lỗi: %s", e)

                if len(collected_comments) >= count:
                    break

            if len(collected_comments) >= count:
                break

        else:
            # ── MODE BULK: Lấy comment bất kỳ theo rid whitelist ────────────
            elements = ui_state.elements if ui_state else []
            candidates = []
            for el in elements:
                rid = (el.get("resourceId") or "").lower()
                text = (el.get("text") or "").strip()
                rid_short = rid.split("/")[-1] if "/" in rid else rid

                if rid_short not in _COMMENT_RIDS:
                    continue
                if not text or len(text) < 2:
                    continue
                candidates.append(el)

            logger.info("[tiktok_copy_video_comments] Tìm thấy %d comment (whitelist)", len(candidates))

            for el in candidates:
                text = el.get("text").strip()
                if text in seen_texts:
                    continue

                clipboard = await _copy_comment_by_element(el, ui_state, ctx)
                seen_texts.add(text)

                if clipboard and clipboard not in seen_texts:
                    collected_comments.append(clipboard)
                    seen_texts.add(clipboard)

                if len(collected_comments) >= count:
                    break

        # Kiểm tra chạm đáy (End of List)
        if len(seen_texts) == seen_before:
            no_new_comments_streak += 1
            if no_new_comments_streak >= 2:
                logger.info("[tiktok_copy_video_comments] Đã chạm đáy bình luận (không có comment mới sau 2 lần vuốt). Tự động dừng lướt.")
                break
        else:
            no_new_comments_streak = 0

        # Cuộn xuống nếu chưa đủ
        if len(collected_comments) < count:
            await ctx.driver.swipe(w // 2, int(h * 0.7), w // 2, int(h * 0.3), 500)
            swipe_count += 1
            await asyncio.sleep(2.0)
            logger.info("[tiktok_copy_video_comments] Cuộn trang (lần %d/%d)", swipe_count, max_swipes)

    # ── Đóng comment section ─────────────────────────────────────────────────
    await ctx.driver.press_button("back")

    # ── Return kết quả ───────────────────────────────────────────────────────
    result_text = "\n".join([f"- {c}" for c in collected_comments])

    if mode == "find":
        target_desc = search_name or search_keyword
        if collected_comments:
            return (
                f"✅ Tìm thấy {len(collected_comments)} comment của '{target_desc}'"
                f" (resolved từ '{search_username}'):\n{result_text}"
            )
        else:
            return (
                f"Failed: Không tìm thấy comment của '{target_desc}' sau {swipe_count} lần cuộn. "
                f"Dừng task, không tiếp tục."
            )
    else:
        if not collected_comments:
            return (
                f"Failed: Không thu thập được bình luận nào sau {swipe_count} lần cuộn. "
                f"Dừng task, không tiếp tục."
            )
        return f"Đã thu thập được {len(collected_comments)} bình luận:\n{result_text}"



def resolve_tag_username(
    tag_display_name: str = "",
    tag_username: str = "",
) -> str | None:
    """Tra cứu @username TikTok từ tên gọi thường ngày.

    Ưu tiên:
      1. ``tag_username`` nếu đã có sẵn (từ payload hoặc tham số LLM).
      2. Tra file ``tag_mapping.yaml`` bằng ``tag_display_name`` (case-insensitive).
      3. Trả về ``None`` nếu không tìm thấy.

    Returns:
        @username (str) bắt đầu bằng ``@``, hoặc ``None``.
    """
    # 1. Ưu tiên tag_username đã có sẵn
    if tag_username and tag_username.strip():
        username = tag_username.strip()
        if not username.startswith("@"):
            username = f"@{username}"
        return username

    # 2. Tra file mapping
    if not tag_display_name or not tag_display_name.strip():
        return None

    mapping_path = Path(__file__).parent / "tag_mapping.yaml"
    if not mapping_path.exists():
        logger.warning("[resolve_tag_username] File tag_mapping.yaml không tồn tại: %s", mapping_path)
        return None

    try:
        import yaml

        with open(mapping_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}

        mappings: dict = data.get("mappings") or {}
        needle = tag_display_name.strip().lower()

        # Exact match (case-insensitive)
        for display_name, username in mappings.items():
            if display_name.strip().lower() == needle:
                logger.info("[resolve_tag_username] Matched: %r → %s", tag_display_name, username)
                return username if username.startswith("@") else f"@{username}"

        logger.warning("[resolve_tag_username] Không tìm thấy mapping cho: %r", tag_display_name)
        return None

    except Exception as e:
        logger.error("[resolve_tag_username] Lỗi đọc tag_mapping.yaml: %s", e)
        return None


async def open_video_comment_and_tag(
    *,
    ctx,
    video_link: str = "",
    comment_context: str = "",
    tag_display_name: str = "",
    tag_username: str = "",
    comment_suffix: str = "",
    **kwargs,
) -> str:
    """Mở video TikTok, đăng comment có tag (@mention) một người dùng.
    
    Hỗ trợ tag linh hoạt ở bất kỳ vị trí nào bằng chiến thuật Paste 3 giai đoạn:
    Part 1 (comment_context + @) -> Part 2 (Tên tag -> Select popup) -> Part 3 (comment_suffix).

    Bước 1: Lấy các tham số từ tham số hoặc payload.
    Bước 1.5: Resolve tag_display_name → @username.
    Bước 2: Mở video bằng ADB deep link.
    Bước 2.5: Tap center màn hình để vào full player.
    Bước 3: Guard check + tap nút comment/bình luận.
    Bước 4: Paste giai đoạn 1 (context + @) và giai đoạn 2 (tên tag).
    Bước 4.5: Quét UI, tìm và tap chọn người dùng trong popup gợi ý.
    Bước 4.7: Paste giai đoạn 3 (comment_suffix - nội dung sau tag).
    Bước 5: Guard check + tap nút Post/Gửi.
    Bước 6: Đóng comment section.
    Bước 7: Ghi tương tác lên Dashboard.
    """
    from task_context import get_raw_context

    # ── Bước 1: Lấy tham số từ args hoặc payload ────────────────────────────
    if not video_link or not comment_context or (not tag_display_name and not tag_username):
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        if not video_link:
            video_link = (_payload.get("video_link") or _payload.get("video_url") or "").strip()
        if not comment_context:
            comment_context = (_payload.get("comment_context") or _payload.get("comment_content") or "").strip()
        if not tag_display_name:
            tag_display_name = _payload.get("tag_display_name", "").strip()
        if not tag_username:
            tag_username = _payload.get("tag_username", "").strip()
        if not comment_suffix:
            comment_suffix = _payload.get("comment_suffix", "").strip()

    logger.info(
        "[open_video_comment_and_tag] Bước 1: video_link=%s context_len=%d suffix_len=%d tag_display=%r",
        video_link[:80] if video_link else "", len(comment_context), len(comment_suffix), tag_display_name,
    )

    if not video_link:
        return (
            "Failed: [bước 1] Không tìm thấy 'video_link' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số video_link."
        )
    if not comment_context:
        return (
            "Failed: [bước 1] Không tìm thấy 'comment_context' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số comment_context."
        )
    if not video_link.startswith("http"):
        return f"Failed: [bước 1] video_link không hợp lệ: {video_link[:80]}"
    if not tag_display_name and not tag_username:
        return (
            "Failed: [bước 1] Không tìm thấy 'tag_display_name' hoặc 'tag_username' — "
            "không biết tag ai. Hãy gọi lại tool với tham số tag_display_name hoặc tag_username."
        )

    # ── Bước 1.5: Resolve @username ──────────────────────────────────────────
    resolved_username = resolve_tag_username(tag_display_name, tag_username)
    if not resolved_username:
        return (
            f"Failed: [bước 1.5] Không thể resolve @username cho '{tag_display_name or tag_username}'. "
            "Kiểm tra lại tag_mapping.yaml hoặc truyền tag_username trực tiếp (VD: '@bacsitiendat')."
        )
    logger.info("[open_video_comment_and_tag] Bước 1.5: Resolved → %s", resolved_username)

    # ── Bước 2: Mở video TikTok bằng ADB deep link ──────────────────────────
    adb_cmd = f"am start -a android.intent.action.VIEW -d '{video_link}'"
    logger.info("[open_video_comment_and_tag] Bước 2: %s", adb_cmd)
    try:
        result = await ctx.driver.device.shell(adb_cmd)
        logger.info("[open_video_comment_and_tag] Bước 2 kết quả: %s", result.strip()[:120])
    except Exception as e:
        return f"Failed: [bước 2] ADB deep link lỗi — {e}"

    await asyncio.sleep(10.0)

    # ── Bước 2.5: Tap trung tâm màn hình để vào full player ─────────────────
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for _line in raw_size.splitlines():
        if "size" in _line.lower():
            _parts = _line.split(":")[-1].strip().split("x")
            if len(_parts) == 2:
                try:
                    w, h = int(_parts[0]), int(_parts[1])
                except ValueError:
                    pass
            break
    await ctx.driver.tap(w // 2, h // 2)
    logger.info("[open_video_comment_and_tag] Bước 2.5: Tap center (%d, %d)", w // 2, h // 2)
    await asyncio.sleep(1.5)

    # ── Bước 3: Guard check video + tap nút comment ──────────────────────────
    guard3 = screen_guard("Bình luận", "Comment", "comment")
    ok3, msg3 = await guard3(ctx)
    if not ok3:
        return f"Failed: [bước 3] Video chưa load xong hoặc màn hình sai — {msg3}"
    logger.info("[open_video_comment_and_tag] Bước 3: Screen guard passed, gọi open_comment_section")
    r3 = await open_comment_section(ctx=ctx)
    logger.info("[open_video_comment_and_tag] Bước 3 kết quả: %s", r3)
    if "Failed" in r3:
        return f"Failed: [bước 3] {r3}"
    await asyncio.sleep(5.0)

    # ── Bước 4: Tách comment thành 2 phần và nhập (để kích hoạt popup) ────────
    # Xử lý chuỗi tag
    tag_text = resolved_username.replace("@", "")
    # Cắt bỏ 15% độ dài cuối cùng (hoặc ít nhất 1 ký tự) để paste lần 2
    cut_len = max(1, int(len(tag_text) * 0.15))
    partial_tag = tag_text[:-cut_len]

    # Phần 1: Nội dung + " @"
    part1_text = f"{comment_context} @"

    guard4 = screen_guard("add comment", "write a comment", "nhập bình luận", "comment_text", "Thêm bình luận")
    ok4, msg4 = await guard4(ctx)
    if not ok4:
        return f"Failed: [bước 4] Comment section chưa mở — {msg4}"

    logger.info("[open_video_comment_and_tag] Bước 4: Paste lần 1: %r", part1_text)
    r4_1 = await type_comment(text=part1_text, ctx=ctx)
    if "Failed" in r4_1:
        return f"Failed: [bước 4] Lỗi paste lần 1 — {r4_1}"

    await asyncio.sleep(5.0)

    logger.info("[open_video_comment_and_tag] Bước 4: Paste lần 2: %r", partial_tag)
    # Gửi text trực tiếp thay vì tap lại làm mất con trỏ
    await ctx.driver.input_text(partial_tag)

    # ── Bước 4.5: Chờ popup xuất hiện, lấy tọa độ động và tìm người ──────────
    await asyncio.sleep(3.0)

    # Lấy width/height để dùng cho swipe động
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for _line in raw_size.splitlines():
        if "size" in _line.lower():
            _parts = _line.split(":")[-1].strip().split("x")
            if len(_parts) == 2:
                try:
                    w, h = int(_parts[0]), int(_parts[1])
                except ValueError:
                    pass
            break

    clean_username = tag_text.lstrip("@").replace("\n", " ").strip().lower()
    clean_display_name = tag_display_name.replace("\n", " ").strip().lower() if tag_display_name else ""

    def _find_target_in_popup(elements_list):
        # Ưu tiên 1: Tìm theo resource ID chính xác (id/ns2)
        for el in elements_list:
            rid = el.get("resourceId") or ""
            if "id/ns2" in rid:
                text = (el.get("text") or "").lower()
                desc = (el.get("content_desc") or "").lower()
                combined_text = f"{text} {desc}"
                if clean_username in combined_text or (clean_display_name and clean_display_name in combined_text):
                    return el.get("index")
        
        # Ưu tiên 2: Fallback tìm theo text (bỏ qua EditText để tránh click nhầm ô comment)
        for el in elements_list:
            if el.get("className") == "android.widget.EditText":
                continue
            text = (el.get("text") or "").lower()
            desc = (el.get("content_desc") or "").lower()
            combined_text = f"{text} {desc}"
            # Chỉ khớp khi text CHÍNH XÁC bằng tên tag (tránh khớp nhầm vào comment dài chứa tên tag)
            if text == clean_username or (clean_display_name and text == clean_display_name):
                return el.get("index")
        return None

    # [Phase 1] Quét lần 1
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []
    selected_idx = _find_target_in_popup(elements)

    if selected_idx is not None:
        x, y = ui_state.get_element_coords(selected_idx)
        logger.info("[open_video_comment_and_tag] Phase 1: Tìm thấy tag %r ngay lần đầu. Tapping...", resolved_username)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)
    else:
        # [Phase 2] Xóa lùi cả chữ và @ rồi gõ lại @
        logger.info("[open_video_comment_and_tag] Phase 2: Không thấy %r. Xóa lùi cả dấu @...", resolved_username)
        # partial_tag là phần text không chứa '@', xóa len(partial_tag) + 1 lần để bay luôn '@'
        for _ in range(len(partial_tag) + 1):
            await ctx.driver.device.shell("input keyevent 67") # KEYCODE_DEL
            await asyncio.sleep(0.05)
            
        await asyncio.sleep(1.0)
        await ctx.driver.input_text("@") # Ép TikTok bật lại popup
        await asyncio.sleep(2.0) # Đợi gợi ý tổng load lại
        
        # [Phase 3] Lặp quét và vuốt
        max_swipes = 5
        found = False
        for i in range(max_swipes):
            ui_state = await ctx.state_provider.get_state()
            elements = ui_state.elements if ui_state else []
            selected_idx = _find_target_in_popup(elements)
            
            if selected_idx is not None:
                x, y = ui_state.get_element_coords(selected_idx)
                logger.info("[open_video_comment_and_tag] Phase 3: Tìm thấy tag %r sau %d lần cuộn. Tapping...", resolved_username, i)
                await ctx.driver.tap(x, y)
                await asyncio.sleep(2.0)
                found = True
                break
                
            logger.info("[open_video_comment_and_tag] Phase 3: Cuộn danh sách tìm %r (lần %d/%d)...", resolved_username, i + 1, max_swipes)
            await ctx.driver.swipe(w // 2, int(h * 0.45), w // 2, int(h * 0.25), 500)
            await asyncio.sleep(2.0)
            
        # [Phase 4] Vẫn thất bại
        if not found:
            logger.warning("[open_video_comment_and_tag] Phase 4: Hoàn toàn không tìm thấy %r, thoát popup bằng phím Space.", resolved_username)
            await ctx.driver.input_text(" ")
            await asyncio.sleep(1.0)

    # ── Bước 4.7: Nhập nội dung sau tag (comment_suffix) ──────────────────────
    if comment_suffix:
        logger.info("[open_video_comment_and_tag] Bước 4.7: Nhập nội dung sau tag: %r", comment_suffix)
        await ctx.driver.input_text(comment_suffix)
        await asyncio.sleep(0.5)

    # ── Bước 5: Guard check nút Post + đăng comment ──────────────────────────
    guard5 = screen_guard("post", "send", "đăng", "gửi", "Đăng", "Post")
    ok5, msg5 = await guard5(ctx)
    if not ok5:
        logger.warning("[open_video_comment_and_tag] Bước 5: guard fail (%s) — có thể là icon, vẫn thử post_comment", msg5)
    
    r5 = await post_comment(ctx=ctx)
    logger.info("[open_video_comment_and_tag] Bước 5 kết quả: %s", r5)
    if "Failed" in r5:
        return f"Failed: [bước 5] {r5}. Tip: Nút 'Đăng' có thể không có chữ mà là một ICON (hình mũi tên hoặc máy bay giấy)."
    await asyncio.sleep(1.5)

    # ── Bước 6: Đóng comment section bằng Back ───────────────────────────────
    await ctx.driver.press_button("back")
    await asyncio.sleep(0.5)

    # ── Bước 7: Ghi lại tương tác lên Dashboard ─────────────────────────────
    logger.info("[open_video_comment_and_tag] Bước 7: Ghi tương tác lên Dashboard")
    final_comment = f"{comment_context} @{tag_text} {comment_suffix}".strip()
    record_result = await record_comment_interaction(ctx=ctx, video_link=video_link, comment_context=final_comment)
    logger.info("[open_video_comment_and_tag] Bước 7 kết quả: %s", record_result[:120])

    logger.info(
        "[open_video_comment_and_tag] Hoàn thành — comment+tag đã đăng lên %s (tag: %s)",
        video_link[:80], resolved_username,
    )
    return (
        f"Comment+Tag đã đăng thành công lên video {video_link[:80]!r}: "
        f"{final_comment[:80]!r} (tag: {resolved_username}) | {record_result}"
    )


async def reply_to_comment(
    *,
    ctx,
    comment_link: str = "",
    reply_text: str = "",
    tag_display_name: str = "",
    tag_username: str = "",
    comment_suffix: str = "",
    **kwargs,
) -> str:
    """Mở một comment TikTok cụ thể và reply vào đó.

    Bước 1: Lấy comment_link + reply_text (+ tag nếu có) — ưu tiên tham số, fallback sang payload.
    Bước 1.5: Nếu có tag → resolve tag_display_name → @username.
    Bước 2: Mở comment_link bằng ADB deep link → TikTok tự mở comment section và scroll đến comment target.
    Bước 3: Tìm "Trả lời" / "Reply" đầu tiên → tap → reply box mở với "@author " pre-filled.
    Bước 4a (không tag): input_text(reply_text) trực tiếp.
    Bước 4b (có tag): logic 3 giai đoạn — gõ reply_text + @, gõ partial tên, tap popup suggest, gõ suffix.
    Bước 5: post_comment() → Back → record_comment_interaction().
    """
    from urllib.parse import urlparse, urlunparse
    from task_context import get_raw_context

    # ── Bước 1: Lấy tham số ─────────────────────────────────────────────────
    if not comment_link or not reply_text or not tag_display_name and not tag_username:
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        if not comment_link:
            comment_link = _payload.get("comment_link", "").strip()
        if not reply_text:
            reply_text = _payload.get("reply_text", "").strip()
        if not tag_display_name:
            tag_display_name = _payload.get("tag_display_name", "").strip()
        if not tag_username:
            tag_username = _payload.get("tag_username", "").strip()
        if not comment_suffix:
            comment_suffix = _payload.get("comment_suffix", "").strip()

    logger.info(
        "[reply_to_comment] Bước 1: comment_link=%s reply_len=%d tag_display=%r",
        comment_link[:80], len(reply_text), tag_display_name,
    )

    if not comment_link:
        return (
            "Failed: [bước 1] Không tìm thấy 'comment_link' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số comment_link."
        )
    if not reply_text:
        return (
            "Failed: [bước 1] Không tìm thấy 'reply_text' — không có trong tham số lẫn payload. "
            "Hãy gọi lại tool với tham số reply_text."
        )
    if not comment_link.startswith("http"):
        return f"Failed: [bước 1] comment_link không hợp lệ: {comment_link[:80]}"

    # ── Bước 1.5: Resolve tag nếu có ────────────────────────────────────────
    has_tag = bool(tag_display_name or tag_username)
    resolved_username = ""
    if has_tag:
        resolved_username = resolve_tag_username(tag_display_name, tag_username)
        if not resolved_username:
            return (
                f"Failed: [bước 1.5] Không thể resolve @username cho '{tag_display_name or tag_username}'. "
                "Kiểm tra lại tag_mapping.yaml hoặc truyền tag_username trực tiếp (VD: '@bacsitiendat')."
            )
        logger.info("[reply_to_comment] Bước 1.5: Resolved → %s", resolved_username)
        # Auto-split: nếu LLM nhồi toàn bộ text vào reply_text (kể cả tên tag + suffix),
        # tìm pattern "tag? "NAME"" trong reply_text và tách thành pre / suffix đúng.
        _tag_name = (tag_display_name or tag_username.lstrip("@")).strip()
        if _tag_name and _tag_name.lower() in reply_text.lower():
            import re as _re3
            _escaped = _re3.escape(_tag_name)
            # Tìm: (từ "tag" tuỳ chọn) + khoảng trắng + quote tuỳ chọn + tên tag + quote tuỳ chọn
            _pat = _re3.compile(
                r'(\s*\btag\b\s*)?["\']?' + _escaped + r'["\']?',
                _re3.IGNORECASE,
            )
            _m = _pat.search(reply_text)
            if _m:
                _pre = reply_text[:_m.start()].rstrip()
                _post = reply_text[_m.end():].lstrip()
                # Chỉ split nếu có text sau tên tag (tức là LLM đã nhồi suffix vào)
                if _post:
                    if not comment_suffix:
                        comment_suffix = _post
                    else:
                        comment_suffix = _post + " " + comment_suffix
                    reply_text = _pre
                    logger.info(
                        "[reply_to_comment] Bước 1.5: Auto-split reply_text → pre=%r suffix=%r",
                        reply_text, comment_suffix,
                    )
                elif _m.start() > 0:
                    # Không có suffix nhưng có "tag NAME" ở cuối → strip phần đó
                    reply_text = _pre
                    logger.info(
                        "[reply_to_comment] Bước 1.5: Strip tag name cuối reply_text → %r", reply_text
                    )

    # Trích video_link từ comment_link: strip query params rồi resolve về canonical URL
    _parsed = urlparse(comment_link)
    _stripped = urlunparse(_parsed._replace(query="", fragment=""))
    video_link = await _resolve_short_url(_stripped)

    # ── Bước 2: Mở comment_link bằng ADB deep link ──────────────────────────
    adb_cmd = f"am start -a android.intent.action.VIEW -d '{comment_link}'"
    logger.info("[reply_to_comment] Bước 2: %s", adb_cmd)
    try:
        result = await ctx.driver.device.shell(adb_cmd)
        logger.info("[reply_to_comment] Bước 2 kết quả: %s", result.strip()[:120])
    except Exception as e:
        return f"Failed: [bước 2] ADB deep link lỗi — {e}"

    # TikTok tự mở comment section + scroll đến comment target
    await asyncio.sleep(6.0)

    # ── Bước 2.5: Like comment ngay sau khi mở link ─────────────────────────
    # Tìm "Trả lời" để xác định row Y, scan bên phải → loại "Tán thành" → tap Button đầu tiên còn lại.
    def _parse_bounds_like(el):
        import re as _re4
        m = _re4.findall(r"\d+", el.get("bounds", ""))
        return (int(m[0]), int(m[1]), int(m[2]), int(m[3])) if len(m) == 4 else None

    ui_like = await ctx.state_provider.get_state()
    els_like = ui_like.elements if ui_like else []
    reply_el_pre = _find_element_by_keywords(els_like, "trả lời", "reply")
    if reply_el_pre is not None:
        rb = _parse_bounds_like(reply_el_pre)
        if rb:
            _, ry1, rx2, ry2 = rb
            row_mid = (ry1 + ry2) // 2
            cands = []
            for el in els_like:
                b = _parse_bounds_like(el)
                if b is None:
                    continue
                ex1, ey1, _, ey2 = b
                if abs((ey1 + ey2) // 2 - row_mid) <= 30 and ex1 > rx2:
                    cands.append((ex1, el))
            cands.sort(key=lambda t: t[0])
            like_el = None
            for _, el in cands:
                el_text = (el.get("text") or "").strip().lower()
                el_desc = (el.get("content-desc") or el.get("content_desc") or "").strip().lower()
                if "tán thành" in el_text or "tán thành" in el_desc:
                    continue
                like_el = el
                break
            if like_el is not None:
                like_idx = like_el.get("index")
                if like_idx is not None:
                    lx, ly = ui_like.get_element_coords(like_idx)
                    await ctx.driver.tap(lx, ly)
                    logger.info("[reply_to_comment] Bước 2.5: Đã tap like tại (%d, %d)", lx, ly)
                    await asyncio.sleep(1.5)
                else:
                    logger.warning("[reply_to_comment] Bước 2.5: like element không có index — bỏ qua")
            else:
                logger.warning("[reply_to_comment] Bước 2.5: Không tìm thấy like button — bỏ qua")
    else:
        logger.warning("[reply_to_comment] Bước 2.5: Không tìm thấy 'Trả lời' — bỏ qua like")

    # ── Bước 3: Tìm "Trả lời" → tap ────────────────────────────────────────
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []

    reply_el = _find_element_by_keywords(elements, "trả lời", "reply")
    if reply_el is None:
        return (
            "Failed: [bước 3] Không tìm thấy nút 'Trả lời' / 'Reply' trong comment section. "
            "Có thể TikTok chưa scroll đến comment target — thử lại sau 3s."
        )

    idx = reply_el.get("index")
    if idx is None:
        return "Failed: [bước 3] Reply element không có index."

    x, y = ui_state.get_element_coords(idx)
    await ctx.driver.tap(x, y)
    logger.info("[reply_to_comment] Bước 3: Đã tap 'Trả lời' tại (%d, %d)", x, y)
    await asyncio.sleep(2.0)

    # ── Bước 4: Nhập reply text — reply box đã auto-focus sau khi tap "Trả lời" ─
    if not has_tag:
        # Không có tag — gõ thẳng
        try:
            await ctx.driver.input_text(reply_text)
            r5 = f"Typed reply: {reply_text[:80]}"
        except Exception as e:
            r5 = f"Failed: Error typing reply — {e}"
        logger.info("[reply_to_comment] Bước 4 kết quả: %s", r5[:80])
        if "Failed" in r5:
            return f"Failed: [bước 4] {r5}"
    else:
        # Có tag — logic 3 giai đoạn (giống open_video_comment_and_tag)
        tag_text = resolved_username.replace("@", "")
        cut_len = max(1, int(len(tag_text) * 0.15))
        partial_tag = tag_text[:-cut_len]

        # Lấy kích thước màn hình cho swipe popup
        raw_size = await ctx.driver.device.shell("wm size")
        sw, sh = 1080, 2400
        for _line in raw_size.splitlines():
            if "size" in _line.lower():
                _parts = _line.split(":")[-1].strip().split("x")
                if len(_parts) == 2:
                    try:
                        sw, sh = int(_parts[0]), int(_parts[1])
                    except ValueError:
                        pass
                break

        clean_username = tag_text.lstrip("@").replace("\n", " ").strip().lower()
        clean_display = tag_display_name.replace("\n", " ").strip().lower() if tag_display_name else ""

        def _find_tag_in_popup(els):
            for el in els:
                rid = el.get("resourceId") or ""
                if "id/ns2" in rid:
                    text = (el.get("text") or "").lower()
                    desc = (el.get("content_desc") or "").lower()
                    combined = f"{text} {desc}"
                    if clean_username in combined or (clean_display and clean_display in combined):
                        return el.get("index")
            for el in els:
                if el.get("className") == "android.widget.EditText":
                    continue
                text = (el.get("text") or "").lower()
                if text == clean_username or (clean_display and text == clean_display):
                    return el.get("index")
            return None

        # Part 1: gõ reply_text + " @" vào reply box đã focused
        part1 = f"{reply_text} @"
        logger.info("[reply_to_comment] Bước 4 tag - Part 1: %r", part1)
        await ctx.driver.input_text(part1)
        await asyncio.sleep(5.0)

        # Part 2: gõ partial tên tag → trigger popup suggest
        logger.info("[reply_to_comment] Bước 4 tag - Part 2: %r", partial_tag)
        await ctx.driver.input_text(partial_tag)
        await asyncio.sleep(3.0)

        # Phase 1: quét popup ngay lần đầu
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        selected_idx = _find_tag_in_popup(elements)

        if selected_idx is not None:
            px, py = ui_state.get_element_coords(selected_idx)
            logger.info("[reply_to_comment] Bước 4 tag - Phase 1: Tìm thấy %r, tapping...", resolved_username)
            await ctx.driver.tap(px, py)
            await asyncio.sleep(2.0)
        else:
            # Phase 2: xóa lùi rồi gõ lại @
            logger.info("[reply_to_comment] Bước 4 tag - Phase 2: Xóa lùi %d ký tự...", len(partial_tag) + 1)
            for _ in range(len(partial_tag) + 1):
                await ctx.driver.device.shell("input keyevent 67")
                await asyncio.sleep(0.05)
            await asyncio.sleep(1.0)
            await ctx.driver.input_text("@")
            await asyncio.sleep(2.0)

            # Phase 3: cuộn popup tìm
            found = False
            for i in range(5):
                ui_state = await ctx.state_provider.get_state()
                elements = ui_state.elements if ui_state else []
                selected_idx = _find_tag_in_popup(elements)
                if selected_idx is not None:
                    px, py = ui_state.get_element_coords(selected_idx)
                    logger.info("[reply_to_comment] Bước 4 tag - Phase 3: Tìm thấy %r sau %d lần cuộn.", resolved_username, i)
                    await ctx.driver.tap(px, py)
                    await asyncio.sleep(2.0)
                    found = True
                    break
                logger.info("[reply_to_comment] Bước 4 tag - Phase 3: Cuộn lần %d/5...", i + 1)
                await ctx.driver.swipe(sw // 2, int(sh * 0.45), sw // 2, int(sh * 0.25), 500)
                await asyncio.sleep(2.0)

            if not found:
                logger.warning("[reply_to_comment] Bước 4 tag - Phase 4: Không tìm thấy %r, thoát popup.", resolved_username)
                await ctx.driver.input_text(" ")
                await asyncio.sleep(1.0)

        # Part 3: gõ suffix sau tag nếu có
        if comment_suffix:
            logger.info("[reply_to_comment] Bước 5 tag - Part 3: suffix %r", comment_suffix)
            await ctx.driver.input_text(comment_suffix)
            await asyncio.sleep(0.5)

        r5 = f"Typed reply+tag: {reply_text[:60]} {resolved_username}"
        logger.info("[reply_to_comment] Bước 4 kết quả: %s", r5)
    await asyncio.sleep(1.5)

    # ── Bước 5: Post → Back → Record ────────────────────────────────────────
    r6 = await post_comment(ctx=ctx)
    logger.info("[reply_to_comment] Bước 5 kết quả: %s", r6)
    if "Failed" in r6:
        return f"Failed: [bước 5] {r6}"
    await asyncio.sleep(2.0)


    if has_tag:
        tag_clean = resolved_username.replace("@", "")
        final_reply = f"{reply_text} @{tag_clean} {comment_suffix}".strip()
    else:
        final_reply = reply_text

    record_result = await record_comment_interaction(
        ctx=ctx,
        video_link=video_link,
        comment_context=final_reply,
        comment_link=comment_link,
    )
    logger.info("[reply_to_comment] Record kết quả: %s", record_result[:120])

    logger.info("[reply_to_comment] Hoàn thành — đã like + reply vào %s", comment_link[:80])
    return (
        f"Đã like và reply thành công vào comment {comment_link[:80]!r}: "
        f"{final_reply[:60]!r} | {record_result}"
    )


# ===========================================================================
# DM (Direct Message) helpers + tool — TCS-v1.5 skill
# Design ref: docs/Chatbot_Tiktok/skill_dm_reply_design.md
# ===========================================================================


def _parse_bounds_dm(el):
    """Parse `bounds="[x1,y1][x2,y2]"` → (x1, y1, x2, y2) hoặc None."""
    import re as _re
    m = _re.findall(r"\d+", el.get("bounds", "") or "")
    return (int(m[0]), int(m[1]), int(m[2]), int(m[3])) if len(m) == 4 else None


def _has_unicode_emoji(text: str) -> bool:
    """Detect text có chứa ký tự ngoài BMP (emoji) hoặc symbol đặc biệt."""
    if not text:
        return False
    for ch in text:
        cp = ord(ch)
        # Emoji ranges (rough heuristic)
        if cp >= 0x1F300 or (0x2600 <= cp <= 0x27BF):
            return True
    return False


def _normalize_text(s: str) -> str:
    """Lowercase + strip + collapse whitespace cho so sánh duplicate."""
    if not s:
        return ""
    return " ".join(s.strip().lower().split())


# DM system-row labels (cần skip khi tìm conversation thật)
_DM_SYSTEM_ROW_LABELS = {
    "những follower mới",
    "hoạt động",
    "thông báo hệ thống",
    "new followers",
    "activity",
    "system notifications",
}


def _is_dm_system_row(text: str) -> bool:
    """True nếu row trong inbox là system feed, KHÔNG phải conversation cá nhân."""
    if not text:
        return False
    norm = _normalize_text(text)
    return any(label in norm for label in _DM_SYSTEM_ROW_LABELS)


def _find_inbox_tab(elements):
    """Tìm tab 'Hộp thư' ở bottom nav.

    Strategy:
    1. content_desc == "Hộp thư" / "Inbox"
    2. text == "Hộp thư" + ở nửa dưới màn hình (y > height*0.85)
    """
    candidates = []
    for el in elements or []:
        text = (el.get("text") or "").strip()
        desc = (el.get("content-desc") or "").strip()
        if text in ("Hộp thư", "Inbox") or desc in ("Hộp thư", "Inbox"):
            bounds = _parse_bounds_dm(el)
            if bounds:
                _, y1, _, y2 = bounds
                candidates.append((y1, el))
    if not candidates:
        return None
    # Bottom nav = element có y lớn nhất
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _find_conversation_row(elements, peer_handle: str):
    """Tìm conversation row trong list inbox match `peer_handle`.

    Returns: element nếu tìm thấy, None nếu chưa scroll tới.

    Strategy:
    1. Iterate TextView elements
    2. Skip system rows ("Những Follower mới", "Hoạt động", "Thông báo hệ thống")
    3. Match peer_handle:
       - Exact match nếu không có emoji
       - Partial substring match nếu có emoji unicode
    """
    has_emoji = _has_unicode_emoji(peer_handle)
    peer_norm = _normalize_text(peer_handle)

    for el in elements or []:
        text = (el.get("text") or "").strip()
        if not text or _is_dm_system_row(text):
            continue
        text_norm = _normalize_text(text)
        if has_emoji:
            # Partial match nếu có emoji
            if peer_handle in text or peer_norm in text_norm:
                return el
        else:
            # Exact or substring match
            if text == peer_handle or text_norm == peer_norm:
                return el
            # Fallback substring (vd "Test06" match trong "Test06 (online)")
            if peer_norm and peer_norm in text_norm:
                return el
    return None


def _find_dm_text_input(elements):
    """Tìm ô text input để gõ tin DM.

    Pattern: EditText với hint chứa "Nhắn tin"/"Gửi tin nhắn"/"Message"
    Hoặc bất kỳ EditText nào ở nửa dưới màn hình.
    """
    # Priority 1: hint text khớp
    for el in elements or []:
        cls = (el.get("class") or "").lower()
        text = (el.get("text") or "")
        hint = (el.get("hint") or "")
        desc = (el.get("content-desc") or "")
        combined = f"{text} {hint} {desc}".lower()
        if "edittext" in cls or el.get("focusable") == "true":
            if any(kw in combined for kw in ("nhắn tin", "gửi tin nhắn", "message", "send a message", "soạn tin")):
                return el

    # Priority 2: bất kỳ EditText nào focusable ở nửa dưới
    for el in elements or []:
        cls = (el.get("class") or "").lower()
        if "edittext" in cls:
            bounds = _parse_bounds_dm(el)
            if bounds:
                _, y1, _, _ = bounds
                # Heuristic: input bar ở 80%+ dưới màn hình
                return el
    return None


def _find_send_icon(elements):
    """Tìm icon SEND (paper plane) — chỉ xuất hiện sau khi có text trong input.

    Strategy:
    1. content_desc/resource-id chứa "send"/"gửi" (case insensitive)
    2. KHÔNG match icon micro (content_desc chứa "voice"/"record"/"ghi âm"/"micro")
    """
    EXCLUDE_KEYWORDS = ("voice", "record", "ghi âm", "ghi am", "micro", "microphone", "audio")
    for el in elements or []:
        text = (el.get("text") or "").lower()
        desc = (el.get("content-desc") or "").lower()
        rid = (el.get("resource-id") or "").lower()
        combined = f"{text} {desc} {rid}"
        # Skip nếu match micro
        if any(kw in combined for kw in EXCLUDE_KEYWORDS):
            continue
        # Match send keywords
        if any(kw in combined for kw in ("send", "gửi", "post", "đăng")):
            return el
    return None


def _extract_bot_messages_in_conv(elements, screen_width: int = 1080):
    """Extract BOT msg bubbles từ conversation detail screen.

    BOT msg align RIGHT (x > screen_width * 0.4). USER msg align LEFT.

    Returns: list of strings (texts của các bot bubbles, ordered oldest→newest).
    """
    bot_msgs = []
    for el in elements or []:
        cls = (el.get("class") or "").lower()
        if "textview" not in cls:
            continue
        text = (el.get("text") or "").strip()
        if not text:
            continue
        # Skip headers/timestamps
        if any(kw in text.lower() for kw in ("hôm nay", "hôm qua", "today", "yesterday", "sa", "ch")):
            if len(text) < 20:  # short timestamps
                continue
        bounds = _parse_bounds_dm(el)
        if not bounds:
            continue
        x1, _, x2, _ = bounds
        # Align right (BOT msg) nếu x1 > 40% screen width
        if x1 > screen_width * 0.4:
            bot_msgs.append(text)
    return bot_msgs


async def _adb_launch_tiktok(ctx) -> str:
    """Launch TikTok app via ADB am start. Returns log string."""
    package = "com.ss.android.ugc.trill"
    cmd = f"monkey -p {package} -c android.intent.category.LAUNCHER 1"
    try:
        result = await ctx.driver.device.shell(cmd)
        await asyncio.sleep(3.0)
        return f"Launched TikTok: {result.strip()[:60]}"
    except Exception as e:
        return f"Launch error: {e}"


async def send_dm(
    peer_handle: str = "",
    reply_text: str = "",
    *, ctx, **kwargs,
) -> str:
    """Gửi DM TikTok cho 1 peer cụ thể — pure-code skill (TCS-v1.5).

    Sequence 12 bước (xem skill_dm_reply_design.md §2.3 + §3.1):
      1. Lấy params từ tham số hoặc payload
      2. Launch TikTok
      3. Tap tab "Hộp thư"
      4. Scroll list, tìm conversation peer_handle
      5. Tap row → mở conversation
      6. Verify conversation opened (action bar match)
      7. Read last 3 BOT msg, check duplicate
      8. Tap text input area (TRÁNH icon micro)
      9. ADB input text reply_text
     10. Verify SEND icon xuất hiện (thay MICRO)
     11. Tap SEND
     12. Verify msg sent

    Granular log: mỗi bước push event tới `failure_log` (nếu set) → có data
    chi tiết khi task fail. Skip log nếu task success (TaskFailureLogger.discard).

    Returns:
      - "SENT_CONFIRMED: gửi DM cho {peer} thành công"
      - "SKIPPED_ALREADY_SENT: bot đã gửi tin trùng nội dung"
      - "Failed: [bước N] {reason}"
    """
    from task_context import get_failure_logger  # noqa: PLC0415
    _flog = get_failure_logger()

    def _flog_event(text: str) -> None:
        """Push event vào failure_log nếu có. No-op nếu không có context."""
        if _flog is not None:
            _flog.add_event('tool:send_dm', text)

    _flog_event(f'send_dm called peer={peer_handle!r} reply_len={len(reply_text or "")}')

    # ── Bước 1: Lấy params ──────────────────────────────────────────────────
    if not peer_handle or not reply_text:
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        if not peer_handle:
            peer_handle = (_payload.get("peer_handle") or "").strip()
        if not reply_text:
            reply_text = (_payload.get("reply_text") or "").strip()

    if not peer_handle:
        _flog_event('FAIL bước 1: peer_handle empty')
        return "Failed: [bước 1] peer_handle bị thiếu trong tham số lẫn payload"
    if not reply_text:
        _flog_event('FAIL bước 1: reply_text empty')
        return "Failed: [bước 1] reply_text bị thiếu trong tham số lẫn payload"

    logger.info(
        "[send_dm] Bước 1: peer=%r reply_len=%d", peer_handle[:40], len(reply_text),
    )
    _flog_event(f'Bước 1 OK: peer={peer_handle!r} reply_len={len(reply_text)}')

    # ── Bước 2: Launch TikTok ───────────────────────────────────────────────
    launch_log = await _adb_launch_tiktok(ctx)
    logger.info("[send_dm] Bước 2: %s", launch_log)
    _flog_event(f'Bước 2 launch: {launch_log[:120]}')

    # ── Bước 3: Tap tab "Hộp thư" ───────────────────────────────────────────
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []
    _flog_event(f'Bước 3: ui_state elements={len(elements)}')

    inbox_tab = _find_inbox_tab(elements)
    if inbox_tab is None:
        _flog_event('FAIL bước 3: inbox_tab not found')
        return "Failed: [bước 3] Không tìm thấy tab 'Hộp thư' — TikTok có thể chưa load home hoặc logged out"

    idx = inbox_tab.get("index")
    if idx is None:
        _flog_event('FAIL bước 3: inbox_tab no index')
        return "Failed: [bước 3] Hộp thư element không có index"
    tx, ty = ui_state.get_element_coords(idx)
    await ctx.driver.tap(tx, ty)
    logger.info("[send_dm] Bước 3: Tap Hộp thư tại (%d, %d)", tx, ty)
    _flog_event(f'Bước 3 OK: tap Hộp thư ({tx}, {ty})')
    await asyncio.sleep(1.5)

    # ── Bước 4: Scroll list tìm conversation ────────────────────────────────
    max_scroll_attempts = 10
    conv_el = None
    for scroll_i in range(max_scroll_attempts):
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        conv_el = _find_conversation_row(elements, peer_handle)
        if conv_el is not None:
            logger.info("[send_dm] Bước 4: Tìm thấy conversation sau %d scroll", scroll_i)
            _flog_event(f'Bước 4 OK: conv found sau {scroll_i} scroll')
            break
        _flog_event(f'Bước 4 scroll iteration {scroll_i+1}/{max_scroll_attempts} chưa thấy peer')
        try:
            screen_w = getattr(ui_state, "width", 1080) or 1080
            screen_h = getattr(ui_state, "height", 1920) or 1920
            await ctx.driver.swipe(
                int(screen_w * 0.5), int(screen_h * 0.7),
                int(screen_w * 0.5), int(screen_h * 0.3),
                duration=400,
            )
            await asyncio.sleep(0.8)
        except Exception as e:
            logger.warning("[send_dm] Bước 4: Swipe error: %s", e)
            _flog_event(f'Bước 4 swipe error: {e}')
            break

    if conv_el is None:
        _flog_event(f'FAIL bước 4: PEER_NOT_FOUND sau {max_scroll_attempts} scroll')
        return (
            f"Failed: [bước 4] PEER_NOT_FOUND — không tìm thấy conversation cho peer "
            f"{peer_handle!r} sau {max_scroll_attempts} lần scroll inbox"
        )

    # ── Bước 5: Tap conversation → mở ───────────────────────────────────────
    idx = conv_el.get("index")
    if idx is None:
        _flog_event('FAIL bước 5: conv element no index')
        return "Failed: [bước 5] Conversation element không có index"
    cx, cy = ui_state.get_element_coords(idx)
    await ctx.driver.tap(cx, cy)
    logger.info("[send_dm] Bước 5: Tap conversation tại (%d, %d)", cx, cy)
    _flog_event(f'Bước 5 OK: tap conv ({cx}, {cy})')
    await asyncio.sleep(2.0)

    # ── Bước 6: Verify conversation opened ──────────────────────────────────
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []
    screen_w = getattr(ui_state, "width", 1080) or 1080
    _flog_event(f'Bước 6: post-open ui_state elements={len(elements)}')

    in_conv = False
    for el in elements or []:
        text = (el.get("text") or "").strip()
        bounds = _parse_bounds_dm(el)
        if not bounds or not text:
            continue
        _, y1, _, _ = bounds
        if y1 < (getattr(ui_state, "height", 1920) or 1920) * 0.15:
            if _has_unicode_emoji(peer_handle):
                if peer_handle in text or _normalize_text(peer_handle) in _normalize_text(text):
                    in_conv = True
                    break
            else:
                if _normalize_text(peer_handle) in _normalize_text(text):
                    in_conv = True
                    break
    if not in_conv:
        logger.warning(
            "[send_dm] Bước 6: Không thấy peer_handle %r ở action bar — tiếp tục thận trọng",
            peer_handle[:40],
        )
        _flog_event('Bước 6 WARN: peer name không thấy ở action bar (tiếp tục)')
    else:
        _flog_event('Bước 6 OK: peer name found ở action bar')

    # ── Bước 7: Đọc 3 tin BOT cuối → check duplicate ────────────────────────
    bot_msgs = _extract_bot_messages_in_conv(elements, screen_width=screen_w)
    _flog_event(f'Bước 7: extracted {len(bot_msgs)} bot msgs')
    if bot_msgs:
        last_bot = bot_msgs[-1]
        if _normalize_text(last_bot) == _normalize_text(reply_text):
            logger.info(
                "[send_dm] Bước 7: SKIPPED_ALREADY_SENT — tin BOT cuối %r match reply_text",
                last_bot[:80],
            )
            _flog_event(f'Bước 7 SKIPPED_ALREADY_SENT: last_bot={last_bot[:80]!r}')
            return (
                f"SKIPPED_ALREADY_SENT: bot đã gửi tin trùng nội dung trước đó "
                f"({last_bot[:80]!r}) — không spam"
            )

    # ── Bước 8: Tap text input area ─────────────────────────────────────────
    input_el = _find_dm_text_input(elements)
    if input_el is None:
        _flog_event(f'FAIL bước 8: text input không tìm thấy trong {len(elements)} elements')
        return (
            "Failed: [bước 8] Không tìm thấy ô text input. "
            "Có thể UI conversation chưa load xong hoặc TikTok block messaging."
        )
    idx = input_el.get("index")
    if idx is None:
        _flog_event('FAIL bước 8: input element no index')
        return "Failed: [bước 8] Text input element không có index"
    ix, iy = ui_state.get_element_coords(idx)
    await ctx.driver.tap(ix, iy)
    logger.info("[send_dm] Bước 8: Tap text input tại (%d, %d)", ix, iy)
    _flog_event(f'Bước 8 OK: tap input ({ix}, {iy})')
    await asyncio.sleep(1.5)

    # ── Bước 9: ADB input text ──────────────────────────────────────────────
    try:
        await ctx.driver.input_text(reply_text)
        logger.info("[send_dm] Bước 9: Input text: %s", reply_text[:80])
        _flog_event(f'Bước 9 OK: input_text "{reply_text[:80]}"')
    except Exception as e:
        _flog_event(f'FAIL bước 9: ADB input_text exception {e}')
        return f"Failed: [bước 9] ADB input text lỗi — {e}"
    await asyncio.sleep(1.0)

    # ── Bước 10: Verify SEND icon xuất hiện ─────────────────────────────────
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []
    send_el = _find_send_icon(elements)
    if send_el is None:
        _flog_event(f'FAIL bước 10: send_icon không tìm thấy trong {len(elements)} elements')
        return (
            "Failed: [bước 10] SEND_ICON_NOT_VISIBLE — không tìm thấy icon Send. "
            "Có thể text input chưa nhận text, hoặc UI khác. "
            "Retry sau 1s."
        )
    _flog_event('Bước 10 OK: SEND icon found')

    # ── Bước 11: Tap SEND ───────────────────────────────────────────────────
    idx = send_el.get("index")
    if idx is None:
        _flog_event('FAIL bước 11: send element no index')
        return "Failed: [bước 11] Send element không có index"
    sx, sy = ui_state.get_element_coords(idx)
    await ctx.driver.tap(sx, sy)
    logger.info("[send_dm] Bước 11: Tap SEND tại (%d, %d)", sx, sy)
    _flog_event(f'Bước 11 OK: tap SEND ({sx}, {sy})')
    await asyncio.sleep(2.0)

    # ── Bước 12: Verify msg sent ────────────────────────────────────────────
    ui_state = await ctx.state_provider.get_state()
    elements = ui_state.elements if ui_state else []
    bot_msgs_after = _extract_bot_messages_in_conv(elements, screen_width=screen_w)
    _flog_event(f'Bước 12: post-send {len(bot_msgs_after)} bot msgs in conv')

    reply_norm = _normalize_text(reply_text)
    msg_found = False
    for msg in bot_msgs_after[-3:]:
        if _normalize_text(msg) == reply_norm or reply_norm in _normalize_text(msg):
            msg_found = True
            break

    if not msg_found:
        _flog_event(f'FAIL bước 12: MESSAGE_NOT_APPEAR (last 3 bot msgs: {[m[:50] for m in bot_msgs_after[-3:]]})')
        return (
            f"Failed: [bước 12] MESSAGE_NOT_APPEAR — gõ + tap send xong nhưng tin {reply_text[:60]!r} "
            f"chưa xuất hiện ở conversation. Có thể delay mạng — kiểm tra lại."
        )

    logger.info(
        "[send_dm] SENT_CONFIRMED: peer=%r reply_len=%d",
        peer_handle[:40], len(reply_text),
    )
    _flog_event(f'SENT_CONFIRMED: peer={peer_handle[:40]!r}')
    return (
        f"SENT_CONFIRMED: gửi DM cho {peer_handle!r} thành công với nội dung "
        f"{reply_text[:80]!r}"
    )


# ---------------------------------------------------------------------------
# Photo (image carousel) upload tools — in-app TikTok "+" upload flow
# ---------------------------------------------------------------------------

# Magic-byte signatures for the image formats TikTok accepts.
_IMAGE_MAGIC = (
    (b"\xff\xd8\xff", "jpg"),         # JPEG
    (b"\x89PNG\r\n\x1a\n", "png"),    # PNG
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _detect_image_ext(magic: bytes) -> str | None:
    """Return a file extension if *magic* matches a supported image header, else None."""
    for sig, ext in _IMAGE_MAGIC:
        if magic.startswith(sig):
            return ext
    # WEBP container: "RIFF" .... "WEBP"
    if len(magic) >= 12 and magic[:4] == b"RIFF" and magic[8:12] == b"WEBP":
        return "webp"
    return None


def _parse_str_list(value, *, sep=r"[,\n]") -> list[str]:
    """Normalise a list / separated-string argument into a clean list of strings."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items = [str(v) for v in value]
    else:
        items = re.split(sep, str(value))
    return [s.strip() for s in items if s and s.strip()]


async def _screen_size(ctx) -> tuple[int, int]:
    """Return the device screen (width, height) in pixels, defaulting to 1080x2400."""
    raw_size = await ctx.driver.device.shell("wm size")
    w, h = 1080, 2400
    for line in raw_size.splitlines():
        if "size" in line.lower():
            parts = line.split(":")[-1].strip().split("x")
            if len(parts) == 2:
                try:
                    w, h = int(parts[0]), int(parts[1])
                except ValueError:
                    pass
            break
    return w, h


async def download_images_to_device(image_urls=None, *, ctx, **kwargs) -> str:
    """Download one or more images and save them to /sdcard/DCIM/Camera/ for upload.

    Accepts *image_urls* as a list, a comma/newline-separated string, or a single
    URL.  Falls back to the task payload (image_urls / images / image_url /
    photo_url / photos) when no argument is supplied — so the LLM does not have
    to pass user-uploaded image links explicitly.

    Each image is downloaded via HTTP, validated by magic bytes
    (JPEG/PNG/WEBP/GIF), pushed to /sdcard/DCIM/Camera/image_<n>.<ext> via ADB,
    and the media scanner is notified so the files appear in the gallery picker.
    Older image_*.* files are cleared first so the newest N images on the device
    are exactly the ones just downloaded.

    Returns a success message containing the number of images saved — next open
    the file manager with ``tiktok_open_file_manager_at_images``.
    """
    import aiohttp

    urls = _parse_str_list(image_urls)
    if not urls:
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        for key in ("image_urls", "images", "image_url", "photo_url", "photos"):
            if _payload.get(key):
                urls = _parse_str_list(_payload.get(key))
                if urls:
                    break
    if not urls:
        return (
            "Failed: Không tìm thấy URL ảnh nào — không có trong tham số lẫn payload. "
            "Hãy gọi lại với tham số image_urls."
        )

    for u in urls:
        if not u.lower().startswith(("http://", "https://")):
            return f"Failed: URL ảnh phải bắt đầu bằng http:// hoặc https:// — got: {u[:60]}"

    try:
        serial: str = getattr(ctx.driver, "_serial", None) or ""
        device_dir = (
            _DOWNLOADS_DIR / re.sub(r"[^\w\-]", "_", os.path.basename(serial))
            if serial else _DOWNLOADS_DIR
        )
        device_dir.mkdir(parents=True, exist_ok=True)

        # Clear previous downloads + on-device images so the picker shows ours.
        for old in device_dir.glob("image_*.*"):
            try:
                old.unlink()
            except OSError:
                pass
        await ctx.driver.device.shell("mkdir -p /sdcard/DCIM/Camera")
        await ctx.driver.device.shell("rm -f /sdcard/DCIM/Camera/image_*")

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
            "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
            "Referer": "https://www.google.com/",
        }
        serial_flag = f"-s {serial}" if serial else ""
        saved = 0

        async with aiohttp.ClientSession(headers=headers) as session:
            for i, url in enumerate(urls, start=1):
                async with session.get(url, timeout=120) as resp:
                    if resp.status != 200:
                        return f"Failed: Tải ảnh #{i} lỗi — HTTP {resp.status} ({url[:60]})"
                    ctype = resp.headers.get("Content-Type", "")
                    data = await resp.read()

                if not data:
                    return f"Failed: Ảnh #{i} tải về rỗng ({url[:60]})"

                ext = _detect_image_ext(data[:16])
                if ext is None:
                    return (
                        f"Failed: File #{i} không phải ảnh hợp lệ "
                        f"(Content-Type: {ctype}, URL: {url[:60]}). "
                        "Cần URL trỏ trực tiếp tới file ảnh."
                    )

                local_path = device_dir / f"image_{i}.{ext}"
                with open(local_path, "wb") as f:
                    f.write(data)

                remote_path = f"/sdcard/DCIM/Camera/image_{i}.{ext}"
                cmd = f"adb {serial_flag} push {local_path} {remote_path}"
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
                except asyncio.TimeoutError:
                    proc.kill()
                    return f"Failed: ADB push ảnh #{i} timeout sau 120s"
                if proc.returncode != 0:
                    err = stderr.decode(errors="replace").strip()
                    return f"Failed: ADB push ảnh #{i} lỗi — {err}"

                await ctx.driver.device.shell(
                    "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE "
                    f"-d file://{remote_path}"
                )
                saved += 1

        return (
            f"Đã tải và lưu {saved} ảnh vào /sdcard/DCIM/Camera/ thành công. "
            f"Gọi tiktok_open_file_manager_at_images rồi tiktok_share_images_file_to_tiktok để chia sẻ {saved} ảnh."
        )
    except Exception as e:
        return f"Failed: Không tải/lưu được ảnh — {e}"


async def set_photo_caption_and_post(caption: str = "", hashtags=None, *, ctx, **kwargs) -> str:
    """Type the caption + hashtags on TikTok's photo-post screen, then tap Post.

    Falls back to the task payload (caption, hashtags) when arguments are
    omitted.  *hashtags* may be a list or a comma/space-separated string; the
    tool prefixes each tag with '#'.

    Flow: skip any intermediate editor screen (tap "Tiếp"/"Next" up to twice
    until the caption field / Post button appears) → tap the caption field →
    type "<caption> #tag1 #tag2" → tap "Đăng"/"Post" → confirm the posting
    screen.

    Returns a success message, or a "Failed: [bước N] ..." reason.
    """
    # ── Bước 1: resolve caption + hashtags ──────────────────────────────────
    if not caption or hashtags is None:
        _raw = get_raw_context()
        _payload = _raw.get("payload") or {}
        if not caption:
            caption = (_payload.get("caption") or _payload.get("content") or "").strip()
        if hashtags is None:
            hashtags = _payload.get("hashtags") or _payload.get("tags") or []

    if isinstance(hashtags, str):
        raw_tags = _parse_str_list(hashtags, sep=r"[,\s]+")
    else:
        raw_tags = _parse_str_list(hashtags)
    norm_tags = [t if t.startswith("#") else "#" + t.lstrip("#") for t in raw_tags]

    full_caption = caption.strip()
    if norm_tags:
        full_caption = (full_caption + " " + " ".join(norm_tags)).strip()
    if not full_caption:
        return "Failed: [bước 1] Không có caption lẫn hashtag — không có trong tham số lẫn payload."

    def _caption_pt(xml):
        """Centre of the description (body) EditText on the photo-post screen.

        Placeholders aren't surfaced by the indexed UI tree, so parse raw XML.
        Prefer the field whose text mentions description/mô tả; otherwise the
        last EditText (the body sits below the title field).
        """
        edits = []
        for m in _BT_NODE_RE.finditer(xml):
            attrs = m.group(1)
            if 'class="android.widget.EditText"' not in attrs:
                continue
            b = _BT_BOUNDS_RE.search(attrs)
            if not b:
                continue
            x1, y1, x2, y2 = map(int, b.groups())
            tm = re.search(r'text="([^"]*)"', attrs)
            edits.append((y1, (x1 + x2) // 2, (y1 + y2) // 2, tm.group(1) if tm else ""))
        if not edits:
            return None
        for _y, cx, cy, t in edits:
            if re.search(r"(?i)description|mô tả|chú thích|caption", t):
                return (cx, cy)
        edits.sort()
        return (edits[-1][1], edits[-1][2])

    def _post_pt(xml):
        return (
            _bt_find_bounds(xml, text="Post")
            or _bt_find_bounds(xml, text="Đăng")
            or _bt_find_bounds(xml, text_contains="Post")
            or _bt_find_bounds(xml, text_contains="Đăng")
        )

    try:
        w, h = await _screen_size(ctx)
        # ── Bước 2: đảm bảo đang ở màn caption (tap Tiếp/Next nếu cần) ────────
        cap_pt = None
        for _ in range(3):
            xml = await _bt_dump_ui(ctx)
            cap_pt = _caption_pt(xml)
            if cap_pt is not None or _post_pt(xml) is not None:
                break
            nxt = _bt_find_bounds(xml, text_contains="Next") or _bt_find_bounds(xml, text_contains="Tiếp")
            if nxt is None:
                break
            await ctx.driver.tap(*nxt)
            await asyncio.sleep(3.0)

        # ── Bước 3: gõ caption + hashtag ─────────────────────────────────────
        xml = await _bt_dump_ui(ctx)
        cap_pt = cap_pt or _caption_pt(xml)
        if cap_pt is None:
            hint = ", ".join(
                (re.search(r'text="([^"]*)"', m.group(1)) or [None, "?"])[1][:24]
                for m in list(_BT_NODE_RE.finditer(xml))[:12]
            )
            return f"Failed: [bước 3] Không tìm thấy ô caption. Visible: {hint}"
        await ctx.driver.tap(*cap_pt)
        await asyncio.sleep(1.0)
        # Trailing space closes the #hashtag autocomplete panel that would
        # otherwise cover the Post button.
        await ctx.driver.input_text(full_caption + " ")
        await asyncio.sleep(1.0)
        # Close the soft keyboard so it doesn't cover the Post button.
        await ctx.driver.press_button("back")
        await asyncio.sleep(1.2)

        # ── Bước 4: tap "Đăng" / "Post" ──────────────────────────────────────
        xml = await _bt_dump_ui(ctx)
        post_pt = _post_pt(xml)
        if post_pt is None:
            # A hashtag-suggestion panel may still cover Post — tap a neutral
            # area to dismiss it, then look again.
            await ctx.driver.tap(w // 2, int(h * 0.30))
            await asyncio.sleep(1.2)
            xml = await _bt_dump_ui(ctx)
            post_pt = _post_pt(xml)
        if post_pt is None:
            return "Failed: [bước 4] Không tìm thấy nút 'Đăng'/'Post' sau khi gõ caption."
        await ctx.driver.tap(*post_pt)
        await asyncio.sleep(4.0)

        # ── Bước 5: xác nhận đang đăng ───────────────────────────────────────
        xml = await _bt_dump_ui(ctx)
        if re.search(r"(?i)posting|đang đăng|đang tải lên|uploading", xml):
            return (
                "Đã đăng ảnh kèm caption thành công — màn 'Đang đăng' đã xác nhận. "
                f"Caption: {full_caption[:60]!r}"
            )
        return (
            "Đã nhấn Đăng — bài có thể đang tải lên ngầm (không thấy màn xác nhận, "
            f"thường vẫn bình thường). Caption: {full_caption[:60]!r}"
        )
    except Exception as e:
        return f"Failed: [bước ?] Lỗi khi nhập caption/đăng — {e}"


TOOLS: dict = {
    "tiktok_copy_video_comments": {
        "parameters": {
            "video_link": {
                "type": "string",
                "required": False,
                "description": "Link video TikTok cần lấy bình luận. Bỏ trống để tự lấy từ task payload.",
            },
            "count": {
                "type": "integer",
                "required": False,
                "description": "Số lượng bình luận cần thu thập (mặc định 10). Trong mode tìm kiếm, đây là số comment của user mục tiêu cần lấy.",
            },
            "search_username": {
                "type": "string",
                "required": False,
                "description": "Tên hiển thị hoặc biệt danh của user cần tìm comment (VD: 'bác sĩ Hoàng'). Sẽ tự tra cứu trong tag_mapping.yaml.",
            },
            "search_keyword": {
                "type": "string",
                "required": False,
                "description": "Từ khóa trong nội dung comment cần tìm. Dùng kết hợp với search_username hoặc dùng riêng.",
            },
        },
        "description": (
            "TOOL dùng để thu thập bình luận từ video TikTok. "
            "Có 2 chế độ: (1) BULK — copy N comment bất kỳ (mặc định), "
            "(2) FIND — tìm comment theo tên người dùng (search_username) và/hoặc từ khóa (search_keyword). "
            "Khi truyền search_username, tool sẽ tra cứu tên thật qua tag_mapping và tìm đúng comment của user đó. "
            "Kết quả trả về là danh sách các bình luận đã thu thập hoặc thông báo không tìm thấy."
        ),
        "function": tiktok_copy_video_comments,
    },
    "tiktok_open_video_and_comment": {
        "parameters": {
            "video_link": {
                "type": "string",
                "required": False,
                "description": "Link video TikTok cần comment. Bỏ trống để tự lấy từ task payload.",
            },
            "comment_context": {
                "type": "string",
                "required": False,
                "description": "Nội dung comment cần đăng. Bỏ trống để tự lấy từ task payload.",
            },
        },
        "description": (
            "TOOL DUY NHẤT cần gọi khi task yêu cầu comment lên một video TikTok cụ thể. "
            "CẢNH BÁO: KHÔNG dùng tool này nếu người dùng yêu cầu 'tag', 'gắn thẻ' hoặc 'mention' ai đó. "
            "Trong trường hợp có tag, bắt buộc phải dùng 'tiktok_open_video_comment_and_tag'. "
            "KHÔNG được dùng tiktok_open_comment_section / tiktok_type_comment / tiktok_post_comment riêng lẻ — "
            "tool này đã bao gồm toàn bộ flow trong một lệnh. "
            "Hai tham số video_link và comment_context là tuỳ chọn — nếu không truyền sẽ tự lấy từ task payload. "
            "Nếu payload cũng không có, tool trả lỗi '[bước 1] ... Hãy gọi lại với tham số ...' "
            "để LLM đọc task và gọi lại với giá trị đầy đủ. "
            "Trả về 'Comment đã đăng thành công ...' nếu xong. "
            "Trả về 'Failed: [bước N] ...' nếu lỗi: "
            "[bước 1] thiếu video_link hoặc comment_context, "
            "[bước 2] ADB deep link lỗi, "
            "[bước 3] nút comment chưa hiện — thử lại sau 3s, "
            "[bước 4] ô nhập / portal thất bại — thử lại sau 2s, "
            "[bước 5] nút Post chưa hiện — thử lại sau 2s."
        ),
        "function": open_video_and_comment,
    },
    "tiktok_record_comment_interaction": {
        "parameters": {
            "video_link": {
                "type": "string",
                "required": False,
                "description": "Link video TikTok đã comment. Bỏ trống để tự lấy từ task payload.",
            },
            "comment_context": {
                "type": "string",
                "required": False,
                "description": "Nội dung comment đã đăng. Bỏ trống để tự lấy từ task payload.",
            },
        },
        "description": (
            "Ghi lại tương tác comment lên Dashboard sau khi agent đã đăng comment thành công. "
            "Hai tham số video_link và comment_context là tuỳ chọn — nếu không truyền sẽ tự lấy từ task payload. "
            "Nếu payload không có, LLM phải truyền trực tiếp qua tham số. "
            "Gọi POST /api/tiktok/record-interaction/ với interaction_type='comment'. "
            "Trả về '[INTERACTION RECORDED] ...' nếu thành công, '[RECORD FAILED] ...' nếu lỗi."
        ),
        "function": record_comment_interaction,
    },
    "tiktok_open_video_comment_and_tag": {
        "parameters": {
            "video_link": {
                "type": "string",
                "required": False,
                "description": "Link video TikTok cần comment. Bỏ trống để tự lấy từ task payload.",
            },
            "comment_context": {
                "type": "string",
                "required": False,
                "description": "Nội dung comment cần đăng (chưa bao gồm tag). Bỏ trống để tự lấy từ task payload.",
            },
            "tag_display_name": {
                "type": "string",
                "required": False,
                "description": (
                    "Tên gọi thường ngày của người cần tag (VD: 'bác sĩ tiến đạt'). "
                    "Dùng để tra cứu @username từ file tag_mapping.yaml. "
                    "Bỏ trống nếu đã có tag_username."
                ),
            },
            "tag_username": {
                "type": "string",
                "required": False,
                "description": (
                    "TikTok @username để tag trực tiếp (VD: '@bacsitiendat'). "
                    "Ưu tiên hơn tag_display_name. Bỏ trống để tra cứu từ tag_display_name."
                ),
            },
            "comment_suffix": {
                "type": "string",
                "required": False,
                "description": "Nội dung comment đứng SAU tag. Bỏ trống nếu tag ở cuối câu.",
            },
        },
        "description": (
            "TOOL dùng khi task yêu cầu comment lên video TikTok VÀ tag (@mention) một người dùng. "
            "Nếu task CHỈ yêu cầu comment (không tag ai), dùng tiktok_open_video_and_comment thay thế. "
            "Tool tự động: mở video → nhập comment kèm @username → đăng → ghi Dashboard. "
            "Bốn tham số đều tuỳ chọn — nếu không truyền sẽ tự lấy từ task payload "
            "(video_link, comment_context, tag_display_name, tag_username). "
            "tag_username ưu tiên hơn tag_display_name. Nếu chỉ có tag_display_name, "
            "tool sẽ tra file tag_mapping.yaml để tìm @username tương ứng. "
            "Trả về 'Comment+Tag đã đăng thành công ...' nếu xong. "
            "Trả về 'Failed: [bước N] ...' nếu lỗi: "
            "[bước 1] thiếu video_link / comment_context / tag info, "
            "[bước 1.5] không resolve được @username, "
            "[bước 2] ADB deep link lỗi, "
            "[bước 3] nút comment chưa hiện, "
            "[bước 4] ô nhập thất bại, "
            "[bước 5] nút Post chưa hiện."
        ),
        "function": open_video_comment_and_tag,
    },
    
    "tiktok_reply_to_comment": {
        "parameters": {
            "comment_link": {
                "type": "string",
                "required": False,
                "description": (
                    "URL đầy đủ của comment TikTok cần trả lời (có chứa comment_id). "
                    "Bỏ trống để tự lấy từ task payload."
                ),
            },
            "reply_text": {
                "type": "string",
                "required": False,
                "description": "Nội dung reply cần đăng. Bỏ trống để tự lấy từ task payload.",
            },
            "tag_display_name": {
                "type": "string",
                "required": False,
                "description": (
                    "Tên hiển thị của người muốn tag trong reply (VD: 'bác sĩ Hoàng'). "
                    "Tool tự tra cứu @username qua tag_mapping.yaml. "
                    "Dùng khi reply cần @mention thêm một người khác ngoài tác giả comment gốc."
                ),
            },
            "tag_username": {
                "type": "string",
                "required": False,
                "description": (
                    "TikTok @username trực tiếp của người muốn tag (VD: '@bacsitiendat'). "
                    "Dùng khi đã biết chính xác username, ưu tiên hơn tag_display_name."
                ),
            },
            "comment_suffix": {
                "type": "string",
                "required": False,
                "description": "Nội dung gõ thêm SAU tag (VD: ' bạn nghĩ sao?'). Mặc định để trống.",
            },
        },
        "description": (
            "TOOL dùng khi task yêu cầu REPLY (trả lời) vào một comment TikTok cụ thể. "
            "Truyền vào comment_link (URL comment có comment_id) và reply_text (nội dung trả lời). "
            "Nếu reply cần tag (@mention) thêm người: truyền tag_display_name hoặc tag_username, "
            "tool tự kích hoạt popup suggest của TikTok và chọn đúng người. "
            "Tool tự động: mở comment → thả tim → tap 'Trả lời' → nhập reply (có/không tag) → đăng → ghi Dashboard. "
            "Nếu không truyền tham số, tool tự lấy từ task payload. "
            "KHÔNG dùng tool này để comment vào video gốc (root comment) — "
            "dùng tiktok_open_video_and_comment hoặc tiktok_open_video_comment_and_tag thay thế. "
            "Trả về 'Đã like và reply thành công ...' nếu xong. "
            "Trả về 'Failed: [bước N] ...' nếu lỗi."
        ),
        "function": reply_to_comment,
    },
    "tiktok_report_copy_success": {
        "parameters": {},
        "description": (
            "GỌI CÔNG CỤ NÀY NGAY SAU KHI ĐÃ NHẤN 'Sao chép liên kết' (Copy Link). "
            "Công cụ này sẽ lấy link từ clipboard và đẩy trực tiếp lên Dashboard ngay lập tức. "
            "Sau khi nhận được phản hồi thành công từ công cụ này, bạn có thể tiếp tục lướt xuống "
            "video tiếp theo để lấy thêm link nếu nhiệm vụ yêu cầu nhiều video."
        ),
        "function": report_copy_success,
    },
    "tiktok_send_webhook_callback": {
        "parameters": {
            "video_url": {"type": "string", "required": False},
            "content": {"type": "string", "required": True},
            "keyword": {"type": "string", "required": False},
            "task_id": {"type": "integer", "required": False},
        },
        "description": (
            "Gửi link video TikTok (tự động lấy từ Clipboard) và kịch bản về Dashboard để tạo record mới. "
            "Hãy gọi công cụ này ngay sau khi bạn đã nhấn 'Sao chép liên kết' (Copy Link). "
            "Nó sẽ tự động lấy link từ bộ nhớ tạm và POST về Dashboard của hệ thống. "
            "Các trường keyword, task_id, và list_id được tự động lấy từ task context — "
            "bạn không cần truyền chúng trừ khi muốn ghi đè."
        ),
        "function": send_webhook_callback,
    },
    "tiktok_dismiss_popup": {
        "parameters": {},
        "description": (
            "Dismiss any popup, advertisement, or overlay that is blocking "
            "the TikTok screen. Tries Close/Skip buttons then falls back to "
            "the system Back button."
        ),
        "function": dismiss_popup,
    },
    "tiktok_open_comment_section": {
        "parameters": {},
        "description": (
            "Open the comment section of the currently displayed TikTok video. "
            "Call this before you attempt to read or type comments."
        ),
        "function": open_comment_section,
        "precondition": screen_guard("Bình luận", "Comment", "comment"),
    },
    "tiktok_type_comment": {
        "parameters": {
            "text": {"type": "string", "required": True},
        },
        "description": (
            "Type the given text into the TikTok comment input field. "
            "Call tiktok_open_comment_section first if the comment section "
            "is not yet open."
        ),
        "function": type_comment,
        "precondition": screen_guard(
            "add comment", "write a comment", "comment…",
            "nhập bình luận", "comment_text",
        ),
    },
    "tiktok_post_comment": {
        "parameters": {},
        "description": (
            "Tap the Post/Send button to submit the comment that was typed "
            "with tiktok_type_comment."
        ),
        "function": post_comment,
        "precondition": screen_guard("post", "send", "đăng", "gửi"),
    },
    "tiktok_ensure_screen_on": {
        "parameters": {},
        "description": (
            "Wake up the device screen if it is off and unlock it, then press "
            "Home. Use this at the start of any task to guarantee the device "
            "is in a usable state. Returns a message indicating whether the "
            "screen had to be woken up."
        ),
        "function": ensure_screen_on,
    },
    "tiktok_download_video_to_device": {
        "parameters": {
            "url": {"type": "string", "required": True},
        },
        "description": (
            "Download an MP4 video from a public URL and push it to "
            "/sdcard/DCIM/Camera/video.mp4 on the Android device via ADB. "
            "Also triggers the media scanner so the file is visible in "
            "gallery apps. Returns a success message with file size or a "
            "failure reason."
        ),
        "function": download_video_to_device,
    },
    "tiktok_open_file_manager_at_video": {
        "parameters": {},
        "description": (
            "Open the Android system file manager at the primary storage root "
            "so the agent can navigate to DCIM > Camera > video.mp4. "
            "Call this after tiktok_download_video_to_device and before "
            "tiktok_share_video_file_to_tiktok."
        ),
        "function": open_file_manager_at_video,
    },
    "tiktok_share_video_file_to_tiktok": {
        "parameters": {},
        "description": (
            "Long-press video.mp4 in the file manager, tap Share / Chia sẻ, "
            "then select TikTok from the Android share sheet. "
            "Expects the file manager to already be open at DCIM/Camera "
            "(navigate there after calling tiktok_open_file_manager_at_video). "
        ),
        "function": share_video_file_to_tiktok,
        "precondition": screen_guard("video.mp4"),
    },
    "tiktok_open_file_manager_at_images": {
        "parameters": {},
        "description": (
            "Open the Android system file manager at DCIM/Camera for the PHOTO flow "
            "and confirm 'image_1.*' is visible. Call this after "
            "tiktok_download_images_to_device and before tiktok_share_images_file_to_tiktok."
        ),
        "function": open_file_manager_at_images,
    },
    "tiktok_share_images_file_to_tiktok": {
        "parameters": {
            "count": {
                "type": "integer",
                "required": False,
                "description": "Số ảnh cần chọn. Bỏ trống/0 để tự đếm file image_* trên thiết bị.",
            },
        },
        "description": (
            "Chọn nhiều ảnh image_1.*…image_<count>.* trong file manager (chỉ chọn đúng "
            "các file worker đã tải, KHÔNG đụng video/ảnh khác), rồi Share → chọn TikTok. "
            "Cần file manager đang mở ở DCIM/Camera (gọi tiktok_open_file_manager_at_images trước). "
            "Sau đó gọi tiktok_set_photo_caption_and_post để nhập caption và đăng. "
            "Trả về 'Đã chọn N/M ảnh và chia sẻ sang TikTok ...' hoặc 'Failed: [bước N] ...'."
        ),
        "function": share_images_file_to_tiktok,
        "precondition": screen_guard("image_1."),
    },
    "tiktok_get_upload_state": {
        "parameters": {},
        "description": (
            "Inspect the current device screen and return the exact state "
            "in the TikTok video upload flow. "
            "Returns a structured message with: state name, description, "
            "the matched landmark element, and the recommended next action. "
            "Known states: file_manager_root, file_manager_dcim, "
            "file_manager_camera, file_manager_video, context_menu_share, "
            "share_sheet, tiktok_upload_editor, tiktok_caption_screen, "
            "tiktok_posting, unknown. "
            "Use this tool to recover from unexpected screens or to verify "
            "progress before deciding whether to continue or fall back."
        ),
        "function": get_upload_state,
    },
    "tiktok_complete_video_upload": {
        "parameters": {
            "caption": {
                "type": "string",
                "required": False,
                "description": "Nội dung caption (chưa gồm hashtag). Bỏ trống để lấy từ payload (caption / content / content_text).",
            },
            "hashtags": {
                "type": "string",
                "required": False,
                "description": (
                    "Danh sách hashtag — list hoặc chuỗi phân tách bởi dấu phẩy/khoảng trắng "
                    "(VD: 'review, lamdep' hoặc '#review #lamdep'). Tool tự thêm '#'. "
                    "Bỏ trống để lấy từ payload (hashtags / tags)."
                ),
            },
        },
        "description": (
            "Complete a TikTok video upload that was initiated via the share sheet. "
            "Can be called when the TikTok 'Video' / 'Tin nhắn' share sheet dialog is showing "
            "OR when the upload editor is open. "
            "Taps the 'Video' tab (if shown), then 'Tiếp' / 'Next', then types "
            "the caption and hashtags (if provided), then taps 'Đăng' / 'Post', "
            "and confirms the 'Đăng video' / 'Posting video' progress screen."
        ),
        "function": complete_video_upload,
        "precondition": screen_guard("Video", "Tin nhắn", "Tiếp", "Next", "Đăng", "Post"),
    },
    "tiktok_browse": {
        "parameters": {
            "duration_minutes": {"type": "number", "required": False},
            "video_count": {"type": "integer", "required": False},
        },
        "description": (
            "Automatically browse the TikTok For You feed — opens the app, scrolls through "
            "videos, and randomly likes content to simulate natural user behaviour. "
            "Stops when duration_minutes has elapsed OR video_count videos have been watched, "
            "whichever comes first. If neither is provided, defaults to 10 minutes. "
            "While running, handles automatically: notifications, out-of-foreground recovery, "
            "SparkActivity webview traps, livestreams (skipped), and ads (skipped). "
            "Randomly likes 2–3 videos per 10-video window (~20–30% like rate). "
            "Has a ~20% chance to visit the creator's profile and watch 1–3 additional videos. "
            "Returns a summary string on success (minutes elapsed, videos watched, likes, "
            "profiles visited, lives skipped, ads skipped). "
            "Returns a string starting with 'Failed:' if TikTok cannot be opened or crashes."
        ),
        "function": browse_tiktok,
    },
    "tiktok_send_dm": {
        "parameters": {
            "peer_handle": {
                "type": "string",
                "required": True,
                "description": (
                    "TikTok username/display name của peer cần gửi DM. "
                    "Có thể chứa emoji unicode (vd '🙂‍↔️', '😜'). "
                    "Tool tự xử lý partial substring match nếu chứa unicode."
                ),
            },
            "reply_text": {
                "type": "string",
                "required": True,
                "description": (
                    "Nội dung tin nhắn cần gửi (text plain, hỗ trợ tiếng Việt + emoji)."
                ),
            },
        },
        "description": (
            "TOOL gửi DM TikTok cho 1 peer cụ thể (TCS-v1.5 skill). "
            "Mở app TikTok → vào tab 'Hộp thư' → tìm conversation peer (scroll list) → "
            "kiểm tra tin BOT cuối (chống duplicate gửi 2 lần) → gõ tin + tap SEND icon "
            "(XÁC ĐỊNH CHÍNH XÁC, KHÔNG nhầm với icon MICRO). "
            "Trả 'SENT_CONFIRMED: ...' nếu gửi thành công, "
            "'SKIPPED_ALREADY_SENT: ...' nếu phát hiện tin đã gửi trước, "
            "'Failed: [bước N] {reason}' nếu lỗi từng bước. "
            "KHÔNG dùng tool này cho reply comment trên video — dùng tiktok_reply_to_comment thay thế."
        ),
        "function": send_dm,
    },
    "tiktok_download_images_to_device": {
        "parameters": {
            "image_urls": {
                "type": "string",
                "required": False,
                "description": (
                    "Một hoặc nhiều URL ảnh. Chấp nhận list, chuỗi phân tách bởi dấu phẩy/xuống dòng, "
                    "hoặc 1 URL. Bỏ trống để tự lấy từ payload (image_urls / images / image_url / "
                    "photo_url / photos). Ảnh user upload lên dashboard đã là URL công khai."
                ),
            },
        },
        "description": (
            "BƯỚC 1 của flow đăng ảnh lên TikTok. Tải một hoặc nhiều ảnh từ URL và lưu vào "
            "/sdcard/DCIM/Camera/image_<n>.<ext> trên thiết bị (validate magic bytes JPEG/PNG/WEBP/GIF, "
            "ADB push, kích media scanner để ảnh hiện trong gallery). Xoá ảnh image_* cũ trước. "
            "Trả về số ảnh đã lưu — sau đó gọi tiktok_open_file_manager_at_images. "
            "Trả về 'Failed: ...' nếu thiếu URL hoặc file không phải ảnh hợp lệ."
        ),
        "function": download_images_to_device,
    },
    "tiktok_set_photo_caption_and_post": {
        "parameters": {
            "caption": {
                "type": "string",
                "required": False,
                "description": "Nội dung caption (chưa gồm hashtag). Bỏ trống để lấy từ payload (caption / content).",
            },
            "hashtags": {
                "type": "string",
                "required": False,
                "description": (
                    "Danh sách hashtag — list hoặc chuỗi phân tách bởi dấu phẩy/khoảng trắng "
                    "(VD: 'review, lamdep' hoặc '#review #lamdep'). Tool tự thêm '#'. "
                    "Bỏ trống để lấy từ payload (hashtags / tags)."
                ),
            },
        },
        "description": (
            "BƯỚC 3 (cuối) của flow đăng ảnh. Bỏ qua màn editor trung gian (tự tap 'Tiếp'/'Next' "
            "tới màn caption) → gõ caption + các '#hashtag' đã ghép → tap 'Đăng'/'Post' → xác nhận "
            "màn 'Đang đăng'. caption/hashtags bỏ trống thì tự lấy từ payload. "
            "Trả về 'Đã đăng ảnh kèm caption thành công ...' hoặc 'Failed: [bước N] ...'."
        ),
        "function": set_photo_caption_and_post,
    },
}
