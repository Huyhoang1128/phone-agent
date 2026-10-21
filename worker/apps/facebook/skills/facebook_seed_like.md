# Skill: facebook_seed_like

## Mục tiêu
Thay mặt một tài khoản FB (actor) thực hiện một thao tác "Thích" trên một bài đăng cụ thể. Dùng cho luồng seeding tương tác (Phase 3).

## Khi nào dùng skill này
Task có dạng:
- "vào facebook [actor], mở bài đăng <post_url> và nhấn Thích."

Tham số trong mô tả task:
- **actor** — tên FB profile (display_name) đang đăng nhập trên thiết bị.
- **post_url** — link bài viết cần thả tim.

---

## Quy trình thực hiện

### Bước 0 — Làm sạch trạng thái ứng dụng (Bắt buộc)
Gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook trước khi mở link.

> ℹ️ Tài khoản (actor) đã được chọn đúng sẵn ở thiết bị — **vào thẳng các bước bên dưới**.

### Bước 1 — Mở bài đăng
Gọi `facebook_seed_open_post_url(post_url="<post_url>")`.

### Bước 2 — Nhấn Thích
Trên màn hình chi tiết bài viết, scan UI tìm nút "Thích" / "Like" (thường ở dưới phần tương tác) rồi tap.
Nếu phát hiện nút "Đã thích" / "Liked" → bài đã được thích trước đó, coi như thành công.

### Bước 3 — Xác nhận
Đợi 1-2 giây để UI cập nhật, scan lại trạng thái nút (phải thấy "Đã thích" hoặc tương đương) rồi báo Success.

---

## QUAN TRỌNG
- **KHÔNG** comment, share hoặc thực hiện thao tác khác — chỉ thả tim.
- **KHÔNG** đổi tài khoản — actor phải khớp với profile_name trong task.
