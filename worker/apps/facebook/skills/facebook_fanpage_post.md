# Skill: facebook_fanpage_post

## Mục tiêu
Đăng bài viết mới lên Fanpage chỉ định (hỗ trợ cả bài viết thông thường hoặc đính kèm một hoặc NHIỀU ảnh/video cùng lúc).

---

## Khi nào dùng skill này
- Task yêu cầu dạng:
  - "[tên] vào Fanpage [tên trang] đăng bài [nội dung]"
  - "[tên] vào Fanpage [tên trang] đăng bài [nội dung] kèm ảnh/video [url]"
  - "[tên] vào Fanpage [tên trang] đăng bài [nội dung] kèm ảnh [url 1], ảnh [url 2], video [url 3]..."

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

### Bước 1 (MỚI) — Tải ảnh/video (nếu có yêu cầu đính kèm)
Nếu task yêu cầu đăng bài kèm một hoặc nhiều ảnh/video từ link internet:
1. LLM/Worker đếm tổng số lượng tệp phương tiện ($N$) yêu cầu.
2. Gọi tuần tự tool `facebook_download_media(url="[đường dẫn tệp i]")` cho từng tệp (tổng cộng $N$ lần).
- **Thành công** → Tiếp tục bước tiếp theo.
- **Thất bại** → Dừng task, báo lỗi tải media.

### Bước 2 — Đăng bài viết lên Fanpage
* Nếu **không** đăng kèm media:
  Gọi `facebook_post_to_fanpage(profile_name="[tên]", fanpage_name="[tên trang]", content="[nội dung]")`.
* Nếu **có** đăng kèm media (sau khi đã tải hết ở Bước 1):
  Gọi `facebook_post_to_fanpage(profile_name="[tên]", fanpage_name="[tên trang]", content="[nội dung]", has_media=True, media_count=[số lượng tệp N])`.

- Tool tự động đọc `fanpage_mapping.yaml` để kiểm tra `[tên]` có phải chủ sở hữu (`owner`) của `[tên trang]` hay không.
- Nếu đúng chủ sở hữu → chạy luồng đăng bài chính chủ (`_post_to_own_fanpage`) có hỗ trợ đính kèm đúng số lượng media từ thư viện bằng cách quét UI tìm từ `"mục 1"` đến `"mục N"`.
- Nếu không phải chủ sở hữu → chạy luồng đăng bài trang công khai (`_post_to_other_fanpage_stub`).

### Bước 3 — Sao chép và đồng bộ liên kết bài đăng (MỚI)
Sau khi đăng thành công lên Fanpage, gọi tool:
```text
facebook_copy_post_link(profile_name="[tên]", content="[nội dung bài đăng]", post_type="Page", target_name="[tên trang]")
```
Tool này sẽ quét tìm bài viết vừa đăng ngay tại profile của Fanpage hiện tại bằng cách đối chiếu nội dung (≥80% khớp từ vựng), click vào nhãn thời gian để vào chi tiết, thực hiện sao chép link và gọi API đồng bộ hóa lên Backend.

> ⚠️ **QUAN TRỌNG — nếu tool này trả về lỗi**: Bước 2 (`facebook_post_to_fanpage`)
> đã đăng bài **THÀNH CÔNG** rồi — lỗi ở đây chỉ là bước quét/so khớp để lấy link bị
> trượt, KHÔNG liên quan đến việc bài đã lên hay chưa.
> - **TUYỆT ĐỐI KHÔNG** gọi lại `facebook_post_to_fanpage` để "thử lại" (nguy cơ
>   đăng trùng lặp thật, không thể tự động xoá).
> - **KHÔNG coi đây là lỗi của cả tác vụ.** Bỏ qua lỗi này, chuyển sang Bước 4 để
>   thoát ứng dụng như bình thường, rồi báo cáo **tác vụ THÀNH CÔNG**
>   (`request_accomplished success="true"`) vì bài đã được đăng — chỉ ghi chú thêm
>   nguyên văn lỗi của `facebook_copy_post_link` trong phần tóm tắt kết quả.

### Bước 4 — Thoát ứng dụng Facebook bằng ADB
Sau khi đã sao chép link và đồng bộ hoàn tất ở Bước 3, bắt buộc gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook hoàn toàn, tránh việc thiết bị bị giữ lại ở màn hình task cũ làm ảnh hưởng đến các task tiếp theo.

---

## Ví dụ thực tế

### Ví dụ 1: Không có ảnh/video
Với task: *"Profile A vào Fanpage Trang Làm Đẹp Mẫu đăng bài tôi muốn làm người mẫu"*
1. Gọi `facebook_post_to_fanpage(profile_name="Profile A", fanpage_name="Trang Làm Đẹp Mẫu", content="tôi muốn làm người mẫu")`
2. Gọi `facebook_copy_post_link(profile_name="Profile A", content="tôi muốn làm người mẫu", post_type="Page", target_name="Trang Làm Đẹp Mẫu")`
3. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 2: Đăng kèm 1 ảnh/video
Với task: *"Profile A vào Fanpage Trang Làm Đẹp Mẫu đăng bài 'Chào ngày mới!' kèm ảnh https://example.com/beautiful_day.jpg"*
1. Gọi `facebook_download_media(url="https://example.com/beautiful_day.jpg")`
2. Gọi `facebook_post_to_fanpage(profile_name="Profile A", fanpage_name="Trang Làm Đẹp Mẫu", content="Chào ngày mới!", has_media=True, media_count=1)`
3. Gọi `facebook_copy_post_link(profile_name="Profile A", content="Chào ngày mới!", post_type="Page", target_name="Trang Làm Đẹp Mẫu")`
4. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 3: Đăng kèm nhiều ảnh/video cùng lúc
Với task: *"Profile A vào Fanpage Trang Làm Đẹp Mẫu đăng bài 'Chào mừng hè sang!' kèm ảnh https://example.com/beach.jpg và ảnh https://example.com/sea.jpg"*
1. Gọi `facebook_download_media(url="https://example.com/beach.jpg")`
2. Gọi `facebook_download_media(url="https://example.com/sea.jpg")`
3. Gọi `facebook_post_to_fanpage(profile_name="Profile A", fanpage_name="Trang Làm Đẹp Mẫu", content="Chào mừng hè sang!", has_media=True, media_count=2)`
4. Gọi `facebook_copy_post_link(profile_name="Profile A", content="Chào mừng hè sang!", post_type="Page", target_name="Trang Làm Đẹp Mẫu")`
5. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

---

## QUY TẮC AN TOÀN & XỬ LÝ LỖI (BẮT BUỘC)
- **KHÔNG TỰ THAO TÁC THỦ CÔNG**: Nếu `facebook_post_to_fanpage` trả về kết quả lỗi (`Failed...`), Agent phải **dừng (abort) tác vụ lập tức và thông báo lỗi**. TUYỆT ĐỐI KHÔNG tự ý thực hiện các click/swipe thủ công hoặc tự ý mở ô tìm kiếm để khắc phục lỗi.
- **NGOẠI LỆ**: Nếu chỉ riêng `facebook_copy_post_link` trả về lỗi **sau khi** `facebook_post_to_fanpage` đã thành công, KHÔNG abort tác vụ — làm theo hướng dẫn ở Bước 3 (báo cáo tác vụ **thành công**, chỉ ghi chú lỗi lấy link).


