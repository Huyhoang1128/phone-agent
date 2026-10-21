"""
Prompts for the ManagerAgent.
"""

import re

# A subgoal header looks like "**Subgoal 1:** ...", "Subgoal 2: ...", "## Subgoal 1: ..." etc.
_SUBGOAL_HEADER_RE = re.compile(r"^\s*(?:\#{1,3}\s*|\*{0,2}\s*)subgoal\b", re.IGNORECASE)

# Các dấu "đã làm xong" mà model có thể dùng trong <plan>.
#
# Prompt (config/prompts/manager/stateless.jinja2) dặn model BỎ HẲN bước đã làm
# ra khỏi kế hoạch — "The first item is what the executor will do next" — nhưng
# thực tế model hay giữ lại bước cũ rồi đánh dấu nó. Bản trước chỉ nhận mỗi
# "✅", nên ngày 08/09 task 3546 gặp model đánh dấu bằng gạch ngang:
#
#     1. ~~Force-stop the Facebook app using run_adb_command(...)~~ — Completed.
#     2. Open Facebook via open_app(text="Facebook")...
#
# Dòng 1 không có "✅" nên hàm dưới trả về đúng nó suốt 30 lượt; executor mỗi
# lượt lại báo "subgoal đã xong rồi, chờ chút" và đốt một bước, tới khi chạm
# trần max_steps=30 — 336 giây, không đăng được bài nào. Cả file log hôm đó có
# 0 dấu "✅" và 29 dòng có "~~". Việc chạy được hay không hoá ra chỉ tuỳ hôm ấy
# model chọn kiểu đánh dấu nào, nên ở đây nhận HẾT các kiểu thường gặp thay vì
# trông chờ model nghe lời.
#
# Chữ "completed/done" CHỈ tính khi đứng CUỐI dòng sau một dấu phân cách, để câu
# mô tả bình thường như "Wait for the upload to complete" không bị hiểu nhầm là
# đã xong rồi bị bỏ qua oan.
# Nhãn đã-xong nằm CUỐI dòng, sau một dấu phân cách. Có cả tiếng Việt vì model
# hay viết plan bằng tiếng Việt khi goal là tiếng Việt — ngày 11/09 task 3573 kẹt
# đủ 20 bước vì dòng "1. Khởi động lại ứng dụng Facebook: đã hoàn thành." không
# khớp kiểu nào đang có (không ✅, không ~~, không [DONE], và "đã hoàn thành"
# chưa nằm trong danh sách).
#
# Bắt buộc phải có dấu phân cách ngay trước và kết thúc dòng ngay sau, để câu
# chưa làm như "Chờ cho tới khi upload hoàn thành" không bị hiểu nhầm là đã xong.
_DONE_TAIL_RE = re.compile(
    # Cho phép có một cụm giải thích trong ngoặc sau nhãn: task 3578 ngày 11/09
    # viết "1. Khởi động lại ứng dụng Facebook: đã hoàn tất (force-stop + open,
    # News Feed đã tải)." — nhãn không còn nằm cuối dòng nữa nên luật cũ trượt.
    r"[—\-–:(\[]\s*(?:đã\s+)?(?:completed|done|finished|xong|hoàn thành|hoàn tất)\b"
    r"(?:\s*[\(\[][^)\]]{0,150}[\)\]])?[\s.)\]]*$",
    re.IGNORECASE,
)

