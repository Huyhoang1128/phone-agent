# Skill: Trả lời (reply) một comment TikTok và thả tim

Dùng skill này khi task yêu cầu **trả lời** một comment cụ thể trên TikTok.
Nếu task chỉ yêu cầu comment vào video (không phải reply một comment cụ thể), dùng skill `open_and_comment_video` thay thế.

## Cách nhận biết task cần dùng skill này

Dùng skill này nếu Goal có bất kỳ đặc điểm nào sau đây:
- Chứa từ khóa: "trả lời comment", "reply comment", "reply vào comment", "phản hồi comment", "trả lời bình luận".
- Goal có kèm link được mô tả là "link bình luận" / "link comment" — kể cả link ngắn `vt.tiktok.com`.
- Payload có field `comment_link` (bất kể định dạng URL).

**KHÔNG dùng skill này nếu:**
- Task không cung cấp link comment và goal chỉ yêu cầu comment vào video → dùng `open_and_comment_video`.

## Tool duy nhất cần gọi

| Tool | Mục đích |
|---|---|
| `tiktok_reply_to_comment` | Mở comment → tap "Trả lời" → nhập nội dung (có/không tag) → đăng → ghi Dashboard — tất cả trong một lệnh |

## Cách trích xuất tham số từ goal

| Tham số | Trích xuất từ goal | Ghi chú |
|---------|-------------------|---------|
| `comment_link` | URL chứa `comment_id` trong goal hoặc payload | Bắt buộc |
| `reply_text` | Nội dung cần reply trong goal | Bắt buộc |
| `tag_display_name` | Tên người cần tag sau "tag", "@", "mention" | Dùng khi reply cần @mention thêm người |
| `tag_username` | @username TikTok trực tiếp nếu đã biết chính xác | Ưu tiên hơn `tag_display_name` |
| `comment_suffix` | Nội dung gõ thêm sau tag | Tuỳ chọn |

Nếu các tham số không truyền, tool tự lấy từ payload (`comment_link`, `reply_text`, `tag_display_name`, `tag_username`, `comment_suffix`).

## QUAN TRỌNG — Cách chia tham số khi có tag

Khi reply có @mention, **PHẢI chia nội dung thành 3 phần** theo vị trí của @tag trong câu:

```
[reply_text] @[tag_display_name / tag_username] [comment_suffix]
```

| Phần | Tham số | Nội dung |
|---|---|---|
| Trước @tag | `reply_text` | Toàn bộ text **trước** vị trí @mention — KHÔNG chứa tên người tag |
| Người được tag | `tag_display_name` hoặc `tag_username` | Chỉ tên/username người cần tag |
| Sau @tag | `comment_suffix` | Toàn bộ text **sau** vị trí @mention (có thể rỗng) |

**❌ SAI — nhồi toàn bộ text vào reply_text:**
```
reply_text="Có bà nào từng tham khảo bên BS A chưa 🥹 tui tò mò không biết bác tư vấn không ạ"
tag_display_name="BS A"
```
→ Kết quả: comment bị lặp tên + tag thừa ở cuối

**✅ ĐÚNG — chia đúng 3 phần:**
```
reply_text="Có bà nào từng tham khảo bên "
tag_display_name="BS A"
comment_suffix=" chưa 🥹 tui tò mò không biết bác tư vấn không ạ"
```
→ Kết quả: `Có bà nào từng tham khảo bên @BS A chưa 🥹 tui tò mò không biết bác tư vấn không ạ`

### Ví dụ goal và cách gọi tool

**Ví dụ 1 — Reply thường (không tag):**

**Goal:** `"trả lời comment https://t.tiktok.com/...?share_comment_id=123&... với nội dung cảm ơn bạn đã chia sẻ"`

```
tiktok_reply_to_comment(
    comment_link="https://t.tiktok.com/...?share_comment_id=123&...",
    reply_text="cảm ơn bạn đã chia sẻ"
)
```

**Ví dụ 2 — Tag ở cuối câu (không có text sau tag):**

**Goal:** `"trả lời comment ... với nội dung 'bạn nghĩ sao' và tag 'bác sĩ Hoàng'"`

```
tiktok_reply_to_comment(
    comment_link="https://t.tiktok.com/...?share_comment_id=123&...",
    reply_text="bạn nghĩ sao",
    tag_display_name="bác sĩ Hoàng"
    # comment_suffix để trống vì không có text sau tag
)
```

