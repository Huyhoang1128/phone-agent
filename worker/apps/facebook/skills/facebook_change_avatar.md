# Skill: facebook_change_avatar

## Mục tiêu
Đổi ảnh đại diện (avatar) trang cá nhân Facebook của một tài khoản cụ thể.

> Ảnh **đã được worker tải sẵn vào `/sdcard/Download/` và đồng bộ thư viện** TRƯỚC khi skill chạy. Skill KHÔNG được gọi `facebook_download_media`.

## Khi nào dùng skill này
- Task yêu cầu "Đổi ảnh đại diện trang cá nhân Facebook của [tên]" (hoặc tương đương).

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

### Bước 1 — Đổi avatar
Gọi tool `facebook_change_avatar(profile_name="[tên]")`. Tool tự động:
1. Vào Trang cá nhân của tài khoản.
2. Tap avatar hiện tại.
3. Tap nút "Chọn ảnh đại diện" / "Chỉnh sửa ảnh đại diện" (hoặc tương đương).
4. Tap nguồn "Chọn ảnh".
5. Chọn ảnh mới nhất từ thư viện (mục 1 — vì file mới push lên Download sẽ hiện đầu).
6. Tap "Lưu" / "Xong" / "Sử dụng" để xác nhận.

## QUAN TRỌNG — không được làm
- KHÔNG gọi `facebook_download_media`. Ảnh đã có.
- KHÔNG cố cài thêm tool (yt-dlp, pip, wget, ...). Mọi thứ đã sẵn sàng.
- Nếu phát hiện không có nút lưu hợp lệ → trả về Failed chứ KHÔNG được tap bừa.
