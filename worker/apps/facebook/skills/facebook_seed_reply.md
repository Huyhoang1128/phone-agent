# Skill: facebook_seed_reply

## Mục tiêu
Thay mặt một tài khoản FB (actor) trả lời (reply trong thread) một bình luận có sẵn trên một bài đăng. Dùng cho luồng seeding tương tác (Phase 3).

## Khi nào dùng skill này
Task có dạng:
- "vào facebook [actor], mở bài đăng <post_url>. Tìm bình luận của "<target_username>" (đoạn text: "<target_snippet>") và nhấn Trả lời, gửi nội dung: "<content>""

Tham số:
- **actor** — tên FB profile đang đăng nhập trên thiết bị.
- **post_url** — link bài viết.
- **target_username** — tên user (display name) của comment cần reply.
- **target_snippet** — đoạn text trích từ nội dung comment cần reply (để disambiguate khi user có nhiều comment).
- **content** — nội dung phần trả lời.

---

## Quy trình thực hiện

### Bước 0 — Làm sạch trạng thái ứng dụng (Bắt buộc)
Gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook trước khi mở link.

> ⛔ **KHÔNG kiểm tra / xác minh tài khoản** dưới BẤT KỲ hình thức nào: KHÔNG gọi
> `facebook_check_current_account`, KHÔNG mở Trang cá nhân, KHÔNG đọc tên tài khoản
> để đối chiếu, và **KHÔNG thêm bước "verify/check current account" vào kế hoạch
> (plan)**. Tài khoản trên thiết bị MẶC ĐỊNH đã đúng — bắt đầu thẳng từ Bước 1.

### Bước 1 — Mở bài đăng
Gọi `facebook_seed_open_post_url(post_url="<post_url>")`.
- Nếu `<post_url>` là **link bình luận** (có `comment_id`), FB sẽ nhảy thẳng tới
  comment gốc — sang Bước 3 luôn.

### Bước 2 — Mở thread bình luận
Scan UI, tap nút "Bình luận" / "Comment" để mở toàn bộ thread.
- **Nếu bài dài / chưa thấy phần bình luận**: **vuốt (scroll) xuống** qua nội dung
  bài cho tới khi thấy khu vực bình luận rồi mới tap. Bài dài có thể cần scroll vài lần.

### Bước 3 — Định vị comment gốc
**Scroll** trong thread bình luận tìm card comment thoả mãn cả hai điều kiện:
1. Element author name khớp `target_username`.
2. Element body chứa `target_snippet` (so match substring, không phân biệt hoa thường).

Cứ **tiếp tục vuốt xuống** nếu chưa thấy. Không tìm thấy sau 5-6 lần scroll → trả
Failed: "Không định vị được comment gốc — target_username/target_snippet không match."

### Bước 4 — Tap Trả lời
Trên card vừa định vị, tap nút "Trả lời" / "Reply" (thường nằm ngay dưới phần text comment).

### Bước 5 — Nhập nội dung
FB tự mở composer reply (thường đính kèm @mention `target_username`). Gọi `ctx.driver.input_text("<content>")`.

### Bước 6 — Gửi
Tap nút Gửi / Send.

### Bước 7 — Xác nhận
Đợi 2 giây cho FB đẩy reply lên thread. Scan UI thấy reply mới xuất hiện trong sub-thread của comment gốc → Success.

---

## QUAN TRỌNG
- **KHÔNG** reply nhầm vào comment khác — match cả `target_username` lẫn `target_snippet`.
- **KHÔNG** tạo bình luận top-level — phải là reply trong thread.
- **KHÔNG** xoá @mention auto của FB nếu nó xuất hiện trong composer.
