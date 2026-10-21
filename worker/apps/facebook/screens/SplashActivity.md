## Đây là giao diện chính (News Feed / Home) của Facebook

Màn hình Home hiện ra sau khi đăng nhập thành công. Đây là màn hình mặc định khi mở app.

```
┌──────────────────────────────────────────┐
│ 15:29 ☁️ ...           📵 4G📶 🔋73%    │
│------------------------------------------│
│ ☰  facebook              ＋  🔍  💬      │
│------------------------------------------│
│ 🏠  🛍️(7)  👥  🏪  🔔(6)  👤            │
│    [active]                               │
│------------------------------------------│
│  [Avatar]  Bạn đang nghĩ gì?     [📷]   │
│------------------------------------------│
│        [ STORIES / TIN ]                 │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│ │  [+] │ │(ava) │ │(ava) │ │(ava) │    │
│ │      │ │      │ │      │ │      │    │
│ │Tạo   │ │Lê    │ │Phan  │ │ ...  │    │
│ │ tin  │ │Hoàng │ │ Anh  │ │      │    │
│ └──────┘ └──────┘ └──────┘ └──────┘    │
│------------------------------------------│
│ ┌────────────────────────────────────┐  │
│ │  [Avatar]  Kênh Hài          ... ✕ │  │
│ │            43 phút · 🌐            │  │
│ │                                    │  │
│ │  Chuyên mục giới thiệu các series: │  │
│ │  Đinh Đông Cơ, vì ăn gà luộc      │  │
│ │  chấm tiêu chanh mà bị ném vỡ đầu │  │
│ │  🍾... Xem thêm                    │  │
│ │                                    │  │
│ │  ┌──────────┐  ┌──────────┐       │  │
│ │  │  [img1]  │  │  [img2]  │       │  │
│ │  └──────────┘  └──────────┘       │  │
│ │  ┌──────────┐  ┌──────────┐       │  │
│ │  │  [img3]  │  │  +2 ảnh  │       │  │
│ │  └──────────┘  └──────────┘       │  │
│ │                                    │  │
│ │  👍 Thích   💬 Bình luận   ↗ Chia  │  │
│ └────────────────────────────────────┘  │
│------------------------------------------│
│  (tiếp tục cuộn xuống để xem thêm bài)  │
└──────────────────────────────────────────┘
```

---

## Các thành phần UI chính

### Thanh điều hướng trên cùng (Top Bar)
- **☰** (hamburger) — mở menu/trang cá nhân
- **facebook** (logo/text) — ở giữa bên trái
- **＋** — tạo bài đăng mới
- **🔍** — tìm kiếm
- **💬** — Messenger

### Tab bar bên dưới Top Bar
| Icon | Chức năng |
|---|---|
| 🏠 | Home / News Feed (tab đang active, có gạch chân xanh) |
| 🛍️ (7) | Marketplace — có badge số |
| 👥 | Bạn bè |
| 🏪 | Xem thêm |
| 🔔 (6) | Thông báo — có badge số |
| 👤 | Trang cá nhân |

### Ô tạo bài đăng (Create Post)
- Avatar của user hiện tại bên trái
- Text placeholder: **"Bạn đang nghĩ gì?"**
- Icon ảnh 📷 bên phải

### Stories (Tin)
- Cuộn ngang
- Ô đầu tiên: **"Tạo tin"** với nút [+] xanh
- Các ô tiếp theo: avatar + tên bạn bè đang có story

### Bài đăng trong Feed (Post Card)
Mỗi bài đăng gồm:
- **Header**: Avatar + Tên trang/người + thời gian + 🌐 (chế độ công khai) + `...` (more) + `✕` (ẩn)
- **Body**: Nội dung văn bản, có thể có **"Xem thêm"** nếu quá dài
- **Media**: Lưới ảnh (1–4 ảnh, ảnh thứ 5+ hiển thị dạng `+N`)
- **Action bar**: 👍 Thích | 💬 Bình luận | ↗ Chia sẻ

---

## Ghi chú cho agent

- Màn hình này xuất hiện khi package `com.facebook.katana` (Facebook) hoặc `com.facebook.lite` (Facebook Lite) đang ở foreground.
- Để **mở comment** của một bài đăng: tìm element có text "Bình luận" hoặc "Comment" và tap vào.
- Để **like** bài đăng: tìm element "Thích" hoặc "Like".
- Để **chia sẻ**: tìm element "Chia sẻ" hoặc "Share".
- Để **tạo bài đăng**: tap vào ô "Bạn đang nghĩ gì?".
- **Lưu ý**: Để mở profile page (kiểm tra tên tài khoản đang đăng nhập), tap vào element "Đi tới trang cá nhân" (IDX 18, bounds [24,258][104,338]) — đây là button avatar trong ô tạo bài viết, khi tap sẽ mở thẳng trang cá nhân với tên tài khoản hiển thị rõ ràng.
- Stories nằm **phía trên feed**, cuộn ngang để xem thêm.