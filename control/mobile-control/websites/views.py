import csv
import io
import logging
import re
from datetime import datetime

import requests as http_requests
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from users.authentication import VersionedJWTAuthentication as JWTAuthentication

from api_keys.authentication import ApiKeyAuthentication

from . import wordpress
from .models import Website, WebsitePost, WebsitePostStatus, WordPressStatus
from .serializers import WebsitePostSerializer, WebsiteSerializer

logger = logging.getLogger(__name__)

_SHEET_ID_RE = re.compile(r'/spreadsheets/d/([a-zA-Z0-9_-]+)')
_GID_RE = re.compile(r'[#&?]gid=([0-9]+)')


def _publish_website_post(post: WebsitePost, *, override_wp_status: str | None = None) -> None:
    """Push *post* to its website (WordPress). Uploads the image as the featured
    media, sends excerpt/slug/categories/tags. ``override_wp_status`` forces the
    WP state (publish|draft) — used by "Đăng ngay" to publish live regardless of
    the saved draft setting. Updates the post's status + wp fields. Raises
    :class:`wordpress.WordPressError`."""
    wp_status = (override_wp_status or post.wp_status or 'publish')
    try:
        # Prefer an already-uploaded media id (local upload); else download URL.
        featured_media = post.featured_media_id or None
        if not featured_media and post.image_url:
            featured_media = wordpress.upload_media(post.website, post.image_url)
        result = wordpress.create_post(
            post.website,
            title=post.title,
            content=post.content,
            status=wp_status,
            excerpt=post.excerpt,
            slug=post.slug,
            categories=post.categories or None,
            tags=post.tags or None,
            featured_media=featured_media,
        )
    except wordpress.WordPressError as exc:
        post.status = WebsitePostStatus.FAILED
        post.error_msg = str(exc)[:500]
        post.save(update_fields=['status', 'error_msg', 'updated_at'])
        raise
    post.wp_post_id = result['wp_post_id']
    post.post_url = result['post_url']
    post.status = WebsitePostStatus.PUBLISHED
    post.wp_status = wp_status
    post.error_msg = ''
    post.save(update_fields=['wp_post_id', 'post_url', 'status', 'wp_status', 'error_msg', 'updated_at'])


def _google_sheet_url_to_csv_url(url: str) -> str | None:
    """Convert a Google Sheets share URL to its CSV export endpoint (public sheet)."""
    m = _SHEET_ID_RE.search(url or '')
    if not m:
        return None
    sheet_id = m.group(1)
    gid_m = _GID_RE.search(url or '')
    gid = gid_m.group(1) if gid_m else '0'
    return f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'


# Column aliases for the importer (lowercased).
_COL_TITLE = {'title', 'tiêu đề', 'tieu de', 'tựa đề', 'chủ đề', 'chu de', 'topic'}
_COL_CONTENT = {'content', 'nội dung', 'noi dung', 'body'}
# Featured image (thumbnail) vs image embedded inside the article body. Both may
# be a public link OR a Google Drive file/folder URL (resolved like the FB import).
_COL_THUMBNAIL = {
    'thumbnail', 'thumbnails', 'image_url', 'image', 'ảnh', 'anh',
    'ảnh đại diện', 'anh dai dien', 'ảnh bìa', 'anh bia', 'featured', 'hình', 'hinh',
}
_COL_BODY_IMAGE = {
    'ảnh trong bài', 'anh trong bai', 'ảnh bài viết', 'anh bai viet',
    'ảnh nội dung', 'anh noi dung', 'body_image', 'content_image', 'ảnh bài', 'anh bai',
}
_COL_SCHEDULED = {
    'scheduled_at', 'scheduled at', 'lịch đăng', 'lich dang', 'thời gian', 'thoi gian',
    'ngày', 'ngay', 'ngày đăng', 'ngay dang', 'ngày giờ', 'ngay gio',
}
_COL_WPSTATUS = {'wp_status', 'status', 'trạng thái', 'trang thai'}
_COL_EXCERPT = {'excerpt', 'mô tả', 'mo ta', 'mô tả ngắn', 'mo ta ngan', 'tóm tắt', 'tom tat'}
_COL_SLUG = {'slug', 'đường dẫn', 'duong dan', 'url'}
_COL_CATEGORIES = {'categories', 'category', 'danh mục', 'danh muc', 'chuyên mục', 'chuyen muc'}
_COL_TAGS = {'tags', 'tag', 'thẻ', 'the'}


