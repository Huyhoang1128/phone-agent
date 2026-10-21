# Skill: Mở video TikTok, đăng comment và tag người dùng

Dùng skill này khi task/goal yêu cầu comment lên một video TikTok cụ thể VÀ tag (@mention) một người dùng trong comment đó.
Nếu task CHỈ yêu cầu comment (không tag ai), dùng skill `open_and_comment_video` thay thế.

## Cách nhận biết task cần dùng skill này

**BẮT BUỘC** dùng skill này nếu Goal có bất kỳ đặc điểm nào sau đây:
- Chứa từ khóa: "tag", "tag vào", "gắn thẻ", "mention".
- Chứa tên người được đặt trong dấu ngoặc kép sau chữ tag. VD: `tag "bác sĩ hoàng"`.
- Chứa cấu trúc: `comment [nội dung] tag [tên]`.

**CẢNH BÁO:** Ngay cả khi người dùng không viết ký tự `@`, nhưng có chữ "tag" thì bạn vẫn phải hiểu đó là yêu cầu gắn thẻ @mention chuyên nghiệp của TikTok. KHÔNG ĐƯỢC dùng skill `open_and_comment_video` thông thường trong trường hợp này.

Ví dụ goal:
- `"comment xin chào vào video https://vt.tiktok.com/... và tag bác sĩ tiến đạt"`
- `"vào video https://... comment tag "review nâng ngực" ơi nâng ngực có đau không"` -> `comment_context`: `""`, `tag_display_name`: `"review nâng ngực"`, `comment_suffix`: `" ơi nâng ngực có đau không"`.
- `"Hãy mở tiktok và bình luận vào video https://vt.tiktok.com/.... với nội dung Nghe nói bên tag "bs a" hay dùng túi Motiva, không biết túi này mặc đồ ôm có đẹp hơn không"` -> `comment_context`: `"Nghe nói bên "`, `tag_display_name`: `"bs a"`, `comment_suffix`: `" hay dùng túi Motiva, không biết túi này mặc đồ ôm có đẹp hơn không"`.
  → **Lưu ý**: chữ "tag" xuất hiện BÊN TRONG nội dung bình luận cũng là lệnh tag. Tên nằm trong dấu ngoặc kép ngay sau "tag" chính là `tag_display_name` cần @mention.

## Tool duy nhất cần gọi

| Tool | Mục đích |
|---|---|
| `tiktok_open_video_comment_and_tag` | Mở video + nhập comment kèm @tag + đăng + ghi Dashboard — tất cả trong một lệnh |

## Cách trích xuất tham số từ goal

Đọc goal và trích xuất câu comment hoàn chỉnh, sau đó chẻ ra làm 3 phần (Sandwich Tag):

| Tham số | Trích xuất từ goal | Ví dụ (Goal: "Chào @A ơi, khỏe không") |
|---------|-------------------|-------|
| `video_link` | URL/link trong goal | `https://vt.tiktok.com/ZSdemo001/` |
| `comment_context` | Nội dung đứng **TRƯỚC** tag | `"Chào "` |
| `tag_display_name` | Tên người cần tag (nickname) | `"Tiến Đạt"` |
| `tag_username` | @username trực tiếp (nếu goal có @) | `@bacsitiendat` |
| `comment_suffix` | Nội dung đứng **SAU** tag | `" ơi, khỏe không"` |

### Quy tắc chẻ câu linh hoạt:
- **Tag ở đầu câu:** `comment_context` để rỗng `""`.
- **Tag ở giữa câu:** Phải tách rõ phần text phía trước và phía sau tag.
- **Tag ở cuối câu:** `comment_suffix` để rỗng `""`.

### Ví dụ các trường hợp:

1. **Tag ở giữa:** `"bác sĩ tag "Tiến Đạt" ơi bác thấy sao"`
   - `comment_context`: `"bác sĩ "`
   - `tag_display_name`: `"Tiến Đạt"`
   - `comment_suffix`: `" ơi bác thấy sao"`

2. **Tag ở đầu:** `"tag "bác sĩ hoàng" bác sĩ ơi thấy sao"`
   - `comment_context`: `""`
   - `tag_display_name`: `"bác sĩ hoàng"`
   - `comment_suffix`: `" bác sĩ ơi thấy sao"`

3. **Tag ở cuối:** `"xin chào bác tag "Tiến Đạt""`
   - `comment_context`: `"xin chào bác "`
   - `tag_display_name`: `"Tiến Đạt"`
   - `comment_suffix`: `""`

