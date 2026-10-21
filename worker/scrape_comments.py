"""
TikTok Comment Scraper — intercept network responses.
Không cần ms_token. Browser tự scroll, intercept /api/comment/list/ để lấy đủ fields.

Usage:
    python scrape_comments.py [tiktok_url] [output.csv]
"""

import asyncio
import csv
import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode
from playwright.async_api import async_playwright, Response

LINK_VIDEO = "https://www.tiktok.com/@demo_creator3/video/7100000000000000003"
OUT_CSV    = "comments.csv"

CSV_FIELDS = [
    "comment_id", "text", "username", "user_id", "sec_uid",
    "likes_count", "reply_count", "parent_comment_id",
    "created_at", "created_ts", "link_comment",
]


def _parse_link(url: str):
    m = re.search(r"tiktok\.com/@([^/?]+)/video/(\d+)", url)
    if not m:
        raise ValueError(f"Không parse được URL: {url}")
    return m.group(1), m.group(2)


def _build_link(username, video_id, comment_id, reply_id=None):
    base = f"https://www.tiktok.com/@{username}/video/{video_id}"
    if reply_id and str(reply_id) not in ("0", ""):
        q = urlencode({"comment_id": str(reply_id), "reply_id": str(comment_id)})
    else:
        q = urlencode({"comment_id": str(comment_id)})
    return f"{base}?{q}"


def _extract_from_api(c: dict, username: str, video_id: str) -> dict:
    cid      = str(c.get("cid", ""))
    reply_id = str(c.get("reply_id", "0") or "0")
    ts       = c.get("create_time", 0)
    user     = c.get("user", {})

    # Ưu tiên share_info.url vì đã có share_comment_id chính xác
    si = c.get("share_info", {})
    share_url = si.get("url", "") if isinstance(si, dict) else ""
    link = share_url if share_url.startswith("http") else _build_link(
        username, video_id, cid, reply_id if reply_id != "0" else None
    )

    return {
        "comment_id":        cid,
        "text":              c.get("text", ""),
        "username":          user.get("unique_id", ""),
        "user_id":           user.get("uid", ""),
        "sec_uid":           user.get("sec_uid", ""),
        "likes_count":       c.get("digg_count", 0),
        "reply_count":       c.get("reply_comment_total", 0),
        "parent_comment_id": reply_id if reply_id != "0" else "",
        "created_at":        datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else "",
        "created_ts":        ts,
        "link_comment":      link,
    }