def _split_names(value: str) -> list[str]:
    """Split a 'a, b; c' cell into clean names."""
    import re as _re
    return [s.strip() for s in _re.split(r'[,;]', value or '') if s.strip()]


_HTML_TAG_RE = re.compile(
    r'<(h[1-6]|p|ul|ol|li|strong|em|b|i|br|figure|img|div|span|a|blockquote)\b',
    re.IGNORECASE,
)


def _content_to_html(text: str) -> str:
    """Convert a plain-text / markdown-lite content cell into HTML.

    Regular users type normal text (not HTML tags), so the importer renders it:
      - blank line                 → paragraph break
      - ``# x`` / ``## x``         → <h2> / <h3>
      - ``- x`` / ``* x`` lines    → <ul><li>
      - ``**bold**`` / ``*italic*``→ <strong> / <em>
      - single newline in a block  → <br>
    If the cell already contains HTML tags it is returned unchanged.
    """
    import html as _html
    s = (text or '').strip()
    if not s:
        return ''
    if _HTML_TAG_RE.search(s):
        return s  # already HTML — keep as-is

    def _inline(t: str) -> str:
        t = _html.escape(t)
        t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
        t = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', t)
        return t

    out: list[str] = []
    for block in re.split(r'\n\s*\n', s):
        lines = [ln.strip() for ln in block.split('\n') if ln.strip()]
        if not lines:
            continue
        if all(re.match(r'^[-*]\s+', ln) for ln in lines):
            items = ''
            for ln in lines:
                item = re.sub(r'^[-*]\s+', '', ln)
                items += f'<li>{_inline(item)}</li>'
            out.append(f'<ul>{items}</ul>')
            continue
        if len(lines) == 1:
            m = re.match(r'^(#{1,6})\s+(.*)$', lines[0])
            if m:
                level = 2 if len(m.group(1)) == 1 else 3
                out.append(f'<h{level}>{_inline(m.group(2))}</h{level}>')
                continue
        out.append('<p>' + '<br>'.join(_inline(ln) for ln in lines) + '</p>')
    return ''.join(out)


def _pick(row: dict, aliases: set) -> str:
    for k, v in row.items():
        if k and k.strip().lower() in aliases:
            return (v or '').strip()
    return ''