# Tiếng Việt: "đã" + động từ hoàn thành là dấu hiệu KHÔNG thể nhầm, nên chấp nhận
# ở BẤT KỲ đâu trong dòng, không cần dấu phân cách hay phải nằm cuối. Người Việt
# không viết "chờ cho tới khi đã hoàn thành" nên gần như không có dương tính giả,
# mà lại bắt được mọi biến thể model bịa ra sau này.
_DONE_VI_RE = re.compile(r"đã\s+(?:hoàn thành|hoàn tất|xong|thực hiện xong)", re.IGNORECASE)
# Nhãn đã-xong đặt trong ngoặc, ĐỨNG ĐÂU HAY GIỮA DÒNG ĐỀU TÍNH: "[DONE]", "[x]",
# "(done)", "[hoàn thành]"... Bắt buộc có ngoặc nên câu mô tả bình thường không
# dính oan. Bản trước chỉ nhận "[x]" ở ĐẦU dòng và "— Done" ở CUỐI dòng, nên
# ngày 11/09 task 3561 lại kẹt đúng kiểu cũ vì model viết:
#     1. [DONE] Force-stop Facebook and reopen to reach News Feed.
# — nhãn nằm ở đầu nhưng là "[DONE]" chứ không phải "[x]".
_DONE_TAG_RE = re.compile(
    r"[\[(]\s*(?:x|v|✓|done|completed|xong|hoàn thành)\s*[\])]", re.IGNORECASE
)


def _is_done(line: str) -> bool:
    """Dòng kế hoạch này đã được đánh dấu là làm xong chưa.

    Nhận mọi kiểu model hay dùng — đã gặp thật 3 kiểu khác nhau trong 4 ngày:
    "✅" (task 3536), "~~gạch ngang~~ — Completed." (3546), "[DONE] ..." (3561).
    """
    s = line.strip()
    if any(tick in s for tick in ("✅", "✔", "☑", "✓")):
        return True
    if s.count("~~") >= 2:  # ~~gạch ngang~~
        return True
    if _DONE_TAG_RE.search(s):  # "[DONE] ...", "- [x] ...", "(done)"
        return True
    if _DONE_VI_RE.search(s):  # "… đã hoàn tất …", "… đã xong …"
        return True
    return bool(_DONE_TAIL_RE.search(s))


def _select_current_subgoal(plan_text: str) -> str:
    """Pick the next actionable line from a plan.

    Handles two plan shapes:
    - Flat plan (one task per line): return the first line not yet marked done
      (xem _is_done — ✅, ~~gạch ngang~~, [x], hoặc "— Completed" ở cuối dòng).
    - Hierarchical plan (subgoal header + indented sub-tasks): a subgoal is only
      considered done when ALL of its sub-tasks are marked done. We skip completed
      subgoals and return the first unfinished sub-task. This prevents the manager
      from re-selecting an already-finished subgoal header (whose sub-tasks carry
      the ✅ but the header line itself does not), which caused infinite loops.
    """
    lines = [line for line in plan_text.splitlines() if line.strip()]
    if not lines:
        return plan_text.strip()

    has_headers = any(_SUBGOAL_HEADER_RE.match(line) for line in lines)

    if not has_headers:
        # Flat plan: first line without a completion mark (original behavior).
        for line in lines:
            if not _is_done(line):
                return line.strip()
        return lines[0].strip()

    # Hierarchical plan: group sub-tasks under their subgoal header.
    groups: list[dict] = []
    current = None
    for line in lines:
        if _SUBGOAL_HEADER_RE.match(line):
            current = {"header": line, "children": []}
            groups.append(current)
        elif current is not None:
            current["children"].append(line)
        else:
            # Line before any header: treat it as a standalone task.
            groups.append({"header": line, "children": []})

    for group in groups:
        children = group["children"]
        if children:
            for child in children:
                if not _is_done(child):
                    return child.strip()
            # All sub-tasks done -> subgoal complete, move on.
            continue
        # Header without sub-tasks: treat the header itself as the task.
        if not _is_done(group["header"]):
            return group["header"].strip()

    # Everything is marked done -> fall back to the last line.
    return lines[-1].strip()


