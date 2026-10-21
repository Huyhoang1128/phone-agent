# Skill: Auto-browse TikTok

## Goal
Automatically scroll the TikTok For You feed for a given duration or number of videos,
randomly liking content to simulate natural user behaviour.

## Tool used

| Tool | Purpose |
|---|---|
| `tiktok_browse` | Auto-browse TikTok — opens the app, scrolls feed, likes randomly |

## How to fill parameters

Read the user's request and fill accordingly:

| User says | Parameters |
|---|---|
| "scroll tiktok 10 minutes" | `duration_minutes=10` |
| "watch 50 tiktok videos" | `video_count=50` |
| "browse 30 minutes or 100 videos" | `duration_minutes=30, video_count=100` |
| Nothing specified | Leave defaults (tool uses 10 minutes) |

- **duration_minutes**: how many minutes to browse (float, e.g. `10.0`, `30.5`)
- **video_count**: how many videos to watch (int, e.g. `50`, `100`)
- If both are provided → stop at whichever condition is met **first**
- If neither is provided → default **10 minutes**

## Steps

### Single step

1. **Call `tiktok_browse`** with parameters read from the user's request.
   - The tool opens TikTok itself — no preparation steps needed.
   - The tool runs the full browse loop and returns when done.
   - Wait for the result string and report it to the user.

## Notes
- The tool **opens TikTok on its own** — no setup tools needed before calling it. If the screen is locked, the tool wakes and unlocks it automatically.
- While browsing, the tool handles automatically: lock screen, notifications, TikTok going to background, SparkActivity webview traps, livestreams (skipped), ads (skipped).
- Randomly likes 2–3 videos per 10-video window (~20–30% like rate).
- ~20% chance to visit the creator's profile and watch 1–3 additional videos.
- On success, returns a summary: minutes elapsed, videos watched, likes, profiles visited, lives skipped, ads skipped.
- If TikTok cannot be opened or crashes, returns a string starting with `Failed:` — handle the error and retry.
