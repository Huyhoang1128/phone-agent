# Skill: facebook_group_fetch_pending

## Mục tiêu
Liệt kê danh sách bài đăng đang chờ admin duyệt trong 1 Facebook Group, gửi
JSON về backend.

## Khi nào dùng skill này
- Goal task chứa cụm "liệt kê các bài đăng đang chờ admin duyệt" hoặc
  payload `action == "fetch_group_pending_posts"`.

## Tiền điều kiện
- Tài khoản FB hiện tại đăng nhập sẵn ở thiết bị, là admin của group.
- Tên group có trong `goal` task (hoặc `payload.group_name`).

## Quy trình thực hiện

### Bước 0 — Khởi động lại ứng dụng (Bắt buộc)
1. Gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt hẳn ứng dụng Facebook.
2. Gọi `open_app(text="Facebook")` để mở lại từ đầu. Chờ 3-4 giây để app tải xong News Feed (Trang chủ).

> ℹ️ Tài khoản đã được chọn đúng sẵn ở thiết bị — **vào thẳng các bước bên dưới**, bắt đầu từ **News Feed / Trang chủ** (nếu đang ở màn hình khác thì bấm tab **Trang chủ** rồi tiếp tục).
> 
> ⛔ **KHÔNG kiểm tra / xác minh tài khoản** dưới BẤT KỲ hình thức nào: KHÔNG gọi
> `facebook_check_current_account`, KHÔNG mở Trang cá nhân, KHÔNG đọc tên tài khoản
> để đối chiếu, và **KHÔNG thêm bước "verify/check current account" vào kế hoạch
> (plan)**. Tài khoản trên thiết bị MẶC ĐỊNH đã đúng — bắt đầu thẳng từ Bước 1.

### Bước 1 — Mở tab "Bài chờ duyệt"
Gọi `facebook_group_open_pending_tab(group_name="[group_name]")`.
- Trả "OK" → Bước 2.
- "Failed: ..." → trả lỗi cho task_executor luôn (đừng cố tap bừa).

### Bước 2 — Scrape danh sách
Gọi `facebook_group_fetch_pending_list()`.
- Tool tự lưu list vào raw_context['pending_posts'].
- Trả về "Đã scrape N bài chờ duyệt." → goal hoàn thành.

> Nếu list dài hơn 1 màn hình, có thể cuộn xuống và gọi lại
> `facebook_group_fetch_pending_list()` để gộp thêm. Mỗi lần gọi sẽ ghi đè —
> nên scroll-then-fetch toàn bộ trước khi return.

## QUAN TRỌNG — không được làm
- KHÔNG tự gọi `facebook_group_approve_pending_post` hay
  `facebook_group_reject_pending_post` trong skill này — chỉ scrape.
- KHÔNG cài thêm tool (yt-dlp, pip, ...). Mọi thứ đã sẵn sàng.
- KHÔNG bịa post_fb_id. Nếu UI không lộ ID, để trống — backend sẽ bỏ qua row.
