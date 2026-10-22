# Hướng dẫn chạy

Hệ thống gồm 2 phần chạy ở 2 nơi:

- **Control** (`control/`) — chạy bằng Docker Compose trên một máy chủ / máy dev: backend
  Django, giao diện web, PostgreSQL, Redis, Kafka, coturn và các tiến trình nền.
- **Worker** (`worker/`) — chạy trực tiếp (không Docker) trên máy **có cắm điện thoại Android**
  qua ADB. Một hệ thống có thể có nhiều worker, mỗi worker một `WORKER_ID`.

Hai phần chỉ nói chuyện với nhau qua **Kafka** (cổng `9094` của máy chạy control) và gọi API
backend (cổng `8030`).

```
 Điện thoại ──ADB── Worker ──Kafka :9094──► Control (Docker)
                      └────HTTP :8030──────►   ├─ backend :8030   ├─ frontend :5173
                                               └─ kafka, db, redis, coturn, tiến trình nền
```

## Yêu cầu

| Thành phần | Dùng cho |
| --- | --- |
| Docker + Docker Compose | Control |
| Python 3.12 (3.13 cũng cài được) | Worker |
| Android platform-tools (`adb`) | Worker — điều khiển điện thoại |
| Điện thoại Android bật **USB debugging** | Worker |
| API key của ít nhất 1 LLM (OpenAI, Gemini, Groq, OpenRouter… hoặc Ollama chạy local) | Agent điều khiển điện thoại |

## 1. Control

```bash
cd control
cp .env.example .env
```

Sửa `control/.env`, tối thiểu:

| Biến | Giá trị |
| --- | --- |
| `DJANGO_SECRET_KEY` | Chuỗi ngẫu nhiên dài |
| `DB_PASSWORD`, `TURN_PASSWORD` | Mật khẩu của bạn (đổi khỏi giá trị mẫu) |
| `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS` | Domain / IP bạn dùng để mở web |
| `KAFKA_EXTERNAL_HOST` | IP / hostname mà **máy worker** dùng để tới máy này (mặc định `localhost` — chỉ đúng khi worker chạy cùng máy) |
| `OPENAI_API_KEY`, `GROQ_API_KEY`… | Key cho các tính năng AI phía control (sinh nội dung, ảnh…) |

Chạy:

```bash
docker compose up -d --build
docker compose exec backend python manage.py createsuperuser
```

| Dịch vụ | Địa chỉ |
| --- | --- |
| Giao diện web | http://localhost:5173 |
| Backend API | http://localhost:8030 |
| Kafka (cho worker) | `<KAFKA_EXTERNAL_HOST>:9094` |
| PostgreSQL / Redis (debug) | `localhost:5441` / `localhost:6380` |

Ghi chú:

- `docker-compose.yml` là bộ dịch vụ tối thiểu. `docker-compose.example.yml` có thêm
  `workflow_runner`, `workflow_dlq_handler`, `chatbot_pending_sweeper` và dịch vụ đa agent
  `agent_teams` (cổng `7777`) — dùng file đó nếu cần các tính năng workflow / agent team:
  `docker compose -f docker-compose.example.yml up -d --build`.
- **coturn** chạy `network_mode: host` để relay WebRTC (xem / điều khiển màn hình trực tiếp).
  Chế độ này hoạt động đầy đủ trên Linux; trên Docker Desktop (Windows / macOS) nên đặt
  TURN trên một máy Linux riêng và trỏ `WEBRTC_ICE_SERVERS` tới đó.
- Backend tự `migrate` khi khởi động.

## 2. Worker (máy cắm điện thoại)

```bash
cd worker
python -m venv .venv
# Linux / macOS: source .venv/bin/activate     Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Sửa `worker/.env`:

| Biến | Giá trị |
| --- | --- |
| `KAFKA_BOOTSTRAP_SERVERS` | `<máy control>:9094` (khớp `KAFKA_EXTERNAL_HOST` ở trên) |
| `API_BASE_URL` | `http://<máy control>:8030` |
| `WORKER_ID` | Tên riêng của worker (mặc định là hostname) |
| `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | Key của LLM bạn dùng |

Cấu hình agent (model, provider…) đọc từ `MOBILERUN_CONFIG` hoặc
`~/.config/mobilerun/config.yaml` — tạo từ mẫu `worker/mobilerun/config_example.yaml`, hoặc
chạy `python -m mobilerun configure`.

Chuẩn bị điện thoại (chạy trong thư mục `worker/`):

```bash
adb devices                    # thấy thiết bị, trạng thái "device"
python -m mobilerun setup      # cài + bật app Portal trên điện thoại
python -m mobilerun ping       # "Portal is installed and accessible"
python -m mobilerun doctor     # kiểm tra tổng thể nếu có lỗi
```

Chạy worker:

```bash
faststream run main:app
```

Worker quét ADB định kỳ, báo thiết bị cắm / rút lên Kafka và nhận việc từ control.

## 3. Tính năng cần dịch vụ ngoài

Các tính năng dưới đây gọi dịch vụ **không nằm trong repo**. Không cấu hình thì phần còn lại
vẫn chạy, riêng tính năng đó báo lỗi khi dùng.

| Tính năng | Biến môi trường (control) |
| --- | --- |
| Tạo / xử lý video (repost TikTok, video hoạt cảnh, highlight) | `GENVIDEO_API_URL` |
| Xoá chữ trên ảnh | `INPAINT_API_URL` |
| Đổi mặt | `FACEFUSION_API_URL` |
| Làm nét ảnh | `UPSCALE_API_URL` |
| Crawl dữ liệu TikTok (video, kênh, bình luận) | `API_CRAWL_HOST`, `TIKTOK_*_URL` |
| Workflow n8n (sinh kịch bản, gửi bình luận…) | `N8N_*` |
| Sinh ảnh bằng fal.ai | `FAL_KEY` |
| Lưu media lên S3 | `CLOUDFLY_*` hoặc `SEAWEEDFS_*` |
| Đọc Google Sheet / Drive riêng tư khi import | `GOOGLE_SERVICE_ACCOUNT_FILE` — đặt file JSON vào `control/mobile-control/secrets/` (đã gitignore); không có thì chỉ đọc được link công khai |

## 4. Chạy test

```bash
# Backend control (SQLite, không cần Docker)
cd control/mobile-control
pip install -r requirements.txt
python manage.py test
```

`worker/apps/*/test_tools.py` là script thử thủ công, cần điện thoại thật.

## Cập nhật phụ thuộc của worker

`worker/requirements.txt` được sinh từ `worker/requirements.in` — sửa file `.in` rồi chạy:

```bash
uv pip compile requirements.in --universal --python-version 3.12 -o requirements.txt
```
