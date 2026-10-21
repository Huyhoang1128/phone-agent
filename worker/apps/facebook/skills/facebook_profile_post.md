# Skill: facebook_profile_post

## Mục tiêu
Đăng bài viết mới lên Trang cá nhân chính chủ của một tài khoản Facebook cụ thể (hỗ trợ đính kèm một hoặc NHIỀU ảnh/video cùng lúc).

> Media (ảnh/video) **đã được worker tải sẵn vào `/sdcard/Download/` và đồng bộ vào thư viện ảnh của thiết bị TRƯỚC khi skill chạy**. Skill KHÔNG được gọi `facebook_download_media` — tệp đã có sẵn. Chỉ cần đếm số tệp từ mô tả task rồi truyền `media_count` đúng vào `facebook_create_post`.

---

## Khi nào dùng skill này
- Task yêu cầu:
  - "vào facebook [tên] đăng bài [nội dung]"
  - "đăng bài [nội dung] lên trang cá nhân của [tên]"
  - "đăng bài [nội dung] lên trang cá nhân của [tên] kèm N tệp media đã được tải sẵn..."

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

### Bước 1 — Đăng bài viết
* Nếu mô tả task **không** nói tới media kèm theo:
  Gọi tool `facebook_create_post(profile_name="[tên]", content="[nội dung]")`.
* Nếu mô tả task có nói "kèm N tệp media đã được tải sẵn..." (hoặc tương đương):
  Gọi tool `facebook_create_post(profile_name="[tên]", content="[nội dung]", has_media=True, media_count=N)`.

> [!IMPORTANT]
> Tool `facebook_create_post` tự động cuộn **LÊN** (vuốt từ trên xuống dưới) để tìm ô soạn bài "Bạn đang nghĩ gì?" khi nó chưa hiển thị trên màn hình. Agent **TUYỆT ĐỐI KHÔNG** tự ý swipe/cuộn thủ công trước hoặc sau khi gọi tool này. Nếu tool trả về `Failed`, dừng task ngay lập tức, không tự ý thao tác màn hình.

### Bước 2 — Sao chép liên kết bài đăng vừa tạo
Gọi tool `facebook_copy_post_link(profile_name="[tên]", content="[nội dung bài đăng]")`.

> ⚠️ **QUAN TRỌNG — nếu tool trả về lỗi "Không tìm thấy bài viết vừa đăng"**:
> Lỗi này KHÔNG chứng minh được là bài ĐÃ đăng, cũng KHÔNG chứng minh được là bài
> CHƯA đăng — `facebook_create_post` báo "thành công" chỉ dựa trên việc ô soạn bài
> đã đóng lại, KHÔNG xác nhận bài thật sự lên feed (đã có case thật: composer đóng
> nhưng bài không hề tồn tại trên trang cá nhân — task 3680, 28/09). Vì vậy:
> - **TUYỆT ĐỐI KHÔNG** gọi lại `facebook_create_post` với cùng nội dung để "thử
>   lại" — nếu bài THẬT SỰ đã lên, làm vậy sẽ tạo ra **MỘT BÀI ĐĂNG TRÙNG LẶP
>   THẬT** trên trang cá nhân, không thể tự động xoá.
> - Dừng (abort) tác vụ ngay, báo lại nguyên văn lỗi của `facebook_copy_post_link`.
> - **BẮT BUỘC báo cáo kết quả CUỐI CÙNG của toàn bộ tác vụ là THẤT BẠI (KHÔNG
>   phải thành công)** — dù `facebook_create_post` trước đó có báo "thành công".
>   TUYỆT ĐỐI KHÔNG tự kết luận "bài đã đăng thành công thật, chỉ lỗi lấy link"
>   rồi báo tác vụ hoàn thành/success — đây là kết luận KHÔNG CÓ CĂN CỨ và đã gây
>   sai lệch thật (task 3680 báo "Hoàn thành" nhưng thực tế không có bài nào được
>   đăng). Ghi rõ trong lý do thất bại: "Không xác nhận được bài đã đăng hay chưa
>   — cần người vận hành kiểm tra thủ công trang cá nhân trước khi quyết định đăng
>   lại hay không."

