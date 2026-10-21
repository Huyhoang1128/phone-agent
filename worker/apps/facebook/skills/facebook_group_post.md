# Skill: facebook_group_post

## Mục tiêu

Đăng bài viết mới vào một hoặc nhiều Nhóm (Groups) đã tham gia trên Facebook
**ở chế độ ẩn danh** (hỗ trợ đính kèm một hoặc NHIỀU ảnh/video cùng lúc).

> **QUAN TRỌNG — bài đăng vào Group luôn phải ẩn danh.** Tham số
> `anonymous=True` là **bắt buộc** trong mọi lần gọi `facebook_create_post`
> ở skill này. Nếu group không hỗ trợ anonymous, tool sẽ Failed thay vì đăng
> lộ danh tính.

---

## Khi nào dùng skill này

- Task yêu cầu dạng:
  - "[tên] đăng bài [nội dung] vào nhóm [tên nhóm]"
  - "đăng bài [nội dung] lên nhóm [tên nhóm] bằng tài khoản [tên]"
  - "đăng bài [nội dung] kèm ảnh [url 1], video [url 2] lên nhóm [tên nhóm]"
  - "đăng bài [nội dung] kèm ảnh/video [url] lên các nhóm [tên nhóm 1], [tên nhóm 2]" (LLM sẽ lặp lại quy trình cho từng nhóm)

---

## Quy trình thực hiện cho mỗi nhóm

### Bước 0 — Khởi động lại ứng dụng (Bắt buộc)
1. Gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt hẳn ứng dụng Facebook.
2. Gọi `open_app(text="Facebook")` để mở lại từ đầu. Chờ 3-4 giây để app tải xong News Feed (Trang chủ).

> ℹ️ Tài khoản đã được chọn đúng sẵn ở thiết bị — **vào thẳng các bước bên dưới**, bắt đầu từ **News Feed / Trang chủ** (nếu đang ở màn hình khác thì bấm tab **Trang chủ** rồi tiếp tục).
> 
> ⛔ **KHÔNG kiểm tra / xác minh tài khoản** dưới BẤT KỲ hình thức nào: KHÔNG gọi
> `facebook_check_current_account`, KHÔNG mở Trang cá nhân, KHÔNG đọc tên tài khoản
> để đối chiếu, và **KHÔNG thêm bước "verify/check current account" vào kế hoạch
> (plan)**. Tài khoản trên thiết bị MẶC ĐỊNH đã đúng — bắt đầu thẳng từ Bước 1.

### Bước 1 — Tải ảnh/video (nếu có yêu cầu đính kèm)

Nếu task yêu cầu đăng bài kèm một hoặc nhiều ảnh/video từ link internet:

1. LLM/Worker đếm tổng số lượng tệp phương tiện (N) yêu cầu.
2. Gọi tuần tự tool `facebook_download_media(url="[đường dẫn tệp i]")` cho từng tệp (tổng cộng N lần).

- **Thành công** → Tiếp tục bước tiếp theo.
- **Thất bại** → Dừng task, báo lỗi tải media.

### Bước 2 — Di chuyển vào nhóm

Gọi `facebook_navigate_to_group(group_name="[tên nhóm]")`.

- Tool sẽ tự động mở tab Nhóm, truy cập Cài đặt -> Đang theo dõi để tìm nhóm (hoặc sử dụng ô Tìm kiếm nhóm để tìm nếu không thấy ngay ở danh sách đầu) và bấm vào nhóm.
- **Thành công** → Sang Bước 3.
- **Thất bại** → Dừng bài viết cho nhóm này, báo lỗi không tìm thấy nhóm.

### Bước 3 — Đăng bài viết vào nhóm (BẮT BUỘC anonymous=True)

- Nếu **không** đăng kèm media:

  ```text
  facebook_create_post(profile_name="[tên]", content="[nội dung]", anonymous=True)
  ```

- Nếu **có** đăng kèm media (sau khi đã tải hết ở Bước 1):

  ```text
  facebook_create_post(profile_name="[tên]", content="[nội dung]", has_media=True, media_count=N, anonymous=True)
  ```

Tool sẽ tự:
1. Tap vào ô soạn thảo bài viết của nhóm ("Bạn viết gì đi...", "Tạo bài viết công khai...").
2. Điền nội dung, đóng bàn phím.
3. Đính kèm ảnh/video bằng cách bấm `"Ảnh/video"` hoặc `"Thư viện"`, chọn lần lượt từ `"mục 1"` tới `"mục N"`, bấm `"Tiếp"`.
4. **Tìm + tap toggle "Đăng ẩn danh"** + xử lý disclaimer dialog (Tiếp tục / Continue).
5. Bấm **Đăng**.

### Bước 4 — Sao chép và đồng bộ liên kết bài đăng (MỚI)

Sau khi đăng bài viết thành công lên group, gọi tool:
```text
facebook_copy_post_link(profile_name="[tên]", content="[nội dung bài đăng]", post_type="Nhóm")
```
Tool này sẽ quét tìm bài viết của bạn vừa đăng ngay tại feed của Nhóm hiện tại bằng cách đối chiếu nội dung (≥80% khớp từ vựng), tự động click vào nhãn thời gian để vào chi tiết, thực hiện sao chép link và gọi API đồng bộ hóa lên Backend.