def _parse_dt(val):
    """Best-effort parse of a scheduled_at value (ISO or common VN formats)."""
    if not val:
        return None
    if hasattr(val, 'isoformat'):
        return val
    s = str(val).strip()
    if not s:
        return None
    dt = parse_datetime(s)
    if dt is None:
        for fmt in ('%d/%m/%Y %H:%M', '%d/%m/%Y', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
    if dt is not None and timezone.is_naive(dt):
        dt = timezone.make_aware(dt)
    return dt


# ─── Image resolution (Google Drive / public URL → WordPress media) ──────────
# Reuse the Facebook importer's battle-tested Drive resolver + robust downloader
# (handles /file/d/, /drive/folders/, the usercontent confirm token and magic-byte
# sniffing) so the website importer accepts the exact same media cells. Imports
# are lazy to avoid app-loading order issues.

def _download_media_bytes(url: str) -> tuple[bytes, str, str]:
    """Download an image from *url* (public or resolved Drive link). Returns
    ``(body_bytes, content_type, filename)``. Raises ``ValueError`` on a non-image
    payload (HTML share page, etc.)."""
    import os as _os
    from urllib.parse import urlparse

    from facebook import s3_utils  # noqa: PLC0415 — lazy, reuse robust primitives

    session = http_requests.Session()
    session.headers['User-Agent'] = (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    )
    max_bytes = int(getattr(settings, 'FB_MEDIA_MAX_BYTES', 500 * 1024 * 1024))
    try:
        resp = session.get(url, timeout=120, stream=True)
        resp.raise_for_status()
        body, content_type = s3_utils._read_response_with_limit(resp, max_bytes)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f'Không tải được ảnh từ {url}: {exc}') from exc

    if not s3_utils._looks_like_media(body[:16]):
        raise ValueError(
            f'URL {url} không trả về file ảnh hợp lệ (có thể là trang share/preview '
            'thay vì link tải trực tiếp).'
        )
    ext = s3_utils._CONTENT_TYPE_TO_EXT.get((content_type or '').lower())
    if ext is None:
        ext = s3_utils._ext_from_magic(body[:16]) or '.jpg'
    path_name = _os.path.basename(urlparse(url).path) or 'image'
    base = _os.path.splitext(path_name)[0] or 'image'
    return body, (content_type or 'image/jpeg'), f'{base}{ext}'


def _resolve_media_to_wp(website, raw_cell: str) -> list[dict]:
    """Resolve a media cell (public URL / Drive file / Drive folder, newline- or
    comma-separated) to a list of WordPress media ``{'id', 'source_url'}`` dicts.
    Each source is downloaded then uploaded to the site's media library so the
    final URL is stable and WP-served. Raises ``ValueError`` on the first failure."""
    raw = (raw_cell or '').strip()
    if not raw:
        return []
    from facebook.views import _expand_media_url_for_import  # noqa: PLC0415 — lazy

    src_urls = _expand_media_url_for_import(raw)
    out: list[dict] = []
    for src in src_urls:
        body, content_type, filename = _download_media_bytes(src)
        media = wordpress.upload_media_file(
            website, filename=filename, content=body, content_type=content_type,
        )
        if media.get('source_url'):
            out.append(media)
    return out


_BLOCK_END_RE = re.compile(r'</(?:p|h2|h3|ul|ol|blockquote)>', re.IGNORECASE)


def _embed_images_in_html(html: str, image_urls: list[str]) -> str:
    """Distribute ``<figure>`` image blocks EVENLY through the article instead of
    dumping them all at the top: each image is placed after a block element spread
    across the document (image i → block ≈ (i+1)/(n+1) of the way down). Falls
    back to appending at the end when the content has no block elements."""
    html = html or ''
    if not image_urls:
        return html

    def _fig(u: str) -> str:
        return f'<figure class="wp-block-image size-large"><img src="{u}" alt=""/></figure>'

    ends = [m.end() for m in _BLOCK_END_RE.finditer(html)]
    if not ends:
        return html + ''.join(_fig(u) for u in image_urls)

    n, m = len(image_urls), len(ends)
    placements: list[tuple[int, str]] = []
    for i, u in enumerate(image_urls):
        bi = max(0, min(round((i + 1) * m / (n + 1)) - 1, m - 1))
        placements.append((ends[bi], _fig(u)))
    # Insert right-to-left so earlier character offsets stay valid.
    for pos, fig in sorted(placements, key=lambda x: x[0], reverse=True):
        html = html[:pos] + fig + html[pos:]
    return html


# ─── AI content generation (shared by ai_generate / import / regenerate) ─────

