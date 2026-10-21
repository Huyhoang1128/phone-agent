# Skill: Searching for TikTok Keywords and Copying Links

## Objective
Open TikTok, search for the provided keyword, and copy links for the requested number of videos (e.g., 1 video, 3 videos, etc.). For each video, copy the link and report success immediately to sync it to the dashboard before moving to the next one.

## Tools
- `tiktok_ensure_screen_on`: Turn on/unlock your device and go to the home screen.

- `tiktok_report_copy_success`: Report that the link has been successfully copied and synced to the dashboard immediately.

## Necessary Steps
1. Wake/Unlock device only if needed (`tiktok_ensure_screen_on`).
2. Open TikTok.
3. Tap search icon (**🔍** or "**Tìm kiếm**").
4. Type keyword, verify it, and tap "**Tìm**" (Search).
5. Tap "**Video**" tab, then open the first video.
6. Share → Copy link → Wait 2s.
7. ⚠️ **PHẢI gọi `tiktok_report_copy_success` NGAY BÂY GIỜ** trước khi làm bất cứ thứ gì khác (swipe, tap, v.v.). KHÔNG được swipe hay chuyển subgoal cho đến khi bước này hoàn thành.
8. Sau khi `tiktok_report_copy_success` trả về thành công → swipe lên video tiếp theo → lặp từ Bước 6.



## Restore
- If you see an ad or pop-up, find the Close or Skip button and tap it. 
- If the "Copy link" button is not visible, swipe horizontally across the share menu to find it.