def _select_next_subgoal(plan_text: str, subgoal_dang_ket: str) -> str:
    """Bước CHƯA LÀM đứng ngay sau *subgoal_dang_ket* trong kế hoạch.

    Dùng làm van an toàn khi manager giao đi giao lại đúng một subgoal (xem
    _dem_subgoal_lap trong manager_agent.py). Trả về chuỗi rỗng nếu không còn
    bước nào phía sau — lúc đó để vòng lặp chạy tiếp như cũ rồi hết max_steps.
    """
    lines = [ln for ln in (plan_text or "").splitlines() if ln.strip()]
    moc = (subgoal_dang_ket or "").strip()
    if not lines or not moc:
        return ""
    vi_tri = -1
    for i, ln in enumerate(lines):
        if ln.strip() == moc or moc in ln.strip():
            vi_tri = i
            break
    if vi_tri < 0:
        return ""
    for ln in lines[vi_tri + 1:]:
        if not _is_done(ln):
            return ln.strip()
    return ""


def parse_manager_response(response: str) -> dict:
    """
    Parse manager LLM response into structured dict.

    Extracts XML-style tags from the response:
    - <thought>...</thought>
    - <add_memory>...</add_memory>
    - <plan>...</plan>
    - <request_accomplished success="true|false">...</request_accomplished> (answer)

    Also derives:
    - current_subgoal: first line of plan (with list markers removed)
    - If first item is <script> tag, extract script content as current_subgoal
    - success: bool | None parsed from request_accomplished success attribute

    Args:
        response: Raw LLM response text

    Returns:
        Dict with keys:
            - thought: str
            - memory: str
            - plan: str
            - current_subgoal: str (first line of plan, cleaned, or script content)
            - answer: str (from request_accomplished tag)
            - success: bool | None (True/False if task complete, None if still in progress)
    """

    def extract(tag: str) -> str:
        """Extract content between XML-style tags (handles attributes)."""
        # Use regex to handle tags with attributes like <tag attr="value">
        pattern = rf"<{tag}(?:\s+[^>]*)?>(.+?)</{tag}>"
        match = re.search(pattern, response, re.DOTALL)
        if match:
            return match.group(1).strip()
        return ""

    thought = extract("thought")
    memory_section = extract("add_memory")
    plan = extract("plan")
    progress_summary = extract("progress_summary")
    answer = extract("request_accomplished")

    # Also support <answer> tag as alternative to <request_accomplished>
    if not answer:
        answer = extract("answer")

    # Parse success attribute from request_accomplished or answer tag
    success = None
    if answer:
        # Try to extract success attribute from tag
        success_match = re.search(
            r'<(?:request_accomplished|answer)\s+success="(true|false)">', response
        )
        if success_match:
            success = success_match.group(1) == "true"
        else:
            # Default to True for backward compatibility if no attribute present
            success = True

    # Parse current subgoal from first line of plan
    current_goal_text = plan

    # Check if first item is a <script> tag
    script_match = re.search(
        r"^\s*<script>(.*?)</script>", current_goal_text, re.DOTALL
    )

    if script_match:
        # Script is first task - extract script content with tag
        current_subgoal = f"<script>{script_match.group(1).strip()}</script>"
    else:
        # Pick the next actionable line, skipping completed subgoals/sub-tasks.
        first_line = _select_current_subgoal(current_goal_text)

        # Strip leading bold markers from subgoal headers, e.g. "**Subgoal 1:**"
        first_line = re.sub(r"^\s*\*{1,2}\s*", "", first_line)  # leading "**"/"*"
        first_line = re.sub(r"^(\s*[Ss]ubgoal[^*]*?)\*{2}", r"\1", first_line)  # closing "**"

        # Remove common list markers like "1.", "-", "*", or bullet characters
        first_line = re.sub(
            r"^\s*\d+\.\s*", "", first_line
        )  # Remove "1. ", "2. ", etc.
        first_line = re.sub(r"^\s*[-*]\s*", "", first_line)  # Remove "- " or "* "
        first_line = re.sub(r"^\s*•\s*", "", first_line)  # Remove bullet "• "

        current_subgoal = first_line.strip()

    return {
        "thought": thought,
        "plan": plan,
        "memory": memory_section,
        "current_subgoal": current_subgoal,
        "answer": answer,
        "success": success,
        "progress_summary": progress_summary,
    }