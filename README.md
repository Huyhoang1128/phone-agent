# Phone Agent

Nền tảng điều khiển và tự động hoá nhiều điện thoại Android bằng AI agent: quản lý thiết bị,
xem / điều khiển màn hình trực tiếp qua WebRTC, giao việc (đăng bài, bình luận, tải nội dung…
trên Facebook / TikTok) cho agent LLM chạy trên từng máy.

## Cấu trúc

| Thư mục | Vai trò |
| --- | --- |
| [`control/`](control/) | **Control plane** — backend Django (ASGI / Daphne, Channels), giao diện React, dịch vụ `agent-teams`, `devices_worker` |
| [`worker/`](worker/) | **Data plane** — quét thiết bị qua ADB, nhận lệnh từ Kafka và chạy agent LLM điều khiển điện thoại |

Hai phần chỉ giao tiếp với nhau qua **Kafka** (`device-events`, `device-commands`, `task_execution`…).

## Công nghệ

- **Backend:** Python, Django, Django Channels (ASGI / Daphne), PostgreSQL, Redis, Kafka
- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Thời gian thực:** WebRTC (coturn TURN/STUN) để xem và điều khiển màn hình điện thoại
- **AI agent:** LlamaIndex, agent LLM điều khiển Android (OpenAI, Gemini, Groq, Ollama… tuỳ cấu hình), dịch vụ đa agent `agent-teams`
- **Thiết bị:** ADB, FastStream (Kafka consumer)
- **Triển khai:** Docker, Docker Compose

## Chạy thử

Xem **[docs/RUNNING.md](docs/RUNNING.md)**. Tóm tắt:

```bash
# Control (Docker): web :5173, API :8030, Kafka :9094
cd control && cp .env.example .env && docker compose up -d --build

# Worker (máy cắm điện thoại, Python 3.12)
cd worker && pip install -r requirements.txt && cp .env.example .env
python -m mobilerun setup && faststream run main:app
```

Một số tính năng (tạo video, crawl TikTok, workflow n8n…) cần dịch vụ ngoài không nằm trong
repo — danh sách và biến môi trường tương ứng ở mục 3 của hướng dẫn.

Mọi địa chỉ máy chủ, domain và khoá trong repo đều là giá trị mẫu (`localhost`, `*.example.com`,
`your-…`) — thay bằng cấu hình của bạn qua biến môi trường. Các file bí mật (`.env`,
`secrets/*`, `profile_mapping.yaml`…) đã được `.gitignore` chặn.

## Mã nguồn bên thứ ba

`worker/mobilerun/` và tài liệu trong `worker/docs/` dựa trên dự án mã nguồn mở
[droidrun/mobilerun](https://github.com/droidrun/mobilerun), phát hành theo giấy phép MIT —
xem [`worker/mobilerun/LICENSE`](worker/mobilerun/LICENSE).
