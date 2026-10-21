# Skill: Upload Video lên TikTok từ URL

## Khi nào dùng skill này

Dùng skill này khi task yêu cầu **"chia sẻ video"**, **"upload video"**, **"đăng video lên TikTok"**, **"post video"** kèm theo một URL.

KHÔNG dùng skill này nếu task chỉ yêu cầu comment, like, view, tìm kiếm — đó là các skill khác.

## Loại URL được hỗ trợ

| Loại | Ví dụ | Ghi chú |
|---|---|---|
| TikTok page URL | `tiktok.com/@user/video/123456` | Tool tự dùng yt-dlp để download |
| Direct MP4 URL | `https://example.com/video.mp4` | Tool download trực tiếp qua HTTP |

Truyền URL nguyên vẹn vào `tiktok_download_video_to_device` — tool tự phát hiện loại và xử lý.

## Tools dùng trong skill này

| Tool | Mục đích |
|---|---|
| `tiktok_ensure_screen_on` | Thức/mở khoá màn hình và về Home screen |
| `tiktok_download_video_to_device` | Download MP4 từ URL → `/sdcard/DCIM/Camera/video.mp4` |
| `tiktok_open_file_manager_at_video` | Mở file manager và tự navigate đến DCIM/Camera |
| `tiktok_share_video_file_to_tiktok` | Long-press video.mp4 → Share → TikTok |
| `tiktok_complete_video_upload` | Điền caption & hashtag, tap Next → Post trong TikTok upload editor |
| `tiktok_get_upload_state` | Kiểm tra trạng thái màn hình hiện tại |
| `tiktok_dismiss_popup` | Đóng popup/quảng cáo xuất hiện bất ngờ trong TikTok |

## Plan chỉ có các bước sau:

1. Thức/mở khoá màn hình nếu cần (`tiktok_ensure_screen_on`).
2. Download video từ URL → `tiktok_download_video_to_device(url="<URL>")`. Chờ tool xác nhận file đã lưu mới tiếp tục.
3. Mở file manager tại DCIM/Camera → `tiktok_open_file_manager_at_video`. Tool sẽ tự navigate đến Camera và xác nhận `video.mp4` hiện. Nếu tool trả về "Failed" → KHÔNG chuyển sang bước 4. Gọi lại `tiktok_open_file_manager_at_video` (tối đa 2 lần) cho đến khi thành công.
4. Share video lên TikTok → `tiktok_share_video_file_to_tiktok`. Nếu có popup → `tiktok_dismiss_popup` rồi gọi lại.
5. Hoàn tất upload → `tiktok_complete_video_upload(caption="<CAPTION>", hashtags="<HASHTAGS>")` (nếu không truyền, tool sẽ tự động đọc từ payload `caption` / `content` / `content_text` và `hashtags` / `tags`). Tool tự điền caption & hashtag rồi tap Next → Post. Nếu có popup → `tiktok_dismiss_popup` rồi gọi lại. Task xong khi màn hình "Đăng video" / "Posting" xuất hiện.

## Recovery

- **`tiktok_open_file_manager_at_video` fail** → **KHÔNG nhảy sang `tiktok_share_video_file_to_tiktok`**. Gọi lại `tiktok_open_file_manager_at_video` (retry, tối đa 2 lần). Tool sẽ tự restart file manager và navigate lại từ đầu.
- **`tiktok_share_video_file_to_tiktok` fail với lý do "video.mp4 not found"** → File manager chưa ở đúng Camera folder. Gọi lại `tiktok_open_file_manager_at_video` trước.
- **Màn hình không rõ trạng thái** → gọi `tiktok_get_upload_state` để xác định bước tiếp theo.
- **Có popup/quảng cáo** → gọi `tiktok_dismiss_popup` rồi thực hiện lại bước hiện tại.
- **`tiktok_download_video_to_device` fail** → kiểm tra URL đúng format chưa; TikTok page URL cần internet ổn định và yt-dlp có thể mất đến 120s.

## Notes

- Video luôn được lưu tại `/sdcard/DCIM/Camera/video.mp4`. File cũ sẽ bị xoá trước khi download mới.
- Nhãn UI TikTok theo ngôn ngữ thiết bị: tiếng Việt là "Tiếp" / "Đăng", tiếng Anh là "Next" / "Post".
- Upload thực sự diễn ra ngầm sau khi tap Post. Task hoàn thành ngay khi màn hình "Đăng video" / "Posting" xuất hiện.
- URL test: `https://samplelib.com/mp4/sample-5s.mp4`
