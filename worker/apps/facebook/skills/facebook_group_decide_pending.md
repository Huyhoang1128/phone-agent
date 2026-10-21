# Skill: facebook_group_decide_pending

## Mục tiêu
Phê duyệt hoặc từ chối **một** bài đăng đang chờ trong 1 Facebook Group cụ
thể, từ tài khoản admin.

## Khi nào dùng skill này
- payload `action == "approve_group_pending_post"` → quyết định là "approve".
- payload `action == "reject_group_pending_post"` → quyết định là "reject".

## Tiền điều kiện
- Tài khoản FB hiện tại đăng nhập sẵn, là admin của group.
- payload chứa: `group_name`, `account_name`, `author_name`, `content_excerpt`
  (và có thể `post_fb_id`).

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
- "OK" → Bước 2.
- "Failed: ..." → trả lỗi.

### Bước 2 — Cuộn tìm + quyết định
Nếu chưa thấy card của `author_name` trên màn hình → cuộn xuống vài lần.

Khi đã thấy card:
- **Approve**: gọi `facebook_group_approve_pending_post(post_fb_id=..., author_name=..., content_excerpt=...)`.
- **Reject**: gọi `facebook_group_reject_pending_post(post_fb_id=..., author_name=..., content_excerpt=...)`.

Tham số `post_fb_id` thường rỗng — tool match bằng `author_name` /
`content_excerpt`.

## QUAN TRỌNG — không được làm
- KHÔNG quyết định nhiều bài trong 1 task — task chỉ xử lý đúng 1 bài.
- KHÔNG tap nhầm nút bài khác — phải kiểm tra `author_name` trùng trước khi tap.
- KHÔNG bịa nội dung báo lỗi giả "thành công" khi không tìm thấy — trả Failed.
