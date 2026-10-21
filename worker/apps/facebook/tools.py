"""
Facebook custom tools.

Low-level, single-purpose helpers that the agent can call directly.
These tools are deterministic wrappers around common Facebook UI actions.
If the UI has changed or an obstacle is detected (e.g. an ad popup) the
tool returns a descriptive failure message so the LLM executor can
decide how to recover.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import unicodedata
from pathlib import Path
import aiohttp

logger = logging.getLogger("mobilerun")

_FACEBOOK_PKG = "com.facebook.katana"
_PROFILE_MAPPING_PATH = Path(__file__).parent / "profile_mapping.yaml"


def _strip_accents(text: str) -> str:
    """Loại bỏ dấu tiếng Việt và diacritics."""
    if not text:
        return ""
    nfd_form = unicodedata.normalize('NFD', text)
    normalized = "".join([c for c in nfd_form if not unicodedata.combining(c)])
    return normalized.replace('đ', 'd').replace('Đ', 'D')


def _clean_text_for_matching(text: str) -> list[str]:
    """Chuẩn hóa văn bản bằng cách:
    1. Đưa về lowercase.
    2. Chuẩn hóa Unicode dạng NFC.
    3. Loại bỏ các ký tự dấu câu đặc biệt.
    4. Tách từ và giữ lại toàn bộ (không lọc theo độ dài).
    """
    if not text:
        return []
    # Đưa về dạng lowercase và chuẩn hóa NFC
    normalized = unicodedata.normalize('NFC', text.lower())
    # Loại bỏ dấu câu đặc biệt, thay bằng khoảng trắng để không dính chữ
    cleaned = re.sub(r'[^\w\s]', ' ', normalized)
    # Tách từ
    return [w for w in cleaned.split() if w.strip()]


# Số từ tối thiểu / tối đa của "phần đầu" khi so khớp bài viết. Quá ít từ thì dễ
# khớp nhầm sang bài khác (vd bài nào cũng mở đầu "Chào cả nhà"), nên dưới ngưỡng
# này thì lấy thêm từ ở các dòng sau cho đủ.
_HEAD_MIN_WORDS = 6
_HEAD_MAX_WORDS = 15


def _head_words_for_matching(content: str) -> list[str]:
    """Các từ ở PHẦN ĐẦU bài viết — phần LUÔN hiện trên màn hình kể cả khi
    Facebook thu gọn bài dài lại sau nút "Xem thêm".

    Vì sao cần: khâu so khớp cũ chia cho TỔNG số từ của cả bài, nên bài dài bị
    thu gọn thì trên màn hình chỉ còn 3-4 dòng đầu, tỷ lệ khớp không bao giờ với
    tới 80% dù đúng là bài đó. Task 3558 (08/09) đăng bài 4 ảnh thành công nhưng
    quét đủ 8 lần vẫn "không tìm thấy bài viết vừa đăng" nên không lấy được link.
    """
    first_line = ""
    for line in (content or "").splitlines():
        if line.strip():
            first_line = line.strip()
            break
    words = _clean_text_for_matching(first_line)
    if len(words) < _HEAD_MIN_WORDS:
        words = _clean_text_for_matching(content)
    return words[:_HEAD_MAX_WORDS]


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


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


# Class của các ô NHẬP CHỮ — tuyệt đối không được coi là nút Đăng.
_TEXT_INPUT_CLASSES = ("edittext", "autocompletetextview")

# Các chữ trên nút đăng bài, dùng cho cả khớp chính xác lẫn khớp chuỗi con.
_POST_BTN_WORDS = ("Đăng", "Post", "Chia sẻ ngay", "Chia sẻ", "Share")

# Số lần và khoảng chờ khi kiểm tra "bài đã rời màn hình soạn chưa" (xem Bước 6
# của facebook_create_post). 6 x 5s = 30s, cộng với 60s đã chờ upload ở trên.
_POST_VERIFY_TRIES = 6
_POST_VERIFY_WAIT = 5.0

# Sau khi bấm "Tiếp" ở giao diện 2 bước: số lần quét và khoảng chờ để đợi màn
# thứ 2 hiện nút đăng. 8 x 5s = 40 giây — đủ cho màn Reels xử lý video nặng.
_NEXT_SCREEN_TRIES = 8
_NEXT_SCREEN_WAIT = 5.0

# Màn có ít hơn ngần này phần tử thì coi là "trống" — dấu hiệu của lớp phủ trình
# phát video (đo thật: lớp phủ 11 node, trang cài đặt thước phim 23+ nhãn).
_MAN_TRONG_TOI_DA = 15


def _find_post_button_loose(elements, content: str = ""):
    """Tìm nút đăng theo CHUỖI CON, nhưng loại trừ những thứ không thể là nút.

    Vì sao phải có hàm riêng thay vì dùng _find_element_by_keywords: hàm chung đó
    ghép cả `resource-id` vào rồi so chuỗi con, mà composer của Facebook thì
    resource-id nào cũng có chữ "post"; tệ hơn nữa là nó so cả `text`, mà `text`
    của ô soạn bài chính là NỘI DUNG BÀI ĐĂNG.
    
    Đo trên máy thật W86HU8KZVWVOQ8W4 ngày 09/09 (bài của task 3558): màn hình
    composer khi đính 4 ảnh KHÔNG có nút "Đăng" — nút là "Tiếp" (giao diện 2
    bước). Khớp chính xác trượt, rồi khớp chuỗi con lại trúng node #42 chính là
    ô AutoCompleteTextView [0,460][720,1377], chỉ vì nội dung bài có sẵn chữ
    "chia sẻ" ("nghe chị em chia sẻ..."). Tool tap vào giữa ô đó (360, 918) →
    Facebook mở màn hình con "Thêm văn bản" → không bao giờ đăng, mà vẫn báo
    "Đăng bài thành công" rồi để máy treo ở đó (4 task hỏng liên tiếp 08/09).
    """
    head = (content or "").strip()[:40]
    for el in elements or []:
        cls = (el.get("className") or el.get("class") or "").lower()
        if any(bad in cls for bad in _TEXT_INPUT_CLASSES):
            continue
        text = el.get("text") or ""
        # Node đang hiển thị chính nội dung bài → là ô soạn/bản xem trước, không phải nút.
        if head and text.strip()[:40] == head:
            continue
        # KHÔNG lấy resource-id vào chuỗi so sánh (xem docstring).
        label = (text + " " + (el.get("content-desc") or el.get("description") or "")).lower()
        if any(kw.lower() in label for kw in _POST_BTN_WORDS):
            return el
    return None


async def _composer_still_open(ctx, content: str) -> bool:
    """Màn hình soạn bài có còn mở với nội dung bài nằm nguyên trong đó không.

    Dùng để KIỂM TRA sau khi tap nút đăng. Trước đây create_post tap xong là
    `sleep()` rồi trả về "Đăng bài thành công" mà không kiểm tra gì — nên một cú
    tap trượt cũng thành "thành công", các bước sau tin theo, và máy bị bỏ lại ở
    màn hình soạn bài làm task kế tiếp cũng hỏng.
    """
    head = (content or "").strip()[:30]
    if not head:
        return False
    try:
        ui = await ctx.state_provider.get_state()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[create_post] Không đọc được màn hình để kiểm tra: %s", exc)
        return False
    for el in (ui.elements if ui else []):
        cls = (el.get("className") or el.get("class") or "").lower()
        if not any(bad in cls for bad in _TEXT_INPUT_CLASSES):
            continue
        if head in (el.get("text") or ""):
            return True
    return False


def _find_element_exact(elements, *values: str):
    """Return the first UI element whose text or description exactly matches any value."""
    for el in elements or []:
        text = el.get("text") or ""
        desc = el.get("content-desc") or el.get("description") or ""
        if any(text == v or desc == v for v in values):
            return el
    return None


class PostBlock:
    def __init__(self, author_el, timestamp_el, three_dots_el, content_el, see_more_el=None):
        self.author_el = author_el
        self.timestamp_el = timestamp_el
        self.three_dots_el = three_dots_el
        self.content_el = content_el
        self.see_more_el = see_more_el


def _parse_post_blocks(elements, author_names: list[str]) -> list[PostBlock]:
    def _get_top_y(el_dict) -> int:
        bounds = el_dict.get("bounds") or ""
        parts = re.findall(r'-?\d+', bounds)
        return int(parts[1]) if len(parts) >= 4 else 0

    blocks = []
    seen_three_dots = set()
    n = len(elements)
    
    for i in range(n):
        el = elements[i]
        text = (el.get("text") or el.get("content-desc") or "").strip()
        
        def _clean_name(n: str) -> str:
            return re.sub(r'[\s\W_]', '', _strip_accents(n)).lower()
            
        is_author = any(_clean_name(auth) in _clean_name(text) for auth in author_names if auth.strip())
        if not is_author:
            continue
            
        # 2. Tìm kiếm nhãn thời gian và nút 3 chấm xung quanh index của tác giả
        timestamp_el = None
        three_dots_el = None
        
        # Tìm trong khoảng lân cận [-5, +10] quanh vị trí tác giả
        search_min = max(0, i - 5)
        search_max = min(n, i + 10)
        
        for idx in range(search_min, search_max):
            check_el = elements[idx]
            txt_check = (check_el.get("text") or "").strip().lower()
            desc_check = (check_el.get("content-desc") or "").strip().lower()
            label_check = txt_check + " " + desc_check
            
            # Kiểm tra nhãn thời gian
            kws = ["vừa xong", "just now", "phút", "giờ", "ngày", "tháng", "•", "public", "friends", "share"]
            if any(kw in label_check for kw in kws) and max(len(txt_check), len(desc_check)) < 50:
                if "thích" not in label_check and "bình luận" not in label_check and ("chia sẻ" not in label_check or "chia sẻ với" in label_check):
                    timestamp_el = check_el
                    
            # Kiểm tra nút 3 chấm
            if any(kw in label_check for kw in ("lựa chọn khác", "more options", "lựa chọn khác cho bài viết")):
                three_dots_el = check_el
                
        # Nếu đã tìm thấy đủ Header (Tác giả + Thời gian + 3 chấm)
        if timestamp_el and three_dots_el:
            three_dots_idx = three_dots_el.get("index")
            if three_dots_idx in seen_three_dots:
                continue
                
            # 3. Tìm nội dung bài đăng (thường nằm sau header, trong vòng 25 index tiếp theo)
            content_texts = []
            content_els = []
            see_more_el = None
            
            author_y = _get_top_y(el)
            header_max_idx = max(i, timestamp_el.get("index", 0), three_dots_el.get("index", 0))
            for idx in range(header_max_idx + 1, min(n, header_max_idx + 25)):
                check_el = elements[idx]
                
                # Bỏ qua nếu phần tử nằm ở vị trí cao hơn tác giả (vd: menu bar, logo FB)
                if _get_top_y(check_el) < (author_y - 20):
                    continue
                    
                c_text = (check_el.get("text") or check_el.get("content-desc") or "").strip()
                if not c_text:
                    continue
                
                # Bỏ qua các text là tên lớp giao diện Android/Facebook layout (ví dụ: android.view.ViewGroup)
                if c_text.startswith(("android.", "androidx.", "com.facebook.")):
                    continue
                
                # Bỏ qua các chi tiết liên quan đến nút Like, Comment, Share ở bài đăng trước
                # Chỉ bỏ qua nếu thực sự là widget/nút (dựa trên độ dài và từ khóa) để tránh loại bỏ bài viết thực sự chứa các từ này
                is_widget = False
                c_text_lower = c_text.lower()
                if len(c_text) < 100:
                    if c_text_lower in ("thích", "bình luận", "chia sẻ", "share", "like", "comment"):
                        is_widget = True
                    elif c_text_lower.startswith(("nút thích", "nút bình luận", "nút chia sẻ", "nút share", "nút like", "nút comment")):
                        is_widget = True
                    elif "cảm xúc" in c_text_lower or "lượt xem" in c_text_lower or "lượt chia sẻ" in c_text_lower:
                        is_widget = True
                    elif re.search(r'^\d+\s+(bình luận|chia sẻ|comment|share)s?$', c_text_lower):
                        is_widget = True
                
                # Gặp widget của bài viết thì dừng thu thập nội dung bài viết này
                if is_widget:
                    break
                
                # Bỏ qua mô tả phông nền của Facebook để tránh nhận diện nhầm làm nội dung bài viết
                if ("phông nền" in c_text_lower or "hình nền" in c_text_lower or "background" in c_text_lower) and \
                   ("hình minh họa" in c_text_lower or "minh họa" in c_text_lower or "illustration" in c_text_lower or c_text_lower == "phông nền"):
                    continue
                
                # Kiểm tra xem bài có bị rút gọn ("xem thêm")
                # Check các phần tử lân cận trước (vì "xem thêm" thường là text node riêng ngay sau content)
                for offset in range(1, 4):
                    if idx + offset < n:
                        btn_el = elements[idx + offset]
                        btn_text = (btn_el.get("text") or btn_el.get("content-desc") or "").strip().lower()
                        if "xem thêm" in btn_text or "see more" in btn_text:
                            see_more_el = btn_el
                            break
                            
                # Fallback nếu chữ "xem thêm" nằm trong chính text node
                if "xem thêm" in c_text_lower or "see more" in c_text_lower:
                    if len(c_text) < 20:
                        if not see_more_el:
                            see_more_el = check_el
                        continue
                
                content_texts.append(c_text)
                content_els.append(check_el)
                
            if content_els:
                # Gộp toàn bộ nội dung text tìm được để so khớp chính xác
                merged_text = " ".join(content_texts)
                representative_el = dict(content_els[0])
                representative_el["text"] = merged_text
                representative_el["content-desc"] = ""
                
                seen_three_dots.add(three_dots_idx)
                blocks.append(PostBlock(el, timestamp_el, three_dots_el, representative_el, see_more_el))
                
    return blocks


def _load_profile(profile_name: str) -> dict:
    """Load Facebook credentials from profile_mapping.yaml by friendly name.

    Args:
        profile_name: Tên gọi thân thiện (VD: "Profile A").

    Returns:
        dict với keys: username, password, display_name.

    Raises:
        FileNotFoundError: Nếu file profile_mapping.yaml không tồn tại.
        KeyError: Nếu profile_name không có trong file.
    """
    if not _PROFILE_MAPPING_PATH.exists():
        raise FileNotFoundError(
            f"profile_mapping.yaml không tìm thấy tại: {_PROFILE_MAPPING_PATH}. "
            "Hãy tạo file này theo hướng dẫn trong file mẫu."
        )

    import yaml

    with open(_PROFILE_MAPPING_PATH, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    profiles: dict = data.get("profiles") or {}
    needle = profile_name.strip().lower()
    for key, value in profiles.items():
        if key.strip().lower() == needle:
            return {
                "username": value.get("username", ""),
                "password": value.get("password", ""),
                "display_name": value.get("display_name", key),
            }

    available = ", ".join(f'"{k}"' for k in profiles.keys())
    raise KeyError(
        f"Không tìm thấy profile '{profile_name}' trong profile_mapping.yaml. "
        f"Các profile hiện có: [{available}]"
    )


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


async def facebook_get_credentials(profile_name: str, *, ctx, **kwargs) -> str:
    """Tra cứu thông tin đăng nhập Facebook từ profile_mapping.yaml.

    Dùng khi agent cần biết username và password để đăng nhập vào một tài khoản
    Facebook cụ thể. Trả về thông tin dạng text để agent tự điền vào form đăng nhập.

    Args:
        profile_name: Tên gọi thân thiện của tài khoản (VD: "Profile A", "profile2").
                      Phải khớp với key trong profile_mapping.yaml.

    Returns:
        Chuỗi text chứa username, password, display_name — hoặc "Failed: ..." nếu lỗi.
    """
    try:
        profile = _load_profile(profile_name)
        logger.info(
            "[facebook_get_credentials] Found profile=%r display_name=%r",
            profile_name, profile["display_name"],
        )
        return (
            f"username: {profile['username']}\n"
            f"password: {profile['password']}\n"
            f"display_name: {profile['display_name']}"
        )
    except FileNotFoundError as e:
        return f"Failed: {e}"
    except KeyError as e:
        return f"Failed: {e}"


async def facebook_check_current_account(profile_name: str, *, ctx, **kwargs) -> str:
    """Kiểm tra tài khoản Facebook đang đăng nhập có khớp với profile yêu cầu không.

    Dùng ngay sau khi mở Facebook. Tool tự động:
    0. Kiểm tra có đang ở giao diện chính (News Feed) không
    1. Tap vào button "Dăng tới trang cá nhân" để mở profile
    2. Đọc tên tài khoản hiển thị
    3. So sánh với display_name của profile yêu cầu

    Args:
        profile_name: Tên gọi thân thiện (VD: "Profile A"). Phải có trong profile_mapping.yaml.

    Returns:
        - "Không ở giao diện chính: đang ở [mô tả] — cần đăng nhập vào Facebook trước"
          → LLM biết cần thực hiện đăng nhập (Trường hợp B trong skill)
        - "Đúng tài khoản: ..." nếu khớp → LLM tiếp tục task chính
        - "Sai tài khoản: cần '...' nhưng đang là '...' — hãy đăng xuất và đăng nhập lại"
          → LLM tự xử lý logout + login đúng tài khoản
        - "Failed: ..." nếu có lỗi kỹ thuật
    """
    # ── Bước 0: Kiểm tra có đang ở giao diện chính (News Feed) không ────────────
    # Marker của News Feed (từ scan_ui thực tế):
    #   - "Bạn đang nghĩ gì?"        → ô tạo bài viết
    #   - "Đi tới trang cá nhân"      → avatar button trong ô tạo bài viết
    #   - "Trang chủ, Tab 1/6"         → tab bar Home
    _NEWS_FEED_MARKERS = (
        "Bạn đang nghĩ gì?",
        "Đi tới trang cá nhân",
        "Trang chủ, Tab 1/6",
        "What's on your mind?",
        "Go to profile",
        "Go to Profile",
        "Home, Tab 1",
    )
    try:
        ui_state_check = await ctx.state_provider.get_state()
        els_check = ui_state_check.elements if ui_state_check else []
        on_news_feed = any(
            _find_element_by_keywords(els_check, marker)
            for marker in _NEWS_FEED_MARKERS
        )
        if not on_news_feed:
            # Lấy một vài element text đầu tiên để mô tả màn hình hiện tại
            visible = ", ".join(
                (e.get("text") or e.get("content-desc") or "")[:25]
                for e in (els_check or [])[:10]
                if (e.get("text") or e.get("content-desc") or "").strip()
            ) or "không xác định"
            logger.info(
                "[facebook_check_current_account] Không phải News Feed. Visible: %s", visible
            )
            return (
                f"Không ở giao diện chính Facebook: đang ở màn hình [{visible}]. "
                "Cần đăng nhập vào Facebook trước (thực hiện Bước 3 trong skill login)."
            )
        logger.info("[facebook_check_current_account] Đang ở News Feed, tiếp tục kiểm tra tài khoản.")
    except Exception as e:
        return f"Failed: [check_account bước 0] Lỗi kiểm tra giao diện — {e}"

    # ── Bước 1: Load display_name từ profile_mapping ────────────────────────
    try:
        profile = _load_profile(profile_name)
        display_name = profile["display_name"]
    except (FileNotFoundError, KeyError) as e:
        # Nếu không có trong profile_mapping, fallback sử dụng luôn profile_name làm display_name
        display_name = profile_name

    logger.info(
        "[facebook_check_current_account] profile=%r display_name=%r",
        profile_name, display_name,
    )

    # ── Bước 2: Tap tab "Trang cá nhân" ────────────────────────────────────
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        profile_tab = _find_element_by_keywords(
            elements,
            "Trang cá nhân, Tab",
            "Đi tới trang cá nhân",
            "Profile, Tab",
            "Menu, Tab",
            "Go to profile",
            "Go to Profile"
        )
        if profile_tab is not None:
            idx = profile_tab.get("index")
            if idx is not None:
                x, y = ui_state.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                logger.info("[facebook_check_current_account] Tapped 'Trang cá nhân' tab")
            else:
                profile_tab = None

        if profile_tab is None:
            # Fallback: tap ☰ (hamburger menu, góc trên trái)
            hamburger = _find_element_by_keywords(elements, "menu", "☰", "navigation drawer")
            if hamburger is not None:
                idx_h = hamburger.get("index")
                if idx_h is not None:
                    x_h, y_h = ui_state.get_element_coords(idx_h)
                    await ctx.driver.tap(x_h, y_h)
                    logger.info("[facebook_check_current_account] Tapped ☰ hamburger menu")
            else:
                return "Failed: Không tìm thấy tab 'Trang cá nhân' hoặc menu ☰ trên màn hình để kiểm tra tài khoản."

        await asyncio.sleep(2.5)
    except Exception as e:
        return f"Failed: [check_account bước 2] Lỗi tap tab — {e}"

    # ── Bước 3: Scan UI tìm display_name ───────────────────────────────────
    try:
        ui_menu = await ctx.state_provider.get_state()
        els_menu = ui_menu.elements if ui_menu else []

        # Tìm exact match trước
        found_el = _find_element_exact(els_menu, display_name)
        # Nếu không exact, thử contains (case-insensitive)
        if found_el is None:
            found_el = _find_element_by_keywords(els_menu, display_name)

        if found_el:
            current_name = found_el.get("text") or found_el.get("content-desc") or display_name
            logger.info(
                "[facebook_check_current_account] Tìm thấy '%s' — đúng tài khoản",
                current_name,
            )
            # Đóng menu
            await ctx.driver.press_button("back")
            await asyncio.sleep(0.8)
            return (
                f"Đúng tài khoản: '{profile_name}' ({current_name}) — tiếp tục task chính."
            )

        # Không tìm thấy → sai tài khoản → đọc tên hiện tại
        current_name = "không xác định"
        
        # Xác nhận đã vào trang cá nhân hoặc menu chưa
        on_profile_or_menu = any(
            _find_element_by_keywords(els_menu, marker)
            for marker in ("Chỉnh sửa trang cá nhân", "Edit profile", "Thêm vào tin", "Add to story", "Cài đặt & quyền riêng tư", "Settings & privacy", "Đăng xuất", "Log out")
        )
        if not on_profile_or_menu:
            current_name = "Chưa mở được Trang cá nhân hoặc Menu (vẫn ở News Feed)"
        else:
            for el in (els_menu or []):
                text = (el.get("text") or "").strip()
                rid = (el.get("resource-id") or "").lower()
                cls = (el.get("className") or "").lower()
                # Tránh các ID của bài đăng feed hoặc bạn bè gợi ý
                if "suggest" in rid or "feed" in rid or "post" in rid or "friend" in rid:
                    continue
                if text and ("name" in rid or "title" in rid) and "textview" in cls:
                    current_name = text
                    break

        logger.warning(
            "[facebook_check_current_account] Sai tài khoản — cần '%s' (%s), hiện là '%s'",
            profile_name, display_name, current_name,
        )
        # Đóng menu rồi trả message cho LLM tự xử lý
        await ctx.driver.press_button("back")
        await asyncio.sleep(2.0)
        return (
            f"Sai tài khoản: cần '{profile_name}' ({display_name}) "
            f"nhưng Facebook đang đăng nhập bằng '{current_name}'. "
            "Hãy đăng xuất tài khoản hiện tại rồi đăng nhập lại đúng tài khoản theo yêu cầu."
        )

    except Exception as e:
        return f"Failed: [check_account bước 3] Lỗi scan tên tài khoản — {e}"


async def facebook_do_login(profile_name: str, *, ctx, **kwargs) -> str:
    """Thực hiện đăng nhập Facebook bằng profile đã cấu hình trong profile_mapping.yaml.

    Tool xử lý toàn bộ flow đăng nhập:
    1. Tap "Tôi có trang cá nhân rồi" (nếu màn hình đăng ký mới xuất hiện)
    2. Xử lý Google Password Manager → tap "Tiếp tục" để dùng credentials đã lưu
       Fallback: điền form thủ công (email + password) nếu không có Password Manager
    3. Chờ load (4s)
    4. Xử lý "Lưu thông tin đăng nhập?":
       - Tìm display_name trong text màn hình
       - Khớp → tap "Lưu" → return "Đúng tài khoản"
       - Không khớp → tap "Lúc khác" → return "Sai tài khoản"
       - Không có màn hình này → kiểm tra đã vào News Feed chưa

    Args:
        profile_name: Tên gọi thân thiện (VD: "Profile A"). Phải có trong profile_mapping.yaml.

    Returns:
        - "Đăng nhập thành công: đúng tài khoản '[profile_name]' ([display_name])"
        - "Sai tài khoản sau đăng nhập: mong đợi '[display_name]' nhưng tài khoản đang là '[name_on_screen]'"
        - "Failed: ..." nếu có lỗi kỹ thuật
    """
    # ── Load credentials ────────────────────────────────────────────────────
    try:
        profile = _load_profile(profile_name)
        username = profile["username"]
        password = profile["password"]
        display_name = profile["display_name"]
    except (FileNotFoundError, KeyError) as e:
        return f"Failed: [do_login load profile] {e}"

    logger.info(
        "[facebook_do_login] profile=%r display_name=%r", profile_name, display_name
    )

    # ── Bước 1: Tap "Tôi có trang cá nhân rồi" nếu có ──────────────────────
    try:
        ui1 = await ctx.state_provider.get_state()
        els1 = ui1.elements if ui1 else []
        have_account_btn = _find_element_by_keywords(els1, "Tôi có trang cá nhân rồi")
        if have_account_btn is not None:
            idx = have_account_btn.get("index")
            if idx is not None:
                x, y = ui1.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                logger.info("[facebook_do_login] Tapped 'Tôi có trang cá nhân rồi'")
                await asyncio.sleep(2.0)
    except Exception as e:
        logger.warning("[facebook_do_login] Bước 1 skip: %s", e)

    # ── Bước 2: Xử lý Google Password Manager hoặc điền form thủ công ───────
    try:
        ui2 = await ctx.state_provider.get_state()
        els2 = ui2.elements if ui2 else []

        if _find_element_by_keywords(els2, "Trình quản lý mật khẩu của Google"):
            # Google Password Manager đang mở → tap "Tiếp tục"
            tiep_tuc = _find_element_by_keywords(els2, "Tiếp tục")
            if tiep_tuc is not None:
                idx_t = tiep_tuc.get("index")
                if idx_t is not None:
                    x_t, y_t = ui2.get_element_coords(idx_t)
                    await ctx.driver.tap(x_t, y_t)
                    logger.info("[facebook_do_login] Tapped 'Tiếp tục' (Google Password Manager)")
            else:
                # Tap tọa độ cứng của button "Tiếp tục" từ scan_ui
                await ctx.driver.tap(564, 1412)
                logger.info("[facebook_do_login] Tapped 'Tiếp tục' via fallback coords (564,1412)")
            await asyncio.sleep(3.0)

        else:
            # Fallback: điền form thủ công
            # Facebook mobile login: email → Tiếp tục → password (2 màn hình riêng)
            logger.info("[facebook_do_login] Không thấy Password Manager, điền form thủ công")

            # Màn hình 1: nhập email/số điện thoại
            email_el = _find_element_by_keywords(
                els2, "Email", "email", "Số điện thoại", "phone", "số điện thoại"
            )
            if email_el:
                idx_e = email_el.get("index")
                if idx_e is not None:
                    x_e, y_e = ui2.get_element_coords(idx_e)
                    await ctx.driver.tap(x_e, y_e)
                    await asyncio.sleep(0.5)
                    await ctx.driver.input_text(username)
                    await asyncio.sleep(0.5)

                    # Tap "Tiếp tục" để chuyển sang màn hình nhập mật khẩu
                    tiep_tuc_el = _find_element_by_keywords(els2, "Tiếp tục", "Next", "Continue")
                    if tiep_tuc_el:
                        idx_tt = tiep_tuc_el.get("index")
                        if idx_tt is not None:
                            x_tt, y_tt = ui2.get_element_coords(idx_tt)
                            await ctx.driver.tap(x_tt, y_tt)
                            logger.info("[facebook_do_login] Tapped 'Tiếp tục' sau khi nhập email")
                    else:
                        # Fallback: press Enter/Next trên bàn phím
                        await ctx.driver.press_button("enter")
                        logger.info("[facebook_do_login] Pressed Enter sau khi nhập email")
                    await asyncio.sleep(2.0)

            # Màn hình 2: nhập mật khẩu (scan lại UI vì đã chuyển màn hình)
            ui2b = await ctx.state_provider.get_state()
            els2b = ui2b.elements if ui2b else []

            pwd_el = _find_element_by_keywords(els2b, "Mật khẩu", "password", "Password")
            if pwd_el:
                idx_p = pwd_el.get("index")
                if idx_p is not None:
                    x_p, y_p = ui2b.get_element_coords(idx_p)
                    await ctx.driver.tap(x_p, y_p)
                    await asyncio.sleep(0.5)
                    await ctx.driver.input_text(password)
                    await asyncio.sleep(0.5)

            login_btn = _find_element_by_keywords(
                els2b, "Đăng nhập", "Log in", "Login"
            )
            if login_btn:
                idx_l = login_btn.get("index")
                if idx_l is not None:
                    x_l, y_l = ui2b.get_element_coords(idx_l)
                    await ctx.driver.tap(x_l, y_l)
                    logger.info("[facebook_do_login] Tapped 'Đăng nhập' (form thủ công)")
            await asyncio.sleep(4.0)

    except Exception as e:
        return f"Failed: [do_login bước 2] Lỗi xử lý đăng nhập — {e}"

    # ── Bước 3: Chờ load ────────────────────────────────────────────────────
    await asyncio.sleep(4.0)

    # ── Bước 4: Xử lý "Lưu thông tin đăng nhập?" ────────────────────────────
    try:
        ui3 = await ctx.state_provider.get_state()
        els3 = ui3.elements if ui3 else []

        # Kiểm tra có màn hình "Lưu thông tin đăng nhập?" không
        save_screen = _find_element_by_keywords(els3, "Lưu thông tin đăng nhập")
        if save_screen is not None:
            # Tìm display_name trong tất cả các text trên màn hình
            all_text = " ".join(
                (e.get("text") or e.get("content-desc") or "")
                for e in els3
            ).lower()
            is_correct_account = display_name.lower() in all_text

            if is_correct_account:
                # Đúng tài khoản → tap "Lưu"
                luu_btn = _find_element_exact(els3, "Lưu") or _find_element_by_keywords(els3, "Lưu")
                if luu_btn:
                    idx_luu = luu_btn.get("index")
                    if idx_luu is not None:
                        x_luu, y_luu = ui3.get_element_coords(idx_luu)
                        await ctx.driver.tap(x_luu, y_luu)
                        logger.info("[facebook_do_login] Tapped 'Lưu' — đúng tài khoản '%s'", display_name)
                await asyncio.sleep(2.0)
                return f"Đăng nhập thành công: đúng tài khoản '{profile_name}' ({display_name})."

            else:
                # Sai tài khoản → tap "Lúc khác"
                luc_khac_btn = _find_element_by_keywords(els3, "Lúc khác")
                if luc_khac_btn:
                    idx_lk = luc_khac_btn.get("index")
                    if idx_lk is not None:
                        x_lk, y_lk = ui3.get_element_coords(idx_lk)
                        await ctx.driver.tap(x_lk, y_lk)
                        logger.info("[facebook_do_login] Tapped 'Lúc khác' — sai tài khoản")
                await asyncio.sleep(1.0)
                # Đọc tên tài khoản thực tế từ màn hình "Lưu"
                name_on_screen = "không xác định"
                for el in els3:
                    text = (el.get("text") or "").strip()
                    if display_name.lower() not in text.lower() and len(text) > 3 and "Lưu" not in text and "Lúc" not in text:
                        name_on_screen = text[:40]
                        break
                return (
                    f"Sai tài khoản sau đăng nhập: mong đợi '{profile_name}' ({display_name}) "
                    f"nhưng đã đăng nhập bằng tài khoản khác. "
                    "Hãy đăng xuất và thử lại."
                )

        # Không có màn hình "Lưu" → kiểm tra đã vào News Feed chưa
        _NEWS_FEED_MARKERS = (
            "Bạn đang nghĩ gì?",
            "Đi tới trang cá nhân",
            "Trang chủ, Tab 1/6",
            "What's on your mind?",
            "Go to profile",
            "Go to Profile",
            "Home, Tab 1",
        )
        on_feed = any(_find_element_by_keywords(els3, m) for m in _NEWS_FEED_MARKERS)
        if on_feed:
            logger.info("[facebook_do_login] Đã vào News Feed sau đăng nhập")
            return f"Đăng nhập thành công: đúng tài khoản '{profile_name}' ({display_name})."
        else:
            visible = ", ".join(
                (e.get("text") or e.get("content-desc") or "")[:20]
                for e in els3[:8]
                if (e.get("text") or e.get("content-desc") or "").strip()
            ) or "trống"
            return f"Failed: [do_login bước 4] Không xác định được trạng thái sau đăng nhập. Màn hình: [{visible}]"

    except Exception as e:
        return f"Failed: [do_login bước 4] Lỗi xử lý sau đăng nhập — {e}"


async def open_comment_section(*, ctx, **kwargs) -> str:
    """Open the comment section on the current Facebook video or post."""
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
    """Dismiss a popup, advertisement, or overlay on the Facebook screen."""
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        dismiss_el = _find_element_by_keywords(
            elements,
            "close", "dismiss", "skip", "not now",
            "đóng", "bỏ qua", "cancel", "no thanks", "đã hiểu", "không cho phép",
        )

        if dismiss_el is not None:
            idx = dismiss_el.get("index")
            if idx is not None:
                x, y = ui_state.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                return f"Popup dismissed via element: {dismiss_el.get('text') or dismiss_el.get('content-desc', 'unknown')}"

        await ctx.driver.press_button("back")
        return "Popup dismissed via back button"

    except Exception as e:
        return f"Failed: Could not dismiss popup — {e}"


async def type_comment(text: str, *, ctx, **kwargs) -> str:
    """Type a comment text into the Facebook comment input field."""
    if not text or not text.strip():
        return "Failed: Comment text cannot be empty"

    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []

        input_el = _find_element_by_keywords(
            elements,
            "add comment", "write a comment", "comment…",
            "nhập bình luận", "thêm bình luận", "EditText", "comment_text",
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

        post_el = _find_element_by_keywords(
            elements, "post", "send", "đăng", "submit", "gửi"
        )

        if post_el is None:
            return "Failed: Post button not found. Make sure a comment has been typed first."

        idx = post_el.get("index")
        if idx is None:
            return "Failed: Post button has no index attribute"

        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        return "Comment posted successfully"

    except Exception as e:
        return f"Failed: Error posting comment — {e}"


async def ensure_screen_on(*, ctx, **kwargs) -> str:
    """Wake up the device screen if it is off and unlock it, then return to home screen."""
    try:
        raw = await ctx.driver.device.shell(
            "dumpsys power | grep -c 'mWakefulness=Awake'"
        )
        is_awake = raw.strip() == "1"

        if not is_awake:
            await ctx.driver.device.shell("input keyevent 26")
            await asyncio.sleep(1)
            await ctx.driver.device.shell("input keyevent 3")
            await asyncio.sleep(1)
            _SWIPE_X = 300
            _SWIPE_START_Y = 1400
            _SWIPE_END_Y = 300
            await ctx.driver.device.shell(
                f"input swipe {_SWIPE_X} {_SWIPE_START_Y} {_SWIPE_X} {_SWIPE_END_Y}"
            )
            await asyncio.sleep(2)
            await ctx.driver.device.shell(
                f"input swipe {_SWIPE_X - 50} {_SWIPE_START_Y} {_SWIPE_X} {_SWIPE_END_Y}"
            )
            await asyncio.sleep(1)
            return "Screen was off — woke up and unlocked the device"
        else:
            await ctx.driver.device.shell("input keyevent 3")
            await asyncio.sleep(1)
            return "Screen was already on — pressed Home"

    except Exception as e:
        return f"Failed: Could not ensure screen is on — {e}"


async def run_adb_command(command: str, *, ctx, **kwargs) -> str:
    """Run an arbitrary ADB shell command on the connected Android device."""
    if not command or not command.strip():
        return "Failed: ADB command cannot be empty"

    try:
        result = await ctx.driver.device.shell(command.strip())
        return result if result else "(command completed with no output)"
    except Exception as e:
        return f"Failed: ADB command error — {e}"


def _tim_o_luoi_theo_nhan(elements, chi_so: int):
    r"""Ô thứ *chi_so* trong lưới thư viện, tìm theo nhãn "mục N".

    Dùng ranh giới số `(?!\d)`: bản cũ tìm chuỗi con "mục 1" nên khớp luôn cả
    "mục 10", "mục 11"... Đo trên máy thật FS4BKA001553 ngày 11/09: đi tìm
    "mục 1" thì nó trả về node "Ảnh, mục 10, chụp ngày 24/4" — tức là đính NHẦM
    một tấm ảnh cũ từ tháng 4 vào bài.
    """
    mau = re.compile(r"mục\s*%d(?!\d)" % chi_so, re.IGNORECASE)
    for el in elements or []:
        lab = (el.get("text") or "") + " " + (el.get("content-desc") or el.get("description") or "")
        if mau.search(lab):
            return el
    return None


def _suy_tam_o_luoi(elements, chi_so: int):
    """Suy ra TOẠ ĐỘ TÂM của ô thứ *chi_so* từ các ô CÓ nhãn xung quanh.

    Vì sao cần: ô mới nhất (mục 1 — đúng cái file vừa đẩy sang máy) rất hay
    KHÔNG có nhãn trợ năng. Đo thật ngày 11/09 trên FS4BKA001553: ô đầu lưới
    [0,280][240,599] có text='' desc='' clickable='false', trong khi các ô sau
    đều đủ nhãn "Ảnh, mục 2..12". Bấm thẳng vào ô trống đó thì video gắn vào bài
    bình thường (màn soạn bài hiện "Gỡ video") — nghĩa là ô vẫn dùng được, chỉ
    là không đọc được tên.

    Lưới xếp đều nên chỉ cần biết vài ô có nhãn là suy ra được ô còn lại:
    cột = (chi_so-1) % số_cột, hàng = (chi_so-1) // số_cột.
    """
    o = []
    for el in elements or []:
        lab = (el.get("text") or "") + " " + (el.get("content-desc") or el.get("description") or "")
        m = re.search(r"mục\s*(\d+)", lab, re.IGNORECASE)
        b = re.findall(r"-?\d+", el.get("bounds") or "")
        if m and len(b) >= 4:
            o.append((int(m.group(1)), int(b[0]), int(b[1]), int(b[2]), int(b[3])))
    if not o:
        return None
    o.sort()
    rong = o[0][3] - o[0][1]
    cao = o[0][4] - o[0][2]
    xs = sorted({x for _, x, _, _, _ in o})
    ys = sorted({y for _, _, y, _, _ in o})
    if not xs or not ys or rong <= 0 or cao <= 0:
        return None
    # Số cột suy từ chính các ô đã biết: ô mục 2 và mục 3 nằm cùng hàng đầu.
    so_cot = max(1, len({x for n, x, y, _, _ in o if y == ys[0]}) + (1 if xs[0] > rong // 2 else 0))
    cot = (chi_so - 1) % so_cot
    hang = (chi_so - 1) // so_cot
    # Gốc lưới: ô có nhãn nhỏ nhất, lùi về đúng số cột/hàng của nó.
    n0, x0, y0, _, _ = o[0]
    cot0 = (n0 - 1) % so_cot
    hang0 = (n0 - 1) // so_cot
    buoc_x = rong + 2
    buoc_y = cao + 2
    x = x0 + (cot - cot0) * buoc_x
    y = y0 + (hang - hang0) * buoc_y
    if x < 0 or y < 0:
        return None
    return (x + rong // 2, y + cao // 2)


# Nhãn CHỈ xuất hiện ở màn Thư viện ảnh (MediaPickerActivity). Dùng để biết mình
# còn đang đứng ở đó hay Facebook đã tự đóng nó và đẩy về màn soạn bài.
_PICKER_MARKERS = ("Chọn album", "Chọn nhiều file", "Choose album", "Select multiple")


def _still_in_media_picker(elements) -> bool:
    """Còn đang ở màn Thư viện ảnh hay đã bị đẩy về màn soạn bài."""
    for el in elements or []:
        lab = ((el.get("text") or "") + " "
               + (el.get("content-desc") or el.get("description") or "")).lower()
        if any(mk.lower() in lab for mk in _PICKER_MARKERS):
            return True
    return False


async def _attach_media_from_gallery(ctx, media_count: int = 1) -> tuple[bool, str]:
    """Mở màn hình chọn tệp, chọn động N tệp phương tiện đầu tiên và bấm Tiếp để hoàn thành."""
    try:
        # ── Bước 1: Tìm và click nút mở Thư viện/Ảnh/video ──
        ui_compose = await ctx.state_provider.get_state()
        els_compose = ui_compose.elements if ui_compose else []
        gallery_btn = _find_element_by_keywords(
            els_compose, 
            "Thư viện", "Ảnh/video", "Ảnh/Video", "Gallery", "Photo/video", "Photo/Video"
        )
        if gallery_btn is None:
            return False, "Không tìm thấy nút mở 'Thư viện' hoặc 'Ảnh/video'."
            
        idx_g = gallery_btn.get("index")
        if idx_g is None:
            return False, "Nút mở thư viện không có index."
            
        x, y = ui_compose.get_element_coords(idx_g)
        await ctx.driver.tap(x, y)
        logger.info("[_attach_media_from_gallery] Đã mở màn hình Chọn tệp phương tiện")
        await asyncio.sleep(4.0) # Chờ lưới ảnh tải đầy đủ
        
        # ── Bước 1.5: Kích hoạt chế độ chọn nhiều file (nếu media_count > 1) ──
        if media_count > 1:
            ui_multi = await ctx.state_provider.get_state()
            els_multi = ui_multi.elements if ui_multi else []
            
            multi_btn = _find_element_by_keywords(
                els_multi,
                "Chọn nhiều file", "Chọn nhiều", "Chọn nhiều mục", 
                "Select multiple", "Select Multiple", "Select multi", "Chọn nhiều ảnh"
            )
            if multi_btn:
                idx_multi = multi_btn.get("index")
                if idx_multi is not None:
                    x_mu, y_mu = ui_multi.get_element_coords(idx_multi)
                    await ctx.driver.tap(x_mu, y_mu)
                    logger.info("[_attach_media_from_gallery] Đã kích hoạt chế độ chọn nhiều tệp")
                    await asyncio.sleep(2.0)
            else:
                logger.warning("[_attach_media_from_gallery] Không tìm thấy nút kích hoạt chọn nhiều file, tiếp tục chọn trực tiếp")
        
        # ── Bước 2: Chọn N tệp phương tiện đầu tiên ──
        for i in range(1, media_count + 1):
            ui_picker = await ctx.state_provider.get_state()
            els_picker = ui_picker.elements if ui_picker else []
            
            # Tìm ô thứ i trong lưới. KHÔNG dùng _find_element_by_keywords nữa:
            # nó so chuỗi con nên "mục 1" khớp luôn "mục 10" (đo thật 11/09 —
            # xem _tim_o_luoi_theo_nhan).
            item_el = _tim_o_luoi_theo_nhan(els_picker, i)

            if item_el is not None:
                idx_m = item_el.get("index")
                if idx_m is None:
                    return False, f"Phần tử 'mục {i}' không có index."
                x_m, y_m = ui_picker.get_element_coords(idx_m)
            else:
                # Ô mới nhất thường KHÔNG có nhãn trợ năng — suy toạ độ từ các ô
                # bên cạnh thay vì bỏ cuộc (hoặc tệ hơn là bấm nhầm ô khác).
                tam = _suy_tam_o_luoi(els_picker, i)
                if tam is None:
                    return False, f"Không quét thấy tệp 'mục {i}' trong Thư viện ảnh."
                x_m, y_m = tam
                logger.info(
                    "[_attach_media_from_gallery] Ô 'mục %d' không có nhãn — suy toạ độ từ các ô "
                    "bên cạnh: (%d, %d)", i, x_m, y_m,
                )

            await ctx.driver.tap(x_m, y_m)
            logger.info(f"[_attach_media_from_gallery] Đã chọn thành công 'mục {i}'")
            
            await asyncio.sleep(1.5) # Chờ UI cập nhật trạng thái chọn
            
        # ── Bước 3: Bấm nút xác nhận — CHỈ KHI VẪN CÒN Ở MÀN THƯ VIỆN ──
        #
        # Chọn 1 file thì Facebook TỰ đóng thư viện và quay về màn soạn bài ngay,
        # không đợi bấm xác nhận; chọn nhiều file thì nó mới đứng lại chờ. Bản cũ
        # bấm "Tiếp" vô điều kiện, nên ở trường hợp 1 file nó bấm trúng nút "Tiếp"
        # CỦA MÀN SOẠN BÀI — và nút đó, khi bài có video, mở màn xem video toàn
        # màn hình (ImmersiveActivity, chỉ có mỗi nút "Đóng"). Sau đó create_post
        # đi tìm nút Đăng trên màn ấy, không thấy, và cả task hỏng.
        #
        # Dựng lại đúng trên máy thật FS4BKA001553 ngày 11/09 (task 3564): tap
        # video trong thư viện → về thẳng màn soạn bài, đã thấy nhãn "Gỡ video"
        # tức là video ĐÃ gắn vào bài; rồi bấm "Tiếp" ở màn đó → ImmersiveActivity.
        # Khớp y hệt ảnh chụp màn hình b04 → b05 của task hỏng.
        #
        # Vì thế: đăng 4 ảnh thì chạy tốt (nhiều file → thư viện đứng chờ, "Tiếp"
        # là đúng nút), còn đăng 1 video thì hỏng.
        ui_confirm = await ctx.state_provider.get_state()
        els_confirm = ui_confirm.elements if ui_confirm else []

        if not _still_in_media_picker(els_confirm):
            logger.info(
                "[_attach_media_from_gallery] Thư viện đã tự đóng sau khi chọn %d file "
                "— media đã gắn vào bài, bỏ qua bước bấm xác nhận.", media_count,
            )
            return True, "Thành công"

        next_btn = _find_element_exact(els_confirm, "Tiếp", "Next", "Xong", "Done", "Thêm", "Add")
        if next_btn is None:
            next_btn = _find_element_by_keywords(els_confirm, "Tiếp", "Next")
            
        if next_btn is None:
            return False, "Không tìm thấy nút 'Tiếp' để hoàn tất chọn ảnh/video."
            
        idx_n = next_btn.get("index")
        if idx_n is None:
            return False, "Nút 'Tiếp' không có index."
            
        x_n, y_n = ui_confirm.get_element_coords(idx_n)
        await ctx.driver.tap(x_n, y_n)
        logger.info(f"[_attach_media_from_gallery] Đã bấm Tiếp để hoàn thành chọn {media_count} ảnh/video")
        await asyncio.sleep(4.0)
        
        return True, "Thành công"
    except Exception as e:
        return False, f"Lỗi khi đính kèm ảnh/video từ thư viện: {e}"
async def _read_clipboard(ctx) -> str:
    """Đọc clipboard của thiết bị. Thử qua portal app trước, nếu không được sẽ thử qua các lệnh ADB shell."""
    # 1. Thử qua portal app
    try:
        portal_cmd = "content query --uri content://com.mobilerun.portal/getclipboard"
        res_portal = await ctx.driver.device.shell(portal_cmd)
        if res_portal and "result=" in res_portal:
            import json
            json_start = res_portal.find("{")
            if json_start >= 0:
                data = json.loads(res_portal[json_start:])
                if data.get("status") == "success":
                    val = (data.get("result", "") or "").strip()
                    # Portal có thể trả về text lỗi ClipboardService (SecurityException)
                    # với status=success — lọc như path 2 để không đẩy rác đi tiếp.
                    lower_val = val.lower()
                    is_err = any(err in lower_val for err in (
                        "no items", "no shell command", "not implemented", "error",
                        "permission", "fail", "not found", "unknown", "exception",
                    ))
                    if val and not is_err:
                        return val
    except Exception as e:
        logger.debug("[_read_clipboard] Thử qua portal app lỗi: %s", e)

    # 2. Thử các lệnh ADB shell thông thường
    candidates = (
        'cmd clipboard get-primary --user 0',
        'cmd clipboard get-primary',
        'service call clipboard 2',  # parcel
    )
    for cmd in candidates:
        try:
            out = await ctx.driver.device.shell(cmd)
            if not out:
                continue
            text = str(out).strip()
            # Bỏ qua các thông báo lỗi hoặc không hỗ trợ của hệ thống
            lower_text = text.lower()
            if any(err in lower_text for err in ("no shell command", "not implemented", "error", "permission", "fail", "not found", "unknown", "exception")):
                continue
            if text and not text.lower().startswith('result:') and 'parcel' not in text.lower():
                return text
            
            # Parse parcel hex nếu là lệnh service call
            if cmd.startswith('service call') and 'parcel' in text.lower():
                import re
                hex_groups = re.findall(r"'([^']{4,})'", text)
                joined = ''.join(hex_groups).replace('.', '')
                if joined:
                    return joined.strip()
        except Exception as e:
            logger.debug("[_read_clipboard] cmd=%r failed: %s", cmd, e)
            continue
            
    return ''


def _find_clickable_element_by_keywords(elements, *keywords: str):
    """Like ``_find_element_by_keywords`` but prefers a clickable element.

    FB bottom-sheet rows are typically: clickable container > TextView label.
    Tapping the inner label often doesn't register selection — must tap the
    clickable parent/container. This helper iterates twice: first pass returns
    the first clickable match, second pass falls back to any match.
    """
    for el in elements or []:
        label = (
            (el.get("text") or "")
            + " "
            + (el.get("content-desc") or "")
            + " "
            + (el.get("resource-id") or "")
        ).lower()
        if any(kw.lower() in label for kw in keywords):
            if str(el.get("clickable") or "").lower() == "true":
                return el
    return _find_element_by_keywords(elements, *keywords)


async def _toggle_group_anonymous_mode(ctx, display_name: str) -> tuple[bool, str]:
    """Bật chế độ "Đăng ẩn danh" qua menu author trên composer của FB Group.

    Flow đúng (FB không hiện toggle trực tiếp trên composer):
      1. Composer đã mở. Tap vào chip tên người dùng (display_name) ở đầu
         composer → mở bottom-sheet author/audience.
      2. Trong sheet, tap option "Đăng ẩn danh" / "Anonymous" (CLICKABLE row,
         không phải label TextView).
      3. FB có thể hiện disclaimer → tap "Tiếp tục" / "Tôi hiểu" / etc.
      4. **VERIFY**: scan lại composer, chip phải đổi sang "Thành viên ẩn danh"
         / "Anonymous member". Nếu vẫn là display_name → toggle thật sự không
         apply (false positive) → return False để caller bỏ tap "Đăng".

    Returns (ok, err_msg). ok=False nếu bất kỳ step nào fail — caller PHẢI
    return Failed để tránh đăng bài dưới tên thật.
    """
    try:
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []

        # Step 1: tìm chip author = element clickable có text/content-desc
        # chứa display_name. Ưu tiên clickable để tránh tap nhầm label.
        clean_name = (display_name or '').strip()
        if not clean_name:
            return False, "display_name rỗng — không định danh được author chip."

        author_chip = None
        author_chip_fallback = None
        for el in els:
            text = (el.get('text') or '').strip()
            desc = (el.get('content-desc') or '').strip()
            if clean_name in text or clean_name in desc:
                if str(el.get('clickable') or '').lower() == 'true':
                    author_chip = el
                    break
                elif author_chip_fallback is None:
                    author_chip_fallback = el
        author_chip = author_chip or author_chip_fallback

        if author_chip is None:
            return False, (
                f"Không tìm thấy chip tên '{clean_name}' trên composer để mở "
                "menu ẩn danh. Có thể display_name không khớp với UI."
            )

        idx = author_chip.get("index")
        if idx is None:
            return False, "Author chip không có index."
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)

        # Step 2: trong bottom-sheet, tìm + tap option "Đăng ẩn danh".
        # Dùng helper ưu tiên CLICKABLE để tránh tap nhằm label TextView.
        ui_sheet = await ctx.state_provider.get_state()
        els_sheet = ui_sheet.elements if ui_sheet else []
        anon_option = _find_clickable_element_by_keywords(
            els_sheet,
            "đăng ẩn danh",
            "bài đăng ẩn danh",
            "ẩn danh",
            "anonymous post",
            "post anonymously",
            "anonymous",
        )
        if anon_option is None:
            try:
                await ctx.driver.press_button("back")
                await asyncio.sleep(0.8)
            except Exception:
                pass
            return False, (
                "Group này không có option 'Đăng ẩn danh' trong menu author — "
                "admin group chưa bật tính năng anonymous. Bỏ đăng để tránh lộ "
                "danh tính."
            )

        idx = anon_option.get("index")
        if idx is None:
            try:
                await ctx.driver.press_button("back")
                await asyncio.sleep(0.8)
            except Exception:
                pass
            return False, "Option 'Đăng ẩn danh' không có index."
        x_a, y_a = ui_sheet.get_element_coords(idx)
        await ctx.driver.tap(x_a, y_a)
        # Chờ 10 giây để bottom sheet biến mất hoàn toàn và giao diện ổn định
        await asyncio.sleep(10.0)

        # Step 3: xử lý disclaimer dialog (nếu có). FB đổi tên nút thường
        # xuyên — keyword list rộng để khỏi miss.
        ui_after = await ctx.state_provider.get_state()
        els_after = ui_after.elements if ui_after else []
        
        confirm = _find_clickable_element_by_keywords(
            els_after,
            "tiếp tục", "continue",
            "đồng ý", "agree",
            "tôi hiểu", "đã hiểu", "i understand",
            "bật ẩn danh", "enable anonymous",
        )
        if confirm is not None:
            idx_c = confirm.get("index")
            if idx_c is not None:
                x_c, y_c = ui_after.get_element_coords(idx_c)
                logger.info(
                    f"[_toggle_group_anonymous_mode] Phát hiện nút xác nhận disclaimer: "
                    f"text={repr(confirm.get('text'))}, desc={repr(confirm.get('content-desc'))}, "
                    f"class={repr(confirm.get('className'))}, tại ({x_c}, {y_c}), tiến hành tap..."
                )
                await ctx.driver.tap(x_c, y_c)
                await asyncio.sleep(2.0)
            else:
                logger.info("[_toggle_group_anonymous_mode] Không tìm thấy index của nút xác nhận disclaimer.")
        else:
            logger.info("[_toggle_group_anonymous_mode] Không phát hiện hộp thoại disclaimer.")

        # Step 4: VERIFY. Scan composer state — author chip phải đổi sang
        # "Thành viên ẩn danh" / "Anonymous member" / "Ẩn danh". Nếu vẫn
        # thấy display_name nghĩa là toggle KHÔNG apply (false positive).
        ui_final = await ctx.state_provider.get_state()
        els_final = ui_final.elements if ui_final else []
        anon_indicator = _find_element_by_keywords(
            els_final,
            "thành viên ẩn danh",
            "anonymous member",
            "người tham gia ẩn danh",
            "ẩn danh",
            "anonymous",
        )
        
        logger.info(f"[_toggle_group_anonymous_mode] Kết quả tìm anon_indicator: {anon_indicator}")

        still_real_name = False
        for el in els_final:
            text = (el.get('text') or '').strip()
            desc = (el.get('content-desc') or '').strip()
            if clean_name in text or clean_name in desc:
                # Chỉ coi là vẫn hiển thị tên thật nếu phần tử này có thuộc tính clickable=True (là author chip)
                is_clickable = str(el.get('clickable') or '').lower() == 'true'
                if is_clickable:
                    logger.info(f"[_toggle_group_anonymous_mode] Phát hiện tên thật '{clean_name}' vẫn hiển thị trên phần tử clickable: text={repr(text)}, desc={repr(desc)}, class={el.get('className')}")
                    still_real_name = True
                    break
                else:
                    logger.info(f"[_toggle_group_anonymous_mode] Phát hiện tên thật '{clean_name}' xuất hiện ở phần tử không clickable (TextView cảnh báo, bỏ qua): text={repr(text)}, desc={repr(desc)}")
        
        if anon_indicator is None or still_real_name:
            return False, (
                "Toggle ẩn danh không apply: composer vẫn hiển thị "
                f"'{clean_name}' chứ chưa chuyển sang 'Thành viên ẩn danh'."
            )
        
        logger.info("[_toggle_group_anonymous_mode] Bật chế độ ẩn danh thành công.")
        return True, ""
    except Exception as e:
        return False, f"Lỗi bật ẩn danh — {e}"


async def _is_keyboard_shown(ctx) -> bool:
    """Kiểm tra xem bàn phím ảo (soft keyboard) có đang mở trên thiết bị hay không."""
    try:
        out = await ctx.driver.device.shell("dumpsys input_method")
        return "minputshown=true" in out.lower()
    except Exception:
        return True


async def facebook_create_post(content: str, profile_name: str, media_path: str = None, has_media: bool = False, media_count: int = 1, anonymous: bool = False, *, ctx, **kwargs) -> str:
    """Tự động đăng bài viết (post) lên trang cá nhân Facebook hoặc Group.

    Quy trình:
    1. Load display_name từ profile_mapping.yaml.
    2. Tìm ô 'Bạn đang nghĩ gì?' ở News Feed và tap.
    3. Trên màn hình Đăng bài: nhập content vào ô input, ấn Back 2 lần để tắt keyboard, tìm nút 'Đăng' và tap.

    *anonymous*: chỉ áp dụng khi đăng bài vào Facebook Group. Khi True, tool
    tự bật toggle "Đăng ẩn danh" giữa bước đính kèm media và bước nhấn Đăng.
    Nếu không tìm thấy toggle (group không hỗ trợ anonymous) → tool trả Failed
    để tránh lộ danh tính thật.
    """
    if not content or not content.strip():
        return "Failed: Nội dung bài viết không được để trống."

    # ── Bước 1: Load display_name từ profile ─────────────────────────────────
    try:
        profile = _load_profile(profile_name)
        display_name = profile["display_name"]
    except (FileNotFoundError, KeyError) as e:
        # Nếu không có trong profile_mapping, fallback sử dụng luôn profile_name làm display_name
        display_name = profile_name

    logger.info(
        "[facebook_create_post] Bắt đầu đăng bài cho profile=%r (%s) với nội dung: %r",
        profile_name, display_name, content
    )

    # ── Ép has_media/media_count theo media đã prefetch (nguồn sự thật từ
    # task payload) thay vì để LLM tự đoán — tránh đính thiếu/không đính khi
    # task có sẵn media_urls. Xem _prefetch_media_to_device trong task_executor.
    try:
        from task_context import get_raw_context
        _media_paths = (get_raw_context().get("payload") or {}).get("media_local_paths") or []
        if _media_paths:
            has_media = True
            if not media_count or media_count < len(_media_paths):
                media_count = len(_media_paths)
            logger.info(
                "[facebook_create_post] Prefetch có %d media → ép has_media=True, media_count=%d",
                len(_media_paths), media_count,
            )
    except Exception as e:
        logger.debug("[facebook_create_post] Không đọc được media_local_paths: %s", e)

    # ── Bước 2: Mở giao diện soạn bài (nếu chưa mở) ────────────────────────
    # Trước tiên kiểm tra xem composer có đang mở sẵn chưa (agent có thể đã
    # tự ý mở trước). Nếu đã mở → bỏ qua bước tìm & tap nút soạn bài.
    try:
        ui_pre = await ctx.state_provider.get_state()
        els_pre = ui_pre.elements if ui_pre else []
        composer_already_open = any(
            "autocompletetextview" in (el.get("className") or "").lower()
            or "edittext" in (el.get("className") or "").lower()
            for el in els_pre
        )
        if composer_already_open:
            logger.info(
                "[facebook_create_post] Composer đã mở sẵn (phát hiện EditText) — bỏ qua bước tap mở soạn bài."
            )
    except Exception:
        composer_already_open = False

    if not composer_already_open:
        try:
            post_trigger = None
            for scroll_up_attempt in range(_NEXT_SCREEN_TRIES):
                ui_feed = await ctx.state_provider.get_state()
                els_feed = ui_feed.elements if ui_feed else []

                post_trigger = _find_element_by_keywords(els_feed, "Bạn đang nghĩ gì?")
                if post_trigger is None:
                    post_trigger = _find_element_by_keywords(
                        els_feed, "Bạn đang nghĩ gì", "What's on your mind", "Bạn viết gì đi..."
                    )

                if post_trigger is not None:
                    break

                if scroll_up_attempt < _NEXT_SCREEN_TRIES - 1:
                    # Màn gần như TRỐNG — nghi overlay che News Feed, cùng hiện
                    # tượng đã xác nhận thực tế ở Bước 5 (composer/màn Reels bị
                    # lớp phủ xám, chỉ hết khi CHẠM màn hình, cuộn không ăn thua
                    # vì overlay phủ kín không lộ nội dung bên dưới ra để cuộn
                    # tới). Chạm giữa màn hình thay vì cuộn trong trường hợp này.
                    if len(els_feed) <= _MAN_TRONG_TOI_DA:
                        cx = (getattr(ui_feed, "screen_width", None) or 720) // 2
                        cy = (getattr(ui_feed, "screen_height", None) or 1600) // 2
                        logger.info(
                            "[facebook_create_post] Feed chỉ có %d phần tử — nghi overlay che "
                            "màn hình, chạm giữa màn hình (%d, %d) để thử gỡ (lần %d/%d)...",
                            len(els_feed), cx, cy, scroll_up_attempt + 1, _NEXT_SCREEN_TRIES,
                        )
                        await ctx.driver.tap(cx, cy)
                        await asyncio.sleep(1.5)
                    else:
                        logger.info(
                            "[facebook_create_post] Không tìm thấy ô soạn bài, cuộn LÊN ĐẦU Feed "
                            "(Lần %d/%d)...", scroll_up_attempt + 1, _NEXT_SCREEN_TRIES,
                        )
                        # Vuốt từ trên xuống dưới = cuộn nội dung lên phía trên (scroll to top)
                        await ctx.driver.swipe(360, 400, 360, 1200, duration_ms=600)
                        await asyncio.sleep(1.5)

            if post_trigger is None:
                visible = ", ".join(
                    (e.get("text") or e.get("content-desc") or "")[:20]
                    for e in els_feed[:10]
                    if (e.get("text") or e.get("content-desc") or "").strip()
                ) or "không xác định"
                return (
                    "Failed: Không tìm thấy ô 'Bạn đang nghĩ gì?' trên News Feed sau khi thử cuộn/chạm màn hình. "
                    f"Các elements hiện tại: [{visible}]"
                )

            idx_trigger = post_trigger.get("index")
            if idx_trigger is None:
                return "Failed: Element kích hoạt đăng bài không có index."

            x_trig, y_trig = ui_feed.get_element_coords(idx_trigger)
            await ctx.driver.tap(x_trig, y_trig)
            logger.info("[facebook_create_post] Đã tap vào ô 'Bạn đang nghĩ gì?' trên News Feed")
            await asyncio.sleep(2.5)
        except Exception as e:
            return f"Failed: [create_post bước 2] Lỗi mở giao diện đăng bài — {e}"


    # ── Bước 2.5: Bật nền bài viết cho bài CHỈ-CÓ-CHỮ (không media) ───────────
    # Bài text-only nếu KHÔNG có nền sẽ bị Facebook tự định dạng lại (phóng to /
    # in hoa) khi nội dung ngắn. Tap nút "phông nền" (icon A) để vào trình soạn
    # nền — FB tự áp 1 nền mặc định nên chữ hiển thị bình thường. Việc gõ nội
    # dung và tap "Xong" do Bước 3 & Bước 4 bên dưới xử lý tiếp (ô soạn là
    # AutoCompleteTextView, nút Xong là Button — đều khớp logic sẵn có).
    #
    # Nút được tìm theo content-desc (KHÔNG hardcode toạ độ), toạ độ resolve
    # động theo từng thiết bị qua get_element_coords → chạy được trên mọi máy /
    # độ phân giải. Không tìm thấy nút → đăng bài thường, KHÔNG fail.
    if not (has_media or media_path):
        try:
            ui_bg = await ctx.state_provider.get_state()
            els_bg = ui_bg.elements if ui_bg else []
            bg_btn = _find_clickable_element_by_keywords(
                els_bg,
                "hiển thị tùy chọn phông nền",
                "tùy chọn phông nền",
                "phông nền",
                "background options",
                "show background",
            )
            idx_bg = bg_btn.get("index") if bg_btn else None
            if idx_bg is not None:
                x_bg, y_bg = ui_bg.get_element_coords(idx_bg)
                await ctx.driver.tap(x_bg, y_bg)
                logger.info(
                    "[facebook_create_post] Đã tap nút phông nền, đang chờ giao diện chọn Phong cách..."
                )
                await asyncio.sleep(2.5)

                # Quét lại để kiểm tra xem có hiện màn hình Phong cách (Style Picker) không
                ui_style = await ctx.state_provider.get_state()
                els_style = ui_style.elements if ui_style else []

                style_title = _find_element_by_keywords(els_style, "Phong cách", "Style")
                apply_btn = _find_clickable_element_by_keywords(
                    els_style,
                    "Áp dụng phong cách đã chọn",
                    "Áp dụng",
                    "Apply",
                    "Apply selected style"
                )

                if style_title is not None or apply_btn is not None:
                    logger.info("[facebook_create_post] Phát hiện giao diện chọn Phong cách. Tiến hành chọn một phong cách...")
                    style_btn = None
                    for el in els_style:
                        txt = (el.get("text") or el.get("content-desc") or "").strip().lower()
                        cls = (el.get("className") or "").lower()
                        if "button" in cls or str(el.get("clickable")).lower() == "true":
                            if ("phông nền" in txt or "hình nền" in txt or "background" in txt) and not any(k in txt for k in ["không có", "no background"]):
                                style_btn = el
                                break

                    if style_btn is not None:
                        idx_style = style_btn.get("index")
                        if idx_style is not None:
                            x_st, y_st = ui_style.get_element_coords(idx_style)
                            logger.info(f"[facebook_create_post] Tap chọn phông nền tại ({x_st}, {y_st})")
                            await ctx.driver.tap(x_st, y_st)
                            await asyncio.sleep(1.5)

                    # Bấm nút Áp dụng phong cách
                    if apply_btn is not None:
                        idx_app = apply_btn.get("index")
                        if idx_app is not None:
                            x_ap, y_ap = ui_style.get_element_coords(idx_app)
                            logger.info(f"[facebook_create_post] Tap nút Áp dụng phong cách đã chọn tại ({x_ap}, {y_ap})")
                            await ctx.driver.tap(x_ap, y_ap)
                            await asyncio.sleep(2.5)
                else:
                    logger.info("[facebook_create_post] Đã bật phông nền (không mở màn hình chọn Phong cách).")
            else:
                logger.info(
                    "[facebook_create_post] Không thấy nút phông nền — đăng bài thường (không nền)."
                )
        except Exception as e:
            logger.warning(
                "[facebook_create_post] Lỗi khi bật nền: %s. Tiếp tục đăng bài thường.", e
            )

    # ── Bước 3: Nhập nội dung bài đăng ────────────────────────────────────────
    try:
        ui_compose = await ctx.state_provider.get_state()
        els_compose = ui_compose.elements if ui_compose else []

        input_el = _find_element_by_keywords(els_compose, "Bạn đang nghĩ gì?", "Bạn đang nghĩ gì", "Gửi bài viết công khai để quản trị viên phê duyệt…")
        if input_el is None:
            for el in els_compose:
                cls = (el.get("className") or "").lower()
                if "autocompletetextview" in cls or "edittext" in cls:
                    input_el = el
                    break

        if input_el is None:
            return "Failed: Không tìm thấy ô nhập nội dung trên giao diện đăng bài."

        idx_input = input_el.get("index")
        if idx_input is None:
            return "Failed: Ô nhập nội dung không có index."

        x_in, y_in = ui_compose.get_element_coords(idx_input)
        await ctx.driver.tap(x_in, y_in)
        await asyncio.sleep(0.5)
        
        await ctx.driver.input_text(content, clear=True)
        logger.info("[facebook_create_post] Đã điền nội dung bài viết: %r", content)
        await asyncio.sleep(1.0)
    except Exception as e:
        return f"Failed: [create_post bước 3] Lỗi nhập nội dung — {e}"

    # ── Bước 4: Đóng bàn phím ảo ──────────────────────────────────────────────
    try:
        logger.info("[facebook_create_post] Đóng bàn phím ảo...")
        ui_close = await ctx.state_provider.get_state()
        els_close = ui_close.elements if ui_close else []
        xong_btn = None
        for el in els_close:
            txt = el.get("text") or el.get("content-desc") or ""
            cls = (el.get("className") or "").lower()
            if txt in ("Xong", "Done") and "button" in cls:
                xong_btn = el
                break
        
        if xong_btn is not None:
            idx_xong = xong_btn.get("index")
            if idx_xong is not None:
                x_x, y_x = ui_close.get_element_coords(idx_xong)
                logger.info(f"[facebook_create_post] Phát hiện nút 'Xong'/'Done' tại ({x_x}, {y_x}), tiến hành click...")
                await ctx.driver.tap(x_x, y_x)
                await asyncio.sleep(2.0)
            else:
                xong_btn = None
                
        if xong_btn is None:
            is_kb = await _is_keyboard_shown(ctx)
            if is_kb:
                logger.info("[facebook_create_post] Không thấy nút 'Xong'/'Done', bàn phím đang mở, tiến hành Back 1 lần để ẩn...")
                await ctx.driver.press_button("back")
                await asyncio.sleep(1.0)
            else:
                logger.info("[facebook_create_post] Không thấy nút 'Xong'/'Done', bàn phím đã đóng sẵn, không cần Back.")
    except Exception as e:
        logger.warning("[facebook_create_post] Lỗi khi đóng bàn phím: %s. Tiếp tục tìm nút Đăng.", e)

    # ── Bước đính kèm Media (MỚI) ────────────────────────────────────────────
    if has_media or media_path:
        logger.info("[facebook_create_post] Bắt đầu đính kèm ảnh/video...")
        ok, err_msg = await _attach_media_from_gallery(ctx, media_count=media_count)
        if not ok:
            return f"Failed: [create_post đính kèm] {err_msg}"

    # ── Bước bật ẩn danh (cho Group) ─────────────────────────────────────────
    # Khi đăng vào Facebook Group có bật anonymous mode: tap chip tên người
    # dùng ở đầu composer → bottom-sheet author hiện ra → tap "Đăng ẩn danh"
    # → xử lý disclaimer. Nếu group không hỗ trợ anonymous, fail thay vì im
    # lặng đăng dưới tên thật.
    if anonymous:
        logger.info("[facebook_create_post] Bật chế độ ẩn danh cho bài đăng group...")
        ok, err_msg = await _toggle_group_anonymous_mode(ctx, display_name)
        if not ok:
            return f"Failed: [create_post ẩn danh] {err_msg}"

    # ── Bước 5: Click nút Đăng hoặc Tiếp ───────────────────────────────────────
    try:
        ui_post = await ctx.state_provider.get_state()
        els_post = ui_post.elements if ui_post else []

        # THỨ TỰ TÌM NÚT — phần này từng gây hỏng 4 task liên tiếp ngày 08/09 nên
        # thứ tự dưới đây là cố ý, đừng đảo lại:
        #   1. khớp CHÍNH XÁC chữ trên nút ("Đăng"/"Post"/...);
        #   2. rồi mới tới nút "Tiếp"/"Next" của giao diện 2 bước;
        #   3. cuối cùng mới khớp chuỗi con, và bằng _find_post_button_loose()
        #      chứ KHÔNG dùng _find_element_by_keywords().
        #
        # Bản cũ để bước khớp-chuỗi-con ngay sau bước 1, trước cả "Tiếp". Khi
        # đính 4 ảnh thì composer chỉ có nút "Tiếp" (không có "Đăng"), khớp chính
        # xác trượt, rồi khớp chuỗi con trúng luôn Ô SOẠN BÀI — vì nội dung bài
        # có sẵn chữ "chia sẻ" và hàm chung so cả `text` lẫn `resource-id`. Tap
        # vào giữa ô soạn → Facebook mở màn hình "Thêm văn bản" → không đăng
        # được gì, nhánh "Tiếp" thì không bao giờ chạy tới.
        post_btn = _find_element_exact(els_post, *_POST_BTN_WORDS)

        # Nếu không thấy nút Đăng trực tiếp, tìm nút "Tiếp" / "Next" (đối với giao diện 2 bước)
        if post_btn is None:
            next_btn = _find_element_exact(els_post, "Tiếp", "Next")

            # CHƯA thấy cả "Đăng" lẫn "Tiếp" ngay ở lần đọc màn hình ĐẦU TIÊN.
            # Trước đây rơi thẳng xuống khớp-chuỗi-con rồi bỏ cuộc NGAY LẬP TỨC,
            # không hề chờ/quét lại lần nào — khác hẳn nhánh "Tiếp" 2 bước bên
            # dưới vốn đã có sẵn vòng chờ-và-quét-lại. Thống kê thực tế (11/09-
            # 14/09): 17/33 lỗi publish_profile_post là "Không tìm thấy nút Đăng
            # hoặc Tiếp", một số ghi rõ màn hình lúc đó "chỉ hiển thị nút Đóng".
            # Đây thường chỉ là trạng thái TẠM THỜI (dialog quyền truy cập ảnh,
            # bàn phím vừa đóng, overlay đang tải...) — quét lại vài lần trước
            # khi kết luận thất bại hẳn, dùng chung ngân sách chờ với nhánh dưới.
            if next_btn is None:
                for lan in range(_NEXT_SCREEN_TRIES):
                    # Màn gần như TRỐNG (≤ _MAN_TRONG_TOI_DA phần tử) — xác nhận
                    # thực tế 14/09 trên FS4BKA001553: đây là lớp phủ overlay XÁM
                    # che composer (đã thấy ở "Tiếp" bước 2, giờ gặp cả ở đây, trước
                    # khi tìm thấy Tiếp lần nào). Người vận hành kiểm tra tay: chạm
                    # giữa màn hình khoảng 3-4 lần thì lớp phủ biến mất, lộ ra bài
                    # đăng đã ở trạng thái chờ với nút Tiếp — CHỜ SUÔNG không đủ, cần
                    # chủ động chạm. Lặp lại mỗi vòng nếu màn vẫn trống (không giới
                    # hạn 1 lần như unstick Back ở nhánh dưới) để đủ số lần chạm cần.
                    if len(els_post) <= _MAN_TRONG_TOI_DA:
                        cx = (getattr(ui_post, "screen_width", None) or 720) // 2
                        cy = (getattr(ui_post, "screen_height", None) or 1600) // 2
                        logger.info(
                            "[facebook_create_post] Màn hiện tại chỉ có %d phần tử — "
                            "nghi overlay xám che composer, chạm giữa màn hình (%d, %d) "
                            "để thử gỡ (lần %d/%d)...",
                            len(els_post), cx, cy, lan + 1, _NEXT_SCREEN_TRIES,
                        )
                        await ctx.driver.tap(cx, cy)
                        await asyncio.sleep(1.5)
                    else:
                        logger.info(
                            "[facebook_create_post] Chưa thấy nút Đăng/Tiếp ở màn hiện tại "
                            "(%d phần tử) — có thể là trạng thái tạm thời, chờ %.0fs rồi "
                            "quét lại (lần %d/%d)...",
                            len(els_post), _NEXT_SCREEN_WAIT, lan + 1, _NEXT_SCREEN_TRIES,
                        )
                        await asyncio.sleep(_NEXT_SCREEN_WAIT)

                    ui_post = await ctx.state_provider.get_state()
                    els_post = ui_post.elements if ui_post else []
                    post_btn = _find_element_exact(els_post, *_POST_BTN_WORDS)
                    if post_btn is not None:
                        logger.info(
                            "[facebook_create_post] Thấy nút Đăng sau %d lần thử "
                            "(lần đọc đầu chỉ có màn hình tạm thời/overlay).",
                            lan + 1,
                        )
                        break
                    next_btn = _find_element_exact(els_post, "Tiếp", "Next")
                    if next_btn is not None:
                        logger.info(
                            "[facebook_create_post] Thấy nút Tiếp sau %d lần thử "
                            "(lần đọc đầu chỉ có màn hình tạm thời/overlay).",
                            lan + 1,
                        )
                        break

            if next_btn:
                idx_next = next_btn.get("index")
                if idx_next is not None:
                    x_n, y_n = ui_post.get_element_coords(idx_next)
                    logger.info(f"[facebook_create_post] Phát hiện giao diện 2 bước. Nhấn nút 'Tiếp' tại ({x_n}, {y_n})")
                    await ctx.driver.tap(x_n, y_n)

                    # CHỜ CÓ KIỂM TRA, không phải ngủ một phát rồi quét một lần.
                    # Bài có VIDEO đi qua màn "Cài đặt thước phim" (Reels) của
                    # Facebook, và màn đó phải xử lý xong video mới hiện nút
                    # "Chia sẻ ngay". Video 403 MB ngày 11/09 mất hơn 4 giây để
                    # dựng xong: quét đúng lúc 4 giây thì trên màn mới chỉ có mỗi
                    # nút "Đóng" (xem ảnh b05 của task 3564), tưởng là không có
                    # nút đăng rồi bỏ cuộc. Quét lại nhiều lần cho tới khi thấy.
                    da_go_lop_phu = False
                    for lan in range(_NEXT_SCREEN_TRIES):
                        await asyncio.sleep(_NEXT_SCREEN_WAIT)
                        ui_post = await ctx.state_provider.get_state()
                        els_post = ui_post.elements if ui_post else []
                        post_btn = (_find_element_exact(els_post, *_POST_BTN_WORDS)
                                    or _find_post_button_loose(els_post, content))
                        if post_btn is not None:
                            logger.info(
                                "[facebook_create_post] Thấy nút đăng ở màn thứ 2 sau %.0fs.",
                                (lan + 1) * _NEXT_SCREEN_WAIT,
                            )
                            break

                        # Bài VIDEO: màn thứ 2 là trang "Cài đặt thước phim", nhưng
                        # Facebook PHỦ LÊN TRÊN nó một trình phát video toàn màn hình
                        # (ImmersiveActivity). Lớp phủ đó không lộ nút nào cho bộ đọc
                        # giao diện — đo trên máy thật FS4BKA001553 ngày 11/09 (task
                        # 3565): cả màn chỉ có 11 node, đúng 1 node bấm được, nhãn
                        # "Đóng" nằm ở dải cao 24px sát đáy (là thanh điều hướng, bấm
                        # vào không ăn). Nên quét 8 lần 40 giây cũng chẳng thấy gì.
                        #
                        # Bấm Back MỘT lần là lớp phủ biến mất, lộ ra trang cài đặt với
                        # nút "Chia sẻ ngay" ở [32,1376][688,1472] — chữ này vốn đã nằm
                        # trong _POST_BTN_WORDS nên vòng quét sau sẽ tìm thấy ngay.
                        #
                        # Chỉ làm khi màn gần như TRỐNG, để không lỡ tay Back ở màn thứ 2
                        # bình thường của bài ảnh (trang chọn đối tượng — màn đó nhiều
                        # phần tử, Back là quay ngược về màn soạn bài).
                        #
                        # CẬP NHẬT 14/09: ảnh chụp thực tế trên FS4BKA001553 xác nhận
                        # màn hình sau lớp phủ là trang chia sẻ Reels ("Chia sẻ ngay",
                        # "Thêm sản phẩm", "Thêm nhãn AI"...) — và Back MỘT lần không
                        # phải lúc nào cũng đủ, người vận hành phải CHẠM màn hình 3-4
                        # lần mới gỡ được. Giữ Back làm lần thử đầu (đã có tiền lệ
                        # thành công), các lần sau nếu màn vẫn trống thì chuyển sang
                        # chạm giữa màn hình, lặp lại mỗi vòng cho tới khi hết lớp phủ.
                        if len(els_post) <= _MAN_TRONG_TOI_DA:
                            if not da_go_lop_phu:
                                logger.info(
                                    "[facebook_create_post] Màn thứ 2 chỉ có %d phần tử — nhiều khả năng là "
                                    "trình phát video phủ lên trang cài đặt. Bấm Back một lần để gỡ lớp phủ.",
                                    len(els_post),
                                )
                                await ctx.driver.press_button("back")
                                da_go_lop_phu = True
                            else:
                                cx = (getattr(ui_post, "screen_width", None) or 720) // 2
                                cy = (getattr(ui_post, "screen_height", None) or 1600) // 2
                                logger.info(
                                    "[facebook_create_post] Màn thứ 2 vẫn còn %d phần tử sau khi bấm Back — "
                                    "chạm giữa màn hình (%d, %d) để thử gỡ tiếp (lần %d/%d)...",
                                    len(els_post), cx, cy, lan + 1, _NEXT_SCREEN_TRIES,
                                )
                                await ctx.driver.tap(cx, cy)
                            continue

                        logger.info(
                            "[facebook_create_post] Màn thứ 2 chưa hiện nút đăng (lần %d/%d), chờ tiếp...",
                            lan + 1, _NEXT_SCREEN_TRIES,
                        )

        # Hết hai đường chính xác rồi mới chấp nhận khớp chuỗi con.
        if post_btn is None:
            post_btn = _find_post_button_loose(els_post, content)

        if post_btn is None:
            logger.warning("[facebook_create_post] Không tìm thấy nút Đăng hoặc Tiếp để hoàn tất bài viết.")
            return "Failed: Không tìm thấy nút Đăng hoặc Tiếp để hoàn tất bài viết."

        idx_post = post_btn.get("index")
        if idx_post is None:
            return "Failed: Nút Đăng không có index."

        x_p, y_p = ui_post.get_element_coords(idx_post)
        logger.info(f"[facebook_create_post] Tìm thấy nút Đăng: text={repr(post_btn.get('text'))}, desc={repr(post_btn.get('content-desc'))}, bounds={post_btn.get('bounds')}, tap tại ({x_p}, {y_p})")
        await ctx.driver.tap(x_p, y_p)
        logger.info(f"[facebook_create_post] Đã tap nút Đăng tại ({x_p}, {y_p})")

        logger.info("[facebook_create_post] Đang tải lên bài viết...")
        # Media nặng (video/ảnh lớn) cần thời gian upload xong mới hiển thị trên
        # feed để copy_post_link tìm được. Chờ lâu hơn khi có media; bài chỉ-chữ
        # lên gần như tức thì nên giữ nhanh.
        _post_wait = 60.0 if (has_media or media_path) else 15.0
        await asyncio.sleep(_post_wait)
    except Exception as e:
        return f"Failed: [create_post bước 5] Lỗi nhấn nút Đăng — {e}"

    # ── Bước 6: KIỂM TRA bài đã rời khỏi màn hình soạn chưa ───────────────────
    # Trước đây hàm này tap xong, ngủ, rồi trả về "Đăng bài thành công" mà KHÔNG
    # kiểm tra gì cả — nên một cú tap trượt cũng ra "thành công". Hậu quả thật
    # (08/09): copy_post_link đi tìm bài không có thật rồi báo lỗi, agent kết
    # luận sai, và máy bị bỏ lại ở màn hình soạn bài nên 3 task sau cũng hỏng
    # theo. Câu "thành công" phải có bằng chứng: ô soạn còn giữ nội dung bài
    # nghĩa là bài CHƯA đăng.
    for lan in range(_POST_VERIFY_TRIES):
        if not await _composer_still_open(ctx, content):
            logger.info("[facebook_create_post] Màn hình soạn bài đã đóng — bài đã được đăng.")
            return f"Đăng bài thành công với nội dung: '{content}'"
        logger.info(
            "[facebook_create_post] Ô soạn bài vẫn còn nội dung (lần %d/%d) — chờ %.0fs rồi kiểm tra lại...",
            lan + 1, _POST_VERIFY_TRIES, _POST_VERIFY_WAIT,
        )
        await asyncio.sleep(_POST_VERIFY_WAIT)

    logger.warning(
        "[facebook_create_post] Đã tap nút đăng nhưng màn hình soạn bài vẫn mở sau %.0fs "
        "→ bài KHÔNG được đăng. Trả về Failed để agent dừng, thay vì báo thành công sai.",
        _POST_VERIFY_TRIES * _POST_VERIFY_WAIT,
    )

    # Chụp lại các text đang hiển thị lúc fail (vd dialog cảnh báo trùng lặp/
    # sự cố của Facebook mà tool chưa biết nhận diện) để việc debug sau này có
    # manh mối thật thay vì phải đoán từ log chung chung (xem task 3591: fail
    # ở lần đăng lại thứ 2, không rõ nguyên nhân do thiếu thông tin này).
    # KHÔNG suy diễn ý nghĩa các dòng text này — chỉ ghi lại nguyên văn.
    extra_hint = ""
    try:
        ui_final = await ctx.state_provider.get_state()
        texts: list[str] = []
        for el in (ui_final.elements if ui_final else []):
            t = (el.get("text") or el.get("content-desc") or "").strip()
            if t and len(t) < 120 and t not in texts:
                texts.append(t)
            if len(texts) >= 12:
                break
        if texts:
            extra_hint = " Nội dung màn hình lúc đó: " + " | ".join(texts)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[facebook_create_post] Không chụp được màn hình lúc fail: %s", exc)

    return (
        "Failed: Đã bấm nút đăng nhưng màn hình soạn bài vẫn còn mở với nội dung bài "
        "— bài chưa được đăng. Kiểm tra lại nút đăng trên màn hình soạn bài."
        + extra_hint
    )



_FB_URL_RE = None  # lazy compile


def _extract_fb_post_url(text: str) -> str:
    """Pick the first Facebook post URL from arbitrary clipboard text."""
    global _FB_URL_RE
    if _FB_URL_RE is None:
        import re
        _FB_URL_RE = re.compile(r'https?://(?:m\.|www\.|web\.)?facebook\.com/\S+', re.IGNORECASE)
    if not text:
        return ''
    m = _FB_URL_RE.search(text)
    return m.group(0).rstrip('.,);]') if m else ''


async def _capture_last_post_url(ctx) -> str:
    """After a successful timeline post, navigate to the user's profile, open
    the latest post's ⋯ menu, tap "Sao chép liên kết", read clipboard, parse
    a Facebook URL. Returns the URL or '' on any failure.

    Caller MUST NOT block on this — wrap in try/except + treat empty as OK.
    Not used for anonymous group posts (the ⋯ menu does not expose copy-link
    to the anonymous author).
    """
    try:
        ok, err = await _open_personal_profile(ctx)
        if not ok:
            logger.info("[capture_post_url] skip — open profile failed: %s", err)
            return ''
        # Wait for timeline to settle, then look for the ⋯ button on the
        # first (newest) post card. FB labels it "Tác vụ khác cho bài viết của …".
        await asyncio.sleep(3.0)
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        more_btn = _find_element_by_keywords(
            els, "Tác vụ khác cho bài viết", "More actions", "Hành động khác",
        )
        if more_btn is None:
            logger.info("[capture_post_url] skip — không tìm thấy nút ⋯ trên post mới.")
            return ''
        idx = more_btn.get("index")
        if idx is None:
            return ''
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)

        ui_menu = await ctx.state_provider.get_state()
        els_menu = ui_menu.elements if ui_menu else []
        copy_btn = _find_element_by_keywords(
            els_menu, "Sao chép liên kết", "Copy link",
        )
        if copy_btn is None:
            logger.info("[capture_post_url] skip — không tìm thấy 'Sao chép liên kết'.")
            await ctx.driver.press_button("back")
            return ''
        idx_copy = copy_btn.get("index")
        if idx_copy is None:
            await ctx.driver.press_button("back")
            return ''
        x2, y2 = ui_menu.get_element_coords(idx_copy)
        await ctx.driver.tap(x2, y2)
        await asyncio.sleep(1.5)

        clip = await _read_clipboard(ctx)
        url = _extract_fb_post_url(clip)
        if url:
            logger.info("[capture_post_url] OK: %s", url[:80])
        else:
            logger.info("[capture_post_url] clipboard=%r — không parse được URL.", clip[:100])
        return url
    except Exception as e:
        logger.warning("[capture_post_url] lỗi không bắt được URL — %s", e)
        return ''


async def _find_own_recent_post_element(ctx, author_names: list[str], is_group: bool = False):
    """Tìm phần tử nhãn thời gian/3-chấm của bài viết vừa đăng.

    Chiến lược: Quét tìm nhãn thời gian "vừa xong" hoặc "just now" trên màn hình.
    - Với group (is_group=True): Tìm 3-chấm gần nhãn "vừa xong".
    - Với profile/page (is_group=False): Trả về chính nhãn "vừa xong".
    Không phụ thuộc vào việc khớp tên tác giả để tránh lệch ký tự hoặc dấu tiếng Việt.
    """
    dots_kws = ["lựa chọn khác", "more options", "lựa chọn khác cho bài viết"]
    very_recent_kws = ["vừa xong", "just now"]

    # Tăng thời gian chờ (8 lần thử, mỗi lần cách nhau 10 giây = 80 giây tối đa)
    for attempt in range(1, 9):
        logger.info(
            "[_find_own_recent_post_element] Thử tìm bài viết vừa xong (Lần %d/8)...",
            attempt
        )
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []

        if is_group:
            # Tìm node "vừa xong", sau đó quét lân cận ±10 để tìm nút 3 chấm
            for i, el in enumerate(els):
                val = ((el.get("text") or "") + " " + (el.get("content-desc") or "")).lower()
                if any(kw in val for kw in very_recent_kws):
                    # Tìm nút 3 chấm xung quanh index của nhãn "vừa xong"
                    start = max(0, i - 10)
                    end = min(len(els), i + 11)
                    for j in range(start, end):
                        check = ((els[j].get("text") or "") + " " + (els[j].get("content-desc") or "")).lower()
                        if any(kw in check for kw in dots_kws):
                            logger.info(
                                "[_find_own_recent_post_element] Tìm thấy nút 3 chấm của bài đăng vừa xong tại index %d",
                                j
                            )
                            return els[j], ui
        else:
            # Profile / Fanpage: Tìm và trả về chính node chứa nhãn "vừa xong" / "just now"
            for i, el in enumerate(els):
                val = ((el.get("text") or "") + " " + (el.get("content-desc") or "")).lower()
                if any(kw in val for kw in very_recent_kws) and len(val) < 50:
                    logger.info(
                        "[_find_own_recent_post_element] Tìm thấy nhãn thời gian 'vừa xong' tại index %d: %r",
                        i, val
                    )
                    return el, ui

        # Đợi 10 giây trước khi quét lại
        await asyncio.sleep(10.0)

    return None, None



async def facebook_copy_post_link(
    profile_name: str,
    content: str,
    post_type: str = "Trang cá nhân",
    target_name: str = None,
    *,
    ctx,
    **kwargs
) -> str:
    """Đợi bài viết vừa đăng hiển thị, tìm theo nội dung bài đăng (≥80% khớp từ vựng),
    bấm xem chi tiết, sao chép liên kết qua clipboard và trả về.

    Args:
        profile_name: Tên gọi thân thiện của tài khoản (VD: 'Lemon').
        content: Nội dung bài đăng cần tìm để đối chiếu.
        post_type: Loại bài đăng ('Trang cá nhân', 'Nhóm', 'Page').
        target_name: Tên Nhóm hoặc Page tương ứng nếu post_type là Nhóm hoặc Page.
    """
    if not content or not content.strip():
        return "Failed: Nội dung bài đăng (content) không được để trống."

    # Sử dụng trực tiếp profile_name làm display_name
    display_name = profile_name

    ptype = post_type.strip().lower() if post_type else "profile"
    if ptype in ("trang cá nhân", "profile", "cá nhân"):
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]
    elif ptype in ("nhóm", "group"):
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]
    elif ptype in ("page", "fanpage", "trang"):
        if not target_name:
            return "Failed: Copy link bài viết fanpage yêu cầu tham số target_name (tên fanpage)."
        author_names = [target_name]
    else:
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]

    logger.info(f"[facebook_copy_post_link] Bắt đầu quét link bài viết vừa đăng cho tác giả {author_names}...")

    # ── Tìm bài viết theo nội dung (≥80% khớp từ vựng) ──
    target_words = _clean_text_for_matching(content)
    target_words_set = set(target_words)
    # Thước đo thứ hai: chỉ phần đầu bài. Đạt MỘT trong hai là khớp — xem
    # _head_words_for_matching để biết vì sao thước đo toàn bài không đủ.
    head_words_set = set(_head_words_for_matching(content))

    matched_block = None
    ui_matched = None

    # 12 x 6s = 72s (trước đây 8 x 5s = 40s). Bài kèm VIDEO có thể mất hơn 40s
    # để Facebook xử lý/hiển thị xong trên feed (xem task 3589: video, quét đủ
    # 8 lần vẫn không thấy) — tăng thời gian chờ để giảm khả năng "không tìm
    # thấy" giả (false negative) do timing, vốn dễ bị hiểu nhầm là đăng thất bại.
    _SCAN_TRIES = 12
    _SCAN_WAIT = 6.0
    for attempt in range(_SCAN_TRIES):
        logger.info(f"[facebook_copy_post_link] Đang quét màn hình (Lần {attempt+1}/{_SCAN_TRIES})...")
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []

        # Phân tích các khối bài viết trên màn hình
        blocks = _parse_post_blocks(els, author_names)
        logger.info(f"[facebook_copy_post_link] Tìm thấy {len(blocks)} khối bài viết của {author_names} trên màn hình.")

        for block in blocks:
            c_text = (block.content_el.get("text") or block.content_el.get("content-desc") or "").strip()

            c_words = set(_clean_text_for_matching(c_text))
            overlap = c_words.intersection(target_words_set)
            ratio = len(overlap) / len(target_words_set) if target_words_set else 0.0
            head_overlap = c_words.intersection(head_words_set)
            head_ratio = len(head_overlap) / len(head_words_set) if head_words_set else 0.0

            logger.info(
                f"[facebook_copy_post_link] Kiểm tra bài viết - Tác giả: {block.author_el.get('text') or block.author_el.get('content-desc')}, "
                f"Nội dung: {repr(c_text[:60])}..., Tỷ lệ khớp: {ratio:.4f} ({len(overlap)}/{len(target_words_set)} từ) "
                f"· phần đầu: {head_ratio:.4f} ({len(head_overlap)}/{len(head_words_set)} từ)"
            )

            if ratio >= 0.8 or head_ratio >= 0.8:
                logger.info(
                    "[facebook_copy_post_link] Khớp bài viết trực tiếp: toàn bài=%.2f, phần đầu=%.2f",
                    ratio, head_ratio,
                )
                matched_block = block
                ui_matched = ui
                break

        if matched_block is not None:
            break

        # Chưa tìm thấy → đợi rồi quét lại (không cuộn). Vòng quét này chính là
        # chỗ ĐỢI bài hiện lên sau khi đăng — bài kèm ảnh/video cần thời gian
        # upload/xử lý mới hiển thị trên feed.
        logger.info(
            f"[facebook_copy_post_link] Chưa tìm thấy bài viết trùng khớp, đợi {_SCAN_WAIT:.0f}s rồi thử lại..."
        )
        await asyncio.sleep(_SCAN_WAIT)

    if matched_block is None:
        # LƯU Ý QUAN TRỌNG cho agent gọi tool này: lỗi "không tìm thấy" ở đây
        # KHÔNG XÁC NHẬN được bài đã đăng hay chưa theo CẢ HAI CHIỀU — tool này
        # chỉ quét lại đúng vùng màn hình hiện tại (không điều hướng sang Trang
        # cá nhân, không cuộn) nên có thể trượt dù bài đã lên thật (đang xử lý
        # media, bị đẩy ra ngoài khung nhìn...); NHƯNG cũng có case thật (task
        # 3680, 28/09) nơi facebook_create_post báo "thành công" (chỉ vì ô soạn
        # bài đóng lại) mà bài KHÔNG hề tồn tại trên trang cá nhân — tức
        # "composer đóng" không phải bằng chứng đủ mạnh để khẳng định đã đăng.
        # TUYỆT ĐỐI KHÔNG gọi lại facebook_create_post với cùng nội dung để
        # "thử lại" khi gặp lỗi này — nếu bài THẬT SỰ đã lên thì sẽ tạo bài đăng
        # TRÙNG LẶP thật trên trang cá nhân. Và TUYỆT ĐỐI KHÔNG tự suy luận
        # "chắc là đã đăng thành công, chỉ lỗi lấy link" rồi báo tác vụ
        # completed/success — phải báo toàn bộ tác vụ là FAILED để người vận
        # hành kiểm tra thủ công trang cá nhân trước khi quyết định đăng lại.
        return (
            f"Failed: Không tìm thấy bài viết vừa đăng trên {post_type} (đã quét "
            f"{_SCAN_TRIES} lần trên màn hình hiện tại, không khớp ≥80% nội dung). "
            f"KHÔNG XÁC NHẬN được bài đã đăng hay chưa (có thể đã đăng thành công "
            f"mà lỗi ở bước lấy link, HOẶC composer đóng nhưng bài chưa từng được "
            f"tạo — cả hai đều đã từng xảy ra thật). KHÔNG được đăng lại cùng nội "
            f"dung; PHẢI báo cáo toàn bộ tác vụ là THẤT BẠI (không phải thành công) "
            f"và dừng tác vụ để kiểm tra thủ công."
        )

    # ── Phương án 1: Click nút 3 chấm trực tiếp trên feed → Sao chép liên kết ──
    three_dots_el = matched_block.three_dots_el
    if three_dots_el is not None:
        idx_3d = three_dots_el.get("index")
        if idx_3d is not None:
            x_3d, y_3d = ui_matched.get_element_coords(idx_3d)
            logger.info(f"[facebook_copy_post_link] Nhấn nút 3 chấm của bài viết tại ({x_3d}, {y_3d}) để mở menu")
            await ctx.driver.tap(x_3d, y_3d)
            await asyncio.sleep(3.5)

            # Quét bottom sheet và click Sao chép liên kết
            ui_sheet = await ctx.state_provider.get_state()
            els_sheet = ui_sheet.elements if ui_sheet else []
            copy_btn = _find_element_by_keywords(
                els_sheet,
                "Sao chép liên kết",
                "Copy link",
                "Copy Link"
            )
            if copy_btn is not None:
                idx_copy = copy_btn.get("index")
                if idx_copy is not None:
                    x_c, y_c = ui_sheet.get_element_coords(idx_copy)
                    logger.info(f"[facebook_copy_post_link] Click nút Sao chép liên kết tại ({x_c}, {y_c})")
                    await ctx.driver.tap(x_c, y_c)
                    await asyncio.sleep(3.0)

                    res = await _read_clipboard_and_sync_link(profile_name, ctx)
                    if not res.startswith("Failed"):
                        return res
                    logger.warning(f"[facebook_copy_post_link] Copy trực tiếp thất bại: {res}. Sẽ thử cách vào chi tiết...")

            # Nếu bấm 3 chấm trực tiếp không có hoặc lỗi, bấm Back để đóng sheet trước khi fallback
            logger.info("[facebook_copy_post_link] Đóng menu Lựa chọn khác (bấm back) để chuyển sang dự phòng...")
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.5)

    # ── Phương án 2 (Fallback): Nhấn vào nhãn thời gian để vào chi tiết ──
    timestamp_el = matched_block.timestamp_el
    if timestamp_el is not None:
        idx_ts = timestamp_el.get("index")
        if idx_ts is not None:
            x_ts, y_ts = ui_matched.get_element_coords(idx_ts)
            logger.info(f"[facebook_copy_post_link] [Fallback] Nhấn nhãn thời gian '{timestamp_el.get('text')}' tại ({x_ts}, {y_ts}) để vào chi tiết")
            await ctx.driver.tap(x_ts, y_ts)
            await asyncio.sleep(4.5)
            return await _copy_link_from_opened_post(profile_name, ctx)

    return "Failed: Tìm thấy bài viết nhưng không có nhãn thời gian hoặc nút 3 chấm để mở chi tiết."


async def _read_clipboard_and_sync_link(profile_name: str, ctx) -> str:
    """Đọc clipboard từ ADB, đồng bộ link bài đăng lên API Backend, và trả về kết quả."""
    copied_link = await _read_clipboard(ctx)
    logger.info(f"[_read_clipboard_and_sync_link] Clipboard từ ADB: {copied_link}")

    # Chỉ chấp nhận khi clipboard chứa URL Facebook thật — tránh đẩy text lỗi
    # ClipboardService ("No items ... SecurityException") lên raw_context/Kafka.
    copied_link = _extract_fb_post_url((copied_link or "").replace("\\/", "/"))

    if copied_link:
        logger.info(f"[_read_clipboard_and_sync_link] Lấy link bài viết thành công: {copied_link}")

        # Plan A — đồng bộ link KHÔNG dùng API key:
        # Nhét link vào raw_context['post_url'] để task_executor emit lên Kafka
        # task_status; devices_worker sẽ mirror vào
        # FacebookProfileScheduledPost.fb_post_id theo fb_scheduled_post_id
        # (resolve owner sẵn trong DB — không cần key per-account trong .env).
        try:
            from task_context import get_raw_context
            get_raw_context()["post_url"] = copied_link
            logger.info("[_read_clipboard_and_sync_link] Đã nhét post_url vào raw_context để mirror keyless.")
        except Exception as e:
            logger.warning(f"[_read_clipboard_and_sync_link] Không stamp được post_url vào raw_context: {e}")

        try:
            logger.info("[_read_clipboard_and_sync_link] Đóng ứng dụng Facebook bằng force-stop...")
            await ctx.driver.device.shell("am force-stop com.facebook.katana")
        except Exception as e:
            logger.warning(f"[_read_clipboard_and_sync_link] Lỗi force-stop: {e}")

        return f"Link bài viết: {copied_link}"
    else:
        return "Failed: Không lấy được link bài viết (clipboard rỗng hoặc không chứa URL Facebook)."


async def _copy_link_from_opened_post(profile_name: str, ctx) -> str:
    """Sao chép liên kết từ trang chi tiết bài viết đang mở và đồng bộ lên API."""
    # 2. Thử cách 1: Tìm nút 3 chấm "Lựa chọn khác" (More options)
    ui_more_screen = await ctx.state_provider.get_state()
    els_more_screen = ui_more_screen.elements if ui_more_screen else []
    
    more_btn = _find_element_by_keywords(
        els_more_screen,
        "Lựa chọn khác cho bài viết",
        "Lựa chọn khác",
        "More options"
    )
    
    link_copied = False
    if more_btn is not None:
        idx_more = more_btn.get("index")
        if idx_more is not None:
            x_m, y_m = ui_more_screen.get_element_coords(idx_more)
            logger.info(f"[facebook_copy_post_link] Nhấn nút Lựa chọn khác (3 chấm) tại ({x_m}, {y_m})")
            await ctx.driver.tap(x_m, y_m)
            await asyncio.sleep(3.5)
            
            # Quét bottom sheet tìm "Sao chép liên kết"
            ui_copy_sheet = await ctx.state_provider.get_state()
            els_copy_sheet = ui_copy_sheet.elements if ui_copy_sheet else []
            
            copy_btn = _find_element_by_keywords(
                els_copy_sheet,
                "Sao chép liên kết",
                "Copy link",
                "Copy Link"
            )
            if copy_btn is not None:
                idx_copy = copy_btn.get("index")
                if idx_copy is not None:
                    x_c, y_c = ui_copy_sheet.get_element_coords(idx_copy)
                    logger.info(f"[facebook_copy_post_link] Nhấn nút Sao chép liên kết trong menu 3 chấm tại ({x_c}, {y_c})")
                    await ctx.driver.tap(x_c, y_c)
                    await asyncio.sleep(3.0)
                    link_copied = True

    # 3. Thử cách 2 (Fallback): Cuộn xuống và dùng nút "Chia sẻ" (Share)
    if not link_copied:
        logger.info("[facebook_copy_post_link] Không thể sao chép qua menu 3 chấm, chuyển sang cách cuộn tìm nút Chia sẻ...")
        share_btn = None
        ui_share_screen = None
        for scroll_attempt in range(5):
            ui_share_screen = await ctx.state_provider.get_state()
            els_share_screen = ui_share_screen.elements if ui_share_screen else []
            
            for el in els_share_screen:
                txt = (el.get("text") or "").strip()
                desc = (el.get("content-desc") or "").strip()
                if "chia sẻ với" in txt.lower() or "chia sẻ với" in desc.lower():
                    continue
                if txt in ("Chia sẻ", "Share") or "nút chia sẻ" in txt.lower() or "nút chia sẻ" in desc.lower():
                    share_btn = el
                    break
                    
            if share_btn is not None:
                break
                
            logger.info(f"[facebook_copy_post_link] Chưa thấy nút Chia sẻ, tiến hành cuộn xuống (Lần {scroll_attempt+1}/5)...")
            await ctx.driver.swipe(360, 1200, 360, 400, duration_ms=800)
            await asyncio.sleep(1.5)

        if share_btn is None:
            return "Failed: Không quét thấy nút Chia sẻ của bài viết."

        idx_share = share_btn.get("index")
        if idx_share is None:
            return "Failed: Nút chia sẻ không có index."

        x_s, y_s = ui_share_screen.get_element_coords(idx_share)
        logger.info(f"[facebook_copy_post_link] Nhấn nút Chia sẻ tại ({x_s}, {y_s})")
        await ctx.driver.tap(x_s, y_s)
        await asyncio.sleep(4.0)

        # Tìm nút Sao chép liên kết trong menu chia sẻ
        ui_copy_screen = await ctx.state_provider.get_state()
        els_copy_screen = ui_copy_screen.elements if ui_copy_screen else []
        
        copy_link_btn = _find_element_by_keywords(
            els_copy_screen,
            "Sao chép liên kết",
            "copy link",
            "Copy link",
            "Copy Link"
        )

        if copy_link_btn is None:
            return "Failed: Không tìm thấy nút Sao chép liên kết trong menu chia sẻ."

        idx_copy = copy_link_btn.get("index")
        if idx_copy is None:
            return "Failed: Nút sao chép liên kết không có index."

        x_c, y_c = ui_copy_screen.get_element_coords(idx_copy)
        logger.info(f"[facebook_copy_post_link] Nhấn nút Sao chép liên kết tại ({x_c}, {y_c})")
        await ctx.driver.tap(x_c, y_c)
        await asyncio.sleep(3.0)

    return await _read_clipboard_and_sync_link(profile_name, ctx)


async def facebook_find_and_copy_post_link(
    profile_name: str,
    content: str,
    post_type: str = None,
    target_name: str = None,
    *,
    ctx,
    **kwargs
) -> str:
    """Tìm kiếm bài viết trên Facebook dựa trên nội dung, loại bài viết (Trang cá nhân, Nhóm, Page) và tài khoản,
    xem rộng toàn bộ bài viết nếu có nút xem thêm, đối chiếu độ khớp từ vựng >= 30%,
    sau đó click vào bài để mở chi tiết, và sao chép link đồng bộ lên backend.
    """
    if not content or not content.strip():
        return "Failed: Nội dung tìm kiếm không được để trống."

    # Sử dụng trực tiếp profile_name làm display_name
    display_name = profile_name

    # Chuẩn hóa loại bài đăng
    ptype = post_type.strip().lower() if post_type else ""
    if ptype in ("trang cá nhân", "profile", "cá nhân"):
        ptype = "profile"
    elif ptype in ("nhóm", "group"):
        ptype = "group"
        if not target_name:
            return "Failed: Tìm kiếm bài đăng nhóm yêu cầu phải có tham số target_name (tên nhóm)."
    elif ptype in ("page", "fanpage", "trang"):
        ptype = "fanpage"
        if not target_name:
            return "Failed: Tìm kiếm bài đăng fanpage yêu cầu phải có tham số target_name (tên fanpage)."
    else:
        # post_type không rõ hoặc bị bỏ trống
        ptype = "profile"

    # Guard: nếu ptype đã normalize thành "profile" nhưng lại có target_name
    # → gần như chắc chắn executor quên truyền post_type cho group/fanpage
    if ptype == "profile" and target_name:
        return (
            f"Failed: Có target_name='{target_name}' nhưng post_type='{post_type}' được hiểu là 'Trang cá nhân'. "
            "Nếu đây là bài nhóm, hãy truyền post_type='Nhóm'. Nếu là fanpage, truyền post_type='Fanpage'. "
            "Nếu thực sự muốn tìm trên trang cá nhân, bỏ tham số target_name đi."
        )

    # Xác định danh sách tên tác giả hiển thị phù hợp cho loại bài đăng
    author_names = []
    if ptype == "profile":
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]
    elif ptype == "group":
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]
    elif ptype == "fanpage":
        author_names = [target_name]
    else:
        author_names = [display_name, "thành viên ẩn danh", "người tham gia ẩn danh", "anonymous", "ẩn danh"]

    logger.info(f"[facebook_find_and_copy_post_link] Bắt đầu tìm bài viết loại {ptype} (target_name={target_name}) cho tài khoản '{display_name}'...")

    # ── Bước 1: Điều hướng tới nơi cần quét bài viết ──
    if ptype == "profile":
        # Vuốt nhẹ xuống để lộ ra thanh tab bar (nếu đang bị ẩn)
        try:
            await ctx.driver.device.shell("input swipe 350 400 350 900")
            await asyncio.sleep(1.5)
        except Exception as se:
            logger.warning("[facebook_find_and_copy_post_link] Lỗi khi thực hiện vuốt nhẹ xuống: %s", se)

        ok, err = await _open_personal_profile(ctx)
        if not ok:
            return f"Failed: [find_and_copy_post_link profile navigation] {err}"

    elif ptype == "group":
        # Điều hướng trực tiếp vào Nhóm
        logger.info(f"[facebook_find_and_copy_post_link] Điều hướng vào nhóm: {target_name}...")
        nav_res = await facebook_navigate_to_group(group_name=target_name, ctx=ctx)
        if nav_res.lower().startswith("failed"):
            return f"Failed: [find_and_copy_post_link group navigation] {nav_res}"

    elif ptype == "fanpage":
        # Để quét bài đăng trên Fanpage chính chủ, chuyển đổi tài khoản sang Fanpage đó trước
        # (tương tự như trong _post_to_own_fanpage)
        # 1. Đi tới tab menu 6/6
        try:
            ui_init = await ctx.state_provider.get_state()
            els_init = ui_init.elements if ui_init else []
            menu_tab = _find_element_by_keywords(els_init, "Đi tới trang cá nhân", "Trang cá nhân, Tab 6/6")
            if menu_tab:
                idx = menu_tab.get("index")
                if idx is not None:
                    x, y = ui_init.get_element_coords(idx)
                    await ctx.driver.tap(x, y)
                    await asyncio.sleep(3.0)
                    
                    # Quét lại UI xem đã mở Menu chưa hay lỡ vào Trang cá nhân
                    ui_check = await ctx.state_provider.get_state()
                    els_check = ui_check.elements if ui_check else []
                    menu_btn_2 = _find_element_by_keywords(els_check, "Menu")
                    if menu_btn_2:
                        idx_m2 = menu_btn_2.get("index")
                        if idx_m2 is not None:
                            x, y = ui_check.get_element_coords(idx_m2)
                            await ctx.driver.tap(x, y)
                            await asyncio.sleep(3.0)
            else:
                return "Failed: Không tìm thấy nút Menu hoặc Trang cá nhân Tab 6/6."
        except Exception as e:
            return f"Failed: [find_and_copy_post_link fanpage navigation] Lỗi mở Menu — {e}"

        # 2. Tap chuyển đổi tài khoản
        try:
            ui_menu = await ctx.state_provider.get_state()
            els_menu = ui_menu.elements if ui_menu else []
            switch_btn = _find_element_by_keywords(els_menu, "Hãy mở công cụ chuyển trang cá nhân")
            if switch_btn is None:
                switch_btn = _find_element_by_keywords(els_menu, target_name)
            if switch_btn is None:
                return f"Failed: [find_and_copy_post_link fanpage navigation] Không thấy nút chuyển đổi sang {target_name}"
            
            idx_sw = switch_btn.get("index")
            x, y = ui_menu.get_element_coords(idx_sw)
            await ctx.driver.tap(x, y)
            await asyncio.sleep(2.5)
            
            # Chọn Fanpage trong popup
            ui_popup = await ctx.state_provider.get_state()
            els_popup = ui_popup.elements if ui_popup else []
            page_option = _find_element_exact(els_popup, target_name) or _find_element_by_keywords(els_popup, target_name)
            if page_option is None:
                return f"Failed: Không tìm thấy Fanpage '{target_name}' trong danh sách tài khoản."
            
            idx_pg = page_option.get("index")
            x, y = ui_popup.get_element_coords(idx_pg)
            await ctx.driver.tap(x, y)
            logger.info(f"[facebook_find_and_copy_post_link] Đang đợi chuyển đổi sang Fanpage '{target_name}'...")
            await asyncio.sleep(6.0)

            # 3. Mở profile của Fanpage đó
            ok, err = await _open_personal_profile(ctx)
            if not ok:
                return f"Failed: [find_and_copy_post_link fanpage profile] {err}"
        except Exception as e:
            return f"Failed: [find_and_copy_post_link fanpage navigation] Lỗi chuyển tài khoản — {e}"

    # ── Bước 2: Vòng lặp tìm kiếm bài đăng bằng cách cuộn màn hình ──
    target_words = _clean_text_for_matching(content)
    target_words_set = set(target_words)
    # Thước đo thứ hai: chỉ phần đầu bài. Đạt MỘT trong hai là khớp — xem
    # _head_words_for_matching để biết vì sao thước đo toàn bài không đủ.
    head_words_set = set(_head_words_for_matching(content))

    matched_block = None
    ui_matched = None

    for scroll_attempt in range(30):
        logger.info(f"[facebook_find_and_copy_post_link] Đang quét màn hình (Lần {scroll_attempt+1}/30)...")
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []

        # Log ra tất cả các text hiển thị tìm thấy trên màn hình để debug
        found_texts = []
        for el in els:
            t = (el.get("text") or el.get("content-desc") or "").strip()
            if t:
                truncated = (t[:100] + "...") if len(t) > 100 else t
                found_texts.append(f"Idx {el.get('index')}: '{truncated}'")
        if found_texts:
            logger.info("[facebook_find_and_copy_post_link] UI quét được:\n  - " + "\n  - ".join(found_texts))
        else:
            logger.info("[facebook_find_and_copy_post_link] UI quét được rỗng (không có text nào).")

        # Phân tích các khối bài viết trên màn hình
        blocks = _parse_post_blocks(els, author_names)
        
        for block in blocks:
            c_text = (block.content_el.get("text") or block.content_el.get("content-desc") or "").strip()
            c_text_lower = c_text.lower()
            
            # Kiểm tra xem bài đăng có chứa nút Xem thêm không
            has_see_more = block.see_more_el is not None
            
            if has_see_more:
                # ── Nhánh A: Bài viết bị rút gọn ──
                # Bấm Xem thêm cho bất kỳ bài viết nào để mở rộng rồi kiểm tra sau
                target_idx = block.see_more_el.get("index")
                if target_idx is None:
                    continue
                    
                x_sm, y_sm = ui.get_element_coords(target_idx)
                # Bỏ qua nếu nút xem thêm sát đáy màn hình
                if y_sm > (ui.screen_height - 150):
                    logger.info("[facebook_find_and_copy_post_link] Nút Xem thêm sát đáy Y=%d, bỏ qua để cuộn tiếp.", y_sm)
                    continue
                    
                logger.info(
                    "[facebook_find_and_copy_post_link] Tap 'Xem thêm' tại (%d, %d) để mở rộng bài viết...",
                    x_sm, y_sm,
                )
                await ctx.driver.tap(x_sm, y_sm)
                await asyncio.sleep(2.5)
                
                # Quét lại UI sau khi mở rộng
                ui_expanded = await ctx.state_provider.get_state()
                els_expanded = ui_expanded.elements if ui_expanded else []
                
                # Phân tích lại các khối bài viết trên màn hình mới
                expanded_blocks = _parse_post_blocks(els_expanded, author_names)
                best_block = None
                best_ratio = 0.0
                
                for exp_block in expanded_blocks:
                    exp_text = (exp_block.content_el.get("text") or exp_block.content_el.get("content-desc") or "").strip()
                    exp_words = set(_clean_text_for_matching(exp_text))
                    overlap_exp = exp_words.intersection(target_words_set)
                    ratio = len(overlap_exp) / len(target_words_set) if target_words_set else 0.0
                    # Bấm "Xem thêm" có thể không ăn (nút trôi, bài quá dài vẫn
                    # cắt) → vẫn phải chấp nhận thước đo phần đầu như vòng quét
                    # chính, nếu không thì mở rộng xong vẫn trượt.
                    head_ratio_exp = (
                        len(exp_words.intersection(head_words_set)) / len(head_words_set)
                        if head_words_set else 0.0
                    )
                    ratio = max(ratio, head_ratio_exp)
                    if ratio > best_ratio:
                        best_ratio = ratio
                        best_block = exp_block
                        
                if best_block and best_ratio >= 0.8:
                    logger.info(
                        "[facebook_find_and_copy_post_link] Khớp bài viết sau mở rộng: ratio=%.2f >= 0.8",
                        best_ratio,
                    )
                    matched_block = best_block
                    ui_matched = ui_expanded
                    break
                else:
                    logger.info(
                        "[facebook_find_and_copy_post_link] Sau khi mở rộng vẫn không khớp (best_ratio=%.2f), tiếp tục tìm.",
                        best_ratio,
                    )
                    continue
            else:
                # ── Nhánh B: Bài viết đầy đủ, so sánh trực tiếp ──
                # Bỏ qua các element sát rìa màn hình
                idx_el = block.content_el.get("index")
                if idx_el is not None:
                    _, y_el = ui.get_element_coords(idx_el)
                    if y_el < 150 or y_el > (ui.screen_height - 150):
                        continue
                        
                c_words = set(_clean_text_for_matching(c_text))
                overlap = c_words.intersection(target_words_set)
                ratio = len(overlap) / len(target_words_set) if target_words_set else 0.0
                
                if ratio >= 0.8:
                    logger.info(
                        "[facebook_find_and_copy_post_link] Khớp bài viết trực tiếp: ratio=%.2f >= 0.8",
                        ratio,
                    )
                    matched_block = block
                    ui_matched = ui
                    break
                    
        if matched_block is not None:
            break
            
        # Nếu không tìm thấy, cuộn màn hình xuống dưới để tìm tiếp
        logger.info(f"[facebook_find_and_copy_post_link] Chưa tìm thấy bài viết trùng khớp, tiến hành cuộn xuống...")
        await ctx.driver.swipe(360, 1200, 360, 400, duration_ms=800)
        await asyncio.sleep(2.5)

    if matched_block is None:
        return f"Failed: Không tìm thấy bài đăng phù hợp trên {ptype} '{target_name or display_name}'."

    # ── Bước 3: Tìm nút 3 chấm ("Lựa chọn khác" / "More options") của chính bài viết đó ──
    three_dots_el = matched_block.three_dots_el
    
    # ── Bước 4: Thực hiện Sao chép liên kết ──
    # Ưu tiên 1: Bấm nút 3 chấm trực tiếp trên dòng thời gian/bảng tin và chọn Sao chép liên kết
    if three_dots_el is not None:
        idx_3d = three_dots_el.get("index")
        if idx_3d is not None:
            x_3d, y_3d = ui_matched.get_element_coords(idx_3d)
            logger.info(f"[facebook_find_and_copy_post_link] Click nút 3 chấm tại ({x_3d}, {y_3d}) để mở menu")
            await ctx.driver.tap(x_3d, y_3d)
            await asyncio.sleep(3.5)

            # Quét bottom sheet và click Sao chép liên kết
            ui_sheet = await ctx.state_provider.get_state()
            els_sheet = ui_sheet.elements if ui_sheet else []
            copy_btn = _find_element_by_keywords(
                els_sheet,
                "Sao chép liên kết",
                "Copy link",
                "Copy Link"
            )
            if copy_btn is not None:
                idx_copy = copy_btn.get("index")
                if idx_copy is not None:
                    x_c, y_c = ui_sheet.get_element_coords(idx_copy)
                    logger.info(f"[facebook_find_and_copy_post_link] Click nút Sao chép liên kết tại ({x_c}, {y_c})")
                    await ctx.driver.tap(x_c, y_c)
                    await asyncio.sleep(3.0)
                    
                    # Gọi trực tiếp hàm helper dùng chung
                    res = await _read_clipboard_and_sync_link(profile_name, ctx)
                    if not res.startswith("Failed"):
                        return res
                    logger.warning(f"[facebook_find_and_copy_post_link] Copy trực tiếp thất bại: {res}. Sẽ thử vào chi tiết...")

            # Nếu bấm 3 chấm trực tiếp không có hoặc lỗi, bấm Back để đóng sheet rồi chuyển sang Fallback
            logger.info("[facebook_find_and_copy_post_link] Đóng menu Lựa chọn khác (bấm back) và chuyển sang dự phòng...")
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.5)
            
    # Ưu tiên 2 (Fallback): Đi vào chi tiết bài viết rồi mới sao chép link
    logger.info("[facebook_find_and_copy_post_link] Chuyển sang phương án dự phòng: vào chi tiết bài viết để lấy link...")
    
    timestamp_el = matched_block.timestamp_el
    if timestamp_el is None:
        return "Failed: Tìm thấy bài viết phù hợp nhưng không xác định được nhãn thời gian để vào chi tiết."

    idx_t = timestamp_el.get("index")
    if idx_t is None:
        return "Failed: Nhãn thời gian tìm thấy không có index."

    x_t, y_t = ui_matched.get_element_coords(idx_t)
    logger.info(
        "[facebook_find_and_copy_post_link] Click nhãn thời gian %r tại (%d, %d) để vào chi tiết",
        timestamp_el.get("text"), x_t, y_t
    )
    await ctx.driver.tap(x_t, y_t)
    await asyncio.sleep(4.5)
    return await _copy_link_from_opened_post(profile_name, ctx)


async def _open_personal_profile(ctx) -> tuple[bool, str]:
    """Tap the "Trang cá nhân" tab (or fallback profile entry) to open the
    current user's personal profile screen. Returns (ok, error_msg).
    """
    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        # Ưu tiên các keyword có định nghĩa Tab cụ thể để không bấm nhầm nút "Cài đặt trang cá nhân"
        profile_tab = _find_element_by_keywords(
            elements,
            "Trang cá nhân, Tab 6/6", "Đi tới trang cá nhân", "Trang cá nhân, Tab"
        )
        if profile_tab is None:
            # Nếu không tìm thấy tab cụ thể, tìm phần tử chứa "Trang cá nhân" nhưng loại trừ các nút cài đặt/chỉnh sửa
            for el in elements:
                label = (
                    (el.get("text") or "")
                    + " "
                    + (el.get("content-desc") or "")
                ).lower()
                if "trang cá nhân" in label and not any(k in label for k in ("cài đặt", "chỉnh sửa", "settings", "edit")):
                    profile_tab = el
                    break
        if profile_tab is None:
            return False, "Không tìm thấy tab/entry 'Trang cá nhân'."
        idx = profile_tab.get("index")
        if idx is None:
            return False, "Tab 'Trang cá nhân' không có index."
        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(3.0)
        return True, ""
    except Exception as e:
        return False, f"Lỗi mở Trang cá nhân — {e}"


async def _pick_first_gallery_item_and_confirm(ctx, confirm_keywords: tuple[str, ...]) -> tuple[bool, str]:
    """Wait for the gallery/picker grid, tap "mục 1", then tap any of
    *confirm_keywords* (e.g. "Lưu", "Xong", "Sử dụng", "Tiếp", "Chia sẻ"). Used by
    avatar/cover/story flows after they reach the photo picker.
    """
    try:
        await asyncio.sleep(3.0)  # wait for grid to load
        ui_picker = await ctx.state_provider.get_state()
        els_picker = ui_picker.elements if ui_picker else []
        item = _find_element_by_keywords(els_picker, "mục 1")
        if item is None:
            return False, "Không quét thấy 'mục 1' trong thư viện ảnh."
        idx_m = item.get("index")
        if idx_m is None:
            return False, "Phần tử 'mục 1' không có index."
        x_m, y_m = ui_picker.get_element_coords(idx_m)
        await ctx.driver.tap(x_m, y_m)
        await asyncio.sleep(2.0)

        ui_confirm = await ctx.state_provider.get_state()
        els_confirm = ui_confirm.elements if ui_confirm else []
        confirm_btn = _find_element_exact(els_confirm, *confirm_keywords)
        if confirm_btn is None:
            confirm_btn = _find_element_by_keywords(els_confirm, *confirm_keywords)
        if confirm_btn is None:
            return False, f"Không tìm thấy nút xác nhận trong {confirm_keywords}."
        idx_c = confirm_btn.get("index")
        if idx_c is None:
            return False, "Nút xác nhận không có index."
        x_c, y_c = ui_confirm.get_element_coords(idx_c)
        await ctx.driver.tap(x_c, y_c)
        await asyncio.sleep(3.0)
        return True, ""
    except Exception as e:
        return False, f"Lỗi chọn ảnh & xác nhận — {e}"


async def facebook_change_avatar(profile_name: str, *, ctx, **kwargs) -> str:
    """Đổi ảnh đại diện trang cá nhân Facebook.

    Tiền điều kiện: ảnh đã được worker push vào /sdcard/Download/ và đồng bộ
    thư viện. Tool sẽ chọn ảnh mới nhất (mục 1) làm avatar.
    """
    logger.info("[facebook_change_avatar] Bắt đầu cho profile=%r", profile_name)

    ok, err = await _open_personal_profile(ctx)
    if not ok:
        return f"Failed: [change_avatar bước 1] {err}"

    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        avatar = _find_element_by_keywords(
            elements, "ảnh đại diện", "Avatar", "Profile picture",
        )
        if avatar is None:
            return "Failed: Không tìm thấy avatar trên Trang cá nhân."
        idx = avatar.get("index")
        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [change_avatar bước 2] Lỗi tap avatar — {e}"

    try:
        ui_menu = await ctx.state_provider.get_state()
        els_menu = ui_menu.elements if ui_menu else []
        choose = _find_element_by_keywords(
            els_menu,
            "Chọn ảnh đại diện", "Chỉnh sửa ảnh đại diện",
            "Choose profile picture", "Edit profile picture",
        )
        if choose is None:
            return "Failed: Không tìm thấy 'Chọn/Chỉnh sửa ảnh đại diện'."
        idx_c = choose.get("index")
        x_c, y_c = ui_menu.get_element_coords(idx_c)
        await ctx.driver.tap(x_c, y_c)
        await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [change_avatar bước 3] Lỗi mở menu chỉnh sửa — {e}"

    try:
        ui_src = await ctx.state_provider.get_state()
        els_src = ui_src.elements if ui_src else []
        gallery = _find_element_by_keywords(
            els_src, "Chọn ảnh", "Thư viện", "Gallery", "Choose photo",
        )
        if gallery is not None:
            idx_g = gallery.get("index")
            x_g, y_g = ui_src.get_element_coords(idx_g)
            await ctx.driver.tap(x_g, y_g)
            await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [change_avatar bước 4] Lỗi mở picker — {e}"

    ok, err = await _pick_first_gallery_item_and_confirm(
        ctx, ("Lưu", "Xong", "Sử dụng", "Use", "Save"),
    )
    if not ok:
        return f"Failed: [change_avatar bước 5] {err}"

    try:
        logger.info("[facebook_change_avatar] Đóng ứng dụng Facebook bằng force-stop...")
        await ctx.driver.device.shell("am force-stop com.facebook.katana")
    except Exception as e:
        logger.warning(f"[facebook_change_avatar] Lỗi force-stop: {e}")

    return "Đã đổi ảnh đại diện thành công."


async def facebook_change_cover(profile_name: str, *, ctx, **kwargs) -> str:
    """Đổi ảnh bìa trang cá nhân Facebook."""
    logger.info("[facebook_change_cover] Bắt đầu cho profile=%r", profile_name)

    ok, err = await _open_personal_profile(ctx)
    if not ok:
        return f"Failed: [change_cover bước 1] {err}"

    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        cover_edit = _find_element_by_keywords(
            elements,
            "Chỉnh sửa ảnh bìa", "Thêm ảnh bìa", "Edit cover photo", "Add cover photo",
            "Ảnh bìa", "Cover photo",
        )
        if cover_edit is None:
            return "Failed: Không tìm thấy nút Chỉnh sửa ảnh bìa."
        idx = cover_edit.get("index")
        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [change_cover bước 2] Lỗi tap ảnh bìa — {e}"

    try:
        ui_menu = await ctx.state_provider.get_state()
        els_menu = ui_menu.elements if ui_menu else []
        choose = _find_element_by_keywords(
            els_menu,
            "Chọn ảnh", "Thư viện", "Choose photo", "Gallery",
        )
        if choose is not None:
            idx_c = choose.get("index")
            x_c, y_c = ui_menu.get_element_coords(idx_c)
            await ctx.driver.tap(x_c, y_c)
            await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [change_cover bước 3] Lỗi mở picker — {e}"

    ok, err = await _pick_first_gallery_item_and_confirm(
        ctx, ("Lưu", "Xong", "Sử dụng", "Save", "Done"),
    )
    if not ok:
        return f"Failed: [change_cover bước 4] {err}"

    try:
        logger.info("[facebook_change_cover] Đóng ứng dụng Facebook bằng force-stop...")
        await ctx.driver.device.shell("am force-stop com.facebook.katana")
    except Exception as e:
        logger.warning(f"[facebook_change_cover] Lỗi force-stop: {e}")

    return "Đã đổi ảnh bìa thành công."


async def facebook_post_story(profile_name: str, *, ctx, **kwargs) -> str:
    """Đăng 1 tin nổi bật (Story) bằng ảnh đã có trong gallery."""
    logger.info("[facebook_post_story] Bắt đầu cho profile=%r", profile_name)

    try:
        ui_state = await ctx.state_provider.get_state()
        elements = ui_state.elements if ui_state else []
        story_btn = _find_element_by_keywords(
            elements,
            "Thêm vào tin", "Tin của bạn", "Tạo tin",
            "Add to story", "Your story", "Create story",
        )
        if story_btn is None:
            return "Failed: Không tìm thấy nút 'Thêm vào tin' trên News Feed."
        idx = story_btn.get("index")
        x, y = ui_state.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(3.0)
    except Exception as e:
        return f"Failed: [post_story bước 1] Lỗi tap 'Thêm vào tin' — {e}"

    try:
        ui_src = await ctx.state_provider.get_state()
        els_src = ui_src.elements if ui_src else []
        gallery = _find_element_by_keywords(
            els_src, "Thư viện", "Photo", "Gallery", "Ảnh",
        )
        if gallery is not None:
            idx_g = gallery.get("index")
            x_g, y_g = ui_src.get_element_coords(idx_g)
            await ctx.driver.tap(x_g, y_g)
            await asyncio.sleep(2.0)
    except Exception as e:
        return f"Failed: [post_story bước 2] Lỗi mở picker — {e}"

    ok, err = await _pick_first_gallery_item_and_confirm(
        ctx, ("Chia sẻ tin", "Chia sẻ", "Đăng", "Share", "Lên tin", "Tiếp"),
    )
    if not ok:
        return f"Failed: [post_story bước 3] {err}"

    try:
        logger.info("[facebook_post_story] Đóng ứng dụng Facebook bằng force-stop...")
        await ctx.driver.device.shell("am force-stop com.facebook.katana")
    except Exception as e:
        logger.warning(f"[facebook_post_story] Lỗi force-stop: {e}")

    return "Đã đăng Story thành công."


def _log_scanned_elements(tag: str, elements):
    """Log a small summary of elements for debugging."""
    if not elements:
        logger.info("[%s] Scanned elements: (Trống)", tag)
        return
    logger.info("[%s] --- DEBUG SCAN UI (%d elements) ---", tag, len(elements))
    for i, el in enumerate(elements):
        txt = (el.get("text") or "").strip()
        desc = (el.get("content-desc") or "").strip()
        rid = el.get("resource-id") or ""
        rid_short = rid.split("/")[-1] if "/" in rid else rid
        cls = el.get("class") or el.get("className") or ""
        cls_short = cls.split(".")[-1] if "." in cls else cls
        bounds = el.get("bounds") or ""
        if txt or desc or "menu" in rid_short.lower() or "tab" in rid_short.lower() or "button" in cls_short.lower():
            logger.info(
                "[%s] IDX %s | RID: %s | CLS: %s | Bounds: %s | Text/Desc: %r",
                tag, el.get("index", i), rid_short, cls_short, bounds, txt or desc
            )
    logger.info("[%s] --- END DEBUG SCAN UI ---", tag)


async def _post_to_own_fanpage(profile_name: str, fanpage_name: str, content: str, media_path: str = None, has_media: bool = False, media_count: int = 1, *, ctx) -> str:
    """Thao tác đăng bài vào Fanpage của TÔI (chính chủ sở hữu)."""
    logger.info("[_post_to_own_fanpage] Bắt đầu chuyển tài khoản để đăng bài lên Fanpage chính chủ: %s", fanpage_name)

    # ── Bước 1: Mở màn hình Menu để tìm nút chuyển đổi ──────────
    try:
        await asyncio.sleep(2.0)
        ui_init = await ctx.state_provider.get_state()
        els_init = ui_init.elements if ui_init else []

        # Kiểm tra xem có đang ở màn hình News Feed không
        is_on_feed = _find_element_by_keywords(els_init, "Bạn đang nghĩ gì?", "Bạn đang nghĩ gì", "Trang chủ, Tab 1/6")
        if not is_on_feed:
            return "Failed: [_post_to_own_fanpage] Hiện tại không phải ở News Feed. Vui lòng quay về trang chủ News Feed trước."

        menu_tab = _find_element_by_keywords(els_init, "Đi tới trang cá nhân", "Trang cá nhân, Tab 6/6")
        if menu_tab:
            idx = menu_tab.get("index")
            if idx is not None:
                x, y = ui_init.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                logger.info("[_post_to_own_fanpage] Đang ở News Feed, đã tap vào tab Trang cá nhân 6/6.")
                await asyncio.sleep(3.0)

                # Quét lại UI xem đã mở Menu chưa hay lỡ vào Trang cá nhân
                ui_check = await ctx.state_provider.get_state()
                els_check = ui_check.elements if ui_check else []

                # Nếu lỡ vào trang cá nhân (thấy nút "Menu" ở góc trên trái)
                menu_btn_2 = _find_element_by_keywords(els_check, "Menu")
                if menu_btn_2:
                    idx_m2 = menu_btn_2.get("index")
                    if idx_m2 is not None:
                        x, y = ui_check.get_element_coords(idx_m2)
                        await ctx.driver.tap(x, y)
                        logger.info("[_post_to_own_fanpage] Lỡ vào Trang cá nhân, đã tap tiếp nút Menu để mở Menu chính.")
                        await asyncio.sleep(3.0)
        else:
            return "Failed: Không tìm thấy nút Menu hoặc Trang cá nhân Tab 6/6 trên News Feed."
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 1] Lỗi mở Menu từ News Feed — {e}"

    # ── Bước 2: Tìm và click nút chuyển đổi tài khoản ("hãy chuyển sang trang của bạn") ──
    try:
        ui_menu = await ctx.state_provider.get_state()
        els_menu = ui_menu.elements if ui_menu else []
        # _log_scanned_elements("_post_to_own_fanpage bước 2", els_menu)

        switch_btn = _find_element_by_keywords(
            els_menu,
            # "hãy chuyển sang trang của bạn",
            "Hãy mở công cụ chuyển trang cá nhân"
        )
        if switch_btn is None:
            switch_btn = _find_element_by_keywords(els_menu, fanpage_name)

        if switch_btn is None:
            return "Failed: Không tìm thấy nút chuyển tài khoản sang trang trên Menu."
        
        idx_sw = switch_btn.get("index")
        if idx_sw is None:
            return "Failed: Nút chuyển tài khoản sang trang không có index."

        x, y = ui_menu.get_element_coords(idx_sw)
        await ctx.driver.tap(x, y)
        logger.info("[_post_to_own_fanpage] Đã tap nút chuyển sang trang")

        await asyncio.sleep(2.5)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 2] Lỗi click nút chuyển trang — {e}"

    # ── Bước 3: Chọn Fanpage trong popup bottom sheet ────────────────────────
    try:
        ui_popup = await ctx.state_provider.get_state()
        els_popup = ui_popup.elements if ui_popup else []
        # _log_scanned_elements("_post_to_own_fanpage bước 3", els_popup)

        page_option = _find_element_exact(els_popup, fanpage_name)
        if page_option is None:
            page_option = _find_element_by_keywords(els_popup, fanpage_name)

        if page_option is None:
            return f"Failed: Không tìm thấy Fanpage '{fanpage_name}' trong popup danh sách tài khoản."

        idx_pg = page_option.get("index")
        if idx_pg is None:
            return f"Failed: Lựa chọn Fanpage '{fanpage_name}' không có index."

        x, y = ui_popup.get_element_coords(idx_pg)
        await ctx.driver.tap(x, y)
        logger.info("[_post_to_own_fanpage] Đã chọn Fanpage '%s' trong popup", fanpage_name)

        logger.info("[_post_to_own_fanpage] Đang đợi chuyển đổi tài khoản sang Fanpage...")
        await asyncio.sleep(6.0)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 3] Lỗi chọn Fanpage trong popup — {e}"

    # ── Bước 4: Tìm và click "Bạn đang nghĩ gì?" trên giao diện Trang mới ─────────
    # Retry tối đa 3 lần với cuộn lên đầu feed (giống facebook_create_post B2)
    try:
        post_trigger = None
        for _scroll_try in range(4):  # lần 0: quét thẳng; lần 1-3: cuộn lên rồi quét lại
            if _scroll_try > 0:
                logger.info("[_post_to_own_fanpage] B4 retry %d/3: cuộn lên đầu feed Fanpage...", _scroll_try)
                try:
                    await ctx.driver.device.shell("input swipe 350 400 350 1200")
                    await asyncio.sleep(1.5)
                except Exception:
                    pass

            ui_feed = await ctx.state_provider.get_state()
            els_feed = ui_feed.elements if ui_feed else []

            post_trigger = _find_element_by_keywords(els_feed, "Bạn đang nghĩ gì?")
            if post_trigger is None:
                post_trigger = _find_element_by_keywords(
                    els_feed, "Bạn đang nghĩ gì", "What's on your mind", "Tạo bài viết"
                )
            if post_trigger is not None:
                break

        if post_trigger is None:
            return "Failed: Không tìm thấy ô tạo bài viết 'Bạn đang nghĩ gì?' trên giao diện Fanpage sau 3 lần cuộn."

        idx_tr = post_trigger.get("index")
        if idx_tr is None:
            return "Failed: Ô tạo bài viết trên Fanpage không có index."

        x, y = ui_feed.get_element_coords(idx_tr)
        await ctx.driver.tap(x, y)
        logger.info("[_post_to_own_fanpage] Đã click vào ô 'Bạn đang nghĩ gì?'")
        await asyncio.sleep(3.0)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 4] Lỗi click Tạo bài viết — {e}"

    # ── Bước 5: Nhập nội dung bài đăng ────────────────────────────────────────
    try:
        ui_compose = await ctx.state_provider.get_state()
        els_compose = ui_compose.elements if ui_compose else []
        # _log_scanned_elements("_post_to_own_fanpage bước 5", els_compose)

        input_el = _find_element_by_keywords(els_compose, "Bạn đang nghĩ gì?", "Bạn đang nghĩ gì")
        if input_el is None:
            for el in els_compose:
                cls = (el.get("className") or "").lower()
                if "autocompletetextview" in cls or "edittext" in cls:
                    input_el = el
                    break

        if input_el is None:
            return "Failed: Không tìm thấy ô nhập nội dung trên giao diện đăng bài Fanpage."

        idx_in = input_el.get("index")
        if idx_in is None:
            return "Failed: Ô nhập nội dung không có index."

        x_in, y_in = ui_compose.get_element_coords(idx_in)
        await ctx.driver.tap(x_in, y_in)
        await asyncio.sleep(0.5)

        await ctx.driver.input_text(content, clear=True)
        logger.info("[_post_to_own_fanpage] Đã điền nội dung: %r", content)
        await asyncio.sleep(1.0)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 5] Lỗi nhập nội dung bài viết — {e}"

    # ── Bước 6: Đóng bàn phím ảo ──────────────────────────────────────────────
    try:
        logger.info("[_post_to_own_fanpage] Đóng bàn phím ảo...")
        ui_close = await ctx.state_provider.get_state()
        els_close = ui_close.elements if ui_close else []
        xong_btn = None
        for el in els_close:
            txt = el.get("text") or el.get("content-desc") or ""
            cls = (el.get("className") or "").lower()
            if txt in ("Xong", "Done") and "button" in cls:
                xong_btn = el
                break
            
        if xong_btn is not None:
            idx_xong = xong_btn.get("index")
            if idx_xong is not None:
                x_x, y_x = ui_close.get_element_coords(idx_xong)
                logger.info(f"[_post_to_own_fanpage] Phát hiện nút 'Xong'/'Done' tại ({x_x}, {y_x}), tiến hành click...")
                await ctx.driver.tap(x_x, y_x)
                await asyncio.sleep(2.0)
            else:
                xong_btn = None
                
        if xong_btn is None:
            logger.info("[_post_to_own_fanpage] Không thấy nút 'Xong'/'Done', tiến hành Back 1 lần...")
            await ctx.driver.press_button("back")
            await asyncio.sleep(1.5)
    except Exception as e:
        logger.warning("[_post_to_own_fanpage] Lỗi khi đóng bàn phím: %s. Tiếp tục tìm nút Tiếp.", e)

    # ── Bước đính kèm Media (MỚI) ────────────────────────────────────────────
    if has_media or media_path:
        logger.info("[_post_to_own_fanpage] Bắt đầu đính kèm ảnh/video...")
        ok, err_msg = await _attach_media_from_gallery(ctx, media_count=media_count)
        if not ok:
            return f"Failed: [_post_to_own_fanpage đính kèm] {err_msg}"

    # ── Bước 7: Click nút Tiếp (Next) ─────────────────────────────────────────
    try:
        ui_next = await ctx.state_provider.get_state()
        els_next = ui_next.elements if ui_next else []
        # _log_scanned_elements("_post_to_own_fanpage bước 7", els_next)

        next_btn = _find_element_exact(els_next, "Tiếp", "Next")
        if next_btn is None:
            next_btn = _find_element_by_keywords(els_next, "Tiếp", "Next")

        if next_btn is None:
            return "Failed: Không tìm thấy nút 'Tiếp' trên màn hình viết bài viết Fanpage."

        idx_nxt = next_btn.get("index")
        if idx_nxt is None:
            return "Failed: Nút 'Tiếp' không có index."

        x, y = ui_next.get_element_coords(idx_nxt)
        await ctx.driver.tap(x, y)
        logger.info("[_post_to_own_fanpage] Đã click nút 'Tiếp'")

        await asyncio.sleep(5.0)

        # Kiểm tra xem có popup hiện lên ngay sau khi click "Tiếp" không
        try:
            ui_popup_next = await ctx.state_provider.get_state()
            els_popup_next = ui_popup_next.elements if ui_popup_next else []
            popup_btn = _find_element_exact(
                els_popup_next,
                "Lúc khác", "Không phải bây giờ", "Để sau", "Not now", "Close", "Đóng"
            )
            if popup_btn:
                idx_pop = popup_btn.get("index")
                if idx_pop is not None:
                    x_p, y_p = ui_popup_next.get_element_coords(idx_pop)
                    await ctx.driver.tap(x_p, y_p)
                    logger.info("[_post_to_own_fanpage] Phát hiện và đã bỏ qua popup sau khi click Tiếp bằng cách tap '%s'", popup_btn.get("text"))
                    await asyncio.sleep(2.0)
        except Exception as pe:
            logger.warning("[_post_to_own_fanpage] Lỗi khi kiểm tra hoặc tắt popup sau nút Tiếp: %s. Bỏ qua.", pe)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 7] Lỗi click nút Tiếp — {e}"

    # ── Bước 8: Click nút Chia sẻ (Share) ──────────────────────────────────────
    try:
        ui_share = await ctx.state_provider.get_state()
        els_share = ui_share.elements if ui_share else []
        # _log_scanned_elements("_post_to_own_fanpage bước 8", els_share)

        share_btn = _find_element_exact(els_share, "Chia sẻ", "Share")
        if share_btn is None:
            share_btn = _find_element_by_keywords(els_share, "Chia sẻ", "Share")

        if share_btn is None:
            return "Failed: Không tìm thấy nút 'Chia sẻ' trên màn hình cấu hình chia sẻ Fanpage."

        idx_sh = share_btn.get("index")
        if idx_sh is None:
            return "Failed: Nút 'Chia sẻ' không có index."

        x, y = ui_share.get_element_coords(idx_sh)
        await ctx.driver.tap(x, y)
        logger.info("[_post_to_own_fanpage] Đã click nút 'Chia sẻ'")

        logger.info("[_post_to_own_fanpage] Đang tải lên bài viết và chờ hoàn tất...")
        await asyncio.sleep(5.0)
    except Exception as e:
        return f"Failed: [_post_to_own_fanpage bước 8] Lỗi click nút Chia sẻ — {e}"

    # ── Bước 9: Xác minh và xử lý popup quảng cáo (nếu có) ──────────────────────
    try:
        ui_final = await ctx.state_provider.get_state()
        els_final = ui_final.elements if ui_final else []
        # _log_scanned_elements("_post_to_own_fanpage bước 9", els_final)

        popup_btn = _find_element_exact(
            els_final,
            "Lúc khác", "Không phải bây giờ", "Để sau", "Not now", "Close", "Đóng"
        )
        if popup_btn:
            idx_pop = popup_btn.get("index")
            if idx_pop is not None:
                x, y = ui_final.get_element_coords(idx_pop)
                await ctx.driver.tap(x, y)
                logger.info("[_post_to_own_fanpage] Đã bỏ qua popup quảng cáo bằng cách tap '%s'", popup_btn.get("text"))
                await asyncio.sleep(1.5)
    except Exception as e:
        logger.warning("[_post_to_own_fanpage] Lỗi kiểm tra popup cuối: %s. Vẫn coi như thành công.", e)

    return f"Đăng bài lên Fanpage chính chủ '{fanpage_name}' thành công với nội dung: '{content}'"


async def _post_to_other_fanpage_stub(profile_name: str, fanpage_name: str, content: str, *, ctx) -> str:
    """[STUB] Thao tác đăng bài vào một Fanpage KHÁC (của người khác - thông qua tìm kiếm)."""
    logger.info("[_post_to_other_fanpage_stub] Đang thực hiện đăng bài lên Fanpage của người khác: %s", fanpage_name)
    await asyncio.sleep(1.0)
    return f"Success (Stub): Đã đăng bài viết '{content}' lên Fanpage công khai '{fanpage_name}'."


async def facebook_post_to_fanpage(profile_name: str, fanpage_name: str, content: str, is_own_fanpage: bool = None, media_path: str = None, has_media: bool = False, media_count: int = 1, *, ctx, **kwargs) -> str:
    """Điều hướng và thực hiện đăng bài viết lên Fanpage chỉ định.

    Tool tự động:
    1. Kiểm tra xem fanpage_name có cấu hình chủ sở hữu (owner) trong fanpage_mapping.yaml hay không.
    2. Nếu thuộc sở hữu (hoặc is_own_fanpage=True): gọi _post_to_own_fanpage.
    3. Nếu không thuộc sở hữu (hoặc is_own_fanpage=False): gọi _post_to_other_fanpage_stub.
    """
    if not profile_name or not profile_name.strip():
        return "Failed: Tên profile_name không được để trống."

    if not fanpage_name or not fanpage_name.strip():
        return "Failed: Tên Fanpage không được để trống."

    if not content or not content.strip():
        return "Failed: Nội dung bài viết không được để trống."

    # Đọc cấu hình fanpage_mapping.yaml để lấy chủ sở hữu (owner)
    fanpage_owner = None
    try:
        import yaml
        fanpage_mapping_path = Path(__file__).parent / "fanpage_mapping.yaml"
        if fanpage_mapping_path.exists():
            with open(fanpage_mapping_path, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            fanpages = data.get("fanpages") or {}
            
            needle_page = fanpage_name.strip().lower()
            for p_name, p_info in fanpages.items():
                if p_name.strip().lower() == needle_page:
                    fanpage_owner = p_info.get("owner")
                    break
    except Exception as e:
        logger.warning("[facebook_post_to_fanpage] Lỗi đọc fanpage_mapping: %s", e)

    if is_own_fanpage is None:
        is_own_fanpage = False
        if fanpage_owner and fanpage_owner.strip().lower() == profile_name.strip().lower():
            is_own_fanpage = True

    logger.info(
        "[facebook_post_to_fanpage] profile=%s, fanpage=%s, is_own_fanpage=%s",
        profile_name, fanpage_name, is_own_fanpage
    )

    if is_own_fanpage:
        return await _post_to_own_fanpage(profile_name, fanpage_name, content, media_path=media_path, has_media=has_media, media_count=media_count, ctx=ctx)
    else:
        return await _post_to_other_fanpage_stub(profile_name, fanpage_name, content, ctx=ctx)


async def facebook_navigate_to_group(group_name: str, *, ctx, **kwargs) -> str:
    """Điều hướng từ News Feed vào một Nhóm (Facebook Group) cụ thể.
    
    Quy trình:
    1. Tra cứu cấu hình trong fanpage_mapping.yaml để lấy search_keyword chính xác.
    2. Kiểm tra màn hình hiện tại. Nếu chưa ở tab Nhóm, tìm và tap tab 'Nhóm, Tab 4/6' (hoặc 'Nhóm').
    3. Tại màn hình Nhóm: quét tìm group_name trong danh sách hiển thị.
    4. Nếu thấy: tap vào nhóm và chờ 3s.
    5. Nếu không thấy ở trang đầu: tìm nút 'Xem tất cả' và tap.
    6. Ở giao diện danh sách tất cả nhóm: thực hiện vòng lặp cuộn màn hình và tìm tên nhóm.
    """
    if not group_name or not group_name.strip():
        return "Failed: Tên nhóm không được để trống."

    # ── Bước 1: Tra cứu search_keyword từ fanpage_mapping.yaml ─────────────────
    search_keyword = group_name.strip()
    try:
        import yaml
        mapping_path = Path(__file__).parent / "fanpage_mapping.yaml"
        if mapping_path.exists():
            with open(mapping_path, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            groups = data.get("groups") or {}
            
            needle = group_name.strip().lower()
            for g_name, g_info in groups.items():
                if g_name.strip().lower() == needle:
                    search_keyword = g_info.get("search_keyword", g_name)
                    break
    except Exception as e:
        logger.warning("[facebook_navigate_to_group] Lỗi đọc fanpage_mapping: %s", e)

    logger.info("[facebook_navigate_to_group] Bắt đầu tìm nhóm: %s (từ khóa tìm kiếm: %s)", group_name.strip(), search_keyword)

    # ── Bước 2: Điều hướng đến tab Nhóm ──────────────────────────────────────
    try:
        # Vuốt nhẹ xuống dưới để lộ ra thanh tab bar/header (tránh bị ẩn do cuộn trước đó)
        logger.info("[facebook_navigate_to_group] Vuốt nhẹ xuống dưới để hiển thị thanh công cụ/tab bar...")
        try:
            await ctx.driver.device.shell("input swipe 350 400 350 900")
            await asyncio.sleep(1.5)
        except Exception as se:
            logger.warning("[facebook_navigate_to_group] Lỗi khi thực hiện vuốt nhẹ xuống: %s", se)

        ui_init = await ctx.state_provider.get_state()
        els_init = ui_init.elements if ui_init else []

        # Kiểm tra xem có đang ở trang nhóm sẵn không (thường có header "Nhóm" hoặc thanh search nhóm)
        in_groups_tab = _find_element_by_keywords(els_init, "Xem tất cả", "Tạo nhóm mới", "Khám phá")
        
        if not in_groups_tab:
            # Ưu tiên tìm chính xác 'Nhóm, Tab 4/6'
            group_tab = _find_element_by_keywords(els_init, "Nhóm, Tab 4/6", "Nhóm, Tab", "Groups, Tab", "Đi tới Nhóm")
            if group_tab is None:
                # Tìm chữ "Nhóm" đơn thuần trên tab
                group_tab = _find_element_exact(els_init, "Nhóm", "Groups")
            
            if group_tab:
                idx = group_tab.get("index")
                if idx is not None:
                    x, y = ui_init.get_element_coords(idx)
                    await ctx.driver.tap(x, y)
                    logger.info("[facebook_navigate_to_group] Đã tap vào tab Nhóm")
                    await asyncio.sleep(3.0)
            else:
                logger.info("[facebook_navigate_to_group] Không tìm thấy tab Nhóm, kích hoạt fallback tìm kiếm trên trang chủ...")
                search_btn = _find_element_by_keywords(els_init, "Tìm kiếm trên Facebook", "Search Facebook", "Tìm kiếm", "Search")
                if not search_btn:
                    search_btn = _find_element_exact(els_init, "Tìm kiếm", "Search")
                
                if search_btn:
                    idx_s = search_btn.get("index")
                    if idx_s is not None:
                        x_s, y_s = ui_init.get_element_coords(idx_s)
                        logger.info("[facebook_navigate_to_group] Tap vào nút Tìm kiếm để tìm nhóm...")
                        await ctx.driver.tap(x_s, y_s)
                        await asyncio.sleep(3.0)
                        
                        # Quét screen xem nhóm có sẵn trong lịch sử tìm kiếm/gợi ý không
                        ui_prep = await ctx.state_provider.get_state()
                        els_prep = ui_prep.elements if ui_prep else []
                        
                        target_el = None
                        for el in els_prep:
                            txt = (el.get("text") or el.get("content-desc") or "").strip().lower()
                            cls = (el.get("className") or "").lower()
                            # Bỏ qua ô nhập liệu (EditText) để tránh nhận diện nhầm ô search trống
                            if "edit" in cls or "search" in cls:
                                continue
                            if txt == group_name.strip().lower() or txt == search_keyword.lower():
                                target_el = el
                                break
                                    
                        if target_el:
                            idx_t = target_el.get("index")
                            x_t, y_t = ui_prep.get_element_coords(idx_t)
                            logger.info(f"[facebook_navigate_to_group] Tìm thấy nhóm/từ khóa '{group_name.strip()}' có sẵn trên màn hình, tap trực tiếp tại ({x_t}, {y_t})...")
                            await ctx.driver.tap(x_t, y_t)
                            await asyncio.sleep(4.0)
                            return f"Success: Đã vào nhóm '{group_name.strip()}' thành công (qua lịch sử tìm kiếm)."
                        else:
                            logger.info(f"[facebook_navigate_to_group] Nhập từ khóa tìm kiếm (bằng clipboard): '{search_keyword}'")
                            await ctx.driver.input_text(search_keyword)
                            await asyncio.sleep(2.0)
                            await ctx.driver.device.shell("input keyevent 66")
                            await asyncio.sleep(4.0)
                            
                            # Quét kết quả tìm kiếm
                            ui_search = await ctx.state_provider.get_state()
                            els_search = ui_search.elements if ui_search else []
                        
                        # Thử tìm tab lọc "Nhóm" (Groups) để kết quả chính xác hơn
                        filter_groups = _find_element_exact(els_search, "Nhóm", "Groups")
                        if filter_groups:
                            idx_fg = filter_groups.get("index")
                            if idx_fg is not None:
                                x_fg, y_fg = ui_search.get_element_coords(idx_fg)
                                # Đảm bảo Y nằm trong khoảng filter bar (140 đến 450) để tránh nhầm tab navigation chính
                                if 140 < y_fg < 450:
                                    logger.info("[facebook_navigate_to_group] Tap vào tab lọc 'Nhóm' trong kết quả tìm kiếm...")
                                    await ctx.driver.tap(x_fg, y_fg)
                                    await asyncio.sleep(3.0)
                                    ui_search = await ctx.state_provider.get_state()
                                    els_search = ui_search.elements if ui_search else []
                        
                        # Tìm nhóm trong kết quả tìm kiếm
                        target_el = _find_element_exact(els_search, group_name.strip(), search_keyword)
                        if not target_el:
                            target_el = _find_element_by_keywords(els_search, group_name.strip(), search_keyword)
                        
                        if target_el:
                            idx_t = target_el.get("index")
                            if idx_t is not None:
                                x_t, y_t = ui_search.get_element_coords(idx_t)
                                logger.info(f"[facebook_navigate_to_group] Tìm thấy nhóm '{group_name.strip()}' từ tìm kiếm và tap vào.")
                                await ctx.driver.tap(x_t, y_t)
                                await asyncio.sleep(4.0)
                                return f"Success: Đã vào nhóm '{group_name.strip()}' thành công (qua tìm kiếm fallback)."
                        else:
                            return f"Failed: Fallback tìm kiếm không thấy nhóm '{group_name.strip()}'."
                
                return "Failed: Không tìm thấy tab 'Nhóm' trên thanh điều hướng Facebook và không tìm thấy nút Tìm kiếm để fallback."
    except Exception as e:
        return f"Failed: Lỗi di chuyển sang tab Nhóm — {e}"

    # ── Bước 3: Quét tìm nhóm ở màn hình chính của tab Nhóm ──────────────────
    try:
        ui_groups = await ctx.state_provider.get_state()
        els_groups = ui_groups.elements if ui_groups else []

        # Thử tìm tên nhóm hiển thị trực tiếp bằng search_keyword hoặc group_name
        group_el = _find_element_exact(els_groups, search_keyword, group_name.strip())
        if group_el is None:
            group_el = _find_element_by_keywords(els_groups, search_keyword, group_name.strip())

        if group_el:
            idx_g = group_el.get("index")
            if idx_g is not None:
                x, y = ui_groups.get_element_coords(idx_g)
                await ctx.driver.tap(x, y)
                logger.info("[facebook_navigate_to_group] Đã tìm thấy nhóm '%s' ở màn hình chính và tap vào.", search_keyword)
                await asyncio.sleep(3.0)
                return f"Success: Đã vào nhóm '{group_name.strip()}' thành công."

    except Exception as e:
        logger.warning("[facebook_navigate_to_group] Lỗi quét nhanh trang đầu: %s", e)

    # ── Bước 4: Tìm kiếm nâng cao bằng "Cài đặt -> Đang theo dõi" ─────────────
    try:
        ui_groups = await ctx.state_provider.get_state()
        els_groups = ui_groups.elements if ui_groups else []

        # Kiểm tra xem có đầy đủ menu Nhóm đầu trang hay không
        matched_menu_count = sum(1 for kw in ["menu", "tạo nhóm", "cài đặt", "tìm kiếm nhóm", "nhóm"] if _find_element_by_keywords(els_groups, kw))
        if matched_menu_count < 3:
            return "Failed: Không tìm thấy thanh menu header Nhóm hợp lệ."

        # 1. Tìm và click Cài đặt
        settings_btn = _find_element_by_keywords(els_groups, "Cài đặt", "Settings")
        idx_st = settings_btn.get("index") if settings_btn else None
        if idx_st is None:
            return "Failed: Không tìm thấy nút 'Cài đặt' của Nhóm."

        x_st, y_st = ui_groups.get_element_coords(idx_st)
        logger.info("[facebook_navigate_to_group] Tap vào 'Cài đặt'")
        await ctx.driver.tap(x_st, y_st)
        await asyncio.sleep(3.0)

        # 2. Tìm và click Đang theo dõi
        ui_settings = await ctx.state_provider.get_state()
        els_settings = ui_settings.elements if ui_settings else []
        following_btn = _find_element_by_keywords(els_settings, "Đang theo dõi", "Theo dõi hoặc bỏ theo dõi", "Following", "Theo dõi")
        idx_fw = following_btn.get("index") if following_btn else None
        if idx_fw is None:
            return "Failed: Không tìm thấy nút 'Đang theo dõi' trong Cài đặt."

        x_fw, y_fw = ui_settings.get_element_coords(idx_fw)
        logger.info("[facebook_navigate_to_group] Tap vào 'Đang theo dõi'")
        await ctx.driver.tap(x_fw, y_fw)
        await asyncio.sleep(3.0)

        # 3. Quét tìm nhóm trong danh sách Đang theo dõi
        ui_list = await ctx.state_provider.get_state()
        els_list = ui_list.elements if ui_list else []

        # Phân nhánh 1: Nếu thấy nhóm ngay thì click vào
        target_el = _find_element_exact(els_list, search_keyword, group_name.strip()) or \
                    _find_element_by_keywords(els_list, search_keyword, group_name.strip())
        idx_t = target_el.get("index") if target_el else None
        if idx_t is not None:
            x_t, y_t = ui_list.get_element_coords(idx_t)
            logger.info(f"[facebook_navigate_to_group] Tìm thấy nhóm '{search_keyword}' ngay tại trang Đang theo dõi")
            await ctx.driver.tap(x_t, y_t)
            await asyncio.sleep(4.0)
            return f"Success: Đã vào nhóm '{group_name.strip()}' thành công."

        # Phân nhánh 2: Nếu không thấy, bấm vào Tìm kiếm nhóm và nhập từ khóa tìm kiếm
        search_btn = _find_element_by_keywords(els_list, "Tìm kiếm nhóm", "Search groups", "Tìm kiếm")
        idx_s = search_btn.get("index") if search_btn else None
        if idx_s is None:
            return "Failed: Không tìm thấy nút Tìm kiếm nhóm trên trang Đang theo dõi."

        x_s, y_s = ui_list.get_element_coords(idx_s)
        logger.info("[facebook_navigate_to_group] Bấm nút 'Tìm kiếm nhóm'")
        await ctx.driver.tap(x_s, y_s)
        await asyncio.sleep(2.5)

        # Quét screen xem nhóm có sẵn trong lịch sử tìm kiếm/gợi ý không
        ui_prep = await ctx.state_provider.get_state()
        els_prep = ui_prep.elements if ui_prep else []
        
        target_el = None
        for el in els_prep:
            txt = (el.get("text") or el.get("content-desc") or "").strip().lower()
            cls = (el.get("className") or "").lower()
            # Bỏ qua ô nhập liệu (EditText) để tránh nhận diện nhầm ô search trống
            if "edit" in cls or "search" in cls:
                continue
            if txt == group_name.strip().lower() or txt == search_keyword.lower():
                target_el = el
                break
                    
        if target_el:
            idx_t = target_el.get("index")
            x_t, y_t = ui_prep.get_element_coords(idx_t)
            logger.info(f"[facebook_navigate_to_group] Tìm thấy nhóm/từ khóa '{group_name.strip()}' có sẵn trên màn hình, tap trực tiếp tại ({x_t}, {y_t})...")
            await ctx.driver.tap(x_t, y_t)
            await asyncio.sleep(4.0)
            return f"Success: Đã vào nhóm '{group_name.strip()}' thành công (qua lịch sử tìm kiếm trong Đang theo dõi)."

        else:
            logger.info(f"[facebook_navigate_to_group] Nhập từ khóa tìm kiếm (bằng clipboard): '{search_keyword}'")
            await ctx.driver.input_text(search_keyword)
            await asyncio.sleep(2.0)
            await ctx.driver.device.shell("input keyevent 66")
            await asyncio.sleep(3.0)
     
            # 4. Quét kết quả tìm kiếm và chọn nhóm
            ui_search_result = await ctx.state_provider.get_state()
            els_search_result = ui_search_result.elements if ui_search_result else []
        result_el = _find_element_exact(els_search_result, search_keyword, group_name.strip()) or \
                    _find_element_by_keywords(els_search_result, search_keyword, group_name.strip())
        idx_r = result_el.get("index") if result_el else None
        if idx_r is None:
            return f"Failed: Không tìm thấy nhóm '{group_name.strip()}' sau khi tìm kiếm."

        x_r, y_r = ui_search_result.get_element_coords(idx_r)
        logger.info(f"[facebook_navigate_to_group] Chọn nhóm '{search_keyword}' trong kết quả tìm kiếm")
        await ctx.driver.tap(x_r, y_r)
        await asyncio.sleep(4.0)
        return f"Success: Đã vào nhóm '{group_name.strip()}' thành công."

    except Exception as e:
        return f"Failed: Lỗi tìm kiếm và định vị nhóm — {e}"


async def _switch_pending_sub_tab(ctx, tab: str) -> tuple[bool, str]:
    """Inside the FB admin queue, switch between the two sub-tabs:
    "Bài viết đang chờ" (approval) and "Có thể là spam" (maybe_spam).

    Assumes caller already opened the admin queue (open_pending_tab returned OK).
    """
    keywords_approval = ("bài viết đang chờ", "bài đang chờ", "đang chờ", "pending posts")
    keywords_spam = ("có thể là spam", "có thể spam", "spam", "possible spam", "maybe spam")
    target_kw = keywords_spam if tab == "maybe_spam" else keywords_approval
    try:
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        sub_tab = _find_element_by_keywords(els, *target_kw)
        if sub_tab is None:
            return False, f"Không tìm thấy sub-tab '{tab}' trong admin queue."
        idx = sub_tab.get("index")
        if idx is None:
            return False, f"Sub-tab '{tab}' không có index."
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)
        return True, ""
    except Exception as e:
        return False, f"Lỗi switch sub-tab '{tab}' — {e}"


async def facebook_group_open_pending_tab(group_name: str, tab: str = "approval", *, ctx, **kwargs) -> str:
    """Vào group và mở tab admin queue (Bài chờ duyệt / Có thể là spam).

    Tiền điều kiện: agent đang đăng nhập bằng tài khoản FB admin của group.

    Params:
      - group_name: tên group
      - tab: 'approval' (default — "Bài viết đang chờ") hoặc 'maybe_spam'
             ("Có thể là spam")

    Quy trình:
    1. Tap ☰ → "Nhóm" hoặc dùng facebook_navigate_to_group(group_name)
    2. Khi vào trong group, mở menu admin.
    3. Tap vào tab "Bài chờ duyệt" (mặc định FB hiển thị sub-tab "Bài viết đang chờ").
    4. Nếu tab='maybe_spam' → tap thêm sub-tab "Có thể là spam".

    Trả về "OK" khi đã ở đúng sub-tab; "Failed: <lý do>" nếu kẹt.
    """
    if not group_name or not group_name.strip():
        return "Failed: Tên nhóm không được để trống."
    if tab not in ("approval", "maybe_spam"):
        return f"Failed: tab='{tab}' không hợp lệ (chỉ chấp nhận 'approval' hoặc 'maybe_spam')."

    # Bước 1: navigate vào group
    nav = await facebook_navigate_to_group(group_name, ctx=ctx)
    if not nav.lower().startswith(("đã vào", "vào nhóm", "ok", "đang", "tìm thấy")):
        # facebook_navigate_to_group có thể trả nhiều dạng — relax check
        if nav.lower().startswith("failed"):
            return f"Failed: [open_pending_tab bước 1] {nav}"

    # Bước 2 + 3: tìm + tap "Bài chờ duyệt" (heuristic giống các tool khác)
    try:
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []
        pending_btn = _find_element_by_keywords(
            els,
            "bài chờ duyệt", "bài đang chờ duyệt",
            "pending posts", "post approval", "đang chờ duyệt",
        )
        if pending_btn is None:
            # Nhiều khi cần mở menu admin trước (icon huy hiệu / 3 chấm)
            admin_btn = _find_element_by_keywords(els, "công cụ quản trị", "admin tools", "công cụ admin")
            if admin_btn is not None:
                idx = admin_btn.get("index")
                x, y = ui.get_element_coords(idx)
                await ctx.driver.tap(x, y)
                await asyncio.sleep(2.0)
                ui = await ctx.state_provider.get_state()
                els = ui.elements if ui else []
                pending_btn = _find_element_by_keywords(
                    els, "bài chờ duyệt", "pending posts", "đang chờ duyệt",
                )
        if pending_btn is None:
            return (
                "Failed: Không tìm thấy mục 'Bài chờ duyệt' — có thể tài khoản "
                "không có quyền admin trong nhóm này."
            )
        idx = pending_btn.get("index")
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.5)

        # Bước 4: switch sub-tab nếu cần (mặc định FB hiển thị "Bài viết
        # đang chờ"; cần explicit tap nếu user chọn 'maybe_spam').
        if tab == "maybe_spam":
            ok, err = await _switch_pending_sub_tab(ctx, tab)
            if not ok:
                return f"Failed: [open_pending_tab bước 4] {err}"
        return "OK"
    except Exception as e:
        return f"Failed: [open_pending_tab bước 2] {e}"


async def _scrape_visible_pending_cards(ctx, tab: str) -> list[dict]:
    """Scrape cards trên màn hình hiện tại và stamp ``pending_tab=tab``.

    Best-effort: dò các nút "Phê duyệt" / "Approve" để identify card cha,
    rồi extract author + content text. FB Android không expose post_fb_id
    qua content-desc nên dùng content fingerprint.
    """
    ui = await ctx.state_provider.get_state()
    els = ui.elements if ui else []
    posts: list[dict] = []
    approve_buttons = [
        el for el in els
        if "phê duyệt" in ((el.get("text") or "") + (el.get("content-desc") or "")).lower()
        or "approve" in ((el.get("text") or "") + (el.get("content-desc") or "")).lower()
    ]
    for approve in approve_buttons:
        card = approve.get("parent") or {}
        posts.append({
            "post_fb_id": "",  # TODO: trích từ DOM thực tế khi có UI dump
            "post_url": "",
            "author_name": (card.get("text") or "").splitlines()[0][:255] if card.get("text") else "",
            "author_uid": "",
            "content": (card.get("text") or "")[:2000],
            "image_urls": [],
            "posted_at": None,
            "pending_tab": tab,
        })
    return posts


async def facebook_group_fetch_pending_list(*, ctx, **kwargs) -> str:
    """Scrape danh sách bài chờ duyệt trong CẢ HAI sub-tab admin queue.

    Tiền điều kiện: đã ở màn hình admin queue của group (gọi
    ``facebook_group_open_pending_tab`` với tab='approval' trước).

    Quy trình:
    1. Scrape sub-tab "Bài viết đang chờ" hiện tại → mark pending_tab='approval'.
    2. Tap sang sub-tab "Có thể là spam" → scrape → mark pending_tab='maybe_spam'.
       (Skip nếu sub-tab không tồn tại — group không có post nào bị flag.)
    3. Gộp 2 list → raw_context['pending_posts'].

    Mỗi card cần trích: post_fb_id, post_url, author_name, author_uid, content,
    image_urls, posted_at, pending_tab.

    Trả về: "Đã scrape N bài (A chờ duyệt, B có thể spam)." hoặc Failed.
    """
    from task_context import get_raw_context

    try:
        all_posts: list[dict] = []

        # Sub-tab 1: Bài viết đang chờ duyệt (đang ở đây sau open_pending_tab).
        approval_posts = await _scrape_visible_pending_cards(ctx, "approval")
        logger.info("[fetch_pending_list] sub-tab approval: %d bài.", len(approval_posts))
        all_posts.extend(approval_posts)

        # Sub-tab 2: Có thể là spam — chuyển sang nếu có.
        ok, err = await _switch_pending_sub_tab(ctx, "maybe_spam")
        if ok:
            spam_posts = await _scrape_visible_pending_cards(ctx, "maybe_spam")
            logger.info("[fetch_pending_list] sub-tab maybe_spam: %d bài.", len(spam_posts))
            all_posts.extend(spam_posts)
            # Tap về lại sub-tab approval để màn hình trở về state quen thuộc.
            await _switch_pending_sub_tab(ctx, "approval")
        else:
            logger.info(
                "[fetch_pending_list] skip maybe_spam tab — %s", err,
            )

        raw = get_raw_context()
        raw["pending_posts"] = all_posts
        approval_n = sum(1 for p in all_posts if p.get("pending_tab") == "approval")
        spam_n = sum(1 for p in all_posts if p.get("pending_tab") == "maybe_spam")
        return f"Đã scrape {len(all_posts)} bài ({approval_n} chờ duyệt, {spam_n} có thể spam)."
    except Exception as e:
        return f"Failed: [fetch_pending_list] {e}"


async def _facebook_group_decide_pending(
    decision: str,
    post_fb_id: str,
    author_name: str,
    content_excerpt: str,
    pending_tab: str = "approval",
    *,
    ctx,
) -> str:
    """Internal: tìm card bài đang chờ duyệt + tap Phê duyệt hoặc Từ chối.

    *pending_tab*: 'approval' (Bài viết đang chờ) hoặc 'maybe_spam' (Có thể là
    spam). Tool sẽ tap đúng sub-tab trước khi search card — caller phải đã
    gọi ``facebook_group_open_pending_tab`` để vào admin queue.
    """
    if decision not in ("approve", "reject"):
        return f"Failed: decision='{decision}' không hợp lệ."
    if pending_tab not in ("approval", "maybe_spam"):
        return f"Failed: pending_tab='{pending_tab}' không hợp lệ."
    keyword_btn = "phê duyệt" if decision == "approve" else "từ chối"
    keyword_btn_en = "approve" if decision == "approve" else "reject"

    # Đảm bảo đúng sub-tab trước khi search card.
    ok, err = await _switch_pending_sub_tab(ctx, pending_tab)
    if not ok and pending_tab == "maybe_spam":
        return f"Failed: [{decision}_pending] {err}"

    try:
        ui = await ctx.state_provider.get_state()
        els = ui.elements if ui else []

        # Tìm card chứa author_name + content_excerpt — đây là heuristic
        # match-by-text vì FB Android app không expose post_fb_id rõ ràng.
        haystack_text = ((author_name or "") + " " + (content_excerpt or "")).lower()[:64]
        target_card = None
        for el in els:
            text = ((el.get("text") or "") + " " + (el.get("content-desc") or "")).lower()
            if author_name and author_name.lower() in text:
                target_card = el
                break
            if content_excerpt and content_excerpt[:40].lower() in text:
                target_card = el
                break

        if target_card is None:
            return (
                f"Failed: Không tìm thấy bài của '{author_name}' "
                f"(haystack={haystack_text!r}) trên danh sách hiện tại — "
                "có thể cần cuộn để hiển thị."
            )

        # Trong cùng cluster của card, tìm nút Phê duyệt/Từ chối tương ứng.
        # Đơn giản hoá: tìm nút keyword_btn gần nhất trong toàn elements.
        decide_btn = _find_element_by_keywords(els, keyword_btn, keyword_btn_en)
        if decide_btn is None:
            return f"Failed: Không thấy nút '{keyword_btn}' trên màn hình."

        idx = decide_btn.get("index")
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        await asyncio.sleep(2.0)
        verb_vi = "duyệt" if decision == "approve" else "từ chối"
        return f"Đã {verb_vi} bài của {author_name}."
    except Exception as e:
        return f"Failed: [{decision}_pending] {e}"


async def facebook_group_approve_pending_post(
    post_fb_id: str = "",
    author_name: str = "",
    content_excerpt: str = "",
    pending_tab: str = "approval",
    *,
    ctx,
    **kwargs,
) -> str:
    """Duyệt 1 bài đăng đang chờ trong group.

    Tiền điều kiện: đã mở tab "Bài chờ duyệt" của group (gọi
    facebook_group_open_pending_tab trước). Tool sẽ tap đúng sub-tab
    (approval / maybe_spam) trước khi search card, rồi tap nút "Phê duyệt".
    """
    return await _facebook_group_decide_pending(
        "approve", post_fb_id, author_name, content_excerpt, pending_tab, ctx=ctx,
    )


async def facebook_group_reject_pending_post(
    post_fb_id: str = "",
    author_name: str = "",
    content_excerpt: str = "",
    pending_tab: str = "approval",
    *,
    ctx,
    **kwargs,
) -> str:
    """Từ chối 1 bài đăng đang chờ trong group.

    Cùng cơ chế với facebook_group_approve_pending_post nhưng tap nút "Từ chối".
    """
    return await _facebook_group_decide_pending(
        "reject", post_fb_id, author_name, content_excerpt, pending_tab, ctx=ctx,
    )


async def facebook_download_media(url: str, filename: str = None, media_type: str = None, *, ctx, **kwargs) -> str:
    """Tải ảnh hoặc video chuyên dụng từ bất kỳ nguồn nào (Pinterest, Google Images, YouTube, TikTok, v.v.).
    
    Quy trình:
    1. Xác định loại media (ảnh hoặc video). Nếu để trống, tự động đoán từ URL.
    2. Nếu là VIDEO: sử dụng yt-dlp.
    3. Nếu là ẢNH: sử dụng gallery-dl.
    4. Đẩy file lên thiết bị Android qua ADB và quét Media Scanner.
    """
    if not url or not url.strip():
        return "Failed: URL không được để trống."
        
    clean_url = url.strip()
    if not (clean_url.startswith("http://") or clean_url.startswith("https://")):
        return f"Failed: URL phải bắt đầu bằng http:// hoặc https:// — nhận được: {clean_url[:60]}"
        
    device_id = ctx.driver.device.serial
    logger.info("[facebook_download_media] Bắt đầu tải: %s", clean_url)

    # Thư mục tạm trên host
    temp_dir = Path(__file__).parent / "temp_downloads"
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Tự động xác định media_type nếu không được truyền vào
    media_type = (media_type or "").strip().lower()
    if not media_type:
        url_lower = clean_url.lower()
        if any(ext in url_lower for ext in [".mp4", ".mov", ".avi", ".mkv", "youtube.com", "youtu.be", "tiktok.com"]):
            media_type = "video"
        else:
            media_type = "image"

    import sys
    import time
    import subprocess
    import shutil

    temp_prefix = f"fb_{media_type}_{int(time.time())}"
    local_path = None

    try:
        if media_type == "video":
            # ── Dùng yt-dlp để tải Video ──
            logger.info("[facebook_download_media] Sử dụng yt-dlp để tải Video...")
            temp_output_pattern = str(temp_dir / f"{temp_prefix}.%(ext)s")
            
            cmd = [
                sys.executable, "-m", "yt_dlp",
                "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "--no-playlist",
                "--force-overwrites",
                "-o", temp_output_pattern,
                clean_url
            ]
            logger.info("[facebook_download_media] Chạy lệnh: %s", " ".join(cmd))
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                err = proc.stderr.strip()[-300:]
                return f"Failed: yt-dlp tải video thất bại. Chi tiết: {err}"

        else:
            # ── Dùng gallery-dl để tải Ảnh ──
            logger.info("[facebook_download_media] Sử dụng gallery-dl để tải Ảnh...")
            temp_output_pattern = f"{temp_prefix}.{{extension}}"
            
            cmd = [
                sys.executable, "-m", "gallery_dl",
                "--dest", str(temp_dir),
                "--filename", temp_output_pattern,
                clean_url
            ]
            logger.info("[facebook_download_media] Chạy lệnh: %s", " ".join(cmd))
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                err = proc.stderr.strip()[-300:]
                return f"Failed: gallery-dl tải ảnh thất bại. Chi tiết: {err}"

        # ── Quét tìm file đã tải về (hỗ trợ đệ quy thư mục con của gallery-dl) ──
        downloaded_files = list(temp_dir.glob(f"**/{temp_prefix}.*"))
        if not downloaded_files:
            return f"Failed: Tải thành công nhưng không tìm thấy file có tiền tố '{temp_prefix}' trong thư mục tạm."

        downloaded_file = downloaded_files[0]
        resolved_ext = downloaded_file.suffix

        # Đổi tên file về tên filename mong muốn của người dùng
        if not filename or not filename.strip():
            filename = f"fb_media_{int(time.time())}{resolved_ext}"
        else:
            filename = filename.strip()
            if not filename.endswith(resolved_ext):
                filename = filename + resolved_ext

        local_path = temp_dir / filename
        if local_path.exists():
            local_path.unlink()
            
        downloaded_file.rename(local_path)
        logger.info("[facebook_download_media] Tải và xử lý file thành công tại host: %s", local_path)

    except Exception as e:
        return f"Failed: Lỗi trong quá trình xử lý tải file — {e}"

    if not local_path or not local_path.exists() or os.path.getsize(local_path) == 0:
        return "Failed: File tải về trống hoặc không tồn tại."

    # ── Đẩy file lên thiết bị Android qua ADB ──────────────────────────
    device_dest_path = f"/sdcard/Download/{filename}"
    try:
        logger.info("[facebook_download_media] Đang đẩy file lên thiết bị: %s -> %s", local_path, device_dest_path)
        if hasattr(ctx.driver.device, "push"):
            ctx.driver.device.push(str(local_path), device_dest_path)
        else:
            subprocess.run(["adb", "-s", device_id, "push", str(local_path), device_dest_path], check=True)
        logger.info("[facebook_download_media] Đã đẩy file lên thiết bị thành công")
    except Exception as e:
        return f"Failed: Lỗi khi đẩy file lên thiết bị Android qua ADB — {e}"
    finally:
        # Xóa file tạm trên máy host để dọn dẹp bộ nhớ và các thư mục con rỗng
        if local_path and local_path.exists():
            try:
                local_path.unlink()
            except Exception:
                pass
        # Xóa các thư mục con rỗng trong temp_downloads
        try:
            for root, dirs, files in os.walk(str(temp_dir), topdown=False):
                for name in dirs:
                    dir_path = os.path.join(root, name)
                    if not os.listdir(dir_path):
                        os.rmdir(dir_path)
        except Exception:
            pass

    # ── Kích hoạt quét MediaStore trên Android để cập nhật thư viện ────
    try:
        logger.info("[facebook_download_media] Đang kích hoạt Media Scanner cho file: %s", device_dest_path)
        await ctx.driver.device.shell(
            f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{device_dest_path}"
        )
        await ctx.driver.device.shell(
            f"content call --uri content://media --method scan_file --arg '{device_dest_path}'"
        )
        logger.info("[facebook_download_media] Đồng bộ thư viện ảnh điện thoại thành công.")
    except Exception as e:
        logger.warning("[facebook_download_media] Lỗi Media Scanner (vẫn bỏ qua tiếp tục): %s", e)

    return f"Success: Đã tải và đồng bộ ảnh/video lên thiết bị tại: {device_dest_path}"


# ---------------------------------------------------------------------------
# Phase 3 — Seeding helpers (open post URL via deep-link, capture comment URL)
# ---------------------------------------------------------------------------


async def facebook_seed_open_post_url(post_url: str, *, ctx, **kwargs) -> str:
    """Mở 1 URL bài viết Facebook trong app Facebook qua deep-link intent.

    Sau khi tool trả về Success, app FB sẽ ở màn hình chi tiết bài viết —
    LLM có thể tap "Thích" / "Bình luận" / quét comment thread như bình thường.
    """
    if not post_url or not post_url.strip():
        return "Failed: post_url không được để trống."
    url = post_url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return f"Failed: post_url phải là http(s) URL — nhận được: {url[:80]}"
    try:
        await ctx.driver.device.shell(
            f"am start -a android.intent.action.VIEW -d \"{url}\" "
            f"-p {_FACEBOOK_PKG}"
        )
        # Cho FB load chi tiết bài viết
        await asyncio.sleep(4.0)
        return f"Success: Đã mở bài viết {url[:120]}"
    except Exception as e:
        return f"Failed: Không mở được post URL — {e}"


async def _capture_last_comment_url(ctx) -> str:
    """Lấy URL của 1 bình luận (menu long-press đã mở sẵn): tap "Chia sẻ bình
    luận" / "Chia sẻ" / "Share" → trong bảng chia sẻ tap "Sao chép liên kết" →
    đọc clipboard, parse FB URL. Returns '' on failure.

    LƯU Ý FB: trong menu long-press, "Sao chép" chỉ copy TEXT bình luận — KHÔNG
    phải link. Muốn lấy LINK phải qua "Chia sẻ"/"Share" rồi mới có "Sao chép liên kết".
    """
    async def _scan(delay: float = 1.2):
        await asyncio.sleep(delay)
        ui = await ctx.state_provider.get_state()
        return ui, (ui.elements if ui else [])

    async def _tap_el(ui, el) -> bool:
        idx = el.get("index") if el else None
        if idx is None:
            return False
        x, y = ui.get_element_coords(idx)
        await ctx.driver.tap(x, y)
        return True

    try:
        ui, els = await _scan()

        # Nếu bảng chia sẻ đã mở sẵn → tìm "Sao chép liên kết" luôn.
        copy_link = _find_element_by_keywords(els, "Sao chép liên kết", "Copy link")
        if copy_link is None:
            # Bước 1: bấm "Chia sẻ" (KHÔNG bấm "Sao chép" trơn — chỉ copy text).
            share = (
                _find_clickable_element_by_keywords(
                    els, "Chia sẻ bình luận", "Chia sẻ liên kết", "Chia sẻ", "Share")
                or _find_element_by_keywords(
                    els, "Chia sẻ bình luận", "Chia sẻ liên kết", "Chia sẻ", "Share")
            )
            if share is None:
                logger.info("[capture_comment_url] không thấy 'Chia sẻ'/'Share' trong menu.")
                return ''
            await _tap_el(ui, share)
            ui, els = await _scan(1.5)
            copy_link = _find_element_by_keywords(els, "Sao chép liên kết", "Copy link")
            # Bảng chia sẻ có thể cần cuộn để lộ "Sao chép liên kết".
            if copy_link is None:
                try:
                    raw = await ctx.driver.device.shell("wm size")
                    sw, sh = 1080, 2400
                    for line in raw.splitlines():
                        if "size" in line.lower():
                            p = line.split(":")[-1].strip().split("x")
                            if len(p) == 2:
                                sw, sh = int(p[0]), int(p[1])
                    await ctx.driver.swipe(int(sw * 0.5), int(sh * 0.8), int(sw * 0.5), int(sh * 0.45), 400)
                except Exception:
                    pass
                ui, els = await _scan(1.0)
                copy_link = _find_element_by_keywords(els, "Sao chép liên kết", "Copy link")

        if copy_link is None:
            logger.info("[capture_comment_url] không tìm thấy 'Sao chép liên kết'.")
            return ''

        await _tap_el(ui, copy_link)
        await asyncio.sleep(1.5)
        clip = await _read_clipboard(ctx)
        url = _extract_fb_post_url(clip)
        if url:
            logger.info("[capture_comment_url] OK: %s", url[:80])
        return url
    except Exception as e:
        logger.warning("[capture_comment_url] lỗi — %s", e)
        return ''


async def facebook_capture_comment_link(*, ctx, **kwargs) -> str:
    """Gọi NGAY khi menu long-press của comment đang mở. Tool tự bấm "Chia sẻ bình
    luận"/"Chia sẻ"/"Share" → trong bảng chia sẻ bấm "Sao chép liên kết" → đọc
    clipboard, parse URL và stamp vào raw_context['comment_url'].

    Dùng trong skill ``facebook_find_comment_link``: một tài khoản KHÁC trong cụm
    mở bài đăng, định vị comment gốc (theo tên tác giả + đoạn text), long-press để
    hiện menu, rồi gọi tool này. (FB không cho copy link comment của CHÍNH mình nên
    phải nhờ tài khoản khác; và phải qua "Chia sẻ" — "Sao chép" trơn chỉ copy
    TEXT.) task_executor publish ``comment_url`` về control để lưu
    ``plan.comment_link`` cho cụm reply.

    Best-effort: không lấy được vẫn trả Success (caller quyết định retry).
    """
    url = await _capture_last_comment_url(ctx)
    if url:
        try:
            from task_context import get_raw_context
            get_raw_context()["comment_url"] = url
        except Exception as e:  # pragma: no cover
            logger.warning("[capture_comment_link] stamp raw_context lỗi — %s", e)
            return f"Success: lấy được link nhưng chưa stamp được ({url[:80]})."
        return f"Success: Đã lấy link comment — {url[:120]}"
    return "Failed: Không lấy được link comment (caller nên retry bằng tài khoản khác)."


# ---------------------------------------------------------------------------

# Precondition helpers
# ---------------------------------------------------------------------------


def screen_guard(*required_keywords: str):
    """Return a precondition callable that passes when any keyword is found on screen."""
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
    """Return a precondition callable that passes when the foreground activity matches."""
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


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

TOOLS: dict = {
    "facebook_check_current_account": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": (
                    "Tên gọi thân thiện của tài khoản Facebook cần kiểm tra "
                    "(VD: 'Profile A'). Phải khớp với key trong profile_mapping.yaml."
                ),
            }
        },
        "description": (
            "Khi Facebook đang ở News Feed, kiểm tra tài khoản đang đăng nhập có "
            "khớp với profile yêu cầu không. Tool tự tap vào tab 'Trang cá nhân' "
            "(fallback sang ☰), đọc tên hiển thị và so sánh với display_name "
            "trong profile_mapping.yaml. "
            "Trả về 'Đúng tài khoản' nếu khớp. "
            "Trả về 'Sai tài khoản: ... — Hãy đăng xuất và đăng nhập lại' "
            "nếu không khớp — khi đó LLM cần tự thực hiện logout rồi login đúng tài khoản."
        ),
        "function": facebook_check_current_account,
    },
    "facebook_do_login": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": (
                    "Tên gọi thân thiện của tài khoản Facebook cần đăng nhập "
                    "(VD: 'Profile A'). Phải khớp với key trong profile_mapping.yaml."
                ),
            }
        },
        "description": (
            "Thực hiện toàn bộ flow đăng nhập Facebook trong 1 lần gọi. "
            "Gọi tool này khi cần đăng nhập (màn hình login hoặc sai tài khoản). "
            "Tool tự động: (1) tap 'Tôi có trang cá nhân rồi' nếu có, "
            "(2) dùng Google Password Manager nếu xuất hiện / điền form thủ công nếu không, "
            "(3) xử lý màn hình 'Lưu thông tin đăng nhập?' — tap 'Lưu' nếu đúng tài khoản, "
            "'Lúc khác' nếu sai. "
            "Trả về: 'Đăng nhập thành công' hoặc 'Sai tài khoản sau đăng nhập'."
        ),
        "function": facebook_do_login,
    },
    "facebook_get_credentials": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": (
                    "Tên gọi thân thiện của tài khoản Facebook (VD: 'Profile A', 'profile2'). "
                    "Phải khớp với key trong file profile_mapping.yaml."
                ),
            }
        },
        "description": (
            "Tra cứu thông tin đăng nhập Facebook (username, password, display_name) "
            "từ file profile_mapping.yaml theo tên gọi thân thiện. "
            "Gọi tool này khi cần biết credentials để đăng nhập — "
            "sau đó tự điền username vào ô email/phone và password vào ô mật khẩu. "
            "Trả về: 'username: ..., password: ..., display_name: ...' nếu thành công, "
            "hoặc 'Failed: ...' nếu không tìm thấy profile."
        ),
        "function": facebook_get_credentials,
    },
    "facebook_dismiss_popup": {
        "parameters": {},
        "description": (
            "Dismiss any popup, advertisement, or overlay that is blocking "
            "the Facebook screen. Tries Close/Skip/Đóng buttons then falls "
            "back to the system Back button."
        ),
        "function": dismiss_popup,
    },
    "facebook_open_comment_section": {
        "parameters": {},
        "description": (
            "Open the comment section of the currently displayed Facebook video or post. "
            "Call this before you attempt to read or type comments."
        ),
        "function": open_comment_section,
        "precondition": screen_guard("Bình luận", "Comment", "comment"),
    },
    "facebook_type_comment": {
        "parameters": {
            "text": {"type": "string", "required": True},
        },
        "description": (
            "Type the given text into the Facebook comment input field. "
            "Call facebook_open_comment_section first if the comment section is not yet open."
        ),
        "function": type_comment,
        "precondition": screen_guard(
            "add comment", "write a comment", "comment…",
            "nhập bình luận", "comment_text",
        ),
    },
    "facebook_post_comment": {
        "parameters": {},
        "description": (
            "Tap the Post/Send button to submit the comment that was typed "
            "with facebook_type_comment."
        ),
        "function": post_comment,
        "precondition": screen_guard("post", "send", "đăng", "gửi"),
    },
    "facebook_ensure_screen_on": {
        "parameters": {},
        "description": (
            "Wake up the device screen if it is off and unlock it, then press Home. "
            "Use this at the start of any task to guarantee the device is in a usable state."
        ),
        "function": ensure_screen_on,
    },
    "facebook_run_adb_command": {
        "parameters": {
            "command": {"type": "string", "required": True},
        },
        "description": (
            "Run an arbitrary ADB shell command on the connected Android device. "
            "Returns the stdout output or a failure message."
        ),
        "function": run_adb_command,
    },
    "facebook_create_post": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên profile cần đăng bài (VD: 'Profile A').",
            },
            "content": {
                "type": "string",
                "required": True,
                "description": "Nội dung bài viết cần đăng.",
            },
            "media_path": {
                "type": "string",
                "required": False,
                "description": "Đường dẫn tệp ảnh/video đã tải lên trên thiết bị (VD: '/sdcard/Download/...').",
            },
            "has_media": {
                "type": "boolean",
                "required": False,
                "description": "Nếu truyền True, sẽ tự động đính kèm tệp phương tiện vừa tải về từ thư viện.",
            },
            "media_count": {
                "type": "integer",
                "required": False,
                "description": "Số lượng tệp phương tiện cần đính kèm từ thư viện (mặc định là 1).",
            },
            "anonymous": {
                "type": "boolean",
                "required": False,
                "description": (
                    "Chỉ áp dụng khi đăng bài vào Facebook Group. Khi True, tool sẽ "
                    "tự bật toggle 'Đăng ẩn danh' trước khi nhấn Đăng. Nếu group "
                    "không hỗ trợ anonymous → tool trả Failed để tránh lộ danh tính."
                ),
            },
        },
        "description": (
            "Tự động thực hiện toàn bộ flow đăng bài viết (post) lên trang cá nhân "
            "hoặc nhóm của profile Facebook chỉ định. Tool sẽ vuốt tìm ô đăng bài, "
            "nhập nội dung, đính kèm ảnh/video nếu được yêu cầu, ẩn bàn phím ảo và ấn nút Đăng. "
            "Truyền anonymous=True khi đăng vào Group để bật chế độ ẩn danh."
        ),
        "function": facebook_create_post,
    },
    "facebook_change_avatar": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên profile Facebook cần đổi avatar (VD: 'BS. A').",
            },
        },
        "description": (
            "Đổi ảnh đại diện trang cá nhân Facebook. Ảnh phải đã được worker "
            "tải sẵn vào /sdcard/Download/ — tool sẽ chọn ảnh mới nhất (mục 1) "
            "trong thư viện làm avatar mới."
        ),
        "function": facebook_change_avatar,
    },
    "facebook_change_cover": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên profile Facebook cần đổi ảnh bìa.",
            },
        },
        "description": (
            "Đổi ảnh bìa trang cá nhân Facebook. Ảnh phải đã được worker tải "
            "sẵn vào /sdcard/Download/ — tool sẽ chọn ảnh mới nhất (mục 1) "
            "trong thư viện làm cover mới."
        ),
        "function": facebook_change_cover,
    },
    "facebook_post_story": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên profile Facebook cần đăng Story.",
            },
        },
        "description": (
            "Đăng 1 tin nổi bật (Story) bằng ảnh đã có trong gallery. Ảnh phải "
            "đã được worker tải sẵn vào /sdcard/Download/ — tool sẽ chọn ảnh "
            "mới nhất (mục 1) và đăng ngay (không thêm text/sticker)."
        ),
        "function": facebook_post_story,
    },
    "facebook_post_to_fanpage": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên profile Facebook đang đăng nhập (VD: 'Profile A').",
            },
            "fanpage_name": {
                "type": "string",
                "required": True,
                "description": "Tên Fanpage Facebook cần đăng bài (VD: 'Trang Làm Đẹp Mẫu').",
            },
            "content": {
                "type": "string",
                "required": True,
                "description": "Nội dung bài viết cần đăng.",
            },
            "is_own_fanpage": {
                "type": "boolean",
                "required": False,
                "description": "Nếu truyền True/False, sẽ ghi đè việc tự động kiểm tra quyền sở hữu Fanpage.",
            },
            "media_path": {
                "type": "string",
                "required": False,
                "description": "Đường dẫn tệp ảnh/video đã tải lên trên thiết bị (VD: '/sdcard/Download/...').",
            },
            "has_media": {
                "type": "boolean",
                "required": False,
                "description": "Nếu truyền True, sẽ tự động đính kèm tệp phương tiện vừa tải về từ thư viện.",
            },
            "media_count": {
                "type": "integer",
                "required": False,
                "description": "Số lượng tệp phương tiện cần đính kèm từ thư viện (mặc định là 1).",
            },
        },
        "description": (
            "Đăng bài viết lên Fanpage Facebook được chỉ định. Tool tự động kiểm tra xem "
            "Fanpage đó là Trang của tôi (chính chủ sở hữu) hay Trang của người khác "
            "để gọi luồng xử lý chính xác, có hỗ trợ đính kèm ảnh/video từ thư viện."
        ),
        "function": facebook_post_to_fanpage,
    },
    "facebook_navigate_to_group": {
        "parameters": {
            "group_name": {
                "type": "string",
                "required": True,
                "description": (
                    "Tên của nhóm Facebook cần vào để đăng bài (VD: 'NHÓM MẪU 24H'). "
                    "Nên khớp với danh sách nhóm trong cấu hình."
                ),
            }
        },
        "description": (
            "Điều hướng từ News Feed chính vào một Nhóm (Facebook Group) đã tham gia. "
            "Tool sẽ tap vào tab Nhóm, tìm nhóm trong danh sách hiện tại (hoặc bấm Xem tất cả "
            "và cuộn tìm nếu không thấy). Trả về thông báo thành công hoặc thất bại."
        ),
        "function": facebook_navigate_to_group,
    },
    "facebook_group_open_pending_tab": {
        "parameters": {
            "group_name": {
                "type": "string",
                "required": True,
                "description": "Tên nhóm cần mở tab 'Bài chờ duyệt' (phải là admin).",
            },
            "tab": {
                "type": "string",
                "required": False,
                "description": (
                    "Sub-tab: 'approval' (mặc định, 'Bài viết đang chờ') hoặc "
                    "'maybe_spam' ('Có thể là spam' — FB tự flag)."
                ),
            },
        },
        "description": (
            "Vào group bằng facebook_navigate_to_group rồi mở tab admin queue. "
            "Tham số tab điều khiển sub-tab approval/maybe_spam. Trả 'OK' khi "
            "đã ở đúng màn hình; 'Failed: ...' nếu không tìm thấy."
        ),
        "function": facebook_group_open_pending_tab,
    },
    "facebook_group_fetch_pending_list": {
        "parameters": {},
        "description": (
            "Scrape CẢ HAI sub-tab 'Bài viết đang chờ' + 'Có thể là spam' của admin "
            "queue. Phải gọi facebook_group_open_pending_tab(tab='approval') trước. "
            "Mỗi bài stamp pending_tab field. Tool lưu list vào "
            "raw_context['pending_posts'] và task_executor sẽ publish ra Kafka."
        ),
        "function": facebook_group_fetch_pending_list,
    },
    "facebook_group_approve_pending_post": {
        "parameters": {
            "post_fb_id": {
                "type": "string",
                "required": False,
                "description": "ID FB của bài (nếu đã có sẵn từ raw_context).",
            },
            "author_name": {
                "type": "string",
                "required": False,
                "description": "Tên người đăng — dùng để tìm card trên màn hình.",
            },
            "content_excerpt": {
                "type": "string",
                "required": False,
                "description": "200 ký tự đầu của nội dung — fallback để khớp card.",
            },
            "pending_tab": {
                "type": "string",
                "required": False,
                "description": (
                    "'approval' hoặc 'maybe_spam' — sub-tab chứa bài cần duyệt. "
                    "Mặc định 'approval'."
                ),
            },
        },
        "description": (
            "Phê duyệt 1 bài đăng đang chờ trong group. Tool tự navigate sang đúng "
            "sub-tab (approval/maybe_spam) trước khi search card + tap 'Phê duyệt'."
        ),
        "function": facebook_group_approve_pending_post,
    },
    "facebook_group_reject_pending_post": {
        "parameters": {
            "post_fb_id": {
                "type": "string",
                "required": False,
                "description": "ID FB của bài (nếu đã có sẵn từ raw_context).",
            },
            "author_name": {
                "type": "string",
                "required": False,
                "description": "Tên người đăng — dùng để tìm card trên màn hình.",
            },
            "content_excerpt": {
                "type": "string",
                "required": False,
                "description": "200 ký tự đầu của nội dung — fallback để khớp card.",
            },
            "pending_tab": {
                "type": "string",
                "required": False,
                "description": (
                    "'approval' hoặc 'maybe_spam' — sub-tab chứa bài cần từ chối. "
                    "Mặc định 'approval'."
                ),
            },
        },
        "description": (
            "Từ chối 1 bài đăng đang chờ trong group. Cùng cơ chế với "
            "facebook_group_approve_pending_post nhưng tap nút 'Từ chối'."
        ),
        "function": facebook_group_reject_pending_post,
    },
    "facebook_download_media": {
        "parameters": {
            "url": {
                "type": "string",
                "required": True,
                "description": "URL trực tiếp của ảnh hoặc video cần tải xuống (VD: 'https://example.com/image.jpg').",
            },
            "filename": {
                "type": "string",
                "required": False,
                "description": "Tên file lưu trên điện thoại (tùy chọn, tự động tạo nếu để trống).",
            }
        },
        "description": (
            "Tải ảnh hoặc video từ internet về máy tính bằng aiohttp stream, đẩy lên thiết bị Android qua ADB, "
            "và đồng bộ với Thư viện ảnh để Facebook nhận diện lập tức. Trả về đường dẫn file thành công trên thiết bị."
        ),
        "function": facebook_download_media,
    },
    "facebook_copy_post_link": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên gọi thân thiện của tài khoản (VD: 'Lemon')."
            },
            "content": {
                "type": "string",
                "required": True,
                "description": "Nội dung bài đăng vừa đăng, dùng để đối chiếu tìm bài trên feed (≥80% khớp từ vựng)."
            },
            "post_type": {
                "type": "string",
                "required": False,
                "description": "Loại bài đăng: 'Trang cá nhân', 'Nhóm', 'Page' (mặc định là 'Trang cá nhân')."
            },
            "target_name": {
                "type": "string",
                "required": False,
                "description": "Tên Nhóm hoặc Page tương ứng nếu post_type là Nhóm hoặc Page."
            }
        },
        "description": (
            "Tìm bài viết vừa đăng trên feed bằng cách đối chiếu nội dung (≥80% khớp từ vựng), "
            "sau đó sao chép liên kết qua clipboard và đồng bộ lên backend."
        ),
        "function": facebook_copy_post_link,
    },
    "facebook_find_and_copy_post_link": {
        "parameters": {
            "profile_name": {
                "type": "string",
                "required": True,
                "description": "Tên gọi thân thiện của tài khoản (VD: 'Lemon')."
            },
            "content": {
                "type": "string",
                "required": True,
                "description": "Nội dung bài đăng cần tìm."
            },
            "post_type": {
                "type": "string",
                "required": False,
                "description": "Loại bài đăng cần tìm: 'Trang cá nhân', 'Nhóm', 'Page' (mặc định là 'Trang cá nhân')."
            },
            "target_name": {
                "type": "string",
                "required": False,
                "description": "Tên của Nhóm hoặc Page tương ứng nếu post_type là Nhóm hoặc Page."
            }
        },
        "description": (
            "Tìm bài viết trên Facebook (trang cá nhân, nhóm, hoặc fanpage) dựa trên nội dung, "
            "xem rộng toàn bộ bài viết nếu bị rút gọn bởi nút xem thêm, đối chiếu "
            "khớp tối thiểu 30% từ vựng, mở chi tiết và sao chép link đồng bộ lên backend."
        ),
        "function": facebook_find_and_copy_post_link,
    },
    "facebook_seed_open_post_url": {
        "parameters": {
            "post_url": {
                "type": "string",
                "required": True,
                "description": "URL bài đăng Facebook cần mở (VD: 'https://www.facebook.com/...').",
            },
        },
        "description": (
            "Mở đúng 1 bài đăng Facebook trong app Facebook qua deep-link intent. "
            "Dùng làm bước đầu tiên cho các skill seeding (like/comment/reply) khi "
            "đã biết URL bài viết — không cần điều hướng từ News Feed/profile."
        ),
        "function": facebook_seed_open_post_url,
    },
    "facebook_capture_comment_link": {
        "parameters": {},
        "description": (
            "Gọi ngay khi menu long-press của 1 bình luận đang mở. Tool tự bấm "
            "'Chia sẻ bình luận'/'Chia sẻ'/'Share' → trong bảng chia sẻ bấm 'Sao chép "
            "liên kết' → đọc clipboard và lưu link vào context (comment_url). Dùng trong "
            "skill find-comment-link để một tài khoản KHÁC lấy link comment gốc (FB không "
            "cho copy link comment của chính mình; 'Sao chép' trơn chỉ copy text)."
        ),
        "function": facebook_capture_comment_link,
    },
}