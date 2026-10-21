"""
task_executor.py — executes a task received from the 'task_execution' Kafka topic.

Expected message schema
-----------------------
{
    "task_id": 4,
    "name": "mở tiktok",
    "description": "mở tiktok",
    "task_type": "generic",
    "status": "running",
    "payload": {"agent": "tiktok"},
    "device_serial_id": "416H4EFS2222A",
    "goal": "mở tiktok",
    "app": "tiktok"
}

During execution, status/log messages are published to KAFKA_TASK_STATUS_TOPIC with
``device_serial_id`` as the Kafka message key.  Each message has the shape:

{
    "task_id": <int|str>,
    "device_serial_id": <str>,
    "status": "processing" | "processed",
    "content": "<log text>",
    "payload": <original payload dict>
}

``status`` is ``"processing"`` while the task is running and one of
``"completed"``, ``"failed"``, or ``"cancelled"`` once the task has
finished.
"""

import asyncio
import logging
import mimetypes
import os
import subprocess
import tempfile
import time
import traceback
from urllib.parse import urlparse

import requests

from failure_log import TaskFailureLogger
from task_context import set_failure_logger, set_raw_context

logger = logging.getLogger(__name__)

TASK_STATUS_TOPIC = os.getenv("KAFKA_TASK_STATUS_TOPIC", "task_status")
TASK_ERROR_TOPIC = os.getenv("KAFKA_TASK_ERROR_TOPIC", "task_errors")

_VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp"}


def _guess_ext(url: str, content_type: str | None = None) -> str:
    path = urlparse(url).path
    ext = os.path.splitext(path)[1].lower()
    if ext in _VIDEO_EXTS or ext in _IMAGE_EXTS:
        return ext
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return guessed
    return ".jpg"