> ⚠️ **QUAN TRỌNG — nếu tool này trả về lỗi**: Bước 3 (`facebook_create_post`) đã
> đăng bài **THÀNH CÔNG** rồi — lỗi ở đây chỉ là bước quét/so khớp để lấy link bị
> trượt, KHÔNG liên quan đến việc bài đã lên hay chưa.
> - **TUYỆT ĐỐI KHÔNG** gọi lại `facebook_create_post` để "thử lại" (nguy cơ đăng
>   trùng lặp thật, không thể tự động xoá).
> - **KHÔNG coi đây là lỗi của cả tác vụ.** Bỏ qua lỗi này, chuyển sang Bước 5 để
>   thoát ứng dụng như bình thường, rồi báo cáo **tác vụ THÀNH CÔNG**
>   (`request_accomplished success="true"`) vì bài đã được đăng — chỉ ghi chú thêm
>   nguyên văn lỗi của `facebook_copy_post_link` trong phần tóm tắt kết quả.

### Bước 5 — Thoát ứng dụng Facebook bằng ADB
Sau khi đã sao chép link và đồng bộ hoàn tất ở Bước 4, bắt buộc gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook hoàn toàn, tránh việc thiết bị bị giữ lại ở màn hình task cũ làm ảnh hưởng đến các task tiếp theo.

---

## QUAN TRỌNG — không được làm

- KHÔNG gọi `facebook_create_post` mà thiếu `anonymous=True`. Đăng dưới danh tính thật trong group là **vi phạm yêu cầu nghiệp vụ**.
- KHÔNG bỏ qua kết quả Failed của tool — nếu group không có toggle ẩn danh, phải dừng task. KHÔNG được mở composer thủ công bypass.
- KHÔNG cài thêm tool (yt-dlp, pip, wget, ...) — mọi thứ đã sẵn sàng.
- **KHÔNG TỰ THAO TÁC THỦ CÔNG**: Nếu bất kỳ tool nào (như `facebook_create_post`, `facebook_navigate_to_group`,...) trả về kết quả lỗi (`Failed...`), Agent phải **dừng (abort) tác vụ lập tức và thông báo lỗi**. TUYỆT ĐỐI KHÔNG tự ý thực hiện các click/swipe thủ công hoặc tự ý mở ô tìm kiếm để khắc phục lỗi.
- **NGOẠI LỆ**: Nếu chỉ riêng `facebook_copy_post_link` trả về lỗi **sau khi** `facebook_create_post` đã thành công, KHÔNG abort tác vụ — làm theo hướng dẫn ở Bước 4 (báo cáo tác vụ **thành công**, chỉ ghi chú lỗi lấy link).

---

## Ví dụ thực tế

### Ví dụ 1: Không có ảnh/video

Với task: *"Profile A đăng bài 'Chúc mọi người ngày mới tốt lành' vào nhóm NHÓM MẪU 24H"*

1. `facebook_navigate_to_group(group_name="NHÓM MẪU 24H")`
2. `facebook_create_post(profile_name="Profile A", content="Chúc mọi người ngày mới tốt lành", anonymous=True)`
3. `facebook_copy_post_link(profile_name="Profile A", content="Chúc mọi người ngày mới tốt lành", post_type="Nhóm")`
4. `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 2: Đăng kèm 1 ảnh/video

Với task: *"Profile A đăng bài 'Chúc mừng tuần mới!' kèm ảnh <https://example.com/flower.jpg> vào nhóm NHÓM MẪU 24H"*

1. `facebook_download_media(url="https://example.com/flower.jpg")`
2. `facebook_navigate_to_group(group_name="NHÓM MẪU 24H")`
3. `facebook_create_post(profile_name="Profile A", content="Chúc mừng tuần mới!", has_media=True, media_count=1, anonymous=True)`
4. `facebook_copy_post_link(profile_name="Profile A", content="Chúc mừng tuần mới!", post_type="Nhóm")`
5. `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 3: Đăng kèm nhiều ảnh/video cùng lúc

Với task: *"Profile A đăng bài 'Tuần mới rực rỡ!' kèm ảnh <https://example.com/rose.png> và ảnh <https://example.com/sunflower.jpg> vào nhóm NHÓM MẪU 24H"*

1. `facebook_download_media(url="https://example.com/rose.png")`
2. `facebook_download_media(url="https://example.com/sunflower.jpg")`
3. `facebook_navigate_to_group(group_name="NHÓM MẪU 24H")`
4. `facebook_create_post(profile_name="Profile A", content="Tuần mới rực rỡ!", has_media=True, media_count=2, anonymous=True)`
5. `facebook_copy_post_link(profile_name="Profile A", content="Tuần mới rực rỡ!", post_type="Nhóm")`
6. `run_adb_command(command="am force-stop com.facebook.katana")`
