"""Thin WordPress REST client.

Auth = HTTP Basic with (username, Application Password). The site must have the
WP REST API enabled (default since WP 4.7) and Application Passwords available
(default since WP 5.6, over HTTPS).
"""
import logging

import requests

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30


class WordPressError(Exception):
    """User-facing WordPress integration error."""


def _api_base(website) -> str:
    """Build the WP REST base from the site URL, tolerating common mistakes:
    a pasted ``/wp-admin`` / ``/wp-login.php`` URL or an existing ``/wp-json``
    path — all normalised back to ``<root>/wp-json/wp/v2``."""
    base = (website.base_url or '').strip().rstrip('/')
    low = base.lower()
    if '/wp-json' in low:
        base = base[: low.index('/wp-json')]
        low = base.lower()
    for suffix in ('/wp-admin', '/wp-login.php'):
        if low.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.rstrip('/') + '/wp-json/wp/v2'


def _auth(website):
    return (website.wp_username, website.wp_app_password)


def _require_creds(website) -> None:
    if not website.wp_username or not website.wp_app_password:
        raise WordPressError('Website chưa cấu hình username / application password.')


def test_connection(website) -> dict:
    """Verify credentials via GET /users/me. Returns the WP user dict or raises."""
    _require_creds(website)
    url = f'{_api_base(website)}/users/me'
    try:
        resp = requests.get(url, auth=_auth(website), headers={'accept': 'application/json'}, timeout=DEFAULT_TIMEOUT)
    except requests.RequestException as exc:
        raise WordPressError(f'Không kết nối được tới website: {exc}') from exc
    if resp.status_code in (401, 403):
        raise WordPressError('Sai username/application password hoặc bị chặn REST (401/403).')
    if not resp.ok:
        raise WordPressError(f'WordPress trả lỗi HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        return resp.json()
    except ValueError:
        raise WordPressError('WordPress trả về dữ liệu không hợp lệ.')


def list_terms(website, taxonomy: str) -> list:
    """Fetch up to 100 terms of a taxonomy ('categories' | 'tags') as
    [{'id', 'name'}]. Raises :class:`WordPressError`."""
    if taxonomy not in ('categories', 'tags'):
        raise WordPressError('Taxonomy không hợp lệ.')
    url = f'{_api_base(website)}/{taxonomy}?per_page=100&orderby=name&order=asc'
    try:
        resp = requests.get(url, auth=_auth(website), headers={'accept': 'application/json'}, timeout=DEFAULT_TIMEOUT)
    except requests.RequestException as exc:
        raise WordPressError(f'Không tải được {taxonomy}: {exc}') from exc
    if not resp.ok:
        raise WordPressError(f'WordPress lỗi HTTP {resp.status_code} khi tải {taxonomy}.')
    try:
        return [{'id': t.get('id'), 'name': t.get('name')} for t in resp.json()]
    except ValueError:
        raise WordPressError('WordPress trả về dữ liệu không hợp lệ.')


def list_media(website, *, search: str = '', page: int = 1, per_page: int = 40) -> list:
    """Fetch images from the site's media library as
    [{'id', 'source_url', 'thumb', 'title'}], newest first. ``search`` filters by
    filename/title. Raises :class:`WordPressError`."""
    _require_creds(website)
    from urllib.parse import quote
    params = f'?media_type=image&per_page={int(per_page)}&page={int(page)}&orderby=date&order=desc'
    if search:
        params += f'&search={quote(search)}'
    url = f'{_api_base(website)}/media{params}'
    try:
        resp = requests.get(url, auth=_auth(website), headers={'accept': 'application/json'}, timeout=DEFAULT_TIMEOUT)
    except requests.RequestException as exc:
        raise WordPressError(f'Không tải được thư viện ảnh: {exc}') from exc
    if not resp.ok:
        raise WordPressError(f'WordPress lỗi HTTP {resp.status_code} khi tải thư viện ảnh.')
    try:
        out = []
        for m in resp.json():
            details = m.get('media_details') or {}
            sizes = details.get('sizes') or {}
            thumb = (
                (sizes.get('thumbnail') or {}).get('source_url')
                or (sizes.get('medium') or {}).get('source_url')
                or m.get('source_url') or ''
            )
            out.append({
                'id': m.get('id'),
                'source_url': m.get('source_url') or '',
                'thumb': thumb,
                'title': (m.get('title') or {}).get('rendered') or '',
            })
        return out
    except ValueError:
        raise WordPressError('WordPress trả về dữ liệu thư viện ảnh không hợp lệ.')


def upload_media_file(website, *, filename: str, content: bytes, content_type: str = 'image/jpeg') -> dict:
    """Upload raw image bytes to the site's media library. Returns
    ``{'id', 'source_url'}``. Raises :class:`WordPressError`."""
    _require_creds(website)
    url = f'{_api_base(website)}/media'
    headers = {
        'Content-Disposition': f'attachment; filename="{filename or "image.jpg"}"',
        'Content-Type': content_type or 'application/octet-stream',
    }
    try:
        resp = requests.post(url, auth=_auth(website), headers=headers, data=content, timeout=60)
    except requests.RequestException as exc:
        raise WordPressError(f'Upload ảnh thất bại: {exc}') from exc
    if not resp.ok:
        raise WordPressError(f'Upload ảnh lỗi HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        d = resp.json()
    except ValueError:
        raise WordPressError('Upload ảnh: phản hồi không hợp lệ.')
    return {'id': d.get('id'), 'source_url': d.get('source_url') or ''}


def upload_media(website, image_url: str) -> int | None:
    """Download *image_url* then upload it to the media library. Returns the new
    media ID (for featured_media), or None if image_url is empty."""
    image_url = (image_url or '').strip()
    if not image_url:
        return None
    try:
        img = requests.get(image_url, timeout=DEFAULT_TIMEOUT)
        img.raise_for_status()
    except requests.RequestException as exc:
        raise WordPressError(f'Không tải được ảnh đại diện: {exc}') from exc
    filename = (image_url.split('/')[-1].split('?')[0] or 'image.jpg')
    result = upload_media_file(
        website, filename=filename, content=img.content,
        content_type=img.headers.get('content-type', 'image/jpeg'),
    )
    return result.get('id')


def create_post(
    website, *, title: str, content: str = '', status: str = 'publish',
    excerpt: str = '', slug: str = '', categories=None, tags=None, featured_media=None,
) -> dict:
    """Create a post. ``status`` = 'publish' (live) or 'draft'. Optional excerpt,
    slug, categories/tags (term ID lists) and featured_media (media ID). Returns
    ``{'wp_post_id', 'post_url'}``. Raises :class:`WordPressError` on failure."""
    _require_creds(website)
    if status not in ('publish', 'draft'):
        status = 'publish'
    url = f'{_api_base(website)}/posts'
    body = {'title': title, 'content': content, 'status': status}
    if excerpt:
        body['excerpt'] = excerpt
    if slug:
        body['slug'] = slug
    if categories:
        body['categories'] = [int(c) for c in categories]
    if tags:
        body['tags'] = [int(t) for t in tags]
    if featured_media:
        body['featured_media'] = int(featured_media)
    try:
        resp = requests.post(url, auth=_auth(website), json=body, timeout=DEFAULT_TIMEOUT)
    except requests.RequestException as exc:
        raise WordPressError(f'Không kết nối được tới website: {exc}') from exc
    if resp.status_code in (401, 403):
        raise WordPressError('Sai username/application password hoặc không có quyền đăng (401/403).')
    if not resp.ok:
        raise WordPressError(f'WordPress trả lỗi HTTP {resp.status_code}: {resp.text[:300]}')
    try:
        data = resp.json()
    except ValueError:
        raise WordPressError('WordPress trả về dữ liệu không hợp lệ.')
    return {'wp_post_id': str(data.get('id') or ''), 'post_url': data.get('link') or ''}
