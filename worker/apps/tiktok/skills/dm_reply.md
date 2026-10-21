# Skill: Gửi DM TikTok (Direct Message reply)

Dùng skill này khi task yêu cầu **gửi tin nhắn DM (Direct Message)** cho 1 user TikTok cụ thể.

## Cách nhận biết task cần dùng skill này

Dùng skill này nếu Goal có bất kỳ đặc điểm nào sau đây:

- Chứa từ khóa: "gửi DM", "trả lời DM", "gửi tin nhắn", "reply tin nhắn", "DM cho", "nhắn tin TikTok", "TikTok DM"
- Payload có CẢ 2 field: `peer_handle` (username/tên hiển thị) và `reply_text` (nội dung tin)

**KHÔNG dùng skill này nếu:**

- Task yêu cầu reply comment trên video → dùng `tiktok_reply_to_comment` thay thế
- Task yêu cầu comment vào video → dùng `tiktok_open_video_and_comment`

## Tool duy nhất cần gọi

| Tool | Mục đích |
|------|----------|
| `tiktok_send_dm` | Mở app TikTok → vào Hộp thư → tìm conversation peer → kiểm tra duplicate → gõ + send DM |

## Cách trích xuất tham số từ goal

| Tham số | Trích xuất từ goal | Ghi chú |
|---------|--------------------|---------|
| `peer_handle` | Tên user sau "cho", "gửi DM cho", "DM tới", hoặc payload.peer_handle | Bắt buộc — có thể chứa emoji unicode |
| `reply_text` | Nội dung sau "với nội dung", "reply", "nhắn", hoặc payload.reply_text | Bắt buộc |

Nếu các tham số không truyền trực tiếp khi gọi tool, tool tự lấy từ task payload (`peer_handle`, `reply_text`).

### Ví dụ goal và cách gọi tool

**Ví dụ 1 — Goal NL chuẩn:**

**Goal:** `"Gửi DM TikTok cho user '🙂‍↔️' với nội dung 'Dạ chị ơi, hiện vòng 1 của chị bị nhỏ hay sa trễ ạ?'"`

```
tiktok_send_dm(
    peer_handle="🙂‍↔️",
    reply_text="Dạ chị ơi, hiện vòng 1 của chị bị nhỏ hay sa trễ ạ?"
)
```

**Ví dụ 2 — Goal tóm tắt, tham số trong payload:**

**Goal:** `"Trả lời DM TikTok theo payload"`
**Payload:** `{"peer_handle": "Test06", "reply_text": "Em xin SĐT của chị nha"}`

```
tiktok_send_dm()  # tool tự lấy từ payload
```

## Tool tự động thực hiện 12 bước

1. **Launch TikTok app** (idempotent — không crash nếu app đã mở).
2. **Tap tab "Hộp thư"** ở bottom navigation (position 4).
3. **Scroll danh sách conversation**, tìm row match `peer_handle` (loop tối đa 10 lần scroll). Skip các system row "Những Follower mới" / "Hoạt động" / "Thông báo hệ thống".
4. **Tap row conversation** → mở chat detail.
5. **Verify đúng conversation** (action bar contains peer_handle).
6. **Đọc 3 tin BOT gần nhất** (msg bubble align RIGHT, blue) — nếu nội dung tin BOT cuối **TRÙNG `reply_text`** → return `SKIPPED_ALREADY_SENT` (anti-spam).
7. **Tap ô text input** — XÁC ĐỊNH CHÍNH XÁC qua EditText element, KHÔNG NHẦM với icon micro 🎤 bên phải.
8. **Gõ nội dung** qua ADB `input text` (hỗ trợ tiếng Việt + emoji).
9. **Verify icon SEND xuất hiện** (paper plane 📤 — thay icon MICRO 🎤 sau khi có text).
10. **Tap SEND icon**.
11. **Verify tin xuất hiện** ở cuối conversation (msg bubble mới có nội dung khớp).
12. Báo cáo `SENT_CONFIRMED` / `SKIPPED_ALREADY_SENT` / `Failed`.

## Xử lý lỗi (retry theo mã bước)

| Lỗi trả về | Nguyên nhân | Hành động |
|------------|-------------|-----------|
| `Failed: [bước 1]` | Thiếu `peer_handle` hoặc `reply_text` trong tham số lẫn payload | Đọc lại goal/payload, gọi lại tool với tham số đầy đủ |
| `Failed: [bước 3]` | Không vào được tab Hộp thư — TikTok có thể logged out / chưa load home | Báo cáo lỗi, KHÔNG retry tự động |
| `Failed: [bước 4] PEER_NOT_FOUND` | Scroll hết list không thấy conversation peer | Báo cáo — peer có thể chưa có conversation DM với account |
| `Failed: [bước 5]` | Tap row không mở conversation | Retry 1 lần sau 1s |
| `Failed: [bước 8]` | Không tìm thấy ô text input (TikTok block messaging hoặc UI khác) | Retry sau 2s |
| `Failed: [bước 9]` | ADB input text fail (encoding unicode lỗi) | Retry, có thể do escape ký tự đặc biệt |
| `Failed: [bước 10] SEND_ICON_NOT_VISIBLE` | Icon SEND chưa xuất hiện sau khi gõ text — có thể text chưa được nhận | Retry sau 1s, gõ lại text |
| `Failed: [bước 12] MESSAGE_NOT_APPEAR` | Tap SEND xong nhưng tin chưa xuất hiện | Retry sau 2s — có thể delay mạng. Nếu vẫn fail → báo cáo |

Nếu 1 bước lỗi quá 3 lần liên tiếp → dừng và báo cáo lỗi cụ thể cho hệ thống.

## Lưu ý quan trọng

- **Chống duplicate (bước 6)**: skill tự đọc 3 tin BOT cuối, nếu nội dung trùng `reply_text` → return `SKIPPED_ALREADY_SENT`. Hệ thống xử lý outcome này như "đã gửi" (vì khách đã thấy tin) — KHÔNG spam 2 tin giống nhau.

- **Unicode peer_handle**: TikTok username có thể chứa emoji (vd `🙂‍↔️`, `😜`). Tool tự detect và dùng **partial substring match** thay exact match cho các trường hợp này.

- **CỰC KỲ QUAN TRỌNG — phân biệt SEND vs MICRO icon**:
  - Khi ô text input RỖNG → icon bên phải input bar là **MICRO 🎤** (ghi âm voice message).
  - Khi ô text input CÓ TEXT → icon micro tự BIẾN MẤT, thay bằng **SEND 📤** (paper plane).
  - Tool dùng dấu hiệu này để tap đúng SEND — KHÔNG nhầm.
  - Bước 10 verify SEND xuất hiện trước khi tap (bước 11).

- **Tool tự launch TikTok** — KHÔNG cần task khác mở app trước.

- **KHÔNG cần `tag_mapping.yaml`** — DM không có @mention như comment.

- **Performance**: Skill này deterministic, latency expectation ~10-15s từ khi nhận task đến SENT_CONFIRMED. Nếu task vượt 30s → kiểm tra log từng bước.