### Bước 3 — Thoát ứng dụng Facebook bằng ADB
Sau khi đã sao chép link và đồng bộ hoàn tất ở Bước 2, bắt buộc gọi `run_adb_command(command="am force-stop com.facebook.katana")` để tắt ứng dụng Facebook hoàn toàn, tránh việc thiết bị bị giữ lại ở màn hình task cũ làm ảnh hưởng đến các task tiếp theo.

---

## Quy trình tự động của tool `facebook_create_post`:
1. Ấn vào mục tạo bài viết mới "Bạn đang nghĩ gì?".
2. Điền nội dung bài viết.
3. Đóng bàn phím ảo.
4. Đính kèm đúng `media_count` tệp bằng cách chọn lần lượt `"mục 1"` tới `"mục N"` từ thư viện.
5. Ấn nút **Đăng**.

## Quy trình tự động của tool `facebook_copy_post_link`:
1. Đợi bài viết được tải lên hoàn tất và hiển thị đầy đủ trên News Feed.
2. Quét tìm và đối chiếu nội dung bài đăng trên feed (≥80% khớp từ vựng) để xác định chính xác bài đăng vừa tải lên.
3. Ấn vào nhãn thời gian hoặc nút 3 chấm của bài viết vừa đăng.
4. Ấn nút **Chia sẻ** (Share) của bài viết (tự động loại bỏ nhãn "Chia sẻ với").
5. Ấn nút **Sao chép liên kết** (Copy link) để lưu link bài viết vào clipboard.
6. Gọi lệnh adb shell để đọc dữ liệu clipboard từ thiết bị, in liên kết của bài viết ra log và tự động gọi API đồng bộ link bài viết lên backend.

---

## Ví dụ thực tế

### Ví dụ 1: Không có ảnh/video
Với task: *"Vào facebook Profile A đăng bài hôm nay thời tiết đẹp quá"*
1. Gọi `facebook_create_post(profile_name="Profile A", content="hôm nay thời tiết đẹp quá")`
2. Gọi `facebook_copy_post_link(profile_name="Profile A", content="hôm nay thời tiết đẹp quá")`
3. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 2: Đăng kèm 1 tệp media
Với task: *"Đăng bài 'Chill cuối tuần' lên trang cá nhân của Profile A kèm 1 tệp media đã được tải sẵn vào /sdcard/Download/ của thiết bị."*
1. Gọi `facebook_create_post(profile_name="Profile A", content="Chill cuối tuần", has_media=True, media_count=1)`
2. Gọi `facebook_copy_post_link(profile_name="Profile A", content="Chill cuối tuần")`
3. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

### Ví dụ 3: Đăng kèm nhiều tệp media
Với task: *"Đăng bài 'Weekend vibe' lên trang cá nhân của Profile A kèm 3 tệp media đã được tải sẵn vào /sdcard/Download/ của thiết bị."*
1. Gọi `facebook_create_post(profile_name="Profile A", content="Weekend vibe", has_media=True, media_count=3)`
2. Gọi `facebook_copy_post_link(profile_name="Profile A", content="Weekend vibe")`
3. Gọi `run_adb_command(command="am force-stop com.facebook.katana")`

---

## QUAN TRỌNG — không được làm

- **KHÔNG** gọi `facebook_download_media`. Worker đã tải xong rồi.
- **KHÔNG** cố cài tool mới (yt-dlp, gallery-dl, pip install, base64, wget, curl, …). Mọi thứ đã sẵn sàng trên `/sdcard/Download/`.
- **KHÔNG** mở Chrome/trình duyệt để tải lại file.
- **KHÔNG** gọi tool tải lại nếu thấy URL trong context — URL chỉ là metadata.
- **KHÔNG TỰ THAO TÁC THỦ CÔNG**: Nếu bất kỳ tool nào (như `facebook_create_post`, `facebook_copy_post_link`,...) trả về kết quả lỗi (`Failed...`), Agent phải **dừng (abort) tác vụ lập tức và thông báo lỗi**. TUYỆT ĐỐI KHÔNG tự ý thực hiện các click/swipe thủ công hoặc tự ý mở ô tìm kiếm để khắc phục lỗi.