**Ví dụ 3 — Tag ở giữa câu (có text trước VÀ sau tag):**

**Goal:** `"reply ... nội dung 'Có bà nào từng tham khảo bên' tag 'BS A' rồi viết thêm 'chưa 🥹 tui tò mò'"`

```
tiktok_reply_to_comment(
    comment_link="https://t.tiktok.com/...?share_comment_id=123&...",
    reply_text="Có bà nào từng tham khảo bên ",   # text TRƯỚC @tag
    tag_display_name="BS A",                 # người được @mention
    comment_suffix=" chưa 🥹 tui tò mò"            # text SAU @tag
)
```

**Ví dụ 4 — Tag ở đầu câu (không có text trước tag):**

**Goal:** `"reply comment ... tag @bacsitiendat và viết thêm 'bạn có đồng ý không?'"`

```
tiktok_reply_to_comment(
    comment_link="https://t.tiktok.com/...?share_comment_id=123&...",
    reply_text="",                        # rỗng vì tag ở đầu
    tag_username="@bacsitiendat",
    comment_suffix="bạn có đồng ý không?"
)
```

## Tool tự động thực hiện

1. Mở `comment_link` bằng ADB deep link → TikTok tự mở comment section và scroll đến đúng comment cần reply.
2. Chờ 6s để load hoàn tất.
3. **Tự động thả tim ngay**: tìm nút like cạnh "Trả lời" (loại trừ nút "Tán thành") → tap để like comment.
4. Nếu có `tag_display_name` hoặc `tag_username` → resolve @username qua `tag_mapping.yaml`.
5. Tìm nút **"Trả lời"** / **"Reply"** → tap → reply box mở với `"@tên_tác_giả "` được điền sẵn.
6. Nhập nội dung reply:
   - **Không tag**: gõ thẳng `reply_text`.
   - **Có tag**: gõ `reply_text + @` → gõ partial tên → TikTok hiện popup suggest → tap chọn đúng người → gõ `comment_suffix` nếu có.
7. Tap nút **Đăng** / **Post** để gửi → ghi lại tương tác lên Dashboard và tự động cập nhật trạng thái comment plan (`POST /api/tiktok/update-comment-plan/` với `is_commented=true`).

Khi nhận được kết quả chứa `Đã like và reply thành công` → **báo cáo hoàn thành và kết thúc task**.

## Xử lý lỗi (retry theo mã bước)

| Lỗi trả về | Nguyên nhân | Hành động |
|---|---|---|
| `Failed: [bước 1]` | Thiếu `comment_link` hoặc `reply_text` trong tham số lẫn payload | Đọc lại goal/payload để lấy giá trị, gọi lại tool với tham số đầy đủ |
| `Failed: [bước 1.5]` | Không resolve được @username từ `tag_display_name` | Kiểm tra `tag_mapping.yaml` hoặc truyền `tag_username` trực tiếp |
| `Failed: [bước 2]` | ADB deep link lỗi hoặc TikTok không mở | Thử lại sau 3s |
| `Failed: [bước 3]` | Không tìm thấy nút "Trả lời" — TikTok chưa scroll đến comment target | Chờ 3s rồi gọi lại tool |
| `Failed: [bước 4]` | Ô nhập reply chưa hiện hoặc nhập thất bại | Chờ 2s rồi gọi lại tool |
| `Failed: [bước 5]` | Nút Post/Gửi chưa hiện | Chờ 2s rồi gọi lại tool |

Nếu một bước lỗi quá 3 lần liên tiếp → dừng và báo cáo lỗi cụ thể cho hệ thống.

## Lưu ý

- Skill này **không cần mở TikTok trước** — deep link tự mở thẳng đến đúng comment.
- Nếu có popup/quảng cáo xuất hiện, gọi `tiktok_dismiss_popup` rồi gọi lại tool.
- `comment_link` là URL share của TikTok lấy từ "Chia sẻ → Sao chép liên kết" trên một comment. TikTok hiện trả về link ngắn `vt.tiktok.com` (VD: `https://vt.tiktok.com/ZSdemo0002/`) — link này mã hóa cả video ID + comment ID, khi mở trong app sẽ navigate đúng tới comment. Cả hai định dạng ngắn lẫn dài đều dùng được.
- `tag_display_name` sẽ tự tra cứu trong `tag_mapping.yaml` — có thể dùng tên thường ngày thay vì @username chính xác.