### Ví dụ cách gọi tool

Goal: `"comment xin chào vào video https://vt.tiktok.com/ZSdemo001/ và tag bác sĩ tiến đạt"`

```
tiktok_open_video_comment_and_tag(
    video_link="https://vt.tiktok.com/ZSdemo001/",
    comment_context="xin chào",
    tag_display_name="bác sĩ tiến đạt"
)
```

## Tool tự động thực hiện

1. Resolve @username: nếu có `tag_username` → dùng luôn; nếu chỉ có `tag_display_name` → tra file `tag_mapping.yaml`.
2. Mở video TikTok bằng deep link (ADB `am start VIEW`).
3. Tap nút bình luận để mở section comment.
4. **Phase 1 (Tìm kiếm nhanh):** Nhập `comment_context` + ký tự `@` + 85-90% tên tag. Chờ 3s và quét UI lần 1. Nếu chưa thấy, tự động chờ thêm 2s và quét UI lần 2. Nếu tìm thấy, tap chọn đúng người dùng. *(Lưu ý nội bộ: Tên hiển thị trên popup UI của TikTok thường KHÔNG có ký tự `@` ở đầu, do đó logic quét UI của tool tự động cắt bỏ ký tự `@` khi thực hiện so sánh).*
5. **Phase 2 (Xóa lùi Fallback):** Nếu Phase 1 vẫn không tìm thấy, tool sẽ tự động xóa lùi toàn bộ đoạn tên vừa nhập VÀ xóa luôn ký tự `@`. Sau đó tự động gõ lại `@` để ép TikTok tải lại danh sách gợi ý.
6. **Phase 3 (Cuộn tìm kiếm sâu):** Tool lặp lại việc cuộn danh sách gợi ý (tối đa 5 lần) và quét UI. Nếu tìm thấy, tap chọn để TikTok tự động chèn tag.
7. **Phase 4 (Hậu Tag):** Nếu đã thử 5 lần vẫn thất bại, tool sẽ tự động thoát popup bằng phím Space. Sau đó, tiếp tục nhập `comment_suffix` (nếu có) vào phía sau tag.
8. Tap nút **Đăng** / **Post** để gửi.
9. Nhấn Back để đóng comment section.
10. Ghi lại tương tác lên Dashboard và tự động cập nhật trạng thái comment plan (`POST /api/tiktok/update-comment-plan/` với `is_commented=true`).

Kết quả trả về khi thành công:
```
Comment+Tag đã đăng thành công ... (tag: @username) | [INTERACTION RECORDED] ...
```

Khi nhận được kết quả chứa `Comment+Tag đã đăng thành công` → **báo cáo hoàn thành và kết thúc task**.

## Xử lý lỗi (retry theo mã bước)

| Lỗi trả về | Nguyên nhân | Hành động |
|---|---|---|
| `Failed: [bước 1]` | Thiếu video_link, comment_context, hoặc tag info | Đọc lại goal để trích xuất, gọi lại tool với tham số đầy đủ |
| `Failed: [bước 1.5]` | Không resolve được @username từ tag_display_name | Thử gọi lại với `tag_username` trực tiếp nếu biết @username |
| `Failed: [bước 2]` | ADB deep link lỗi hoặc TikTok không mở | Kiểm tra TikTok đã cài chưa, thử lại sau 3s |
| `Failed: [bước 3]` | Video chưa load xong, nút comment chưa hiện | Chờ 3s rồi gọi lại tool |
| `Failed: [bước 4]` | Ô nhập comment chưa hiện hoặc portal thất bại | Chờ 2s rồi gọi lại tool |
| `Failed: [bước 4.5]` | Không tìm thấy người dùng trong popup gợi ý của TikTok | Thường do mạng lag popup chưa hiện hoặc sai tên. Dừng lại và báo cáo để tránh tag nhầm người. |
| `Failed: [bước 5]` | Nút Post/Gửi chưa hiện | Chờ 2s rồi gọi lại tool |

Nếu một bước lỗi quá 3 lần liên tiếp → dừng và báo cáo lỗi cụ thể cho hệ thống.

## Lưu ý

- Skill này **không cần mở TikTok trước** — deep link tự mở thẳng vào video.
- Nếu có popup/quảng cáo xuất hiện sau khi mở video, gọi `tiktok_dismiss_popup` rồi gọi lại tool.
- Tag có thể nằm ở bất kỳ đâu trong comment tùy thuộc vào cách LLM phân tách tham số.
