# Skill: Đăng ảnh (kèm caption + hashtag) lên TikTok

## Khi nào dùng skill này

Dùng skill này khi task yêu cầu **"chia sẻ ảnh"**, **"đăng ảnh"**, **"post ảnh/hình"**, **"upload ảnh lên TikTok"** kèm caption và/hoặc hashtag. Hỗ trợ **một hoặc nhiều ảnh (carousel)**.

KHÔNG dùng skill này nếu task là đăng **video** (dùng `share_video`), hay chỉ comment/like/view/tìm kiếm — đó là các skill khác.

## ⚠️ QUAN TRỌNG — KHÔNG hỏi người dùng

Dữ liệu (ảnh, caption, hashtag) **ĐÃ có sẵn trong payload Kafka** của task. Các tool **tự đọc payload**, bạn KHÔNG cần và KHÔNG được truyền/hỏi thủ công.

- TUYỆT ĐỐI **KHÔNG** tạo subgoal kiểu "hỏi người dùng cung cấp URL/caption/hashtag", **KHÔNG** chờ (`wait`) input. Người dùng KHÔNG có mặt — đây là task tự động.
- Cứ **gọi thẳng các tool theo thứ tự** bên dưới với **tham số rỗng**; tool tự lấy ảnh/caption/hashtag từ payload.
- Nếu `tiktok_download_images_to_device` trả "Failed: không tìm thấy URL ảnh" → payload thực sự thiếu ảnh → **báo task thất bại**, KHÔNG hỏi người dùng.

## Đầu vào (input)

Ảnh có thể đến từ:

| Nguồn | Dạng dữ liệu | Ghi chú |
|---|---|---|
| Ảnh người dùng upload | URL công khai trong payload | Dashboard đã biến file upload thành link |
| Link ảnh trực tiếp | `https://.../photo.jpg` | Trỏ thẳng tới file ảnh (JPEG/PNG/WEBP/GIF) |

Các trường payload tool tự đọc:
- ảnh: `image_urls` / `images` / `image_url` / `photo_url` / `photos`
- caption: `caption` / `content`
- hashtag: `hashtags` / `tags`

## Cách hoạt động (luồng File Manager — chia sẻ qua share sheet)

Luồng này **chia sẻ ảnh từ File Manager** (giống flow video), ổn định trên nhiều máy hơn flow in-app. Ảnh được tải về với tên cố định `image_1.*`, `image_2.*`, … nên ở bước chọn ta chỉ chọn **đúng các file đó theo tên**, không đụng video/ảnh khác trong Camera.

## Tools dùng trong skill này

| Tool | Mục đích |
|---|---|
| `tiktok_ensure_screen_on` | Thức/mở khoá màn hình, về Home |
| `tiktok_download_images_to_device` | Tải N ảnh từ URL → `/sdcard/DCIM/Camera/image_<n>.*` |
| `tiktok_open_file_manager_at_images` | Mở file manager, vào DCIM/Camera, xác nhận `image_1.*` hiện |
| `tiktok_share_images_file_to_tiktok` | Chọn nhiều `image_<n>.*` → Share → TikTok |
| `tiktok_set_photo_caption_and_post` | (Trong TikTok) qua editor → gõ caption + hashtag → Đăng |
| `tiktok_get_upload_state` | Kiểm tra trạng thái màn hình (recover) |
| `tiktok_dismiss_popup` | Đóng popup/quảng cáo bất ngờ |

## Plan chỉ có các bước sau:

1. Thức/mở khoá màn hình nếu cần (`tiktok_ensure_screen_on`).
2. Tải ảnh về thiết bị → gọi `tiktok_download_images_to_device` (tham số rỗng — tự lấy `image_urls` từ payload). Chờ tool xác nhận **số ảnh đã lưu**.
3. Mở file manager tại DCIM/Camera → `tiktok_open_file_manager_at_images`. Nếu trả "Failed" → KHÔNG sang bước 4; gọi lại (tối đa 2 lần) cho đến khi `image_1.*` hiện.
4. Chọn ảnh và chia sẻ → `tiktok_share_images_file_to_tiktok` (tự đếm số ảnh). Nó long-press `image_1.*`, chọn thêm `image_2..N.*`, Share → TikTok. Nếu có popup → `tiktok_dismiss_popup` rồi gọi lại.
5. Nhập caption + hashtag và đăng → gọi `tiktok_set_photo_caption_and_post` (tham số rỗng — tự lấy `caption`/`hashtags` từ payload). Task xong khi báo "Đã đăng ảnh ... thành công" hoặc màn "Đang đăng" xuất hiện.

## Recovery

- **`tiktok_download_images_to_device` fail** → kiểm tra URL đúng format; URL phải trỏ thẳng tới file ảnh (không phải trang web). Lỗi "không phải ảnh hợp lệ" nghĩa là URL trả về HTML.
- **`tiktok_open_file_manager_at_images` fail** → KHÔNG nhảy sang bước 4. Gọi lại (tool tự restart file manager và navigate DCIM → Camera). Tối đa 2 lần.
- **`tiktok_share_images_file_to_tiktok` fail [bước 1]** ("không thấy image_1.*") → file manager chưa ở đúng Camera. Gọi `tiktok_open_file_manager_at_images` trước rồi thử lại.
- **`tiktok_share_images_file_to_tiktok` fail [bước 3/4]** (không thấy Share / TikTok) → có popup hoặc share sheet chưa mở. `tiktok_dismiss_popup` rồi gọi lại.
- **`tiktok_set_photo_caption_and_post` fail [bước 3]** ("không tìm thấy ô caption") → chưa tới màn caption. Gọi `tiktok_get_upload_state` để xác định màn rồi thử lại.
- **Màn hình không rõ trạng thái** → `tiktok_get_upload_state`.

## Notes

- Ảnh luôn lưu tại `/sdcard/DCIM/Camera/image_<n>.*`. Ảnh `image_*` cũ bị xoá trước khi tải mới, nên chọn theo tên là chính xác và không đụng video/ảnh khác.
- Nhãn UI theo ngôn ngữ thiết bị: VI "Chia sẻ" / "Đăng"; EN "Share" / "Post". File manager: Google Files hoặc Samsung My Files (tool xử lý cả hai).
- `tiktok_share_images_file_to_tiktok` long-press `image_1.*` để vào chế độ chọn nhiều, rồi tap thêm `image_2..N.*` theo tên (cuộn nếu khuất).
- Gõ `#hashtag` làm TikTok bật bảng gợi ý che nút Đăng — `tiktok_set_photo_caption_and_post` tự thêm dấu cách cuối và bỏ focus để hiện lại nút Đăng.
- `hashtags` có thể là "review, lamdep" hoặc "#review #lamdep" — tool tự thêm dấu `#`.
- Upload diễn ra ngầm sau khi tap Đăng. Task hoàn thành ngay khi màn "Đang đăng" / "Posting" xuất hiện.
