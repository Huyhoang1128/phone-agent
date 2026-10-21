# Skill: Mở video TikTok và đăng comment

Dùng skill này khi task yêu cầu comment lên một video TikTok cụ thể.
Thông tin cần thiết (link video, nội dung comment) được lấy tự động từ payload — hoặc truyền trực tiếp qua tham số nếu payload không có.

## Tool duy nhất cần gọi

| Tool | Mục đích |
|---|---|
| `tiktok_open_video_and_comment` | Mở video + nhập comment + đăng + ghi Dashboard — tất cả trong một lệnh |

## Gọi `tiktok_open_video_and_comment`

Tool tự động thực hiện:
1. Lấy `video_link` và `comment_context` — ưu tiên tham số truyền trực tiếp, fallback sang task payload.
2. Mở video TikTok bằng deep link (ADB `am start VIEW`).
3. Tap nút bình luận để mở section comment.
4. Nhập nội dung comment qua portal (hỗ trợ Unicode, emoji).
5. Tap nút **Đăng** / **Post** để gửi.
6. Nhấn Back để đóng comment section.
7. Ghi lại tương tác lên Dashboard (`POST /api/tiktok/record-interaction/`) và tự động cập nhật trạng thái comment plan (`POST /api/tiktok/update-comment-plan/` với `is_commented=true`).

Kết quả trả về khi thành công:
```
Comment đã đăng thành công ... | [INTERACTION RECORDED] ...
Comment đã đăng thành công ... | [RECORD FAILED] ...
```

Khi nhận được kết quả chứa `Comment đã đăng thành công` → **báo cáo hoàn thành và kết thúc task**.

## Xử lý lỗi (retry theo mã bước)

| Lỗi trả về | Nguyên nhân | Hành động |
|---|---|---|
| `Failed: [bước 1]` | Không tìm thấy `video_link` hoặc `comment_context` trong tham số lẫn payload | Đọc task description/goal để lấy giá trị, gọi lại tool với tham số `video_link` và/hoặc `comment_context` trực tiếp |
| `Failed: [bước 2]` | ADB deep link lỗi hoặc TikTok không mở | Kiểm tra TikTok đã cài chưa, thử lại sau 3s |
| `Failed: [bước 3]` | Video chưa load xong, nút comment chưa hiện | Chờ 3s rồi gọi lại tool |
| `Failed: [bước 4]` | Ô nhập comment chưa hiện hoặc portal thất bại | Chờ 2s rồi gọi lại tool |
| `Failed: [bước 5]` | Nút Post/Gửi chưa hiện | Chờ 2s rồi gọi lại tool |

Nếu một bước lỗi quá 3 lần liên tiếp → dừng và báo cáo lỗi cụ thể cho hệ thống.

## Lưu ý

- Skill này **không cần mở TikTok trước** — deep link tự mở thẳng vào video.
<!-- - Nếu màn hình đang tắt hoặc bị khóa, gọi `tiktok_ensure_screen_on` trước. -->
- Nếu có popup/quảng cáo xuất hiện sau khi mở video, gọi `tiktok_dismiss_popup` rồi gọi lại tool.
