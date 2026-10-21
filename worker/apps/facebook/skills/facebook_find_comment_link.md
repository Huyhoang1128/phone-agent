# Skill: facebook_find_comment_link

## Mục tiêu
Một tài khoản FB (fetcher) **khác** với tác giả comment gốc mở một bài đăng, định vị
comment gốc (theo tên tác giả + đoạn text), rồi **copy liên kết** của comment đó.
Dùng cho luồng seeding cụm hội thoại: FB KHÔNG cho copy link comment của chính
mình, nên phải nhờ một tài khoản khác trong cụm đi lấy link, để các reply sau định
vị đúng comment gốc.

## Khi nào dùng skill này
Task có dạng:
- "Vào facebook [fetcher], mở bài đăng <post_url>, tìm bình luận của "<root_author>" (đoạn text: "<root_snippet>"), long-press và Sao chép liên kết của bình luận đó."

Tham số:
- **fetcher** — tên FB profile đang đăng nhập trên thiết bị (KHÁC tác giả comment gốc).
- **post_url** — link bài viết.
- **root_author** — tên hiển thị của tài khoản đã đăng comment gốc.
- **root_snippet** — đoạn text trích từ nội dung comment gốc (để định vị).

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

### Bước 2 — Mở thread bình luận
Scan UI, tap nút "Bình luận" / "Comment" để mở toàn bộ thread.
- **Nếu bài dài / chưa thấy phần bình luận**: **vuốt (scroll) xuống** qua nội dung
  bài cho tới khi thấy khu vực bình luận rồi mới tap. Bài dài có thể cần scroll vài lần.

### Bước 3 — Định vị comment gốc
**Scroll** trong thread bình luận tìm card comment thoả mãn cả hai:
1. Author name khớp `root_author`.
2. Body chứa `root_snippet` (so khớp substring, không phân biệt hoa thường).

Cứ **tiếp tục vuốt xuống** nếu chưa thấy. Không thấy sau 5-6 lần scroll → trả Failed:
"Không định vị được comment gốc."

### Bước 4 — Long-press để hiện menu
Long-press (nhấn giữ) lên card comment gốc → FB hiện menu ngữ cảnh.
**LƯU Ý:** menu này có "Sao chép" (chỉ copy TEXT bình luận — **ĐỪNG dùng**) và
"Chia sẻ bình luận" / "Chia sẻ" / "Share". Link comment lấy qua "Chia sẻ".

### Bước 5 — Copy link
Gọi `facebook_capture_comment_link()` ngay khi menu long-press đang mở.
- Tool tự bấm "Chia sẻ bình luận"/"Chia sẻ"/"Share" → trong bảng chia sẻ bấm
  "Sao chép liên kết" → đọc clipboard, parse URL và stamp `comment_url`.
- Nếu tool trả Failed (không thấy "Chia sẻ" hoặc "Sao chép liên kết") → trả Failed
  để control retry bằng tài khoản khác.
- (Nếu cần làm tay: tap "Chia sẻ bình luận" → đợi bảng chia sẻ → tap "Sao chép
  liên kết". TUYỆT ĐỐI không bấm "Sao chép" trơn vì chỉ copy text, không phải link.)

### Bước 6 — Xác nhận
`facebook_capture_comment_link` trả Success kèm URL → coi như hoàn tất.

---

## QUAN TRỌNG
- Lấy link phải qua **"Chia sẻ" → "Sao chép liên kết"**. KHÔNG dùng "Sao chép" trơn
  trong menu long-press (đó là copy TEXT, không phải link).
- **KHÔNG** comment, like, reply gì trong skill này — chỉ đi lấy link.
- **KHÔNG** long-press nhầm comment khác — phải khớp cả `root_author` lẫn `root_snippet`.
- Nếu không lấy được link → trả Failed (control sẽ cho một tài khoản khác thử lại).
