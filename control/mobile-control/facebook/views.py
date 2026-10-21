import json
import logging
import re
import threading
from functools import wraps
from datetime import datetime, time, timedelta, timezone as dt_timezone
from difflib import SequenceMatcher
from zoneinfo import ZoneInfo

import requests as http_requests
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import parsers, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.response import Response
from rest_framework.views import APIView
from users.authentication import VersionedJWTAuthentication as JWTAuthentication

from api_keys.authentication import ApiKeyAuthentication
from profiles.models import Profile
from schedule.models import Schedule, ScheduleType
from task.models import Task, TaskStatus, TaskType
from task.device_lock import device_is_busy, dispatch_or_queue

from .models import (
    FacebookCommentPlan,
    FacebookGroup,
    FacebookGroupPost,
    FacebookGroupPostSeedingAction,
    FacebookGroupScheduledPost,
    FacebookInteractionType,
    FacebookPage,
    FacebookPost,
    FacebookPostInteraction,
    FacebookPostStatus,
    FacebookPostUserComment,
    FacebookProfileScheduledPostUserComment,
    FacebookGroupPendingMemberPost,
    FacebookGroupPendingMemberPostStatus,
    FacebookProfile,
    FacebookProfileMediaActionType,
    FacebookProfilePost,
    FacebookProfilePostSeedingAction,
    FacebookProfileScheduledMediaAction,
    FacebookProfileScheduledPost,
    FacebookScheduledPost,
    FacebookScheduledPostCommentPlan,
    FacebookScheduledPostStatus,
    FacebookSeedingActionStatus,
    FacebookSeedingInteractionType,
    FbHackKey,
)
from .serializers import (
    FacebookCommentedInteractionSerializer,
    FacebookCommentPlanSerializer,
    FacebookGroupPostSerializer,
    FacebookGroupPostSeedingActionSerializer,
    FacebookGroupScheduledPostSerializer,
    FacebookGroupSerializer,
    FacebookPageSerializer,
    FacebookPostInteractionSerializer,
    FacebookPostSerializer,
    FacebookPostUserCommentSerializer,
    FacebookProfileScheduledPostUserCommentSerializer,
    FacebookGroupPendingMemberPostSerializer,
    FacebookProfilePostSerializer,
    FacebookProfilePostSeedingActionSerializer,
    FacebookProfileScheduledMediaActionSerializer,
    FacebookProfileScheduledPostSerializer,
    FacebookProfileSerializer,
    FacebookScheduledPostCommentPlanSerializer,
    FacebookScheduledPostSerializer,
    FbHackKeySerializer,
)
from .s3_utils import download_image_bytes_from_s3, get_presigned_image_url, upload_image_to_s3
from .seaweedfs_utils import get_seaweedfs_url, upload_to_seaweedfs

DIG_COMMENT_MAX_FETCH = 200
DIG_COMMENT_SIMILARITY_THRESHOLD = 0.98
# Presign lifetime for media handed to the phoneagent worker. Longer than the
# 1h display default because a scheduled post is presigned at dispatch time but
# the worker may only download it minutes–hours later (queue / device busy).
MEDIA_PRESIGN_EXPIRY_SECONDS = 6 * 3600

logger = logging.getLogger(__name__)
_LOCAL_TZ = ZoneInfo('Asia/Ho_Chi_Minh')


def _apply_local_date_filter(qs, field_name: str, date_from: str | None, date_to: str | None):
    """Filter `qs` by a local-timezone date range on the given datetime field.

    `date_from`/`date_to` are expected as ``YYYY-MM-DD``. Invalid values are
    silently ignored.
    """
    if date_from:
        try:
            d_from = datetime.strptime(date_from, '%Y-%m-%d').date()
        except ValueError:
            d_from = None
        if d_from is not None:
            start = datetime.combine(d_from, time.min, tzinfo=_LOCAL_TZ)
            qs = qs.filter(**{f'{field_name}__gte': start})
    if date_to:
        try:
            d_to = datetime.strptime(date_to, '%Y-%m-%d').date()
        except ValueError:
            d_to = None
        if d_to is not None:
            end_exclusive = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=_LOCAL_TZ)
            qs = qs.filter(**{f'{field_name}__lt': end_exclusive})
    return qs


def _sync_approved_comment_plan(post: FacebookPost, interaction: FacebookPostInteraction, owner):
    """Mark the matching comment plan as commented once an interaction is recorded.

    Mirrors the TikTok behaviour: match by comment content (exact, then trimmed,
    then case-insensitive), falling back to any uncommented plan on the post.
    """
    if interaction.interaction_type not in {FacebookInteractionType.COMMENT, FacebookInteractionType.REPLY}:
        return

    plan_owner = post.owner or owner
    plan_qs = FacebookCommentPlan.objects.filter(post=post, owner=plan_owner, is_commented=False)

    plan = None
    raw_content = interaction.comment_content or ''
    normalized = raw_content.strip()
    if raw_content:
        plan = plan_qs.filter(comment_content=raw_content).order_by('-is_approved', '-created_at').first()
    if not plan and normalized:
        plan = plan_qs.filter(comment_content=normalized).order_by('-is_approved', '-created_at').first()
        if not plan:
            plan = plan_qs.filter(comment_content__iexact=normalized).order_by('-is_approved', '-created_at').first()
    if not plan:
        plan = plan_qs.order_by('-is_approved', '-created_at').first()
    if not plan:
        return

    plan.is_commented = True
    update_fields = ['is_commented']
    if interaction.comment_link and plan.comment_link != interaction.comment_link:
        plan.comment_link = interaction.comment_link
        update_fields.append('comment_link')
    update_fields.append('updated_at')
    plan.save(update_fields=update_fields)


class FacebookCommentApiError(Exception):
    """Raised when the external Facebook comment crawler call fails."""


