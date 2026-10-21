# Skill: facebook_find_post_link

## Mục tiêu
Tìm kiếm bài viết trên Facebook dựa trên nội dung được cung cấp, loại bài đăng ("Trang cá nhân", "Nhóm", hoặc "Page"), xem toàn bộ bài viết (nếu bị rút gọn bằng nút Xem thêm), đối chiếu độ khớp từ vựng tối thiểu 80%, mở chi tiết bài viết, sao chép liên kết và đồng bộ lên hệ thống.

---
## Khi nào dùng skill này
- Task yêu cầu:
  - "tìm link bài đăng [Trang cá nhân / Nhóm / Page] với nội dung [nội dung] của tài khoản [tên]"
  - "tìm và lấy link bài viết có nội dung [nội dung] trong [Nhóm / Page / Trang cá nhân] của [tên]"
  - "lấy liên kết bài đăng [nội dung] trên [Trang cá nhân / Nhóm / Page] của [tên]"

> [!WARNING]
> - **KHÔNG** sử dụng skill này nếu task yêu cầu **đăng bài** / **tạo bài viết mới** / **viết bài** (kể cả khi trong mô tả task có yêu cầu lấy link/đồng bộ link sau khi đăng). Với tác vụ đăng bài, bắt buộc phải dùng skill `facebook_profile_post` để tạo bài viết trước!

---

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
> 
> [!IMPORTANT]
> - **KHÔNG** tự ý thực hiện các bước tìm kiếm, gõ tìm tên tài khoản trên thanh tìm kiếm, hoặc tự click vào profile của tài khoản hiện tại trên màn hình.
> - **BẮT BUỘC** gọi trực tiếp tool `facebook_find_and_copy_post_link` ngay tại màn hình chính. Tool sẽ tự động xử lý toàn bộ việc điều hướng thông qua nút Trang cá nhân/Fanpage/Nhóm.


### Bước 1 — Tìm bài viết và sao chép link
Gọi tool `facebook_find_and_copy_post_link(profile_name="[tên_tài_khoản]", content="[nội dung]", post_type="[loại_bài_đăng]", target_name="[tên_nhóm_hoặc_page]")`.

*Lưu ý:*
- Nếu `post_type` là `"Trang cá nhân"` (hoặc `"profile"`): `target_name` không bắt buộc.
- Nếu `post_type` là `"Nhóm"` (hoặc `"group"`): `target_name` bắt buộc phải là Tên Nhóm cụ thể.
- Nếu `post_type` là `"Page"` / `"Fanpage"` (hoặc `"fanpage"`): `target_name` bắt buộc phải là Tên Fanpage cụ thể.

Tool này sẽ thực hiện tự động:
1. Điều hướng tới Trang cá nhân, Nhóm, hoặc Fanpage mục tiêu.
2. Cuộn tìm bài viết phù hợp — so sánh **word-overlap ≥ 80%** giữa text bài hiển thị và `content` (áp dụng thống nhất cả khi bài bị rút gọn và sau khi mở rộng "xem thêm").
3. Nếu bài viết hiển thị chưa đầy đủ (có chữ "xem thêm" hoặc "See more"), robot sẽ click để mở rộng toàn bộ bài đăng trước khi so sánh.
4. Nhấn vào **nhãn thời gian** của bài viết để đi vào trang chi tiết. Nếu không tìm thấy nhãn thời gian → trả về Failed, không thao tác bừa.
6. Thực hiện quy trình sao chép link và đồng bộ lên API của backend.

### Bước 2 — Thoát ứng dụng Facebook bằng ADB
Sau khi đã sao chép link và đồng bộ hoàn tất ở Bước 1, bắt buộc gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook hoàn toàn, tránh việc thiết bị bị giữ lại ở màn hình task cũ làm ảnh hưởng đến các task tiếp theo.

---

## Ví dụ thực tế

### Ví dụ 1: Tìm link bài viết trên Trang cá nhân
Với task: *"Vào facebook Profile B tìm link bài đăng 'TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...' trên trang cá nhân"*
1. Gọi `facebook_find_and_copy_post_link(profile_name="Profile B", content="TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...", post_type="Trang cá nhân")`
2. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 2: Tìm link bài viết trong Nhóm
Với task: *"Vào facebook Profile B tìm link bài viết 'TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...' đăng trong nhóm 'NHÓM MẪU 24H'"*
1. Gọi `facebook_find_and_copy_post_link(profile_name="Profile B", content="TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...", post_type="Nhóm", target_name="NHÓM MẪU 24H")`
2. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 3: Tìm link bài viết trên Fanpage
Với task: *"Vào facebook Profile B tìm link bài viết 'TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...' đăng trên page 'Trang Làm Đẹp Mẫu'"*
1. Gọi `facebook_find_and_copy_post_link(profile_name="Profile B", content="TẠI SAO CẦN NHỊN ĂN TRƯỚC PHẪU THUẬT?...", post_type="Page", target_name="Trang Làm Đẹp Mẫu")`
2. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

---

## QUY TẮC AN TOÀN & XỬ LÝ LỖI (BẮT BUỘC)
- **KHÔNG TỰ THAO TÁC THỦ CÔNG**: Nếu bất kỳ tool nào (như `facebook_find_and_copy_post_link`, `facebook_navigate_to_group`,...) trả về kết quả lỗi (`Failed...`) hoặc không hoạt động như mong muốn, Agent phải **dừng (abort) tác vụ lập tức và thông báo lỗi**.
- **TUYỆT ĐỐI KHÔNG** tự ý thực hiện các hành động cơ bản (như nhấn nút `back`, tự click các toạ độ/index ngẫu nhiên trên màn hình, tự mở ô tìm kiếm và tự nhập chữ thủ công...) để cố gắng giải quyết lỗi. Việc tự ý thao tác này sẽ làm sai lệch trạng thái giao diện của ứng dụng Facebook và làm hỏng các bước tiếp theo.
