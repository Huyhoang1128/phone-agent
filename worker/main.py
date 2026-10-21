import asyncio
import logging
import logging.handlers
import os
import socket
import time
from typing import Dict, Tuple

from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from aiokafka.errors import TopicAlreadyExistsError
from dotenv import load_dotenv
from faststream import FastStream
from faststream.kafka import KafkaBroker, KafkaMessage

from adb_scanner import rescan_and_publish, scan_loop
from kafka_consumer import handle_command
from task_executor import TASK_STATUS_TOPIC, handle_task_execution

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)

logger = logging.getLogger(__name__)

# ── Ghi log RA FILE, không chỉ ra màn hình ───────────────────────────────────
# Trước đây toàn bộ log chỉ đi ra stdout, mà stdout là cái terminal đang mở
# (/proc/<pid>/fd/1 -> /dev/pts/0). Task hỏng thì chỉ còn file trong
# logs/failures/, mà file đó chỉ có kế hoạch + danh sách sự kiện, KHÔNG có log
# chi tiết của tool. Ngày 08/09 task 3558 đăng bài xong nhưng không lấy được
# link; mấy dòng "[facebook_copy_post_link] Tìm thấy 0 khối bài viết trên màn
# hình" — thứ chỉ đúng nguyên nhân — chỉ tồn tại trên màn hình, cuộn qua là mất,
# phải xin người dùng chụp lại mới đọc được.
#
# MỖI TIẾN TRÌNH MỘT FILE: chạy `faststream run main:app --workers 4` là 4 tiến
# trình, mà RotatingFileHandler không an toàn khi nhiều tiến trình cùng xoay
# vòng một file (mất log lúc đổi file). Kèm dọn file cũ hơn LOG_KEEP_DAYS ngày
# để thư mục không phình vô hạn — đúng bài học từ log Docker không bao giờ tự dọn.
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
LOG_KEEP_DAYS = int(os.getenv("LOG_KEEP_DAYS", "7"))
LOG_MAX_MB = int(os.getenv("LOG_MAX_MB", "20"))


def _setup_file_logging() -> None:
    """Thêm một handler ghi log ra logs/worker-<pid>.log. Hỏng thì bỏ qua —
    không ghi được ra file thì vẫn phải chạy, log ra màn hình như cũ."""
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        cutoff = time.time() - LOG_KEEP_DAYS * 86400
        for name in os.listdir(LOG_DIR):
            if name.startswith("worker-") and ".log" in name:
                path = os.path.join(LOG_DIR, name)
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.remove(path)
                except OSError:
                    pass
        handler = logging.handlers.RotatingFileHandler(
            os.path.join(LOG_DIR, f"worker-{os.getpid()}.log"),
            maxBytes=LOG_MAX_MB * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s")
        )
        logging.getLogger().addHandler(handler)
        # PHẢI gắn thêm vào logger "mobilerun" chứ không chỉ logger gốc:
        # mobilerun/__init__.py đặt `_logger.propagate = False` cho logger đó và
        # chỉ cắm CLILogHandler (rich, ra màn hình). Mà apps/facebook/tools.py
        # lại ghi log bằng chính logging.getLogger("mobilerun") — nên toàn bộ
        # dòng "[facebook_create_post] ..." / "[facebook_copy_post_link] ..."
        # KHÔNG bao giờ tới được logger gốc. Đo ngày 09/09: file log bắt được
        # adb_scanner, task_executor... nhưng thiếu đúng phần cần nhất khi đi tìm
        # lỗi đăng bài. Hàm configure_logging() có xoá sạch handler của logger
        # này, nhưng chỉ CLI/TUI gọi — luồng worker không đụng tới.
        logging.getLogger("mobilerun").addHandler(handler)
        logger.info("Log đang được ghi ra %s", handler.baseFilename)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Không bật được log ra file: %s", exc)


_setup_file_logging()

BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
DEVICE_EVENTS_TOPIC = os.getenv("KAFKA_DEVICE_EVENTS_TOPIC", "device-events")
COMMANDS_TOPIC = os.getenv("KAFKA_COMMANDS_TOPIC", "device-commands")
TASK_EXECUTION_TOPIC = os.getenv("KAFKA_TASK_EXECUTION_TOPIC", "task_execution")
CONSUMER_GROUP = os.getenv("KAFKA_CONSUMER_GROUP", "mobile-agent-worker")
WORKER_ID = os.getenv("WORKER_ID", socket.gethostname())

