# Skill: facebook_seed_comment

## Mục tiêu
Thay mặt một tài khoản FB (actor) viết một bình luận trên một bài đăng cụ thể. Dùng cho luồng seeding tương tác (Phase 3).

## Khi nào dùng skill này
Task có dạng:
- "vào facebook [actor], mở bài đăng <post_url> và viết bình luận: "<content>""

Tham số:
- **actor** — tên FB profile (display_name) đang đăng nhập trên thiết bị.
- **post_url** — link bài viết cần bình luận.
- **content** — nội dung bình luận (đã được AI generate hoặc admin nhập sẵn).

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

### Bước 2 — Mở khung Bình luận
Scan UI tìm và tap nút "Bình luận" / "Comment" để mở composer comment.
- **Nếu bài dài / chưa thấy nút Bình luận hoặc khung bình luận**: **vuốt (scroll)
  xuống** qua phần nội dung bài cho tới khi thấy khu vực bình luận, rồi mới tap.
  Bài dài có thể cần scroll vài lần.

### Bước 3 — Nhập nội dung
Tap ô input "Viết bình luận..." / "Write a comment..." rồi gọi `ctx.driver.input_text("<content>")`.

### Bước 4 — Gửi
Tap nút Gửi / Send (mũi tên hoặc icon máy bay giấy) ở cuối ô comment.

### Bước 5 — Xác nhận
Đợi 2 giây cho FB đẩy comment lên thread. Scan UI thấy đoạn text vừa gửi xuất hiện ở cuối thread → Success.
(KHÔNG cần tự lấy link comment — việc lấy link do một tài khoản khác đảm nhận sau.)

---

## QUAN TRỌNG
- **KHÔNG** sửa nội dung `content` — gửi nguyên văn.
- **KHÔNG** like, share hoặc thực hiện thao tác khác.
- **KHÔNG** comment chỉ với emoji nếu `content` có chữ.