def _adb_device_state(device_serial: str) -> str:
    """Trả về trạng thái adb hiện tại của thiết bị (``"device"``, ``"offline"``,
    ``"unauthorized"``...), hoặc ``"not_found"``/``"error:..."`` nếu adb không
    liệt kê được serial này nữa.

    Dùng để phát hiện SỚM việc thiết bị đã mất kết nối, thay vì để lệnh
    ``adb push`` thất bại với thông báo khó hiểu
    "failed to get feature set: device 'X' not found".
    """
    try:
        res = subprocess.run(
            ["adb", "-s", device_serial, "get-state"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        return f"error:{exc}"
    if res.returncode != 0:
        stderr = (res.stderr or "").strip()
        return f"error:{stderr[:120]}" if stderr else "not_found"
    return (res.stdout or "").strip() or "unknown"


def _wait_for_device_online(
    device_serial: str, tries: int = 3, wait_seconds: float = 3.0
) -> bool:
    """Đợi thiết bị về state ``"device"`` trong adb, thử tối đa ``tries`` lần.

    Một lần mất kết nối THOÁNG QUA (rút/cắm lại cáp USB, wifi-adb chập chờn,
    device vừa reboot...) chỉ kéo dài vài giây — chờ ngắn ở đây để một khoảnh
    khắc rớt kết nối như vậy không làm cả task fail hẳn (xem lỗi thật đã gặp:
    "adb push failed for media #0: adb: error: failed to get feature set:
    device 'FS4BKA001553' not found").
    """
    for attempt in range(tries):
        state = _adb_device_state(device_serial)
        if state == "device":
            return True
        logger.warning(
            "[prefetch] Device %s chưa sẵn sàng (state=%s), thử lại %d/%d sau %.1fs...",
            device_serial, state, attempt + 1, tries, wait_seconds,
        )
        time.sleep(wait_seconds)
    return False


def _prefetch_media_to_device(
    media_urls: list[str], device_serial: str, task_id
) -> list[str]:
    """Download each URL to a temp file then ``adb push`` to ``/sdcard/Download/``.

    Returns the list of on-device paths in input order. Triggers MediaScanner
    so the file shows up in the system Gallery (required by the FB composer).
    Raises on any failure — caller treats this as a permanent task error.

    Lưu ý về THỨ TỰ: lưới ảnh của FB composer sắp xếp mới-nhất-trước, và tool
    chọn ảnh theo vị trí ("mục 1", "mục 2"...). Để "mục i" khớp đúng
    ``media_urls[i]``, sau khi đẩy hết file ta quét MediaScanner theo chiều
    NGƯỢC (item cuối trước → item đầu sau) với khoảng nghỉ >1s giữa mỗi lần,
    để DATE_ADDED (đơn vị giây) tăng dần về ``media_urls[0]`` → phần tử đầu là
    ảnh mới nhất = "mục 1".

    Trước khi tải, xoá sạch các FILE nằm trực tiếp trong /sdcard/Download để
    picker chỉ thấy đúng media của task này (tránh dính file rác của task cũ
    hoặc ảnh chụp màn hình mới hơn). Thư mục con không bị đụng tới.
    """
    on_device_paths: list[str] = []
    tmp_dir = tempfile.mkdtemp(prefix=f"task_{task_id}_")

    # ── Kiểm tra thiết bị còn online TRƯỚC KHI thao tác gì ────────────────
    # Trước đây không hề check: nếu device rớt kết nối đúng lúc này, lỗi chỉ
    # lộ ra muộn ở bước push với thông báo adb khó hiểu (xem docstring).
    if not _wait_for_device_online(device_serial):
        raise RuntimeError(
            f"Thiết bị {device_serial} không sẵn sàng (adb get-state không trả về "
            f"'device') — có thể đã mất kết nối USB/wifi-adb ngay trước khi task "
            f"bắt đầu tải media."
        )

    # ── Dọn sạch /sdcard/Download (chỉ file top-level, không đệ quy) ──────
    rm = subprocess.run(
        ["adb", "-s", device_serial, "shell", "rm", "-f", "/sdcard/Download/*"],
        capture_output=True, text=True,
    )
    if rm.returncode != 0:
        # Không raise — thư mục có thể chỉ đơn giản là đã rỗng trên một số ROM
        # (rm báo lỗi "no such file"). Nhưng log rõ để không nuốt im lặng như
        # trước, vì đây cũng có thể là dấu hiệu SỚM của việc mất kết nối.
        logger.warning(
            "[prefetch] Task %s: dọn /sdcard/Download thất bại (rc=%s): %s",
            task_id, rm.returncode, (rm.stderr or "").strip()[:200],
        )

    try:
        for idx, url in enumerate(media_urls):
            r = requests.get(url, timeout=120, stream=True)
            r.raise_for_status()
            ext = _guess_ext(url, r.headers.get("content-type"))
            local_path = os.path.join(tmp_dir, f"media_{idx}{ext}")
            with open(local_path, "wb") as fh:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        fh.write(chunk)

            device_path = f"/sdcard/Download/task_{task_id}_{idx}{ext}"

            # Thử push tối đa 3 lần: một lần rớt kết nối thoáng qua không nên
            # làm cả task fail hẳn. Giữa các lần thử, đợi thiết bị về lại
            # state "device" trước khi push lại.
            push_err: str | None = None
            for push_attempt in range(3):
                if push_attempt > 0:
                    if not _wait_for_device_online(device_serial, tries=4, wait_seconds=3.0):
                        push_err = push_err or "device không quay lại online để retry"
                        break
                push = subprocess.run(
                    ["adb", "-s", device_serial, "push", local_path, device_path],
                    capture_output=True, text=True,
                )
                if push.returncode == 0:
                    push_err = None
                    break
                push_err = push.stderr.strip()[:200]
                logger.warning(
                    "[prefetch] Task %s: adb push media #%d thất bại lần %d/3: %s",
                    task_id, idx, push_attempt + 1, push_err,
                )
            if push_err is not None:
                raise RuntimeError(
                    f"adb push failed for media #{idx} (đã thử 3 lần): {push_err}"
                )
            on_device_paths.append(device_path)
            logger.info(
                "[prefetch] Task %s media %d/%d pushed: %s",
                task_id, idx + 1, len(media_urls), device_path,
            )

        # ── Quét MediaScanner theo chiều NGƯỢC để media_urls[0] là mới nhất ──
        n = len(on_device_paths)
        for pos in range(n - 1, -1, -1):
            device_path = on_device_paths[pos]
            # touch để mtime cũng tăng dần (một số picker sort theo DATE_MODIFIED)
            subprocess.run(
                ["adb", "-s", device_serial, "shell", "touch", device_path],
                capture_output=True, text=True,
            )
            subprocess.run(
                ["adb", "-s", device_serial, "shell",
                 "am", "broadcast", "-a",
                 "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                 "-d", f"file://{device_path}"],
                capture_output=True, text=True,
            )
            # DATE_ADDED tính theo giây → nghỉ >1s để mốc thời gian phân biệt.
            if pos > 0:
                time.sleep(1.2)
    finally:
        try:
            for f in os.listdir(tmp_dir):
                try:
                    os.remove(os.path.join(tmp_dir, f))
                except OSError:
                    pass
            os.rmdir(tmp_dir)
        except OSError:
            pass
    return on_device_paths


async def handle_task_execution(body: dict, broker) -> None:
    """Execute a mobile-agent task and stream progress back to Kafka."""

    task_id = body.get("task_id")
    device_serial_id = body.get("device_serial_id")
    goal = body.get("goal") or body.get("description") or ""
    app = body.get("app") or None
    payload = body.get("payload") or {}

    # Inject the full Kafka message body into the async context (raw_context) so
    # every tool can access any task field without relying on the LLM.
    set_raw_context(body)

    logger.info(
        "Received task_execution: task_id=%s device=%s app=%s goal=%r",
        task_id,
        device_serial_id,
        app,
        goal,
    )

    key = device_serial_id.encode() if device_serial_id else None

    async def _publish(content: str, status: str = "processing", **extra) -> None:
        """Publish a task-status event back to Kafka.

        *extra* fields are merged into the message — used by callers that
        need to ship structured data alongside the status text (e.g. the
        ``pending_posts`` array emitted by ``fetch_group_pending_posts``).
        devices_worker keeps every event in ``task.result`` so the backend
        post-processor (`_scan_result_for_payload`) can pull these fields
        back out by key.
        """
        message = {
            "task_id": task_id,
            "device_serial_id": device_serial_id,
            "status": status,
            "content": content,
            "payload": payload,
        }
        if extra:
            message.update(extra)
        try:
            await broker.publish(message, TASK_STATUS_TOPIC, key=key)
        except Exception as exc:
            logger.error("Failed to publish status update: %s", exc)

    async def _publish_error(exc: BaseException, task_name: str) -> None:
        error_message = {
            "task_id": task_id,
            "task_name": task_name,
            "device_serial_id": device_serial_id,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "payload": payload,
        }
        try:
            await broker.publish(error_message, TASK_ERROR_TOPIC, key=key)
        except Exception as pub_exc:
            logger.error("Failed to publish error to %s: %s", TASK_ERROR_TOPIC, pub_exc)

    await _publish(f"Task {task_id} started — goal: {goal}")

    # Failure logger — accumulate events, write file CHỈ khi task fail.
    # Setup TRƯỚC prefetch_media để cover cả event prefetch fail.
    flog = TaskFailureLogger(
        task_id=task_id, device_serial=device_serial_id or '',
        body=body, goal=goal, app=app or '',
    )
    flog.add_event('start', f'Task {task_id} started')
    # Expose flog cho tools dùng (granular log per-step) qua ContextVar.
    set_failure_logger(flog)

    # Pre-fetch media: download URL về temp, adb push lên /sdcard/Download/
    # trước khi MobileAgent.run() (cho FB composer thấy file qua MediaScanner).
    media_urls = payload.get("media_urls") or []
    if media_urls and device_serial_id:
        await _publish(
            f"Tải sẵn {len(media_urls)} media vào /sdcard/Download/ của {device_serial_id}..."
        )
        try:
            pushed = await asyncio.to_thread(
                _prefetch_media_to_device, media_urls, device_serial_id, task_id
            )
            payload["media_local_paths"] = pushed
            await _publish(f"Đã tải {len(pushed)}/{len(media_urls)} media lên thiết bị.")
        except Exception as exc:
            logger.exception("Pre-fetch media failed for task %s", task_id)
            flog.finalize(status='error', reason=f'Pre-fetch media failed: {exc}', exc=exc)
            await _publish(f"Tải media thất bại: {exc}", status="failed")
            await _publish_error(exc, "prefetch_media")
            return

    try:
        from mobilerun import MobileAgent, MobileConfig
        from mobilerun.config_manager import (
            AgentConfig,
            AppCardConfig,
            DeviceConfig,
            ExecutorConfig,
            FastAgentConfig,
            LoggingConfig,
            ManagerConfig,
            ToolsConfig,
        )
        from mobilerun.config_manager.config_manager import LLMProfile

        # ── LLM profiles (mirrors the default in runmb.py) ──────────────────
        _groq_fast = LLMProfile(
            provider="Groq",
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            temperature=0.1,
        )

        _deepseek_fast = LLMProfile(
            provider="DeepSeek",
            model="deepseek-chat",
            temperature=0.1,
        )

        _openai_fast = LLMProfile(provider="OpenAIResponses", model="gpt-4o-mini", temperature=0.1)
        # gpt-4o-mini làm manager bỏ qua Bước 0 force-stop và bị màn hình cũ dắt
        # đi (task 3816: được giao đăng video, lại tự đổi ảnh bìa).
        _openai_manager = LLMProfile(provider="OpenAIResponses", model="gpt-5.4", temperature=0.1)

        llm_profiles: dict[str, LLMProfile] = {
            "manager": _openai_manager,
            "executor": _openai_fast,
            "fast_agent": _openai_fast,
            "app_opener": _openai_fast,
            "structured_output": LLMProfile(
                provider="OpenAIResponses", model="gpt-5.4-nano", temperature=0.0
            ),
        }

        # llm_profiles: dict[str, LLMProfile] = {
        #     "manager": _deepseek_fast,
        #     "executor": _deepseek_fast,
        #     "fast_agent": _deepseek_fast,
        #     "app_opener": _deepseek_fast,
        #     "structured_output": LLMProfile(
        #         provider="OpenAIResponses", model="gpt-5.4-nano", temperature=0.0
        #     ),
        # }

        # ── Tool disabling ────────────────────────────────────────────────────
        # Tài khoản đã được backend chọn đúng sẵn trên thiết bị cho mọi task
        # thao tác, nên KHÔNG cần (và không nên) để Manager tự chèn bước
        # `facebook_check_current_account` — vừa tốn bước, vừa fail nếu thiếu
        # profile_mapping.yaml. Chỉ task ĐĂNG NHẬP mới cần xác minh tài khoản →
        # giữ tool cho login, chặn cứng ở mọi task khác (disable = pop khỏi
        # registry → Manager không còn thấy tool để gọi).
        disabled_tools = ["click_at", "click_area"]
        _goal_lower = (goal or "").lower()
        _is_login_task = ("đăng nhập" in _goal_lower or "login" in _goal_lower) and not any(
            kw in _goal_lower for kw in [
                "đăng bài", "đăng tin", "đăng story", "tìm bài", "tìm link", "lấy bài", 
                "lấy link", "sao chép", "copy", "post", "story", "viết bài", "tạo bài"
            ]
        )
        if not _is_login_task:
            disabled_tools.append("facebook_check_current_account")

        # ── Build MobileConfig ────────────────────────────────────────────────
        config = MobileConfig(
            agent=AgentConfig(
                max_steps=20,
                reasoning=True,
                streaming=True,
                fast_agent=FastAgentConfig(vision=False),
                manager=ManagerConfig(vision=False),
                executor=ExecutorConfig(vision=False),
                app_cards=AppCardConfig(enabled=True, mode="local", app_cards_dir="config/app_cards"),
            ),
            device=DeviceConfig(
                serial=device_serial_id,
                platform="android",
                auto_setup=True,
            ),
            tools=ToolsConfig(
                disabled_tools=disabled_tools,
            ),
            logging=LoggingConfig(debug=False),
            llm_profiles=llm_profiles,
        )

        # ── Create agent ──────────────────────────────────────────────────────
        # Timeout: use duration_minutes from payload * 1.2 if provided, else default 1000s
        _duration_minutes = payload.get("duration_minutes", 0)
        agent_timeout = int(_duration_minutes * 60 * 1.2) if _duration_minutes else 1000

        agent = MobileAgent(
            goal=goal,
            config=config,
            app=app,
            timeout=agent_timeout,
        )

        handler = agent.run()

        # ── Stream events → Kafka ─────────────────────────────────────────────
        from mobilerun.agent.droid.events import ManagerPlanEvent
        from mobilerun.agent.executor.events import ExecutorActionEvent, ExecutorActionResultEvent
        from mobilerun.agent.fast_agent.events import FastAgentOutputEvent

        async for ev in handler.stream_events():
            if isinstance(ev, ManagerPlanEvent) and ev.plan:
                await _publish(f"[plan] {ev.plan[:500]}")
                flog.add_event('plan', ev.plan)
            elif isinstance(ev, ExecutorActionEvent):
                await _publish(f"[action] {ev.description}")
                flog.add_event('action', ev.description)
            elif isinstance(ev, ExecutorActionResultEvent) and not ev.success:
                # Kết quả NGUYÊN VĂN của lần gọi tool vừa thất bại — KHÔNG qua
                # tay LLM tóm tắt. Trước đây chỉ [plan]/[action]/[agent] được
                # publish, nên chi tiết chẩn đoán tool tự trả về (vd danh sách
                # elements đang hiển thị trong lỗi "Không tìm thấy ô ...") bị
                # mất hẳn — log cuối cùng chỉ còn bản LLM tự diễn giải lại, có
                # lúc bị cắt/tóm gọn tới mức vô dụng (task 3591: lý do chỉ còn
                # "..."; task 3645: mất luôn đoạn "Các elements hiện tại: [...]").
                text = f"[result] ❌ {ev.summary}"[:800]
                await _publish(text)
                flog.add_event('result', ev.summary)
            elif isinstance(ev, FastAgentOutputEvent):
                text = str(ev)[:300]
                await _publish(f"[agent] {text}")
                flog.add_event('agent', str(ev))

        result = await handler
        status_display = "✅ success" if result.success else "❌ failed"
        final_status = "completed" if result.success else "failed"

        # ── Structured result emission: pending_posts ─────────────────────
        # When the goal is "fetch group pending posts", tools collect the
        # scraped list into raw_context['pending_posts'] (set during the
        # facebook_group_fetch_pending_list run). Publish it as a discrete
        # status event so devices_worker can upsert the rows.
        if result.success and payload.get("action") == "fetch_group_pending_posts":
            from task_context import get_raw_context as _grc
            pending_list = _grc().get("pending_posts") or []
            if isinstance(pending_list, list):
                await _publish(
                    f"Scraped {len(pending_list)} pending member posts.",
                    pending_posts=pending_list,
                )

        # ── Structured result emission: post_url ──────────────────────────
        # The facebook_create_post tool (publish) and facebook_find_and_copy_post_link
        # (find) store raw_context['post_url'] when they capture the post URL via
        # clipboard. Surface it so devices_worker can mirror into
        # FacebookProfileScheduledPost.fb_post_id (handler scans event stream for
        # the field) — keyless, works for every account (no per-account API key).
        if result.success and payload.get("action") in ("publish_profile_post", "find_profile_post_link"):
            from task_context import get_raw_context as _grc
            captured_url = (_grc().get("post_url") or '').strip()
            if captured_url:
                await _publish(
                    f"Captured post URL: {captured_url[:120]}",
                    post_url=captured_url,
                )

        # ── Structured result emission: comment_url (Phase 3 seeding) ─────
        # Skills facebook_seed_comment / facebook_seed_reply best-effort gọi
        # _capture_last_comment_url khi gửi xong → stamp raw_context['comment_url'].
        # Empty is OK — mirror chỉ flip status, không bắt buộc URL.
        if result.success and payload.get("action") in ("seed_post_interaction", "seed_scheduled_comment", "seed_fetch_comment_link"):
            from task_context import get_raw_context as _grc
            captured_comment = (_grc().get("comment_url") or '').strip()
            if captured_comment:
                await _publish(
                    f"Captured comment URL: {captured_comment[:120]}",
                    comment_url=captured_comment,
                )

        await _publish(f"Task {task_id} finished — {status_display}: {result.reason}")

        # Failure log dispatch
        if result.success:
            flog.discard()
        else:
            flog.finalize(status='failed', reason=str(result.reason)[:500])

        # --- BẮT ĐẦU HẬU XỬ LÝ (POST-PROCESSING) ---
        # Mỗi tool có thể đăng ký hàm `post_process` riêng trong định nghĩa tool
        # (tương tự `precondition`). Sau khi agent hoàn thành, ToolRegistry thu thập
        # các hàm đó và trả về qua result.post_process_fns.
        post_process_fns = result.post_process_fns if result.success else []

        if post_process_fns:
            await _publish("✅ Đang chạy tiến trình ngầm: Moi link từ thiết bị và đồng bộ...")
            for post_process_fn in post_process_fns:
                try:
                    sync_success = await post_process_fn(
                        device_serial_id=device_serial_id,
                        payload=payload,
                        task_id=task_id,
                    )
                    if sync_success:
                        await _publish("✅ Hậu xử lý hoàn tất: Đã đẩy dữ liệu lên Dashboard thành công.", status=final_status)
                    else:
                        await _publish("❌ Hậu xử lý thất bại: Không tìm thấy dữ liệu cần đồng bộ.", status=final_status)
                except Exception as e:
                    logger.error("Lỗi khi chạy hậu xử lý: %s", e)
                    await _publish(f"❌ Lỗi hậu xử lý: {e}", status=final_status)
        else:
            await _publish("Task completion finalized.", status=final_status)
        # --- KẾT THÚC HẬU XỬ LÝ ---

        logger.info(
            "Task %s finished: success=%s reason=%s",
            task_id,
            result.success,
            result.reason,
        )

    except asyncio.CancelledError:
        logger.info("Task %s was stopped on device %s", task_id, device_serial_id)
        try:
            await asyncio.shield(_publish(f"Task {task_id} stopped", status="cancelled"))
        except Exception as pub_exc:
            logger.error("Failed to publish stopped status for task %s: %s", task_id, pub_exc)
        flog.finalize(status='cancelled', reason='Task cancelled (asyncio.CancelledError)')
        raise

    except Exception as exc:
        task_name = body.get("name") or f"task_{task_id}"
        logger.exception(
            "Task %s (%s) execution error on device %s: %s",
            task_id,
            task_name,
            device_serial_id,
            exc,
        )
        await _publish(f"Task {task_id} error: {exc}", status="failed")
        await _publish_error(exc, task_name)
        flog.finalize(status='error', reason=str(exc)[:500], exc=exc)