def _call_facebook_comment_api(post_url: str, max_comments: int, include_replies: bool, num_sessions: int) -> list:
    """Call the external Facebook comment-scraping service and return the raw
    ``comments`` list. Raises ``FacebookCommentApiError`` on failure.

    The crawler service is built separately; configure FACEBOOK_COMMENT_API_URL
    to point at it. Mirrors the TikTok crawler request/response contract.
    """
    api_url = getattr(settings, 'FACEBOOK_COMMENT_API_URL', '')
    timeout = getattr(settings, 'FACEBOOK_COMMENT_TIMEOUT_SECONDS', 120)
    if not api_url:
        raise FacebookCommentApiError('FACEBOOK_COMMENT_API_URL is not configured.')
    endpoint = f'{api_url.rstrip("/")}/comments'
    try:
        resp = http_requests.post(
            endpoint,
            json={
                'url': post_url,
                'max_comments': max_comments,
                'include_replies': include_replies,
                'num_sessions': num_sessions,
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except (http_requests.exceptions.RequestException, ValueError) as exc:
        logger.exception('facebook comment crawler error: %s', exc)
        raise FacebookCommentApiError('Failed to call the Facebook comment service.') from exc

    comments = data.get('comments', [])
    if not isinstance(comments, list):
        raise FacebookCommentApiError('Unexpected response format from comment service.')
    return comments


def _cluster_comment_texts(comments: list) -> dict:
    """Cluster a list of comment texts into semantic groups for the "Phân tích"
    view — reuses the SAME external clustering service + LLM cluster-naming as
    TikTok. Returns ``{count, model, n_clusters, points, cluster_labels}``.

    Unlike the TikTok endpoint it does NOT use the Qdrant cache (it re-clusters on
    each call), so no per-surface Qdrant collection is needed. Raises
    ``FacebookCommentApiError`` on failure."""
    api_url = getattr(settings, 'TIKTOK_COMMENT_API_URL', '')
    if not api_url:
        raise FacebookCommentApiError('Clustering service (TIKTOK_COMMENT_API_URL) is not configured.')
    timeout = getattr(settings, 'FACEBOOK_COMMENT_TIMEOUT_SECONDS', 120)
    endpoint = f'{api_url.rstrip("/")}/cluster-comment'
    try:
        resp = http_requests.post(
            endpoint,
            json={'comments': comments, 'model': 'text-embedding-3-small', 'n_neighbors': 15, 'min_dist': 0.1, 'k_max': 10},
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except (http_requests.exceptions.RequestException, ValueError) as exc:
        logger.exception('facebook cluster service error: %s', exc)
        raise FacebookCommentApiError('Failed to call the comment clustering service.') from exc

    points = data.get('points', [])
    if not isinstance(points, list):
        raise FacebookCommentApiError('Unexpected response from the clustering service.')

    cluster_labels: dict = {}
    api_key = getattr(settings, 'OPENAI_API_KEY', '')
    if api_key and points:
        try:
            from tiktok.views import _name_clusters_with_llm  # noqa: PLC0415 — reuse
            cluster_labels = _name_clusters_with_llm(points, api_key)
        except Exception as exc:  # noqa: BLE001 — naming is best-effort
            logger.warning('facebook cluster: LLM naming failed: %s', exc)

    return {
        'count': len(points),
        'model': data.get('model') or 'text-embedding-3-small',
        'n_clusters': int(data.get('n_clusters') or 0),
        'points': points,
        'cluster_labels': cluster_labels,
    }


def _call_facebook_page_posts_api(
    url: str,
    *,
    since: str | None = None,
    until: str | None = None,
    max_posts: int = 50,
) -> list:
    """Call the external crawler /page-posts endpoint for competitor analysis.

    Expected response: ``{ "posts": [ {post_url, content, image_url, posted_at,
    reactions_count, comments_count, shares_count}, ... ] }``.

    ``since``/``until`` are ISO date strings (YYYY-MM-DD). Raises
    ``FacebookCommentApiError`` on failure.
    """
    api_url = getattr(settings, 'FACEBOOK_COMMENT_API_URL', '')
    timeout = getattr(settings, 'FACEBOOK_COMMENT_TIMEOUT_SECONDS', 120)
    if not api_url:
        raise FacebookCommentApiError('FACEBOOK_COMMENT_API_URL is not configured.')
    endpoint = f'{api_url.rstrip("/")}/page-posts'
    payload = {'url': url, 'max_posts': max_posts}
    if since:
        payload['since'] = since
    if until:
        payload['until'] = until
    try:
        resp = http_requests.post(endpoint, json=payload, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except (http_requests.exceptions.RequestException, ValueError) as exc:
        logger.exception('facebook page-posts crawler error: %s', exc)
        raise FacebookCommentApiError('Failed to call the Facebook page-posts service.') from exc

    posts = data.get('posts', [])
    if not isinstance(posts, list):
        raise FacebookCommentApiError('Unexpected response format from page-posts service.')
    return posts


# ─── Google Sheets import helpers ──────────────────────────────────────────

# Canonical CSV field → tuple of accepted header aliases (case-insensitive).
# When a sheet has any of the aliases, it is treated as that canonical field.
# Order matters: the first alias that matches a column wins.
_CSV_ALIASES: dict[str, tuple[str, ...]] = {
    'content': ('content', 'nội dung'),
    'image_url': (
        'image_url', 'image url', 'media', 'media_url',
        'ảnh', 'url ảnh', 'video', 'url video', 'link sản phẩm',
        'link', 'link ảnh', 'link media', 'link ảnh/video',
    ),
    'scheduled_at': (
        'scheduled_at', 'scheduled at',
        'ngày', 'lịch đăng', 'thời gian', 'ngày đăng', 'ngày giờ',
    ),
    'topic': ('chủ đề', 'topic'),
    # "Via" / poster name — the FB-app account that should own the row. When the
    # cell is non-empty, the row is imported ONLY if it matches the target
    # profile's (or group poster's) ``account_name``; empty cell = import anyway.
    'via_name': ('via_name', 'via', 'tên via', 'người đăng', 'nguoi dang', 'account name'),
    # FB profile media actions (avatar / cover / story) — each cell holds a
    # single image URL (Drive file URL, Drive folder picks the first file,
    # or a direct public URL). Used only by FacebookProfile.upload_csv;
    # Page/Group importers ignore these columns.
    'avatar_url': (
        'avatar_url', 'avatar',
        'ảnh đại diện', 'link ảnh đại diện', 'url ảnh đại diện',
    ),
    'cover_url': (
        'cover_url', 'cover',
        'ảnh bìa', 'link ảnh bìa', 'url ảnh bìa',
    ),
    'story_url': (
        'story_url', 'story',
        'tin nổi bật', 'link tin nổi bật', 'url tin nổi bật', 'ảnh story',
    ),
    # Per-row redirect into a FB group (anonymously). Resolved against the
    # user's accessible FacebookGroup set by URL → group_uid match. Empty
    # cell = use batch-level ``target_group_id`` form arg (or timeline if
    # neither is set). Sheet cell value may be a Drive/rich chip URL pointing
    # to facebook.com/groups/<uid> or a plain text URL/UID.
    'group_url': (
        'group_url', 'group url', 'group',
        'nhóm', 'fb group', 'link group', 'group đăng',
    ),
}


_CSV_IMPORT_SEMAPHORE = threading.BoundedSemaphore(
    int(getattr(settings, 'FB_CSV_IMPORT_MAX_CONCURRENT_REQUESTS', 1))
)


def _guard_csv_import(view_func):
    @wraps(view_func)
    def _wrapped(self, request, *args, **kwargs):
        if not _CSV_IMPORT_SEMAPHORE.acquire(blocking=False):
            return Response(
                {
                    'detail': (
                        'Đang có import CSV khác chạy. Vui lòng chờ job hiện tại '
                        'xong rồi thử lại.'
                    )
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        try:
            return view_func(self, request, *args, **kwargs)
        finally:
            _CSV_IMPORT_SEMAPHORE.release()

    return _wrapped


def _count_csv_media_refs(rows: list[dict], resolver: dict[str, str | None], fields: tuple[str, ...]) -> int:
    total = 0
    for row in rows:
        for field in fields:
            raw = _row_get(row, resolver, field)
            if raw is None:
                continue
            lines = [ln.strip() for ln in str(raw).split('\n') if ln.strip()]
            total += max(1, len(lines)) if str(raw).strip() else 0
    return total


def _validate_csv_import_size(
    rows: list[dict],
    resolver: dict[str, str | None],
    *,
    media_fields: tuple[str, ...] = ('image_url',),
) -> Response | None:
    max_rows = int(getattr(settings, 'FB_CSV_IMPORT_MAX_ROWS', 300))
    if len(rows) > max_rows:
        return Response(
            {'detail': f'CSV/Sheet có {len(rows)} rows, vượt giới hạn {max_rows} rows/lần import.'},
            status=400,
        )

    max_media_refs = int(getattr(settings, 'FB_CSV_IMPORT_MAX_MEDIA_REFS', 300))
    media_refs = _count_csv_media_refs(rows, resolver, media_fields)
    if media_refs > max_media_refs:
        return Response(
            {
                'detail': (
                    f'CSV/Sheet có {media_refs} media references, vượt giới hạn '
                    f'{max_media_refs} media/lần import.'
                )
            },
            status=400,
        )

    return None


_FB_GROUP_UID_FROM_URL_RE = re.compile(
    r'facebook\.com/groups/([^/?#\s]+)', re.IGNORECASE,
)


def _resolve_target_group_from_cell(
    raw: str, candidate_groups: list['FacebookGroup'],
) -> 'FacebookGroup | None':
    """Resolve a sheet cell value into a FacebookGroup the user owns/shares.

    Strategy:
      1. Strip + take first non-empty line (cells may carry multiple chips).
      2. If the value contains ``facebook.com/groups/<token>``, match
         ``token`` against each candidate's ``group_uid`` (case-insensitive)
         or fall back to substring match on ``group_url``.
      3. If the value itself looks like a bare UID/vanity (no URL), match
         directly against ``group_uid``.

    Returns the matched group or ``None`` if the cell is empty. Raises
    ``ValueError`` with a user-facing message when non-empty but no candidate
    matches.
    """
    if not raw:
        return None
    line = next((ln.strip() for ln in raw.splitlines() if ln.strip()), '')
    if not line:
        return None

    m = _FB_GROUP_UID_FROM_URL_RE.search(line)
    if m:
        token = m.group(1).strip().lower()
        for g in candidate_groups:
            if (g.group_uid or '').strip().lower() == token:
                return g
        for g in candidate_groups:
            if line in (g.group_url or '') or (g.group_url or '') in line:
                return g
    else:
        token = line.strip().lower()
        for g in candidate_groups:
            if (g.group_uid or '').strip().lower() == token:
                return g

    raise ValueError(
        f'Cột Group có giá trị {line!r} nhưng không khớp group nào bạn đang '
        'sở hữu / được share. Kiểm tra group_uid hoặc URL có đúng không.'
    )

# Canonical fields the sheet MUST contain (under any alias) for import to run.
_CSV_REQUIRED: tuple[str, ...] = ('content',)


def _build_csv_resolver(header_keys: list[str]) -> dict[str, str | None]:
    """Map canonical field name → actual header key present in the sheet (or None).

    Header matching is case- and whitespace-insensitive: ``  Chủ Đề  `` matches
    alias ``chủ đề``. Unknown columns in the sheet are ignored.
    """
    normalized = {(k or '').strip().lower(): k for k in header_keys if k}
    resolver: dict[str, str | None] = {}
    for canonical, aliases in _CSV_ALIASES.items():
        match = next((normalized[a] for a in aliases if a in normalized), None)
        resolver[canonical] = match
    return resolver


def _validate_csv_headers(header_keys: list[str]) -> str | None:
    """Return Vietnamese error message if required headers missing, else None."""
    resolver = _build_csv_resolver(header_keys)
    for canonical in _CSV_REQUIRED:
        if not resolver.get(canonical):
            aliases = ' / '.join(_CSV_ALIASES[canonical])
            return (
                f'Sheet thiếu cột bắt buộc cho field "{canonical}" '
                f'(chấp nhận một trong: {aliases}). '
                f'Header hiện tại trong sheet: {[h for h in header_keys if h]!r}.'
            )
    return None


def _row_get(row: dict, resolver: dict[str, str | None], canonical: str):
    """Fetch a canonical field's raw value from *row* via the resolver."""
    actual = resolver.get(canonical)
    if not actual:
        return None
    return row.get(actual)


_SHEET_ID_RE = re.compile(r'/spreadsheets/d/([a-zA-Z0-9_-]+)')
_GID_RE = re.compile(r'gid=(\d+)')


def _google_sheet_url_to_csv_url(url: str) -> str | None:
    """Convert any Google Sheets share URL to its CSV export endpoint.

    Examples:
        .../edit#gid=123    → ...export?format=csv&gid=123
        .../edit?usp=sharing → ...export?format=csv&gid=0
    Returns ``None`` if the URL does not contain a Google Sheets ID.
    """
    if not url:
        return None
    m = _SHEET_ID_RE.search(url)
    if not m:
        return None
    sheet_id = m.group(1)
    gid_match = _GID_RE.search(url)
    gid = gid_match.group(1) if gid_match else '0'
    return f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'


def _drive_chip_to_url(chip: dict) -> str | None:
    """Convert a Sheets API ``chip`` object to a URL when possible.

    The Sheets API v4 exposes smart chips through ``chip.richLinkProperties``
    (with ``uri`` and ``mimeType``). Drive smart chips arrive here too because
    Sheets models them as rich-link chips pointing at the Drive resource. Person
    chips and other types have no URL — return None for those.
    """
    rich = chip.get('richLinkProperties') or {}
    uri = rich.get('uri')
    if uri:
        return uri
    return None


_URL_IN_TEXT_RE = re.compile(r'https?://[^\s<>"\']+', re.IGNORECASE)


def _extract_cell_value(cell: dict) -> str:
    """Return the most useful string from a Sheets API cell.

    Behaviour by cell shape:

      * Cell has Drive/rich-link chip(s) → treat as a MEDIA cell. Collect chip
        URLs, then also pull any ``hyperlink`` + URLs hiding inside
        ``formattedValue`` (user may have mixed chip + text URL in the same
        cell). Deduped, joined by ``\\n``.
      * Cell has no chips but has a ``hyperlink`` (whole-cell hyperlink) →
        return that URL.
      * Otherwise → return the raw ``formattedValue``.

    The "URLs from formattedValue" extraction is GATED on chips being present.
    Content cells often embed URLs in long text (``Liên hệ Zalo
    https://zalo.me/g/...``); extracting them would discard the surrounding
    text and the row would import with just the URL as the post content.
    Chips are the unambiguous signal that the cell is URL-oriented.
    """
    chip_runs = cell.get('chipRuns') or []
    chip_urls: list[str] = []
    seen: set[str] = set()

    def _add(u: str | None):
        if not u:
            return
        clean = u.strip().rstrip('.,);]')
        if clean and clean not in seen:
            seen.add(clean)
            chip_urls.append(clean)

    for run in chip_runs:
        _add(_drive_chip_to_url(run.get('chip') or {}))

    if chip_urls:
        _add(cell.get('hyperlink'))
        for m in _URL_IN_TEXT_RE.findall(cell.get('formattedValue') or ''):
            _add(m)
        return '\n'.join(chip_urls)

    formatted = (cell.get('formattedValue') or '').strip()
    # WYSIWYG: khi text hiển thị TỰ NÓ đã là một URL (http/https), tin vào text
    # thay vì hyperlink của cả ô — người dùng dán link media dạng chữ nhưng
    # Sheets có thể gắn kèm hyperlink lạ (vd link Google Docs) lên ô đó, khiến
    # importer lấy nhầm link Docs làm ảnh. Text nhìn thấy mới là ý người dùng.
    if formatted and _URL_IN_TEXT_RE.match(formatted):
        return formatted

    hyperlink = cell.get('hyperlink')
    if hyperlink:
        return hyperlink
    return formatted


def _fetch_sheet_as_rows_via_api(sheet_url: str) -> list[dict] | None:
    """Read a Google Sheet via Sheets API, preserving smart chips.

    Auth: tries ``GOOGLE_API_KEY`` first (public "Anyone with the link"
    sheets — the original behaviour, unchanged), then falls back to the
    service-account Bearer token which can read PRIVATE sheets shared with
    the SA email.

    Returns a list of dicts (one per data row, keyed by header) — or ``None``
    if the API call is not feasible (no auth configured, URL not a Sheets
    URL, API rejects the request, or the sheet isn't accessible with any of
    the auths). The caller is expected to fall back to CSV export in those
    cases.
    """
    from .google_auth import get_google_bearer_token

    # Ordered auth attempts: API key (logic cũ — sheet public) trước, SA token
    # (sheet private đã share cho email SA) là fallback. Each entry =
    # (headers, extra query params).
    auth_attempts: list[tuple[dict, dict]] = []
    api_key = (getattr(settings, 'GOOGLE_API_KEY', '') or '').strip()
    if api_key:
        auth_attempts.append(({}, {'key': api_key}))
    token = get_google_bearer_token()
    if token:
        auth_attempts.append(({'Authorization': f'Bearer {token}'}, {}))
    if not auth_attempts:
        return None
    m = _SHEET_ID_RE.search(sheet_url or '')
    if not m:
        return None
    sheet_id = m.group(1)
    gid_match = _GID_RE.search(sheet_url)
    gid = gid_match.group(1) if gid_match else '0'

    try:
        # 1) Find the sheet's title from gid (the grid API wants a range name).
        # The first auth that can read the metadata wins and is reused for the
        # grid call below (a sheet readable by the SA may not be public and
        # vice versa).
        meta_resp = None
        headers: dict = {}
        auth_params: dict = {}
        for headers, auth_params in auth_attempts:
            meta_resp = http_requests.get(
                f'https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}',
                params={**auth_params, 'fields': 'sheets(properties(sheetId,title))'},
                headers=headers,
                timeout=30,
            )
            if meta_resp.ok:
                break
        if meta_resp is None or not meta_resp.ok:
            return None
        meta = meta_resp.json()
        title = None
        for s in meta.get('sheets') or []:
            if str((s.get('properties') or {}).get('sheetId')) == gid:
                title = (s.get('properties') or {}).get('title')
                break
        if not title and meta.get('sheets'):
            title = (meta['sheets'][0].get('properties') or {}).get('title')
        if not title:
            return None

        # 2) Pull the full grid for that tab, including chip metadata.
        grid_resp = http_requests.get(
            f'https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}',
            params={
                **auth_params,
                'includeGridData': 'true',
                'ranges': title,
                'fields': (
                    'sheets(properties(title),data(rowData(values('
                    'formattedValue,hyperlink,chipRuns(chip(richLinkProperties))'
                    '))))'
                ),
            },
            headers=headers,
            timeout=60,
        )
        if not grid_resp.ok:
            return None
        grid = grid_resp.json()
    except http_requests.exceptions.RequestException:
        return None

    sheets = grid.get('sheets') or []
    if not sheets:
        return None
    data = (sheets[0].get('data') or [{}])[0]
    row_data = data.get('rowData') or []
    if not row_data:
        return []

    headers = []
    for cell in (row_data[0].get('values') or []):
        headers.append((cell.get('formattedValue') or '').strip())
    if not any(headers):
        return None

    out: list[dict] = []
    for r in row_data[1:]:
        cells = r.get('values') or []
        if not cells:
            continue
        row: dict = {}
        any_value = False
        for idx, cell in enumerate(cells):
            if idx >= len(headers):
                break
            key = headers[idx]
            if not key:
                continue
            value = _extract_cell_value(cell)
            row[key] = value
            if value:
                any_value = True
        if any_value:
            out.append(row)
    return out


def _fetch_sheet_as_csv_bytes(sheet_url: str) -> bytes:
    """Fetch a public Google Sheet as CSV bytes. Raises ``ValueError`` on failure.

    NOTE: CSV export strips smart chips down to display text. For sheets with
    Drive/link chips in the image column, callers should prefer
    :func:`_fetch_sheet_as_rows_via_api` and only fall back here when the
    Sheets API isn't available.
    """
    csv_url = _google_sheet_url_to_csv_url(sheet_url)
    if not csv_url:
        raise ValueError(
            'URL không phải Google Sheets hợp lệ. Cần dạng '
            'https://docs.google.com/spreadsheets/d/.../edit'
        )
    try:
        resp = http_requests.get(csv_url, timeout=60, allow_redirects=True)
    except http_requests.exceptions.RequestException as exc:
        raise ValueError(f'Không tải được Google Sheet: {exc}') from exc
    # Google trả 401/403 nếu sheet không public; thường redirect về trang login.
    if resp.status_code in (401, 403) or 'accounts.google.com' in resp.url:
        from .google_auth import get_google_service_account_email
        sa_email = get_google_service_account_email()
        if sa_email:
            raise ValueError(
                f'Không đọc được Google Sheet. Vào Share → thêm email '
                f'"{sa_email}" (quyền Viewer), rồi thử lại. (Hoặc share '
                '"Anyone with the link" → Viewer nếu muốn để public.)'
            )
        raise ValueError(
            'Google Sheet chưa được chia sẻ public. Vào Share → '
            '"Anyone with the link" → Viewer, rồi thử lại.'
        )
    if not resp.ok:
        raise ValueError(f'Không tải được Google Sheet: HTTP {resp.status_code}')
    return resp.content


# ─── Google Drive folder expansion helpers ─────────────────────────────────

# Match Drive folder URLs with or without the optional account-index segment:
#   /drive/folders/<id>
#   /drive/u/0/folders/<id>      ← inserted by Drive when user is signed into
#   /drive/u/3/folders/<id>        multiple Google accounts; ``0`` is the
#                                  primary, but Drive picks the active account
#                                  index. Older regex without ``u/\d+/`` skips
#                                  these silently → folder URL gets treated as
#                                  a raw image URL → S3 ends up storing the
#                                  folder path as a fake key.
_DRIVE_FOLDER_RE = re.compile(r'/drive/(?:u/\d+/)?folders/([a-zA-Z0-9_-]+)')
_DRIVE_FILE_RE = re.compile(r'/file/(?:u/\d+/)?d/([a-zA-Z0-9_-]+)')


def _extract_drive_file_id(url: str) -> str | None:
    """Extract file ID from a Google Drive single-file share URL.

    Drive file share URLs (``/file/d/{id}/view``) return an HTML preview page
    when HTTP GET'd; we must swap them for the API media-download URL.
    """
    if not url:
        return None
    m = _DRIVE_FILE_RE.search(url)
    return m.group(1) if m else None


def _extract_drive_folder_id(url: str) -> str | None:
    """Extract folder ID from a Google Drive folder URL, or None."""
    if not url:
        return None
    m = _DRIVE_FOLDER_RE.search(url)
    if m:
        return m.group(1)
    # Also accept the alt ``open?id=`` form for folders.
    m = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', url)
    if m and 'drive.google.com' in url:
        return m.group(1)
    return None


_ALLOWED_MEDIA_MIMES = frozenset({
    'image/jpeg', 'image/jpg', 'image/png', 'image/x-png',
    'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/bmp',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
    'video/x-msvideo', 'video/x-matroska',
})
_ALLOWED_MEDIA_EXTS = frozenset({
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp',
    '.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv',
})
# Mimes Drive applies to designer formats we explicitly do NOT want even if
# the file extension would otherwise match (defensive — extensions can lie).
_BLOCKED_MEDIA_MIMES = frozenset({
    'image/vnd.adobe.photoshop',
    'application/illustrator',
    'application/postscript',
    'application/x-photoshop',
    'application/photoshop',
})


def _list_drive_folder_files(folder_id: str) -> list[dict]:
    """List image+video files in a Google Drive folder via the Drive v3 API.

    Returns a list of ``{id, name, mimeType}`` sorted by ``name`` ascending.

    Auth: tries ``GOOGLE_API_KEY`` first (public "Anyone with the link"
    folders — the original behaviour, unchanged), then falls back to the
    service-account Bearer token which works on PRIVATE folders shared with
    the SA email. At least one must be configured.

    Filtering: we ask Drive for ALL non-trashed files (no MIME predicate) and
    filter client-side. The reason: Drive sometimes labels PNGs exported from
    Photoshop/Illustrator as ``application/octet-stream`` or ``image/x-png``;
    a strict ``mimeType='image/png'`` query in the API call silently drops
    them. Client-side, we accept a file if EITHER its mime is in the whitelist
    OR its filename extension is — but reject if mime is in the designer-
    format blocklist (PSD/AI) even when extension looks fine.

    Raises ``ValueError`` on API errors (no auth configured, folder not
    accessible, etc.).
    """
    import os as _os

    from .google_auth import get_google_bearer_token, get_google_service_account_email

    # Ordered auth attempts, same pattern as _fetch_sheet_as_rows_via_api:
    # API key (logic cũ — folder public) trước, SA token (folder private đã
    # share cho email SA) là fallback.
    auth_attempts: list[tuple[dict, dict]] = []
    api_key = getattr(settings, 'GOOGLE_API_KEY', '')
    if api_key:
        auth_attempts.append(({}, {'key': api_key}))
    token = get_google_bearer_token()
    if token:
        auth_attempts.append((
            {'Authorization': f'Bearer {token}'},
            # Shared drives (Drive dùng chung) chỉ list được qua token.
            {'supportsAllDrives': 'true', 'includeItemsFromAllDrives': 'true'},
        ))
    if not auth_attempts:
        raise ValueError(
            'Chưa cấu hình GOOGLE_SERVICE_ACCOUNT_FILE hoặc GOOGLE_API_KEY. '
            'Cần 1 Google Cloud project đã bật Drive API, rồi set một trong '
            'hai env đó trước khi dùng Drive folder URL.'
        )
    q = f"'{folder_id}' in parents and trashed=false"
    base_params = {
        'q': q,
        'fields': 'files(id,name,mimeType)',
        'pageSize': '200',
        'orderBy': 'name',
    }
    # Chọn auth theo kết quả THỰC, không chỉ theo HTTP ok: một folder PRIVATE bị
    # API key (ẩn danh) query sẽ trả 200 kèm danh sách RỖNG (không thấy nội dung)
    # thay vì 403 — nếu dừng ở đó thì không bao giờ thử tới SA token và ảnh mất
    # sạch. Nên: chỉ dừng khi một auth trả về list CÓ file; auth ok-nhưng-rỗng
    # chỉ được ghi nhận để, nếu mọi auth đều rỗng, coi folder là rỗng thật.
    files: list | None = None
    saw_ok_empty = False
    error_resp = None
    try:
        for headers, auth_params in auth_attempts:
            resp = http_requests.get(
                'https://www.googleapis.com/drive/v3/files',
                params={**base_params, **auth_params},
                headers=headers,
                timeout=30,
            )
            if not resp.ok:
                error_resp = resp
                continue
            try:
                fetched = (resp.json() or {}).get('files') or []
            except ValueError as exc:
                raise ValueError(f'Drive API trả non-JSON: {exc}') from exc
            if not isinstance(fetched, list):
                raise ValueError('Drive API trả unexpected payload.')
            if fetched:
                files = fetched
                break
            saw_ok_empty = True
    except http_requests.exceptions.RequestException as exc:
        raise ValueError(f'Không gọi được Drive API: {exc}') from exc

    if files is None:
        # Không auth nào trả file. Có auth ok (folder rỗng thật, hoặc mọi auth
        # đều không thấy nội dung) → trả rỗng. Toàn lỗi → báo lỗi share.
        if saw_ok_empty:
            return []
        resp = error_resp
        if resp is not None and resp.status_code in (403, 404):
            sa_email = get_google_service_account_email()
            if sa_email:
                raise ValueError(
                    f'Drive API trả {resp.status_code}. Nhiều khả năng folder chưa '
                    f'được share cho service account: vào Share của folder → thêm '
                    f'email "{sa_email}" (quyền Viewer). Các khả năng khác: API key '
                    'chưa enable Drive API, hoặc API key bị hạn chế domain/IP.'
                )
            if resp.status_code == 403:
                raise ValueError(
                    'Drive API trả 403. Có thể: (a) API key chưa enable Drive API, '
                    '(b) folder chưa share public, hoặc (c) API key bị hạn chế domain/IP.'
                )
        if resp is not None:
            raise ValueError(f'Drive API error: HTTP {resp.status_code} – {resp.text[:200]}')
        raise ValueError('Drive API: không lấy được danh sách file trong folder.')

    accepted: list[dict] = []
    for f in files:
        if not isinstance(f, dict):
            continue
        mime = str(f.get('mimeType') or '').lower().strip()
        name = str(f.get('name') or '').strip()
        ext = _os.path.splitext(name)[1].lower()
        if mime in _BLOCKED_MEDIA_MIMES:
            continue
        if mime in _ALLOWED_MEDIA_MIMES or ext in _ALLOWED_MEDIA_EXTS:
            accepted.append(f)

    return sorted(accepted, key=lambda f: str(f.get('name') or ''))


def _drive_file_download_url(file_id: str) -> str:
    """Public download URL for a Drive file.

    Drive API v3 ``/files/{id}?alt=media`` REJECTS API-key auth for content
    download (only OAuth works). Use the user-content endpoint instead — it
    works for any file shared "Anyone with the link" without auth.

    Files >25 MB trigger a "virus scan warning" HTML interstitial on the plain
    ``uc?export=download`` endpoint, so the download returns HTML instead of the
    file bytes (magic-byte validation then rejects the row). The
    ``drive.usercontent.google.com/download`` endpoint with ``confirm=t``
    bypasses that page and streams the real bytes for files of any size.
    """
    return (
        'https://drive.usercontent.google.com/download'
        f'?id={file_id}&export=download&confirm=t'
    )


def _batch_resolve_and_upload_media(raw_urls: list[str]) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Download and upload a list of raw media URLs (including folders) in parallel.

    Returns:
        - url_map: dict mapping raw_url -> list of SeaweedFS URLs
        - errors_map: dict mapping raw_url -> error string (if expansion/download failed)
    """
    from concurrent.futures import ThreadPoolExecutor

    unique_raw_urls = list(set(u.strip() for u in raw_urls if u and u.strip()))
    if not unique_raw_urls:
        return {}, {}

    expanded_map = {}
    errors_map = {}

    expand_workers = int(getattr(settings, 'FB_CSV_IMPORT_EXPAND_WORKERS', 3))
    upload_workers = int(getattr(settings, 'FB_CSV_IMPORT_UPLOAD_WORKERS', 3))

    with ThreadPoolExecutor(max_workers=max(1, expand_workers)) as executor:
        future_to_raw = {
            executor.submit(_expand_media_url_for_import, raw_url): raw_url
            for raw_url in unique_raw_urls
        }
        for future in future_to_raw:
            raw_url = future_to_raw[future]
            try:
                expanded_map[raw_url] = future.result()
            except Exception as exc:
                errors_map[raw_url] = str(exc)

    all_source_urls = set()
    for raw_url, sources in expanded_map.items():
        for src in sources:
            all_source_urls.add(src)

    max_expanded_media = int(getattr(settings, 'FB_CSV_IMPORT_MAX_EXPANDED_MEDIA', 300))
    if len(all_source_urls) > max_expanded_media:
        return {}, {
            raw_url: (
                f'Import expand ra {len(all_source_urls)} media files, vượt giới hạn '
                f'{max_expanded_media} files/lần import.'
            )
            for raw_url in unique_raw_urls
        }

    uploaded_map = {}
    from .seaweedfs_utils import download_and_upload_to_seaweedfs

    with ThreadPoolExecutor(max_workers=max(1, upload_workers)) as executor:
        future_to_src = {
            executor.submit(download_and_upload_to_seaweedfs, src_url): src_url
            for src_url in all_source_urls
        }
        for future in future_to_src:
            src_url = future_to_src[future]
            try:
                uploaded_map[src_url] = future.result()
            except Exception as exc:
                uploaded_map[src_url] = exc

    final_url_map = {}
    for raw_url in unique_raw_urls:
        if raw_url in errors_map:
            continue

        sources = expanded_map.get(raw_url, [])
        resolved_urls = []
        row_failed = False

        for src in sources:
            res = uploaded_map.get(src)
            if isinstance(res, Exception):
                errors_map[raw_url] = str(res)
                row_failed = True
                break
            elif res:
                resolved_urls.append(res)

        if not row_failed:
            final_url_map[raw_url] = resolved_urls

    return final_url_map, errors_map


def _expand_media_url_for_import(raw: str) -> list[str]:
    """Resolve a CSV/Sheet ``image_url`` cell to a concrete list of URLs.

    The cell may carry MULTIPLE sources separated by newlines (chip + chip,
    chip + URL, or URL + URL). Each line is resolved independently:

    - Drive **folder** URL → list of file download URLs (sorted by Drive name).
    - Drive **single-file** URL (``/file/d/{id}/view``) → API media-download URL.
    - Other URL → passthrough.
    - Empty / whitespace-only line → skipped.

    Final list = concat of all per-line results, in cell order.

    Raises ``ValueError`` if any Drive folder URL fails to expand.
    """
    if not raw:
        return []
    lines = [ln.strip() for ln in raw.split('\n') if ln.strip()]
    if not lines:
        return []

    out: list[str] = []
    for line in lines:
        # Drive folder — accept both ``/drive/folders/...`` and the
        # account-indexed ``/drive/u/<N>/folders/...`` form.
        folder_id = _extract_drive_folder_id(line)
        if folder_id and _DRIVE_FOLDER_RE.search(line):
            files = _list_drive_folder_files(folder_id)
            out.extend(_drive_file_download_url(f['id']) for f in files if f.get('id'))
            continue

        # Drive single file. No GOOGLE_API_KEY needed: the usercontent download
        # endpoint (_drive_file_download_url) streams any "Anyone with the link"
        # file keyless — the API key only authorises folder *listing*, never
        # content download (Drive rejects API-key auth for download). Private
        # files (shared with the service account, not public) still resolve to
        # this URL form; download_and_upload_to_seaweedfs detects the HTML
        # login page and retries via the Drive API with the SA token.
        file_id = _extract_drive_file_id(line)
        if file_id:
            out.append(_drive_file_download_url(file_id))
            continue

        out.append(line)
    return out


def _upsert_post_comments(post: FacebookPost, comments: list) -> int:
    """Upsert scraped comments into FacebookPostUserComment. Returns count created."""
    saved = 0
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        cid = str(comment.get('cid') or '').strip()
        if not cid:
            continue
        user = comment.get('user') or {}
        raw = comment.get('raw') or {}
        share_info = raw.get('share_info') or {}
        comment_link = str(share_info.get('url') or '').strip() or None

        create_time = None
        raw_create_time = comment.get('create_time')
        if raw_create_time is not None:
            try:
                create_time = datetime.fromtimestamp(int(raw_create_time), tz=dt_timezone.utc)
            except (TypeError, ValueError, OSError):
                pass

        _obj, created = FacebookPostUserComment.objects.update_or_create(
            post=post,
            cid=cid,
            defaults={
                'user_id': str(user.get('uid') or '').strip(),
                'nickname': str(user.get('nickname') or '').strip(),
                'text': str(comment.get('text') or '').strip(),
                'create_time': create_time,
                'parent_cid': str(comment.get('parent_cid') or '').strip(),
                'comment_link': comment_link,
            },
        )
        if created:
            saved += 1
    return saved


def _upsert_scheduled_post_comments(scheduled_post, comments: list) -> int:
    """Upsert scraped comments into FacebookProfileScheduledPostUserComment.
    Returns count created. Mirrors :func:`_upsert_post_comments`."""
    saved = 0
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        cid = str(comment.get('cid') or '').strip()
        if not cid:
            continue
        user = comment.get('user') or {}
        raw = comment.get('raw') or {}
        share_info = raw.get('share_info') or {}
        comment_link = str(share_info.get('url') or '').strip() or None

        create_time = None
        raw_create_time = comment.get('create_time')
        if raw_create_time is not None:
            try:
                create_time = datetime.fromtimestamp(int(raw_create_time), tz=dt_timezone.utc)
            except (TypeError, ValueError, OSError):
                pass

        _obj, created = FacebookProfileScheduledPostUserComment.objects.update_or_create(
            scheduled_post=scheduled_post,
            cid=cid,
            defaults={
                'user_id': str(user.get('uid') or '').strip(),
                'nickname': str(user.get('nickname') or '').strip(),
                'text': str(comment.get('text') or '').strip(),
                'create_time': create_time,
                'parent_cid': str(comment.get('parent_cid') or '').strip(),
                'comment_link': comment_link,
            },
        )
        if created:
            saved += 1
    return saved


class FacebookPageViewSet(viewsets.ModelViewSet):
    serializer_class = FacebookPageSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'page_url', 'page_uid', 'category', 'description']
    ordering_fields = ['created_at', 'updated_at', 'name', 'follower_count', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookPage.objects.filter(owner=self.request.user)
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    # ── CSV bulk-schedule upload ─────────────────────────────────────────────

    @action(
        detail=True,
        methods=['post'],
        url_path='upload-csv',
        url_name='upload-csv',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    @_guard_csv_import
    def upload_csv(self, request, pk=None):
        """Parse a CSV or XLSX file and create FacebookScheduledPost records.

        Accepted file types: ``.csv`` (UTF-8) and ``.xlsx``/``.xlsm`` (e.g. a
        Google Sheets export).

        Columns (header row required):
          ``content``       – post text
          ``image_url``     – public URL of an image to attach (optional)
          ``scheduled_at``  – datetime interpreted as Vietnam time, either an
                              Excel date cell or a string like
                              ``2026-05-28 13:00`` / ``28-05-2026 13:00`` /
                              ``28-05-26 13:00`` (day-first). Optional.

        Rows whose ``content`` matches a post that already exists on this
        page (or an earlier row in the same upload) are skipped and reported
        in ``skipped`` — re-uploading a list won't create duplicates.

        Rows where ``scheduled_at`` is provided but unparseable are skipped
        and reported in ``errors``.

        Rows without ``scheduled_at`` are auto-assigned one slot per day
        starting from the day after the last already-scheduled pending post
        (or tomorrow if none exist), at 09:00 Asia/Ho_Chi_Minh.
        """
        import csv
        import io as _io
        import os as _os
        from datetime import date as _date, timedelta as _td, datetime as _dt

        page = self.get_object()
        csv_file = request.FILES.get('file')
        sheet_url = (request.data.get('sheet_url') or '').strip()
        api_rows: list[dict] | None = None
        if sheet_url:
            api_rows = _fetch_sheet_as_rows_via_api(sheet_url)
            if api_rows is None:
                try:
                    csv_bytes = _fetch_sheet_as_csv_bytes(sheet_url)
                except ValueError as exc:
                    return Response({'detail': str(exc)}, status=400)
                csv_io = _io.BytesIO(csv_bytes)
                csv_name = 'sheet.csv'
            else:
                csv_io = None
                csv_name = 'sheet.csv'
        elif csv_file:
            csv_io = csv_file.file
            csv_name = csv_file.name or ''
        else:
            return Response({'detail': 'No file or sheet_url provided.'}, status=400)

        # Determine the starting date for auto-assignment
        last_ts = (
            FacebookScheduledPost.objects.filter(
                page=page,
                status=FacebookScheduledPostStatus.PENDING,
            )
            .order_by('-scheduled_at')
            .values_list('scheduled_at', flat=True)
            .first()
        )
        if last_ts:
            auto_day = last_ts.astimezone(_LOCAL_TZ).date() + _td(days=1)
        else:
            auto_day = _date.today() + _td(days=1)

        # SeaweedFS is always used — no flag needed.

        # Pre-load existing post contents for this page so we can skip duplicates.
        # We compare on the trimmed text — same comparison used for the new rows.
        existing_contents = set(
            FacebookScheduledPost.objects.filter(page=page)
            .values_list('content', flat=True)
        )
        seen_in_upload: set[str] = set()
        skipped_rows: list[dict] = []

        def _read_xlsx_rows(file_obj):
            from openpyxl import load_workbook
            wb = load_workbook(file_obj, read_only=True, data_only=True)
            ws = wb.active
            iterator = ws.iter_rows(values_only=True)
            try:
                raw_headers = next(iterator)
            except StopIteration:
                return []
            headers = [(str(h).strip() if h is not None else '') for h in raw_headers]
            out = []
            for cells in iterator:
                if not cells or all(c is None or c == '' for c in cells):
                    continue
                d = {}
                for idx, value in enumerate(cells):
                    if idx >= len(headers):
                        break
                    key = headers[idx]
                    if key:
                        d[key] = value
                out.append(d)
            return out

        # Read rows from CSV or XLSX, depending on the file extension.
        ext = _os.path.splitext(csv_name.lower())[1]
        try:
            if api_rows is not None:
                rows = api_rows
            elif ext in ('.xlsx', '.xlsm'):
                rows = _read_xlsx_rows(csv_io)
            else:
                content_io = _io.TextIOWrapper(csv_io, encoding='utf-8-sig')
                rows = list(csv.DictReader(content_io))
        except Exception as exc:
            return Response({'detail': f'Failed to read file: {exc}'}, status=400)

        header_keys = list(rows[0].keys()) if rows else []
        err = _validate_csv_headers(header_keys)
        if err:
            return Response({'detail': err}, status=400)
        resolver = _build_csv_resolver(header_keys)
        size_err = _validate_csv_import_size(rows, resolver)
        if size_err:
            return size_err

        def _s(value):
            if value is None:
                return ''
            if isinstance(value, str):
                return value.strip()
            return str(value).strip()

        created_ids = []
        row_errors = []
        parsed_rows = []
        raw_urls_to_resolve = []

        for i, row in enumerate(rows, start=2):  # row 1 = header
            content = _s(_row_get(row, resolver, 'content'))

            # Skip rows whose content matches an existing post on this page or
            # an earlier row in the same upload — avoid creating duplicates.
            if content and (content in existing_contents or content in seen_in_upload):
                skipped_rows.append({'row': i, 'reason': 'duplicate_content'})
                continue

            image_url_raw = _s(_row_get(row, resolver, 'image_url'))
            sv = _row_get(row, resolver, 'scheduled_at')

            # Parse scheduled_at. XLSX cells may already be a datetime; treat
            # naive datetimes (no tzinfo) as Vietnam time. Strings are parsed
            # below using day-first formats (Vietnamese convention).
            scheduled_at = None
            if isinstance(sv, _dt):
                scheduled_at = (
                    sv if sv.tzinfo is not None else sv.replace(tzinfo=_LOCAL_TZ)
                )
            else:
                scheduled_at_raw = _s(sv)
                if scheduled_at_raw:
                    for fmt in (
                        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                        '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M', '%d-%m-%Y',
                        '%d-%m-%y %H:%M:%S', '%d-%m-%y %H:%M', '%d-%m-%y',
                        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%d/%m/%Y',
                        '%d/%m/%y %H:%M:%S', '%d/%m/%y %H:%M', '%d/%m/%y',
                    ):
                        try:
                            scheduled_at = _dt.strptime(scheduled_at_raw, fmt).replace(
                                tzinfo=_LOCAL_TZ
                            )
                            break
                        except ValueError:
                            continue
                    if scheduled_at is None:
                        row_errors.append({
                            'row': i,
                            'error': (
                                f'Unrecognised scheduled_at format {scheduled_at_raw!r}. '
                                'Use e.g. "2026-05-28 13:00", "28-05-2026 13:00", '
                                'or "28-05-26 13:00".'
                            ),
                        })
                        continue

            if scheduled_at is None:
                scheduled_at = _dt.combine(auto_day, time(9, 0), tzinfo=_LOCAL_TZ)
                auto_day += _td(days=1)

            if image_url_raw:
                raw_urls_to_resolve.append(image_url_raw)

            parsed_rows.append({
                'row_num': i,
                'content': content,
                'scheduled_at': scheduled_at,
                'image_url_raw': image_url_raw,
                'topic': _s(_row_get(row, resolver, 'topic'))[:64],
            })
            if content:
                seen_in_upload.add(content)

        # Lazy media: store the raw image_url cell as-is and defer the heavy
        # download + re-upload to SeaweedFS to publish time
        # (_ensure_scheduled_post_media_hosted). Keeps import instant even for
        # large videos / Drive folders.
        for pr in parsed_rows:
            i = pr['row_num']
            image_url_raw = pr['image_url_raw']
            image_urls = [image_url_raw] if image_url_raw else []

            obj = FacebookScheduledPost.objects.create(
                page=page,
                content=pr['content'],
                image_urls=image_urls,
                topic=pr['topic'],
                scheduled_at=pr['scheduled_at'],
                status=FacebookScheduledPostStatus.PENDING,
                owner=request.user,
            )
            created_ids.append(obj.id)

        return Response({
            'created': len(created_ids),
            'skipped': skipped_rows,
            'errors': row_errors,
        })


class FacebookGroupViewSet(viewsets.ModelViewSet):
    serializer_class = FacebookGroupSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'group_url', 'group_uid', 'description']
    ordering_fields = ['created_at', 'updated_at', 'name', 'member_count', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookGroup.objects.filter(owner=self.request.user).select_related('admin_profile', 'admin_fb_profile')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(
        detail=True,
        methods=['post'],
        url_path='sync-pending-member-posts',
        url_name='sync-pending-member-posts',
    )
    def sync_pending_member_posts(self, request, pk=None):
        """Dispatch a phoneagent task that scrapes the group's "Pending posts"
        tab in the FB app and reports the list back. The devices_worker
        terminal-state hook upserts ``FacebookGroupPendingMemberPost`` rows
        from the task's result payload.
        """
        group = self.get_object()
        try:
            task = _dispatch_fb_group_fetch_pending_task(group)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TransientPublishError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({
            'detail': f'Đã dispatch task #{task.id}. Refresh sau khi agent xong.',
            'task_id': task.id,
        })

    @action(
        detail=True,
        methods=['post'],
        url_path='upload-csv',
        url_name='upload-csv',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    @_guard_csv_import
    def upload_csv(self, request, pk=None):
        """Parse a CSV/XLSX file and create FacebookGroupScheduledPost records.

        Mirror of ``FacebookPageViewSet.upload_csv``. Accepts CSV (UTF-8) and
        XLSX. Columns: ``content``, ``image_url`` (optional), ``scheduled_at``
        (optional — day-first or ISO; XLSX date cells supported). Dedupes by
        content; reports per-row issues in ``errors`` / ``skipped``.
        """
        import csv
        import io as _io
        import os as _os
        from datetime import date as _date, timedelta as _td, datetime as _dt

        group = self.get_object()
        csv_file = request.FILES.get('file')
        sheet_url = (request.data.get('sheet_url') or '').strip()
        api_rows: list[dict] | None = None
        if sheet_url:
            api_rows = _fetch_sheet_as_rows_via_api(sheet_url)
            if api_rows is None:
                try:
                    csv_bytes = _fetch_sheet_as_csv_bytes(sheet_url)
                except ValueError as exc:
                    return Response({'detail': str(exc)}, status=400)
                csv_io = _io.BytesIO(csv_bytes)
                csv_name = 'sheet.csv'
            else:
                csv_io = None
                csv_name = 'sheet.csv'
        elif csv_file:
            csv_io = csv_file.file
            csv_name = csv_file.name or ''
        else:
            return Response({'detail': 'No file or sheet_url provided.'}, status=400)

        last_ts = (
            FacebookGroupScheduledPost.objects.filter(
                group=group,
                status=FacebookScheduledPostStatus.PENDING,
            )
            .order_by('-scheduled_at')
            .values_list('scheduled_at', flat=True)
            .first()
        )
        if last_ts:
            auto_day = last_ts.astimezone(_LOCAL_TZ).date() + _td(days=1)
        else:
            auto_day = _date.today() + _td(days=1)

        # SeaweedFS is always used — no flag needed.

        existing_contents = set(
            FacebookGroupScheduledPost.objects.filter(group=group)
            .values_list('content', flat=True)
        )
        seen_in_upload: set[str] = set()
        skipped_rows: list[dict] = []

        def _read_xlsx_rows(file_obj):
            from openpyxl import load_workbook
            wb = load_workbook(file_obj, read_only=True, data_only=True)
            ws = wb.active
            iterator = ws.iter_rows(values_only=True)
            try:
                raw_headers = next(iterator)
            except StopIteration:
                return []
            headers = [(str(h).strip() if h is not None else '') for h in raw_headers]
            out = []
            for cells in iterator:
                if not cells or all(c is None or c == '' for c in cells):
                    continue
                d = {}
                for idx, value in enumerate(cells):
                    if idx >= len(headers):
                        break
                    key = headers[idx]
                    if key:
                        d[key] = value
                out.append(d)
            return out

        ext = _os.path.splitext(csv_name.lower())[1]
        try:
            if api_rows is not None:
                rows = api_rows
            elif ext in ('.xlsx', '.xlsm'):
                rows = _read_xlsx_rows(csv_io)
            else:
                content_io = _io.TextIOWrapper(csv_io, encoding='utf-8-sig')
                rows = list(csv.DictReader(content_io))
        except Exception as exc:
            return Response({'detail': f'Failed to read file: {exc}'}, status=400)

        header_keys = list(rows[0].keys()) if rows else []
        err = _validate_csv_headers(header_keys)
        if err:
            return Response({'detail': err}, status=400)
        resolver = _build_csv_resolver(header_keys)
        size_err = _validate_csv_import_size(rows, resolver)
        if size_err:
            return size_err

        def _s(value):
            if value is None:
                return ''
            if isinstance(value, str):
                return value.strip()
            return str(value).strip()

        created_ids = []
        row_errors = []
        parsed_rows = []
        raw_urls_to_resolve = []

        for i, row in enumerate(rows, start=2):
            content = _s(_row_get(row, resolver, 'content'))

            # "Via" filter: only import rows whose via/poster matches this group's
            # default poster account_name (empty cell = import anyway).
            # Same as the profile import: sheet HAS a via column → only rows whose
            # via matches this group's poster (account_name OR name) import; empty
            # / different via is skipped. No via column → import everything.
            if resolver.get('via_name') is not None:
                poster = group.default_poster_fb_profile
                via = _s(_row_get(row, resolver, 'via_name')).strip().lower()
                via_targets = {
                    (getattr(poster, 'account_name', '') or '').strip().lower(),
                    (getattr(poster, 'name', '') or '').strip().lower(),
                }
                via_targets.discard('')
                if via not in via_targets:
                    skipped_rows.append({'row': i, 'reason': 'via_mismatch'})
                    continue

            if content and (content in existing_contents or content in seen_in_upload):
                skipped_rows.append({'row': i, 'reason': 'duplicate_content'})
                continue

            image_url_raw = _s(_row_get(row, resolver, 'image_url'))
            sv = _row_get(row, resolver, 'scheduled_at')

            scheduled_at = None
            if isinstance(sv, _dt):
                scheduled_at = sv if sv.tzinfo is not None else sv.replace(tzinfo=_LOCAL_TZ)
            else:
                scheduled_at_raw = _s(sv)
                if scheduled_at_raw:
                    for fmt in (
                        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                        '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M', '%d-%m-%Y',
                        '%d-%m-%y %H:%M:%S', '%d-%m-%y %H:%M', '%d-%m-%y',
                        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%d/%m/%Y',
                        '%d/%m/%y %H:%M:%S', '%d/%m/%y %H:%M', '%d/%m/%y',
                    ):
                        try:
                            scheduled_at = _dt.strptime(scheduled_at_raw, fmt).replace(tzinfo=_LOCAL_TZ)
                            break
                        except ValueError:
                            continue
                    if scheduled_at is None:
                        row_errors.append({
                            'row': i,
                            'error': (
                                f'Unrecognised scheduled_at format {scheduled_at_raw!r}. '
                                'Use e.g. "2026-05-28 13:00", "28-05-2026 13:00", '
                                'or "28-05-26 13:00".'
                            ),
                        })
                        continue

            if scheduled_at is None:
                scheduled_at = _dt.combine(auto_day, time(9, 0), tzinfo=_LOCAL_TZ)
                auto_day += _td(days=1)

            if image_url_raw:
                raw_urls_to_resolve.append(image_url_raw)

            parsed_rows.append({
                'row_num': i,
                'content': content,
                'scheduled_at': scheduled_at,
                'image_url_raw': image_url_raw,
                'topic': _s(_row_get(row, resolver, 'topic'))[:64],
            })
            if content:
                seen_in_upload.add(content)

        # Lazy media: store the raw image_url cell as-is and defer the heavy
        # download + re-upload to SeaweedFS to publish time
        # (_ensure_scheduled_post_media_hosted). Keeps import instant even for
        # large videos / Drive folders.
        for pr in parsed_rows:
            i = pr['row_num']
            image_url_raw = pr['image_url_raw']
            image_urls = [image_url_raw] if image_url_raw else []

            obj = FacebookGroupScheduledPost.objects.create(
                group=group,
                content=pr['content'],
                image_urls=image_urls,
                topic=pr['topic'],
                scheduled_at=pr['scheduled_at'],
                status=FacebookScheduledPostStatus.PENDING,
                poster_fb_profile=group.default_poster_fb_profile,
                owner=request.user,
            )
            created_ids.append(obj.id)

        return Response({
            'created': len(created_ids),
            'skipped': skipped_rows,
            'errors': row_errors,
        })


# ── Facebook Graph API publisher ─────────────────────────────────────────────

def _download_image_bytes(image_url: str) -> tuple[bytes, str]:
    """Download image bytes for sending to Facebook.

    - Cloudfly S3 URL: download via boto3 credentials (private bucket, with
      built-in retry for transient errors). Do NOT fall back to plain HTTP —
      the bucket is private so anonymous GET would just return 403 and mask
      the real boto3 error.
    - Non-S3 URL: download via normal HTTP GET.

    Raises ``ValueError`` on failure.
    """
    import os as _os
    from urllib.parse import urlparse as _urlparse

    parsed = _urlparse(image_url)
    endpoint_host = _urlparse(getattr(settings, 'CLOUDFLY_S3_ENDPOINT', '')).netloc
    is_cloudfly_host = bool(endpoint_host) and parsed.netloc == endpoint_host

    from rest_framework.exceptions import APIException as _APIEx

    if is_cloudfly_host:
        try:
            return download_image_bytes_from_s3(image_url)
        except _APIEx as exc:
            # S3 read failure is treated as transient — the file exists (we just
            # uploaded it) but Cloudfly may be having a blip / consistency lag.
            # Scheduled-post handlers retry these until the cutoff window.
            raise TransientPublishError(str(exc)) from exc

    # SeaweedFS public host (SEAWEEDFS_PUBLIC_BASE_URL → e.g. media.example.com) is a
    # SEPARATE proxy box that goes down / is flaky; a plain HTTP GET there fails
    # exactly when it's down — which is what broke loading a character's face as a
    # generation reference. Fetch the bytes from the reliable S3 gateway
    # (SEAWEEDFS_S3_ENDPOINT) instead, so face reuse / FB media keeps working
    # regardless of the public proxy's health. Falls back to plain HTTP on any miss.
    seaweed_host = _urlparse(getattr(settings, 'SEAWEEDFS_PUBLIC_BASE_URL', '') or '').netloc
    if seaweed_host and parsed.netloc == seaweed_host:
        try:
            from facebook.seaweedfs_utils import _get_seaweedfs_client
            key = parsed.path.lstrip('/')                 # buckets/user-media/characters/…
            if key.startswith('buckets/'):
                key = key[len('buckets/'):]
            bucket = (getattr(settings, 'SEAWEEDFS_BUCKET', '') or '').strip('/')
            if bucket and key.startswith(bucket + '/'):
                key = key[len(bucket) + 1:]
            obj = _get_seaweedfs_client().get_object(Bucket=settings.SEAWEEDFS_BUCKET, Key=key)
            filename = _os.path.basename(key) or 'image.jpg'
            return obj['Body'].read(), filename
        except Exception as exc:  # noqa: BLE001 — last-resort: try plain HTTP below
            logger.warning('_download_image_bytes: SeaweedFS S3 fetch failed for %s (%s); trying HTTP', image_url, exc)

    try:
        resp = http_requests.get(image_url, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        raise ValueError(f'Failed to download image from URL: {exc}') from exc
    filename = _os.path.basename(parsed.path.split('?')[0]) or 'image.jpg'
    return resp.content, filename


_VIDEO_URL_RE = re.compile(r'\.(mp4|mov|webm|m4v|avi|mkv)(\?|$)', re.IGNORECASE)


def _is_video_url(url: str) -> bool:
    return bool(_VIDEO_URL_RE.search(url or ''))


def _sort_post_media_videos_first(s3_urls: list[str]) -> list[str]:
    """Reorder S3 media URLs so the video (if any) comes first, then images.

    Used by the CSV import path so a cell that resolves to ``[image, video,
    image]`` is normalised to ``[video, image, image]`` — FB shows the lead
    video as the main media block on the published post.

    Raises ``ValueError`` if more than one video is present; FB allows at most
    one video per post. Caller should report this as a row-level error and
    skip creating the scheduled post.
    """
    videos = [u for u in s3_urls if _is_video_url(u)]
    images = [u for u in s3_urls if not _is_video_url(u)]
    if len(videos) > 1:
        raise ValueError(
            f'Bài đăng chỉ cho phép tối đa 1 video — cell này resolve ra '
            f'{len(videos)} video. Tách thành nhiều bài hoặc xoá bớt video.'
        )
    return videos + images


class TransientPublishError(Exception):
    """Raised when a transient infrastructure error (S3 read timeout, Cloudfly
    5xx, network blip) prevents publish. Scheduled-post handlers treat this
    specially: the post stays PENDING (no status change) so the next cron tick
    retries — up to a cutoff window past ``scheduled_at`` (see
    ``_handle_scheduled_publish_exception``).
    """


class DeviceBusyError(TransientPublishError):
    """Raised at dispatch time when the target device is already running another
    phoneagent task. A physical device runs ONE task at a time, so pushing a
    second one just collides on-device ("Failed to get state … Portal").

    Subclasses ``TransientPublishError`` so scheduled flows treat it as
    retryable (post stays PENDING for the next tick); manual endpoints surface
    it as a 409 so the user knows to wait for the current task to finish.
    """


def _device_is_busy(device_id) -> bool:
    """Thin alias kept for existing call sites — delegates to the shared
    ``task.device_lock.device_is_busy`` (single source of truth for the lock)."""
    return device_is_busy(device_id)


# How long after scheduled_at we keep retrying transient errors before giving
# up and marking the post FAILED.
_TRANSIENT_RETRY_CUTOFF = timedelta(minutes=10)


def _humanize_post_error(raw: str) -> str:
    """Rewrite raw phoneagent error strings into Vietnamese explanations.

    Known patterns:
      * ``s3.cloudfly.vn/<bucket>/uc?X-Amz-...`` → Drive chip in sheet pointed
        to a missing/private/>100MB file. The S3 sign step coerced the bogus
        ``/uc`` path into a presigned URL with key ``uc`` which 404s.
    """
    if not raw:
        return raw
    if 's3.cloudfly.vn' in raw and '/uc?X-Amz-' in raw:
        return (
            'Không tải được file media từ Google Drive. File có thể đã bị xoá, '
            'chưa share "Anyone with the link", hoặc lớn hơn 100MB (Drive chặn '
            'tải qua API key). Mở sheet, kiểm tra cell image_url của row này.'
        )
    return raw


def _handle_scheduled_publish_exception(post, exc) -> None:
    """Common transient/permanent dispatch for scheduled-post publish failures.

    - ``TransientPublishError`` within cutoff → save error_msg only, keep
      PENDING so the cron retries on next tick.
    - ``TransientPublishError`` past cutoff → mark FAILED with cutoff message.
    - Other ``ValueError`` → mark FAILED as a permanent error.

    Caller should re-raise after calling so the cron logs the exception.
    """
    if isinstance(exc, TransientPublishError):
        cutoff = post.scheduled_at + _TRANSIENT_RETRY_CUTOFF
        if timezone.now() < cutoff:
            # Reset to PENDING so the next tick retries. The scheduler poll flips
            # PENDING→PUBLISHING via an atomic claim BEFORE calling publish, so a
            # transient failure (e.g. device busy in a race) must roll that back
            # here — otherwise the post would be stranded in PUBLISHING forever.
            post.status = FacebookScheduledPostStatus.PENDING
            post.error_msg = f'(retrying) {exc}'
            post.save(update_fields=['status', 'error_msg', 'updated_at'])
            return
        post.status = FacebookScheduledPostStatus.FAILED
        post.error_msg = f'Đã quá {int(_TRANSIENT_RETRY_CUTOFF.total_seconds() // 60)} phút từ giờ đặt lịch, dừng retry. Lỗi cuối: {exc}'
        post.save(update_fields=['status', 'error_msg', 'updated_at'])
        return

    # Permanent failure: token sai, content bị reject, etc.
    post.status = FacebookScheduledPostStatus.FAILED
    post.error_msg = str(exc)
    post.save(update_fields=['status', 'error_msg', 'updated_at'])


def _enqueue_scheduled_now(post) -> None:
    """Queue *post* for the device-locked scheduler poll: mark it due now and
    PENDING so it dispatches as soon as the device is free.

    Used by "Đăng ngay" when the device is mid-task — instead of rejecting the
    click, we save it and the post is published in turn (one per device), so the
    user can fire several at once and they drain sequentially.
    """
    post.status = FacebookScheduledPostStatus.PENDING
    post.scheduled_at = timezone.now()
    post.error_msg = ''
    post.save(update_fields=['status', 'scheduled_at', 'error_msg', 'updated_at'])


# Friendly message shown when a manual "Đăng ngay" is queued behind a busy device.
_QUEUED_DETAIL = 'Thiết bị đang bận — đã thêm vào hàng đợi, sẽ tự đăng khi máy rảnh.'

# Message khi "Đăng ngay" được đẩy sang nền vì media còn phải tải + re-host.
_QUEUED_MEDIA_DETAIL = (
    'Media (video/ảnh) đang được tải và xử lý ở nền — bài sẽ tự đăng ngay sau khi '
    'chuẩn bị xong (thường trong khoảng 1 phút). Anh không cần chờ ở đây.'
)


def _needs_media_rehost(post) -> bool:
    """True khi *post* còn media nguồn ngoài (Drive/CDN) CHƯA nằm trên SeaweedFS.

    Publish một post như vậy phải TẢI + re-host (Drive có thể bị throttle xuống
    ~80 KB/s cho video 50-100MB) — việc nặng đó KHÔNG được chạy trong luồng HTTP
    của "Đăng ngay": gunicorn giết worker ở 300s → trình duyệt báo "Failed to
    fetch", còn UI thì quay chờ cả phút. Khi hàm này True, caller đẩy post sang
    hàng đợi scheduler (``_enqueue_scheduled_now``) để tải ở nền và trả về ngay.

    Lưu ý: một video đã được cache (HostedMediaCache) vẫn tính là "cần re-host" ở
    đây, vì ``post.image_urls`` vẫn giữ link Drive gốc cho tới khi publish thành
    công ghi đè. Nhưng nhờ dedup, bước re-host ở nền khi đó là cache HIT (~1s),
    nên post vẫn lên gần như tức thì ở lần poll kế tiếp.
    """
    urls = list(getattr(post, 'image_urls', None) or [])
    if not urls:
        single = getattr(post, 'image_url', '') or ''
        if single:
            urls = [single]
    return any(u and str(u).strip() and not _is_already_hosted_media(u) for u in urls)


def _fb_video_json_or_raise(resp, phase: str) -> dict:
    """Parse a graph-video response; raise a clear ValueError on error. Falls back
    to ``resp.text`` / the HTTP status when FB returns an error with no message
    (large uploads sometimes reply with an empty body)."""
    try:
        data = resp.json()
    except Exception:
        data = {}
    if not resp.ok or 'error' in data:
        err = (data.get('error') or {}).get('message') or resp.text or f'HTTP {resp.status_code}'
        raise ValueError(f'Facebook API error (video {phase}): {err}')
    return data


def _publish_video_to_facebook(uid: str, access_token: str, video_url: str, description: str) -> dict:
    """Publish one video to a Page/Group via the RESUMABLE upload protocol
    (``start`` → ``transfer`` chunks → ``finish``).

    The old single-shot ``source`` multipart upload silently fails for large/long
    videos (~100MB+): FB rejects them, often with an empty error body. Resumable
    upload streams the file in the offsets FB dictates, so any size/length works.
    """
    vid_bytes, filename = _download_image_bytes(video_url)
    file_size = len(vid_bytes)
    base_url = f'https://graph-video.facebook.com/v19.0/{uid}/videos'

    # 1) start — reserve an upload session; FB returns the first offset window.
    resp = http_requests.post(
        base_url,
        data={'upload_phase': 'start', 'file_size': str(file_size), 'access_token': access_token},
        timeout=60,
    )
    data = _fb_video_json_or_raise(resp, 'start')
    session_id = data['upload_session_id']
    video_id = data.get('video_id')
    start_offset = int(data['start_offset'])
    end_offset = int(data['end_offset'])

    # 2) transfer — send the bytes FB asks for each round until offsets meet.
    while start_offset < end_offset:
        chunk = vid_bytes[start_offset:end_offset]
        resp = http_requests.post(
            base_url,
            data={
                'upload_phase': 'transfer',
                'upload_session_id': session_id,
                'start_offset': str(start_offset),
                'access_token': access_token,
            },
            files={'video_file_chunk': (filename, chunk)},
            timeout=600,
        )
        data = _fb_video_json_or_raise(resp, 'transfer')
        start_offset = int(data['start_offset'])
        end_offset = int(data['end_offset'])

    # 3) finish — publish with the caption.
    resp = http_requests.post(
        base_url,
        data={
            'upload_phase': 'finish',
            'upload_session_id': session_id,
            'description': description,
            'access_token': access_token,
        },
        timeout=120,
    )
    _fb_video_json_or_raise(resp, 'finish')
    # finish returns {"success": true}; the published id is video_id from `start`.
    return {'id': video_id, 'post_id': video_id}


def _upload_unpublished_photo(uid: str, access_token: str, image_url: str) -> str:
    """Upload one image to /photos with ``published=false`` and return media_fbid."""
    img_bytes, filename = _download_image_bytes(image_url)
    resp = http_requests.post(
        f'https://graph.facebook.com/v19.0/{uid}/photos',
        data={'published': 'false', 'access_token': access_token},
        files={'source': (filename, img_bytes)},
        timeout=120,
    )
    try:
        data = resp.json()
    except Exception:
        data = {}
    if not resp.ok or 'error' in data or not data.get('id'):
        error_msg = (data.get('error') or {}).get('message') or resp.text
        raise ValueError(f'Facebook API error (photo upload): {error_msg}')
    return data['id']


def _publish_photos_to_feed(uid: str, access_token: str, message: str, image_urls: list[str]) -> dict:
    """Publish N images as ONE /feed post: each uploaded ``published=false`` then
    attached via ``attached_media``. Photos are the only media type
    ``attached_media`` accepts — a video there fails with
    ``(#10) ... permission``, so videos go through ``_publish_video_to_facebook``.
    """
    attached_media = []
    for url in image_urls:
        media_fbid = _upload_unpublished_photo(uid, access_token, url)
        attached_media.append({'media_fbid': media_fbid})

    feed_data = {'message': message, 'access_token': access_token}
    for idx, item in enumerate(attached_media):
        feed_data[f'attached_media[{idx}]'] = json.dumps(item)
    resp = http_requests.post(
        f'https://graph.facebook.com/v19.0/{uid}/feed',
        data=feed_data,
        timeout=120,
    )
    try:
        data = resp.json()
    except Exception:
        data = {}
    if not resp.ok or 'error' in data:
        error_msg = (data.get('error') or {}).get('message') or resp.text
        raise ValueError(f'Facebook API error: {error_msg}')
    return data


def _publish_page_content(page: FacebookPage, content: str, image_urls: list[str] | None = None) -> dict:
    """Publish text/image/video content to a Facebook page and return Graph API JSON.

    When media is supplied it is downloaded server-side and streamed to
    Facebook as multipart/form-data. A post may contain N images, OR 1 video,
    OR 1 video + N images (uploaded as ``published=false`` then attached via
    ``attached_media`` in a single /feed post).

    Raises ``ValueError`` when token/config/content is invalid or the API
    returns an error payload.
    """
    if not page.page_token:
        raise ValueError('Page token is not configured for this page.')

    message = (content or '').strip()
    if not message:
        raise ValueError('Post content is required.')

    page_uid = page.page_uid or str(page.id)
    access_token = page.page_token
    image_urls = [u for u in (image_urls or []) if u]

    videos = [u for u in image_urls if _is_video_url(u)]
    images = [u for u in image_urls if not _is_video_url(u)]
    if len(videos) > 1:
        raise ValueError('Only one video per post is supported.')

    # Video MUST go through /{page}/videos directly — Facebook rejects a video
    # attached via ``attached_media`` on /feed with "(#10) ... does not have
    # permission". A short video there also becomes a Reel; that's unavoidable
    # via the API. When a post carries a video AND images, they can't share one
    # post, so the images are published as a SEPARATE photo post.
    if videos:
        video_data = _publish_video_to_facebook(page_uid, access_token, videos[0], message)
        if images:
            try:
                _publish_photos_to_feed(page_uid, access_token, message, images)
            except Exception as exc:  # noqa: BLE001 — video is already up; failing here
                # would retry and double-post the video. Log and keep the success.
                logger.warning('[_publish_page_content] video đã đăng nhưng bài ảnh riêng lỗi: %s', exc)
        return video_data

    if images:
        return _publish_photos_to_feed(page_uid, access_token, message, images)

    resp = http_requests.post(
        f'https://graph.facebook.com/v19.0/{page_uid}/feed',
        data={
            'message': message,
            'access_token': access_token,
        },
        timeout=60,
    )
    try:
        data = resp.json()
    except Exception:
        data = {}
    if not resp.ok or 'error' in data:
        error_msg = (data.get('error') or {}).get('message') or resp.text
        raise ValueError(f'Facebook API error: {error_msg}')
    return data


def _is_already_hosted_media(url: str) -> bool:
    """True when *url* already points at OUR storage — the SeaweedFS Filer or
    the Cloudfly S3 bucket (re-hosted on a prior import/attempt, or created via
    the UI). Such URLs must NOT be re-downloaded at publish time: the Cloudfly
    bucket is private so a plain GET 403s. They are presigned host-aware at
    dispatch instead (get_presigned_image_url). Only genuinely external/raw URLs
    (Drive, public CDN) are re-hosted lazily here.
    """
    if not url or not isinstance(url, str):
        return False
    from urllib.parse import urlparse
    base = (getattr(settings, 'SEAWEEDFS_PUBLIC_BASE_URL', '') or '').rstrip('/')
    if base and url.startswith(base):
        return True
    cloudfly_host = urlparse(getattr(settings, 'CLOUDFLY_S3_ENDPOINT', '') or '').netloc
    return bool(cloudfly_host) and urlparse(url).netloc == cloudfly_host


def _rehost_media_cached(src: str) -> str:
    """Re-host *src* to SeaweedFS, reusing an earlier hosted copy when the same
    source was already downloaded (``HostedMediaCache``).

    Đây là chốt chặn throttle của Drive: cùng một video lịch cho N bài giờ chỉ
    tải từ Drive ĐÚNG 1 lần; các bài sau lấy thẳng link SeaweedFS. Khoá cache =
    sha256(src) vì ``src`` deterministic theo Drive file id
    (``drive.usercontent.google.com/download?id=<id>&...``).

    Cache HIT vẫn kiểm tra tồn tại: nếu file SeaweedFS đã bị dọn (cleanup_post_media)
    → coi như miss và re-host, để không trả về link chết. Chỉ coi là chết khi
    nhận 404/410 dứt khoát; lỗi mạng tạm thời thì vẫn tin cache (FB publish tự báo
    lỗi nếu link thật sự hỏng).
    """
    import hashlib  # noqa: PLC0415
    from .models import HostedMediaCache  # noqa: PLC0415
    from .seaweedfs_utils import download_and_upload_to_seaweedfs  # noqa: PLC0415

    key = hashlib.sha256(src.encode('utf-8')).hexdigest()
    row = HostedMediaCache.objects.filter(source_key=key).first()
    if row and row.hosted_url:
        if _hosted_media_missing(row.hosted_url):
            logger.warning('[media-cache] STALE %s -> %s (đã bị dọn), re-host', src[:80], row.hosted_url)
            row.delete()
        else:
            logger.info('[media-cache] HIT %s -> %s', src[:80], row.hosted_url)
            return row.hosted_url

    hosted = download_and_upload_to_seaweedfs(src)  # có thể raise → caller bọc thành ValueError
    HostedMediaCache.objects.get_or_create(
        source_key=key,
        defaults={'source_url': src, 'hosted_url': hosted},
    )
    logger.info('[media-cache] STORE %s -> %s', src[:80], hosted)
    return hosted


def _hosted_media_missing(hosted_url: str) -> bool:
    """True chỉ khi SeaweedFS trả 404/410 dứt khoát cho *hosted_url*. Lỗi mạng /
    timeout → False (tin cache, tránh tải lại Drive oan)."""
    try:
        resp = http_requests.head(hosted_url, timeout=10, allow_redirects=True)
        return resp.status_code in (404, 410)
    except http_requests.RequestException:
        return False


def _resolve_scheduled_post_media_for_publish(image_urls: list[str]) -> list[str]:
    """Lazily re-host a scheduled post's media at *publish* time.

    CSV import stores the **raw** image_url cell (Drive file/folder links,
    public URLs) without downloading anything, so import stays instant even for
    large videos. The heavy download + re-upload to SeaweedFS is deferred to
    here — the moment the post is actually published.

    URLs already on SeaweedFS (re-hosted on a previous attempt, or created via
    the UI) pass straight through, so this is idempotent across publish retries.

    Raises ``ValueError`` if a source fails to expand/download so the caller can
    mark the post FAILED with a readable message.
    """
    if not image_urls:
        return []

    # Fast path: nothing to do (UI-created posts, or a retry after re-host).
    if all(_is_already_hosted_media(u) for u in image_urls):
        return image_urls

    resolved: list[str] = []
    for entry in image_urls:
        if not entry or not str(entry).strip():
            continue
        if _is_already_hosted_media(entry):
            resolved.append(entry)
            continue
        try:
            sources = _expand_media_url_for_import(entry)
        except Exception as exc:
            raise ValueError(f'Không mở rộng được media {entry!r}: {exc}') from exc
        for src in sources:
            try:
                resolved.append(_rehost_media_cached(src))
            except Exception as exc:
                raise ValueError(f'Không tải/đăng media {src!r}: {exc}') from exc

    return _sort_post_media_videos_first(resolved)


def _ensure_scheduled_post_media_hosted(post) -> None:
    """Resolve + re-host ``post.image_urls`` in place (lazy import) and persist.

    No-op when the media is already hosted, so safe to call on every publish
    attempt. Raises ``ValueError`` (from the resolver) on media failure.
    """
    original = list(post.image_urls or [])
    resolved = _resolve_scheduled_post_media_for_publish(original)
    if resolved != original:
        post.image_urls = resolved
        post.save(update_fields=['image_urls', 'updated_at'])


def _publish_to_facebook(post: 'FacebookScheduledPost') -> None:
    """Call the Facebook Graph API to publish *post* to its page.

    Mutates *post*.status (PUBLISHED / FAILED) and saves to DB.
    Raises ``ValueError`` on API error or ``TransientPublishError`` on
    infrastructure blip (post stays PENDING for cron to retry).
    """
    try:
        _ensure_scheduled_post_media_hosted(post)
        data = _publish_page_content(post.page, post.content, post.image_urls)
    except (ValueError, TransientPublishError) as exc:
        _handle_scheduled_publish_exception(post, exc)
        raise

    post.status = FacebookScheduledPostStatus.PUBLISHED
    post.fb_post_id = data.get('post_id') or data.get('id') or ''
    post.error_msg = ''
    post.save(update_fields=['status', 'fb_post_id', 'error_msg', 'updated_at'])

    # Free S3 bytes — best-effort, doesn't block. cleanup_post_media skips
    # URLs still referenced by other (PENDING/PUBLISHING) scheduled rows.
    try:
        from .s3_utils import cleanup_post_media
        cleanup_post_media(post.image_urls, exclude=post)
    except Exception:
        logger.warning('S3 cleanup failed for FB page post %s', post.id, exc_info=True)

    owner = post.owner or post.page.owner
    image_url = (post.image_urls or [''])[0] if post.image_urls else ''
    post_url = f'https://www.facebook.com/{post.fb_post_id}' if post.fb_post_id else ''

    existing_post = None
    if owner and post_url:
        existing_post = FacebookPost.objects.filter(
            owner=owner,
            page=post.page,
            post_url=post_url,
        ).first()

    if existing_post:
        existing_post.content = post.content
        existing_post.image_url = image_url
        existing_post.status = FacebookPostStatus.SHARED
        existing_post.save(update_fields=['content', 'image_url', 'status', 'updated_at'])
    else:
        FacebookPost.objects.create(
            page=post.page,
            post_url=post_url,
            image_url=image_url,
            caption='',
            content=post.content,
            keywords=[],
            status=FacebookPostStatus.SHARED,
            owner=owner,
        )


def _safe_cleanup_post_media(post, label: str) -> None:
    """Wrap ``cleanup_post_media`` so caller never has to think about errors.

    *label* goes into log lines so we can tell which surface (page/group/
    profile/media-action) the cleanup belonged to when something fails.
    """
    try:
        from .s3_utils import cleanup_post_media
        media = getattr(post, 'image_urls', None)
        if media is None:
            media = getattr(post, 'image_url', None)
        cleanup_post_media(media, exclude=post)
    except Exception:
        logger.warning('S3 cleanup failed (%s post %s)', label, getattr(post, 'id', '?'), exc_info=True)


class FacebookScheduledPostViewSet(viewsets.ModelViewSet):
    """CRUD for FacebookScheduledPost.  Also exposes /publish-due/ action."""

    serializer_class = FacebookScheduledPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content']
    ordering_fields = ['scheduled_at', 'created_at', 'status']
    ordering = ['scheduled_at']

    def get_queryset(self):
        qs = FacebookScheduledPost.objects.filter(owner=self.request.user).select_related('page')
        page_id = self.request.query_params.get('page')
        status_param = self.request.query_params.get('status')
        if page_id:
            qs = qs.filter(page_id=page_id)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        _safe_cleanup_post_media(instance, 'page-scheduled')
        super().perform_destroy(instance)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        """Publish a single scheduled post immediately."""
        post = self.get_object()
        if post.status == FacebookScheduledPostStatus.PUBLISHED:
            return Response({'detail': 'This scheduled post is already published.'}, status=status.HTTP_400_BAD_REQUEST)
        if post.status == FacebookScheduledPostStatus.PUBLISHING:
            return Response(
                {'detail': 'Bài đăng đang được phoneagent xử lý, chờ kết quả.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if post.status == FacebookScheduledPostStatus.CANCELLED:
            return Response({'detail': 'Cancelled scheduled post cannot be published.'}, status=status.HTTP_400_BAD_REQUEST)

        # Media còn phải tải + re-host → đẩy sang nền, đừng chặn request (xem
        # _needs_media_rehost). Poll của scheduler sẽ tải và đăng.
        if _needs_media_rehost(post):
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_MEDIA_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )

        try:
            _publish_to_facebook(post)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                'detail': 'Scheduled post published successfully.',
                'scheduled_post_id': post.id,
                'facebook_post_id': post.fb_post_id,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=['post'], url_path='publish-due', url_name='publish-due')
    def publish_due(self, request):
        """Publish all *pending* scheduled posts whose ``scheduled_at`` is in the past."""
        now = timezone.now()
        due_posts = FacebookScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__lte=now,
        ).select_related('page')

        published_count = 0
        failed_count = 0

        for post in due_posts:
            try:
                _publish_to_facebook(post)
                published_count += 1
            except Exception:
                failed_count += 1

        return Response({'published': published_count, 'failed': failed_count})

    @action(detail=False, methods=['post'], url_path='delete-pending', url_name='delete-pending')
    def delete_pending(self, request):
        """Delete all pending scheduled posts for the current user.

        Optional filters:
          - page (query or body): limit deletion to one Facebook page id
        """
        page_id = request.query_params.get('page') or request.data.get('page')
        qs = FacebookScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
        )
        if page_id:
            qs = qs.filter(page_id=page_id)

        # Cleanup S3 BEFORE bulk delete (qs.delete() bypasses perform_destroy).
        for post in qs:
            _safe_cleanup_post_media(post, 'page-scheduled')
        deleted_count, _ = qs.delete()
        return Response({'deleted': deleted_count}, status=status.HTTP_200_OK)


class FacebookPostViewSet(viewsets.ModelViewSet):
    serializer_class = FacebookPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content', 'post_url', 'caption']
    ordering_fields = ['created_at', 'updated_at', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookPost.objects.filter(owner=self.request.user).select_related('page')
        page_id = self.request.query_params.get('page')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        if page_id:
            qs = qs.filter(page_id=page_id)
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(
        detail=False,
        methods=['post'],
        url_path='upload-image',
        url_name='upload-image',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    def upload_image(self, request):
        image_file = request.FILES.get('file')
        if not image_file:
            return Response({'detail': 'No image file provided.'}, status=status.HTTP_400_BAD_REQUEST)

        # Upload to SeaweedFS – public Filer URL returned, no presigning needed.
        image_url = upload_to_seaweedfs(image_file, image_file.name)
        return Response({'image_url': get_seaweedfs_url(image_url)}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        """Publish this post immediately to its Facebook page via Graph API."""
        post = self.get_object()
        publish_content = (post.content or post.caption or '').strip()
        if not publish_content:
            return Response({'detail': 'Post content is required.'}, status=status.HTTP_400_BAD_REQUEST)

        images = list(post.image_urls or [])
        if not images and post.image_url:
            images = [post.image_url]
        try:
            data = _publish_page_content(post.page, publish_content, images or None)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        fb_post_id = data.get('post_id') or data.get('id') or ''
        update_fields = ['status', 'updated_at']
        post.status = FacebookPostStatus.SHARED
        if fb_post_id:
            post.post_url = f'https://www.facebook.com/{fb_post_id}'
            update_fields.append('post_url')
        post.save(update_fields=update_fields)

        return Response({
            'detail': 'Post published successfully.',
            'facebook_post_id': fb_post_id,
            'post_url': post.post_url,
        })

    # ── Comment-plan dispatch helpers ────────────────────────────────────────

    @staticmethod
    def _build_facebook_comment_task_description(post_url: str, comment_content: str) -> str:
        return (
            f'Hãy mở Facebook và bình luận vào bài đăng {post_url} với nội dung {comment_content}'
        )

    def _create_schedules_for_approved_comment_plan(self, plan: FacebookCommentPlan, owner) -> int:
        if not plan.device_id:
            return 0

        post_url = plan.post_link or (plan.post.post_url if plan.post else '') or ''
        comment_content = (plan.comment_content or '').strip()
        if not post_url or not comment_content:
            return 0

        from devices.models import Device
        device_serial = (
            Device.objects.filter(id=plan.device_id)
            .values_list('device_serial_id', flat=True)
            .first() or ''
        )

        count = 0
        profiles = list(Profile.objects.filter(device_id=plan.device_id).order_by('id'))
        if not plan.profile_id and profiles:
            plan.profile_id = profiles[0].id
            plan.save(update_fields=['profile', 'updated_at'])

        for profile in profiles:
            task = Task.objects.create(
                name=f'Facebook comment - {profile.name}',
                description=self._build_facebook_comment_task_description(post_url, comment_content),
                task_type=TaskType.GENERIC,
                status=TaskStatus.PENDING,
                payload={
                    'agent': 'facebook',
                    'post_url': post_url,
                    'comment_content': comment_content,
                    'profile_id': profile.id,
                    'device_id': plan.device_id,
                },
                device_id=plan.device_id,
                device_serial=device_serial,
                owner=owner,
            )
            self._create_schedule_for_profile(task, profile)
            count += 1
        return count

    @staticmethod
    def _create_schedule_for_profile(task, profile) -> Schedule:
        run_at = None
        now = timezone.now()

        try:
            from profiles.utils import get_auto_schedule_params

            auto_params = get_auto_schedule_params(profile)
            if isinstance(auto_params, dict) and auto_params.get('run_at'):
                raw_run_at = auto_params.get('run_at')
                parsed = raw_run_at if isinstance(raw_run_at, datetime) else parse_datetime(str(raw_run_at))
                if parsed is not None:
                    if timezone.is_naive(parsed):
                        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
                    if parsed > now:
                        run_at = parsed
        except RuntimeError:
            logger.warning('auto_schedule: invalid run_at for ONCE comment task %s / profile %s', task.pk, profile.pk)

        if run_at is None:
            from profiles.models import ProfileRoutine

            current_local_time = timezone.localtime(now).time().replace(tzinfo=None)
            next_routine = (
                ProfileRoutine.objects
                .filter(profile=profile, schedule_time__gt=current_local_time)
                .order_by('schedule_time')
                .first()
            )
            run_day_offset = 0
            if next_routine is None:
                next_routine = ProfileRoutine.objects.filter(profile=profile).order_by('schedule_time').first()
                run_day_offset = 1
            if next_routine:
                run_at = timezone.make_aware(
                    datetime.combine(now.date() + timedelta(days=run_day_offset), next_routine.schedule_time),
                    timezone.get_current_timezone(),
                )

        if run_at is None:
            run_at = now + timedelta(hours=1)

        return Schedule.objects.create(
            task=task,
            profile=profile,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
        )

    # ── Interactions ─────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='interactions')
    def interactions(self, request, pk=None):
        post = self.get_object()

        if request.method == 'GET':
            qs = post.interactions.all()
            interaction_type = request.query_params.get('type')
            if interaction_type:
                qs = qs.filter(interaction_type=interaction_type)
            return Response(FacebookPostInteractionSerializer(qs, many=True).data)

        serializer = FacebookPostInteractionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        interaction = serializer.save(post=post)
        _sync_approved_comment_plan(post=post, interaction=interaction, owner=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    # ── Comment scraping (external crawler) ──────────────────────────────────

    @action(detail=True, methods=['get'], url_path='post-comments')
    def post_comments(self, request, pk=None):
        """List comments scraped from this post."""
        post = self.get_object()
        return Response(FacebookPostUserCommentSerializer(post.user_comments.all(), many=True).data)

    @action(detail=True, methods=['post'], url_path='fetch-comments')
    def fetch_comments(self, request, pk=None):
        """Call the external crawler to scrape this post's comments and store them."""
        post = self.get_object()
        if not post.post_url:
            return Response({'detail': 'post_url is empty. Cannot fetch comments without a URL.'},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            comments = _call_facebook_comment_api(
                post.post_url,
                int(request.data.get('max_comments', 100)),
                bool(request.data.get('include_replies', True)),
                int(request.data.get('num_sessions', 1)),
            )
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        saved = _upsert_post_comments(post, comments)
        qs = post.user_comments.all()
        return Response({'saved': saved, 'total': qs.count(), 'comments': FacebookPostUserCommentSerializer(qs, many=True).data})

    @action(detail=True, methods=['post'], url_path='cluster-comments')
    def cluster_comments(self, request, pk=None):
        """Cluster this page post's scraped comments into semantic groups."""
        post = self.get_object()
        comments = [t.strip() for t in post.user_comments.values_list('text', flat=True) if (t or '').strip()]
        if not comments:
            return Response({'detail': 'Chưa có bình luận. Hãy bấm "Lấy bình luận" trước.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = _cluster_comment_texts(comments)
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'source_comments': len(comments), **result})

    @action(detail=True, methods=['post'], url_path='dig-comment')
    def dig_comment(self, request, pk=None):
        """Fetch this post's comments and find the one matching a given interaction
        (>=98% text similarity), then write its link back to the interaction and plan.

        Body: interaction_id (int, required), comment_plan_id (int, optional)
        """
        post = self.get_object()
        raw_interaction_id = request.data.get('interaction_id')
        raw_comment_plan_id = request.data.get('comment_plan_id')
        if not raw_interaction_id:
            return Response({'detail': 'interaction_id is required.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            interaction_id = int(raw_interaction_id)
        except (TypeError, ValueError):
            return Response({'detail': 'interaction_id must be an integer.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            interaction = FacebookPostInteraction.objects.get(
                id=interaction_id,
                post=post,
                interaction_type=FacebookInteractionType.COMMENT,
                post__owner=request.user,
            )
        except FacebookPostInteraction.DoesNotExist:
            return Response({'detail': 'Interaction not found.'}, status=status.HTTP_404_NOT_FOUND)

        comment_content = (interaction.comment_content or '').strip()
        if not comment_content:
            return Response({'detail': 'Interaction has no comment content to match against.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if not post.post_url:
            return Response({'detail': 'post_url is empty. Cannot fetch comments without a URL.'},
                            status=status.HTTP_400_BAD_REQUEST)

        try:
            comments = _call_facebook_comment_api(post.post_url, DIG_COMMENT_MAX_FETCH, True, 1)
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        _upsert_post_comments(post, comments)

        # Mark this interaction as dug (shared highlight), regardless of match.
        if not interaction.dig_comment_dispatched:
            interaction.dig_comment_dispatched = True
            interaction.save(update_fields=['dig_comment_dispatched'])

        best_match, best_ratio = None, 0.0
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            text = str(comment.get('text') or '').strip()
            if not text:
                continue
            ratio = SequenceMatcher(None, comment_content, text).ratio()
            if ratio > best_ratio:
                best_ratio, best_match = ratio, comment

        if best_match is None or best_ratio < DIG_COMMENT_SIMILARITY_THRESHOLD:
            return Response({'matched': False, 'comment_link': None, 'similarity': round(best_ratio, 4),
                             'interaction_id': interaction.id, 'comment_plan_id': raw_comment_plan_id})

        share_info = (best_match.get('raw') or {}).get('share_info') or {}
        matched_link = str(share_info.get('url') or '').strip() or None
        if not matched_link:
            return Response({'matched': True, 'comment_link': None, 'similarity': round(best_ratio, 4),
                             'interaction_id': interaction.id, 'comment_plan_id': raw_comment_plan_id})

        interaction.comment_link = matched_link
        interaction.save(update_fields=['comment_link'])

        updated_plan = False
        if raw_comment_plan_id:
            try:
                plan = FacebookCommentPlan.objects.get(id=int(raw_comment_plan_id), post=post)
                plan.comment_link = matched_link
                plan.save(update_fields=['comment_link', 'updated_at'])
                updated_plan = True
            except (FacebookCommentPlan.DoesNotExist, TypeError, ValueError):
                pass

        return Response({'matched': True, 'comment_link': matched_link, 'similarity': round(best_ratio, 4),
                         'interaction_id': interaction.id, 'comment_plan_id': raw_comment_plan_id,
                         'updated_plan': updated_plan})

    # ── Comment plans ────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='comment-plans')
    def comment_plans(self, request, pk=None):
        post = self.get_object()

        if request.method == 'GET':
            qs = post.comment_plans.filter(owner=request.user)
            return Response(FacebookCommentPlanSerializer(qs, many=True).data)

        serializer = FacebookCommentPlanSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save(
            post=post,
            owner=request.user,
            post_link=request.data.get('post_link') or post.post_url or '',
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='comment-plans/approve-all')
    def approve_all_comment_plans(self, request, pk=None):
        post = self.get_object()
        plans = list(post.comment_plans.filter(owner=request.user, is_approved=False).select_related('post'))
        count = 0
        for plan in plans:
            plan.is_approved = True
            plan.save(update_fields=['is_approved', 'updated_at'])
            self._create_schedules_for_approved_comment_plan(plan, request.user)
            count += 1
        return Response({'approved': count})

    @action(detail=True, methods=['post'], url_path='dispatch-comments')
    def dispatch_comments(self, request, pk=None):
        """Create one comment plan per selected device for this post.

        Body:
          comment_content (str, required)
          agent_group     (int, optional)
          devices         (list[int], optional) – one plan per device
          reply_to        (str, optional)
          auto_approve    (bool, optional) – approve immediately (creates tasks)
        """
        post = self.get_object()
        comment_content = (request.data.get('comment_content') or '').strip()
        if not comment_content:
            return Response({'detail': 'comment_content is required.'}, status=status.HTTP_400_BAD_REQUEST)

        agent_group_id = request.data.get('agent_group')
        devices = request.data.get('devices') or []
        reply_to = request.data.get('reply_to') or ''
        auto_approve = bool(request.data.get('auto_approve', False))

        if not isinstance(devices, list):
            return Response({'detail': 'devices must be a list.'}, status=status.HTTP_400_BAD_REQUEST)

        # Validate ownership of agent_group / devices.
        if agent_group_id is not None:
            from agent_groups.models import AgentGroup
            if not AgentGroup.objects.filter(id=agent_group_id, owner=request.user).exists():
                return Response({'detail': 'Invalid agent_group.'}, status=status.HTTP_400_BAD_REQUEST)

        device_ids = []
        for raw in devices:
            try:
                device_ids.append(int(raw))
            except (TypeError, ValueError):
                return Response({'detail': 'devices must be a list of integers.'}, status=status.HTTP_400_BAD_REQUEST)
        if device_ids:
            from devices.models import Device
            owned = set(Device.objects.filter(id__in=device_ids, owner=request.user).values_list('id', flat=True))
            invalid = [d for d in device_ids if d not in owned]
            if invalid:
                return Response({'detail': f'Invalid devices: {invalid}'}, status=status.HTTP_400_BAD_REQUEST)

        # One plan per device; if no device given, create a single unassigned plan.
        targets = device_ids or [None]
        created = []
        for device_id in targets:
            plan = FacebookCommentPlan.objects.create(
                post=post,
                post_link=post.post_url or '',
                agent_group_id=agent_group_id,
                device_id=device_id,
                comment_content=comment_content,
                reply_to=reply_to,
                is_approved=auto_approve,
                owner=request.user,
            )
            if auto_approve:
                self._create_schedules_for_approved_comment_plan(plan, request.user)
            created.append(plan)

        return Response(
            {
                'detail': 'Comment plans created.',
                'comment_plans': FacebookCommentPlanSerializer(created, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['patch', 'delete'], url_path=r'comment-plans/(?P<plan_id>[^/.]+)')
    def comment_plan_detail(self, request, pk=None, plan_id=None):
        post = self.get_object()
        try:
            plan = post.comment_plans.get(id=plan_id, owner=request.user)
        except FacebookCommentPlan.DoesNotExist:
            return Response({'detail': 'Comment plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        if request.method == 'DELETE':
            plan.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        was_approved = plan.is_approved
        serializer = FacebookCommentPlanSerializer(plan, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        plan = serializer.save()
        if not was_approved and plan.is_approved:
            self._create_schedules_for_approved_comment_plan(plan, request.user)
        return Response(serializer.data)

    # ── Tracking / report ────────────────────────────────────────────────────

    @action(detail=False, methods=['get'], url_path='commented-interactions')
    def commented_interactions(self, request):
        """List comment/reply interactions on the user's posts, with the matching
        comment plan's profile/device resolved when available."""
        interactions = (
            FacebookPostInteraction.objects
            .filter(
                post__owner=request.user,
                interaction_type__in=[FacebookInteractionType.COMMENT, FacebookInteractionType.REPLY],
            )
            .select_related('post', 'post__page')
            .order_by('-created_at')
        )
        interactions = _apply_local_date_filter(
            interactions, 'created_at',
            request.query_params.get('date_from'), request.query_params.get('date_to'),
        )

        plans = (
            FacebookCommentPlan.objects
            .filter(owner=request.user)
            .select_related('profile', 'device')
        )
        plan_by_content = {}
        plan_by_post = {}
        for plan in plans:
            content_key = (plan.post_id, (plan.comment_content or '').strip().lower())
            plan_by_content.setdefault(content_key, plan)
            plan_by_post.setdefault(plan.post_id, plan)

        results = []
        for it in interactions:
            content_key = (it.post_id, (it.comment_content or '').strip().lower())
            plan = plan_by_content.get(content_key) or plan_by_post.get(it.post_id)
            results.append({
                'id': it.id,
                'comment_plan_id': plan.id if plan else None,
                'post_id': it.post_id,
                'post_url': it.post.post_url if it.post else '',
                'page_id': it.post.page_id if it.post else None,
                'page_name': it.post.page.name if it.post and it.post.page else None,
                'comment_content': it.comment_content,
                'comment_link': it.comment_link,
                'profile': plan.profile_id if plan else None,
                'profile_name': plan.profile.name if plan and plan.profile else None,
                'device': plan.device_id if plan else None,
                'device_name': plan.device.name if plan and plan.device else None,
                'interacted_at': it.interacted_at,
                'replay_task_dispatched': it.replay_task_dispatched,
                'dig_comment_dispatched': it.dig_comment_dispatched,
                'created_at': it.created_at,
            })
        return Response(FacebookCommentedInteractionSerializer(results, many=True).data)

    @action(detail=False, methods=['post'], url_path='mark-replay-dispatched')
    def mark_replay_dispatched(self, request):
        ids = request.data.get('ids')
        if not isinstance(ids, list) or not ids:
            return Response({'detail': 'ids must be a non-empty list.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            return Response({'detail': 'ids must be a list of integers.'}, status=status.HTTP_400_BAD_REQUEST)
        dispatched = request.data.get('dispatched', True)
        if not isinstance(dispatched, bool):
            return Response({'detail': 'dispatched must be a boolean.'}, status=status.HTTP_400_BAD_REQUEST)
        updated = FacebookPostInteraction.objects.filter(
            id__in=ids,
            interaction_type=FacebookInteractionType.COMMENT,
            post__owner=request.user,
        ).update(replay_task_dispatched=dispatched)
        return Response({'updated': updated, 'dispatched': dispatched})

    @action(detail=False, methods=['post'], url_path='delete-interactions')
    def delete_interactions(self, request):
        ids = request.data.get('ids')
        if not isinstance(ids, list) or not ids:
            return Response({'detail': 'ids must be a non-empty list.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            return Response({'detail': 'ids must be a list of integers.'}, status=status.HTTP_400_BAD_REQUEST)
        deleted, _ = FacebookPostInteraction.objects.filter(
            id__in=ids, post__owner=request.user,
        ).delete()
        return Response({'deleted': deleted})


class CleanupPublishedMediaView(APIView):
    """One-shot cleanup: delete S3 media for all PUBLISHED scheduled posts.

    POST /api/facebook/cleanup-published-media/

    Sweeps the 4 scheduled-post surfaces (page / group / profile / media-action)
    owned by the requesting user with status=PUBLISHED. For each row, calls
    :func:`cleanup_post_media` which skips URLs still referenced by other
    PENDING/PUBLISHING rows so in-flight posts don't lose their source.

    Body: no params (sweeps everything for the caller).
    Returns: ``{"scanned": N, "deleted": K}``.
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        from .s3_utils import cleanup_post_media

        scanned = 0
        deleted = 0

        list_surfaces = (
            ('page', FacebookScheduledPost),
            ('group', FacebookGroupScheduledPost),
            ('profile', FacebookProfileScheduledPost),
        )
        for label, model in list_surfaces:
            for post in model.objects.filter(
                owner=request.user,
                status=FacebookScheduledPostStatus.PUBLISHED,
            ).only('id', 'image_urls'):
                scanned += 1
                try:
                    deleted += cleanup_post_media(post.image_urls, exclude=post)
                except Exception:
                    logger.warning('Cleanup failed for %s post %s', label, post.id, exc_info=True)

        for action_row in FacebookProfileScheduledMediaAction.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PUBLISHED,
        ).only('id', 'image_url'):
            scanned += 1
            try:
                deleted += cleanup_post_media(action_row.image_url, exclude=action_row)
            except Exception:
                logger.warning('Cleanup failed for media action %s', action_row.id, exc_info=True)

        return Response({'scanned': scanned, 'deleted': deleted})


class RecordPostInteractionView(APIView):
    """Record an interaction (like/comment/share/reply) on a Facebook post by URL.

    POST /api/facebook/record-interaction/
    Body:
        post_url         (str, required)
        interaction_type (str, required) – like | comment | share | reply
        profile_username (str, optional)
        profile_avatar_url (str, optional)
        comment_content  (str, optional)
        comment_link     (str, optional)
        interacted_at    (datetime, optional)
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        post_url = (request.data.get('post_url') or '').strip()
        if not post_url:
            return Response({'detail': 'post_url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        post = FacebookPost.objects.filter(owner=request.user, post_url=post_url).first()
        if not post:
            return Response({'detail': 'No Facebook post found with that post_url.'}, status=status.HTTP_404_NOT_FOUND)

        # Upsert: an interaction is identified by its post (post_url). Re-sending
        # the request updates the existing row (e.g. to add comment_link).
        existing = FacebookPostInteraction.objects.filter(post=post).order_by('-created_at').first()
        if existing is not None:
            serializer = FacebookPostInteractionSerializer(existing, data=request.data, partial=True)
            response_status = status.HTTP_200_OK
        else:
            serializer = FacebookPostInteractionSerializer(data=request.data)
            response_status = status.HTTP_201_CREATED
        serializer.is_valid(raise_exception=True)
        interaction = serializer.save(post=post)

        _sync_approved_comment_plan(post=post, interaction=interaction, owner=request.user)

        if interaction.interaction_type == FacebookInteractionType.COMMENT and post.status != FacebookPostStatus.COMMENTED:
            post.status = FacebookPostStatus.COMMENTED
            post.save(update_fields=['status', 'updated_at'])
        return Response(serializer.data, status=response_status)


class AnalyzeCompetitorView(APIView):
    """One-shot competitor analysis. Calls external crawler /page-posts and
    returns the list normalized + sorted by engagement (reactions + comments).

    POST /api/facebook/analyze-competitor/
    Body:
        url        (str, required) – competitor FB page or profile URL
        since      (str, optional) – ISO date YYYY-MM-DD (inclusive)
        until      (str, optional) – ISO date YYYY-MM-DD (inclusive)
        max_posts  (int, optional) – default 50, capped at 200

    Response:
        {
          "count": int,
          "posts": [
            {post_url, content, image_url, posted_at,
             reactions_count, comments_count, shares_count, engagement_total}
          ]
        }
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [ApiKeyAuthentication, JWTAuthentication]

    def post(self, request):
        url = (request.data.get('url') or '').strip()
        if not url:
            return Response({'detail': 'url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        since = (request.data.get('since') or '').strip() or None
        until = (request.data.get('until') or '').strip() or None
        try:
            max_posts = int(request.data.get('max_posts') or 50)
        except (TypeError, ValueError):
            max_posts = 50
        max_posts = max(1, min(max_posts, 200))

        try:
            raw_posts = _call_facebook_page_posts_api(
                url, since=since, until=until, max_posts=max_posts,
            )
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        posts = []
        for item in raw_posts:
            if not isinstance(item, dict):
                continue
            reactions = int(item.get('reactions_count') or 0)
            comments = int(item.get('comments_count') or 0)
            shares = int(item.get('shares_count') or 0)
            posts.append({
                'post_url': str(item.get('post_url') or '').strip(),
                'content': str(item.get('content') or '').strip(),
                'image_url': str(item.get('image_url') or '').strip(),
                'posted_at': item.get('posted_at') or None,
                'reactions_count': reactions,
                'comments_count': comments,
                'shares_count': shares,
                'engagement_total': reactions + comments,
            })
        posts.sort(key=lambda p: p['engagement_total'], reverse=True)
        return Response({'count': len(posts), 'posts': posts})


class GenerateFacebookCommentView(APIView):
    """Generate a Facebook comment via OpenAI based on post content.

    POST /api/facebook/generate-comment/
    Body: post_content (str, optional), existing_comments (list[str], optional)
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def post(self, request):
        post_content = (request.data.get('post_content') or '').strip()
        existing_comments = request.data.get('existing_comments', [])

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key)

            comments_hint = ''
            if isinstance(existing_comments, list) and existing_comments:
                sample = [str(c) for c in existing_comments[:10]]
                comments_hint = '\nExisting comments on this post:\n' + '\n'.join(f'- {c}' for c in sample)

            prompt = (
                f'Generate a natural, engaging Facebook comment for a post.\n'
                f'Post content: {post_content or "No description available"}'
                f'{comments_hint}\n'
                f'Rules:\n'
                f'- Return ONLY the comment text, nothing else.\n'
                f'- Keep it short (1–2 sentences).\n'
                f'- Make it relevant and authentic.\n'
                f'- Write in Vietnamese.'
            )

            chat_response = client.chat.completions.create(
                model='gpt-4o-mini',
                messages=[
                    {'role': 'system', 'content': (
                        'You are a Facebook user writing natural comments. '
                        'Respond with the comment text only.'
                    )},
                    {'role': 'user', 'content': prompt},
                ],
                temperature=0.8,
                max_tokens=150,
            )
            comment = chat_response.choices[0].message.content.strip()
        except Exception as exc:  # noqa: BLE001
            logger.exception('generate_facebook_comment: OpenAI error: %s', exc)
            return Response(
                {'detail': 'Failed to generate comment. Please try again later.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({'comment': comment})


# ─── Facebook Group post + scheduled-post viewsets ───────────────────────────
# Parallel to the Page versions. Reuses ``_download_image_bytes`` and the same
# Graph API call shape; only the target uid/token differ.


def _publish_group_content(group: FacebookGroup, content: str, image_urls: list[str] | None = None) -> dict:
    """Publish text/image content to a Facebook group via Graph API.

    Same logic as ``_publish_page_content`` but uses ``group.group_uid`` +
    ``group.group_token`` (a user access token with ``publish_to_groups``).
    Raises ``ValueError`` on token/config/content/API errors.
    """
    if not group.group_token:
        raise ValueError('Group token is not configured for this group.')

    message = (content or '').strip()
    if not message:
        raise ValueError('Post content is required.')

    group_uid = group.group_uid or str(group.id)
    access_token = group.group_token
    image_urls = [u for u in (image_urls or []) if u]

    videos = [u for u in image_urls if _is_video_url(u)]
    images = [u for u in image_urls if not _is_video_url(u)]
    if len(videos) > 1:
        raise ValueError('Only one video per post is supported.')

    # Same as the page flow: video via /{group}/videos directly (attached_media
    # rejects video with "(#10) ... permission"); video + images → 2 posts.
    if videos:
        video_data = _publish_video_to_facebook(group_uid, access_token, videos[0], message)
        if images:
            try:
                _publish_photos_to_feed(group_uid, access_token, message, images)
            except Exception as exc:  # noqa: BLE001 — video already up; avoid double-post on retry
                logger.warning('[_publish_group_content] video đã đăng nhưng bài ảnh riêng lỗi: %s', exc)
        return video_data

    if images:
        return _publish_photos_to_feed(group_uid, access_token, message, images)

    resp = http_requests.post(
        f'https://graph.facebook.com/v19.0/{group_uid}/feed',
        data={'message': message, 'access_token': access_token},
        timeout=60,
    )
    try:
        data = resp.json()
    except Exception:
        data = {}
    if not resp.ok or 'error' in data:
        error_msg = (data.get('error') or {}).get('message') or resp.text
        raise ValueError(f'Facebook API error: {error_msg}')
    return data


def _build_fb_group_post_goal(account_name: str, group_name: str, content: str, image_urls: list[str]) -> str:
    """Build a natural-language goal string for the phoneagent that targets
    the ``facebook_group_post`` skill (always anonymous).

    Mirrors ``_build_fb_profile_post_goal``: worker pre-downloads media into
    /sdcard/Download/ so the goal text only states intent + count.
    """
    name = (account_name or '').strip() or 'tài khoản chính'
    g = (group_name or '').strip() or 'nhóm đã cấu hình'
    content_clean = (content or '').strip()
    n = len(image_urls or [])
    if not n:
        return f"{name} đăng bài \"{content_clean}\" vào nhóm {g} (ẩn danh)."
    return (
        f"{name} đăng bài \"{content_clean}\" vào nhóm {g} (ẩn danh), kèm "
        f"{n} tệp media đã được tải sẵn vào /sdcard/Download/ của thiết bị."
    )


def _dispatch_fb_group_post_task(
    group: 'FacebookGroup',
    poster: 'FacebookProfile',
    content: str,
    image_urls: list[str] | None = None,
    *,
    scheduled_post_id: int | None = None,
):
    """Create + dispatch a phoneagent Task that publishes to *group* using
    *poster*'s device. The agent runs the ``facebook_group_post`` skill with
    ``anonymous=True``. Result is delivered asynchronously through Task
    status updates handled by ``handle_fb_group_post_task_status``.

    Returns the created :class:`Task`. Raises ``ValueError`` for permanent
    misconfigurations and ``TransientPublishError`` when Kafka dispatch fails.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    if poster is None:
        raise ValueError(
            'Scheduled post chưa gán poster_fb_profile. Cấu hình Poster mặc định '
            'trên group hoặc gán trực tiếp vào row trước khi đăng.'
        )
    if not poster.device_id:
        raise ValueError(
            f'Poster "{poster.name}" chưa gắn với thiết bị. Vào Sửa FB profile '
            'và chọn device đã login account này.'
        )
    if not poster.account_name:
        raise ValueError(
            f'Poster "{poster.name}" chưa khai báo account_name (tên FB account '
            'hiển thị trên device). Vào Sửa FB profile để cập nhật.'
        )
    message = (content or '').strip()
    if not message:
        raise ValueError('Post content is required.')

    image_urls = [u for u in (image_urls or []) if u]

    from .s3_utils import get_presigned_image_url
    presigned_media: list[str] = []
    for url in image_urls:
        try:
            presigned_media.append(get_presigned_image_url(url, expires_in=MEDIA_PRESIGN_EXPIRY_SECONDS))
        except Exception:
            presigned_media.append(url)

    goal = _build_fb_group_post_goal(poster.account_name, group.name, message, presigned_media)

    task = Task.objects.create(
        name=f'FB group post — {group.name} via {poster.account_name}',
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'publish_group_scheduled_post',
            'fb_group_id': group.id,
            'fb_scheduled_post_id': scheduled_post_id,
            'poster_fb_profile_id': poster.id,
            'account_name': poster.account_name,
            'group_name': group.name,
            'content': message,
            'media_urls': presigned_media,
            'anonymous': True,
        },
        device_id=poster.device_id,
        owner=group.owner,
    )

    # Send now if free, else QUEUE for the drain poll.
    if dispatch_or_queue(task, poster.device_id) == 'failed':
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(
            f'Kafka dispatch thất bại cho FB group post task {task.id}. '
            'Cron sẽ retry ở tick sau.'
        )
    return task


def _publish_group_scheduled_to_facebook(post: 'FacebookGroupScheduledPost') -> None:
    """Dispatch a phoneagent Task to publish *post* to its group via the
    configured poster's device. Marks the scheduled post as PUBLISHING — the
    actual PUBLISHED/FAILED transition happens later in
    ``handle_fb_group_post_task_status`` when the agent reports back.
    """
    try:
        _ensure_scheduled_post_media_hosted(post)
        _dispatch_fb_group_post_task(
            post.group,
            post.poster_fb_profile,
            post.content,
            post.image_urls,
            scheduled_post_id=post.id,
        )
    except (ValueError, TransientPublishError) as exc:
        _handle_scheduled_publish_exception(post, exc)
        raise

    post.status = FacebookScheduledPostStatus.PUBLISHING
    post.error_msg = ''
    post.save(update_fields=['status', 'error_msg', 'updated_at'])


def handle_fb_group_post_task_status(task, *, old_status: str, new_status: str) -> None:
    """Update the FacebookGroupScheduledPost tied to *task* when the agent
    reports COMPLETED / FAILED. Wired in from ``task/views.py``.
    """
    from task.models import TaskStatus

    payload = task.payload or {}
    if payload.get('action') != 'publish_group_scheduled_post':
        return
    if new_status == old_status or new_status not in (TaskStatus.COMPLETED, TaskStatus.FAILED):
        return

    sched_id = payload.get('fb_scheduled_post_id')
    if not sched_id:
        return

    try:
        sp = FacebookGroupScheduledPost.objects.select_related('group').get(id=sched_id)
    except FacebookGroupScheduledPost.DoesNotExist:
        logger.warning('FB group post task %s references missing scheduled post %s', task.id, sched_id)
        return

    if new_status == TaskStatus.COMPLETED:
        post_url = ''
        result = task.result
        if isinstance(result, dict):
            post_url = result.get('post_url') or ''
        elif isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('post_url'):
                    post_url = item['post_url']
                    break
        sp.status = FacebookScheduledPostStatus.PUBLISHED
        sp.fb_post_id = post_url
        sp.error_msg = ''
        sp.save(update_fields=['status', 'fb_post_id', 'error_msg', 'updated_at'])

        owner = sp.owner or sp.group.owner
        image_url = (sp.image_urls or [''])[0] if sp.image_urls else ''
        existing_post = None
        if owner and post_url:
            existing_post = FacebookGroupPost.objects.filter(
                owner=owner, group=sp.group, post_url=post_url,
            ).first()
        if existing_post:
            existing_post.content = sp.content
            existing_post.image_url = image_url
            existing_post.status = FacebookPostStatus.SHARED
            existing_post.save(update_fields=['content', 'image_url', 'status', 'updated_at'])
        elif owner:
            FacebookGroupPost.objects.create(
                group=sp.group,
                post_url=post_url,
                image_url=image_url,
                caption='',
                content=sp.content,
                keywords=[],
                status=FacebookPostStatus.SHARED,
                owner=owner,
            )
    else:  # FAILED
        err = ''
        result = task.result
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('error'):
                    err = str(item['error'])[:500]
                    break
        elif isinstance(result, str):
            err = result[:500]
        sp.status = FacebookScheduledPostStatus.FAILED
        sp.error_msg = _humanize_post_error(err) or 'Phoneagent task failed without details.'
        sp.save(update_fields=['status', 'error_msg', 'updated_at'])


class FacebookGroupPostViewSet(viewsets.ModelViewSet):
    """CRUD + upload-image + publish-now for ``FacebookGroupPost``."""

    serializer_class = FacebookGroupPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content', 'post_url', 'caption']
    ordering_fields = ['created_at', 'updated_at', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookGroupPost.objects.filter(owner=self.request.user).select_related('group')
        group_id = self.request.query_params.get('group')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        if group_id:
            qs = qs.filter(group_id=group_id)
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(
        detail=False, methods=['post'], url_path='upload-image', url_name='upload-image',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    def upload_image(self, request):
        image_file = request.FILES.get('file')
        if not image_file:
            return Response({'detail': 'No image file provided.'}, status=status.HTTP_400_BAD_REQUEST)
        # Upload to SeaweedFS – public Filer URL returned, no presigning needed.
        image_url = upload_to_seaweedfs(image_file, image_file.name)
        return Response({'image_url': get_seaweedfs_url(image_url)}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        """Publish this group post immediately via Graph API."""
        post = self.get_object()
        publish_content = (post.content or post.caption or '').strip()
        if not publish_content:
            return Response({'detail': 'Post content is required.'}, status=status.HTTP_400_BAD_REQUEST)

        images = list(post.image_urls or [])
        if not images and post.image_url:
            images = [post.image_url]
        try:
            data = _publish_group_content(post.group, publish_content, images or None)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        fb_post_id = data.get('post_id') or data.get('id') or ''
        update_fields = ['status', 'updated_at']
        post.status = FacebookPostStatus.SHARED
        if fb_post_id:
            post.post_url = f'https://www.facebook.com/{fb_post_id}'
            update_fields.append('post_url')
        post.save(update_fields=update_fields)

        return Response({
            'detail': 'Post published successfully.',
            'facebook_post_id': fb_post_id,
            'post_url': post.post_url,
        })


class FacebookGroupScheduledPostViewSet(viewsets.ModelViewSet):
    """CRUD + publish-now + publish-due + delete-pending + upload-csv for groups.

    Mirror of ``FacebookScheduledPostViewSet``.
    """

    serializer_class = FacebookGroupScheduledPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content']
    ordering_fields = ['scheduled_at', 'created_at', 'status']
    ordering = ['scheduled_at']

    def get_queryset(self):
        qs = FacebookGroupScheduledPost.objects.filter(owner=self.request.user).select_related('group')
        group_id = self.request.query_params.get('group')
        status_param = self.request.query_params.get('status')
        if group_id:
            qs = qs.filter(group_id=group_id)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        _safe_cleanup_post_media(instance, 'group-scheduled')
        super().perform_destroy(instance)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        post = self.get_object()
        if post.status == FacebookScheduledPostStatus.PUBLISHED:
            return Response({'detail': 'This scheduled post is already published.'}, status=status.HTTP_400_BAD_REQUEST)
        if post.status == FacebookScheduledPostStatus.PUBLISHING:
            return Response(
                {'detail': 'Bài đăng đang được phoneagent xử lý, chờ kết quả.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if post.status == FacebookScheduledPostStatus.CANCELLED:
            return Response({'detail': 'Cancelled scheduled post cannot be published.'}, status=status.HTTP_400_BAD_REQUEST)
        if not post.is_approved:
            return Response(
                {'detail': 'Bài đăng chưa được admin duyệt. Bấm Duyệt trước khi đăng.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Media còn phải tải + re-host → đẩy sang nền, đừng chặn request (xem
        # _needs_media_rehost). Poll của scheduler sẽ tải và đăng.
        if _needs_media_rehost(post):
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_MEDIA_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        # Device busy → queue (don't reject) so several can be fired at once.
        if _device_is_busy(post.poster_fb_profile.device_id if post.poster_fb_profile_id else None):
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        try:
            _publish_group_scheduled_to_facebook(post)
        except DeviceBusyError:
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            {
                'detail': 'Đã dispatch task cho phoneagent. Chờ poster đăng bài và Kafka mirror kết quả.',
                'scheduled_post_id': post.id,
                'status': post.status,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'], url_path='approve', url_name='approve')
    def approve(self, request, pk=None):
        """Mark the scheduled post as approved so the cron picks it up."""
        post = self.get_object()
        if post.status != FacebookScheduledPostStatus.PENDING:
            return Response(
                {'detail': f'Chỉ duyệt được post đang ở trạng thái pending (hiện tại: {post.status}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if post.is_approved:
            return Response(
                {'detail': 'Post đã được duyệt rồi.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        post.is_approved = True
        post.save(update_fields=['is_approved', 'updated_at'])
        return Response(self.get_serializer(post).data)

    @action(detail=True, methods=['post'], url_path='reject', url_name='reject')
    def reject(self, request, pk=None):
        """Reject a pending scheduled post. Sets status=CANCELLED so it never
        fires. Use delete if you want it gone entirely.
        """
        post = self.get_object()
        if post.status != FacebookScheduledPostStatus.PENDING:
            return Response(
                {'detail': f'Chỉ từ chối được post đang pending (hiện tại: {post.status}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        post.status = FacebookScheduledPostStatus.CANCELLED
        post.is_approved = False
        reason = (request.data.get('reason') or '').strip()
        if reason:
            post.error_msg = f'Admin từ chối: {reason}'[:1000]
        post.save(update_fields=['status', 'is_approved', 'error_msg', 'updated_at'])
        return Response(self.get_serializer(post).data)

    @action(detail=False, methods=['post'], url_path='publish-due', url_name='publish-due')
    def publish_due(self, request):
        now = timezone.now()
        # Only fire posts that the admin FB profile explicitly approved.
        due_posts = FacebookGroupScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
            is_approved=True,
            scheduled_at__lte=now,
        ).select_related('group')
        published_count = 0
        failed_count = 0
        for post in due_posts:
            try:
                _publish_group_scheduled_to_facebook(post)
                published_count += 1
            except Exception:
                failed_count += 1
        return Response({'published': published_count, 'failed': failed_count})

    @action(detail=False, methods=['post'], url_path='delete-pending', url_name='delete-pending')
    def delete_pending(self, request):
        group_id = request.query_params.get('group') or request.data.get('group')
        qs = FacebookGroupScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
        )
        if group_id:
            qs = qs.filter(group_id=group_id)
        for post in qs:
            _safe_cleanup_post_media(post, 'group-scheduled')
        deleted_count, _ = qs.delete()
        return Response({'deleted': deleted_count}, status=status.HTTP_200_OK)


class FacebookGroupPendingMemberPostViewSet(viewsets.ReadOnlyModelViewSet):
    """List + approve/reject for the snapshot of members' pending posts.

    No create/update endpoints — rows come from the sync phoneagent task.
    """

    serializer_class = FacebookGroupPendingMemberPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['author_name', 'content']
    ordering_fields = ['posted_at', 'created_at', 'status']
    ordering = ['-posted_at', '-created_at']

    def get_queryset(self):
        qs = FacebookGroupPendingMemberPost.objects.filter(
            owner=self.request.user,
        ).select_related('group')
        group_id = self.request.query_params.get('group')
        status_param = self.request.query_params.get('status')
        if group_id:
            qs = qs.filter(group_id=group_id)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    @action(detail=True, methods=['post'], url_path='approve', url_name='approve')
    def approve(self, request, pk=None):
        return self._dispatch_decision('approve')

    @action(detail=True, methods=['post'], url_path='reject', url_name='reject')
    def reject(self, request, pk=None):
        return self._dispatch_decision('reject')

    def _dispatch_decision(self, decision: str):
        row = self.get_object()
        if row.status == FacebookGroupPendingMemberPostStatus.PROCESSING:
            return Response(
                {'detail': 'Đang xử lý — chờ kết quả trước khi gửi lại.'},
                status=status.HTTP_409_CONFLICT,
            )
        if row.status in (
            FacebookGroupPendingMemberPostStatus.APPROVED,
            FacebookGroupPendingMemberPostStatus.REJECTED,
        ):
            return Response(
                {'detail': f'Bài đã ở trạng thái {row.status}, không thể gửi lại.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            _dispatch_fb_group_pending_decision_task(row, decision)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TransientPublishError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        row.status = FacebookGroupPendingMemberPostStatus.PROCESSING
        row.error_msg = ''
        row.save(update_fields=['status', 'error_msg', 'updated_at'])
        return Response(self.get_serializer(row).data)


# ─── Facebook Profile (personal) viewsets ────────────────────────────────────
# NOTE: Graph API has deprecated publishing to personal profiles since 2018
# (publish_actions). The publish flow below mirrors Page/Group architecturally
# so the UI is consistent and infrastructure is ready if a workaround is wired
# in later (e.g. via a mobile-agent doing it through the official app).


# Default style prompt when the user didn't customize at import time.
_DEFAULT_AI_REWRITE_PROMPT = (
    'VIẾT LẠI toàn bộ nội dung bằng câu chữ MỚI theo phong cách bác sĩ y khoa '
    'chuyên nghiệp, giọng văn điềm đạm, đáng tin cậy. Hãy diễn đạt lại RÕ RỆT: '
    'dùng từ ngữ khác, có thể sắp xếp lại câu và thứ tự ý cho mạch lạc, chuyên '
    'nghiệp và thuyết phục hơn — TUYỆT ĐỐI KHÔNG sao chép nguyên văn bản gốc. '
    'Vẫn GIỮ NGUYÊN mọi thông tin, sự kiện, số liệu, hashtag, emoji, hotline, '
    'link, tên người, tên thương hiệu. KHÔNG bịa thêm chẩn đoán, kê đơn hay '
    'khuyến cáo y khoa mới. Trả về DUY NHẤT nội dung đã viết lại, không kèm giải thích.'
)


def _ai_rewrite_content(original_content: str, user_prompt: str = '') -> str:
    """Call OpenAI to rewrite *original_content* per *user_prompt*.

    Returns the rewritten text. Raises ``RuntimeError`` with a user-facing message
    when OpenAI is not configured. Other exceptions propagate.
    """
    import os as _os
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError('OpenAI SDK chưa được cài trên backend.') from exc

    api_key = _os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise RuntimeError('OPENAI_API_KEY chưa cấu hình trên backend.')

    model = _os.environ.get('FACEBOOK_AI_REWRITE_MODEL', 'gpt-4o-mini')
    system_prompt = (user_prompt or '').strip() or _DEFAULT_AI_REWRITE_PROMPT

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        # Higher temperature → diễn đạt lại đa dạng hơn, tránh việc AI gần như
        # giữ nguyên bản gốc.
        temperature=0.7,
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': original_content},
        ],
    )
    text = (resp.choices[0].message.content or '').strip()
    if not text:
        raise RuntimeError('AI trả về nội dung rỗng.')
    return text


def _build_fb_profile_post_goal(account_name: str, content: str, image_urls: list[str]) -> str:
    """Build a natural-language goal string for the phoneagent.

    The worker pre-downloads media from ``payload.media_urls`` and pushes them
    onto the device's /sdcard/Download/ BEFORE invoking the LLM agent. The goal
    text therefore only states INTENT + media count — the LLM never sees URLs
    and cannot hallucinate around them.
    """
    name = (account_name or '').strip() or 'tài khoản chính'
    content_clean = (content or '').strip()
    n = len(image_urls or [])
    if not n:
        return f"Vào facebook {name} đăng bài \"{content_clean}\""
    return (
        f"Đăng bài \"{content_clean}\" lên trang cá nhân của {name} kèm "
        f"{n} tệp media đã được tải sẵn vào /sdcard/Download/ của thiết bị."
    )


def _dispatch_fb_profile_post_task(
    profile: 'FacebookProfile',
    content: str,
    image_urls: list[str] | None = None,
    *,
    scheduled_post_id: int | None = None,
    target_group: 'FacebookGroup | None' = None,
):
    """Create + dispatch a phoneagent Task that publishes via *profile*'s device.

    By default the agent runs ``facebook_profile_post`` (timeline). When
    ``target_group`` is provided, the agent instead runs ``facebook_group_post``
    with ``anonymous=True`` and publishes into that group using *profile* as
    the poster account.

    Returns the created :class:`Task`. Raises ``ValueError`` for permanent
    misconfigurations and ``TransientPublishError`` when Kafka dispatch fails.

    Pass ``scheduled_post_id`` so the agent's status callback can find the
    correct ``FacebookProfileScheduledPost`` to update.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    if not profile.device_id:
        raise ValueError(
            'Profile chưa gắn với thiết bị. Vào Sửa profile và chọn device '
            'đã login FB account này.'
        )
    if not profile.account_name:
        raise ValueError(
            'Profile chưa khai báo account_name (tên FB account hiển thị trên '
            'device). Vào Sửa profile để cập nhật.'
        )

    message = (content or '').strip()
    if not message:
        raise ValueError('Post content is required.')

    image_urls = [u for u in (image_urls or []) if u]

    # Sign S3 URLs so the device can download them without bucket credentials.
    from .s3_utils import get_presigned_image_url
    presigned_media: list[str] = []
    for url in image_urls:
        try:
            presigned_media.append(get_presigned_image_url(url, expires_in=MEDIA_PRESIGN_EXPIRY_SECONDS))
        except Exception:
            presigned_media.append(url)

    if target_group is None:
        goal = _build_fb_profile_post_goal(profile.account_name, message, presigned_media)
        task_name = f'FB profile post — {profile.account_name}'
        payload_extra = {}
    else:
        goal = _build_fb_group_post_goal(profile.account_name, target_group.name, message, presigned_media)
        task_name = f'FB group post — {target_group.name} via {profile.account_name}'
        payload_extra = {
            'target_group_id': target_group.id,
            'group_name': target_group.name,
            'anonymous': True,
        }

    task = Task.objects.create(
        name=task_name,
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'publish_profile_post',
            'fb_profile_id': profile.id,
            'fb_scheduled_post_id': scheduled_post_id,
            'account_name': profile.account_name,
            'content': message,
            'media_urls': presigned_media,
            **payload_extra,
        },
        device_id=profile.device_id,
        owner=profile.owner,
    )

    # Send now if the device is free, else QUEUE for the drain poll. Mirrors
    # /tasks/{id}/run/: a delivered task flips to RUNNING so the UI shows "Đang
    # chạy"; a busy device parks it as QUEUED ("Trong hàng đợi").
    if dispatch_or_queue(task, profile.device_id) == 'failed':
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(
            f'Kafka dispatch thất bại cho FB profile post task {task.id}. '
            'Cron sẽ retry ở tick sau.'
        )
    return task


def _dispatch_fb_find_post_link_task(post: 'FacebookProfileScheduledPost'):
    """Create + dispatch a phoneagent Task that finds *post*'s published link on
    Facebook (via the profile's device) and syncs it back. The worker reports the
    URL via the ``update-link`` callback when done.

    Mirrors :func:`_dispatch_fb_profile_post_task` but carries no media and uses
    the ``find_profile_post_link`` action. Returns the created Task; raises
    ``ValueError`` for misconfig and ``TransientPublishError`` on dispatch failure.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    profile = post.profile
    if not profile.device_id:
        raise ValueError(
            'Profile chưa gắn với thiết bị. Vào Sửa profile và chọn device '
            'đã login FB account này.'
        )
    if not profile.account_name:
        raise ValueError(
            'Profile chưa khai báo account_name (tên FB account hiển thị trên '
            'device). Vào Sửa profile để cập nhật.'
        )

    content = (post.content or '').strip()
    if not content:
        raise ValueError('Bài đăng chưa có nội dung để tìm link.')

    # Phân biệt bài đăng trên trang cá nhân vs đăng vào nhóm (giống cột UI).
    if post.target_group_id:
        where = f'trong nhóm {post.target_group.name}'
        post_type = 'Nhóm'
    else:
        where = 'trên trang cá nhân'
        post_type = 'Trang cá nhân'
    goal = (
        f'Vào facebook {profile.account_name} tìm bài viết {where} có nội dung '
        f'"{content}", sau đó sao chép liên kết của bài viết đó và đồng bộ về hệ thống.'
    )

    task = Task.objects.create(
        name=f'FB find post link profile — {profile.account_name}',
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'find_profile_post_link',
            'content': content,
            'post_type': post_type,
            'account_name': profile.account_name,
            'fb_profile_id': profile.id,
            'fb_scheduled_post_id': post.id,
        },
        device_id=profile.device_id,
        owner=profile.owner,
    )

    # Send now if free, else QUEUE for the drain poll (find-link no longer floods
    # a busy device — it waits its turn behind the current task).
    if dispatch_or_queue(task, profile.device_id) == 'failed':
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(
            f'Kafka dispatch thất bại cho FB find-link task {task.id}.'
        )
    return task


def _publish_profile_content(profile: FacebookProfile, content: str, image_urls: list[str] | None = None) -> dict:
    """Dispatch a phoneagent Task to publish to *profile* immediately (no
    scheduled-post linkage). Used by FacebookProfilePost.publish_now action.

    Returns ``{'id': '', 'post_id': '', 'pending_task_id': <int>}`` — the
    actual FB post URL is filled in later by the task status callback.
    """
    task = _dispatch_fb_profile_post_task(profile, content, image_urls)
    return {'id': '', 'post_id': '', 'pending_task_id': task.id}


# ─── Media actions on FB profile (avatar / cover / story) ───────────────────
#
# These three actions share the same shape: 1 image → phoneagent task that
# navigates FB UI to apply the media. Like the post flow, the worker pre-fetches
# the image to /sdcard/Download/ first so the LLM never sees URLs.

_FB_PROFILE_MEDIA_ACTIONS = {
    'change_avatar': {
        'goal_template': (
            'Đổi ảnh đại diện trang cá nhân Facebook của {name} bằng 1 tệp ảnh '
            'đã được tải sẵn vào /sdcard/Download/ của thiết bị.'
        ),
        'task_name': 'FB profile change avatar',
    },
    'change_cover': {
        'goal_template': (
            'Đổi ảnh bìa trang cá nhân Facebook của {name} bằng 1 tệp ảnh '
            'đã được tải sẵn vào /sdcard/Download/ của thiết bị.'
        ),
        'task_name': 'FB profile change cover',
    },
    'post_story': {
        'goal_template': (
            'Đăng tin nổi bật (Story) trên Facebook của {name} bằng 1 tệp ảnh '
            'đã được tải sẵn vào /sdcard/Download/ của thiết bị.'
        ),
        'task_name': 'FB profile post story',
    },
}


def _dispatch_fb_profile_media_action_task(
    profile: 'FacebookProfile',
    action: str,
    image_url: str,
    *,
    scheduled_media_action_id: int | None = None,
):
    """Create + dispatch a phoneagent Task for a single-image profile action.

    *action* must be one of the keys in ``_FB_PROFILE_MEDIA_ACTIONS``. *image_url*
    is the raw S3 (or external) URL — backend presigns it before dispatch so the
    worker can download it via HTTPS.

    Pass ``scheduled_media_action_id`` so devices_worker's terminal-state
    mirror can flip the matching ``FacebookProfileScheduledMediaAction`` row
    when the agent reports back.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    spec = _FB_PROFILE_MEDIA_ACTIONS.get(action)
    if not spec:
        raise ValueError(f'Unknown FB profile media action: {action!r}')
    if not profile.device_id:
        raise ValueError(
            'Profile chưa gắn với thiết bị. Vào Sửa profile và chọn device '
            'đã login FB account này.'
        )
    if not profile.account_name:
        raise ValueError(
            'Profile chưa khai báo account_name (tên FB account hiển thị trên '
            'device). Vào Sửa profile để cập nhật.'
        )
    if not image_url:
        raise ValueError('Image URL is required.')

    presigned_url = image_url
    try:
        presigned_url = get_presigned_image_url(image_url, expires_in=MEDIA_PRESIGN_EXPIRY_SECONDS)
    except Exception:
        pass

    goal = spec['goal_template'].format(name=profile.account_name)

    payload = {
        'agent': 'facebook',
        'action': action,
        'fb_profile_id': profile.id,
        'account_name': profile.account_name,
        'media_urls': [presigned_url],
    }
    if scheduled_media_action_id is not None:
        payload['fb_scheduled_media_action_id'] = scheduled_media_action_id

    task = Task.objects.create(
        name=f"{spec['task_name']} — {profile.account_name}",
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload=payload,
        device_id=profile.device_id,
        owner=profile.owner,
    )

    # Send now if free, else QUEUE for the drain poll.
    if dispatch_or_queue(task, profile.device_id) == 'failed':
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(
            f'Kafka dispatch thất bại cho FB profile {action} task {task.id}.'
        )
    return task


def _publish_profile_scheduled_media_action(action_row: 'FacebookProfileScheduledMediaAction') -> None:
    """Dispatch a phoneagent task for a scheduled avatar/cover/story change.

    Sets the row to PUBLISHING; terminal state is mirrored later by
    devices_worker when the worker reports back via Kafka.
    """
    try:
        _dispatch_fb_profile_media_action_task(
            action_row.profile,
            action_row.action_type,
            action_row.image_url,
            scheduled_media_action_id=action_row.id,
        )
    except (ValueError, TransientPublishError) as exc:
        _handle_scheduled_publish_exception(action_row, exc)
        raise

    action_row.status = FacebookScheduledPostStatus.PUBLISHING
    action_row.error_msg = ''
    action_row.save(update_fields=['status', 'error_msg', 'updated_at'])


# ─── FB Group: pending-member-post phoneagent dispatch ───────────────────────

def _dispatch_fb_group_fetch_pending_task(group: 'FacebookGroup'):
    """Create + dispatch a phoneagent Task that opens the group's "Pending
    posts" tab in the FB app and scrapes the visible list.

    The worker reports the scraped JSON list back through ``task_status``;
    devices_worker reads the terminal event and upserts
    ``FacebookGroupPendingMemberPost`` rows from it.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    admin = group.admin_fb_profile
    if admin is None:
        raise ValueError(
            'Group chưa gán admin FB profile. Vào Sửa Group → chọn Tài khoản FB Admin trước.'
        )
    if not admin.device_id:
        raise ValueError('Admin FB profile chưa gắn với thiết bị.')
    if not admin.account_name:
        raise ValueError('Admin FB profile chưa khai báo account_name.')

    goal = (
        f'Mở Facebook bằng tài khoản {admin.account_name}, vào nhóm '
        f'"{group.name}" và liệt kê các bài đăng đang chờ admin duyệt. '
        'Trả về JSON các bài đăng đó cho backend.'
    )

    task = Task.objects.create(
        name=f'FB group fetch pending — {group.name}',
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'fetch_group_pending_posts',
            'fb_group_id': group.id,
            'group_uid': group.group_uid,
            'group_url': group.group_url,
            'group_name': group.name,
            'account_name': admin.account_name,
        },
        device_id=admin.device_id,
        owner=group.owner,
    )

    delivered = send_task_execution_message(task, devices_id=[admin.device_id])
    if not delivered:
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(f'Kafka dispatch thất bại cho task {task.id}.')
    return task


def _dispatch_fb_group_pending_decision_task(
    pending_post: 'FacebookGroupPendingMemberPost',
    decision: str,
):
    """Dispatch a phoneagent task that finds the pending post in the FB app
    and clicks Approve or Reject.

    *decision* must be 'approve' or 'reject'. The status mirror in
    devices_worker flips ``pending_post.status`` on terminal task state.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    if decision not in ('approve', 'reject'):
        raise ValueError(f'Invalid decision {decision!r}.')
    group = pending_post.group
    admin = group.admin_fb_profile
    if admin is None:
        raise ValueError('Group chưa gán admin FB profile.')
    if not admin.device_id:
        raise ValueError('Admin FB profile chưa gắn với thiết bị.')
    if not admin.account_name:
        raise ValueError('Admin FB profile chưa khai báo account_name.')

    verb_vi = 'duyệt' if decision == 'approve' else 'từ chối'
    tab_vi = 'Có thể là spam' if pending_post.pending_tab == 'maybe_spam' else 'Bài viết đang chờ'
    goal = (
        f'Mở Facebook bằng {admin.account_name}, vào nhóm "{group.name}", '
        f'mở admin queue tab "{tab_vi}", tìm bài đăng của '
        f'{pending_post.author_name or "thành viên"} và {verb_vi} bài đó.'
    )

    action_value = f'{decision}_group_pending_post'

    task = Task.objects.create(
        name=f'FB group {decision} pending ({pending_post.pending_tab}) — {group.name}',
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': action_value,
            'fb_group_id': group.id,
            'fb_pending_post_id': pending_post.id,
            'post_fb_id': pending_post.post_fb_id,
            'post_url': pending_post.post_url,
            'author_name': pending_post.author_name,
            'author_uid': pending_post.author_uid,
            'content_excerpt': pending_post.content[:200],
            'group_uid': group.group_uid,
            'group_url': group.group_url,
            'group_name': group.name,
            'account_name': admin.account_name,
            'pending_tab': pending_post.pending_tab,
        },
        device_id=admin.device_id,
        owner=group.owner,
    )

    delivered = send_task_execution_message(task, devices_id=[admin.device_id])
    if not delivered:
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(f'Kafka dispatch thất bại cho task {task.id}.')
    return task


def _publish_profile_scheduled_to_facebook(post: 'FacebookProfileScheduledPost') -> None:
    """Dispatch a phoneagent Task to publish *post*. Marks the scheduled post
    as PUBLISHING — the actual PUBLISHED/FAILED transition happens later in
    ``handle_fb_profile_post_task_status`` when the agent reports back.

    Routes to ``facebook_group_post`` (anonymous) when ``post.target_group``
    is set; otherwise runs ``facebook_profile_post`` on the timeline.
    """
    try:
        _ensure_scheduled_post_media_hosted(post)
        _dispatch_fb_profile_post_task(
            post.profile,
            post.content,
            post.image_urls,
            scheduled_post_id=post.id,
            target_group=post.target_group,
        )
    except (ValueError, TransientPublishError) as exc:
        _handle_scheduled_publish_exception(post, exc)
        raise

    post.status = FacebookScheduledPostStatus.PUBLISHING
    post.error_msg = ''
    post.save(update_fields=['status', 'error_msg', 'updated_at'])


def handle_fb_profile_post_task_status(task, *, old_status: str, new_status: str) -> None:
    """Update the FacebookProfileScheduledPost (or FacebookProfilePost) tied
    to *task* when the agent reports COMPLETED / FAILED.

    Wired in from ``task/views.py:handle_task_status_update``. The dispatch
    code stamps ``payload.action='publish_profile_post'`` so we can filter.
    """
    from task.models import TaskStatus

    payload = task.payload or {}
    if payload.get('action') != 'publish_profile_post':
        return
    if new_status == old_status or new_status not in (TaskStatus.COMPLETED, TaskStatus.FAILED):
        return

    sched_id = payload.get('fb_scheduled_post_id')
    if not sched_id:
        return

    try:
        sp = FacebookProfileScheduledPost.objects.select_related('profile').get(id=sched_id)
    except FacebookProfileScheduledPost.DoesNotExist:
        logger.warning('FB profile post task %s references missing scheduled post %s', task.id, sched_id)
        return

    if new_status == TaskStatus.COMPLETED:
        # task.result is a JSONField populated by the worker callback. Agents
        # typically report ``{"post_url": "..."}`` but the field shape may
        # also be a list of step results; be defensive.
        post_url = ''
        result = task.result
        if isinstance(result, dict):
            post_url = result.get('post_url') or ''
        elif isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('post_url'):
                    post_url = item['post_url']
                    break

        # KHÔNG được tin "task completed" là bằng chứng đủ mạnh để đánh dấu
        # PUBLISHED khi không có post_url thật. facebook_create_post chỉ báo
        # "thành công" dựa trên việc ô soạn bài đóng lại — không xác nhận bài
        # thật sự lên feed; nếu facebook_copy_post_link (bước lấy link) cũng
        # thất bại, agent có thể tự kết luận "chắc đã đăng thành công, chỉ lỗi
        # lấy link" rồi báo completed — đã có case thật (task 3680, 28/09):
        # completed nhưng KHÔNG có bài nào tồn tại trên trang cá nhân, và trước
        # bản vá này bị đánh dấu published với fb_post_id rỗng, gây sai lệch dữ
        # liệu (report/UI hiển thị "đã đăng" cho một bài chưa từng lên thật).
        if not post_url:
            sp.status = FacebookScheduledPostStatus.FAILED
            sp.error_msg = (
                'Task báo hoàn thành nhưng không có link bài viết xác nhận — '
                'không đủ căn cứ để coi là đã đăng thành công. Cần kiểm tra thủ '
                'công trang cá nhân trước khi quyết định đăng lại.'
            )
            sp.save(update_fields=['status', 'error_msg', 'updated_at'])
            return

        sp.status = FacebookScheduledPostStatus.PUBLISHED
        sp.fb_post_id = post_url
        sp.error_msg = ''
        sp.save(update_fields=['status', 'fb_post_id', 'error_msg', 'updated_at'])

        owner = sp.owner or sp.profile.owner
        image_url = (sp.image_urls or [''])[0] if sp.image_urls else ''

        # Branch: re-routed group post → upsert FacebookGroupPost on the
        # target group. Timeline post → upsert FacebookProfilePost.
        target_group_id = payload.get('target_group_id')
        if target_group_id and sp.target_group_id:
            existing_post = None
            if owner and post_url:
                existing_post = FacebookGroupPost.objects.filter(
                    owner=owner, group_id=sp.target_group_id, post_url=post_url,
                ).first()
            if existing_post:
                existing_post.content = sp.content
                existing_post.image_url = image_url
                existing_post.status = FacebookPostStatus.SHARED
                existing_post.save(update_fields=['content', 'image_url', 'status', 'updated_at'])
            elif owner:
                FacebookGroupPost.objects.create(
                    group_id=sp.target_group_id,
                    post_url=post_url,
                    image_url=image_url,
                    caption='',
                    content=sp.content,
                    keywords=[],
                    status=FacebookPostStatus.SHARED,
                    owner=owner,
                )
        else:
            existing_post = None
            if owner and post_url:
                existing_post = FacebookProfilePost.objects.filter(
                    owner=owner, profile=sp.profile, post_url=post_url,
                ).first()
            if existing_post:
                existing_post.content = sp.content
                existing_post.image_url = image_url
                existing_post.status = FacebookPostStatus.SHARED
                existing_post.save(update_fields=['content', 'image_url', 'status', 'updated_at'])
            elif owner:
                FacebookProfilePost.objects.create(
                    profile=sp.profile,
                    post_url=post_url,
                    image_url=image_url,
                    caption='',
                    content=sp.content,
                    keywords=[],
                    status=FacebookPostStatus.SHARED,
                    owner=owner,
                )
    else:  # FAILED
        # Surface the task's last error message if any.
        err = ''
        result = task.result
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('error'):
                    err = str(item['error'])[:500]
                    break
        elif isinstance(result, str):
            err = result[:500]
        sp.status = FacebookScheduledPostStatus.FAILED
        sp.error_msg = _humanize_post_error(err) or 'Phoneagent task failed without details.'
        sp.save(update_fields=['status', 'error_msg', 'updated_at'])


class FacebookProfileViewSet(viewsets.ModelViewSet):
    serializer_class = FacebookProfileSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'profile_url', 'profile_uid', 'description']
    ordering_fields = ['created_at', 'updated_at', 'name', 'friend_count', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookProfile.objects.filter(owner=self.request.user)
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(
        detail=True,
        methods=['post'],
        url_path='upload-csv',
        url_name='upload-csv',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    @_guard_csv_import
    def upload_csv(self, request, pk=None):
        """Parse a CSV/XLSX file and create FacebookProfileScheduledPost records.

        Mirror of ``FacebookGroupViewSet.upload_csv``.
        """
        import csv
        import io as _io
        import os as _os
        from datetime import date as _date, timedelta as _td, datetime as _dt

        profile = self.get_object()
        csv_file = request.FILES.get('file')
        sheet_url = (request.data.get('sheet_url') or '').strip()
        # AI rewrite (on-demand later): ai_prompt is stored on every row and the
        # UI shows the "AI viết lại" button whenever it is non-empty. The client
        # sends ``ai_rewrite_enabled`` plus an optional ``ai_prompt``. When the
        # feature is enabled with no custom prompt we persist the default prompt
        # so the button still appears (and the rewrite stays consistent); when
        # disabled we store an empty string so the button stays hidden.
        ai_prompt = (request.data.get('ai_prompt') or '').strip()
        _ai_enabled_raw = request.data.get('ai_rewrite_enabled')
        if _ai_enabled_raw is None:
            # Backward-compat: older clients only sent ai_prompt → presence == enabled.
            ai_enabled = bool(ai_prompt)
        else:
            ai_enabled = str(_ai_enabled_raw).strip().lower() in ('true', '1', 'yes', 'on')
        if ai_enabled and not ai_prompt:
            ai_prompt = _DEFAULT_AI_REWRITE_PROMPT
        elif not ai_enabled:
            ai_prompt = ''
        # Optional batch-level redirect: every row in this import targets the
        # given FB group instead of the profile's timeline. The poster is the
        # profile itself; the post is anonymous; admin of that group must
        # approve before cron fires.
        target_group_id_raw = (request.data.get('target_group_id') or '').strip()
        target_group: FacebookGroup | None = None
        if target_group_id_raw:
            try:
                target_group_id_int = int(target_group_id_raw)
            except ValueError:
                return Response({'detail': 'target_group_id phải là số.'}, status=400)
            try:
                target_group = FacebookGroup.objects.get(id=target_group_id_int)
            except FacebookGroup.DoesNotExist:
                return Response({'detail': 'Group không tồn tại.'}, status=400)
            user = request.user
            if target_group.owner_id != user.id:
                shared_ok = False
                if target_group.team_id:
                    from teams.models import TeamMembership
                    shared_ok = TeamMembership.objects.filter(
                        team_id=target_group.team_id, user=user,
                    ).exists()
                if not shared_ok:
                    return Response(
                        {'detail': 'Group này không thuộc bạn và không share qua team.'},
                        status=403,
                    )
        api_rows: list[dict] | None = None
        if sheet_url:
            # Try Sheets API first to preserve smart chips (Drive URL chips).
            api_rows = _fetch_sheet_as_rows_via_api(sheet_url)
            if api_rows is None:
                try:
                    csv_bytes = _fetch_sheet_as_csv_bytes(sheet_url)
                except ValueError as exc:
                    return Response({'detail': str(exc)}, status=400)
                csv_io = _io.BytesIO(csv_bytes)
                csv_name = 'sheet.csv'
            else:
                csv_io = None
                csv_name = 'sheet.csv'
        elif csv_file:
            csv_io = csv_file.file
            csv_name = csv_file.name or ''
        else:
            return Response({'detail': 'No file or sheet_url provided.'}, status=400)

        last_ts = (
            FacebookProfileScheduledPost.objects.filter(
                profile=profile,
                status=FacebookScheduledPostStatus.PENDING,
            )
            .order_by('-scheduled_at')
            .values_list('scheduled_at', flat=True)
            .first()
        )
        if last_ts:
            auto_day = last_ts.astimezone(_LOCAL_TZ).date() + _td(days=1)
        else:
            auto_day = _date.today() + _td(days=1)

        # SeaweedFS is always used — no flag needed.

        existing_contents = set(
            FacebookProfileScheduledPost.objects.filter(profile=profile)
            .values_list('content', flat=True)
        )
        seen_in_upload: set[str] = set()
        skipped_rows: list[dict] = []

        def _read_xlsx_rows(file_obj):
            from openpyxl import load_workbook
            wb = load_workbook(file_obj, read_only=True, data_only=True)
            ws = wb.active
            iterator = ws.iter_rows(values_only=True)
            try:
                raw_headers = next(iterator)
            except StopIteration:
                return []
            headers = [(str(h).strip() if h is not None else '') for h in raw_headers]
            out = []
            for cells in iterator:
                if not cells or all(c is None or c == '' for c in cells):
                    continue
                d = {}
                for idx, value in enumerate(cells):
                    if idx >= len(headers):
                        break
                    key = headers[idx]
                    if key:
                        d[key] = value
                out.append(d)
            return out

        ext = _os.path.splitext(csv_name.lower())[1]
        try:
            if api_rows is not None:
                rows = api_rows
            elif ext in ('.xlsx', '.xlsm'):
                rows = _read_xlsx_rows(csv_io)
            else:
                content_io = _io.TextIOWrapper(csv_io, encoding='utf-8-sig')
                rows = list(csv.DictReader(content_io))
        except Exception as exc:
            return Response({'detail': f'Failed to read file: {exc}'}, status=400)

        header_keys = list(rows[0].keys()) if rows else []
        err = _validate_csv_headers(header_keys)
        if err:
            return Response({'detail': err}, status=400)
        resolver = _build_csv_resolver(header_keys)
        size_err = _validate_csv_import_size(
            rows,
            resolver,
            media_fields=('image_url', 'avatar_url', 'cover_url', 'story_url'),
        )
        if size_err:
            return size_err

        def _s(value):
            if value is None:
                return ''
            if isinstance(value, str):
                return value.strip()
            return str(value).strip()

        created_ids = []
        row_errors = []
        parsed_rows = []
        raw_urls_to_resolve = []

        # Candidate groups for per-row "Group" cell resolution: owned by the
        # user OR shared via a team they belong to. Pulled once before the
        # loop so each row is an O(N_groups) in-memory scan, not a query.
        candidate_groups: list[FacebookGroup] = []
        if resolver.get('group_url'):
            try:
                from teams.models import TeamMembership
                team_ids = list(
                    TeamMembership.objects.filter(user=request.user)
                    .values_list('team_id', flat=True)
                )
            except Exception:
                team_ids = []
            if team_ids:
                qs = (
                    FacebookGroup.objects.filter(owner=request.user)
                    .union(FacebookGroup.objects.filter(team_id__in=team_ids))
                )
            else:
                qs = FacebookGroup.objects.filter(owner=request.user)
            candidate_groups = list(qs)

        for i, row in enumerate(rows, start=2):
            content = _s(_row_get(row, resolver, 'content'))

            # "Via" filter: only import rows whose via/poster matches THIS
            # profile's FB-app account_name (empty cell = import anyway).
            # When the sheet HAS a "tên via" column, only rows whose via matches
            # THIS profile (by account_name OR display name) are imported — rows
            # with a different via OR an empty via are skipped. No via column at
            # all → import everything (backward compatible).
            if resolver.get('via_name') is not None:
                via = _s(_row_get(row, resolver, 'via_name')).strip().lower()
                via_targets = {
                    (profile.account_name or '').strip().lower(),
                    (profile.name or '').strip().lower(),
                }
                via_targets.discard('')
                if via not in via_targets:
                    skipped_rows.append({'row': i, 'reason': 'via_mismatch'})
                    continue

            if content and (content in existing_contents or content in seen_in_upload):
                skipped_rows.append({'row': i, 'reason': 'duplicate_content'})
                continue

            image_url_raw = _s(_row_get(row, resolver, 'image_url'))
            sv = _row_get(row, resolver, 'scheduled_at')

            scheduled_at = None
            if isinstance(sv, _dt):
                scheduled_at = sv if sv.tzinfo is not None else sv.replace(tzinfo=_LOCAL_TZ)
            else:
                scheduled_at_raw = _s(sv)
                if scheduled_at_raw:
                    for fmt in (
                        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                        '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M', '%d-%m-%Y',
                        '%d-%m-%y %H:%M:%S', '%d-%m-%y %H:%M', '%d-%m-%y',
                        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%d/%m/%Y',
                        '%d/%m/%y %H:%M:%S', '%d/%m/%y %H:%M', '%d/%m/%y',
                    ):
                        try:
                            scheduled_at = _dt.strptime(scheduled_at_raw, fmt).replace(tzinfo=_LOCAL_TZ)
                            break
                        except ValueError:
                            continue
                    if scheduled_at is None:
                        row_errors.append({
                            'row': i,
                            'error': (
                                f'Unrecognised scheduled_at format {scheduled_at_raw!r}. '
                                'Use e.g. "2026-05-28 13:00", "28-05-2026 13:00", '
                                'or "28-05-26 13:00".'
                            ),
                        })
                        continue

            if scheduled_at is None:
                scheduled_at = _dt.combine(auto_day, time(9, 0), tzinfo=_LOCAL_TZ)
                auto_day += _td(days=1)

            # Per-row target_group via the "Group" column. Falls back to the
            # batch-level ``target_group_id`` form arg (or NULL = timeline)
            # when the cell is empty. Non-empty + unresolved → row error.
            row_target_group: FacebookGroup | None = target_group
            group_cell_raw = _s(_row_get(row, resolver, 'group_url'))
            if group_cell_raw:
                try:
                    resolved = _resolve_target_group_from_cell(
                        group_cell_raw, candidate_groups,
                    )
                    if resolved is not None:
                        row_target_group = resolved
                except ValueError as exc:
                    row_errors.append({'row': i, 'error': str(exc)})
                    continue

            # Lazy media (posts only): the post's image_url cell is kept RAW and
            # re-hosted at publish time (_ensure_scheduled_post_media_hosted), so
            # we do NOT add it to raw_urls_to_resolve. Avatar/cover/story below
            # are single media-actions that still resolve at import via the batch
            # pass (raw_urls_to_resolve → url_map → _single_uploaded_url).

            avatar_raw = _s(_row_get(row, resolver, 'avatar_url'))
            cover_raw = _s(_row_get(row, resolver, 'cover_url'))
            story_raw = _s(_row_get(row, resolver, 'story_url'))
            for action_raw in (avatar_raw, cover_raw, story_raw):
                if action_raw:
                    raw_urls_to_resolve.append(action_raw)

            parsed_rows.append({
                'row_num': i,
                'content': content,
                'scheduled_at': scheduled_at,
                'image_url_raw': image_url_raw,
                'topic': _s(_row_get(row, resolver, 'topic'))[:64],
                'target_group': row_target_group,
                'avatar_raw': avatar_raw,
                'cover_raw': cover_raw,
                'story_raw': story_raw,
            })
            if content:
                seen_in_upload.add(content)

        url_map, media_errors = _batch_resolve_and_upload_media(raw_urls_to_resolve)

        for pr in parsed_rows:
            i = pr['row_num']
            content = pr['content']
            image_url_raw = pr['image_url_raw']
            # Lazy media (posts): store the raw cell; re-hosted at publish time.
            image_urls = [image_url_raw] if image_url_raw else []

            def _single_uploaded_url(raw_url: str, label: str) -> str | None:
                if not raw_url:
                    return None
                if raw_url in media_errors:
                    row_errors.append({'row': i, 'error': f'{label}: {media_errors[raw_url]}'})
                    return None
                urls = url_map.get(raw_url, [])
                return urls[0] if urls else None

            avatar_url = _single_uploaded_url(pr['avatar_raw'], 'avatar')
            cover_url = _single_uploaded_url(pr['cover_raw'], 'cover')
            story_url = _single_uploaded_url(pr['story_raw'], 'story')

            # Row may carry only avatar/cover/story without any content. Skip
            # only when literally nothing is set.
            if not content and not avatar_url and not cover_url and not story_url:
                continue

            if content:
                if image_urls:
                    try:
                        image_urls = _sort_post_media_videos_first(image_urls)
                    except ValueError as exc:
                        row_errors.append({'row': i, 'error': str(exc)})
                        image_urls = []  # skip post creation but still process avatar/cover/story
                        content = ''
            if content:
                obj = FacebookProfileScheduledPost.objects.create(
                    profile=profile,
                    content=content,
                    image_urls=image_urls,
                    topic=pr['topic'],
                    ai_prompt=ai_prompt,
                    scheduled_at=pr['scheduled_at'],
                    status=FacebookScheduledPostStatus.PENDING,
                    target_group=pr['target_group'],
                    owner=request.user,
                )
                created_ids.append(obj.id)

            for action_type, url in (
                ('change_avatar', avatar_url),
                ('change_cover', cover_url),
                ('post_story', story_url),
            ):
                if not url:
                    continue
                FacebookProfileScheduledMediaAction.objects.create(
                    profile=profile,
                    action_type=action_type,
                    image_url=url,
                    scheduled_at=pr['scheduled_at'],
                    status=FacebookScheduledPostStatus.PENDING,
                    owner=request.user,
                )

        return Response({
            'created': len(created_ids),
            'skipped': skipped_rows,
            'errors': row_errors,
        })

    def _media_action_request(self, request, action: str):
        """Shared handler for change-avatar / change-cover / post-story.

        Body:
          * ``file``: multipart image (uploaded → S3) — OR
          * ``image_url``: an already-uploaded URL (S3 or external)
        """
        profile = self.get_object()
        s3_url: str | None = None

        upload_file = request.FILES.get('file')
        if upload_file:
            try:
                # Upload to SeaweedFS – public Filer URL returned.
                s3_url = upload_to_seaweedfs(upload_file, upload_file.name or 'image.jpg')
            except Exception as exc:
                return Response({'detail': f'Upload to SeaweedFS failed: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        else:
            raw = (request.data.get('image_url') or '').strip()
            if not raw:
                return Response(
                    {'detail': 'Cần upload file hoặc cung cấp image_url.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            s3_url = raw

        try:
            task = _dispatch_fb_profile_media_action_task(profile, action, s3_url)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TransientPublishError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        return Response({
            'detail': f'Đã gửi task phoneagent (id={task.id}). Mở Task list để theo dõi.',
            'task_id': task.id,
            'image_url': s3_url,
        })

    @action(
        detail=True, methods=['post'], url_path='change-avatar', url_name='change-avatar',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser],
    )
    def change_avatar(self, request, pk=None):
        return self._media_action_request(request, 'change_avatar')

    @action(
        detail=True, methods=['post'], url_path='change-cover', url_name='change-cover',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser],
    )
    def change_cover(self, request, pk=None):
        return self._media_action_request(request, 'change_cover')

    @action(
        detail=True, methods=['post'], url_path='post-story', url_name='post-story',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser],
    )
    def post_story(self, request, pk=None):
        return self._media_action_request(request, 'post_story')


class FacebookProfilePostViewSet(viewsets.ModelViewSet):
    """CRUD + upload-image + publish-now for ``FacebookProfilePost``."""

    serializer_class = FacebookProfilePostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content', 'post_url', 'caption']
    ordering_fields = ['created_at', 'updated_at', 'status']
    ordering = ['-created_at']

    def get_queryset(self):
        qs = FacebookProfilePost.objects.filter(owner=self.request.user).select_related('profile')
        profile_id = self.request.query_params.get('profile')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        status_param = self.request.query_params.get('status')
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        qs = _apply_local_date_filter(qs, 'created_at', date_from, date_to)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(
        detail=False, methods=['post'], url_path='upload-image', url_name='upload-image',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    def upload_image(self, request):
        image_file = request.FILES.get('file')
        if not image_file:
            return Response({'detail': 'No image file provided.'}, status=status.HTTP_400_BAD_REQUEST)
        # Upload to SeaweedFS – public Filer URL returned, no presigning needed.
        image_url = upload_to_seaweedfs(image_file, image_file.name)
        return Response({'image_url': get_seaweedfs_url(image_url)}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        """Dispatch a phoneagent Task. The actual publish happens asynchronously
        on the device — status COMPLETED comes back via Task.status callback.
        """
        post = self.get_object()
        publish_content = (post.content or post.caption or '').strip()
        if not publish_content:
            return Response({'detail': 'Post content is required.'}, status=status.HTTP_400_BAD_REQUEST)

        images = list(post.image_urls or [])
        if not images and post.image_url:
            images = [post.image_url]
        try:
            data = _publish_profile_content(post.profile, publish_content, images or None)
        except DeviceBusyError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_409_CONFLICT)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        task_id = data.get('pending_task_id')
        return Response({
            'detail': (
                f'Đã gửi task phoneagent (id={task_id}) tới device. '
                'Mở Task list để theo dõi tiến trình — agent sẽ mở FB app + đăng bài.'
            ),
            'pending_task_id': task_id,
        })


# ───────────────── Scheduled-post comment-plan helpers (TikTok-style) ────────


def _fb_resolve_webhook_url(webhook_key):
    """Return (url, None) or (None, error_response) for an external webhook key."""
    from webhooks.services import ExternalWebhookNotConfiguredError, get_external_webhook_url
    try:
        return get_external_webhook_url(webhook_key), None
    except (ValueError, ExternalWebhookNotConfiguredError) as exc:
        logger.exception('FB comment webhook resolution error: %s', exc)
        return None, Response(
            {'detail': f'External webhook chưa được cấu hình hợp lệ: {webhook_key}.'},
            status=status.HTTP_502_BAD_GATEWAY,
        )


def _fb_extract_comment_pairs(webhook_response):
    """Parse the N8N webhook response into an ordered list of (device_id, text).

    Same contract as ``tiktok.views.TiktokVideoViewSet._extract_comment_pairs``
    (we reuse the TikTok webhook): supports ``{'output': [{'device_id', 'comment'}]}``
    and the legacy ``{'output': [{'<device_id>': 'text'}]}``, optionally wrapped
    in a single-element list."""
    if isinstance(webhook_response, list):
        if not webhook_response:
            return []
        webhook_response = webhook_response[0]
    if not isinstance(webhook_response, dict):
        return []
    output = webhook_response.get('output', [])
    if not isinstance(output, list):
        return []

    def _texts(raw):
        if isinstance(raw, str):
            return [raw]
        if isinstance(raw, (list, tuple)):
            return [x for x in raw if isinstance(x, str)]
        return []

    pairs = []
    for item in output:
        if not isinstance(item, dict):
            continue
        if 'device_id' in item and 'comment' in item:
            try:
                device_id = int(item['device_id'])
            except (TypeError, ValueError):
                continue
            for text in _texts(item['comment']):
                pairs.append((device_id, text))
        else:
            for device_id_str, raw in item.items():
                try:
                    device_id = int(device_id_str)
                except (TypeError, ValueError):
                    continue
                for text in _texts(raw):
                    pairs.append((device_id, text))
    return pairs


def _fb_build_comment_dispatch_payload(request, post):
    """Validate the dispatch request → (AgentGroup, payload, None) or (None, None, error).

    Payload mirrors the TikTok webhook contract so the same N8N flow works:
    ``{video_url, content, keywords, agent_group, devices}``. ``video_url`` carries
    the published post link; ``content`` the post text."""
    from agent_groups.models import AgentGroup

    agent_group_id = request.data.get('agent_group')
    if agent_group_id is None:
        return None, None, Response({'agent_group': ['This field is required.']}, status=status.HTTP_400_BAD_REQUEST)
    try:
        group = AgentGroup.objects.prefetch_related('members__device').get(id=agent_group_id, owner=request.user)
    except (TypeError, ValueError):
        return None, None, Response({'agent_group': ['A valid integer is required.']}, status=status.HTTP_400_BAD_REQUEST)
    except AgentGroup.DoesNotExist:
        return None, None, Response({'agent_group': ['You can only use your own resources.']}, status=status.HTTP_400_BAD_REQUEST)

    requested_devices = request.data.get('devices')
    group_device_ids = [m.device_id for m in group.members.all() if m.device_id]
    if requested_devices is None:
        device_ids = group_device_ids
    else:
        if not isinstance(requested_devices, list):
            return None, None, Response({'devices': ['Expected a list of device IDs.']}, status=status.HTTP_400_BAD_REQUEST)
        group_set = set(group_device_ids)
        if any(d not in group_set for d in requested_devices):
            return None, None, Response({'devices': ['All devices must belong to the selected agent group.']}, status=status.HTTP_400_BAD_REQUEST)
        device_ids = requested_devices

    payload = {
        'video_url': (post.fb_post_id or '').strip(),
        'content': request.data.get('content') if 'content' in request.data else (post.content or ''),
        'keywords': request.data.get('keywords') if isinstance(request.data.get('keywords'), list) else [],
        'agent_group': group.id,
        'devices': device_ids,
    }
    return group, payload, None


def _dispatch_fb_comment_plan_task(plan: 'FacebookScheduledPostCommentPlan', *, run_at=None):
    """Create a phoneagent Task that posts *plan*'s comment via the FB account on
    the plan's device.

    If *run_at* is None → dispatch immediately (send Kafka now). If *run_at* is a
    datetime → create the Task NOW (visible as "pending") plus a one-shot Schedule
    that runs it at *run_at* (used to space cluster replies CLUSTER_DELAY_MINUTES
    apart while still showing the next task right after the previous finishes; the
    user can press ▶️ to run it early). The worker's status flips the plan via
    ``handle_fb_scheduled_comment_task_status``."""
    from mbcontrol.kafka_utils import send_task_execution_message

    actor = plan.actor_fb_profile
    post = plan.scheduled_post
    post_url = (plan.post_link or post.fb_post_id or '').strip()
    comment = (plan.comment_content or '').strip()
    if actor is None:
        raise ValueError('Plan chưa có tài khoản FB (không tìm thấy FB account login trên device này).')
    if not actor.device_id:
        raise ValueError(f'Tài khoản "{actor.name}" chưa gắn thiết bị. Vào Sửa FB profile và chọn device.')
    if not actor.account_name:
        raise ValueError(f'Tài khoản "{actor.name}" chưa khai báo account_name.')
    if not post_url:
        raise ValueError('Bài đăng chưa có link (fb_post_id) — cần đăng xong / tìm link trước khi comment.')
    if not comment:
        raise ValueError('Nội dung comment không được rỗng.')

    # A plan with reply_to set is a reply inside a cluster: it must REPLY to the
    # cluster opener comment, not post a fresh top-level comment. reply_to stores
    # the opener's text, so the opener plan is the one whose comment_content
    # matches it — its actor account_name is the reply target's display name.
    # Prefer the stable root_plan FK; fall back to text matching for legacy rows
    # created before the FK existed.
    opener = plan.root_plan
    reply_snippet = (plan.reply_to or '').strip()
    if opener is None and reply_snippet:
        opener = (post.comment_plans
                  .filter(comment_content=plan.reply_to)
                  .exclude(id=plan.id)
                  .select_related('actor_fb_profile')
                  .order_by('created_at')
                  .first())
    target_username = ''
    target_comment_link = ''
    if opener is not None or reply_snippet:
        if not reply_snippet and opener is not None:
            reply_snippet = (opener.comment_content or '').strip()
        if opener:
            target_comment_link = (opener.comment_link or '').strip()
            if opener.actor_fb_profile:
                target_username = (opener.actor_fb_profile.account_name or '').strip()
        interaction_type = FacebookSeedingInteractionType.REPLY
        goal = _build_fb_seeding_goal(
            FacebookSeedingInteractionType.REPLY,
            post_url=post_url,
            actor_name=actor.account_name,
            comment_content=comment,
            reply_target_username=target_username,
            reply_target_snippet=reply_snippet[:200],
            reply_target_comment_link=target_comment_link,
        )
        root_id = opener.id if opener else '?'
        task_name = f'FB reply plan #{plan.id} → root #{root_id} — post #{post.id} via {actor.account_name}'
    else:
        interaction_type = FacebookSeedingInteractionType.COMMENT
        goal = _build_fb_seeding_goal(
            FacebookSeedingInteractionType.COMMENT,
            post_url=post_url,
            actor_name=actor.account_name,
            comment_content=comment,
        )
        task_name = f'FB comment plan #{plan.id} — post #{post.id} via {actor.account_name}'

    task = Task.objects.create(
        name=task_name,
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'seed_scheduled_comment',
            'fb_comment_plan_id': plan.id,
            'fb_scheduled_post_id': post.id,
            'post_url': post_url,
            'actor_fb_profile_id': actor.id,
            'account_name': actor.account_name,
            'interaction_type': interaction_type,
            'comment_content': comment,
            # Reply context — empty strings for top-level comments.
            'reply_target_username': target_username,
            'reply_target_snippet': reply_snippet,
            'reply_target_comment_link': target_comment_link,
        },
        device_id=actor.device_id,
        owner=plan.owner or post.owner,
    )

    if run_at is not None:
        # Deferred: create the task now (visible as pending) + a one-shot Schedule
        # that fires it at run_at via _poll_schedules/_execute_schedule. No Kafka now.
        from schedule.models import Schedule, ScheduleType
        Schedule.objects.create(
            task=task,
            schedule_type=ScheduleType.ONCE,
            run_at=run_at,
            next_run_at=run_at,
        )
        plan.task = task
        plan.execution_status = FacebookScheduledPostCommentPlan.ExecutionStatus.SCHEDULED
        plan.execution_last_error = ''
        plan.save(update_fields=['task', 'execution_status', 'execution_last_error', 'updated_at'])
        return task

    delivered = send_task_execution_message(task, devices_id=[actor.device_id])
    if not delivered:
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(f'Kafka dispatch thất bại cho FB comment task {task.id}.')

    plan.task = task
    plan.execution_status = FacebookScheduledPostCommentPlan.ExecutionStatus.SCHEDULED
    plan.execution_last_error = ''
    plan.save(update_fields=['task', 'execution_status', 'execution_last_error', 'updated_at'])
    return task


def handle_fb_scheduled_comment_task_status(task, *, old_status: str, new_status: str) -> None:
    """Flip a comment plan's state when its phoneagent task finishes. Wired in
    from ``task/views.py:perform_update``; filters on ``action='seed_scheduled_comment'``."""
    payload = task.payload or {}
    action = payload.get('action')
    # Fetch-link task (a different account copying the opener's comment link) is
    # handled by the cluster orchestrator.
    if action == 'seed_fetch_comment_link':
        from facebook.comment_execution import handle_fetch_link_status
        handle_fetch_link_status(task, old_status=old_status, new_status=new_status)
        return
    if action != 'seed_scheduled_comment':
        return
    if new_status == old_status or new_status not in (TaskStatus.COMPLETED, TaskStatus.FAILED):
        return
    plan_id = payload.get('fb_comment_plan_id')
    if not plan_id:
        return
    try:
        plan = FacebookScheduledPostCommentPlan.objects.get(id=plan_id)
    except FacebookScheduledPostCommentPlan.DoesNotExist:
        return

    if new_status == TaskStatus.COMPLETED:
        comment_url = ''
        result = task.result
        if isinstance(result, dict):
            comment_url = result.get('comment_url') or result.get('comment_link') or ''
        elif isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and (item.get('comment_url') or item.get('comment_link')):
                    comment_url = item.get('comment_url') or item.get('comment_link')
                    break
        plan.is_commented = True
        plan.comment_link = comment_url or plan.comment_link
        plan.execution_status = FacebookScheduledPostCommentPlan.ExecutionStatus.COMPLETED
        plan.execution_last_error = ''
        plan.save(update_fields=['is_commented', 'comment_link', 'execution_status', 'execution_last_error', 'updated_at'])
    else:  # FAILED
        err = ''
        result = task.result
        if isinstance(result, list):
            for item in reversed(result):
                if isinstance(item, dict) and item.get('error'):
                    err = str(item['error'])[:500]
                    break
        elif isinstance(result, str):
            err = result[:500]
        plan.execution_status = FacebookScheduledPostCommentPlan.ExecutionStatus.FAILED
        plan.execution_retry_count = (plan.execution_retry_count or 0) + 1
        plan.execution_last_error = err or 'Phoneagent task failed without details.'
        plan.save(update_fields=['execution_status', 'execution_retry_count', 'execution_last_error', 'updated_at'])

    # Advance the conversation cluster (opener → fetch link → replies in order).
    try:
        from facebook.comment_execution import advance_after_member
        advance_after_member(plan, new_status)
    except Exception:
        logger.exception('FB cluster advance failed for task %s', task.id)


class FacebookProfileScheduledPostViewSet(viewsets.ModelViewSet):
    """CRUD + publish-now + publish-due + delete-pending for profiles."""

    serializer_class = FacebookProfileScheduledPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['content']
    ordering_fields = ['scheduled_at', 'created_at', 'status']
    ordering = ['scheduled_at']

    def get_queryset(self):
        qs = FacebookProfileScheduledPost.objects.filter(owner=self.request.user).select_related('profile')
        profile_id = self.request.query_params.get('profile')
        status_param = self.request.query_params.get('status')
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        _safe_cleanup_post_media(instance, 'profile-scheduled')
        super().perform_destroy(instance)

    @action(detail=True, methods=['get'], url_path='post-comments')
    def post_comments(self, request, pk=None):
        """List real comments scraped from this published scheduled post."""
        post = self.get_object()
        return Response(FacebookProfileScheduledPostUserCommentSerializer(post.user_comments.all(), many=True).data)

    @action(detail=True, methods=['post'], url_path='fetch-comments')
    def fetch_comments(self, request, pk=None):
        """Scrape this published post's real comments via the external crawler."""
        post = self.get_object()
        url = (post.fb_post_id or '').strip()
        if not url:
            return Response(
                {'detail': 'Bài chưa có link đã đăng. Bấm "Tìm link" để lấy link bài rồi mới lấy bình luận.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            comments = _call_facebook_comment_api(
                url,
                int(request.data.get('max_comments', 100)),
                bool(request.data.get('include_replies', True)),
                int(request.data.get('num_sessions', 1)),
            )
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        saved = _upsert_scheduled_post_comments(post, comments)
        qs = post.user_comments.all()
        return Response({'saved': saved, 'total': qs.count(), 'comments': FacebookProfileScheduledPostUserCommentSerializer(qs, many=True).data})

    @action(detail=True, methods=['post'], url_path='cluster-comments')
    def cluster_comments(self, request, pk=None):
        """Cluster this post's scraped comments into semantic groups (Phân tích)."""
        post = self.get_object()
        comments = [t.strip() for t in post.user_comments.values_list('text', flat=True) if (t or '').strip()]
        if not comments:
            return Response({'detail': 'Chưa có bình luận. Hãy bấm "Lấy bình luận" trước.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = _cluster_comment_texts(comments)
        except FacebookCommentApiError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'source_comments': len(comments), **result})

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        post = self.get_object()
        if post.status == FacebookScheduledPostStatus.PUBLISHED:
            return Response({'detail': 'This scheduled post is already published.'}, status=status.HTTP_400_BAD_REQUEST)
        if post.status == FacebookScheduledPostStatus.PUBLISHING:
            return Response(
                {'detail': 'Bài đăng đang được phoneagent xử lý, chờ kết quả.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if post.status == FacebookScheduledPostStatus.CANCELLED:
            return Response({'detail': 'Cancelled scheduled post cannot be published.'}, status=status.HTTP_400_BAD_REQUEST)
        # Media còn phải tải + re-host → đẩy sang nền, đừng chặn request (xem
        # _needs_media_rehost). Ưu tiên trước cả kiểm device-busy: poll của
        # scheduler lo cả việc tải lẫn xếp hàng theo máy.
        if _needs_media_rehost(post):
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_MEDIA_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        # Device busy → queue (don't reject) so the user can fire several at once
        # and they drain one-by-one as the device frees.
        if _device_is_busy(post.profile.device_id if post.profile_id else None):
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        try:
            _publish_profile_scheduled_to_facebook(post)
        except DeviceBusyError:
            # Lost the race (device became busy) — queue instead of failing.
            _enqueue_scheduled_now(post)
            return Response(
                {'detail': _QUEUED_DETAIL, 'scheduled_post_id': post.id, 'status': post.status},
                status=status.HTTP_200_OK,
            )
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            {
                'detail': 'Đã dispatch task cho phoneagent.',
                'scheduled_post_id': post.id,
                'status': post.status,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'], url_path='update-link', url_name='update-link')
    def update_link(self, request, pk=None):
        """Worker callback: lưu link bài đã đăng và đánh dấu published.

        Lấy được link là bước cuối của task đăng bài (mobile-agent-worker đăng
        xong rồi đi tìm URL bài trên Facebook) — có link nghĩa là task đã xong
        nên set ``status=published``. Worker đã có ``fb_scheduled_post_id`` từ
        payload lúc dispatch nên gọi theo ``pk``. Body chấp nhận ``fb_post_id``
        hoặc ``post_url``.
        """
        post = self.get_object()
        url = (request.data.get('fb_post_id') or request.data.get('post_url') or '').strip()
        if not url:
            return Response(
                {'detail': 'Thiếu fb_post_id (hoặc post_url) trong body.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        post.fb_post_id = url[:255]
        post.status = FacebookScheduledPostStatus.PUBLISHED
        post.error_msg = ''
        post.save(update_fields=['fb_post_id', 'status', 'error_msg', 'updated_at'])
        try:
            from .s3_utils import cleanup_post_media
            cleanup_post_media(post.image_urls, exclude=post)
        except Exception:
            logger.warning('S3 cleanup failed for FB profile post %s', post.id, exc_info=True)
        return Response(self.get_serializer(post).data)

    @action(detail=True, methods=['post'], url_path='find-link', url_name='find-link')
    def find_link(self, request, pk=None):
        """Dispatch a phoneagent Task để worker đi tìm link bài đã đăng.

        Gửi Kafka message ``action='find_profile_post_link'`` xuống device của
        profile; worker tìm URL bài rồi gọi lại ``update-link`` để lưu + đánh dấu
        published.
        """
        post = self.get_object()
        # Dedup: if a find-link task for this post is already queued or running,
        # don't stack another — repeated clicks would otherwise pile up the queue.
        existing = Task.objects.filter(
            payload__action='find_profile_post_link',
            payload__fb_scheduled_post_id=post.id,
            status__in=[TaskStatus.QUEUED, TaskStatus.RUNNING],
        ).first()
        if existing:
            return Response(
                {
                    'detail': 'Đã có yêu cầu tìm link đang chờ/chạy cho bài này.',
                    'task_id': existing.id,
                    'scheduled_post_id': post.id,
                },
                status=status.HTTP_200_OK,
            )
        try:
            task = _dispatch_fb_find_post_link_task(post)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TransientPublishError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(
            {
                'detail': 'Đã gửi yêu cầu tìm link cho phoneagent.',
                'task_id': task.id,
                'scheduled_post_id': post.id,
            },
            status=status.HTTP_200_OK,
        )

    # ───────────────────────── Comment plans (TikTok-style) ─────────────────
    # Generate/review/approve/execute comments on a published scheduled post,
    # mirroring tiktok.TiktokVideoViewSet's comment-plan endpoints. Comments are
    # generated via the SAME N8N webhook (keyed by device); the FB account on
    # each device (actor_fb_profile) is who posts the comment.

    @action(detail=True, methods=['get'], url_path='comment-plans')
    def comment_plans(self, request, pk=None):
        """GET /facebook/profile-scheduled-posts/{id}/comment-plans/ — list plans."""
        post = self.get_object()
        # Oldest first so the cluster opener (created first) leads and its replies
        # follow in order — the model default is '-created_at' which inverts this.
        qs = (post.comment_plans.filter(owner=request.user)
              .select_related('device', 'actor_fb_profile', 'agent_group')
              .order_by('created_at', 'id'))
        return Response(FacebookScheduledPostCommentPlanSerializer(qs, many=True).data)

    @action(detail=True, methods=['post'], url_path='dispatch-comments')
    def dispatch_comments(self, request, pk=None):
        """Generate clustered comments (reply chain) via the TikTok N8N webhook."""
        return self._fb_dispatch_comment_plans(request, single=False)

    @action(detail=True, methods=['post'], url_path='dispatch-single-comment')
    def dispatch_single_comment(self, request, pk=None):
        """Generate one independent comment per device (no reply chain)."""
        return self._fb_dispatch_comment_plans(request, single=True)

    def _fb_dispatch_comment_plans(self, request, *, single: bool):
        post = self.get_object()
        group, payload, error = _fb_build_comment_dispatch_payload(request, post)
        if error:
            return error

        from tiktok.views import (
            N8N_DISPATCH_COMMENTS_WEBHOOK_KEY,
            N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_KEY,
        )
        webhook_key = N8N_DISPATCH_SINGLE_COMMENT_WEBHOOK_KEY if single else N8N_DISPATCH_COMMENTS_WEBHOOK_KEY
        webhook_url, error = _fb_resolve_webhook_url(webhook_key)
        if error:
            return error

        logger.info('FB dispatch comments (single=%s): %s', single, payload)
        try:
            resp = http_requests.post(webhook_url, json=payload, timeout=30)
            try:
                webhook_response = resp.json()
            except ValueError:
                webhook_response = resp.text
            logger.info('FB dispatch_comments webhook status=%s body=%s', resp.status_code, webhook_response)
            resp.raise_for_status()
        except http_requests.exceptions.RequestException as exc:
            logger.exception('FB dispatch_comments webhook error: %s', exc)
            return Response(
                {'detail': 'Không gọi được webhook tạo comment. Thử lại sau.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        created = []
        opener_plan = None
        for device_id, comment_text in _fb_extract_comment_pairs(webhook_response):
            actor = FacebookProfile.objects.filter(device_id=device_id, owner=request.user).first()
            # First pair is the cluster opener; the rest are replies linked to it
            # via the stable root_plan FK. reply_to text is still stored (for
            # display + legacy fallback) but is no longer the source of truth.
            is_reply = (not single) and opener_plan is not None
            plan = FacebookScheduledPostCommentPlan.objects.create(
                scheduled_post=post,
                post_link=payload['video_url'],
                device_id=device_id,
                actor_fb_profile=actor,
                agent_group=group,
                comment_content=comment_text,
                reply_to=(opener_plan.comment_content or '') if is_reply else '',
                root_plan=opener_plan if is_reply else None,
                is_approved=False,
                is_commented=False,
                owner=request.user,
            )
            created.append(plan)
            if not single and opener_plan is None:
                opener_plan = plan

        return Response(
            {
                'detail': 'Đã tạo kế hoạch comment.',
                'payload': payload,
                'comment_plans': FacebookScheduledPostCommentPlanSerializer(created, many=True).data,
            },
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['post'], url_path='comment-plans/approve-all')
    def approve_all_comment_plans(self, request, pk=None):
        """Approve every pending plan, then start the ordered run for each cluster
        (opener → fetch link via another account → replies in order)."""
        from facebook.comment_execution import execute_cluster, _resolve_cluster_root

        post = self.get_object()
        plans = list(post.comment_plans.filter(owner=request.user, is_approved=False))
        approved = 0
        for plan in plans:
            plan.is_approved = True
            plan.save(update_fields=['is_approved', 'updated_at'])
            approved += 1

        # Kick off one ordered run per distinct cluster (root). execute_cluster
        # is idempotent: it dispatches only the first not-done plan and skips
        # clusters already in flight.
        started_roots: set[int] = set()
        for plan in post.comment_plans.filter(owner=request.user, is_approved=True):
            root = _resolve_cluster_root(plan)
            if root.id in started_roots:
                continue
            started_roots.add(root.id)
            try:
                execute_cluster(root)
            except Exception:
                logger.exception('FB approve-all: execute_cluster failed for root #%s', root.id)
        return Response({'approved': approved})

    @action(detail=True, methods=['patch', 'delete'], url_path=r'comment-plans/(?P<plan_id>[^/.]+)')
    def comment_plan_detail(self, request, pk=None, plan_id=None):
        """PATCH (edit content / approve) or DELETE a single comment plan.

        Approving only MARKS the plan approved — it does NOT post. Posting runs
        as an ordered cluster via ``execute-cluster`` / ``approve-all`` so replies
        wait for the opener (and its captured link). This avoids replies firing
        before the opener comment exists."""
        post = self.get_object()
        try:
            plan = post.comment_plans.get(id=plan_id, owner=request.user)
        except FacebookScheduledPostCommentPlan.DoesNotExist:
            return Response({'detail': 'Comment plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        if request.method == 'DELETE':
            plan.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        serializer = FacebookScheduledPostCommentPlanSerializer(plan, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        plan = serializer.save()
        return Response(FacebookScheduledPostCommentPlanSerializer(plan).data)

    @action(detail=True, methods=['post'], url_path=r'comment-plans/(?P<plan_id>[^/.]+)/execute-cluster')
    def execute_comment_plan_cluster(self, request, pk=None, plan_id=None):
        """Run this plan's whole cluster in order: opener → fetch its link from a
        different account → replies one by one (each deep-linking to the opener)."""
        from facebook.comment_execution import execute_cluster

        post = self.get_object()
        try:
            plan = post.comment_plans.get(id=plan_id, owner=request.user)
        except FacebookScheduledPostCommentPlan.DoesNotExist:
            return Response({'detail': 'Comment plan not found.'}, status=status.HTTP_404_NOT_FOUND)
        force_restart = bool(request.data.get('force_restart'))
        try:
            root, next_plan, task = execute_cluster(plan, force_restart=force_restart)
        except TransientPublishError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(
            {
                'detail': 'Đã lên lịch chạy cụm comment.',
                'cluster_root_plan_id': root.id if root else None,
                'next_plan_id': next_plan.id if next_plan else None,
                'task_id': task.id if task else None,
            },
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['post'], url_path='ai-rewrite', url_name='ai-rewrite')
    def ai_rewrite(self, request, pk=None):
        """Generate a doctor-style rewrite of ``post.content`` using OpenAI.

        The rewrite is stored in ``ai_rewritten_content`` (preview only). User
        reviews + optionally edits, then calls ``ai-accept`` to move it into
        ``content`` for publishing.

        Request body may override the stored ``ai_prompt`` (e.g. user picks a
        different style on the fly without re-importing).
        """
        post = self.get_object()
        if post.status not in (
            FacebookScheduledPostStatus.PENDING,
            FacebookScheduledPostStatus.FAILED,
        ):
            return Response(
                {'detail': 'Chỉ rewrite được post ở trạng thái PENDING hoặc FAILED.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not (post.content or '').strip():
            return Response(
                {'detail': 'Post chưa có nội dung gốc để rewrite.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        prompt_override = (request.data.get('prompt') or '').strip()
        user_prompt = prompt_override or (post.ai_prompt or '').strip()

        try:
            rewritten = _ai_rewrite_content(post.content, user_prompt)
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except Exception as exc:
            logger.exception('AI rewrite failed for FB profile scheduled post %s', post.id)
            return Response({'detail': f'AI rewrite failed: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)

        post.ai_rewritten_content = rewritten
        if prompt_override and prompt_override != post.ai_prompt:
            post.ai_prompt = prompt_override
            post.save(update_fields=['ai_rewritten_content', 'ai_prompt', 'updated_at'])
        else:
            post.save(update_fields=['ai_rewritten_content', 'updated_at'])

        return Response({
            'id': post.id,
            'original_content': post.content,
            'ai_rewritten_content': post.ai_rewritten_content,
            'ai_prompt': post.ai_prompt,
        })

    @action(detail=True, methods=['post'], url_path='ai-accept', url_name='ai-accept')
    def ai_accept(self, request, pk=None):
        """Promote ``ai_rewritten_content`` (optionally edited by client) into
        ``content``. Clears ``ai_rewritten_content`` afterwards so the row is
        ready to publish without ambiguity about which version goes live.
        """
        post = self.get_object()
        # Client may pass edited text; otherwise use what's stored.
        edited = request.data.get('content')
        new_content = (edited if edited is not None else post.ai_rewritten_content) or ''
        new_content = new_content.strip()
        if not new_content:
            return Response(
                {'detail': 'Nội dung mới rỗng — không thể accept.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        post.content = new_content
        post.ai_rewritten_content = ''
        post.save(update_fields=['content', 'ai_rewritten_content', 'updated_at'])
        return Response({'id': post.id, 'content': post.content})

    @action(detail=False, methods=['post'], url_path='publish-due', url_name='publish-due')
    def publish_due(self, request):
        now = timezone.now()
        # Profile-side approval gate was removed: a user pre-approving their
        # own post added no value. Real moderation happens later via the FB
        # group admin queue (see Phase 2 + maybe_spam tab workflow).
        due_posts = FacebookProfileScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__lte=now,
        ).select_related('profile')
        published_count = 0
        failed_count = 0
        for post in due_posts:
            try:
                _publish_profile_scheduled_to_facebook(post)
                published_count += 1
            except Exception:
                failed_count += 1

        # Also fire any due media-action rows (avatar / cover / story).
        due_actions = FacebookProfileScheduledMediaAction.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
            scheduled_at__lte=now,
        ).select_related('profile')
        action_published = 0
        action_failed = 0
        for ar in due_actions:
            try:
                _publish_profile_scheduled_media_action(ar)
                action_published += 1
            except Exception:
                action_failed += 1

        return Response({
            'published': published_count,
            'failed': failed_count,
            'action_published': action_published,
            'action_failed': action_failed,
        })

    @action(detail=False, methods=['post'], url_path='delete-pending', url_name='delete-pending')
    def delete_pending(self, request):
        profile_id = request.query_params.get('profile') or request.data.get('profile')
        qs = FacebookProfileScheduledPost.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
        )
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        for post in qs:
            _safe_cleanup_post_media(post, 'profile-scheduled')
        deleted_count, _ = qs.delete()
        return Response({'deleted': deleted_count}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['get'], url_path='template', url_name='template')
    def template(self, request):
        """Return an .xlsx with the import-template headers + one sample row.

        Columns match the canonical CSV aliases the importer accepts (see
        ``_CSV_ALIASES``). Vietnamese header names are used so the file is
        self-explanatory to operators.
        """
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from django.http import HttpResponse
        from io import BytesIO

        wb = Workbook()
        ws = wb.active
        ws.title = 'Bài đăng FB Profile'

        # Header capitalisation is purely cosmetic — the importer's resolver
        # (_build_csv_resolver) lowercases every header before matching, so
        # "Nội dung" / "NỘI DUNG" / "nội dung" / "Nội Dung" all hit the same
        # alias. We ship Sentence case here because it reads more naturally.
        headers = [
            'Nội dung',
            'Ảnh',
            'Lịch đăng',
            'Chủ đề',
            'Group',
            'Ảnh đại diện',
            'Ảnh bìa',
            'Ảnh story',
        ]
        ws.append(headers)
        header_font = Font(bold=True, color='FFFFFF')
        header_fill = PatternFill(start_color='4F46E5', end_color='4F46E5', fill_type='solid')
        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=1, column=col_idx)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal='center', vertical='center')

        ws.append([
            'Nội dung bài đăng mẫu — chỉnh sửa hoặc xoá dòng này trước khi import.',
            'https://drive.google.com/drive/folders/<folder-id>',
            '2026-06-15 09:00',
            'FEEDBACK',
            'https://www.facebook.com/groups/<group-uid>',
            'https://drive.google.com/file/d/<file-id>/view',
            'https://drive.google.com/file/d/<file-id>/view',
            '',
        ])

        # Reasonable column widths so the file reads cleanly when opened.
        widths = [60, 40, 18, 18, 40, 40, 40, 40]
        for col_idx, width in enumerate(widths, start=1):
            ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = width

        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)
        response = HttpResponse(
            buf.read(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        response['Content-Disposition'] = (
            'attachment; filename="fb-profile-import-template.xlsx"'
        )
        return response


class FacebookProfileScheduledMediaActionViewSet(viewsets.ModelViewSet):
    """CRUD + publish-now for ``FacebookProfileScheduledMediaAction``.

    Mirror of :class:`FacebookProfileScheduledPostViewSet` but for the
    avatar / cover / story actions imported from Google Sheets.
    """

    serializer_class = FacebookProfileScheduledMediaActionSerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [SearchFilter, OrderingFilter]
    ordering_fields = ['scheduled_at', 'created_at', 'updated_at', 'status']
    ordering = ['scheduled_at']

    def get_queryset(self):
        qs = FacebookProfileScheduledMediaAction.objects.filter(
            owner=self.request.user,
        ).select_related('profile')
        profile_id = self.request.query_params.get('profile')
        status_param = self.request.query_params.get('status')
        action_type = self.request.query_params.get('action_type')
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        if status_param:
            qs = qs.filter(status=status_param)
        if action_type:
            qs = qs.filter(action_type=action_type)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        _safe_cleanup_post_media(instance, 'profile-media-action')
        super().perform_destroy(instance)

    @action(detail=True, methods=['post'], url_path='publish-now', url_name='publish-now')
    def publish_now(self, request, pk=None):
        ar = self.get_object()
        if ar.status == FacebookScheduledPostStatus.PUBLISHING:
            return Response(
                {'detail': 'Đang chạy — chờ kết quả trước khi đăng lại.'},
                status=status.HTTP_409_CONFLICT,
            )
        # Device busy → queue (don't reject) so several can be fired at once.
        if _device_is_busy(ar.profile.device_id if ar.profile_id else None):
            _enqueue_scheduled_now(ar)
            return Response(self.get_serializer(ar).data)
        try:
            _publish_profile_scheduled_media_action(ar)
        except DeviceBusyError:
            _enqueue_scheduled_now(ar)
            return Response(self.get_serializer(ar).data)
        except (ValueError, TransientPublishError) as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(self.get_serializer(ar).data)

    @action(detail=False, methods=['post'], url_path='delete-pending', url_name='delete-pending')
    def delete_pending(self, request):
        profile_id = request.query_params.get('profile') or request.data.get('profile')
        qs = FacebookProfileScheduledMediaAction.objects.filter(
            owner=request.user,
            status=FacebookScheduledPostStatus.PENDING,
        )
        if profile_id:
            qs = qs.filter(profile_id=profile_id)
        for ar in qs:
            _safe_cleanup_post_media(ar, 'profile-media-action')
        deleted_count, _ = qs.delete()
        return Response({'deleted': deleted_count}, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Phase 3 — Seeding (like/comment/reply) on Profile + Group posts
# ---------------------------------------------------------------------------


_SEEDING_DEFAULT_AI_PROMPT = (
    'Bạn là một người dùng Facebook bình thường, đang để lại một comment ngắn '
    'gọn (1-2 câu) cho một bài viết. Văn phong tự nhiên, tích cực, đúng ngữ '
    'cảnh bài viết. Không dùng emoji nếu không cần.'
)


def _build_fb_seeding_goal(
    action_type: str,
    *,
    post_url: str,
    actor_name: str,
    comment_content: str = '',
    reply_target_username: str = '',
    reply_target_snippet: str = '',
    reply_target_comment_link: str = '',
) -> str:
    actor = (actor_name or 'tài khoản chính').strip()
    url = (post_url or '').strip()
    if action_type == FacebookSeedingInteractionType.LIKE:
        return f'Vào facebook {actor}, mở bài đăng {url} và nhấn Thích.'
    if action_type == FacebookSeedingInteractionType.COMMENT:
        content = (comment_content or '').strip()
        return (
            f'Vào facebook {actor}, mở bài đăng {url} và viết bình luận: '
            f'"{content}"'
        )
    if action_type == FacebookSeedingInteractionType.REPLY:
        content = (comment_content or '').strip()
        link = (reply_target_comment_link or '').strip()
        # Prefer the captured comment permalink — it deep-links straight to the
        # target comment (robust). Fall back to locating by author + text.
        if link:
            return (
                f'Vào facebook {actor}, mở liên kết bình luận {link} và nhấn '
                f'Trả lời, gửi nội dung: "{content}"'
            )
        target_user = (reply_target_username or '').strip()
        snippet = (reply_target_snippet or '').strip()
        return (
            f'Vào facebook {actor}, mở bài đăng {url}. Tìm bình luận của '
            f'"{target_user}" (đoạn text: "{snippet}") và nhấn Trả lời, '
            f'gửi nội dung: "{content}"'
        )
    raise ValueError(f'Loại tương tác không hỗ trợ: {action_type!r}')


def _ai_generate_seed_comment(
    action_type: str,
    post_content: str,
    user_prompt: str = '',
    reply_target_snippet: str = '',
) -> str:
    """Generate comment/reply text via OpenAI. Mirrors ``_ai_rewrite_content``."""
    import os as _os
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError('OpenAI SDK chưa được cài trên backend.') from exc

    api_key = _os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise RuntimeError('OPENAI_API_KEY chưa cấu hình trên backend.')

    model = _os.environ.get('FACEBOOK_AI_REWRITE_MODEL', 'gpt-4o-mini')
    system_prompt = (user_prompt or '').strip() or _SEEDING_DEFAULT_AI_PROMPT

    if action_type == FacebookSeedingInteractionType.REPLY:
        user_payload = (
            f'Bài đăng gốc:\n"""\n{(post_content or "").strip()}\n"""\n\n'
            f'Bình luận bạn cần trả lời:\n"""\n{(reply_target_snippet or "").strip()}\n"""\n\n'
            'Hãy viết phần trả lời.'
        )
    else:
        user_payload = (
            f'Bài đăng:\n"""\n{(post_content or "").strip()}\n"""\n\n'
            'Hãy viết bình luận.'
        )

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        temperature=0.7,
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_payload},
        ],
    )
    text = (resp.choices[0].message.content or '').strip()
    if not text:
        raise RuntimeError('AI trả về nội dung rỗng.')
    return text


def _validate_seeding_action_for_dispatch(action) -> None:
    """Raise ``ValueError`` if *action* is missing required fields per type."""
    actor = action.actor_fb_profile
    if actor is None:
        raise ValueError('Chưa chọn tài khoản FB thực hiện (actor_fb_profile).')
    if not actor.device_id:
        raise ValueError(
            f'Actor "{actor.name}" chưa gắn với thiết bị. Vào Sửa FB profile '
            'và chọn device đã login account này.'
        )
    if not actor.account_name:
        raise ValueError(
            f'Actor "{actor.name}" chưa khai báo account_name. Vào Sửa FB '
            'profile để cập nhật.'
        )

    post = action.post
    if not (post.post_url or '').strip():
        raise ValueError('Bài viết chưa có post_url — chưa đăng xong nên không thể seed.')

    itype = action.interaction_type
    if itype in {FacebookSeedingInteractionType.COMMENT, FacebookSeedingInteractionType.REPLY}:
        if not (action.comment_content or '').strip():
            raise ValueError('Nội dung comment/reply không được rỗng.')
    if itype == FacebookSeedingInteractionType.REPLY:
        if not (action.reply_target_username or '').strip():
            raise ValueError('Reply yêu cầu tên user của comment gốc.')


def _dispatch_fb_seeding_action_task(action, *, surface: str):
    """Create + dispatch a phoneagent Task that performs *action* on the post.

    *surface* is ``'profile'`` or ``'group'`` and is reflected in the payload
    so the worker + Kafka mirror know which model to write back to.
    Returns the created :class:`Task`. Raises ``ValueError`` for permanent
    misconfigurations and ``TransientPublishError`` when Kafka dispatch fails.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    _validate_seeding_action_for_dispatch(action)

    actor = action.actor_fb_profile
    post = action.post
    goal = _build_fb_seeding_goal(
        action.interaction_type,
        post_url=post.post_url,
        actor_name=actor.account_name,
        comment_content=action.comment_content,
        reply_target_username=action.reply_target_username,
        reply_target_snippet=action.reply_target_snippet,
    )

    task = Task.objects.create(
        name=(
            f'FB seed {action.interaction_type} — post #{post.id} '
            f'via {actor.account_name}'
        ),
        description=goal,
        task_type=TaskType.GENERIC,
        status=TaskStatus.PENDING,
        payload={
            'agent': 'facebook',
            'action': 'seed_post_interaction',
            'surface': surface,
            'seeding_action_id': action.id,
            'fb_post_id': post.id,
            'post_url': post.post_url,
            'actor_fb_profile_id': actor.id,
            'account_name': actor.account_name,
            'interaction_type': action.interaction_type,
            'comment_content': action.comment_content,
            'reply_target_username': action.reply_target_username,
            'reply_target_snippet': action.reply_target_snippet,
        },
        device_id=actor.device_id,
        owner=action.owner or post.owner,
    )

    delivered = send_task_execution_message(task, devices_id=[actor.device_id])
    if not delivered:
        task.status = TaskStatus.FAILED
        task.save(update_fields=['status', 'updated_at'])
        raise TransientPublishError(
            f'Kafka dispatch thất bại cho FB seeding task {task.id}. '
            'Retry sau.'
        )

    action.task = task
    action.status = FacebookSeedingActionStatus.DISPATCHED
    action.error_msg = ''
    action.save(update_fields=['task', 'status', 'error_msg', 'updated_at'])
    return task


class _SeedingActionViewSetBase(viewsets.ModelViewSet):
    """Shared list/create/dispatch/ai-generate logic for both surfaces.

    Subclasses must set:
    * ``model`` — FacebookProfilePostSeedingAction or FacebookGroupPostSeedingAction
    * ``serializer_class``
    * ``_surface`` — 'profile' or 'group' (passed into task payload)
    """

    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]
    filter_backends = [OrderingFilter]
    ordering_fields = ['created_at', 'updated_at', 'status']
    ordering = ['-created_at']

    model = None
    _surface = ''

    def get_queryset(self):
        qs = self.model.objects.filter(owner=self.request.user).select_related(
            'post', 'actor_fb_profile', 'task',
        )
        post_id = self.request.query_params.get('post')
        status_param = self.request.query_params.get('status')
        if post_id:
            qs = qs.filter(post_id=post_id)
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=True, methods=['post'], url_path='dispatch', url_name='dispatch')
    def dispatch_action(self, request, pk=None):
        action_obj = self.get_object()
        if action_obj.status == FacebookSeedingActionStatus.DISPATCHED:
            return Response(
                {'detail': 'Đang chạy — chờ kết quả trước khi dispatch lại.'},
                status=status.HTTP_409_CONFLICT,
            )
        if action_obj.status == FacebookSeedingActionStatus.DONE:
            return Response(
                {'detail': 'Action đã hoàn thành.'},
                status=status.HTTP_409_CONFLICT,
            )
        try:
            _dispatch_fb_seeding_action_task(action_obj, surface=self._surface)
        except (ValueError, TransientPublishError) as exc:
            action_obj.status = FacebookSeedingActionStatus.FAILED
            action_obj.error_msg = str(exc)
            action_obj.save(update_fields=['status', 'error_msg', 'updated_at'])
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(self.get_serializer(action_obj).data)

    @action(detail=True, methods=['post'], url_path='ai-generate', url_name='ai-generate')
    def ai_generate(self, request, pk=None):
        action_obj = self.get_object()
        if action_obj.interaction_type == FacebookSeedingInteractionType.LIKE:
            return Response(
                {'detail': 'Like không cần generate nội dung.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user_prompt = (request.data.get('ai_prompt') or action_obj.ai_prompt or '').strip()
        post = action_obj.post
        try:
            generated = _ai_generate_seed_comment(
                action_obj.interaction_type,
                post.content or post.caption or '',
                user_prompt=user_prompt,
                reply_target_snippet=action_obj.reply_target_snippet,
            )
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        action_obj.ai_prompt = user_prompt
        action_obj.comment_content = generated
        action_obj.save(update_fields=['ai_prompt', 'comment_content', 'updated_at'])
        return Response(self.get_serializer(action_obj).data)


class FacebookProfilePostSeedingActionViewSet(_SeedingActionViewSetBase):
    model = FacebookProfilePostSeedingAction
    serializer_class = FacebookProfilePostSeedingActionSerializer
    _surface = 'profile'


class FacebookGroupPostSeedingActionViewSet(_SeedingActionViewSetBase):
    model = FacebookGroupPostSeedingAction
    serializer_class = FacebookGroupPostSeedingActionSerializer
    _surface = 'group'


# ── FB reaction-boost (hacklike17) ───────────────────────────────────────────
FB_HACK_LIKE_URL = 'https://hacklike17.com/api/fb_speed/s_like'


def _resolve_fb_share_url(url: str) -> str:
    """Follow a Facebook share/redirect link to its canonical permalink.

    ``/share/p/<token>/`` (and ``l.facebook.com``) links are opaque — they carry
    no numeric post id, so hacklike17 rejects them ("không có uid hợp lệ").
    Following the 302 with a generic ``Mozilla/5.0`` UA yields a
    ``story.php?story_fbid=<post>&id=<owner>`` URL that the service can parse.
    Returns the resolved URL, or the original on any failure (best-effort).
    """
    if not url or ('/share/' not in url and 'l.facebook.com' not in url):
        return url
    try:
        resp = http_requests.get(
            url, allow_redirects=True, timeout=10,
            headers={'User-Agent': 'Mozilla/5.0'},
        )
        return resp.url or url
    except http_requests.RequestException:
        return url


class FbHackKeyViewSet(viewsets.ModelViewSet):
    """CRUD for the user's hacklike17 tokens + a proxy ``like`` action that
    forwards a reaction-boost order to the external service using a stored token.
    The token never leaves the backend (FE only sees ``key_masked``)."""

    serializer_class = FbHackKeySerializer
    permission_classes = [permissions.IsAuthenticated]
    authentication_classes = [JWTAuthentication, ApiKeyAuthentication]

    def get_queryset(self):
        return FbHackKey.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=False, methods=['post'], url_path='like')
    def like(self, request):
        """Forward a reaction-boost order to hacklike17 (urlencoded), using the
        chosen stored token. Body: ``{hack_key, url, count, reaction, speed,
        uid?, server?, speed_server_2?, note?}``. Returns the service's JSON."""
        try:
            key = FbHackKey.objects.get(
                id=request.data.get('hack_key'), owner=request.user, is_active=True,
            )
        except (FbHackKey.DoesNotExist, ValueError, TypeError):
            return Response(
                {'detail': 'Key hack không hợp lệ hoặc đã tắt.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        url = (request.data.get('url') or '').strip()
        if not url:
            return Response({'detail': 'url là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        # Resolve opaque /share/ links → canonical story.php permalink so
        # hacklike17 can extract the post uid. No-op for normal post URLs.
        url = _resolve_fb_share_url(url)
        try:
            count = int(request.data.get('count') or 100)
        except (ValueError, TypeError):
            return Response({'detail': 'count không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)

        # Reactions: accept a list (multiple emotions in one order — only applies
        # to server 1/3/7/10) or a single 'reaction' for backward-compat. A list
        # value makes `requests` send repeated `reaction=` keys (urlencoded).
        reactions = request.data.get('reactions')
        if isinstance(reactions, list):
            reactions = [str(r).strip() for r in reactions if str(r).strip()]
        else:
            single = (request.data.get('reaction') or '').strip()
            reactions = [single] if single else []
        if not reactions:
            reactions = ['like']

        speed_raw = request.data.get('speed')
        payload = {
            'token': key.token,
            'uid': (request.data.get('uid') or '').strip(),
            'count': count,
            'server': (request.data.get('server') or 'server_1').strip(),
            'reaction': reactions,
            'speed': str(speed_raw if speed_raw not in (None, '') else 0),
            'speed_server_2': (request.data.get('speed_server_2') or 'low').strip(),
            'note': (request.data.get('note') or '').strip(),
            'url': url,
        }
        try:
            resp = http_requests.post(FB_HACK_LIKE_URL, data=payload, timeout=30)
            try:
                body = resp.json()
            except ValueError:
                body = {'status': 0, 'msg': (resp.text or '')[:300]}
        except http_requests.exceptions.RequestException as exc:
            logger.exception('fb_hack like error: %s', exc)
            return Response(
                {'detail': f'Gọi dịch vụ thất bại: {exc}'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        key.last_used_at = timezone.now()
        key.save(update_fields=['last_used_at', 'updated_at'])

        # Record the buff against the scheduled post it was launched from, so the
        # UI can tell which posts were boosted and by how much (cumulative). Only
        # on a successful order (hacklike17 returns a non-zero ``status``).
        sp_id = request.data.get('scheduled_post_id')
        sp_kind = (request.data.get('scheduled_post_kind') or '').strip()
        order_ok = str(body.get('status', '')).strip().lower() not in ('', '0', 'false', 'none')
        if sp_id and order_ok:
            from django.db.models import F
            from .models import FacebookProfileScheduledPost, FacebookScheduledPost
            model = {'profile': FacebookProfileScheduledPost, 'page': FacebookScheduledPost}.get(sp_kind)
            if model:
                model.objects.filter(id=sp_id).update(
                    buffed_like_total=F('buffed_like_total') + count,
                    buffed_at=timezone.now(),
                )

        return Response(body, status=status.HTTP_200_OK)
