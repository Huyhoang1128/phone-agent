# Skill: Thu thập bình luận (comment) từ video TikTok

Dùng skill này khi task yêu cầu "copy comment", "lấy bình luận", "thu thập bình luận", hoặc "tìm comment của ai đó" từ một video TikTok cụ thể.

## Cách nhận biết task cần dùng skill này

Dùng skill này nếu Goal có các đặc điểm:
- Chứa từ khóa: "copy comment", "lấy bình luận", "lấy comment", "thu thập bình luận", "tìm comment".
- Có kèm link video TikTok (hoặc link có sẵn trong payload).
- Có thể yêu cầu số lượng cụ thể (ví dụ: "lấy 20 comment").
- Có thể yêu cầu tìm comment của một người cụ thể (ví dụ: "tìm comment của tag "bác sĩ Hoàng"").
- Có thể yêu cầu tìm comment chứa nội dung cụ thể (ví dụ: "tìm comment 'xin chào'").

## Ví dụ goal và cách trích xuất tham số

### Ví dụ 1: Copy hàng loạt (mode BULK)
**Goal:** `"lấy 10 bình luận từ video https://vt.tiktok.com/ZSdemo001/"`
```json
{"video_link": "https://vt.tiktok.com/ZSdemo001/", "count": 10}
```

### Ví dụ 2: Tìm comment theo tên + nội dung (mode FIND)
**Goal:** `"đi vào link video https://www.tiktok.com/@abc/video/123 tìm cho tôi comment "chào người ae" của tag "thằn lằn con""`
```json
{"video_link": "https://www.tiktok.com/@abc/video/123", "search_username": "thằn lằn con", "search_keyword": "chào người ae", "count": 1}
```
- **"của tag ..."** hoặc **"của ..."** → `search_username` (tên người dùng)
- **"comment ..."** (nội dung trong ngoặc kép) → `search_keyword` (nội dung comment)

### Ví dụ 3: Tìm comment chỉ theo tên (mode FIND)
**Goal:** `"tìm 3 comment của tag "bác sĩ Hoàng" trong video https://vt.tiktok.com/ZSdemo001/"`
```json
{"video_link": "https://vt.tiktok.com/ZSdemo001/", "search_username": "bác sĩ Hoàng", "count": 3}
```

### Ví dụ 4: Tìm comment chỉ theo nội dung (mode FIND)
**Goal:** `"tìm comment nào nói về 'nâng ngực' trong video này"`
```json
{"search_keyword": "nâng ngực", "count": 1}
```

## Quy tắc trích xuất tham số

| Tham số | Trích xuất từ goal | Mặc định |
|---------|-------------------|----------|
| `video_link` | URL/link trong goal | Lấy từ payload |
| `count` | Số lượng yêu cầu | `10` (bulk), `1` (find) |
| `search_username` | Tên sau "của tag", "của", "user" | `""` (không tìm) |
| `search_keyword` | Nội dung comment trong ngoặc kép sau "comment" | `""` (không tìm) |

**QUAN TRỌNG:**
- Khi goal nói **"tag"** trong ngữ cảnh TÌM KIẾM comment (không phải đăng comment), thì "tag" ở đây nghĩa là **tên người dùng** → truyền vào `search_username`.
- Nếu goal không nói số lượng cụ thể trong mode FIND, mặc định `count = 1`.
- Nếu goal chỉ nói "lấy comment" mà KHÔNG có tên người hay nội dung cụ thể → dùng mode BULK (không truyền search_username/search_keyword).

## Tool duy nhất cần gọi

| Tool | Mục đích |
|---|---|
| `tiktok_copy_video_comments` | Tự động mở video, mở section comment, thu thập comment (hàng loạt hoặc tìm kiếm có mục tiêu). |

## Cách tool hoạt động

### Mode BULK (mặc định — không truyền search_username/search_keyword)
1. Mở video TikTok bằng deep link.
2. Mở section comment.
3. Vòng lặp thu thập (tối đa 15 lần cuộn):
    - Tìm comment text theo resource ID.
    - Long-press → Copy → Đọc clipboard.
    - Cuộn trang nếu cần thêm.
4. Trả về danh sách comment.

### Mode FIND (khi truyền search_username và/hoặc search_keyword)
1. Mở video + comment section.
2. Phân giải `search_username` qua `tag_mapping.yaml` (VD: "thằn lằn con" → "thằn lằn con :))").
3. Vòng lặp tìm kiếm (tối đa 50 lần cuộn):
    - Quét username + comment trên màn hình.
    - Ghép cặp username ↔ comment.
    - Tìm comment thỏa mãn điều kiện (username match + keyword match).
    - Nếu tìm thấy:
        - Long-press → "Sao chép" → lấy nội dung comment (parse `@username:content`).
        - Long-press lần 2 → "Chia sẻ với" → "Sao chép liên kết" → lấy comment link.
        - Tự động đẩy lên Dashboard API (`record-interaction`) với `profile_username`, `comment_content`, `comment_link`.
    - Nếu chưa tìm thấy → cuộn xuống.
4. Trả về kết quả (dict với profile_username, comment_content, comment_link).

## Lưu ý

- `search_username` sẽ tự tra cứu trong `tag_mapping.yaml` — bạn có thể dùng tên thường ngày.
- Tool tự xử lý cuộn trang và tránh copy trùng.
- Sau khi tìm thấy, tool tự động copy cả nội dung + link comment và đẩy lên Dashboard.
- Sau khi nhận kết quả, báo cáo cho người dùng.
- Sau khi không tìm thấy comment khi lướt đến cuối comment thì dừng lại không được chạy thêm bất kì hành động nào khác. hãy báo về cho người dùng là không tìm thấy comment. dừng tiến trình lại 