# Worker-specific topics for directed routing
WORKER_COMMANDS_TOPIC = f"{COMMANDS_TOPIC}-{WORKER_ID}"
WORKER_TASK_EXECUTION_TOPIC = f"{TASK_EXECUTION_TOPIC}-{WORKER_ID}"

DEFAULT_NUM_PARTITIONS = 30

broker = KafkaBroker(BOOTSTRAP_SERVERS)
app = FastStream(broker)


async def _ensure_topics_exist(topics: list[str], num_partitions: int = DEFAULT_NUM_PARTITIONS) -> None:
    """Create topics with the specified number of partitions if they do not already exist."""
    admin = AIOKafkaAdminClient(bootstrap_servers=BOOTSTRAP_SERVERS)
    await admin.start()
    try:
        for topic in topics:
            try:
                await admin.create_topics([NewTopic(name=topic, num_partitions=num_partitions, replication_factor=1)])
                logger.info("Created topic '%s' with %d partition(s)", topic, num_partitions)
            except TopicAlreadyExistsError:
                logger.debug("Topic '%s' already exists — skipping", topic)
    finally:
        await admin.close()

# Registry of currently running tasks keyed by (device_serial, task_id)
_running_tasks: Dict[Tuple[str, int], asyncio.Task] = {}


async def _handle_command(body: dict, msg: KafkaMessage) -> None:
    action = body.get("action")
    if action == "rescan":
        logger.info("Received rescan command – triggering device rescan")
        await rescan_and_publish(broker, DEVICE_EVENTS_TOPIC, WORKER_ID)
    elif action == "stop_task":
        serial = body.get("devices_serical", "")
        task_id = body.get("task_id")
        key = (serial, task_id)
        running_task = _running_tasks.get(key)
        if running_task and not running_task.done():
            logger.info("Cancelling task %s on device %s", task_id, serial)
            running_task.cancel()
        else:
            # Task not found locally – still publish a stopped status so the
            # orchestrator is notified regardless.
            logger.warning(
                "stop_task: no running task found for device=%s task_id=%s – publishing stopped status anyway",
                serial,
                task_id,
            )
            message = {
                "task_id": task_id,
                "device_serial_id": serial,
                "content": f"Task {task_id} stopped",
                "payload": {},
            }
            msg_key = serial.encode() if serial else None
            try:
                await broker.publish(message, TASK_STATUS_TOPIC, key=msg_key)
            except Exception as exc:
                logger.error("Failed to publish stopped status: %s", exc)
    else:
        await handle_command(body, msg)


async def _handle_task_execution(body: dict) -> None:
    task_id = body.get("task_id")
    device_serial = body.get("device_serial_id", "")
    registry_key = (device_serial, task_id)

    async def _run() -> None:
        await handle_task_execution(body, broker)

    task = asyncio.create_task(_run())
    _running_tasks[registry_key] = task
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        _running_tasks.pop(registry_key, None)


broker.subscriber(COMMANDS_TOPIC, group_id=CONSUMER_GROUP)(_handle_command)
broker.subscriber(WORKER_COMMANDS_TOPIC, group_id=f"{CONSUMER_GROUP}-{WORKER_ID}")(_handle_command)
broker.subscriber(TASK_EXECUTION_TOPIC, group_id=CONSUMER_GROUP, max_workers=10)(_handle_task_execution)
broker.subscriber(WORKER_TASK_EXECUTION_TOPIC, group_id=f"{CONSUMER_GROUP}-{WORKER_ID}", max_workers=10)(_handle_task_execution)


@app.on_startup
async def create_topics() -> None:
    """Pre-create all Kafka topics with the desired partition count before the broker starts."""
    await _ensure_topics_exist([
        COMMANDS_TOPIC,
        WORKER_COMMANDS_TOPIC,
        TASK_EXECUTION_TOPIC,
        WORKER_TASK_EXECUTION_TOPIC,
        DEVICE_EVENTS_TOPIC,
        TASK_STATUS_TOPIC,
    ])


@app.after_startup
async def start_scanner() -> None:
    logger.info("Worker ID: %s", WORKER_ID)
    asyncio.create_task(scan_loop(broker, DEVICE_EVENTS_TOPIC, WORKER_ID))