def _ai_write_single(website, *, topic: str, brief: str = '') -> dict:
    """Generate ONE blog post from *topic* (and an optional *brief*) via OpenAI.

    Returns ``{'title', 'content', 'excerpt', 'slug', 'categories'(names),
    'tags'(names)}`` where content is sanitised HTML. Raises ``ValueError`` /
    surfaces the OpenAI error so callers can report it. The AI may only pick
    categories/tags from the website's existing taxonomy terms."""
    import html as _html
    import json as _json

    api_key = getattr(settings, 'OPENAI_API_KEY', '') or ''
    if not api_key:
        raise ValueError('Chưa cấu hình OPENAI_API_KEY trên server.')

    try:
        cats = wordpress.list_terms(website, 'categories')
        tags = wordpress.list_terms(website, 'tags')
    except wordpress.WordPressError:
        cats, tags = [], []
    cat_names = [t['name'] for t in cats if t.get('name')]
    tag_names = [t['name'] for t in tags if t.get('name')]

    system_prompt = (
        'Bạn là biên tập viên nội dung web. Người dùng cho một CHỦ ĐỀ. Viết MỘT bài đăng blog '
        'bằng tiếng Việt, tự nhiên, hữu ích. Trả về DUY NHẤT một JSON object: '
        '{"title", "content", "excerpt", "slug", "categories", "tags"}. '
        'Trong đó: content là HTML hợp lệ dùng <h2>,<h3>,<p>,<strong>,<em>,<ul><li> '
        '(KHÔNG có <html>/<body>/<script>); excerpt là 1-2 câu tóm tắt; slug là chữ thường '
        'không dấu nối bằng dấu gạch ngang; categories và tags là MẢNG, CHỈ được chọn từ '
        'danh sách cho sẵn (có thể để rỗng nếu không phù hợp). Không thêm chữ nào ngoài JSON.'
    )
    user_prompt = (
        f'Chủ đề: {topic}\n'
        + (f'Yêu cầu thêm: {brief}\n' if brief else '')
        + f'Danh mục có sẵn (chỉ chọn trong đây): {cat_names or "(không có)"}\n'
        f'Thẻ có sẵn (chỉ chọn trong đây): {tag_names or "(không có)"}'
    )
    llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', 'gpt-4o-mini') or 'gpt-4o-mini'
    from openai import OpenAI  # noqa: PLC0415 — lazy
    client = OpenAI(api_key=api_key)
    completion = client.chat.completions.create(
        model=llm_model,
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_prompt},
        ],
        temperature=0.8,
        response_format={'type': 'json_object'},
    )
    raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
    data = _json.loads(raw)
    if not isinstance(data, dict) or not (data.get('title') or topic):
        raise ValueError('AI trả về dữ liệu rỗng.')
    return {
        'title': (data.get('title') or topic or '').strip(),
        'content': _content_to_html(data.get('content') or ''),
        'excerpt': (data.get('excerpt') or '').strip(),
        'slug': (data.get('slug') or '').strip(),
        'categories': data.get('categories') or [],
        'tags': data.get('tags') or [],
        '_cat_map': {_html.unescape(t['name']).strip().lower(): t['id'] for t in cats if t.get('name')},
        '_tag_map': {_html.unescape(t['name']).strip().lower(): t['id'] for t in tags if t.get('name')},
    }


class WebsiteViewSet(viewsets.ModelViewSet):
    """CRUD websites + test-connection."""

    serializer_class = WebsiteSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get_queryset(self):
        return Website.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=True, methods=['post'], url_path='test-connection')
    def test_connection(self, request, pk=None):
        website = self.get_object()
        try:
            user = wordpress.test_connection(website)
        except wordpress.WordPressError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'detail': 'Kết nối thành công.', 'wp_user': user.get('name') or user.get('slug') or ''})

    @action(detail=True, methods=['post'], url_path='upload-media')
    def upload_media(self, request, pk=None):
        """Upload a local image file straight to the site's media library.
        Returns ``{id, source_url}`` — the id is stored as the post's
        featured_media_id, source_url is shown as a preview."""
        website = self.get_object()
        f = request.FILES.get('file')
        if not f:
            return Response({'detail': 'Thiếu file ảnh.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = wordpress.upload_media_file(
                website, filename=f.name, content=f.read(), content_type=f.content_type or 'image/jpeg',
            )
        except wordpress.WordPressError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(result)

    @action(detail=True, methods=['get'], url_path='media')
    def media(self, request, pk=None):
        """Return images from the site's media library ([{id, source_url, thumb,
        title}]) so the editor can pick existing images. ``?search=`` filters."""
        website = self.get_object()
        search = (request.query_params.get('search') or '').strip()
        try:
            items = wordpress.list_media(website, search=search)
        except wordpress.WordPressError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'media': items})

    @action(detail=True, methods=['get'], url_path='taxonomies')
    def taxonomies(self, request, pk=None):
        """Return the site's categories + tags ([{id, name}]) for the post editor."""
        website = self.get_object()
        try:
            cats = wordpress.list_terms(website, 'categories')
            tags = wordpress.list_terms(website, 'tags')
        except wordpress.WordPressError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'categories': cats, 'tags': tags})


