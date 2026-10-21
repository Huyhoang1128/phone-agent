# Skill: facebook_login

## Mục tiêu
Đăng nhập vào tài khoản Facebook được chỉ định trong task (VD: "Profile A", "profile2").

---

## Khi nào dùng skill này
- Task yêu cầu "đăng nhập vào Facebook của [tên]"
- Facebook mở lên nhưng hiện màn hình yêu cầu đăng nhập
- Cần xác nhận đang dùng đúng tài khoản trước khi thực hiện task

---

## Quy trình thực hiện

### Bước 0 — Làm sạch trạng thái ứng dụng (Bắt buộc)
Gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook trước.

### Bước 1 — Mở Facebook
Dùng `open_app` với tên "Facebook". Chờ app load.

### Bước 2 — Gọi facebook_check_current_account
Gọi `facebook_check_current_account(profile_name="[tên]")` ngay sau khi mở app.

- **"Đúng tài khoản"** → hoàn thành, tiếp tục task chính.
- **"Sai tài khoản: ... — Hãy đăng xuất..."** → thực hiện logout rồi sang Bước 3.
- **Failed** (tool lỗi vì đang ở màn hình đăng nhập, chưa login) → sang Bước 3 luôn.

### Bước 3 — Đăng nhập (chỉ khi Bước 2 không phải "Đúng tài khoản")
Gọi `facebook_do_login(profile_name="[tên]")` — tool tự động xử lý toàn bộ:
- Tap "Tôi có trang cá nhân rồi" (nếu có)
- Dùng Google Password Manager hoặc điền form thủ công
- Xử lý màn hình "Lưu thông tin đăng nhập?"
- Trả về "Đăng nhập thành công" hoặc "Sai tài khoản sau đăng nhập"

---

## Ví dụ — task "đăng nhập vào Facebook của Profile A"

```
1. open_app("Facebook")
2. facebook_check_current_account(profile_name="Profile A")
   → "Đúng tài khoản: Profile A Đào" → done
   → "Sai tài khoản" → logout → bước 3
   → Failed → bước 3
3. facebook_get_credentials(profile_name="Profile A")
   → điền username, password vào form → tap Đăng nhập
```

---

## Lưu ý quan trọng

> **Popup chặn**: Nếu xuất hiện popup (update, permission...) trước khi vào được app,
> dùng `facebook_dismiss_popup` để đóng rồi tiếp tục.
