# Skill: facebook_post_story

## Mục tiêu
Đăng 1 tin nổi bật (Story) lên Facebook bằng 1 ảnh đã có sẵn.

> Ảnh **đã được worker tải sẵn vào `/sdcard/Download/` và đồng bộ thư viện** TRƯỚC khi skill chạy. Skill KHÔNG được gọi `facebook_download_media`.

## Khi nào dùng skill này
- Task yêu cầu "Đăng tin nổi bật" / "Đăng Story" trên Facebook của [tên].

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

### Bước 1 — Đăng Story
Gọi tool `facebook_post_story(profile_name="[tên]")`. Tool tự động:
1. Trên News Feed, tap "Thêm vào tin" / "Tin của bạn" / "Tạo tin".
2. Tap nút "Thư viện" / "Photo" để chọn ảnh từ gallery (KHÔNG tap "Camera").
3. Chọn ảnh mới nhất từ thư viện (mục 1 — vì file mới push lên Download sẽ hiện đầu).
4. Skip text/sticker editor — đi thẳng tới nút "Chia sẻ tin" / "Đăng" / "Lên tin".
5. Tap "Chia sẻ" để xác nhận.

## QUAN TRỌNG — không được làm
- KHÔNG thêm text overlay, sticker, GIF, music — task chỉ yêu cầu post ảnh.
- KHÔNG gọi `facebook_download_media`. Ảnh đã có.
- KHÔNG cố cài thêm tool. Mọi thứ đã sẵn sàng.
- Nếu Story editor mở thêm dialog "Save draft" / "Discard" → tap "Discard" để thoát.