class WebsitePostViewSet(viewsets.ModelViewSet):
    """CRUD website posts + publish-now + bulk import (sheet / manual rows)."""

    serializer_class = WebsitePostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get_queryset(self):
        qs = WebsitePost.objects.filter(owner=self.request.user).select_related('website')
        website_id = self.request.query_params.get('website')
        if website_id:
            qs = qs.filter(website_id=website_id)
        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=True, methods=['post'], url_path='publish-now')
    def publish_now(self, request, pk=None):
        post = self.get_object()
        if post.status == WebsitePostStatus.PUBLISHED:
            return Response({'detail': 'Bài này đã đăng rồi.'}, status=status.HTTP_400_BAD_REQUEST)
        if not (post.title or '').strip():
            return Response({'detail': 'Bài chưa có tiêu đề.'}, status=status.HTTP_400_BAD_REQUEST)
        # "Đăng ngay" publishes LIVE by default; pass wp_status='draft' to push a draft.
        desired = (request.data.get('wp_status') or 'publish').strip().lower()
        if desired not in ('publish', 'draft'):
            desired = 'publish'
        try:
            _publish_website_post(post, override_wp_status=desired)
        except wordpress.WordPressError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(self.get_serializer(post).data)

    @action(detail=False, methods=['post'], url_path='import')
    def import_posts(self, request):
        """Bulk-create posts (status pending). Body:
          - ``website`` (required)
          - either ``sheet_url`` (public Google Sheet → CSV) OR ``posts`` (list of
            {title, content, thumbnail, body_image, scheduled_at, wp_status}).
          - ``wp_status`` (optional default for all rows, publish|draft).
          - ``use_ai`` (optional bool): when true, AI writes the article from the
            row's topic/title (+ content as brief) and embeds the body image.

        Image cells (``thumbnail`` = featured, ``body_image`` = in-article) accept
        public links or Google Drive file/folder URLs; each is downloaded and
        re-uploaded to the site's media library so the stored URL is WP-served.
        """
        website_id = request.data.get('website')
        try:
            website = Website.objects.get(id=website_id, owner=request.user)
        except (Website.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Website không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)

        default_wp_status = (request.data.get('wp_status') or WordPressStatus.PUBLISH).strip().lower()
        if default_wp_status not in ('publish', 'draft'):
            default_wp_status = WordPressStatus.PUBLISH
        use_ai = bool(request.data.get('use_ai'))

        rows: list[dict] = []
        sheet_url = (request.data.get('sheet_url') or '').strip()
        if sheet_url:
            csv_url = _google_sheet_url_to_csv_url(sheet_url)
            if not csv_url:
                return Response({'detail': 'URL Google Sheet không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)
            try:
                resp = http_requests.get(csv_url, timeout=30)
                resp.raise_for_status()
            except http_requests.RequestException as exc:
                return Response({'detail': f'Không đọc được Google Sheet (sheet phải share "Anyone with the link"): {exc}'}, status=status.HTTP_400_BAD_REQUEST)
            reader = csv.DictReader(io.StringIO(resp.content.decode('utf-8-sig', errors='replace')))
            for r in reader:
                rows.append({
                    'title': _pick(r, _COL_TITLE),
                    'content': _pick(r, _COL_CONTENT),
                    'excerpt': _pick(r, _COL_EXCERPT),
                    'slug': _pick(r, _COL_SLUG),
                    'thumbnail': _pick(r, _COL_THUMBNAIL),
                    'body_image': _pick(r, _COL_BODY_IMAGE),
                    'scheduled_at': _pick(r, _COL_SCHEDULED),
                    'wp_status': _pick(r, _COL_WPSTATUS),
                    'categories': _pick(r, _COL_CATEGORIES),
                    'tags': _pick(r, _COL_TAGS),
                })
        else:
            posts = request.data.get('posts') or []
            if not isinstance(posts, list):
                return Response({'detail': 'posts phải là danh sách.'}, status=status.HTTP_400_BAD_REQUEST)
            rows = posts

        # Resolve category/tag NAMES → term IDs (sheets use names). Fetched once.
        needs_terms = any((r.get('categories') or r.get('tags')) for r in rows)
        cat_map, tag_map = {}, {}
        if needs_terms or use_ai:
            import html as _html
            try:
                cat_map = {_html.unescape(t['name']).strip().lower(): t['id'] for t in wordpress.list_terms(website, 'categories') if t.get('name')}
                tag_map = {_html.unescape(t['name']).strip().lower(): t['id'] for t in wordpress.list_terms(website, 'tags') if t.get('name')}
            except wordpress.WordPressError:
                pass  # best-effort; unknown terms simply skipped

        def _term_ids(value, name_map):
            if isinstance(value, list):
                return [int(x) for x in value if str(x).strip()]
            return [name_map[n.lower()] for n in _split_names(value) if n.lower() in name_map]

        created, skipped, row_errors = [], 0, []
        for i, r in enumerate(rows, start=1):
            title = (r.get('title') or '').strip()
            if not title:
                skipped += 1
                continue
            wp_status = (r.get('wp_status') or '').strip().lower()
            if wp_status not in ('publish', 'draft'):
                wp_status = default_wp_status
            if use_ai:
                wp_status = 'draft'  # AI-written posts always land as draft for review

            # Resolve thumbnail → featured. All sheet images (thumbnail + in-article
            # cell, Drive folders expanded) are uploaded to WP media and stored on
            # the post as ``source_images`` — shown as a tray in the editor for the
            # user to pick & place; we no longer auto-embed them into the content.
            thumb_cell = r.get('thumbnail') or r.get('image_url') or ''
            body_cell = r.get('body_image') or ''
            featured_id, featured_url = None, ''
            source_imgs: list[str] = []
            try:
                thumb_media = _resolve_media_to_wp(website, thumb_cell)
                if thumb_media:
                    featured_id = thumb_media[0].get('id')
                    featured_url = thumb_media[0].get('source_url') or ''
                    source_imgs.extend(m['source_url'] for m in thumb_media if m.get('source_url'))
                source_imgs.extend(m['source_url'] for m in _resolve_media_to_wp(website, body_cell) if m.get('source_url'))
            except (ValueError, wordpress.WordPressError) as exc:
                row_errors.append({'row': i, 'error': str(exc)})
            source_imgs = list(dict.fromkeys(source_imgs))  # dedup, keep order

            # Build content: AI from topic, else the cell text → HTML.
            categories = _term_ids(r.get('categories'), cat_map)
            tags = _term_ids(r.get('tags'), tag_map)
            excerpt = (r.get('excerpt') or '').strip()
            slug = (r.get('slug') or '').strip()
            content = _content_to_html(r.get('content') or '')
            if use_ai:
                try:
                    ai = _ai_write_single(website, topic=title, brief=(r.get('content') or '').strip())
                    content = ai['content'] or content
                    excerpt = excerpt or ai['excerpt']
                    slug = slug or ai['slug']
                    if not categories:
                        categories = [ai['_cat_map'][n.strip().lower()] for n in ai['categories'] if isinstance(n, str) and n.strip().lower() in ai['_cat_map']]
                    if not tags:
                        tags = [ai['_tag_map'][n.strip().lower()] for n in ai['tags'] if isinstance(n, str) and n.strip().lower() in ai['_tag_map']]
                except Exception as exc:  # noqa: BLE001 — fall back to cell content
                    row_errors.append({'row': i, 'error': f'AI tạo nội dung lỗi: {exc}'})

            created.append(WebsitePost(
                website=website,
                title=title[:500],
                content=content,
                excerpt=excerpt[:1000],
                slug=slug[:255],
                image_url=featured_url[:2048],
                featured_media_id=featured_id,
                categories=categories,
                tags=tags,
                source_images=source_imgs,
                wp_status=wp_status,
                scheduled_at=_parse_dt(r.get('scheduled_at')),
                status=WebsitePostStatus.PENDING,
                owner=request.user,
            ))
        if not created:
            return Response(
                {'detail': 'Không có dòng hợp lệ (thiếu tiêu đề).', 'skipped': skipped, 'errors': row_errors},
                status=status.HTTP_400_BAD_REQUEST,
            )
        WebsitePost.objects.bulk_create(created)
        return Response(
            {'created': len(created), 'skipped': skipped, 'errors': row_errors},
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'], url_path='regenerate')
    def regenerate(self, request, pk=None):
        """Re-generate the article content for a PENDING/FAILED post with AI.

        Body (all optional): ``{topic, brief, keep_images}``. Defaults to the
        post's own title as the topic. Existing embedded body images are
        preserved (re-inserted) unless ``keep_images`` is false. Returns the
        updated post."""
        post = self.get_object()
        if post.status == WebsitePostStatus.PUBLISHED:
            return Response({'detail': 'Bài đã đăng — không tạo lại nội dung.'}, status=status.HTTP_400_BAD_REQUEST)
        topic = (request.data.get('topic') or post.title or '').strip()
        if not topic:
            return Response({'detail': 'Bài chưa có tiêu đề/chủ đề để tạo lại.'}, status=status.HTTP_400_BAD_REQUEST)
        brief = (request.data.get('brief') or '').strip()
        keep_images = request.data.get('keep_images', True)
        try:
            ai = _ai_write_single(post.website, topic=topic, brief=brief)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            logger.exception('website regenerate error: %s', exc)
            return Response({'detail': f'Tạo lại nội dung thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)

        content = ai['content']
        if keep_images:
            old_imgs = re.findall(r'<img[^>]+src="([^"]+)"', post.content or '')
            content = _embed_images_in_html(content, old_imgs)
        post.content = content
        if ai['excerpt']:
            post.excerpt = ai['excerpt'][:1000]
        post.save(update_fields=['content', 'excerpt', 'updated_at'])
        return Response(self.get_serializer(post).data)

    @action(detail=False, methods=['post'], url_path='ai-generate')
    def ai_generate(self, request):
        """Generate draft posts from a topic with OpenAI.

        Body: ``{website, topic, count?, wp_status?}``. The AI is given the
        website's EXISTING WordPress categories/tags and must pick only from
        them. Each post is created as a PENDING WebsitePost (HTML content) for
        the user to review/edit then publish — same downstream flow as import.
        """
        import html as _html
        import json as _json

        website_id = request.data.get('website')
        try:
            website = Website.objects.get(id=website_id, owner=request.user)
        except (Website.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Website không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)

        topic = (request.data.get('topic') or '').strip()
        if not topic:
            return Response({'detail': 'Hãy nhập chủ đề.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(topic) > 500:
            topic = topic[:500]
        try:
            count = int(request.data.get('count') or 1)
        except (ValueError, TypeError):
            count = 1
        count = max(1, min(count, 5))

        wp_status = 'draft'  # AI-written posts are always saved as draft for review

        api_key = getattr(settings, 'OPENAI_API_KEY', '') or ''
        if not api_key:
            return Response({'detail': 'Chưa cấu hình OPENAI_API_KEY trên server.'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        # Existing terms — fetched once; AI must pick only from these names.
        try:
            cats = wordpress.list_terms(website, 'categories')
            tags = wordpress.list_terms(website, 'tags')
        except wordpress.WordPressError:
            cats, tags = [], []
        cat_names = [t['name'] for t in cats if t.get('name')]
        tag_names = [t['name'] for t in tags if t.get('name')]
        cat_map = {_html.unescape(t['name']).strip().lower(): t['id'] for t in cats if t.get('name')}
        tag_map = {_html.unescape(t['name']).strip().lower(): t['id'] for t in tags if t.get('name')}

        system_prompt = (
            'Bạn là biên tập viên nội dung web. Người dùng cho một CHỦ ĐỀ. Viết bài đăng blog '
            'bằng tiếng Việt, tự nhiên, hữu ích. Trả về DUY NHẤT một JSON object: '
            '{"posts": [{"title", "content", "excerpt", "slug", "categories", "tags"}]}. '
            'Trong đó: content là HTML hợp lệ dùng <h2>,<h3>,<p>,<strong>,<em>,<ul><li> '
            '(KHÔNG có <html>/<body>/<script>); excerpt là 1-2 câu tóm tắt; slug là chữ thường '
            'không dấu nối bằng dấu gạch ngang; categories và tags là MẢNG, CHỈ được chọn từ '
            'danh sách cho sẵn (có thể để rỗng nếu không phù hợp). Không thêm chữ nào ngoài JSON.'
        )
        user_prompt = (
            f'Chủ đề: {topic}\n'
            f'Số bài cần viết: {count}\n'
            f'Danh mục có sẵn (chỉ chọn trong đây): {cat_names or "(không có)"}\n'
            f'Thẻ có sẵn (chỉ chọn trong đây): {tag_names or "(không có)"}'
        )
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', 'gpt-4o-mini') or 'gpt-4o-mini'
        try:
            from openai import OpenAI  # noqa: PLC0415 — lazy
            client = OpenAI(api_key=api_key)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': user_prompt},
                ],
                temperature=0.8,
                response_format={'type': 'json_object'},
            )
            raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            data = _json.loads(raw)
            posts = data.get('posts') if isinstance(data, dict) else None
            if not isinstance(posts, list) or not posts:
                raise ValueError('AI trả về danh sách rỗng')
        except Exception as exc:  # noqa: BLE001 — surface a clean 502
            logger.exception('website ai_generate error: %s', exc)
            return Response({'detail': f'Tạo nội dung bằng AI thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)

        def _ids(value, name_map):
            names = value if isinstance(value, list) else _split_names(value or '')
            return [name_map[n.strip().lower()] for n in names if isinstance(n, str) and n.strip().lower() in name_map]

        created = []
        for p in posts[:count]:
            if not isinstance(p, dict):
                continue
            title = (p.get('title') or '').strip()
            if not title:
                continue
            created.append(WebsitePost(
                website=website,
                title=title[:500],
                content=_content_to_html(p.get('content') or ''),
                excerpt=(p.get('excerpt') or '')[:1000],
                slug=(p.get('slug') or '')[:255],
                image_url='',
                categories=_ids(p.get('categories'), cat_map),
                tags=_ids(p.get('tags'), tag_map),
                wp_status=wp_status,
                scheduled_at=None,
                status=WebsitePostStatus.PENDING,
                owner=request.user,
            ))
        if not created:
            return Response({'detail': 'AI không tạo được bài hợp lệ.'}, status=status.HTTP_502_BAD_GATEWAY)
        WebsitePost.objects.bulk_create(created)
        return Response({'created': len(created)}, status=status.HTTP_201_CREATED)