async def scrape_comments(url: str) -> list[dict]:
    """Scrape toàn bộ comment từ một video TikTok. Trả về list dict rows."""
    username, video_id = _parse_link(url)

    seen_ids: set[str] = set()
    rows: list[dict] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="vi-VN",
            viewport={"width": 1440, "height": 900},
        )
        page = await ctx.new_page()

        async def on_response(resp: Response):
            u = resp.url
            if "tiktok.com/api" in u:
                print(f"  [NET] {resp.status} {u[:100]}")
            if "/api/comment/list/" not in u:
                return
            print(f"  [COMMENT API] status={resp.status} url={u[:100]}")
            try:
                data = await resp.json()
            except Exception as e:
                try:
                    raw = await resp.body()
                    print(f"  [COMMENT API] json() failed: {e} | body={raw[:200]}")
                except Exception as e2:
                    print(f"  [COMMENT API] body() also failed: {e2}")
                return

            comments = data.get("comments") or []
            print(f"  [COMMENT API] got {len(comments)} comments, has_more={data.get('has_more')}")
            for c in comments:
                cid = str(c.get("cid", ""))
                if not cid or cid in seen_ids:
                    continue
                seen_ids.add(cid)
                row = _extract_from_api(c, username, video_id)
                rows.append(row)
                print(f"  [{len(rows)}] @{row['username']}: {row['text'][:60]}")

        page.on("response", on_response)

        print(f"[*] Mở → {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        print(f"[*] Page title: {await page.title()}")
        await asyncio.sleep(6)

        clicked_info = await page.evaluate("""
        () => {
            let candidates = [
                ...document.querySelectorAll('[data-e2e*="comment"]'),
                ...document.querySelectorAll('[aria-label*="comment" i]'),
                ...document.querySelectorAll('[aria-label*="bình luận" i]'),
            ];
            for (let el of candidates) {
                let tag = el.tagName;
                let role = el.getAttribute('role');
                if (tag === 'BUTTON' || tag === 'A' || role === 'button') {
                    el.click();
                    return {clicked: true, tag, cls: el.className.substring(0,80), label: el.getAttribute('aria-label')};
                }
            }
            return {clicked: false, total: candidates.length};
        }
        """)
        print(f"[*] Comment button click: {clicked_info}")
        await asyncio.sleep(4)

        print("[*] Đợi comment panel mở...")
        panel_sel = None
        for sel in ['[class*="DivCommentListContainer"]', '[class*="DivCommentPanel"]',
                    '[class*="CommentListScroll"]', '[data-e2e="comment-list"]']:
            try:
                await page.wait_for_selector(sel, timeout=8_000)
                panel_sel = sel
                print(f"[*] Comment panel found: {sel}")
                break
            except Exception:
                pass

        if not panel_sel:
            new_containers = await page.evaluate("""
            () => {
                let found = [];
                document.querySelectorAll('div').forEach(el => {
                    let s = window.getComputedStyle(el);
                    if ((s.overflowY==='auto'||s.overflowY==='scroll') && el.scrollHeight > el.clientHeight+50) {
                        found.push({cls: el.className.substring(0,80), sh: el.scrollHeight, ch: el.clientHeight});
                    }
                });
                return found;
            }
            """)
            print("[!] Không tìm thấy comment panel bằng selector. Scrollable divs hiện tại:")
            for c in new_containers:
                print(f"    {c['cls'][:70]}  scrollH={c['sh']}")

        print("[*] Tìm scrollable wrapper của comment panel...")

        scroll_info = await page.evaluate("""
        () => {
            let inner = document.querySelector('[class*="DivCommentListContainer"]');
            if (!inner) return {found: false, reason: 'no DivCommentListContainer'};
            let el = inner.parentElement;
            while (el && el !== document.body) {
                let st = window.getComputedStyle(el);
                if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
                    let rect = el.getBoundingClientRect();
                    return {
                        found: true,
                        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
                        cls: el.className.substring(0, 100),
                        scrollTop: el.scrollTop,
                        scrollHeight: el.scrollHeight,
                        clientHeight: el.clientHeight,
                    };
                }
                el = el.parentElement;
            }
            return {found: false, reason: 'no scrollable parent'};
        }
        """)
        print(f"[*] Scroll info: {scroll_info}")

        if scroll_info.get("found") and 0 <= scroll_info["y"] < 900:
            cx = scroll_info["x"] + scroll_info["w"] / 2
            cy = scroll_info["y"] + scroll_info["h"] / 2
            print(f"[*] Scroll target: ({cx:.0f}, {cy:.0f}) size={scroll_info['w']:.0f}x{scroll_info['h']:.0f}")
        else:
            cx, cy = 1110, 450
            print(f"[!] Dùng fallback ({cx}, {cy})")

        await page.mouse.click(cx, cy)
        await asyncio.sleep(0.5)
        await page.mouse.move(cx, cy)

        no_new = 0
        while no_new < 15:
            before = len(rows)

            await page.mouse.wheel(0, 800)
            await asyncio.sleep(2.5)

            if len(rows) == before:
                await page.evaluate("""
                () => {
                    let inner = document.querySelector('[class*="DivCommentListContainer"]');
                    if (!inner) return;
                    let el = inner.parentElement;
                    while (el && el !== document.body) {
                        let st = window.getComputedStyle(el);
                        if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
                            el.dispatchEvent(new WheelEvent('wheel', {deltaY: 800, bubbles: true, cancelable: true}));
                            return;
                        }
                        el = el.parentElement;
                    }
                }
                """)
                await asyncio.sleep(1.5)

            if len(rows) == before:
                no_new += 1
                print(f"  [~] Không có comment mới ({no_new}/15), tiếp tục scroll...")
            else:
                no_new = 0
                print(f"  [+] Tổng: {len(rows)} comments")

        print(f"\n[*] Xong scroll — tổng {len(rows)} comments")
        await browser.close()

    return rows


async def main(url: str, out_csv: str):
    username, video_id = _parse_link(url)
    print(f"[*] Video: @{username} / {video_id}")

    rows = await scrape_comments(url)

    if not rows:
        print("[!] Không lấy được comment nào. Có thể TikTok chặn hoặc video private.")
        return

    # Ghi CSV
    with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"✓ Đã ghi {len(rows)} comments → {out_csv}")

    if rows:
        print("\n--- RAW JSON (comment đầu tiên từ API) ---")
        print(json.dumps(rows[0], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else LINK_VIDEO
    out = sys.argv[2] if len(sys.argv) > 2 else OUT_CSV
    asyncio.run(main(url, out))
