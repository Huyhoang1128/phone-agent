# Facebook App Guide

## Package name
com.facebook.katana

## Giao diện chính (News Feed / Home)

Màn hình Home hiện ra sau khi đăng nhập thành công.

```
┌──────────────────────────────────────────┐
│ 15:29 ☁️                    4G📶 🔋73%  │
│------------------------------------------│
│ ☰  facebook              ＋  🔍  💬      │
│------------------------------------------│
│ 🏠  🛍️(7)  👥  🏪  🔔(6)  👤            │
│    [active tab có gạch chân xanh]        │
│------------------------------------------│
│  [Avatar]  Bạn đang nghĩ gì?     [📷]   │
│------------------------------------------│
│        [ STORIES / TIN ]                 │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│ │  [+] │ │(ava) │ │(ava) │ │(ava) │    │
│ │Tạo   │ │Tên   │ │Tên   │ │ ...  │    │
│ │ tin  │ │bạn   │ │bạn   │ │      │    │
│ └──────┘ └──────┘ └──────┘ └──────┘    │
│------------------------------------------│
│ ┌────────────────────────────────────┐  │
│ │  [Avatar]  Tên Trang         ... ✕ │  │
│ │            43 phút · 🌐            │  │
│ │  Nội dung bài đăng...  Xem thêm   │  │
│ │  ┌──────────┐  ┌──────────┐       │  │
│ │  │  [ảnh1]  │  │  [ảnh2]  │       │  │
│ │  └──────────┘  └──────────┘       │  │
│ │  👍 Thích  💬 Bình luận  ↗ Chia   │  │
│ └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

## Các thành phần UI chính

### Top Bar
- **☰** — mở menu / trang cá nhân (góc trên trái)
- **facebook** — logo ở giữa
- **＋** — tạo bài đăng mới
- **🔍** — tìm kiếm
- **💬** — Messenger

### Tab Bar (dưới top bar)
| Icon | Chức năng |
|---|---|
| 🏠 | Home / News Feed (tab đang active) |
| 🛍️ | Marketplace |
| 👥 | Bạn bè |
| 🏪 | Xem thêm |
| 🔔 | Thông báo |
| 👤 | Trang cá nhân |

### Ô tạo bài đăng
- Avatar + "**Bạn đang nghĩ gì?**" + 📷

### Stories (Tin)
- Cuộn ngang, ô đầu tiên là "Tạo tin" [+]

### Post Card (Bài đăng trong feed)
- Header: Avatar + Tên + thời gian + 🌐 + `...` + `✕`
- Body: văn bản, "Xem thêm" nếu dài
- Media: lưới ảnh (ảnh 5+ hiển thị `+N`)
- Action bar: 👍 Thích | 💬 Bình luận | ↗ Chia sẻ

## Giao diện màn hình đăng nhập

Khi chưa đăng nhập, Facebook hiển thị form login:

```
┌──────────────────────────────────────────┐
│              f  facebook                 │
│------------------------------------------│
│  [Số điện thoại hoặc email]              │
│------------------------------------------│
│  [Mật khẩu]                    👁        │
│------------------------------------------│
│          [ Đăng nhập ]                   │
│------------------------------------------│
│         Quên mật khẩu?                   │
│------------------------------------------│
│       [ Tạo tài khoản mới ]              │
└──────────────────────────────────────────┘
```

## Ghi chú cho agent

- Khi cần đăng nhập: gọi `facebook_get_credentials(profile_name="Tên")` để lấy username/password, sau đó tự điền vào form
- Để mở comment: tìm element "Bình luận" hoặc "Comment" và tap
- Để like: tìm element "Thích" hoặc "Like"
- Để chia sẻ: tìm element "Chia sẻ" hoặc "Share"
- Để tạo bài đăng: tap "Bạn đang nghĩ gì?"
- Để kiểm tra đang đăng nhập tài khoản nào: tap ☰ hoặc tab 👤 (Trang cá nhân)
