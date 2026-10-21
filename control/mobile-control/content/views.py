import base64
import copy
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import requests
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.http import Http404, HttpResponse, HttpResponseNotAllowed, StreamingHttpResponse
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import parsers, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from mbcontrol.mixins import OwnedResourceMixin
from teams.models import TeamMembership

from .models import (
    Character,
    CharacterPostPlatform,
    CharacterScheduledPost,
    CharacterScheduledPostStatus,
    Content,
    ContentMode,
    ContentScriptAuditLog,
    ContentScriptChatMessage,
    ContentSourceType,
    CrawlContentSnapshot,
    CrawlRun,
    CrawlSource,
    FeatureSystemPrompt,
    ImageGenerationLog,
)
from .serializers import (
    CharacterScheduledPostSerializer,
    CharacterSerializer,
    ContentScriptChatMessageSerializer,
    ContentSerializer,
    CrawlContentSnapshotSerializer,
    CrawlRunSerializer,
    CrawlSourceSerializer,
    FeatureSystemPromptSerializer,
)
from . import ai_tenant, fal_utils

logger = logging.getLogger(__name__)


def _release_db_connection():
    """Return the request's pooled DB connection to the pool BEFORE a long
    external call (OpenAI / Facebook Graph) so it isn't held idle for the whole
    wait — otherwise the connection pool exhausts under load (``PoolTimeout``).
    Django transparently re-opens a connection from the pool on the next query.
    No-op inside a transaction (can't release a connection mid-atomic-block)."""
    try:
        from django.db import connection  # noqa: PLC0415
        if not connection.in_atomic_block:
            connection.close()
    except Exception:  # noqa: BLE001 — must never break the request
        pass


def _safe_content_disposition(raw):
    """Make a ``Content-Disposition`` value safe for an HTTP header.

    HTTP headers are latin-1 only. A raw non-ASCII download filename — e.g. a
    Vietnamese character name like ``Kỳ Duyên-source.jpg`` — makes Django MIME-mangle
    the whole header, so the browser can't read the ``attachment`` directive and
    opens the image inline instead of downloading it. When the value isn't latin-1
    encodable, rebuild it per RFC 6266: an ASCII ``filename="…"`` fallback plus a
    ``filename*=UTF-8''<percent-encoded>`` that modern browsers use for the real name.
    """
    if not raw:
        return ''
    try:
        raw.encode('latin-1')
        return raw  # already header-safe (ASCII filename) — pass through unchanged
    except UnicodeEncodeError:
        import re as _re  # noqa: PLC0415
        from urllib.parse import quote as _q  # noqa: PLC0415
        m = _re.search(r'filename="?([^";]+)"?', raw)
        fname = (m.group(1).strip() if m else 'download') or 'download'
        ascii_name = fname.encode('ascii', 'ignore').decode().strip() or 'download'
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{_q(fname)}"


def media_proxy(request, key):
    """Stream a SeaweedFS object back through THIS backend over HTTPS.

    The public SeaweedFS host (``SEAWEEDFS_PUBLIC_BASE_URL`` → media.example.com) is a
    plain-HTTP endpoint on a separate box that can go down; the browser also can't
    load it as an ``<img>`` on the HTTPS app (mixed content). So image URLs are
    rewritten on read (``facebook.s3_utils.get_presigned_image_url``) to point here,
    and we re-serve the bytes from the SeaweedFS S3 endpoint — which the backend
    reaches internally — over the app's own HTTPS origin. Read-only: GET/HEAD only,
    a single bucket, no key traversal. Public by design (these images were already
    public); it is a plain Django view so DRF auth does not apply.
    """
    if request.method not in ('GET', 'HEAD'):
        return HttpResponseNotAllowed(['GET', 'HEAD'])
    key = (key or '').lstrip('/')
    # Never let a crafted key escape the bucket or traverse the tree.
    if not key or '..' in key:
        raise Http404('media not found')

    from facebook.seaweedfs_utils import _get_seaweedfs_client  # noqa: PLC0415 — lazy

    bucket = getattr(settings, 'SEAWEEDFS_BUCKET', '') or 'user-media'
    client = _get_seaweedfs_client()

    # A download link (see ContentViewSet.download_url) appends
    # ?response-content-disposition=attachment; the SeaweedFS Filer honours this
    # natively, so the proxy must too — otherwise the "Tải về" button just opens the
    # image inline in a new tab (an <a download> to a cross-origin proxy URL is
    # ignored by the browser). Strip CR/LF defensively (Django blocks header
    # injection anyway).
    disposition = (request.GET.get('response-content-disposition') or '').replace('\r', '').replace('\n', '').strip()

    if request.method == 'HEAD':
        try:
            meta = client.head_object(Bucket=bucket, Key=key)
        except Exception:  # noqa: BLE001 — any miss/error → 404, never a 500 to the browser
            raise Http404('media not found')
        resp = HttpResponse(content_type=meta.get('ContentType') or 'application/octet-stream')
        resp['Content-Length'] = str(meta.get('ContentLength') or 0)
        resp['Cache-Control'] = 'public, max-age=31536000, immutable'
        if disposition:
            resp['Content-Disposition'] = _safe_content_disposition(disposition)
            resp['Cache-Control'] = 'no-store'
        return resp

    try:
        obj = client.get_object(Bucket=bucket, Key=key)
    except Exception:  # noqa: BLE001
        raise Http404('media not found')
    body = obj['Body']
    resp = StreamingHttpResponse(
        body.iter_chunks(chunk_size=64 * 1024),
        content_type=obj.get('ContentType') or 'application/octet-stream',
    )
    # UUID-named, immutable objects → cache hard so the browser (and any CDN put in
    # front later) almost never re-hits the backend, keeping this proxy cheap.
    resp['Cache-Control'] = 'public, max-age=31536000, immutable'
    content_length = obj.get('ContentLength')
    if content_length is not None:
        resp['Content-Length'] = str(content_length)
    if disposition:
        resp['Content-Disposition'] = _safe_content_disposition(disposition)
        # A download must NOT be CDN-cached: the filename varies per request, and a
        # response cached hard (immutable) before this header existed would keep
        # "opening the image in a tab" for a year. Inline display (no disposition)
        # keeps the long immutable cache set above.
        resp['Cache-Control'] = 'no-store'
    return resp


# Validation limits for the generate-scripts proxy. Numbers are deliberately
# tight: the n8n flow only knows how to read .xlsx templates.
ALLOWED_SCENARIO_EXTENSIONS = {'.xlsx'}
MAX_SCENARIO_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_ORDER_DESCRIPTION_LEN = 4000
# The n8n flow does RAG + multi-step LLM generation for 5 scripts so a real
# call routinely takes 1-3 minutes. 300s gives headroom; if it still trips
# we should switch to an async (job-id + poll) design instead of raising
# this further.
N8N_TIMEOUT_SECONDS = 300
# Trần độ dài prompt sinh ảnh. Đây là giới hạn CỦA MÌNH, KHÔNG phải của model: tài liệu
# OpenAI ghi rõ nhóm "GPT image models" (gpt-image-2 nằm trong đó) cho tới 32.000 ký tự ở
# cả images.generate lẫn images.edit — 4.000 là trần của dall-e-3, model mình không dùng.
# Đã đo thật ngày 22/07/2026: prompt 4.500 ký tự chạy TỐT trên cả hai endpoint.
# Vẫn giữ trần thấp có chủ ý, không mở tới 32.000: prompt của mình là nhiều KHỐI xếp
# chồng, và bệnh kinh niên ở đây là khối dài lấn át khối ngắn (khối tả da 107 từ đè bẹp
# câu cỡ cảnh 13 từ → ảnh mỗi lần một độ rộng). Nới trần rộng quá là mời thêm block chồng
# lên nhau. 5.000 đủ chỗ thở cho prompt tự gõ mà vẫn giữ kỷ luật.
# ĐỔI SỐ Ở ĐÂY THÌ ĐỔI LUÔN MAX_IMAGE_PROMPT_LEN trong ui/src/lib/quickPrompt.ts.
MAX_PROMPT_LEN = 5000
# Cap how many target images one swap-images call processes (1 GPU → serial).
MAX_DAILY_PROMPTS = 8
# Default OpenAI image model; override via settings.OPENAI_IMAGE_MODEL.
# Cap concurrent image generations. A burst (QuickImage fires 3/click × several
# users) of slow/timing-out OpenAI calls otherwise exhausts the web process's
# worker threads and the whole server stops responding. Beyond this many
# in-flight, extra requests get an immediate 503 (no thread held) instead of
# piling on. KHÔNG đổi sang acquire() có chờ: chờ trong này là giữ thread web, đúng
# kiểu treo mà cái cap này sinh ra để chặn.
#
# LƯU Ý semaphore này nằm CẤP PROCESS. Prod chạy 4 worker gunicorn nên tổng là 4×4=16,
# nhưng KHÔNG phải 16 suất dùng chung một hàng đợi: mỗi worker giữ hạn mức riêng và
# request bị phân vào worker ngẫu nhiên, nên một cụm request bắn cùng lúc có thể dồn quá
# 4 cái vào một worker và ăn 503 trong khi các worker khác đang rảnh. Vì thế client PHẢI
# tự điều tiết — xem IMAGE_GEN_MAX_INFLIGHT / withImageGenGate trong ui/src/lib/api.ts.
# (Comment cũ ở đây ghi "the frontend already treats a failed image as retry" — điều đó
# chưa bao giờ đúng cho tới khi cổng chặn phía client được thêm vào.)
_IMAGE_GEN_LIMIT = int(os.environ.get('IMAGE_GEN_CONCURRENCY', '8') or '8')
_IMAGE_GEN_SEMAPHORE = threading.BoundedSemaphore(_IMAGE_GEN_LIMIT)

# Timeout (seconds) for the GPT *text* calls (chat.completions). Without this the
# OpenAI SDK waits its 600s default, so when OpenAI is slow/down each call pins a
# worker thread for up to 10 minutes → the pool exhausts and the server hangs.
# 60s bounds that; max_retries=0 avoids the SDK's built-in retry back-off piling
# more wait on top. Override via env OPENAI_TEXT_TIMEOUT.
OPENAI_TEXT_TIMEOUT = float(os.environ.get('OPENAI_TEXT_TIMEOUT', '60') or '60')

# Chữ tiếng Việt có dấu — thứ DUY NHẤT quyết định một prompt có cần dịch sang tiếng
# Anh trước khi đưa cho gpt-image hay không (xem _translate_prompt_for_image).
_VIETNAMESE_CHARS_RE = re.compile(
    '[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]',
    re.IGNORECASE,
)

DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2'
# Image render quality (low|medium|high). 'low' is ~15x cheaper than 'high' and
# also suits the deliberately low-fi "authentic phone photo" look. Override via
# settings.OPENAI_IMAGE_QUALITY. NB: images.edit previously sent no quality, so
# it defaulted to the most expensive 'auto'/high — pinning it here is the main
# cost fix.
DEFAULT_OPENAI_IMAGE_QUALITY = 'low'
# Qualities a caller may explicitly request (the brief test-bench does, to let the
# user compare). Everything else stays on the low default above.
OPENAI_IMAGE_QUALITIES = ('low', 'medium', 'high')
# Output sizes gpt-image accepts. Portrait (1024x1536) is what a photoshoot brief
# asking for "9:16" actually gets — the model has no true 9:16 (0.5625); 1024x1536
# is 2:3 (0.667) and is the tallest frame available. Verified against the live API.
DEFAULT_OPENAI_IMAGE_SIZE = '1024x1024'
OPENAI_IMAGE_SIZES = ('1024x1024', '1024x1536', '1536x1024')

# Longest edge kept when an image is stored into character media. Must stay above
# 2*1536 = 3072 so a 2x "Làm nét" (upscale) of the tallest gpt-image frame survives
# the save intact — see the note in ContentViewSet._store_media for what happened
# when it did not. Still bounds a many-megapixel phone/DSLR upload.
MEDIA_MAX_EDGE = 4096


def _sniff_image_mime_ext(raw: bytes) -> tuple[str, str]:
    """Detect an image's real format from its magic bytes → ``(mime, ext)``.

    Character source images are stored as JPEG (sanitize re-encodes to JPEG) but
    were handed around labelled ``image/png`` / ``reference.png``. OpenAI's
    ``images.edit`` keys off that declared format, so JPEG-bytes-named-``.png``
    can be rejected as an invalid image — which then drops the reference and
    silently returns an unrelated face. Naming the part by its ACTUAL format
    (png/jpg/webp — the three ``images.edit`` accepts) avoids that. Falls back to
    PNG for anything unrecognised."""
    if raw[:3] == b'\xff\xd8\xff':
        return 'image/jpeg', 'jpg'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp', 'webp'
    return 'image/png', 'png'


def _parse_prompt_suggestions(raw: str) -> list[str]:
    """Extract a list of prompt strings from an OpenAI reply.

    Accepts a JSON array (optionally wrapped in ```json fences) or a plain
    newline / numbered list, and returns cleaned, de-duped non-empty strings.
    """
    import json as _json
    import re as _re

    text = (raw or '').strip()
    if not text:
        return []
    # Strip markdown code fences if present.
    if text.startswith('```'):
        text = _re.sub(r'^```[a-zA-Z]*\n?|\n?```$', '', text).strip()
    out: list[str] = []
    try:
        parsed = _json.loads(text)
        if isinstance(parsed, list):
            out = [str(x).strip() for x in parsed]
    except Exception:
        # Fallback: split lines, drop bullet/number prefixes and quotes.
        for line in text.splitlines():
            line = _re.sub(r'^\s*(?:\d+[\.\)]|[-*•])\s*', '', line).strip().strip('"').strip("',")
            if line:
                out.append(line)
    seen, result = set(), []
    for p in out:
        p = p.strip().strip('"').strip()
        if p and p not in seen:
            seen.add(p)
            result.append(p)
    return result


MAX_GENERATED_SCRIPTS_PER_SAVE = 50  # cap save-generated payload
DEFAULT_CONTENT_AI_MODEL = 'gpt-4o-mini'
FEATURE_ID_REPOST_CONTENT_AI = 'content_repost_ai'

# One-shot "gold" example for /topic-to-prompt. This endpoint produces the
# REUSABLE CHARACTER IDENTITY prompt — the FE prepends it to every scene
# (buildScenePrompt = identity + scene + shared camera), so it must describe ONLY
# the persistent subject (a fixed Filipino / Southeast Asian woman: face, skin,
# hair, body, expression) and must NOT bake in a specific outfit, background or
# camera/post-processing terms, which would fight the per-scene setting and the
# shared FACE_SWAP_CAMERA lock. The topic only lightly informs styling/vibe.
# One-shot example: a COUNTRY in → that nationality's identity out. Philippines
# is just the worked example (it locks the structure + realism vocabulary); the
# nationality is driven by the user's country, not hardcoded.
TOPIC_TO_PROMPT_EXAMPLE_TOPIC = 'Philippines'
# Gold example is now in VIETNAMESE — topic_to_prompt outputs Vietnamese so the
# user can read/edit the character description, so the one-shot must match that
# language (an English example would make the model answer in English).
TOPIC_TO_PROMPT_EXAMPLE = (
    'Phụ nữ Philippines khoảng đầu 20 tuổi, da sáng trung bình tông ấm, nét mặt Đông Nam Á tự nhiên, '
    'mặt trái xoan, mắt nâu sẫm hình hạnh nhân, tóc dài đen gợn sóng, vẻ ngoài đời thường bình dị. '
    'Gương mặt rõ nét, dễ nhận ra, không bị tóc hay tay che (biểu cảm thay đổi theo từng cảnh). '
    'Da tươi tự nhiên, mềm mại, không làm mịn quá mức.'
)
DEFAULT_FEATURE_SYSTEM_PROMPTS = {
    FEATURE_ID_REPOST_CONTENT_AI: (
        'You are an expert social media content writer. '
        'Produce concise, engaging, natural Vietnamese copy unless the user asks another language. '
        'Keep claims factual, avoid inventing details, avoid policy violations, and return only the final content text.'
    )
}


def _get_default_system_prompt(feature_id: str) -> str:
    return DEFAULT_FEATURE_SYSTEM_PROMPTS.get(feature_id, DEFAULT_FEATURE_SYSTEM_PROMPTS[FEATURE_ID_REPOST_CONTENT_AI])


def _resolve_feature_prompt(user, feature_id: str):
    """Resolve feature prompt with fallback: user override -> default row -> code default.

    Returns tuple: (prompt_obj, used_default)
    """
    user_prompt = FeatureSystemPrompt.objects.filter(user=user, feature_id=feature_id).first()
    if user_prompt:
        return user_prompt, False

    default_prompt, _ = FeatureSystemPrompt.objects.get_or_create(
        user=None,
        feature_id=feature_id,
        defaults={'system_prompt': _get_default_system_prompt(feature_id)},
    )
    if not default_prompt.system_prompt.strip():
        default_prompt.system_prompt = _get_default_system_prompt(feature_id)
        default_prompt.save(update_fields=['system_prompt', 'updated_at'])
    return default_prompt, True

# ─────────────────────────────────────────────────────────────────────────
# Chat-refine helpers — spec: docs/Gen_Scenario/chat-refine-design.md
# ─────────────────────────────────────────────────────────────────────────
MAX_CHAT_BODY_LEN = 4000
MAX_REFINE_BRIEF_LEN = 1000
SCRIPT_CHAT_HISTORY_LIMIT = 30      # last N turns sent to LLM context
SCRIPT_CHAT_MAX_TOKENS = 600
SCRIPT_CHAT_TEMPERATURE = 0.7
REFINE_TIMEOUT_SECONDS = 60          # /refine-frame on agent_teams is ~6s p99

# Mode → which frame fields are user-writable (server enforced; FE is just
# a hint). Voice/Text/Visual/Music are ALWAYS editable; structural fields
# (Footage/Time/Note) are read-only in real_footage mode because they're
# pinned to the catalog clip the script was wired to.
EDITABLE_FRAME_FIELDS_BY_MODE = {
    'real_footage': {'Voice', 'Text', 'Visual', 'Music'},
    'ai_video':     {'Voice', 'Text', 'Visual', 'Music', 'Footage', 'Time', 'Note'},
}
_DASH_EM = re.compile(r'\s*[—–]\s*')
_DASH_HYPHEN = re.compile(r'\s+-\s+')   # gạch nối có khoảng trắng (KHÔNG đụng "Q-Lean")
_MULTISPACE = re.compile(r'\s{2,}')

# Allowed reviewer focus values when calling agent_teams /refine-frame
ALLOWED_REVIEWER_FOCUS = {'style', 'brand', 'content', 'structure'}
DEFAULT_REVIEWER_FOCUS = 'style'

# Default chat model. Phase 1 v1: hard-code gpt-4o-mini (OQ4 — predictable
# cost). Override per-env via SCRIPT_CHAT_MODEL if needed.
DEFAULT_SCRIPT_CHAT_MODEL = 'gpt-4o-mini'

# ── Function-calling tool used by the chat endpoint ────────────────────
# AI decides whether to invoke this. When invoked we run the agent_teams
# /script-studio/refine-frame pipeline per requested frame and attach the
# before/after patches to the assistant message so the FE can show an
# inline Apply/Discard card (Phase 5 — replaces the standalone 🪄 modal).
APPLY_FRAME_PATCH_TOOL = {
    'type': 'function',
    'function': {
        'name': 'apply_frame_patch',
        'description': (
            'Đề xuất sửa MỘT hoặc NHIỀU frame cụ thể bằng pipeline AI refine. '
            'CHỈ dùng khi user yêu cầu rõ ràng sửa frame nào theo hướng nào '
            '(vd "frame 1 hook mạnh hơn", "sửa frame 2+3 theo hướng số liệu", '
            '"chốt hướng 2 cho frame 1"). KHÔNG dùng khi user chỉ hỏi mở / xin tư vấn / '
            'chưa quyết định hướng nào.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'frame_indexes': {
                    'type': 'array',
                    'items': {'type': 'integer', 'minimum': 1},
                    'description': 'Danh sách số Frame cần sửa (1-based, theo trường "Frame" trong KB).',
                },
                'brief': {
                    'type': 'string',
                    'description': 'Mô tả ngắn hướng sửa cho Reviser, vd "hook mạnh hơn bằng số liệu giật".',
                },
                'reviewer_focus': {
                    'type': 'string',
                    'enum': ['style', 'brand', 'content', 'structure'],
                    'description': 'Reviewer focus (mặc định style nếu không chắc).',
                },
            },
            'required': ['frame_indexes', 'brief'],
        },
    },
}


def _clean_frame_text(value):
    """Replace em/en/hyphen dashes used as punctuation with "..." so the
    downstream TTS doesn't choke. Preserves intra-word hyphens (Q-Lean)."""
    text = str(value or '')
    text = _DASH_EM.sub('... ', text)
    text = _DASH_HYPHEN.sub('... ', text)
    return _MULTISPACE.sub(' ', text).strip()


def _enforce_frame_contract(original: dict, candidate: dict, mode: str) -> dict:
    """Merge an AI/user candidate frame onto the original under mode rules.

    - Voice/Text/Visual always pass through _clean_frame_text.
    - Music passes through unchanged (just stringified).
    - Footage/Time/Note are kept from ``original`` in real_footage mode,
      and accepted from ``candidate`` in ai_video mode.
    - Phần / Frame / Source are NEVER editable from this entrypoint.
    """
    mode = mode if mode in EDITABLE_FRAME_FIELDS_BY_MODE else 'real_footage'
    out = dict(original or {})
    candidate = candidate or {}
    for key in ('Voice', 'Text', 'Visual'):
        if key in candidate:
            out[key] = _clean_frame_text(candidate[key])
    if 'Music' in candidate:
        out['Music'] = str(candidate.get('Music') or '')
    if mode == 'ai_video':
        for key in ('Footage', 'Time', 'Note'):
            if key in candidate:
                out[key] = str(candidate.get(key) or '')
    # Identity fields — preserve whatever original had.
    out['Phần'] = original.get('Phần', out.get('Phần', '')) if original else out.get('Phần', '')
    out['Frame'] = original.get('Frame', out.get('Frame', '')) if original else out.get('Frame', '')
    out['Source'] = ''
    return out


def _frame_brief(frame: dict, limit: int = 200) -> str:
    """Compact one-line preview of a frame for the chat system prompt."""
    if not isinstance(frame, dict):
        return ''
    voice = (frame.get('Voice') or '')[:limit]
    text = (frame.get('Text') or '')[:80]
    return f"Frame {frame.get('Frame', '?')} | Voice: {voice} | Text: {text}"


def _build_chat_system_prompt(content: Content, frame_target: int | None) -> str:
    """System prompt sent to OpenAI for every chat turn. Embeds the current
    KB context (so AI knows what frames to talk about) + the 7 hard rules
    from §10 OQ2 of the design doc."""
    frames = content.frames if isinstance(content.frames, list) else []
    frames_dump = '\n'.join(f"  - {_frame_brief(f)}" for f in frames[:20])
    mode = content.mode or 'real_footage'

    target_block = ''
    if frame_target and 1 <= frame_target <= len(frames):
        f = frames[frame_target - 1]
        target_block = (
            f"\nUSER ĐANG CHỈ ĐỊNH NÓI VỀ Frame {frame_target}:\n"
            f"  Voice: {f.get('Voice', '')}\n"
            f"  Text: {f.get('Text', '')}\n"
            f"  Visual: {f.get('Visual', '')}\n"
            f"  Music: {f.get('Music', '')}\n"
        )

    return (
        "Bạn là biên kịch video marketing seeding cho phòng khám thẩm mỹ Dr Đình Khanh. "
        f"Đang tư vấn cho user về KB \"{content.kb_name or '?'}\" "
        f"(OD {content.od_number or '?'}) — {len(frames)} frame.\n\n"
        "NGỮ CẢNH KB HIỆN TẠI:\n"
        f"{frames_dump or '  (chưa có frame nào)'}\n"
        f"{target_block}\n"
        f"MODE: {mode} "
        + ("(giữ Footage/Time/Note; chỉ tư vấn Voice/Text/Visual/Music)"
           if mode == 'real_footage'
           else "(mọi field mở edit)") +
        "\n\n"
        "CÔNG CỤ:\n"
        "- Bạn có DUY NHẤT 1 tool: `apply_frame_patch(frame_indexes, brief, reviewer_focus)`.\n"
        "- TUYỆT ĐỐI KHÔNG bao giờ nói \"hãy bấm nút X\" / \"hãy ấn 🪄\" / "
        "\"vui lòng cập nhật thủ công\" — UI KHÔNG có nút đó. Bạn TỰ áp dụng qua tool.\n\n"

        "XÁC ĐỊNH TARGET FRAME (RULE 1 — CỰC QUAN TRỌNG):\n"
        "- User message có prefix [@Frame N] → target = N.\n"
        "- User message KHÔNG có prefix [@Frame N] NHƯNG turn user trước đó CÓ "
        "→ target = N của turn trước (context kéo dài).\n"
        "- User message dạng \"chọn hướng X\", \"đi hướng Y\", \"OK\", \"được\", \"chốt\", "
        "\"theo hướng đó\" → KHÔNG diễn dịch \"X\"/\"Y\" thành frame index. "
        "Frame target VẪN là N từ context gần nhất.\n\n"

        "KHI NÀO GỌI TOOL (RULE 2 — BẮT BUỘC):\n"
        "- User yêu cầu sửa cụ thể: \"frame 1 hook mạnh hơn\", \"sửa frame 2 hài hơn\" → GỌI tool.\n"
        "- User CHỐT hướng sau khi bạn đã đề xuất: \"chọn hướng 1\", \"đi hướng A\", "
        "\"OK\", \"được\", \"theo Hướng B\" → BẮT BUỘC GỌI tool với frame_indexes = target frame "
        "(theo RULE 1) và brief mô tả hướng đã chốt.\n"
        "- User nói multi-frame: \"sửa frame 1+2\", \"cả KB\" → gọi tool 1 lần với "
        "frame_indexes = list.\n"
        "- Sau khi gọi tool: trả 1-2 câu xác nhận thân thiện "
        "(vd \"Đã refine Frame 2 theo hướng truyền động lực. Xem qua nhé!\"). "
        "TUYỆT ĐỐI KHÔNG mô tả nội dung patch bằng text (không liệt kê - Voice: ..., - Text: ...). "
        "Tool sẽ lo phần content; bạn chỉ confirm.\n\n"

        "KHI NÀO KHÔNG GỌI TOOL (RULE 3):\n"
        "- User hỏi mở (\"frame 1 nên thế nào?\"), chưa quyết định → trả text với "
        "2-3 hướng đánh số (\"1. **Hướng A:** mô tả + ví dụ \"...\"\"), kết bằng \"Bạn chọn hướng nào?\".\n"
        "- KHÔNG gọi tool khi user còn lưỡng lự.\n\n"

        "VÍ DỤ ĐÚNG:\n"
        "User: [@Frame 2] làm cảm xúc hơn\n"
        "→ AI (không tool, đề xuất): 1. **Hướng cảm xúc cá nhân:** ... 2. **Hướng nỗi sợ:** ... Bạn chọn hướng nào?\n"
        "User: chọn hướng 1\n"
        "→ AI (GỌI TOOL với frame_indexes=[2], brief=\"cảm xúc cá nhân\"): "
        "\"Đã refine Frame 2 theo hướng cảm xúc cá nhân. Xem qua nhé!\"\n\n"

        "TONE + FORMAT:\n"
        "- Thân thiện, gần gũi, chuyên nghiệp.\n"
        "- Markdown nhẹ OK: **bold** cho tên hướng, \"trích dẫn\" cho ví dụ. "
        "KHÔNG heading #, KHÔNG code block ```.\n"
        "- Mỗi turn ≤ 150 từ.\n\n"
        "QUY TẮC CỨNG (không vi phạm):\n"
        "1. Trả lời tiếng Việt, friendly trung tính, ≤ 250 từ.\n"
        "2. KHÔNG trả về JSON, KHÔNG bọc ``` (đó là việc của /refine-frame).\n"
        "3. KHÔNG bịa tên bác sĩ/sản phẩm/claim ngoài những gì đã có trong KB.\n"
        "4. TUYỆT ĐỐI không dùng \"-\" như dấu câu trong câu mẫu (TTS lỗi) — dùng \"...\".\n"
        "5. Bám phễu marketing: Hook (3s đầu) → Vấn đề → Giải pháp → CTA.\n"
        "6. Subtitle/Voice phải đọc xong trong ~5 giây.\n"
        "7. Claim y tế thận trọng: không hứa \"100% an toàn\", \"khỏi hẳn\", \"chắc chắn\"."
    )


def _call_refine_agent_teams(
    *,
    frame: dict,
    kb_context: dict,
    brief: str,
    reviewer_focus: str,
    recent_chat: list,
    mode: str,
    jwt_auth: str | None,
) -> dict | None:
    """Forward refine work to agent_teams /script-studio/refine-frame and
    re-enforce the mode contract server-side. Returns None on any failure
    (the caller decides whether to surface a partial response or 502)."""
    base = (getattr(settings, 'AGENT_TEAMS_URL', '') or '').rstrip('/')
    if not base:
        logger.error('refine: AGENT_TEAMS_URL not configured')
        return None
    headers = {'Content-Type': 'application/json'}
    if jwt_auth:
        headers['Authorization'] = jwt_auth
    try:
        resp = requests.post(
            f'{base}/script-studio/refine-frame',
            json={
                'frame': frame,
                'kb_context': kb_context,
                'brief': brief,
                'reviewer_focus': reviewer_focus,
                'recent_chat': recent_chat[:6] if isinstance(recent_chat, list) else [],
                'mode': mode,
                'allow_structure_change': False,
            },
            headers=headers,
            timeout=REFINE_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        logger.error('refine: agent_teams call failed: %s', exc)
        return None
    if not resp.ok:
        logger.error('refine: agent_teams returned %s', resp.status_code)
        return None
    try:
        body = resp.json()
    except ValueError:
        return None
    candidate = body.get('frame') if isinstance(body, dict) else None
    if not isinstance(candidate, dict):
        return None
    return _enforce_frame_contract(frame, candidate, mode)


def _process_chat_turn(
    *,
    frames: list,
    kb_name: str,
    od_number: str,
    mode: str,
    frame_target: int | None,
    body: str,
    prior_messages: list,
    jwt_auth: str | None,
) -> tuple[str, list, str]:
    """Run one chat turn through OpenAI with function calling.

    Returns: ``(assistant_text, patches, llm_model)``.
      - ``patches`` is ``[]`` for plain-advice turns; otherwise a list of
        ``{frame_index, before, after}`` dicts ready for the FE to render
        Apply/Discard cards.
      - On unrecoverable OpenAI failure raises RuntimeError; caller maps it
        to a 502.
    """
    api_key = getattr(settings, 'OPENAI_API_KEY', '')
    if not api_key:
        raise RuntimeError('OPENAI_API_KEY not configured')

    model_name = getattr(settings, 'SCRIPT_CHAT_MODEL', DEFAULT_SCRIPT_CHAT_MODEL)

    class _Shim:
        pass
    shim = _Shim()
    shim.kb_name = kb_name
    shim.od_number = od_number
    shim.frames = frames
    shim.mode = mode
    system_prompt = _build_chat_system_prompt(shim, frame_target)

    # Build the conversation. We INLINE frame_target as a "[@Frame N]"
    # prefix on every user turn so the AI never loses sight of which frame
    # the user is talking about across multiple turns. Without this the AI
    # would forget context — e.g. user says "@Frame 2 …" then "chọn hướng 1"
    # (no chip) and AI applies to Frame 1 instead of Frame 2 (real bug).
    chat_messages: list = [{'role': 'system', 'content': system_prompt}]
    # Track the most recent user-turn frame_target to use as a "sticky"
    # target reminder right before the current user message — defense in
    # depth in case the AI ignores the inline [@Frame N] tag.
    latest_history_target: int | None = None
    for m in (prior_messages or [])[-SCRIPT_CHAT_HISTORY_LIMIT:]:
        if not isinstance(m, dict):
            continue
        sender = str(m.get('sender') or '').upper()
        content_text = str(m.get('body') or '')[:MAX_CHAT_BODY_LEN]
        if not content_text:
            continue
        role = 'assistant' if sender == 'ASSISTANT' else 'user'
        if role == 'user':
            ft = m.get('frame_target')
            try:
                ft_int = int(ft) if ft is not None else None
            except (TypeError, ValueError):
                ft_int = None
            if ft_int and 1 <= ft_int <= len(frames):
                content_text = f'[@Frame {ft_int}] {content_text}'
                latest_history_target = ft_int
        chat_messages.append({'role': role, 'content': content_text})

    # Sticky target: prefer the current turn's frame_target, else fall back
    # to the last user turn that had one. Inject as a system message right
    # before the current user prompt so the AI sees an unmissable hint.
    sticky_target: int | None = None
    if frame_target and 1 <= frame_target <= len(frames):
        sticky_target = frame_target
    elif latest_history_target:
        sticky_target = latest_history_target

    if sticky_target:
        chat_messages.append({
            'role': 'system',
            'content': (
                f'CONTEXT REMINDER: target frame hiện tại là Frame {sticky_target}. '
                f'Nếu user nói ngắn (vd "1", "OK", "chốt", "hướng A"), HIỂU rằng họ vẫn '
                f'đang nói về Frame {sticky_target}. Khi gọi apply_frame_patch, '
                f'frame_indexes BẮT BUỘC = [{sticky_target}] trừ khi user nói rõ frame khác.'
            ),
        })

    # Current user turn — same chip-inline treatment so AI sees the target
    # right next to the content (cheaper than re-reading system prompt).
    if frame_target and 1 <= frame_target <= len(frames):
        chat_messages.append({'role': 'user', 'content': f'[@Frame {frame_target}] {body}'})
    else:
        chat_messages.append({'role': 'user', 'content': body})

    # If the user's current message looks like a CHOICE / CONFIRMATION
    # ("OK", "1", "2", "chọn hướng 1", "chốt", "đi hướng A") AND we have a
    # sticky target frame, force the tool. Otherwise the model sometimes
    # hallucinates a "Đã refine frame X..." text WITHOUT actually calling
    # the tool — leaving patches empty + a misleading message in the chat.
    # (Reported by user 2026-05-28.)
    body_norm = body.strip().lower()
    looks_like_choice = (
        body_norm.isdigit()
        or body_norm in {'ok', 'oki', 'đi', 'chốt', 'được', 'yes', 'có'}
        or any(body_norm.startswith(p) for p in (
            'chọn ', 'đi hướng', 'theo hướng', 'hướng ', 'chốt hướng',
            'làm theo', 'áp dụng', 'apply',
        ))
    )
    force_tool = bool(sticky_target) and looks_like_choice

    from openai import OpenAI  # noqa: PLC0415 — lazy
    client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
    completion = client.chat.completions.create(
        model=model_name,
        messages=chat_messages,
        tools=[APPLY_FRAME_PATCH_TOOL],
        tool_choice=(
            {'type': 'function', 'function': {'name': 'apply_frame_patch'}}
            if force_tool else 'auto'
        ),
        temperature=SCRIPT_CHAT_TEMPERATURE,
        max_tokens=800,
    )
    choices = getattr(completion, 'choices', None) or []
    if not choices:
        raise RuntimeError('OpenAI returned no choices')
    msg = choices[0].message

    # ── If AI called the tool, run refine per frame_index ─────────────────
    patches: list = []
    tool_calls = getattr(msg, 'tool_calls', None) or []
    if tool_calls:
        # Build a compact recent_chat snapshot for the reviser (last 6 turns).
        recent_chat = [
            {'sender': str(m.get('sender') or '').upper(),
             'body': str(m.get('body') or '')[:500]}
            for m in (prior_messages or [])[-6:]
            if isinstance(m, dict)
        ]
        kb_context = {'kb_name': kb_name, 'od_number': od_number, 'frames': frames}

        # Counters so we can rewrite the assistant text if the tool was
        # called but every single patch ended up being a no-op (AI's
        # confident "Đã refine frame X" would lie to the user otherwise —
        # bug reported 2026-05-28).
        attempted_indexes: list[int] = []
        noop_indexes: list[int] = []

        for tc in tool_calls:
            fn = getattr(tc, 'function', None)
            if not fn or getattr(fn, 'name', None) != 'apply_frame_patch':
                continue
            try:
                args = json.loads(getattr(fn, 'arguments', None) or '{}')
            except (TypeError, ValueError):
                args = {}
            raw_indexes = args.get('frame_indexes') or []
            if not isinstance(raw_indexes, list):
                continue
            brief = str(args.get('brief') or '')[:MAX_REFINE_BRIEF_LEN]
            focus = str(args.get('reviewer_focus') or DEFAULT_REVIEWER_FOCUS).strip().lower()
            if focus not in ALLOWED_REVIEWER_FOCUS:
                focus = DEFAULT_REVIEWER_FOCUS

            seen = set()
            for raw_idx in raw_indexes:
                try:
                    idx = int(raw_idx)
                except (TypeError, ValueError):
                    continue
                if idx in seen or not (1 <= idx <= len(frames)):
                    continue
                seen.add(idx)
                attempted_indexes.append(idx)
                original = frames[idx - 1]
                if not isinstance(original, dict):
                    continue
                new_frame = _call_refine_agent_teams(
                    frame=original,
                    kb_context=kb_context,
                    brief=brief,
                    reviewer_focus=focus,
                    recent_chat=recent_chat,
                    mode=mode,
                    jwt_auth=jwt_auth,
                )
                if not new_frame:
                    noop_indexes.append(idx)
                    continue
                # Compact patch: only the AI-editable fields. FE applies via
                # update-frame (post-save) or local state (preview).
                editable = {'Voice', 'Text', 'Visual', 'Music'}
                before = {k: original.get(k, '') for k in editable}
                after = {k: new_frame.get(k, '') for k in editable}
                # Skip no-op patches (identical before/after). We still
                # remember the index so we can correct the assistant text
                # below — otherwise AI lies "Đã refine frame X" when nothing
                # changed.
                if before == after:
                    noop_indexes.append(idx)
                    continue
                patches.append({
                    'frame_index': idx,
                    'before': before,
                    'after': after,
                })

    assistant_text = (msg.content or '').strip()

    # ── Safety net 1: tool called, ALL patches no-op ─────────────────────
    # Rewrite the message so the user understands no actual diff was
    # produced — otherwise chat shows "Đã refine frame X..." with no
    # Apply card and the user can't tell whether the refine ran.
    if tool_calls and attempted_indexes and not patches and noop_indexes:
        idx_list = ', '.join(str(i) for i in sorted(set(noop_indexes)))
        assistant_text = (
            f'Mình đã thử refine frame {idx_list} nhưng AI thấy không có '
            f'thay đổi đáng kể — frame có vẻ đã ổn theo hướng này. '
            f'Bạn muốn thử hướng khác cụ thể hơn không?'
        )
    # ── Safety net 2: AI hallucinated refine text WITHOUT calling tool ───
    # The model occasionally writes "Đã refine frame X..." without actually
    # invoking apply_frame_patch — leaving patches empty and the user
    # staring at a lying assistant message. Detect via lexical match and
    # rewrite into a truthful retry prompt.
    elif (not tool_calls and not patches and assistant_text):
        lower = assistant_text.lower()
        if any(p in lower for p in (
            'đã refine', 'đã sửa', 'đã chỉnh', 'đã tối ưu', 'đã áp dụng'
        )):
            target_hint = (
                f' frame {sticky_target}' if sticky_target else ''
            )
            assistant_text = (
                f'Mình chưa thực sự refine được{target_hint}. '
                f'Bạn nói rõ hơn muốn sửa theo hướng nào nhé '
                f'(vd: "hook giật hơn bằng số liệu", "cảm xúc cá nhân").'
            )
    elif not assistant_text:
        if patches:
            frame_list = ', '.join(str(p['frame_index']) for p in patches)
            assistant_text = f'Đã refine frame {frame_list}. Áp dụng nếu OK.'
        else:
            assistant_text = 'Mình chưa rõ ý lắm — bạn nói rõ hơn muốn sửa frame nào theo hướng nào nhé?'

    return assistant_text[:MAX_CHAT_BODY_LEN], patches, model_name


class CrawlResultsPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 100


def get_accessible_crawl_sources(user):
    if not user.is_authenticated:
        return CrawlSource.objects.none()
    team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
    return CrawlSource.objects.filter(Q(owner=user) | Q(team_id__in=team_ids)).distinct()


class ContentPagination(PageNumberPagination):
    """Pagination for the Content list. Default 20/page, capped at 100.

    Override with ?page_size=N (≤ 100). DRF wraps the response as
    ``{count, next, previous, results}``.
    """
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100


class CharacterPagination(PageNumberPagination):
    """Pagination for character lists.

    Keep the default page size small so the UI only transfers the 10 most
    recent characters per request. The upper bound is also capped at 10 so the
    client cannot accidentally request a larger page.
    """
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 10


class ContentViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = Content.objects.all()
    serializer_class = ContentSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = ContentPagination

    def get_queryset(self):
        """Apply optional list filters in addition to OwnedResourceMixin's
        ownership scoping. Filters are accepted via query params:

          - date_from=YYYY-MM-DD : only content created on/after this date
          - date_to=YYYY-MM-DD   : only content created on/before this date
          - search=<text>        : case-insensitive substring match against
                                   title, kb_name, od_number or text_content

        Bad date values are silently ignored — we never raise on filter parse
        errors so a junk URL doesn't 500.
        """
        qs = super().get_queryset()
        params = self.request.query_params

        # NOTE: we filter by created_at date so the FE's "from/to date pickers"
        # are timezone-agnostic — server-side date comparison uses the server's
        # current_tz, which is consistent with what FE displays via toLocaleString.
        date_from = parse_date(params.get('date_from', '') or '')
        date_to = parse_date(params.get('date_to', '') or '')
        if date_from:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__date__lte=date_to)

        search = (params.get('search') or '').strip()
        if search:
            # Cap search length so a malicious caller cannot pass a 10 MB
            # query and DOS the DB with a huge LIKE pattern.
            search = search[:200]
            qs = qs.filter(
                Q(title__icontains=search)
                | Q(kb_name__icontains=search)
                | Q(od_number__icontains=search)
                | Q(text_content__icontains=search)
            )
        return qs

    def retrieve(self, request, *args, **kwargs):
        """Lazy fallback: legacy Content rows created before migration 0006
        have ``origin_frames=[]``. The first time the editor opens such a
        row we snapshot ``frames → origin_frames`` so the Restore button has
        something to revert to. The eager backfill command covers the bulk
        of legacy rows at deploy-time; this is just belt-and-braces for
        Content created during the deploy window itself.
        """
        instance = self.get_object()
        if (
            instance.source_type == ContentSourceType.GENERATED
            and not instance.origin_frames
            and instance.frames
        ):
            instance.origin_frames = copy.deepcopy(instance.frames)
            instance.save(update_fields=['origin_frames'])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @action(
        detail=False,
        methods=['post'],
        url_path='generate-scripts',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    def generate_scripts(self, request):
        """Validate inputs then proxy the request to the n8n webhook that
        generates 5 script variants.

        Multipart fields:
          - ``file``               : .xlsx template, ≤ 10 MB. **OPTIONAL** — when
                                     omitted, n8n self-authors from the brief + RAG.
          - ``order_description``  : free-form rewriting/brief instructions.
                                     **Required when no file** is provided.

        The n8n URL is read from ``settings.N8N_GENERATE_SCRIPTS_URL`` —
        never embedded in the JS bundle; never logged with the response.
        """
        file_obj = request.FILES.get('file')
        order_description = request.data.get('order_description', '') or ''
        # mode: 'real_footage' (giàu + neo clip kho, mặc định) | 'ai_video' (thuần sáng tạo)
        mode = (request.data.get('mode', '') or 'real_footage').strip()
        if mode not in ('real_footage', 'ai_video'):
            mode = 'real_footage'

        # ── Input validation ────────────────────────────────────────────────
        # The template file is OPTIONAL: when omitted, the n8n flow self-authors
        # 5 scripts from ``order_description`` + RAG. In that case a non-empty
        # ``order_description`` is REQUIRED (the no-file n8n branch raises without
        # it). When a file IS sent we validate its extension/size as before.
        if not isinstance(order_description, str):
            return Response(
                {'detail': 'order_description must be a string.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not file_obj and not order_description.strip():
            return Response(
                {'detail': 'order_description is required when no template file is provided.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if file_obj:
            ext = os.path.splitext(file_obj.name)[1].lower()
            if ext not in ALLOWED_SCENARIO_EXTENSIONS:
                return Response(
                    {'detail': f'Unsupported file extension {ext!r}. Allowed: .xlsx'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if file_obj.size > MAX_SCENARIO_BYTES:
                return Response(
                    {'detail': 'File too large (max 10 MB).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        if len(order_description) > MAX_ORDER_DESCRIPTION_LEN:
            return Response(
                {'detail': f'order_description must be ≤ {MAX_ORDER_DESCRIPTION_LEN} chars.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Forward to n8n ──────────────────────────────────────────────────
        n8n_url = getattr(settings, 'N8N_GENERATE_SCRIPTS_URL', '') or ''
        if not n8n_url:
            return Response(
                {'detail': 'Script-generation service is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Only attach the file part when a template was actually uploaded. n8n
        # routes on the PRESENCE of binary data, so sending an empty file part
        # would mis-route the request into the "has template" branch and fail.
        post_kwargs = {
            'data': {'order_description': order_description, 'mode': mode},
            'timeout': N8N_TIMEOUT_SECONDS,
        }
        if file_obj:
            file_obj.seek(0)
            post_kwargs['files'] = {
                'file': (
                    file_obj.name,
                    file_obj.read(),
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            }
        try:
            resp = requests.post(n8n_url, **post_kwargs)
        except requests.RequestException as exc:
            # Don't leak the n8n URL or stack trace to the client.
            logger.error('generate_scripts: n8n call failed: %s', exc)
            return Response(
                {'detail': 'Failed to reach the script-generation service.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        if not resp.ok:
            logger.error(
                'generate_scripts: n8n returned %s (body trimmed)',
                resp.status_code,
            )
            return Response(
                {'detail': f'Script-generation service returned HTTP {resp.status_code}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            body = resp.json()
        except ValueError:
            return Response(
                {'detail': 'Script-generation service returned non-JSON.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Attach the source filename + mode so the FE can echo both back to
        # /save-generated without having to track them in its own state.
        if isinstance(body, dict):
            body.setdefault(
                'parent_scenario_filename', file_obj.name if file_obj else ''
            )
            body.setdefault('mode', mode)
        return Response(body, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='generate-image')
    def generate_image(self, request):
        """Generate a single image from a prompt via OpenAI (``settings``
        ``OPENAI_IMAGE_MODEL``; key chọn theo CÔNG TY của người gọi — xem
        ``content.ai_tenant``, không đọc thẳng ``settings.OPENAI_API_KEY``).

        Body: ``{"prompt": "..."}``. Returns ``{"image": "data:image/png;base64,…"}``.

        Used by the "Tạo nhân vật" wizard for both the reference-character step
        and each daily-scene step, so the user can review/regenerate each image
        before any face swap happens.
        """
        prompt = (request.data.get('prompt') or '').strip()
        if not prompt:
            return Response({'detail': 'A prompt is required.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(prompt) > MAX_PROMPT_LEN:
            # Người dùng chỉ nhìn thấy ô nhập vài trăm chữ của mình, còn prompt thật
            # gửi đi còn gồm mô tả nhân vật + các khối phong cách do FE ghép vào. Báo
            # rõ con số và chỗ cần rút gọn, thay vì một câu tiếng Anh về "chars"
            # khiến họ tưởng ô nhập của mình quá dài.
            return Response(
                {'detail': (
                    f'Prompt dài {len(prompt)} ký tự, vượt giới hạn {MAX_PROMPT_LEN} ký tự. Prompt gửi '
                    'đi gồm cả mô tả nhân vật và các khối phong cách chứ không chỉ phần bạn gõ — hãy '
                    'rút gọn phần mô tả nhân vật.'
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # A single reference (face-lock) OR a list (realref scene: [real photo,
        # character image] → keep the real photo's pose/scene, put the character's
        # face on it). ``reference_images`` (list) wins when both are present.
        reference_image = request.data.get('reference_image') or None
        reference_images = request.data.get('reference_images') or None
        if reference_images is not None and not isinstance(reference_images, list):
            return Response({'detail': 'reference_images must be a list.'}, status=status.HTTP_400_BAD_REQUEST)
        ref_arg = reference_images if reference_images else reference_image
        # Edit flow sets no_fallback so a rejected/failed images.edit surfaces a
        # clear error instead of silently returning an unrelated text-only image.
        no_fallback = bool(request.data.get('no_fallback'))
        # explain_errors: prompt do người dùng tự nhập (không phải prompt mặc định
        # của hệ thống). Khi tạo ảnh lỗi, nhờ GPT đọc lỗi gốc + prompt rồi giải
        # thích dễ hiểu cho người dùng thay vì trả thông báo lỗi tiếng Anh khó hiểu.
        explain = bool(request.data.get('explain_errors'))
        # Portrait ('1024x1536') is what a brief asking for 9:16 should send.
        size = (request.data.get('size') or DEFAULT_OPENAI_IMAGE_SIZE).strip()
        if size not in OPENAI_IMAGE_SIZES:
            return Response(
                {'detail': f'size must be one of {", ".join(OPENAI_IMAGE_SIZES)}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Optional quality override (the brief test-bench). Absent → server default
        # ('low'), so no existing caller changes cost. Whitelisted to avoid passing
        # an arbitrary string to the API.
        quality = (request.data.get('quality') or '').strip().lower()
        if quality and quality not in OPENAI_IMAGE_QUALITIES:
            return Response(
                {'detail': f'quality must be one of {", ".join(OPENAI_IMAGE_QUALITIES)}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Provider: default 'openai' (the unchanged gpt-image path). 'seedream45' /
        # 'grok' route to fal.ai (content.fal_utils) — the "Tạo ảnh nhanh" flow's
        # extra models. Every existing caller omits `provider`, so nothing changes
        # for them. fal ignores quality/no_fallback/explain (not its knobs).
        provider = (request.data.get('provider') or 'openai').strip().lower()
        if provider != 'openai' and not fal_utils.is_fal_model(provider):
            return Response(
                {'detail': f'provider must be one of openai, {", ".join(fal_utils.FAL_MODELS)}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # `resolution` is the fal model's own scale knob; fal_utils validates it
        # against that model's set and falls back to its default, so an unknown
        # value is harmless (no whitelist needed here).
        resolution = (request.data.get('resolution') or '').strip()

        # Cap concurrent image generations so a burst of slow/timing-out calls
        # can't exhaust the server's worker threads and freeze everything. Over
        # the limit → immediate 503 (thread not held); the frontend retries.
        if not _IMAGE_GEN_SEMAPHORE.acquire(blocking=False):
            return Response(
                {'detail': 'Máy chủ đang bận sinh ảnh, thử lại sau giây lát.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            return self._generate_image_blocking(
                prompt, ref_arg, provider, size, quality, resolution, no_fallback, explain,
            )
        finally:
            _IMAGE_GEN_SEMAPHORE.release()

    def _generate_image_blocking(self, prompt, ref_arg, provider, size, quality,
                                 resolution, no_fallback, explain):
        """The OpenAI/fal call + DB logging half of :meth:`generate_image`, split
        out so the concurrency gate wraps exactly the heavy work."""
        if fal_utils.is_fal_model(provider):
            # Log the EXACT prompt sent to fal (Grok/Seedream) — the fal path does no
            # translation, so this is the final prompt verbatim. Mirrors the gpt-image
            # log below so a bad render (e.g. Grok's literal "powder") is traceable.
            logger.info(
                'image prompt (provider=%s reference=%s) final=%r',
                provider, bool(ref_arg), prompt,
            )
            fal_key = ai_tenant.fal_key_for(self.request.user, purpose='sinh-ảnh-fal')
            if not fal_key:
                return Response(
                    {'detail': ai_tenant.missing_key_detail(self.request.user, 'fal.ai')},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            _release_db_connection()  # nhả kết nối DB trong lúc chờ fal (chống PoolTimeout)
            image_b64, err_msg = fal_utils.fal_generate_image(
                prompt, provider, reference_b64=ref_arg, size=size,
                resolution=resolution or None, api_key=fal_key,
            )
            self._log_image_gen(success=bool(image_b64), provider=provider)
            if err_msg:
                return Response({'detail': err_msg}, status=status.HTTP_502_BAD_GATEWAY)
            return Response({'image': self._as_data_uri(image_b64)}, status=status.HTTP_200_OK)

        # Return ONLY the base64 image — do NOT touch storage here (saving handles
        # the parallel upload itself; a pre-upload on this hot path stalled on a
        # slow SeaweedFS endpoint).
        image_b64, err = self._openai_generate_image(
            prompt, reference_b64=ref_arg, no_fallback=no_fallback,
            explain=explain, size=size, quality=quality or None,
        )
        if err is not None:
            return err
        return Response({'image': self._as_data_uri(image_b64)}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='scene-details')
    def scene_details(self, request):
        """Invent the SMALL, VARIABLE details of a scene with GPT, per generation.

        Why this exists: those details used to be hardcoded English in the frontend —
        "Something in the FOREGROUND partly overlaps her: the back of a chair, the edge
        of a table, or a person walking past". Giving an image model three examples does
        NOT make it pick one at random: it latches onto the first concrete noun, so every
        single image came out with a chair in front of the lens.

        The fix is to stop hardcoding what should vary. The user still picks the things
        they care about (place, pose, outfit, camera); GPT invents what should differ
        shot to shot — and it does so knowing WHERE the photo is, so a beach gets a
        beach-appropriate foreground, not a cafe chair.

        In:  {location, region, pose}   Out: {foreground, clutter} (+ *_vi to display).
        """
        location = (request.data.get('location') or '').strip()[:300]
        region = (request.data.get('region') or '').strip()[:300]
        pose = (request.data.get('pose') or '').strip()[:200]
        if not location and not region:
            return Response({'detail': 'Thiếu bối cảnh.'}, status=status.HTTP_400_BAD_REQUEST)

        # Key theo công ty của người gọi (xem content.ai_tenant). 4 endpoint dùng khối
        # này — GPT chi tiết / Quốc gia→prompt / Tạo caption / Cảnh→prompt — đều thuộc
        # luồng nhân vật nên phải tính vào key của công ty đó, không phải key mặc định.
        api_key = ai_tenant.openai_key_for(request.user, purpose='GPT-bịa-chi-tiết-cảnh')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        system_prompt = (
            'You invent the small, incidental details that make a snapshot look REAL, for an AI image '
            'generator. You are given a place. Return TWO things:\n'
            '1) "foreground": ONE object that happens to sit very close to the camera lens and partly '
            'blocks the subject — the kind of thing that accidentally drifts into a hurried phone photo. '
            'It MUST belong naturally to that exact place (a beach does not contain office chairs). '
            'Describe it in 6-14 English words, blurred and out of focus.\n'
            '2) "clutter": the everyday mess and the other people that belong in that exact place, '
            'scattered through the background. 10-25 English words.\n'
            'Be SPECIFIC and concrete, never generic. Do NOT describe the subject herself, her face, her '
            'clothes, the lighting or the camera. Do NOT include any readable text, signs, logos or brands. '
            'Answer with STRICT JSON only: {"foreground": "...", "clutter": "...", '
            '"foreground_vi": "...", "clutter_vi": "..."} where the *_vi fields are natural Vietnamese '
            'translations for the user to read.'
        )
        # A fresh random "angle" each call — temperature alone still converges on the same
        # first idea, which is exactly the bug we are fixing (every photo got a chair).
        import random  # noqa: PLC0415
        nudge = random.choice([
            'Pick something at ground level.', 'Pick something at head height.',
            'Pick a living thing (an animal, or part of another person).',
            'Pick something man-made and mundane.', 'Pick something that is moving.',
            'Pick something dirty, worn or broken.', 'Pick something the locals would have there.',
            'Pick something a careless photographer would not have noticed.',
        ])
        user_msg = f'Place: {location} {region}. The woman is {pose}.\n\n{nudge}'

        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        try:
            _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': user_msg},
                ],
                response_format={'type': 'json_object'},
                temperature=1.0,
                max_tokens=260,
            )
            raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            data = json.loads(raw) if raw else {}
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
            logger.exception('scene_details OpenAI error: %s', exc)
            reason = self._openai_error_reason(exc)
            return Response(
                {'detail': f'Tạo chi tiết cảnh thất bại: {reason}' if reason else 'Tạo chi tiết cảnh thất bại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        out = {k: str(data.get(k) or '').strip() for k in ('foreground', 'clutter', 'foreground_vi', 'clutter_vi')}
        if not out['foreground'] and not out['clutter']:
            return Response({'detail': 'GPT trả về rỗng.'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(out, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='pick-face')
    def pick_face(self, request):
        """Let GPT pick ONE code per slot from a menu the caller supplies.

        Body: ``{"menu": {"<slot>": ["<code>", …], …}, "level": "<mô tả mức nhan sắc>"}``
        Out:  ``{"codes": {"<slot>": "<code>", …}}``

        Why the caller sends the menu instead of the server owning it: the menu IS the
        prompt vocabulary and it lives in ``ui/src/lib/quickPrompt.ts`` next to the
        sentences it maps to. Keeping a second copy here would let the two drift, and a
        drifted code silently degrades an image nobody is watching. So this endpoint is
        deliberately dumb — it knows nothing about faces, it just picks from lists.

        GPT never writes prose here, only codes, and every code is checked against the
        list it came from (anything else is replaced by a random valid one). That is the
        whole point: the caller composes the sentence from its own text, so a model that
        drifts cannot leak a flattering word into the image prompt. The free-prose
        version of this DID drift — see docs/test-nhan-sac/.

        NB the frontend's DEFAULT is to pick at random locally, without calling this at
        all: measured over 30 images, GPT touched 18/45 menu options and chose the same
        code 20/20 times in three slots, while random covered 35/45 in ten. This exists
        for the "Mặt bằng GPT" button — a coherent combination on demand — not as the
        normal path.
        """
        menu = request.data.get('menu')
        if not isinstance(menu, dict) or not menu:
            return Response({'detail': 'Thiếu thực đơn.'}, status=status.HTTP_400_BAD_REQUEST)
        # Bound the payload: this goes into a prompt, so an unbounded menu is an
        # unbounded bill. The real menu is 8 slots x <=7 codes.
        if len(menu) > 16:
            return Response({'detail': 'Thực đơn quá nhiều ô.'}, status=status.HTTP_400_BAD_REQUEST)
        clean = {}
        for slot, codes in menu.items():
            if not isinstance(slot, str) or not isinstance(codes, list) or not codes:
                return Response({'detail': f'Ô {slot!r} không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)
            ok = [str(c)[:40] for c in codes[:32] if isinstance(c, (str, int))]
            if not ok:
                return Response({'detail': f'Ô {slot!r} rỗng.'}, status=status.HTTP_400_BAD_REQUEST)
            clean[str(slot)[:40]] = ok
        level = str(request.data.get('level') or 'an ordinary person')[:200]

        api_key = ai_tenant.openai_key_for(request.user, purpose='GPT-chọn-gương-mặt')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        system_prompt = (
            'You build one ordinary Vietnamese woman\'s face by CHOOSING one code from each list. '
            'Pick a combination that hangs together as one believable real person — a heavy build '
            'goes with full cheeks and a short neck, not with hollow ones. '
            f'She should read as: {level}. '
            'Vary your choices; do not always take the first code in a list. '
            'Answer with STRICT JSON only, exactly these keys, each value one code from its own list:\n'
            + json.dumps(clean, ensure_ascii=False)
        )
        try:
            _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL)
                or DEFAULT_CONTENT_AI_MODEL,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': 'Pick one combination now.'},
                ],
                response_format={'type': 'json_object'},
                temperature=1.0,
                max_tokens=260,
            )
            raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            data = json.loads(raw) if raw else {}
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
            logger.exception('pick_face OpenAI error: %s', exc)
            reason = self._openai_error_reason(exc)
            return Response(
                {'detail': f'GPT chọn gương mặt thất bại: {reason}' if reason else 'GPT chọn gương mặt thất bại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Mã lạ hoặc thiếu ô -> thay bằng một mã hợp lệ bốc ngẫu nhiên, để nút này không
        # bao giờ trả về tổ hợp khuyết (frontend sẽ dựng câu thiếu ô và rơi về câu cố định).
        import random  # noqa: PLC0415
        codes = {
            slot: (data[slot] if isinstance(data.get(slot), str) and data[slot] in ok else random.choice(ok))
            for slot, ok in clean.items()
        }
        return Response({'codes': codes}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='apply-filter')
    def apply_filter(self, request):
        """Apply an Instagram-style colour filter (``pilgram``) to an image.

        Body: ``{"image": <data-uri|b64|http(s) url>, "filter": "clarendon"}``.
        Returns ``{"image": "data:image/jpeg;base64,…"}``. Used by the "Tạo nhân
        vật" wizard (colour-grade a generated photo before saving) and the
        character detail gallery (re-filter an already-saved media image — passed
        as its presigned URL, fetched server-side here to avoid browser CORS).
        Purely local pixel work — no OpenAI call, so it adds no generation cost.
        """
        from .image_utils import FILTERS, apply_filter as _apply_filter  # noqa: PLC0415
        import base64 as _b64  # noqa: PLC0415

        image = str(request.data.get('image') or '')
        name = (request.data.get('filter') or '').strip()
        if not image:
            return Response({'detail': 'image là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        if name not in FILTERS:
            return Response({'detail': f'Filter không hợp lệ: {name!r}.'}, status=status.HTTP_400_BAD_REQUEST)
        # max_edge: trả về bản xem trước NHỎ thay vì ảnh full — dải filter trong
        # FilterPicker cần 13 ảnh mẫu một lúc, mà ảnh full là ~576 KB tải về mỗi
        # cái, nên trước đây phải bấm từng filter mới biết nó ra sao (đo được:
        # max_edge=260 → 37 KB). 0/thiếu = trả full như cũ.
        try:
            max_edge = int(request.data.get('max_edge') or 0)
        except (TypeError, ValueError):
            max_edge = 0
        max_edge = max(0, min(max_edge, MEDIA_MAX_EDGE))
        try:
            if image.startswith('http://') or image.startswith('https://'):
                import requests  # noqa: PLC0415
                resp = requests.get(image, timeout=30)
                resp.raise_for_status()
                raw = resp.content
            else:
                raw = self._safe_b64decode(image)
            out = _apply_filter(raw, name, max_edge=max_edge or None)
        except ImportError:
            return Response(
                {'detail': 'Thư viện filter (pilgram) chưa được cài đặt.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception('apply_filter failed: %s', exc)
            return Response({'detail': f'Áp dụng filter thất bại: {exc}'}, status=status.HTTP_400_BAD_REQUEST)
        out_b64 = _b64.b64encode(out).decode()
        return Response({'image': f'data:image/jpeg;base64,{out_b64}'}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='store-image')
    def store_image(self, request):
        """Cất MỘT ảnh đã sinh vào kho ảnh và trả về ``{"url": ...}``.

        Vì sao cần endpoint này: ``generate-image`` chỉ trả base64 — phần
        pre-upload đã bị bỏ khỏi luồng sinh ảnh (commit b4c71ea) vì kho ảnh chậm
        làm treo luồng nóng. Hệ quả là tới lúc bấm Lưu, frontend phải gửi lại
        TOÀN BỘ base64: một ảnh 1024x1536 là PNG 1,69 MB → 2,25 MB base64 đi
        LÊN, mà lên là chiều chậm nhất của đường truyền. Đo thực tế: 3 ảnh =
        6,6 MB một request, mất 6–27 giây tuỳ băng thông, trong khi phần việc
        thật của server (giải mã 3 ms + nén 34 ms + PUT ~20 ms mỗi ảnh) chỉ
        khoảng nửa giây. Toàn bộ thời gian chờ là byte bò lên mạng — và bò lên
        lần thứ hai, vì server chính là nơi vừa tạo ra đúng những byte đó.

        Frontend gọi endpoint này NGAY khi ảnh vừa hiện ra, lúc người dùng còn
        đang ngắm ảnh, rồi khi lưu chỉ gửi URL: ``create`` và ``add-media`` cho
        URL http(s) đi thẳng qua, không giải mã lại (xem
        ``upload_character_image_to_seaweedfs``). Request lưu tụt từ ~6,6 MB
        xuống vài trăm byte.

        Tách riêng khỏi ``generate-image`` là có chủ ý: luồng sinh ảnh không
        được phụ thuộc vào kho ảnh nữa — đó đúng là lý do phần pre-upload cũ bị
        bỏ. Ở đây kho chậm hay chết thì chỉ endpoint này lỗi, frontend bỏ qua và
        quay về đường gửi base64 như trước.

        Tham số upload trùng khít ``CharacterViewSet._upload_media_items`` để
        ảnh cất trước hay lưu sau đều ra đúng một file giống nhau.
        """
        from .seaweedfs_utils import upload_character_image_to_seaweedfs  # noqa: PLC0415

        image = str(request.data.get('image') or '')
        kind = (request.data.get('kind') or 'scenes').strip()
        if not image:
            return Response({'detail': 'image là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        if kind not in ('media', 'scenes', 'source'):
            return Response(
                {'detail': f'kind không hợp lệ: {kind!r} (media|scenes|source).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            url = upload_character_image_to_seaweedfs(
                image, subfolder=kind, sanitize=True, sanitize_quality=95,
                sanitize_max_edge=MEDIA_MAX_EDGE,
            )
        except Exception as exc:  # noqa: BLE001
            # warning, không exception: frontend coi đây là chuyện có thể xảy ra và
            # tự quay về đường base64, nên đây không phải sự cố cần traceback.
            logger.warning('store_image failed (kind=%s): %s', kind, exc)
            return Response(
                {'detail': f'Không cất được ảnh vào kho: {exc}'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({'url': url}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='remove-text')
    def remove_text(self, request):
        """Erase a masked region (text/watermark) from an image via the
        self-hosted LaMa inpainting service (``settings.INPAINT_API_URL``).

        Unlike OpenAI image editing, this has no content moderation, so it works
        on images OpenAI refuses (medical/sensitive). Body:
        ``{"image": <data-uri|b64>, "mask": <data-uri|b64; white = erase>}``.
        Returns ``{"image": "data:image/png;base64,…"}``.
        """
        image = request.data.get('image') or ''
        mask = request.data.get('mask') or ''
        if not image or not mask:
            return Response({'detail': 'image và mask là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        url = (getattr(settings, 'INPAINT_API_URL', '') or '').rstrip('/')
        if not url:
            return Response(
                {'detail': 'Inpaint service chưa được cấu hình.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        timeout = getattr(settings, 'INPAINT_TIMEOUT_SECONDS', 120)
        try:
            import requests  # noqa: PLC0415
            resp = requests.post(
                f'{url}/inpaint',
                json={'image': self._strip_data_uri(image), 'mask': self._strip_data_uri(mask)},
                timeout=timeout,
            )
            resp.raise_for_status()
            out_b64 = (resp.json() or {}).get('image')
        except Exception as exc:  # noqa: BLE001
            logger.exception('remove_text: inpaint service error: %s', exc)
            return Response({'detail': f'Xóa chữ thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        if not out_b64:
            return Response({'detail': 'Inpaint service không trả về ảnh.'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'image': self._as_data_uri(out_b64)}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='upscale')
    def upscale(self, request):
        """Enlarge an existing image via the self-hosted Real-ESRGAN service
        (``settings.UPSCALE_API_URL``; service upscale riêng).

        gpt-image-2 caps at 1024x1536 and scenes are stored as JPEG, so a saved
        image is ~1 MP and looks soft as soon as it is zoomed or downloaded. This
        enlarges what is already there — no re-generation, so no OpenAI cost and
        the picture's content cannot change.

        Body: ``{"image": <data-uri|b64|http(s) url>, "scale": 2}``. Returns
        ``{"image": "data:image/jpeg;base64,…", "width": …, "height": …}``.

        NB the service deliberately runs a pure super-resolution model with no
        face prior — see that repo's README. Do not swap it for a "face
        restoration" model (GFPGAN/CodeFormer): those regenerate the face from a
        learned prior and shift identity, which would break characters that must
        stay recognisable across posts.
        """
        image = request.data.get('image') or ''
        if not image:
            return Response({'detail': 'image là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            scale = int(request.data.get('scale') or 2)
        except (TypeError, ValueError):
            return Response({'detail': 'scale phải là số.'}, status=status.HTTP_400_BAD_REQUEST)
        if not 1 <= scale <= 4:
            return Response({'detail': 'scale phải từ 1 đến 4.'}, status=status.HTTP_400_BAD_REQUEST)

        url = (getattr(settings, 'UPSCALE_API_URL', '') or '').rstrip('/')
        if not url:
            return Response(
                {'detail': 'Upscale service chưa được cấu hình.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        # Accept a character-media URL too (fetched server-side to dodge browser
        # CORS), mirroring apply_filter — the gallery only has presigned URLs.
        try:
            raw = self._resolve_image_bytes(image)
        except Exception as exc:  # noqa: BLE001
            return Response({'detail': f'Không đọc được ảnh: {str(exc)[:200]}'},
                            status=status.HTTP_400_BAD_REQUEST)

        timeout = getattr(settings, 'UPSCALE_TIMEOUT_SECONDS', 180)
        _release_db_connection()  # nhả kết nối DB trong lúc chờ GPU (chống PoolTimeout)
        try:
            import requests as _requests  # noqa: PLC0415
            resp = _requests.post(
                f'{url}/upscale',
                json={'image': base64.b64encode(raw).decode(), 'scale': scale},
                timeout=timeout,
            )
            resp.raise_for_status()
            data = resp.json() or {}
        except Exception as exc:  # noqa: BLE001
            logger.exception('upscale: service error: %s', exc)
            return Response({'detail': f'Làm nét ảnh thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        out_b64 = data.get('image')
        if not out_b64:
            return Response({'detail': 'Upscale service không trả về ảnh.'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(
            {
                'image': f'data:image/jpeg;base64,{out_b64}',
                'width': data.get('width'),
                'height': data.get('height'),
            },
            status=status.HTTP_200_OK,
        )

    def _resolve_image_bytes(self, value):
        """Bytes for an image given as a data-URI/base64 OR an http(s) URL (a
        character-media pick, fetched server-side to dodge browser CORS)."""
        value = str(value or '')
        if value.startswith('http://') or value.startswith('https://'):
            resp = requests.get(value, timeout=30)
            resp.raise_for_status()
            return resp.content
        return self._safe_b64decode(value)

    FACE_SWAP_ENGINES = ('facefusion', 'deeplivecam')

    def _call_face_swap_engine(self, url, engine, source_bytes, source_ext, source_mime,
                                target_bytes, target_ext, target_mime, timeout):
        """One /face-swap call against the given engine. Returns
        ``(engine, data_uri, None)`` on success or ``(engine, None, detail)`` on
        failure — never raises, so callers can fan this out and keep partial results.

        We fan both engines out at once, but the gateway serialises them on its
        side: the box has one 8 GB card and deeplivecam holds ~3.7 GB resident, so
        two engines inferring together left facefusion unable to allocate even 1 MB
        (8/8 of its crashes in the log look like that). The second engine therefore
        waits a few seconds inside the gateway rather than failing.
        """
        key = getattr(settings, 'FACEFUSION_API_KEY', '') or ''
        try:
            resp = requests.post(
                f'{url}/face-swap',
                files={
                    'source': (f'source.{source_ext}', source_bytes, source_mime),
                    'target': (f'target.{target_ext}', target_bytes, target_mime),
                },
                data={'engine': engine},
                headers={'X-API-Key': key} if key else None,
                timeout=timeout,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception('face_swap: %s engine error: %s', engine, exc)
            return engine, None, f'không gọi được ({str(exc)[:200]})'
        if resp.status_code != 200:
            try:
                detail = (resp.json() or {}).get('detail', '')
            except Exception:  # noqa: BLE001
                detail = resp.text[:200]
            return engine, None, detail or str(resp.status_code)
        ctype = resp.headers.get('Content-Type', 'image/png') or 'image/png'
        out_b64 = base64.b64encode(resp.content).decode()
        return engine, f'data:{ctype};base64,{out_b64}', None

    @action(detail=False, methods=['post'], url_path='face-swap')
    def face_swap(self, request):
        """Swap the face from ``source`` onto ``target`` via the self-hosted
        face-swap gateway (``settings.FACEFUSION_API_URL``; repo ~/facefusion
        gateway/gateway.py). Calls every engine the gateway exposes
        (``FACE_SWAP_ENGINES``) in parallel so the frontend can show the user both
        results to pick from.

        Body: ``{"source": <data-uri|b64|url>, "target": <data-uri|b64|url>}`` —
        ``source`` supplies the face/identity, ``target`` is the image whose face is
        replaced. Each may be an uploaded data-URI or a character-media URL (fetched
        server-side). Returns ``{"results": {"<engine>": "data:image/…;base64,…"},
        "errors": {"<engine>": "<detail>"}}`` — an engine only lands in ``errors`` if
        it failed; 502 only if every engine failed. Proxy only, no OpenAI cost —
        mirrors ``remove_text`` (self-hosted inpaint).
        """
        source = str(request.data.get('source') or '')
        target = str(request.data.get('target') or '')
        if not source or not target:
            return Response({'detail': 'source và target là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        url = (getattr(settings, 'FACEFUSION_API_URL', '') or '').rstrip('/')
        if not url:
            return Response(
                {'detail': 'FaceFusion service chưa được cấu hình.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            source_bytes = self._resolve_image_bytes(source)
            target_bytes = self._resolve_image_bytes(target)
        except Exception as exc:  # noqa: BLE001
            return Response({'detail': f'Ảnh nguồn/đích không hợp lệ: {str(exc)[:200]}'},
                            status=status.HTTP_400_BAD_REQUEST)
        s_mime, s_ext = _sniff_image_mime_ext(source_bytes)
        t_mime, t_ext = _sniff_image_mime_ext(target_bytes)
        timeout = getattr(settings, 'FACEFUSION_TIMEOUT_SECONDS', 180)
        _release_db_connection()  # nhả kết nối DB trong lúc chờ FaceFusion (chống PoolTimeout)

        results, errors = {}, {}
        with ThreadPoolExecutor(max_workers=len(self.FACE_SWAP_ENGINES)) as executor:
            calls = [
                executor.submit(
                    self._call_face_swap_engine, url, engine,
                    source_bytes, s_ext, s_mime, target_bytes, t_ext, t_mime, timeout,
                )
                for engine in self.FACE_SWAP_ENGINES
            ]
            for future in calls:
                engine, image, error = future.result()
                if image:
                    results[engine] = image
                else:
                    errors[engine] = error

        if not results:
            return Response({'detail': f'Ghép mặt thất bại: {errors}'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'results': results, 'errors': errors}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='detect-text')
    def detect_text(self, request):
        """OCR an image via the inpaint service → ``{width, height, boxes:[{x,y,w,h,text,conf}]}``
        so the UI can pre-fill a removal mask the user then refines by hand."""
        image = request.data.get('image') or ''
        if not image:
            return Response({'detail': 'image là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        url = (getattr(settings, 'INPAINT_API_URL', '') or '').rstrip('/')
        if not url:
            return Response(
                {'detail': 'Inpaint service chưa được cấu hình.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        timeout = getattr(settings, 'INPAINT_TIMEOUT_SECONDS', 120)
        try:
            import requests  # noqa: PLC0415
            resp = requests.post(
                f'{url}/detect-text',
                json={'image': self._strip_data_uri(image)},
                timeout=timeout,
            )
            resp.raise_for_status()
            return Response(resp.json(), status=status.HTTP_200_OK)
        except Exception as exc:  # noqa: BLE001
            logger.exception('detect_text: inpaint service error: %s', exc)
            return Response({'detail': f'Dò chữ thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)

    @action(detail=False, methods=['post'], url_path='remove-background')
    def remove_background(self, request):
        """Remove an image's background via the self-hosted worker
        (``settings.INPAINT_API_URL`` + ``/remove-background``, rembg/U²-Net).

        Runs on the separate inpaint worker (NOT this Django process) so the
        heavy ~1-3s CPU job never blocks a gunicorn worker. Body:
        ``{"image": <data-uri|b64>}``. Returns a transparent PNG as
        ``{"image": "data:image/png;base64,…"}``.
        """
        image = request.data.get('image') or ''
        if not image:
            return Response({'detail': 'image là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        url = (getattr(settings, 'INPAINT_API_URL', '') or '').rstrip('/')
        if not url:
            return Response(
                {'detail': 'Dịch vụ xử lý ảnh chưa được cấu hình.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        timeout = getattr(settings, 'INPAINT_TIMEOUT_SECONDS', 120)
        try:
            import requests  # noqa: PLC0415
            resp = requests.post(
                f'{url}/remove-background',
                json={'image': self._strip_data_uri(image)},
                timeout=timeout,
            )
            resp.raise_for_status()
            out_b64 = (resp.json() or {}).get('image')
        except Exception as exc:  # noqa: BLE001
            logger.exception('remove_background: service error: %s', exc)
            return Response({'detail': f'Xoá nền thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        if not out_b64:
            return Response({'detail': 'Dịch vụ không trả về ảnh.'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'image': self._as_data_uri(out_b64)}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='topic-to-prompt')
    def topic_to_prompt(self, request):
        """Build a reusable CHARACTER IDENTITY prompt for a woman of a given
        nationality — used by the character wizard so the user just types a
        COUNTRY (e.g. "Việt Nam", "Hàn Quốc") and gets a face prompt with that
        nationality's realistic features (no longer hardcoded Filipino).
        """
        nation = (request.data.get('nation') or request.data.get('topic') or '').strip()
        if not nation:
            return Response({'detail': 'Hãy nhập quốc gia.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(nation) > 500:
            return Response({'detail': 'Tên quốc gia quá dài.'}, status=status.HTTP_400_BAD_REQUEST)

        # Key theo công ty của người gọi (xem content.ai_tenant). 4 endpoint dùng khối
        # này — GPT chi tiết / Quốc gia→prompt / Tạo caption / Cảnh→prompt — đều thuộc
        # luồng nhân vật nên phải tính vào key của công ty đó, không phải key mặc định.
        api_key = ai_tenant.openai_key_for(request.user, purpose='quốc-gia→prompt-gương-mặt')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        system_prompt = (
            'You write a REUSABLE CHARACTER IDENTITY prompt for an AI image generator. This prompt '
            'is prepended to every later scene, so it must describe ONLY the persistent subject — '
            'never a specific outfit, location, or camera setting. '
            'The user gives a COUNTRY. The subject is a woman of THAT nationality — describe '
            'realistic skin tone, facial features and hair that are natural and typical for women '
            'of that country / region. Do NOT default to any other nationality. If the input is '
            'not a clear country, choose a natural everyday look that fits it. '
            'Output ONE CONCISE prompt of about 40-55 words as plain descriptive phrases '
            '(no repetition, no filler, no markdown, no headings, no quotes, no storytelling). Describe ONLY the face and '
            'head: use the exact age given in the per-character constraints below (do NOT default everyone to early-20s), a realistic skin tone with natural undertones for that country, '
            'realistic nationality-appropriate facial features, face shape, eye shape and colour, '
            'natural eyebrows, and hairstyle / colour / texture. Her face must stay '
            'clearly visible, in sharp focus and a consistent recognizable likeness, not cropped or '
            'hidden by hair/hands/sunglasses — do NOT lock a fixed head angle or gaze (pose and head '
            'angle, gaze and expression are set per scene; default to a relaxed, natural everyday expression (calm or a '
            'soft genuine smile) for the base face, but do NOT ban any expression — the per-scene prompt sets the actual '
            'emotion (smiling, laughing, a cute aegyo pout, sulking, teary, posing, etc.). '
            'Add a SHORT natural-skin note (fresh natural skin, soft real texture, not over-smoothed or plastic). '
            'Keep it strictly neutral and non-sexual so it passes content moderation: do NOT '
            'describe body, figure, proportions or curves, and avoid words like "beautiful", '
            '"attractive", "sexy" or "hot" — describe her as an ordinary everyday person. '
            'Do NOT describe a specific outfit, do NOT describe a background or location, and do '
            'NOT add camera, lens or post-processing terms — those are added separately per scene. '
            'Tasteful, non-explicit. '
            'WRITE THE DESCRIPTION IN VIETNAMESE (tiếng Việt) — simple, plain, readable phrases a '
            'normal Vietnamese user can understand and edit. Output only the Vietnamese prompt text.'
        )
        # Per-character randomised traits so the SAME country yields a DIFFERENT
        # person each call — temperature alone repeats near-identical early-20s
        # look-alikes. The model reconciles each trait with what's realistic for
        # the country. This is the "random" the wizard needs for face variety.
        import random  # noqa: PLC0415
        _traits = {
            'age': random.choice([
                'in her late teens (around 18-19)', 'in her early 20s (around 20-23)',
                'in her mid-to-late 20s (around 24-29)', 'in her early 30s (around 30-34)',
                'in her mid-to-late 30s (around 35-39)',
            ]),
            'face': random.choice([
                'an oval', 'a round', 'a heart-shaped', 'a soft square', 'a long oval', 'a diamond-shaped',
            ]),
            'eyes': random.choice([
                'almond-shaped', 'round', 'monolid', 'double-eyelid', 'slightly hooded', 'gently upturned',
            ]),
            'nose': random.choice([
                'a small button nose', 'a straight nose', 'a softly rounded nose', 'a slender refined nose',
            ]),
            'hair': random.choice([
                'long straight dark hair', 'shoulder-length wavy dark-brown hair', 'a short chin-length bob',
                'long layered hair tied back', 'a casual ponytail',
                'medium wavy hair with soft light-brown highlights',
            ]),
            'skin': random.choice([
                'fair skin with cool undertones', 'light skin with warm undertones', 'light-medium neutral skin',
                'medium warm tan skin', 'medium skin with olive undertones',
            ]),
            'build': random.choice(['a slender', 'an average', 'a slightly fuller', 'a petite']),
        }
        variation_directive = (
            'For THIS specific character, use these randomised traits (keep them realistic and natural for '
            f"someone from {nation}; gently reconcile any trait that would be unusual there): she is "
            f"{_traits['age']}, with {_traits['face']} face, {_traits['eyes']} eyes, {_traits['nose']}, "
            f"{_traits['hair']}, {_traits['skin']}, and {_traits['build']} build. Weave these into the "
            'description naturally — do NOT list them as labels and do NOT mention the word "randomised".'
        )

        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        try:
            _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    # One-shot example: a country in → that nationality's identity out.
                    {'role': 'user', 'content': f'Country: {TOPIC_TO_PROMPT_EXAMPLE_TOPIC}'},
                    {'role': 'assistant', 'content': TOPIC_TO_PROMPT_EXAMPLE},
                    {'role': 'user', 'content': f'Country: {nation}\n\n{variation_directive}'},
                ],
                temperature=0.95,
                max_tokens=260,
            )
            prompt_text = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            if not prompt_text:
                raise ValueError('OpenAI returned empty prompt')
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
            logger.exception('topic_to_prompt OpenAI error: %s', exc)
            reason = self._openai_error_reason(exc)
            return Response(
                {'detail': f'Tạo prompt thất bại: {reason}' if reason else 'Tạo prompt thất bại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        # Pre-translate the identity description too — off the image hot path — so a
        # person scene (which embeds this face prompt) can be assembled fully in
        # English and skip the per-image translate call. prompt = Vietnamese (user
        # reads/edits); prompt_en = English for generation.
        prompt_en = self._translate_prompt_for_image(prompt_text)
        return Response({'prompt': prompt_text, 'prompt_en': prompt_en}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='caption-from-image')
    def caption_from_image(self, request):
        """Look at an image and write a Vietnamese social caption + hashtags.

        Body: ``{image_url (public / presigned / data-URI), platform?}``.
        Returns ``{caption, hashtags}``. Used by the character "Đăng bài" modal."""
        import json as _json

        image_url = (request.data.get('image_url') or '').strip()
        if not image_url:
            return Response({'detail': 'Thiếu ảnh để tạo caption.'}, status=status.HTTP_400_BAD_REQUEST)
        platform = (request.data.get('platform') or 'facebook').strip().lower()
        plat_label = {
            'tiktok': 'TikTok',
            'facebook_profile': 'Facebook',
            'facebook_page': 'Facebook Page',
            'facebook_group': 'nhóm Facebook',
        }.get(platform, 'mạng xã hội')

        # Key theo công ty của người gọi (xem content.ai_tenant). 4 endpoint dùng khối
        # này — GPT chi tiết / Quốc gia→prompt / Tạo caption / Cảnh→prompt — đều thuộc
        # luồng nhân vật nên phải tính vào key của công ty đó, không phải key mặc định.
        api_key = ai_tenant.openai_key_for(request.user, purpose='tạo-caption-từ-ảnh')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        system_prompt = (
            'Bạn là copywriter mạng xã hội người Việt. Nhìn ẢNH rồi viết MỘT caption tiếng Việt '
            f'ngắn gọn, tự nhiên, cuốn hút phù hợp để đăng {plat_label}, kèm 3-6 hashtag liên quan. '
            'Giữ thân thiện, tích cực, KHÔNG nhạy cảm/gợi dục. Trả về DUY NHẤT một JSON object: '
            '{"caption": "...", "hashtags": ["...", "..."]} — hashtag viết thường, không dấu cách, '
            'không kèm dấu #. Không thêm chữ nào ngoài JSON.'
        )
        try:
            _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': [
                        {'type': 'text', 'text': 'Viết caption + hashtag cho ảnh này.'},
                        {'type': 'image_url', 'image_url': {'url': image_url}},
                    ]},
                ],
                temperature=0.8,
                response_format={'type': 'json_object'},
                max_tokens=400,
            )
            raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            data = _json.loads(raw)
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
            logger.exception('caption_from_image OpenAI error: %s', exc)
            reason = self._openai_error_reason(exc)
            return Response(
                {'detail': f'Tạo caption thất bại: {reason}' if reason else 'Tạo caption thất bại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        caption = (data.get('caption') or '').strip() if isinstance(data, dict) else ''
        raw_tags = data.get('hashtags') if isinstance(data, dict) else []
        hashtags = [
            str(t).strip().lstrip('#').replace(' ', '')
            for t in (raw_tags or []) if str(t).strip()
        ]
        return Response({'caption': caption, 'hashtags': hashtags}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='scene-to-prompt')
    def scene_to_prompt(self, request):
        """Generate a fresh, varied SCENE description for an everyday theme.

        Used by the character wizard's "Tạo lại" button once a row's curated
        local variants are exhausted, so users get unlimited scene variety.
        Returns a setting/outfit/pose/angle description ONLY — the person
        identity and the camera-style lock are added client-side, so this prompt
        must not describe the person's face/body or camera hardware.
        """
        theme = (request.data.get('theme') or request.data.get('topic') or '').strip()
        if not theme:
            return Response({'detail': 'Hãy nhập chủ đề cảnh.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(theme) > 500:
            return Response({'detail': 'Chủ đề quá dài.'}, status=status.HTTP_400_BAD_REQUEST)
        nation = (request.data.get('nation') or '').strip()[:100]
        # The character identity prompt already encodes the woman's nationality
        # ("Vietnamese woman...", "Filipino woman..."). When the caller can't send
        # an explicit country (e.g. adding scenes to a saved character), we pass
        # this so the scene atmosphere can still be localised — used for LOCALE
        # inference only, never echoed into the scene description.
        identity = (request.data.get('face_prompt') or request.data.get('identity') or '').strip()[:1200]

        # Key theo công ty của người gọi (xem content.ai_tenant). 4 endpoint dùng khối
        # này — GPT chi tiết / Quốc gia→prompt / Tạo caption / Cảnh→prompt — đều thuộc
        # luồng nhân vật nên phải tính vào key của công ty đó, không phải key mặc định.
        api_key = ai_tenant.openai_key_for(request.user, purpose='cảnh→prompt')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Localise the everyday atmosphere to the character's country (places,
        # signage, streets, fashion). Priority: explicit nation → infer from the
        # identity prompt → generic (no hardcoded nationality). Phrased as a hard
        # requirement — a soft "favour ..." clause buried mid-prompt gets dropped
        # at temperature 0.95 (verified: ~1 in 3 scenes came out with no country
        # cues at all).
        if nation:
            atmosphere = (
                f'The photo is taken in {nation}. You MUST ground the scene there: the setting, '
                f'streets, signage, architecture, fashion and small background details must all '
                f'read as authentically, recognisably {nation} (everyday and ordinary, not a '
                'tourist-postcard cliché). Include at least ONE concrete, unmistakably local detail '
                '(signage language, typical architecture, local food or drink, street furniture). '
            )
        elif identity:
            atmosphere = (
                "Infer the woman's nationality / home country from her identity description above. "
                'The photo is taken in THAT country, and you MUST ground the scene there: the '
                'setting, streets, signage, architecture, fashion and small background details must '
                'all read as authentically of that country (everyday and ordinary, not a '
                'tourist-postcard cliché). Include at least ONE concrete, unmistakably local detail '
                '(signage language, typical architecture, local food or drink, street furniture). '
            )
        else:
            # No country signal at all: keep the location generic — do NOT invent
            # or default to any specific country or landmark. The "write in
            # Vietnamese" instruction below otherwise nudges the model into picking
            # a Vietnamese place (e.g. "Công viên Thống Nhất") even for a foreign
            # character, so forbid that default explicitly.
            atmosphere = (
                'Keep the location generic and unspecified — do NOT name or invent any specific '
                'country, city or landmark, and in particular do NOT default to Vietnam or a '
                'Vietnamese place. Use a plain everyday setting that could be anywhere. '
            )
        system_prompt = (
            'You write ONE short scene description for a candid, everyday smartphone photo of a '
            'young woman, given a SETTING theme. Output about 25-40 words as plain descriptive '
            'phrases (no markdown, no headings, no quotes, no storytelling). '
            'Keep the scene SIMPLE and ordinary, like a real everyday snapshot: one clear main '
            'subject, a plain uncluttered setting, and only a FEW details. Do NOT pile on props, '
            'decorations, elaborate outfits or busy backgrounds — an over-detailed scene looks '
            'fake and AI-generated; a plain simple one looks real. '
            'Describe ONLY: a simple casual everyday outfit, a relaxed natural pose or action, a '
            'natural facial expression / mood that fits the scene (VARY it across calls so she '
            'looks like a real person — e.g. a soft smile, a candid mid-laugh, a calm relaxed '
            'look, a thoughtful look, a cute playful pout, shy, or confident — pick ONE, natural '
            'and believable, not a stiff catalog face), a plain background for the theme, and the '
            'camera framing. Vary the shot distance across calls and lean toward WIDER framing '
            '(full-body / full-length / three-quarter / half-body), not just tight upper-body '
            'crops — keep the whole body and setting in frame with the face clearly visible. '
            'Make it a FRESH variation each call. ' + atmosphere +
            "Do NOT describe the person's facial features, identity, body, figure or proportions (a natural facial expression / mood is fine), and do NOT "
            'add camera hardware, resolution or post-processing terms — those are added separately. '
            'Keep it strictly neutral and non-sexual so it passes content moderation; avoid words '
            'like "beautiful", "attractive", "sexy" or "feminine". '
            'WRITE THE SCENE DESCRIPTION IN VIETNAMESE (tiếng Việt) — simple, plain, easy-to-read '
            'phrases a normal Vietnamese user can understand and edit. Output only the Vietnamese scene text.'
        )
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        try:
            _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            messages = [{'role': 'system', 'content': system_prompt}]
            # Give the identity ONLY for locale inference when no explicit country
            # was sent — the system prompt still forbids describing her in output.
            if identity and not nation:
                messages.append({
                    'role': 'user',
                    'content': (
                        'The woman in the photo (use ONLY to infer her nationality / country for the '
                        f'setting — do NOT describe her appearance in your output): {identity}'
                    ),
                })
            # Repeat the country next to the theme — the user message is where the
            # model attends most, so the locale survives high-temperature sampling.
            theme_msg = f'Setting theme: {theme} (the scene is in {nation})' if nation else f'Setting theme: {theme}'
            messages.append({'role': 'user', 'content': theme_msg})
            completion = client.chat.completions.create(
                model=llm_model,
                messages=messages,
                # 0.7: đủ đa dạng cảnh giữa các lần gọi nhưng bám chắc yêu cầu quốc
                # gia. 0.95 trước đây quá cao → model rớt tín hiệu "phải ở {nation}"
                # ~1/3 lần, sinh địa danh sai nước (vd "Công viên Tôn Đức Thắng" cho
                # nhân vật Thái). Mỗi cảnh vẫn khác nhau nhờ theme/pose/khung hình.
                temperature=0.7,
                max_tokens=200,
            )
            prompt_text = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            if not prompt_text:
                raise ValueError('OpenAI returned empty prompt')
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
            logger.exception('scene_to_prompt OpenAI error: %s', exc)
            reason = self._openai_error_reason(exc)
            return Response(
                {'detail': f'Tạo cảnh thất bại: {reason}' if reason else 'Tạo cảnh thất bại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        # Pre-translate to English HERE — off the image hot path — so image
        # generation can send English straight to gpt-image and SKIP its own
        # per-image translate call (that extra LLM round-trip is a big slice of the
        # "sinh ảnh lâu"). The Vietnamese ``prompt`` is what the user reads/edits;
        # ``prompt_en`` is used only for generation. If translation is disabled or
        # the model returns the text unchanged, prompt_en == prompt and generation
        # falls back to translating as before (no regression).
        prompt_en = self._translate_prompt_for_image(prompt_text)
        # Log the country signal + resulting scene so a wrong-country leak (e.g. a
        # Vietnamese landmark for a Thai character) is auditable per generation —
        # this is the "lúc được lúc không" the user is chasing.
        logger.info(
            'scene_to_prompt: nation=%r has_identity=%s theme=%r -> %s',
            nation or '(none)', bool(identity), theme, prompt_text,
        )
        return Response({'prompt': prompt_text, 'prompt_en': prompt_en}, status=status.HTTP_200_OK)

    # ---------------- Photoshoot-brief blocks (structured prompt) ----------------
    # ``topic_to_prompt`` / ``scene_to_prompt`` above return ONE opaque paragraph.
    # These two return the SAME information split into named blocks, so the wizard
    # can show one editable box per block (hair, nails, posture, lighting…) and the
    # user picks or rewrites each one. Assembling the blocks back into a prompt is
    # the frontend's job (buildBriefPrompt) — the shape is the contract.

    def _chat_json(self, system_prompt, user_messages, required_keys, max_tokens=900, temperature=0.8):
        """Call the chat model in JSON mode and return a validated dict.

        Raises ``ValueError`` when the model omits a required key, so the caller
        turns it into a clean 502 rather than shipping a half-filled block set.
        """
        api_key = ai_tenant.openai_key_for(self.request.user, purpose='chat-json')
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)
        from openai import OpenAI  # noqa: PLC0415
        client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
        completion = client.chat.completions.create(
            model=llm_model,
            messages=[{'role': 'system', 'content': system_prompt}, *user_messages],
            response_format={'type': 'json_object'},
            temperature=temperature,
            max_tokens=max_tokens,
        )
        raw = (completion.choices[0].message.content or '').strip() if completion.choices else ''
        if not raw:
            raise ValueError('OpenAI returned an empty response')
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError('OpenAI returned a non-object JSON')
        missing = [k for k in required_keys if not data.get(k)]
        if missing:
            raise ValueError(f'OpenAI response is missing: {", ".join(missing)}')
        return data

    @action(detail=False, methods=['get'], url_path='download-url')
    def download_url(self, request):
        """Return a browser-navigable URL that forces a FILE DOWNLOAD (attachment).

        The character media lives on two hosts that both display images *inline*
        by default, so a plain ``<a download>`` in the browser either opens a new
        tab (Cloudfly presigned URLs are cross-origin without CORS, so a
        client-side ``fetch`` is blocked) or downloads with the wrong extension.

        This centralises the fix server-side:

        * **Cloudfly** (``s3.cloudfly.vn``) — re-presign the object with
          ``ResponseContentDisposition=attachment`` (a query param can't be added
          to an already-signed URL without breaking the signature).
        * **SeaweedFS** (public Filer URL) — append
          ``response-content-disposition=attachment`` (honoured by the Filer).

        The frontend just navigates to the returned URL; the ``attachment``
        disposition makes the browser download it and stay on the page — no CORS,
        correct filename/extension, works for images and videos alike. Only our
        own two media hosts are ever signed/rewritten; any other host is returned
        unchanged.
        """
        from urllib.parse import quote, urlparse

        url = (request.query_params.get('url') or '').strip()
        if not url:
            return Response({'detail': 'Thiếu url.'}, status=status.HTTP_400_BAD_REQUEST)
        # Sanitise the download filename: strip characters that would break the
        # Content-Disposition header, keep it short.
        name = (request.query_params.get('name') or 'download').strip()[:120]
        name = name.replace('"', '').replace('\\', '').replace('\r', '').replace('\n', '') or 'download'
        disposition = f'attachment; filename="{name}"'

        parsed = urlparse(url)
        cloud_host = urlparse(settings.CLOUDFLY_S3_ENDPOINT).netloc
        seaweed_host = urlparse(getattr(settings, 'SEAWEEDFS_PUBLIC_BASE_URL', '') or '').netloc
        # Image URLs are rewritten on read to the backend media proxy
        # (MEDIA_PROXY_BASE_URL/api/media/…) when the public SeaweedFS host is down;
        # the proxy honours the SAME disposition query param as the Filer.
        proxy_host = urlparse(getattr(settings, 'MEDIA_PROXY_BASE_URL', '') or '').netloc

        # Cloudfly → re-presign the object with an attachment disposition.
        if cloud_host and parsed.netloc == cloud_host:
            path = parsed.path.lstrip('/')
            bucket = settings.CLOUDFLY_BUCKET.strip('/')
            key = path[len(bucket) + 1:] if path.startswith(bucket + '/') else path
            if key:
                try:
                    from facebook.s3_utils import _get_s3_client  # noqa: PLC0415
                    client = _get_s3_client()
                    dl = client.generate_presigned_url(
                        'get_object',
                        Params={
                            'Bucket': settings.CLOUDFLY_BUCKET,
                            'Key': key,
                            'ResponseContentDisposition': disposition,
                        },
                        ExpiresIn=900,
                    )
                    return Response({'url': dl}, status=status.HTTP_200_OK)
                except Exception as exc:  # noqa: BLE001 — fall back to the raw URL
                    logger.warning('download_url presign failed: %s', exc)
                    return Response({'url': url}, status=status.HTTP_200_OK)

        # SeaweedFS public Filer URL OR our own media proxy → append the disposition
        # override query param (the Filer honours it natively; the proxy via
        # content.views.media_proxy).
        if (seaweed_host and parsed.netloc == seaweed_host) or (proxy_host and parsed.netloc == proxy_host):
            sep = '&' if parsed.query else '?'
            # dl=1 makes this a DISTINCT CDN cache key from the inline <img> URL and
            # from any URL that got cached before the attachment header existed
            # (which the CDN would otherwise keep serving for a year). The proxy
            # serves downloads no-store, so this key is never cached again either.
            return Response(
                {'url': f'{url}{sep}response-content-disposition={quote(disposition)}&dl=1'},
                status=status.HTTP_200_OK,
            )

        # Unknown host — never sign/rewrite arbitrary URLs; return unchanged.
        return Response({'url': url}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['get'], url_path='image-usage')
    def image_usage(self, request):
        """Per-account image-generation usage for a day and its month.

        Returns ``{date, calls, images, month, month_calls, month_images}`` —
        ``calls`` = OpenAI image API calls made by this user, ``images`` = how
        many returned an image; the ``month_*`` fields are the same totals over
        the whole calendar month of ``date``. Optional ``?date=YYYY-MM-DD``.
        """
        from django.utils import timezone
        date_str = (request.query_params.get('date') or '').strip()
        day = parse_date(date_str) if date_str else timezone.localdate()
        if day is None:
            return Response({'detail': 'Invalid date.'}, status=status.HTTP_400_BAD_REQUEST)

        base = ImageGenerationLog.objects.filter(owner=request.user)
        day_qs = base.filter(created_at__date=day)
        month_qs = base.filter(created_at__year=day.year, created_at__month=day.month)
        return Response({
            'date': day.isoformat(),
            'calls': day_qs.count(),
            'images': day_qs.filter(success=True).count(),
            'month': day.strftime('%Y-%m'),
            'month_calls': month_qs.count(),
            'month_images': month_qs.filter(success=True).count(),
            # Công ty của tài khoản này ('' = chưa gán, dùng key mặc định). Số liệu vẫn
            # là của RIÊNG tài khoản như trước — trường này chỉ để kiểm tra nhanh xem
            # tài khoản đã được gán đúng công ty chưa. Sao kê cả công ty thì truy vấn
            # ImageGenerationLog theo `tenant` (Django admin hoặc SQL).
            'tenant': ai_tenant.tenant_of(request.user),
        })

    # ----------------------------- Image-generation helpers -----------------------------

    def _openai_generate_image(self, prompt, reference_b64=None, no_fallback=False, explain=False,
                              size=DEFAULT_OPENAI_IMAGE_SIZE, quality=None):
        """Generate one image via OpenAI → ``(b64, None)`` or ``(None, error_response)``.

        If ``reference_b64`` is given (a character face), the result comes from a
        reference-guided ``images.edit`` so it resembles that person. Such a call
        NEVER falls back to a text-only ``images.generate`` — that would drop the
        face and return an unrelated random person (the "each scene a different
        face/outfit" bug).

        Exactly ONE OpenAI image call is made. A moderation rejection is returned to
        the caller as an error: the prompt is never silently rewritten and retried,
        because that billed a second image call and handed back a picture nobody
        asked for. ``size`` must be one of ``OPENAI_IMAGE_SIZES``; ``quality`` (when
        given) one of ``OPENAI_IMAGE_QUALITIES``, else the low server default.

        ``no_fallback`` is retained for signature compatibility but no longer
        branches behaviour: a reference call always surfaces the error, and a
        reference-less call always uses ``images.generate`` (there is no face to
        preserve). Only reference-less calls reach the generate path below.
        """
        _ = no_fallback  # retained for caller compatibility; see docstring
        # Key riêng theo công ty của người gọi (xem content.ai_tenant). Thiếu key thì
        # TỪ CHỐI, không rơi về key mặc định — rơi về mặc định là tính tiền sang công
        # ty khác.
        api_key = ai_tenant.openai_key_for(self.request.user, purpose='SINH-ẢNH')
        if not api_key:
            return None, Response(
                {'detail': ai_tenant.missing_key_detail(self.request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        model = getattr(settings, 'OPENAI_IMAGE_MODEL', '') or DEFAULT_OPENAI_IMAGE_MODEL
        # An explicit per-call quality (brief test-bench) wins; otherwise the low
        # server default. Already whitelisted at the action, so trusted here.
        quality = quality or getattr(settings, 'OPENAI_IMAGE_QUALITY', '') or DEFAULT_OPENAI_IMAGE_QUALITY
        from openai import OpenAI  # noqa: PLC0415 — lazy
        # Bound each image call: without an explicit timeout the SDK waits ~10 min
        # (+ its default retries) on a stuck request, pinning this web worker. On
        # timeout the SDK raises APITimeoutError → caught by the except blocks
        # below → clean 502 / 400 error, so the user just re-generates.
        image_timeout = float(getattr(settings, 'OPENAI_IMAGE_TIMEOUT', 120) or 120)
        image_retries = int(getattr(settings, 'OPENAI_IMAGE_MAX_RETRIES', 0) or 0)
        client = OpenAI(api_key=api_key, timeout=image_timeout, max_retries=image_retries)
        _release_db_connection()  # nhả kết nối DB trong lúc chờ OpenAI (chống PoolTimeout)

        # Prompt do "Tạo nhân vật" dựng ra luôn bằng tiếng Việt (mô tả người + cảnh).
        # Đưa thẳng chuỗi tiếng Việt cho gpt-image khiến nó VẼ CHỮ TIẾNG VIỆT lên
        # biển hiệu/băng rôn — kể cả khi cảnh ở Philippines (ví dụ "Đỉnh núi Taal",
        # "Chào mừng các bạn"). Dịch prompt sang tiếng Anh cho model NGAY TRƯỚC khi
        # sinh ảnh (text tiếng Việt user nhìn/sửa ở FE giữ nguyên), đồng thời bắt
        # mọi chữ trong ảnh phải theo ngôn ngữ bản địa của quốc gia trong cảnh.
        import time as _time
        _t_translate0 = _time.monotonic()
        prompt_before_translate = prompt
        prompt = self._translate_prompt_for_image(prompt)
        translate_ms = int((_time.monotonic() - _t_translate0) * 1000)
        # Độ dài được kiểm ở generate_image TRƯỚC khi dịch, nhưng bản DỊCH mới là thứ
        # gửi cho gpt-image, và nó nở ra thêm (đo trên log thật: 3.425 → 3.603 ký tự).
        # Nên một prompt sát trần vẫn có thể vượt trần SAU khi dịch. Bản gốc thì chắc
        # chắn vừa (đã qua cửa kiểm) nên quay về dùng nó: dịch chỉ là bước tối ưu chất
        # lượng, không được phép làm hỏng việc tạo ảnh. Cắt thêm ở đây chỉ để chặn cứng,
        # thực tế không bao giờ cắt vì caller đã giới hạn prompt gốc.
        # (Trần MAX_PROMPT_LEN là của MÌNH, không phải của model — model cho tới 32.000.
        # Nhưng đã đặt trần thì phải giữ nhất quán ở cả hai phía của bước dịch.)
        if len(prompt) > MAX_PROMPT_LEN:
            logger.warning(
                'prompt sau khi dịch dài %d ký tự > cap %d — dùng lại prompt gốc (%d ký tự)',
                len(prompt), MAX_PROMPT_LEN, len(prompt_before_translate),
            )
            prompt = prompt_before_translate[:MAX_PROMPT_LEN]
        # Log the EXACT prompt sent to gpt-image (post-translation) + the original,
        # so a wrong-country / inconsistent scene can be traced to the words that
        # produced it. reference=True means the images.edit (face-lock) path.
        logger.info(
            'image prompt (reference=%s) original=%r | final=%r',
            bool(reference_b64), prompt_before_translate, prompt,
        )

        # Timing: measure the OpenAI image call separately from the translate step
        # so "cái nhanh cái chậm" is attributable — the translate hop is the usual
        # reason a Vietnamese prompt is slower than an English one.
        _t_img0 = _time.monotonic()
        result = None
        if reference_b64:
            import io as _io
            # One OR MORE reference images. Single ref = the usual face-lock. A
            # realref scene sends TWO — [real photo for pose/scene, character image
            # for the face] — which gpt-image composites in one edit call (keep
            # image-1's pose/scene, put image-2's face on it, different outfit).
            raw_list = reference_b64 if isinstance(reference_b64, (list, tuple)) else [reference_b64]
            ref_files = []
            for i, b64 in enumerate(raw_list):
                if not b64:
                    continue
                raw = self._safe_b64decode(b64)
                # Name each part by its REAL format (JPEG mislabelled 'reference.png'
                # → OpenAI could reject the edit). See _sniff_image_mime_ext.
                _, ref_ext = _sniff_image_mime_ext(raw)
                f = _io.BytesIO(raw)
                f.name = f'reference{i}.{ref_ext}'
                ref_files.append(f)
            # A single image is passed as-is; multiple as a list (gpt-image accepts
            # a list of input images for a composited edit).
            image_arg = ref_files[0] if len(ref_files) == 1 else ref_files
            # Reference-guided edit: exactly ONE call. A moderation block is reported
            # to the user as-is — we never silently rewrite the prompt and retry,
            # because that billed a second image call and handed back a picture the
            # user never asked for. Crucially, a reference-anchored call NEVER falls
            # through to the text-only images.generate below: that drops the face and
            # returns an unrelated random person (the "mỗi ảnh một mặt" bug). If the
            # edit can't succeed, surface the error so the user re-generates it.
            try:
                for f in ref_files:
                    f.seek(0)
                result = client.images.edit(model=model, image=image_arg, prompt=prompt, size=size, quality=quality, n=1)
            except Exception as exc:  # noqa: BLE001
                result = None
                self._log_image_gen(success=False)
                self._log_image_failure('images.edit', exc, prompt)
                detail = self._image_failure_detail(exc, 'images.edit', prompt, 'Không chỉnh sửa được ảnh', explain)
                return None, Response({'detail': detail}, status=status.HTTP_400_BAD_REQUEST)

        if result is None:
            # Text-only generation: also exactly ONE call, same reasoning as above.
            try:
                result = client.images.generate(
                    model=model,
                    prompt=prompt,
                    size=size,
                    quality=quality,
                    n=1,
                )
            except Exception as exc:  # noqa: BLE001 — surface a clean 502, log the detail
                self._log_image_gen(success=False)
                self._log_image_failure('images.generate', exc, prompt)
                detail = self._image_failure_detail(exc, 'images.generate', prompt, 'Tạo ảnh thất bại', explain)
                return None, Response(
                    {'detail': detail},
                    status=status.HTTP_502_BAD_GATEWAY,
                )
        try:
            image_b64 = result.data[0].b64_json
        except (AttributeError, IndexError, TypeError):
            image_b64 = None
        if not image_b64:
            self._log_image_gen(success=False)
            return None, Response(
                {'detail': 'Image-generation service returned no image.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        self._log_image_gen(success=True)
        img_ms = int((_time.monotonic() - _t_img0) * 1000)
        # One line per generated image: translate cost vs the OpenAI image cost.
        # This is what explains why two "person" images take very different times.
        logger.info(
            'image timing (reference=%s): translate=%dms image=%dms',
            bool(reference_b64), translate_ms, img_ms,
        )
        return image_b64, None

    def _log_image_gen(self, success, provider='openai'):
        """Record one image-generation API call for per-account daily reporting and
        per-provider cost tracking. Best-effort: a logging failure must never break
        image generation. ``provider`` defaults to 'openai' since every call site
        inside ``_openai_generate_image`` (the only other caller) is the OpenAI
        path by construction; the fal path passes its actual provider explicitly."""
        try:
            user = getattr(self.request, 'user', None)
            authed = user is not None and user.is_authenticated
            tenant = ai_tenant.tenant_of(user) if authed else ''
            ImageGenerationLog.objects.create(
                owner=user if authed else None,
                success=success,
                provider=provider,
                # Chốt công ty NGAY LÚC GỌI: chuyển tài khoản sang công ty khác về sau
                # không được làm đổi hoá đơn của tháng đã qua (xem ghi chú ở model).
                tenant=tenant,
            )
            # Dòng TỔNG KẾT một lượt tính tiền — mỗi dòng ở đây là một lượt gọi model có
            # phí. Cùng tiền tố AI-KEY với log chọn key để lọc chung một lệnh grep, và
            # đối chiếu được ngay với bảng sao kê ImageGenerationLog.
            logger.info(
                '%s | TÍNH-TIỀN | user=%s | cong-ty=%s | provider=%s | ket-qua=%s',
                ai_tenant.LOG_TAG,
                getattr(user, 'username', None) or '(chưa đăng nhập)',
                tenant or '(chưa gán → key mặc định)',
                provider,
                'CÓ ẢNH' if success else 'THẤT BẠI (vẫn có thể bị tính tiền)',
            )
        except Exception:  # noqa: BLE001
            logger.exception('failed to write ImageGenerationLog')

    @staticmethod
    def _strip_data_uri(value):
        """Return the raw base64 payload from a data URI or a bare base64 string."""
        if not value:
            return ''
        value = str(value)
        return value.split(',', 1)[-1] if value.startswith('data:') else value

    @staticmethod
    def _safe_b64decode(value):
        """Decode base64 tolerantly (strip data-URI, drop whitespace, re-pad).

        ``base64.b64decode`` is strict: a payload that lost its trailing ``=``
        padding or picked up whitespace/newlines raises "Incorrect padding". That
        broke the reference-guided ``images.edit`` (it silently fell back to a
        text-only generation → wrong face) and the colour-filter endpoint. Same
        normalisation as ``content.seaweedfs_utils.upload_character_image_to_seaweedfs``.
        """
        import base64 as _b64  # noqa: PLC0415
        data = value.split(',', 1)[-1] if str(value).startswith('data:') else str(value or '')
        data = ''.join(data.split())
        data += '=' * (-len(data) % 4)
        return _b64.b64decode(data)

    @staticmethod
    def _as_data_uri(img):
        """Wrap a raw base64 string, or pass through an existing data URI."""
        img = str(img)
        if img.startswith('data:'):
            return img
        return f'data:image/png;base64,{img}'

    @staticmethod
    def _is_moderation_blocked(exc):
        """True if an OpenAI image error is a content-moderation rejection."""
        code = ''
        body = getattr(exc, 'body', None)
        if isinstance(body, dict):
            err = body.get('error') if isinstance(body.get('error'), dict) else body
            if isinstance(err, dict):
                code = err.get('code') or ''
        msg = str(getattr(exc, 'message', '') or exc).lower()
        return code == 'moderation_blocked' or 'safety system' in msg or 'content_policy' in msg or 'moderation' in msg

    @staticmethod
    def _moderation_stage_categories(exc):
        """``(stage, categories)`` của một lần bị kiểm duyệt chặn. Không bao giờ raise.

        ``moderation_stage`` is the one that matters: ``input`` means the prompt
        was refused before any work happened, ``output`` means the image was
        rendered and then discarded by OpenAI's own classifier — so an ``output``
        block is non-deterministic (it depends on what got drawn) and cannot be
        avoided by inspecting the prompt.

        Stage cũng là thứ quyết định LỜI KHUYÊN: ``output`` nghĩa là ảnh tải lên đã
        qua cửa kiểm duyệt bình thường, chỉ ảnh vẽ ra mới bị chặn — bảo người dùng
        đổi ảnh khác lúc đó là chỉ sai đường (xem :meth:`_moderation_advice`).
        """
        stage = categories = ''
        # ``exc.body`` IS the inner error dict — ``{'code': …, 'message': …}`` — not
        # ``{'error': {…}}``. Reaching for a nested 'error' key found nothing, so
        # moderation_details was never read and every log line said ``stage=?``.
        body = getattr(exc, 'body', None)
        err = body if isinstance(body, dict) else None
        if isinstance(err, dict) and isinstance(err.get('error'), dict):
            err = err['error']
        if isinstance(err, dict):
            details = err.get('moderation_details')
            if isinstance(details, dict):
                stage = str(details.get('moderation_stage') or '')
                cats = details.get('categories')
                if isinstance(cats, (list, tuple)):
                    categories = ','.join(str(c) for c in cats)
        # The violation list only appears in free text. Search the body's own message
        # as well as the exception's: the latter only happens to contain it because
        # the SDK stringifies the whole body into it, which is not a contract.
        msg = ' '.join(filter(None, [
            str(err.get('message') or '') if isinstance(err, dict) else '',
            str(getattr(exc, 'message', '') or exc),
        ]))
        if not stage:
            m = re.search(r'moderation_stage["\']?\s*[:=]\s*["\']?(\w+)', msg)
            if m:
                stage = m.group(1)
        if not categories:
            m = re.search(r'safety_violations=\[([^\]]*)\]', msg)
            if m:
                categories = m.group(1)
        return stage, categories

    def _moderation_info(self, exc):
        """Short ``key=value`` line about a moderation rejection, for the log.
        Never raises."""
        stage, categories = self._moderation_stage_categories(exc)
        # The SDK lifts the x-request-id header onto the exception; the message text
        # never spells "request ID", so the old regex over `msg` always came back empty.
        request_id = str(getattr(exc, 'request_id', '') or '')
        return f'stage={stage or "?"} categories={categories or "?"} request_id={request_id or "?"}'

    def _translate_prompt_for_image(self, prompt):
        """Dịch prompt sinh ảnh (thường là tiếng Việt do "Tạo nhân vật" dựng) sang
        tiếng Anh cho gpt-image, GIỮ NGUYÊN mọi chi tiết chủ thể/cảnh/máy ảnh.

        Mục đích chính: sửa lỗi ảnh nhân vật ngoài Việt Nam bị vẽ CHỮ TIẾNG VIỆT
        lên biển hiệu. Vì thế còn ép: mọi chữ hiện trong ảnh (biển hiệu, băng rôn,
        nhãn, mặt tiền) phải theo ngôn ngữ bản địa của quốc gia/địa điểm trong cảnh
        (vd Philippines → Filipino/English), TUYỆT ĐỐI không dùng tiếng Việt cho
        địa điểm ngoài Việt Nam.

        Bỏ qua (trả nguyên prompt) khi: tắt qua ``OPENAI_IMAGE_TRANSLATE=False``,
        chưa cấu hình API key, prompt đã thuần ASCII (tiếng Anh mặc định), hoặc gọi
        LLM lỗi — dịch chỉ là bước tối ưu, không được phép làm hỏng việc tạo ảnh."""
        if not getattr(settings, 'OPENAI_IMAGE_TRANSLATE', True):
            return prompt
        # Prompt không có chữ tiếng Việt thì đã là tiếng Anh → khỏi dịch, tránh tốn
        # thêm 1 lần gọi LLM + độ trễ trên hot path mỗi ảnh.
        #
        # Điều kiện này TRƯỚC ĐÂY là prompt.isascii(). Nhưng prompt do FE dựng sẵn tuy
        # toàn tiếng Anh vẫn rớt khỏi cửa đó chỉ vì vài ký tự soạn thảo — gạch ngang
        # dài "—", nháy cong "’", dấu nhân "×" — nên vẫn bị dịch Anh→Anh: tốn tiền,
        # tốn thời gian, và nguy hiểm nhất là bản dịch bị max_tokens cắt cụt. Khối
        # NO_TEXT (bắt mọi biển hiệu phải để trống, chống chữ/watermark hiện trong
        # ảnh) nằm CUỐI prompt nên nó là thứ bị cắt đầu tiên. Đo trên log thật: một
        # bản dịch dài 3.603 ký tự vừa đúng chạm trần, mà prompt cảnh "toàn cảnh" của
        # trang Tạo ảnh nhanh đã 3.501 ký tự — sát nút.
        if not _VIETNAMESE_CHARS_RE.search(prompt):
            return prompt
        api_key = ai_tenant.openai_key_for(self.request.user, purpose='dịch-prompt-sang-tiếng-Anh')
        if not api_key:
            return prompt
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        system_prompt = (
            'You translate prompts for an AI image generator into fluent natural English. '
            'Preserve EVERY detail exactly: the subject/person, appearance, clothing, pose, '
            'facial expression, scene, setting, country, lighting and camera/framing. Do not add, '
            'drop or reinterpret anything. CRITICAL: any text visible inside the image itself '
            '(signboards, banners, shop fronts, labels, screens) must read in the natural LOCAL '
            'language of the country or place described in the scene — for example Filipino or '
            'English for the Philippines, Vietnamese only if the scene is in Vietnam. NEVER render '
            'Vietnamese text for a non-Vietnamese location. Output ONLY the translated English '
            'prompt text, no quotes or explanation.'
        )
        try:
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': prompt},
                ],
                temperature=0.2,
                max_tokens=900,
            )
            translated = (completion.choices[0].message.content or '').strip() if completion.choices else ''
            return translated or prompt
        except Exception as exc:  # noqa: BLE001 — dịch lỗi thì dùng prompt gốc, không chặn tạo ảnh
            logger.warning('translate prompt for image failed: %s', exc)
            return prompt

    def _log_image_failure(self, op, exc, prompt):
        """One log line per failed OpenAI image call.

        A moderation rejection gets its stage / categories / request-id broken out,
        so a recurring ``stage=output`` (image drawn, then discarded by OpenAI's own
        classifier) is visible in the logs instead of hiding behind a generic 400.
        """
        if self._is_moderation_blocked(exc):
            logger.warning(
                '%s blocked by moderation — %s | prompt=%r', op, self._moderation_info(exc), prompt[:160],
            )
        else:
            logger.error('%s failed: %s | prompt=%r', op, exc, prompt[:160])

    def _moderation_advice(self, op, stage=''):
        """What the user should actually change after a moderation block.

        ``images.edit`` uploads a photo, and OpenAI moderates that photo as well as
        the words. Telling an edit user to "sửa prompt" sends them to rewrite a
        sentence that was never the problem — that is exactly what happened when a
        user reworded "change the hair color to brown" three times while the same
        photo kept being refused.

        NHƯNG lời khuyên đó chỉ đúng cho ``stage='input'``. Với ``stage='output'``
        thì ảnh tải lên ĐÃ QUA kiểm duyệt, OpenAI vẽ xong rồi mới chấm ảnh kết quả
        là vi phạm — nguyên nhân nằm ở phần mô tả. Bảo họ đổi ảnh lúc đó là đẩy họ
        đi sai hướng, và mỗi vòng thử lại đều bị tính tiền (``stage=output`` nghĩa
        là ảnh đã được vẽ ra rồi mới vứt đi). Log prod 18/08 có một người bị chặn
        6 lần trong 84 giây vì đi đổi ảnh theo đúng lời khuyên cũ.
        """
        if stage == 'output':
            # Chỉ luồng edit mới có ảnh tải lên để mà nhắc tới; nói câu đó ở luồng
            # generate (chỉ có chữ, không có ảnh nào) là làm người dùng rối thêm.
            khong_phai_anh = (
                ' Ảnh bạn tải lên không có vấn đề gì — đổi ảnh khác vẫn sẽ bị chặn y như vậy.'
                if op == 'images.edit' else ''
            )
            return (
                'OpenAI đã vẽ xong ảnh rồi mới từ chối trả về, vì bộ lọc của họ chấm CHÍNH ẢNH '
                'KẾT QUẢ là nhạy cảm.' + khong_phai_anh + ' Hãy sửa phần mô tả: bỏ đồ bơi / '
                'bikini / đồ lót / trang phục bó sát hoặc hở, và bỏ các câu tả vóc dáng, vòng '
                'ngực, đường cong. Thử lại mà không đổi mô tả thì kết quả vẫn thế.'
            )
        if op == 'images.edit':
            return (
                'OpenAI từ chối chính tấm ảnh bạn tải lên, không phải phần mô tả — bộ lọc của họ '
                'chấm ảnh gốc là nhạy cảm. Sửa lại câu chữ sẽ không giúp được gì. Hãy dùng ảnh khác '
                '(ảnh chụp người mặc đồ bó sát hoặc hở thường bị chặn) hoặc cắt bớt khung hình.'
            )
        return (
            'Ảnh bị OpenAI từ chối vì nội dung nhạy cảm. Hãy sửa prompt — thường là do mô tả '
            'vóc dáng / vòng ngực / đường cong, hoặc quần áo bó sát, hở hang — rồi tạo lại.'
        )

    def _image_error_detail(self, exc, fallback_prefix, op=''):
        """User-facing message for a failed image call.

        Moderation gets its own text: the prompt is NOT rewritten for the user any
        more, so they have to know what to change themselves.
        """
        if self._is_moderation_blocked(exc):
            stage, _ = self._moderation_stage_categories(exc)
            return self._moderation_advice(op, stage)
        reason = self._openai_error_reason(exc)
        return f'{fallback_prefix}: {reason}' if reason else f'{fallback_prefix}.'

    def _image_failure_detail(self, exc, op, prompt, fallback_prefix, explain):
        """Pick the message the user sees, and decide whether GPT gets to guess.

        A moderation block on ``images.edit`` is answered deterministically. The
        explainer LLM is only ever handed the prompt text — never the uploaded photo
        — so on an edit it cannot see the real cause, yet it is asked to name one. It
        blamed the word "hair" in "change the hair color to brown" and sent the user
        rewording for four minutes while the photo stayed the same. On the
        ``images.generate`` path the prompt IS the only input, so the explanation is
        worth its API call.

        Lời khuyên còn phụ thuộc ``moderation_stage`` — xem :meth:`_moderation_advice`.
        """
        if self._is_moderation_blocked(exc) and op == 'images.edit':
            stage, _ = self._moderation_stage_categories(exc)
            return self._moderation_advice(op, stage)
        detail = self._explain_image_error_with_llm(prompt, exc) if explain else ''
        return detail or self._image_error_detail(exc, fallback_prefix, op)

    @staticmethod
    def _openai_error_reason(exc):
        """Human-readable reason from an OpenAI SDK exception so the FE shows
        *why* a generation failed instead of a generic message (it displays this
        verbatim, after "Tạo ảnh thất bại: ").

        Safety-system rejections are the most common failure for character
        prompts (e.g. "ngực to") — those get a clear Vietnamese hint; other
        errors (invalid model, quota, …) pass through OpenAI's own message.
        Never echoes the API key: OpenAI errors don't include it. Truncated so
        we don't dump a huge body."""
        body = getattr(exc, 'body', None)
        code = msg = ''
        if isinstance(body, dict):
            err = body.get('error') if isinstance(body.get('error'), dict) else body
            if isinstance(err, dict):
                code = err.get('code') or ''
                msg = err.get('message') or ''
        if not msg:
            msg = getattr(exc, 'message', None) or str(exc).strip()
        if code == 'moderation_blocked' or 'safety system' in msg.lower():
            return ('prompt bị hệ thống kiểm duyệt của OpenAI từ chối vì nội dung '
                    'nhạy cảm. Hãy viết lại mô tả nhẹ nhàng hơn, tránh từ ngữ gợi '
                    'dục hoặc nhạy cảm.')
        return str(msg)[:300]

    @staticmethod
    def _raw_openai_error_text(exc):
        """Lỗi gốc (mã + message tiếng Anh) từ một exception của OpenAI SDK, KHÔNG
        thay thế gì — dùng làm đầu vào cho GPT phân tích. Cắt ngắn để khỏi gửi cả
        body khổng lồ. OpenAI errors không chứa API key nên an toàn."""
        body = getattr(exc, 'body', None)
        code = msg = ''
        if isinstance(body, dict):
            err = body.get('error') if isinstance(body.get('error'), dict) else body
            if isinstance(err, dict):
                code = err.get('code') or ''
                msg = err.get('message') or ''
        if not msg:
            msg = getattr(exc, 'message', None) or str(exc).strip()
        return (f'[{code}] {msg}' if code else str(msg))[:600]

    def _explain_image_error_with_llm(self, prompt, exc):
        """Khi người dùng tự nhập prompt (không phải prompt mặc định của hệ thống)
        và việc tạo ảnh bị lỗi, nhờ chat model đọc prompt + lỗi gốc của OpenAI rồi
        giải thích NGẮN GỌN, dễ hiểu bằng tiếng Việt cho người dùng: vì sao lỗi,
        từ/ý nào trong prompt có thể gây ra, nên sửa thế nào. Trả '' nếu không gọi
        được (caller tự fallback về thông báo lỗi tĩnh)."""
        api_key = ai_tenant.openai_key_for(self.request.user, purpose='giải-thích-lỗi-kiểm-duyệt')
        if not api_key:
            return ''
        raw = self._raw_openai_error_text(exc)
        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL
        # The old rule — "chỉ rõ từ hoặc ý nào trong prompt có khả năng gây ra" —
        # contradicted "không bịa thông tin" that followed it: when no word in the
        # prompt is at fault, the only way to obey is to invent one. Naming a culprit
        # is now explicitly optional, and admitting ignorance is an allowed answer.
        system_prompt = (
            'Bạn là trợ lý giải thích lỗi cho người dùng một công cụ tạo ảnh bằng AI. '
            'Người dùng tự nhập prompt và việc tạo ảnh bị lỗi. Dựa vào prompt của người '
            'dùng và thông báo lỗi gốc (tiếng Anh) của OpenAI, hãy giải thích NGẮN GỌN '
            'bằng tiếng Việt, thân thiện, dễ hiểu: (1) vì sao bị lỗi; (2) CHỈ KHI prompt '
            'thật sự chứa từ hoặc ý nhạy cảm thì mới nêu ra từ đó; (3) gợi ý cách sửa. '
            'TUYỆT ĐỐI không đoán bừa một từ vô hại (màu sắc, tóc, quần áo, đồ vật) là '
            'nguyên nhân chỉ để có câu trả lời. Nếu prompt trông hoàn toàn vô hại, hãy '
            'nói thẳng rằng lỗi không nằm ở prompt và nguyên nhân có thể là ảnh người '
            'dùng tải lên. Tối đa 3 câu. Không dùng thuật ngữ kỹ thuật, không nhắc tên '
            'model hay mã lỗi, không bịa thông tin. Chỉ trả về lời giải thích, không '
            'thêm tiêu đề hay ngoặc kép.'
        )
        user_msg = f'PROMPT của người dùng:\n{prompt}\n\nLỖI gốc từ OpenAI:\n{raw}'
        try:
            from openai import OpenAI  # noqa: PLC0415
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': user_msg},
                ],
                temperature=0.3,
                max_tokens=220,
            )
            return (completion.choices[0].message.content or '').strip() if completion.choices else ''
        except Exception as exc2:  # noqa: BLE001
            logger.warning('explain image error with llm failed: %s', exc2)
            return ''

    @action(detail=True, methods=['post'], url_path='optimize-script')
    def optimize_script(self, request, pk=None):
        """Proxy 1 kịch bản (frames) của Content sang ScriptStudio (agent_teams) để
        TỐI ƯU bằng đội AI, trả về kịch bản đã tối ưu để FE xem trước (KHÔNG tự lưu).

        Body (tùy chọn):
          - ``mode``                  : 'real_footage' (mặc định) | 'ai_video'
          - ``allow_structure_change``: bool — false (mặc định) giữ nguyên khung+footage.
          - ``optimization_brief``    : yêu cầu tối ưu (vd 'hook mạnh hơn').

        JWT của người dùng được forward sang agent_teams (cùng DJANGO_SECRET_KEY).
        """
        content = self.get_object()
        frames = content.frames or []
        if not isinstance(frames, list) or not frames:
            return Response(
                {'detail': 'Content này không có frames để tối ưu.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        mode = request.data.get('mode', 'real_footage') or 'real_footage'
        allow_structure_change = bool(request.data.get('allow_structure_change', False))
        brief = request.data.get('optimization_brief', '') or ''
        if not isinstance(brief, str) or len(brief) > MAX_ORDER_DESCRIPTION_LEN:
            return Response(
                {'detail': f'optimization_brief phải là chuỗi ≤ {MAX_ORDER_DESCRIPTION_LEN} ký tự.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        base = (getattr(settings, 'AGENT_TEAMS_URL', '') or '').rstrip('/')
        if not base:
            return Response(
                {'detail': 'Script-optimization service is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        headers = {'Content-Type': 'application/json'}
        auth = request.headers.get('Authorization')
        if auth:
            headers['Authorization'] = auth  # forward JWT (agent_teams xác thực cùng secret)

        payload = {
            'existing_script': {
                'kb_name': content.kb_name or '',
                'od_number': content.od_number or '',
                'frames': frames,
            },
            'mode': mode,
            'allow_structure_change': allow_structure_change,
            'optimization_brief': brief,
        }
        try:
            resp = requests.post(
                f'{base}/script-studio/optimize',
                json=payload,
                headers=headers,
                timeout=N8N_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            logger.error('optimize_script: agent_teams call failed: %s', exc)
            return Response(
                {'detail': 'Failed to reach the script-optimization service.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        if not resp.ok:
            logger.error('optimize_script: agent_teams returned %s', resp.status_code)
            return Response(
                {'detail': f'Script-optimization service returned HTTP {resp.status_code}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            body = resp.json()
        except ValueError:
            return Response(
                {'detail': 'Script-optimization service returned non-JSON.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        # body = {"optimized_script": {kb_name, od_number, frames}}
        return Response(body, status=status.HTTP_200_OK)

    # ══════════════════════════════════════════════════════════════════════
    # Chat-based AI refine — docs/Gen_Scenario/chat-refine-design.md
    # ══════════════════════════════════════════════════════════════════════

    @action(detail=True, methods=['get', 'post'], url_path='script-chat')
    def script_chat(self, request, pk=None):
        """1 thread/Content (= 1 KB). GET lists, POST appends a USER turn,
        calls OpenAI for the ASSISTANT reply, then returns the user message.
        FE refetches the list after a successful POST to render the reply.

        - 404 if the caller doesn't own the Content (handled by get_queryset).
        - 400 on empty/over-long body.
        - 503 if OPENAI_API_KEY is not configured.
        - 502 if OpenAI fails (USER message is still saved for retry).
        """
        content = self.get_object()

        if request.method == 'GET':
            qs = (
                content.script_chat_messages
                .filter(owner=request.user)
                .order_by('created_at')
            )
            return Response(
                ContentScriptChatMessageSerializer(qs, many=True).data
            )

        # POST
        body_raw = (request.data.get('body') or '').strip()
        if not body_raw:
            return Response({'detail': 'body must not be empty.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if len(body_raw) > MAX_CHAT_BODY_LEN:
            return Response(
                {'detail': f'body must be ≤ {MAX_CHAT_BODY_LEN} chars.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Optional pointer to the frame the user is talking about. We tolerate
        # any junk (str, negative, out-of-range) by normalising to None — the
        # message is still useful conversation context.
        raw_target = request.data.get('frame_target')
        frame_target = None
        try:
            n = int(raw_target) if raw_target is not None else None
            frames_len = len(content.frames or [])
            if n and 1 <= n <= frames_len:
                frame_target = n
        except (TypeError, ValueError):
            frame_target = None

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'AI chat service is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Save USER message FIRST so we never lose the user's words even if
        # the OpenAI round-trip blows up below.
        user_msg = ContentScriptChatMessage.objects.create(
            content=content,
            owner=request.user,
            sender=ContentScriptChatMessage.SenderType.USER,
            body=body_raw,
            frame_target=frame_target,
        )

        # Build prior history snapshot for the helper. Exclude the user
        # message we just created (the helper appends it on top via `body`).
        prior = list(
            content.script_chat_messages
            .filter(owner=request.user)
            .exclude(pk=user_msg.pk)
            .order_by('-created_at')[:SCRIPT_CHAT_HISTORY_LIMIT]
        )
        prior.reverse()
        # IMPORTANT: include frame_target so _process_chat_turn can prepend
        # [@Frame N] tags. Without this the AI loses chip context across
        # turns and refines the wrong frame when user replies ambiguously
        # (e.g. "1", "OK", "chốt"). Was a real bug reported 2026-05-28.
        prior_dump = [
            {'sender': m.sender, 'body': m.body, 'frame_target': m.frame_target}
            for m in prior
        ]

        try:
            assistant_text, patches, llm_model = _process_chat_turn(
                frames=content.frames or [],
                kb_name=content.kb_name or '',
                od_number=content.od_number or '',
                mode=content.mode or ContentMode.REAL_FOOTAGE,
                frame_target=frame_target,
                body=body_raw,
                prior_messages=prior_dump,
                jwt_auth=request.headers.get('Authorization'),
            )
        except Exception as exc:  # noqa: BLE001 — surface a 502 but keep user msg
            logger.exception('script_chat OpenAI error: %s', exc)
            return Response(
                {
                    'detail': 'AI tạm thời không phản hồi. Vui lòng thử lại.',
                    'user_message': ContentScriptChatMessageSerializer(user_msg).data,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Persist assistant message + the candidate patches. Patches are NOT
        # auto-applied to Content.frames — the user clicks Apply (in the
        # bubble) which then PATCHes via /update-frame as a separate audit
        # event. Keeping refine-suggest + apply-commit as separate steps
        # preserves the "AI proposes, CODE updates" contract.
        ContentScriptChatMessage.objects.create(
            content=content,
            owner=request.user,
            sender=ContentScriptChatMessage.SenderType.ASSISTANT,
            body=assistant_text,
            frame_target=frame_target,
            llm_model=llm_model,
            attached_patches=patches,
        )

        return Response(
            ContentScriptChatMessageSerializer(user_msg).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'], url_path='refine-frame')
    def refine_frame(self, request, pk=None):
        """Refine ONE frame by calling agent_teams /script-studio/refine-frame.

        Body:
          - ``frame_index``     : 1-based index into Content.frames (required)
          - ``brief``           : user's optimisation brief (optional, ≤ 1000)
          - ``reviewer_focus``  : 'style' | 'brand' | 'content' | 'structure'
                                  (default 'style')

        Server-side flow:
          1. validate inputs
          2. snapshot the original frame (for audit log + rollback safety)
          3. POST to agent_teams with: frame + kb_context + brief + recent_chat
          4. on success, merge AI candidate back via _enforce_frame_contract
             (CODE updates frames; AI only supplies suggestions)
          5. log to ContentScriptAuditLog
        """
        content = self.get_object()
        frames = list(content.frames or [])
        if not frames:
            return Response({'detail': 'Content này chưa có frames.'},
                            status=status.HTTP_400_BAD_REQUEST)

        # Validate frame_index
        try:
            frame_index = int(request.data.get('frame_index'))
        except (TypeError, ValueError):
            return Response({'detail': 'frame_index phải là số nguyên.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if not (1 <= frame_index <= len(frames)):
            return Response(
                {'detail': f'frame_index phải trong [1, {len(frames)}].'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        brief = request.data.get('brief') or ''
        if not isinstance(brief, str) or len(brief) > MAX_REFINE_BRIEF_LEN:
            return Response(
                {'detail': f'brief phải là chuỗi ≤ {MAX_REFINE_BRIEF_LEN} ký tự.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        reviewer_focus = (request.data.get('reviewer_focus') or DEFAULT_REVIEWER_FOCUS).strip().lower()
        if reviewer_focus not in ALLOWED_REVIEWER_FOCUS:
            reviewer_focus = DEFAULT_REVIEWER_FOCUS
        mode = content.mode or ContentMode.REAL_FOOTAGE

        base = (getattr(settings, 'AGENT_TEAMS_URL', '') or '').rstrip('/')
        if not base:
            return Response(
                {'detail': 'Script-refine service is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Last 6 chat turns as additional signal for the reviser. We
        # downsample to a flat compact form so agent_teams doesn't have to
        # know about our message schema.
        recent_chat = []
        for m in list(
            content.script_chat_messages
            .filter(owner=request.user)
            .order_by('-created_at')[:6]
        )[::-1]:
            recent_chat.append({'sender': m.sender, 'body': m.body[:500]})

        original_frame = copy.deepcopy(frames[frame_index - 1])
        payload = {
            'frame': original_frame,
            'kb_context': {
                'kb_name': content.kb_name or '',
                'od_number': content.od_number or '',
                'frames': frames,  # full KB for reviser context
            },
            'brief': brief,
            'reviewer_focus': reviewer_focus,
            'recent_chat': recent_chat,
            'mode': mode,
            'allow_structure_change': False,  # v1 always False (mode guard server side)
        }

        headers = {'Content-Type': 'application/json'}
        auth = request.headers.get('Authorization')
        if auth:
            headers['Authorization'] = auth  # forward JWT to agent_teams

        try:
            resp = requests.post(
                f'{base}/script-studio/refine-frame',
                json=payload,
                headers=headers,
                timeout=REFINE_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            logger.error('refine_frame: agent_teams call failed: %s', exc)
            return Response(
                {'detail': 'Failed to reach the refine service.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        if not resp.ok:
            logger.error('refine_frame: agent_teams returned %s', resp.status_code)
            return Response(
                {'detail': f'Refine service returned HTTP {resp.status_code}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            body = resp.json()
        except ValueError:
            return Response(
                {'detail': 'Refine service returned non-JSON.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        candidate = body.get('frame') if isinstance(body, dict) else None
        if not isinstance(candidate, dict):
            return Response(
                {'detail': 'Refine service response missing "frame" object.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # CODE updates the canonical frame using mode-aware enforcement.
        new_frame = _enforce_frame_contract(original_frame, candidate, mode)
        with transaction.atomic():
            frames[frame_index - 1] = new_frame
            content.frames = frames
            content.save(update_fields=['frames', 'updated_at'])
            ContentScriptAuditLog.objects.create(
                content=content,
                actor=request.user,
                action=ContentScriptAuditLog.Action.REFINE,
                frame_index=frame_index,
                fields_changed={k: new_frame.get(k) for k in
                                ('Voice', 'Text', 'Visual', 'Music')
                                if original_frame.get(k) != new_frame.get(k)},
                previous_value=original_frame,
            )

        return Response({'frame': new_frame}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['patch'], url_path='update-frame')
    def update_frame(self, request, pk=None):
        """Manual edit / Restore for a single frame (auto-save endpoint).

        Body:
          - ``op``           : 'update' (default) | 'restore_frame' | 'restore_all'
          - ``frame_index``  : 1-based index (required for update + restore_frame)
          - ``fields``       : dict of field→value (required for op='update')

        Mode rules:
          - real_footage : only Voice/Text/Visual/Music are writable; other
                           keys in ``fields`` are silently dropped.
          - ai_video     : Footage/Time/Note also writable.
          Source is always coerced to "". Phần / Frame can never be changed
          via this endpoint (use save_generated).

        Restore reads from ``content.origin_frames``; 404 if that snapshot
        is empty (legacy row that hasn't passed through retrieve() yet).
        """
        content = self.get_object()
        frames = list(content.frames or [])
        origin = list(content.origin_frames or [])
        mode = content.mode or ContentMode.REAL_FOOTAGE
        op = (request.data.get('op') or 'update').strip()

        if op == 'restore_all':
            if not origin:
                return Response(
                    {'detail': 'Không có snapshot origin_frames để khôi phục.'},
                    status=status.HTTP_404_NOT_FOUND,
                )
            previous = copy.deepcopy(frames)
            with transaction.atomic():
                content.frames = copy.deepcopy(origin)
                content.save(update_fields=['frames', 'updated_at'])
                ContentScriptAuditLog.objects.create(
                    content=content,
                    actor=request.user,
                    action=ContentScriptAuditLog.Action.RESTORE_ALL,
                    previous_value={'frames': previous},
                )
            return Response({'frames': content.frames}, status=status.HTTP_200_OK)

        # update / restore_frame both need a valid frame_index
        try:
            frame_index = int(request.data.get('frame_index'))
        except (TypeError, ValueError):
            return Response({'detail': 'frame_index phải là số nguyên.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if not (1 <= frame_index <= len(frames)):
            return Response(
                {'detail': f'frame_index phải trong [1, {len(frames)}].'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        original_frame = copy.deepcopy(frames[frame_index - 1])

        if op == 'restore_frame':
            if not origin or frame_index > len(origin):
                return Response(
                    {'detail': 'Không có snapshot frame này trong origin_frames.'},
                    status=status.HTTP_404_NOT_FOUND,
                )
            new_frame = copy.deepcopy(origin[frame_index - 1])
            audit_action = ContentScriptAuditLog.Action.RESTORE_FRAME
            audit_changed = {}
        elif op == 'update':
            fields = request.data.get('fields') or {}
            if not isinstance(fields, dict) or not fields:
                return Response(
                    {'detail': 'fields phải là object không rỗng.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            allowed = EDITABLE_FRAME_FIELDS_BY_MODE.get(mode, EDITABLE_FRAME_FIELDS_BY_MODE['real_footage'])
            clean = {k: v for k, v in fields.items() if k in allowed}
            if not clean:
                return Response(
                    {'detail': f'Không field nào cho phép edit ở mode {mode!r}.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            new_frame = _enforce_frame_contract(original_frame, clean, mode)
            audit_action = ContentScriptAuditLog.Action.UPDATE
            audit_changed = {k: new_frame.get(k) for k in clean.keys()}
        else:
            return Response(
                {'detail': f'op không hợp lệ: {op!r}. Cho phép: update | restore_frame | restore_all.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            frames[frame_index - 1] = new_frame
            content.frames = frames
            content.save(update_fields=['frames', 'updated_at'])
            ContentScriptAuditLog.objects.create(
                content=content,
                actor=request.user,
                action=audit_action,
                frame_index=frame_index,
                fields_changed=audit_changed,
                previous_value=original_frame,
            )

        return Response({'frame': new_frame}, status=status.HTTP_200_OK)

    # ══════════════════════════════════════════════════════════════════════
    # PREVIEW-mode chat & refine — stateless (no Content.id, nothing persisted).
    # Used by ContentPage's "Xem chi tiết" modal so users can refine the 5
    # freshly-generated KBs BEFORE deciding to save them. Lives next to its
    # post-save siblings (script_chat / refine_frame) so the contract +
    # rate-limiting story stays in one place.
    #
    # Why stateless: until the user clicks "Lưu N kịch bản", there's no FK
    # parent row to attach chat messages or audit logs to. We keep chat
    # history in FE state instead (lost on modal close, which matches the
    # "draft brainstorm" UX). Once saved, ContentDetailPage offers the
    # persistent DB-backed chat.
    # ══════════════════════════════════════════════════════════════════════

    @action(detail=False, methods=['post'], url_path='preview-script-chat',
            permission_classes=[permissions.IsAuthenticated])
    def preview_script_chat(self, request):
        """Stateless 1-turn chat for the preview modal.

        Body:
          - ``kb_name``         : 'KB1' etc (display only).
          - ``od_number``       : 'OD 365' etc.
          - ``frames``          : current frames list (FE state, may have
                                  user edits + refines applied).
          - ``mode``            : 'real_footage' | 'ai_video'.
          - ``body``            : user message text.
          - ``frame_target``    : 1-based frame index (optional pointer).
          - ``recent_messages`` : list of {sender, body} prior turns from
                                  FE state. Capped at 30 by the server to
                                  bound prompt cost.

        Returns: ``{"assistant": "<text>", "llm_model": "<id>"}``.
        """
        body_raw = (request.data.get('body') or '').strip()
        if not body_raw:
            return Response({'detail': 'body must not be empty.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if len(body_raw) > MAX_CHAT_BODY_LEN:
            return Response(
                {'detail': f'body must be ≤ {MAX_CHAT_BODY_LEN} chars.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        frames = request.data.get('frames') or []
        if not isinstance(frames, list):
            return Response({'detail': 'frames must be a list.'},
                            status=status.HTTP_400_BAD_REQUEST)
        kb_name = str(request.data.get('kb_name') or '')[:64]
        od_number = str(request.data.get('od_number') or '')[:64]
        mode = (request.data.get('mode') or ContentMode.REAL_FOOTAGE).strip()
        if mode not in {ContentMode.REAL_FOOTAGE, ContentMode.AI_VIDEO}:
            mode = ContentMode.REAL_FOOTAGE

        raw_target = request.data.get('frame_target')
        frame_target = None
        try:
            n = int(raw_target) if raw_target is not None else None
            if n and 1 <= n <= len(frames):
                frame_target = n
        except (TypeError, ValueError):
            frame_target = None

        prior = request.data.get('recent_messages') or []
        if not isinstance(prior, list):
            prior = []

        try:
            assistant_text, patches, llm_model = _process_chat_turn(
                frames=frames,
                kb_name=kb_name,
                od_number=od_number,
                mode=mode,
                frame_target=frame_target,
                body=body_raw,
                prior_messages=prior,
                jwt_auth=request.headers.get('Authorization'),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception('preview_script_chat OpenAI error: %s', exc)
            return Response(
                {'detail': 'AI tạm thời không phản hồi. Vui lòng thử lại.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({
            'assistant': assistant_text,
            'patches': patches,
            'llm_model': llm_model,
        })

    @action(detail=False, methods=['post'], url_path='preview-refine-frame',
            permission_classes=[permissions.IsAuthenticated])
    def preview_refine_frame(self, request):
        """Stateless single-frame refine for the preview modal.

        Body:
          - ``frame``           : the frame object to refine
          - ``kb_context``      : {kb_name, od_number, frames} for narrative
          - ``brief``           : optional optimisation brief
          - ``reviewer_focus``  : 'style' | 'brand' | 'content' | 'structure'
          - ``recent_chat``     : optional list of {sender, body}
          - ``mode``            : 'real_footage' | 'ai_video'

        Returns: ``{"frame": <new frame>}``. No DB writes, no audit log.
        """
        frame = request.data.get('frame')
        if not isinstance(frame, dict):
            return Response({'detail': 'frame must be an object.'},
                            status=status.HTTP_400_BAD_REQUEST)
        brief = request.data.get('brief') or ''
        if not isinstance(brief, str) or len(brief) > MAX_REFINE_BRIEF_LEN:
            return Response(
                {'detail': f'brief phải là chuỗi ≤ {MAX_REFINE_BRIEF_LEN} ký tự.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        reviewer_focus = (request.data.get('reviewer_focus') or DEFAULT_REVIEWER_FOCUS).strip().lower()
        if reviewer_focus not in ALLOWED_REVIEWER_FOCUS:
            reviewer_focus = DEFAULT_REVIEWER_FOCUS
        mode = (request.data.get('mode') or ContentMode.REAL_FOOTAGE).strip()
        if mode not in {ContentMode.REAL_FOOTAGE, ContentMode.AI_VIDEO}:
            mode = ContentMode.REAL_FOOTAGE
        kb_context = request.data.get('kb_context') or {}
        if not isinstance(kb_context, dict):
            kb_context = {}
        recent_chat = request.data.get('recent_chat') or []
        if not isinstance(recent_chat, list):
            recent_chat = []

        base = (getattr(settings, 'AGENT_TEAMS_URL', '') or '').rstrip('/')
        if not base:
            return Response(
                {'detail': 'Script-refine service is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        payload = {
            'frame': frame,
            'kb_context': kb_context,
            'brief': brief,
            'reviewer_focus': reviewer_focus,
            'recent_chat': recent_chat[:6],
            'mode': mode,
            'allow_structure_change': False,
        }

        headers = {'Content-Type': 'application/json'}
        auth = request.headers.get('Authorization')
        if auth:
            headers['Authorization'] = auth  # forward JWT

        try:
            resp = requests.post(
                f'{base}/script-studio/refine-frame',
                json=payload,
                headers=headers,
                timeout=REFINE_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            logger.error('preview_refine_frame: agent_teams call failed: %s', exc)
            return Response(
                {'detail': 'Failed to reach the refine service.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        if not resp.ok:
            logger.error('preview_refine_frame: agent_teams returned %s', resp.status_code)
            return Response(
                {'detail': f'Refine service returned HTTP {resp.status_code}.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            body = resp.json()
        except ValueError:
            return Response(
                {'detail': 'Refine service returned non-JSON.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        candidate = body.get('frame') if isinstance(body, dict) else None
        if not isinstance(candidate, dict):
            return Response(
                {'detail': 'Refine service response missing "frame" object.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Mode-guard server-side even though the in-memory frame isn't
        # persisted — keeps the user's expectation that "real_footage locks
        # Footage/Time/Note" consistent regardless of where refine happened.
        new_frame = _enforce_frame_contract(frame, candidate, mode)
        return Response({'frame': new_frame}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='save-generated')
    def save_generated(self, request):
        """Atomically persist the user's selected scripts as Content records.

        Body::

            {
              "parent_scenario_filename": "ODR365.xlsx",
              "scripts": [
                {"kb_name": "KB1", "od_number": "OD 365", "frames": [...]},
                ...
              ]
            }

        Returns the list of created Content records (full serialized form).
        Every created row has ``source_type='generated'`` so the UI can tell
        them apart from manually-created content.
        """
        parent = request.data.get('parent_scenario_filename', '') or ''
        scripts = request.data.get('scripts')
        # Mode is forwarded from /generate-scripts → FE → here, so the editor
        # can later enforce edit-locks on Footage/Time/Note. Default to the
        # safe (read-only structural) mode for backwards compat.
        mode = (request.data.get('mode') or ContentMode.REAL_FOOTAGE).strip()
        if mode not in {ContentMode.REAL_FOOTAGE, ContentMode.AI_VIDEO}:
            mode = ContentMode.REAL_FOOTAGE

        # ── Validate payload shape ──────────────────────────────────────────
        if not isinstance(scripts, list) or not scripts:
            return Response(
                {'detail': 'scripts must be a non-empty list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(scripts) > MAX_GENERATED_SCRIPTS_PER_SAVE:
            return Response(
                {'detail': 'scripts list too large.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not isinstance(parent, str):
            return Response(
                {'detail': 'parent_scenario_filename must be a string.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        parent = parent[:255]

        # Per-item validation up-front so we never half-create on bad input.
        cleaned = []
        for s in scripts:
            if not isinstance(s, dict):
                return Response(
                    {'detail': 'Each script must be an object.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            frames = s.get('frames') or []
            if not isinstance(frames, list):
                return Response(
                    {'detail': 'frames must be a list.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            kb_name = str(s.get('kb_name') or '')[:64]
            od_number = str(s.get('od_number') or '')[:64]
            title = ' — '.join(p for p in [kb_name, od_number] if p) or 'Untitled scenario'
            cleaned.append({
                'kb_name': kb_name,
                'od_number': od_number,
                'frames': frames,
                'title': title[:255],
            })

        # ── Create all-or-nothing ───────────────────────────────────────────
        # origin_frames receives a deep copy of frames so future PATCHes /
        # refines on Content.frames never mutate the snapshot via shared list
        # references — important for the Restore button to work correctly.
        created = []
        with transaction.atomic():
            for c in cleaned:
                created.append(Content.objects.create(
                    title=c['title'],
                    source_type=ContentSourceType.GENERATED,
                    kb_name=c['kb_name'],
                    od_number=c['od_number'],
                    parent_scenario_filename=parent,
                    frames=c['frames'],
                    origin_frames=copy.deepcopy(c['frames']),
                    mode=mode,
                    owner=request.user,
                ))

        serializer = ContentSerializer(
            created, many=True, context={'request': request}
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['get', 'put'], url_path='feature-system-prompt')
    def feature_system_prompt(self, request):
        """Get or update per-user system prompt for a content feature.

        Query/body:
          - feature_id (required)
        PUT body:
          - system_prompt (required)
        """
        feature_id = (
            (request.query_params.get('feature_id') or request.data.get('feature_id') or '')
            .strip()
        )
        if not feature_id:
            return Response(
                {'detail': 'feature_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if request.method == 'GET':
            prompt_obj, used_default = _resolve_feature_prompt(request.user, feature_id)
            payload = FeatureSystemPromptSerializer(prompt_obj).data
            payload['used_default'] = used_default
            return Response(payload, status=status.HTTP_200_OK)

        system_prompt = request.data.get('system_prompt', '')
        if not isinstance(system_prompt, str):
            return Response(
                {'detail': 'system_prompt must be a string.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        system_prompt = system_prompt.strip()
        if not system_prompt:
            return Response(
                {'detail': 'system_prompt cannot be empty.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        prompt_obj, _ = FeatureSystemPrompt.objects.update_or_create(
            user=request.user,
            feature_id=feature_id,
            defaults={'system_prompt': system_prompt},
        )
        return Response(FeatureSystemPromptSerializer(prompt_obj).data, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='ai-rewrite-repost')
    def ai_rewrite_repost(self, request):
        """Generate rewritten/new repost content using OpenAI and feature prompt.

        Body:
          - feature_id (optional, default: content_repost_ai)
          - mode: rewrite | create
          - source_text (required for rewrite)
          - instruction (optional)
        """
        feature_id = (request.data.get('feature_id') or FEATURE_ID_REPOST_CONTENT_AI)
        mode = (request.data.get('mode') or 'rewrite').strip().lower()
        source_text = request.data.get('source_text', '')
        instruction = request.data.get('instruction', '')

        if not isinstance(feature_id, str) or not feature_id.strip():
            return Response({'detail': 'feature_id must be a non-empty string.'}, status=status.HTTP_400_BAD_REQUEST)
        feature_id = feature_id.strip()

        if mode not in {'rewrite', 'create'}:
            return Response({'detail': 'mode must be either "rewrite" or "create".'}, status=status.HTTP_400_BAD_REQUEST)

        if not isinstance(source_text, str):
            return Response({'detail': 'source_text must be a string.'}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(instruction, str):
            return Response({'detail': 'instruction must be a string.'}, status=status.HTTP_400_BAD_REQUEST)

        source_text = source_text.strip()
        instruction = instruction.strip()

        if mode == 'rewrite' and not source_text:
            return Response({'detail': 'source_text is required for rewrite mode.'}, status=status.HTTP_400_BAD_REQUEST)
        if mode == 'create' and not source_text and not instruction:
            return Response(
                {'detail': 'Provide source_text or instruction for create mode.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_key = getattr(settings, 'OPENAI_API_KEY', '')
        if not api_key:
            return Response(
                {'detail': 'OpenAI API key is not configured on the server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        prompt_obj, used_default_prompt = _resolve_feature_prompt(request.user, feature_id)

        user_prompt_parts = []
        if mode == 'rewrite':
            user_prompt_parts.append('Rewrite the following content into a better social post:')
            user_prompt_parts.append(source_text)
        else:
            user_prompt_parts.append('Create a brand-new social post content based on the following context.')
            if source_text:
                user_prompt_parts.append(f'Context:\n{source_text}')

        if instruction:
            user_prompt_parts.append(f'Additional instruction:\n{instruction}')

        user_prompt = '\n\n'.join(user_prompt_parts)

        llm_model = getattr(settings, 'OPENAI_CONTENT_REWRITE_MODEL', DEFAULT_CONTENT_AI_MODEL) or DEFAULT_CONTENT_AI_MODEL

        try:
            from openai import OpenAI  # noqa: PLC0415

            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            completion = client.chat.completions.create(
                model=llm_model,
                messages=[
                    {'role': 'system', 'content': prompt_obj.system_prompt},
                    {'role': 'user', 'content': user_prompt},
                ],
                temperature=0.7,
            )

            if not completion.choices:
                raise ValueError('OpenAI returned no choices for content rewrite')

            generated_text = (completion.choices[0].message.content or '').strip()
            if not generated_text:
                raise ValueError('OpenAI returned empty content for content rewrite')

            return Response(
                {
                    'feature_id': feature_id,
                    'mode': mode,
                    'content': generated_text,
                    'used_default_prompt': used_default_prompt,
                },
                status=status.HTTP_200_OK,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception('ai_rewrite_repost OpenAI error: %s', exc)
            return Response(
                {'detail': 'Failed to generate rewritten content via OpenAI.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )


class CrawlSourceViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = CrawlSource.objects.select_related('device', 'owner', 'team').all()
    serializer_class = CrawlSourceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def _paginate(self, request, queryset, serializer_class):
        paginator = CrawlResultsPagination()
        page = paginator.paginate_queryset(queryset, request)
        serializer = serializer_class(page if page is not None else queryset, many=True)
        if page is not None:
            return paginator.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def _apply_datetime_filters(self, queryset, field_name, after_param, before_param):
        after_value = self.request.query_params.get(after_param)
        before_value = self.request.query_params.get(before_param)

        if after_value:
            parsed_after = parse_datetime(after_value)
            if parsed_after is None:
                parsed_date = parse_date(after_value)
                if parsed_date is not None:
                    queryset = queryset.filter(**{f'{field_name}__date__gte': parsed_date})
                else:
                    queryset = queryset.none()
            else:
                queryset = queryset.filter(**{f'{field_name}__gte': parsed_after})

        if before_value:
            parsed_before = parse_datetime(before_value)
            if parsed_before is None:
                parsed_date = parse_date(before_value)
                if parsed_date is not None:
                    queryset = queryset.filter(**{f'{field_name}__date__lte': parsed_date})
                else:
                    queryset = queryset.none()
            else:
                queryset = queryset.filter(**{f'{field_name}__lte': parsed_before})

        return queryset

    @action(detail=True, methods=['get'])
    def runs(self, request, pk=None):
        source = self.get_object()
        queryset = source.crawl_runs.all().order_by('-started_at', '-created_at')

        status_value = request.query_params.get('status')
        if status_value:
            queryset = queryset.filter(status=status_value)

        search = request.query_params.get('search', '').strip()
        if search:
            queryset = queryset.filter(
                Q(error_message__icontains=search)
                | Q(triggered_by__icontains=search)
                | Q(source_url__icontains=search)
            )

        queryset = self._apply_datetime_filters(queryset, 'started_at', 'started_after', 'started_before')
        return self._paginate(request, queryset, CrawlRunSerializer)

    @action(detail=True, methods=['get'])
    def snapshots(self, request, pk=None):
        source = self.get_object()
        queryset = CrawlContentSnapshot.objects.filter(
            Q(crawl_source=source) | Q(source_index_url=source.url)
        ).select_related('crawl_source', 'content', 'latest_run').distinct().order_by('-last_updated_at', '-updated_at')

        search = request.query_params.get('search', '').strip()
        if search:
            queryset = queryset.filter(
                Q(title__icontains=search)
                | Q(content_url__icontains=search)
                | Q(summary__icontains=search)
                | Q(content_body__icontains=search)
            )

        content_type = request.query_params.get('content_type', '').strip()
        if content_type:
            queryset = queryset.filter(content_type=content_type)

        has_media = request.query_params.get('has_media', '').strip().lower()
        if has_media in {'1', 'true', 'yes'}:
            queryset = queryset.exclude(media_file_urls=[])
        elif has_media in {'0', 'false', 'no'}:
            queryset = queryset.filter(media_file_urls=[])

        queryset = self._apply_datetime_filters(queryset, 'crawled_at', 'crawled_after', 'crawled_before')
        return self._paginate(request, queryset, CrawlContentSnapshotSerializer)


class CrawlContentSnapshotViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = CrawlContentSnapshotSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = CrawlResultsPagination

    def get_queryset(self):
        accessible_sources = get_accessible_crawl_sources(self.request.user)
        accessible_urls = accessible_sources.values_list('url', flat=True)
        return CrawlContentSnapshot.objects.filter(
            Q(crawl_source__in=accessible_sources) | Q(source_index_url__in=accessible_urls)
        ).select_related('crawl_source', 'content', 'latest_run').distinct().order_by('-last_updated_at', '-updated_at')


def _compose_fb_content(caption: str, hashtags: list[str]) -> str:
    """Merge a TikTok-style caption + hashtag list into a single Facebook post
    body (Facebook has no separate hashtag field — they live inline in text)."""
    parts = []
    cap = (caption or '').strip()
    if cap:
        parts.append(cap)
    tags = ' '.join(f'#{h}' for h in (hashtags or []) if str(h).strip())
    if tags:
        parts.append(tags)
    return '\n\n'.join(parts)


def _dispatch_character_post(
    *, platform, owner, image_urls, caption, hashtags,
    device=None, profile=None, fb_profile=None, fb_page=None, fb_group=None,
):
    """Publish a character photo-post to *platform*. ``image_urls`` must already
    be presigned (fetchable over HTTP).

    Single dispatch point shared by the immediate ``post_photos`` endpoint and
    the scheduler poller. Returns a result dict; raises ``ValueError`` for a bad
    target/config so callers can surface a clean message.
    """
    from task.models import Task, TaskStatus, TaskType
    from mbcontrol.kafka_utils import send_task_execution_message

    if platform == CharacterPostPlatform.TIKTOK:
        if device is None and profile is not None:
            device = profile.device
        if device is None:
            raise ValueError('Chọn thiết bị hoặc profile có gắn thiết bị để đăng.')
        _goal = (
            f"Đăng {len(image_urls)} ảnh lên TikTok kèm caption và hashtag. "
            "Ảnh, caption và hashtag ĐÃ có sẵn trong payload — các tool tự đọc payload. "
            "Gọi lần lượt: tiktok_download_images_to_device → tiktok_open_photo_upload_and_select "
            "→ tiktok_set_photo_caption_and_post. KHÔNG hỏi người dùng, KHÔNG chờ input."
        )
        task = Task.objects.create(
            name='Đăng ảnh TikTok',
            description=_goal,
            task_type=TaskType.GENERIC,
            status=TaskStatus.RUNNING,
            payload={'agent': 'tiktok', 'image_urls': image_urls, 'caption': caption, 'hashtags': hashtags},
            owner=owner,
            device=device,
            device_serial=device.device_serial_id or '',
        )
        send_task_execution_message(
            task,
            devices_id=[device.id],
            profile_id=profile.id if profile else None,
        )
        return {'task_id': task.id, 'device_serial_id': task.device_serial, 'image_count': len(image_urls)}

    # ── Facebook platforms — caption + hashtags collapse into one text body ──
    content = _compose_fb_content(caption, hashtags)

    if platform == CharacterPostPlatform.FACEBOOK_PROFILE:
        from facebook.views import _dispatch_fb_profile_post_task
        if fb_profile is None:
            raise ValueError('Chọn Facebook cá nhân để đăng.')
        task = _dispatch_fb_profile_post_task(fb_profile, content, image_urls)
        return {'task_id': task.id, 'image_count': len(image_urls)}

    if platform == CharacterPostPlatform.FACEBOOK_PAGE:
        from facebook.views import _publish_page_content
        if fb_page is None:
            raise ValueError('Chọn Facebook Page để đăng.')
        data = _publish_page_content(fb_page, content, image_urls)
        return {'fb_post_id': data.get('post_id') or data.get('id') or '', 'image_count': len(image_urls)}

    if platform == CharacterPostPlatform.FACEBOOK_GROUP:
        from facebook.views import _publish_group_content
        if fb_group is None:
            raise ValueError('Chọn Facebook Group để đăng.')
        data = _publish_group_content(fb_group, content, image_urls)
        return {'fb_post_id': data.get('post_id') or data.get('id') or '', 'image_count': len(image_urls)}

    raise ValueError(f'Nền tảng không hỗ trợ: {platform}')


def publish_character_scheduled_post(post) -> None:
    """Publish a due :class:`CharacterScheduledPost` (called by the scheduler).

    Re-presigns the stored image URLs (the originally-signed links have long
    since expired) and reuses ``_dispatch_character_post``. Mutates ``post``
    status to PUBLISHED / FAILED and persists it.
    """
    from facebook.s3_utils import get_presigned_image_url

    post.status = CharacterScheduledPostStatus.PUBLISHING
    post.save(update_fields=['status', 'updated_at'])
    try:
        image_urls = [get_presigned_image_url(str(u)) for u in (post.image_urls or []) if u]
        if not image_urls:
            raise ValueError('Bài lên lịch không có ảnh nào.')
        result = _dispatch_character_post(
            platform=post.platform,
            owner=post.owner,
            image_urls=image_urls,
            caption=post.caption,
            hashtags=post.hashtags or [],
            device=post.device,
            profile=post.profile,
            fb_profile=post.fb_profile,
            fb_page=post.fb_page,
            fb_group=post.fb_group,
        )
    except Exception as exc:  # noqa: BLE001 — record the failure on the row
        post.status = CharacterScheduledPostStatus.FAILED
        post.error_msg = str(exc)[:1000]
        post.save(update_fields=['status', 'error_msg', 'updated_at'])
        raise

    post.status = CharacterScheduledPostStatus.PUBLISHED
    post.error_msg = ''
    if result.get('task_id'):
        post.task_id = result['task_id']
    post.save(update_fields=['status', 'error_msg', 'task', 'updated_at'])


class CharacterViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    """CRUD for saved face-swap characters.

    create  — accepts name + base64 images, uploads to S3, returns Character.
    list    — returns visible characters owned by or shared with the current user.
    destroy — soft-delete: hides the character (row + S3 media are kept).
    add-media — appends additional swapped images to an existing character.
    """
    serializer_class = CharacterSerializer
    queryset = Character.objects.all()
    pagination_class = CharacterPagination
    # patch = rename + edit the appearance blocks (the serializer keeps everything
    # else read-only, so PATCH can only touch `name`, `team_permission` and
    # subject/hair/nails/face_makeup); no put (no full replace).
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def get_queryset(self):
        # Hidden (soft-deleted) characters never show up in the API.
        queryset = super().get_queryset().filter(hidden=False)
        search = (self.request.query_params.get('search') or '').strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        return queryset

    def destroy(self, request, *args, **kwargs):
        """Soft-delete: just hide the character instead of removing the row, so it
        disappears from the UI but stays in the DB (recoverable, history intact)."""
        character = self.get_object()
        character.hidden = True
        character.save(update_fields=['hidden', 'updated_at'])
        return Response(status=status.HTTP_204_NO_CONTENT)

    def create(self, request):
        from django.utils import timezone
        from .seaweedfs_utils import upload_character_image_to_seaweedfs

        # name may be empty → un-named draft (auto-saved when the user closes the
        # wizard without naming). We only require that *some* image is present so
        # we never store a completely empty row.
        name = (request.data.get('name') or '').strip()
        # Persisted so a later "add media" reuses the same identity description.
        face_prompt = (request.data.get('face_prompt') or '').strip()
        # Persisted so later scene generation grounds the setting in the character's
        # own country (a Filipino character must not get a Vietnamese landmark).
        nation = (request.data.get('nation') or '').strip()[:100]
        # The four constant appearance blocks (see Character.subject). Optional:
        # a character saved by the older wizard has only ``face_prompt``.
        blocks = {
            key: (request.data.get(key) or '').strip()[:MAX_PROMPT_LEN]
            for key in ('subject', 'hair', 'nails', 'face_makeup')
        }

        source_b64 = request.data.get('source_image') or ''
        media_b64_list = request.data.get('media') or []
        scenes_b64_list = request.data.get('scenes') or []

        if not isinstance(media_b64_list, list):
            return Response({'detail': 'media must be a list.'}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(scenes_b64_list, list):
            return Response({'detail': 'scenes must be a list.'}, status=status.HTTP_400_BAD_REQUEST)
        if not source_b64 and not media_b64_list and not scenes_b64_list:
            return Response({'detail': 'Nothing to save.'}, status=status.HTTP_400_BAD_REQUEST)

        source_url = ''
        if source_b64:
            source_url = upload_character_image_to_seaweedfs(source_b64, subfolder='source', sanitize=True)

        now_iso = timezone.now().isoformat()
        # media = source + face-swapped results; scenes = raw generated scenes
        # (kept in a separate store, uploaded under characters/scenes/).
        media = self._upload_media_items(media_b64_list, 'media', now_iso)
        scenes = self._upload_media_items(scenes_b64_list, 'scenes', now_iso)

        character = Character.objects.create(
            name=name,
            source_image_url=source_url,
            face_prompt=face_prompt,
            nation=nation,
            media=media,
            scenes=scenes,
            owner=request.user,
            **blocks,
        )
        return Response(CharacterSerializer(character).data, status=status.HTTP_201_CREATED)

    @staticmethod
    def _upload_media_items(b64_list, subfolder, now_iso):
        """Upload each base64 image to SeaweedFS → list of ``{url, created_at}`` items.

        Uploads run concurrently on a small thread pool: each item is independent
        (base64 decode + PIL sanitize + network PUT), so a pool cuts the wall-time
        from sum(N) down to roughly the slowest single upload. ``executor.map``
        preserves input order and re-raises the first failure exactly like the old
        sequential loop.
        """
        from concurrent.futures import ThreadPoolExecutor
        from .seaweedfs_utils import upload_character_image_to_seaweedfs

        valid = [b64 for b64 in b64_list if b64]
        if not valid:
            return []
        # Cap workers so a big save can't flood SeaweedFS with too many parallel PUTs.
        #
        # max_edge WAS 1600, on the reasoning that it "only matters for a locally
        # uploaded photo (e.g. a 4000px phone shot); gpt-image output is at most 1536 on
        # its longest edge, so it is a no-op there". That stopped being true the day the
        # "Làm nét" button shipped (upscale, commit b743393): Real-ESRGAN hands back
        # 2048x3072 for a 1024x1536 scene and this cap shrank it straight back to
        # 1066x1600 — 4% wider than the original, so 48% of the upscale was thrown away
        # at the moment of saving while the UI reported the pre-save 2048x3072. Users
        # reported exactly that ("làm nét… vẫn không cải thiện được mấy") and, downstream,
        # that Facebook showed the image small: FB never enlarges past native size and
        # wants ~2048 on the long edge to fill its lightbox.
        #
        # 4096 keeps the original intent (a 6000px DSLR/phone upload is still bounded)
        # while letting a 2x upscale of the tallest gpt-image output (1536*2 = 3072)
        # through untouched. Cost is storage: an upscaled scene is ~1.7 MB instead of
        # ~335 KB. Only images that were deliberately upscaled pay it — a freshly
        # generated 1024x1536 scene is under both caps and is unaffected.
        #
        # quality was 85 and is now 95 (matching the source image). The old note claimed
        # "no visible quality loss", which measurement disproved: a 1024x1024 scene is
        # 1.242 KB as lossless PNG but only 175 KB at q85 — ~86% of the data discarded.
        # JPEG spends its bit budget on flat areas and destroys fine high-frequency
        # detail first, which is exactly what these prompts deliberately ask for (visible
        # pores, peach-fuzz, sensor grain, skin texture — see SKIN_TEX / IMPERFECT in
        # ui/src/lib/quickPrompt.ts). Users reported precisely this: a freshly generated
        # image downloads sharp (the browser still holds OpenAI's original PNG) while the
        # same image re-downloaded from the gallery looks smeared — the difference IS
        # this re-encode. Together with the 4:4:4 chroma now written by sanitize_image,
        # a scene goes 175 KB → ~335 KB; going further (q100 = 688 KB at 4:4:4, lossless
        # PNG = 1.242 KB) buys nothing a viewer can see.
        with ThreadPoolExecutor(max_workers=min(len(valid), 8)) as pool:
            urls = list(pool.map(
                lambda b64: upload_character_image_to_seaweedfs(
                    b64, subfolder=subfolder, sanitize=True, sanitize_quality=95,
                    sanitize_max_edge=MEDIA_MAX_EDGE,
                ),
                valid,
            ))
        return [{'url': url, 'created_at': now_iso} for url in urls]

    @action(detail=True, methods=['post'], url_path='add-media')
    def add_media(self, request, pk=None):
        """Append more images to an existing character: ``media`` (face-swapped
        results) and/or ``scenes`` (raw generated scenes), each a base64 list."""
        from django.utils import timezone

        character = self.get_object()
        media_b64_list = request.data.get('media') or []
        scenes_b64_list = request.data.get('scenes') or []
        if not isinstance(media_b64_list, list) or not isinstance(scenes_b64_list, list):
            return Response({'detail': 'media and scenes must be lists.'}, status=status.HTTP_400_BAD_REQUEST)
        if not media_b64_list and not scenes_b64_list:
            return Response({'detail': 'Nothing to add.'}, status=status.HTTP_400_BAD_REQUEST)

        now_iso = timezone.now().isoformat()
        new_media = self._upload_media_items(media_b64_list, 'media', now_iso)
        new_scenes = self._upload_media_items(scenes_b64_list, 'scenes', now_iso)

        # Lock the row only for the read-modify-write below — uploads above (can
        # take a while: base64 decode + PIL sanitize + network PUT per image)
        # already ran outside the lock. Without this, two concurrent add-media
        # calls for the SAME character (e.g. two browser tabs, or a retried
        # request racing the original) each read the pre-upload media/scenes
        # list, append their own items, and save — whichever save lands second
        # silently overwrites the first's appended images (lost update).
        with transaction.atomic():
            character = Character.objects.select_for_update().get(pk=character.pk)
            character.media = (character.media or []) + new_media
            character.scenes = (character.scenes or []) + new_scenes
            character.save(update_fields=['media', 'scenes', 'updated_at'])
        return Response(CharacterSerializer(character).data)

    @action(detail=True, methods=['post'], url_path='hide-media')
    def hide_media(self, request, pk=None):
        """Ẩn / bỏ ẩn MỘT ảnh trong ``media`` hoặc ``scenes`` của nhân vật.

        Body: ``{url, kind: "media"|"scenes", hidden?: bool}`` (``hidden`` mặc
        định True = ẩn; gửi False để bỏ ẩn).

        Không xoá ảnh — chỉ gắn cờ ``hidden`` lên item (giống soft-delete cấp
        nhân vật): file trên storage và bản ghi vẫn được giữ, nhưng
        ``CharacterSerializer`` lọc bỏ item ``hidden`` khỏi mọi nơi hiển thị và
        khỏi việc chọn ảnh để đăng.

        Item được định vị theo url: so khớp trên (host, path) — bỏ qua query
        string vì ảnh Cloudfly được presign (thêm ``?X-Amz-...``) khi trả về,
        nên url client cầm khác url gốc lưu trong DB.
        """
        from urllib.parse import urlparse

        character = self.get_object()
        url = (request.data.get('url') or '').strip()
        kind = (request.data.get('kind') or 'media').strip()
        hidden = request.data.get('hidden', True)
        if isinstance(hidden, str):
            hidden = hidden.strip().lower() in ('true', '1', 'yes', 'on')
        if kind not in ('media', 'scenes'):
            return Response({'detail': 'kind phải là "media" hoặc "scenes".'}, status=status.HTTP_400_BAD_REQUEST)
        if not url:
            return Response({'detail': 'url là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)

        def _key(u):
            parsed = urlparse(u or '')
            return (parsed.netloc, parsed.path)

        target = _key(url)
        items = list(getattr(character, kind) or [])
        matched = False
        for item in items:
            if isinstance(item, dict) and item.get('url') and _key(item['url']) == target:
                item['hidden'] = bool(hidden)
                matched = True
                break
        if not matched:
            return Response({'detail': 'Không tìm thấy ảnh trong nhân vật.'}, status=status.HTTP_404_NOT_FOUND)

        setattr(character, kind, items)
        character.save(update_fields=[kind, 'updated_at'])
        return Response(CharacterSerializer(character).data)

    @action(detail=True, methods=['post'], url_path='add-video')
    def add_video(self, request, pk=None):
        """Append a generated video (by URL) to the character's video store.

        Body: ``{"video_url": "https://..."}``. The URL is an external genvideo
        link (not the private S3 bucket), so it is stored and served as-is.
        """
        from django.utils import timezone

        character = self.get_object()
        video_url = (request.data.get('video_url') or '').strip()
        if not video_url:
            return Response({'detail': 'video_url is required.'}, status=status.HTTP_400_BAD_REQUEST)
        item = {'url': video_url, 'created_at': timezone.now().isoformat()}
        character.videos = (character.videos or []) + [item]
        character.save(update_fields=['videos', 'updated_at'])
        return Response(CharacterSerializer(character).data)

    @action(detail=True, methods=['post'], url_path='watch-video-task')
    def watch_video_task(self, request, pk=None):
        """Start a background poll of a genvideo task; when it finishes, the
        resulting video URL is appended to this character's ``videos`` store.
        The FE fires this and returns immediately — generation takes minutes, so
        the video just shows up in the character's gallery when ready.
        """
        character = self.get_object()
        genvideo_task_id = (request.data.get('genvideo_task_id') or '').strip()
        if not genvideo_task_id:
            return Response({'detail': 'genvideo_task_id is required.'}, status=status.HTTP_400_BAD_REQUEST)
        from .video_poll import start_character_video_poll
        start_character_video_poll(genvideo_task_id, character.id)
        return Response(
            {'status': 'watching', 'genvideo_task_id': genvideo_task_id},
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['post'], url_path='suggest-scene-prompts')
    def suggest_scene_prompts(self, request, pk=None):
        """AI-generate a few cinematic scene-video prompts for this character.

        Used by the "video hoạt cảnh" flow: the prompt drives genvideo
        ``/api/script-to-video``. Body: ``{"size": "youtube"|"tiktok"}`` (default
        youtube). Returns ``{"prompts": ["...", ...]}``. The client's "Tạo lại"
        button just calls this again for a fresh set (temperature is high).
        """
        character = self.get_object()
        size = (request.data.get('size') or 'youtube').strip().lower()
        if size not in ('tiktok', 'youtube'):
            size = 'youtube'
        orientation = 'vertical 9:16' if size == 'tiktok' else 'horizontal 16:9'
        topic = (request.data.get('topic') or '').strip()
        if not topic:
            return Response(
                {'detail': 'Hãy nhập chủ đề để tạo gợi ý prompt.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_key = ai_tenant.openai_key_for(request.user, purpose='gợi-ý-prompt-video')
        if not api_key:
            return Response(
                {'detail': ai_tenant.missing_key_detail(request.user)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        subject = (character.name or '').strip() or 'the person'
        system_prompt = (
            'You write prompts for an AI image-to-video generator that animates a '
            'single reference photo of a person into a short, REALISTIC cinematic '
            'clip (<=5s). '
            f'The subject is "{subject}". Target framing: {orientation}. '
            f'The video topic/theme is: "{topic}" — the prompt MUST fit this theme '
            '(environment, mood and action should match it). '
            'Return EXACTLY 1 prompt: one rich English description that specifies a '
            'wide, smooth camera arc/orbit movement around the person revealing the '
            'surrounding environment; an active parallax effect with clear depth '
            'separation between foreground subject and background; and a scene that '
            'is FULLY ALIVE — natural lighting shifts, subtle micro-movements of the '
            'subject, and gentle motion in the environment so the background feels '
            'dynamic and fully integrated with the subject (NOT a static cutout, no '
            'fake/floating look). Keep the person identity unchanged. Use 4k '
            'resolution and professional gimbal-style cinematography. '
            'Example style: "Cinematic 3D animation, applying a wide, smooth camera '
            'arc movement that orbits around the person to reveal the surrounding '
            'environment. The camera parallax effect is active, creating a clear '
            'depth separation between the subject in the foreground and the landscape '
            'or interior in the background. The scene is fully alive with natural '
            'lighting shifts, micro-movements of the subject, and subtle motion in '
            'the environment, ensuring the background is dynamic and fully integrated '
            'with the subject. 4k resolution, professional gimbal-style '
            'cinematography, immersive showcase perspective." '
            'Output ONLY a JSON array containing exactly 1 string, no extra text.'
        )

        try:
            from openai import OpenAI  # noqa: PLC0415 — lazy
            model = getattr(settings, 'OPENAI_TEXT_MODEL', None) or 'gpt-4o-mini'
            client = OpenAI(api_key=api_key, timeout=OPENAI_TEXT_TIMEOUT, max_retries=0)
            resp = client.chat.completions.create(
                model=model,
                temperature=0.9,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': f'Topic: {topic}. Generate the prompt now.'},
                ],
            )
            raw = (resp.choices[0].message.content or '').strip()
        except Exception as exc:  # noqa: BLE001
            logger.exception('suggest-scene-prompts: OpenAI failed for character %s', character.id)
            return Response({'detail': f'AI gợi ý thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)

        prompts = _parse_prompt_suggestions(raw)
        if not prompts:
            return Response({'detail': 'AI trả về rỗng.', 'raw': raw[:500]}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'prompts': prompts[:1]})

    @action(detail=True, methods=['get'], url_path='source-image')
    def source_image(self, request, pk=None):
        """Return the character's source face as a base64 data URI, fetched
        server-side from the (private) S3 bucket. The FE reuses it as the swap
        source when adding more images — avoids a CORS-blocked fetch of the
        presigned URL from the browser."""
        import base64
        # Host-aware download: Cloudfly URLs (old images, private bucket) go via
        # boto3 credentials; SeaweedFS / other public hosts (new images) are
        # fetched over plain HTTP. The old Cloudfly-only client 404s (NoSuchKey)
        # on SeaweedFS-hosted sources — exactly what broke reuse of new characters.
        from facebook.views import _download_image_bytes

        character = self.get_object()
        if not character.source_image_url:
            return Response({'detail': 'Character has no source image.'}, status=status.HTTP_404_NOT_FOUND)
        try:
            raw, _ = _download_image_bytes(character.source_image_url)
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log detail
            logger.error('source_image: download failed: %s', exc)
            return Response({'detail': 'Failed to load source image.'}, status=status.HTTP_502_BAD_GATEWAY)
        # Label the data URI by the bytes' REAL format — source images are JPEG,
        # and a mislabelled image/png is later re-sent as the images.edit reference.
        mime, _ext = _sniff_image_mime_ext(raw)
        return Response({'image': f'data:{mime};base64,{base64.b64encode(raw).decode()}'})

    @action(detail=False, methods=['post'], url_path='proxy-image')
    def proxy_image(self, request):
        """Fetch a character image URL server-side and return it as a base64 data
        URI, so the in-app editor can load a NON-CORS image (legacy Cloudfly)
        without the browser tainting the canvas (which would block export/save).

        Only needed for hosts that don't send CORS — the editor loads CORS-enabled
        images (SeaweedFS) directly and only falls back here for Cloudfly. Body:
        ``{url}``; restricted to our own storage hosts (SSRF guard). The Cloudfly
        S3 client has fail-fast timeouts so a slow fetch can't hang the worker.
        """
        import base64
        from urllib.parse import urlparse
        from facebook.views import _download_image_bytes

        url = (request.data.get('url') or '').strip()
        if not url:
            return Response({'detail': 'url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        host = urlparse(url).netloc
        allowed = {
            urlparse(settings.CLOUDFLY_S3_ENDPOINT).netloc,
            urlparse(settings.SEAWEEDFS_PUBLIC_BASE_URL).netloc,
        }
        if host not in allowed:
            return Response({'detail': 'URL host not allowed.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            raw, _ = _download_image_bytes(url)
        except Exception as exc:  # noqa: BLE001 — surface a clean 502, log detail
            logger.error('proxy_image: download failed: %s', exc)
            return Response({'detail': 'Failed to load image.'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'image': f'data:image/png;base64,{base64.b64encode(raw).decode()}'})

    @action(detail=False, methods=['post'], url_path='change-page-image')
    def change_page_image(self, request):
        """Set a Facebook Page's avatar and/or cover from character images.

        Body: ``{fb_page_id, avatar_url?, cover_url?}`` — image URLs taken from
        the character (source / media / scenes). Avatar → ``POST /{page}/picture``;
        cover → upload an unpublished photo then ``POST /{page}`` with ``cover``.
        Needs a Page token with the right scopes (avatar: pages_read_engagement +
        pages_show_list + MANAGE task; cover: pages_manage_metadata) — a token that
        only has pages_manage_posts will get a permissions error from Graph."""
        import io as _io
        import requests as http_requests
        from facebook.models import FacebookPage
        from facebook.s3_utils import get_presigned_image_url
        from facebook.views import _download_image_bytes, _upload_unpublished_photo

        avatar_url = (request.data.get('avatar_url') or '').strip()
        cover_url = (request.data.get('cover_url') or '').strip()
        avatar_crop = request.data.get('avatar_crop') or None
        cover_crop = request.data.get('cover_crop') or None
        if not avatar_url and not cover_url:
            return Response({'detail': 'Hãy chọn ảnh đại diện hoặc ảnh bìa.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            page = FacebookPage.objects.get(id=request.data.get('fb_page_id'), owner=request.user)
        except (FacebookPage.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Facebook Page không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)
        if not page.page_token:
            return Response({'detail': 'Page chưa cấu hình page token.'}, status=status.HTTP_400_BAD_REQUEST)

        page_uid = page.page_uid or str(page.id)
        token = page.page_token
        graph = 'https://graph.facebook.com/v19.0'
        _release_db_connection()  # nhả kết nối DB trong lúc upload ảnh lên Graph (chống PoolTimeout)

        def _photo_id(image_url, crop, target):
            """Upload an unpublished photo to the page and return its media id.
            When *crop* (normalised {x,y,w,h} in 0..1) is given, the image is
            cropped server-side with Pillow, then upscaled to at least *target*
            (w, h) with LANCZOS + a light sharpen and saved as high-quality JPEG —
            so Facebook isn't handed a tiny crop it has to blow up (which looks
            blurry/pixelated)."""
            signed = get_presigned_image_url(image_url)
            if not crop:
                return _upload_unpublished_photo(page_uid, token, signed)
            from PIL import Image, ImageFilter  # noqa: PLC0415
            img_bytes, _name = _download_image_bytes(signed)
            im = Image.open(_io.BytesIO(img_bytes)).convert('RGB')
            w, h = im.size
            try:
                cx, cy = float(crop.get('x', 0)), float(crop.get('y', 0))
                cw, ch = float(crop.get('w', 1)), float(crop.get('h', 1))
            except (TypeError, ValueError, AttributeError):
                cx, cy, cw, ch = 0.0, 0.0, 1.0, 1.0
            left = max(0, min(int(cx * w), w - 1))
            top = max(0, min(int(cy * h), h - 1))
            right = max(left + 1, min(int((cx + cw) * w), w))
            bottom = max(top + 1, min(int((cy + ch) * h), h))
            im = im.crop((left, top, right, bottom))
            # Upscale a small crop to the target size so FB shows it crisp.
            tw, th = target
            if im.width < tw or im.height < th:
                im = im.resize((tw, th), Image.LANCZOS)
                im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=80, threshold=2))
            buf = _io.BytesIO()
            im.save(buf, format='JPEG', quality=95, subsampling=0)
            resp = http_requests.post(
                f'{graph}/{page_uid}/photos',
                data={'published': 'false', 'access_token': token},
                files={'source': ('crop.jpg', buf.getvalue())},
                timeout=120,
            )
            d = resp.json() if resp.content else {}
            if not resp.ok or 'error' in d or not d.get('id'):
                raise ValueError((d.get('error') or {}).get('message') or resp.text)
            return d['id']

        results: dict = {}

        if avatar_url:
            try:
                photo_id = _photo_id(avatar_url, avatar_crop, (1080, 1080))
                resp = http_requests.post(f'{graph}/{page_uid}/picture', data={'photo': photo_id, 'access_token': token}, timeout=60)
                data = resp.json() if resp.content else {}
                if (not resp.ok or 'error' in data) and not avatar_crop:
                    # Fallback (uncropped only): some pages accept a direct URL.
                    resp = http_requests.post(f'{graph}/{page_uid}/picture', data={'picture': get_presigned_image_url(avatar_url), 'access_token': token}, timeout=60)
                    data = resp.json() if resp.content else {}
                if not resp.ok or 'error' in data:
                    raise ValueError((data.get('error') or {}).get('message') or resp.text)
                results['avatar'] = {'ok': True}
            except Exception as exc:  # noqa: BLE001
                logger.warning('change_page_image avatar failed: %s', exc)
                results['avatar'] = {'ok': False, 'error': str(exc)[:300]}

        if cover_url:
            try:
                photo_id = _photo_id(cover_url, cover_crop, (1640, 624))
                resp = http_requests.post(f'{graph}/{page_uid}', data={'cover': photo_id, 'access_token': token}, timeout=60)
                data = resp.json() if resp.content else {}
                if not resp.ok or 'error' in data:
                    raise ValueError((data.get('error') or {}).get('message') or resp.text)
                results['cover'] = {'ok': True}
            except Exception as exc:  # noqa: BLE001
                logger.warning('change_page_image cover failed: %s', exc)
                results['cover'] = {'ok': False, 'error': str(exc)[:300]}

        ok_any = any(v.get('ok') for v in results.values())
        return Response({'results': results}, status=status.HTTP_200_OK if ok_any else status.HTTP_400_BAD_REQUEST)

    @action(
        detail=False,
        methods=['post'],
        url_path='post-photos',
        parser_classes=[parsers.MultiPartParser, parsers.FormParser],
    )
    def post_photos(self, request):
        """Post a character's photos to a social platform — now or on a schedule.

        Body (multipart):
          - platform   : 'tiktok' | 'facebook_profile' | 'facebook_page' |
                         'facebook_group' (default 'tiktok')
          - media_urls : JSON list of already-hosted character-media URLs to post
          - images     : uploaded image files (optional, posted alongside media)
          - caption    : str
          - hashtags   : JSON list of strings (the leading '#' is stripped)
          - character_id : Character PK (required when scheduling)
          - scheduled_at : ISO datetime (optional). When in the future the post
                           is queued as a CharacterScheduledPost instead of fired
                           immediately.
          Target (only the one matching ``platform`` is read):
          - device_id / profile_id : TikTok (profile's bound device used if no device_id)
          - fb_profile_id          : Facebook cá nhân (device automation)
          - fb_page_id             : Facebook Page (Graph API)
          - fb_group_id            : Facebook Group (Graph API)

        Character media URLs are presigned so the device worker / Graph API can
        fetch the private-bucket objects. Dispatch is delegated to the shared
        ``_dispatch_character_post`` helper (also used by the scheduler).
        """
        import base64 as _b64
        import json
        from django.utils import timezone as dj_tz
        from django.utils.dateparse import parse_datetime
        from facebook.s3_utils import get_presigned_image_url
        from .seaweedfs_utils import upload_character_image_to_seaweedfs
        from devices.models import Device
        from profiles.models import Profile
        from facebook.models import FacebookProfile, FacebookPage, FacebookGroup

        def _as_list(raw):
            if isinstance(raw, (list, tuple)):
                return list(raw)
            try:
                parsed = json.loads(raw or '[]')
                return parsed if isinstance(parsed, list) else []
            except (ValueError, TypeError):
                return []

        platform = (request.data.get('platform') or CharacterPostPlatform.TIKTOK).strip()
        valid_platforms = {p.value for p in CharacterPostPlatform}
        if platform not in valid_platforms:
            return Response({'detail': f'Nền tảng không hỗ trợ: {platform}'}, status=status.HTTP_400_BAD_REQUEST)

        caption = (request.data.get('caption') or '').strip()
        hashtags = [str(h).strip().lstrip('#') for h in _as_list(request.data.get('hashtags')) if str(h).strip()]

        # Mọi ID đích dưới đây do CLIENT gửi lên, nên PHẢI kiểm quyền sở hữu. Bản
        # trước tra thẳng ``Model.objects.filter(id=...)``: tài khoản của một công ty
        # chỉ cần đổi số ``fb_page_id`` là đăng được bài lên Page của công ty khác,
        # hoặc đẩy tác vụ xuống điện thoại của họ (không xem được danh sách của nhau,
        # nhưng ID là số nguyên tăng dần nên đoán rất dễ). Vô hại khi cả hệ thống chỉ
        # phục vụ một khách; thành lỗ hổng ngay khi cấp tài khoản cho công ty thứ hai.
        #
        # Dùng ĐÚNG luật hiển thị của OwnedResourceMixin — của mình HOẶC được chia sẻ
        # cho team mình — nên "thấy được trong app thì đăng được", không phá luồng
        # dùng chung theo team đang chạy. (``change_page_image`` cùng file dùng
        # ``owner=request.user`` chặt hơn vì nó đổi ảnh Page, không phải đăng bài.)
        team_ids = list(
            TeamMembership.objects.filter(user=request.user).values_list('team_id', flat=True)
        )

        def _usable(model, obj_id):
            """Bản ghi ``obj_id`` nếu user được phép dùng; None nếu không, hoặc không có.

            Cố ý KHÔNG phân biệt "không tồn tại" với "không phải của bạn": phân biệt
            là xác nhận cho người ngoài biết ID đó có thật.
            """
            if not obj_id:
                return None
            return model.objects.filter(
                Q(owner=request.user) | Q(team_id__in=team_ids), id=obj_id,
            ).first()

        # ── Resolve the platform target ─────────────────────────────────────
        device = profile = fb_profile = fb_page = fb_group = None
        if platform == CharacterPostPlatform.TIKTOK:
            device = _usable(Device, request.data.get('device_id') or None)
            profile = _usable(Profile, request.data.get('profile_id') or None)
            # Thiết bị suy ra TỪ profile đã được kiểm quyền ở trên — không phải ID do
            # client gửi, nên không cần kiểm lại.
            if device is None and profile is not None:
                device = profile.device
            if device is None:
                return Response(
                    {'detail': 'Chọn thiết bị hoặc profile có gắn thiết bị để đăng '
                               '(chỉ dùng được thiết bị của bạn).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        elif platform == CharacterPostPlatform.FACEBOOK_PROFILE:
            fb_profile = _usable(FacebookProfile, request.data.get('fb_profile_id') or None)
            if fb_profile is None:
                return Response({'detail': 'Chọn Facebook cá nhân của bạn để đăng.'},
                                status=status.HTTP_400_BAD_REQUEST)
        elif platform == CharacterPostPlatform.FACEBOOK_PAGE:
            fb_page = _usable(FacebookPage, request.data.get('fb_page_id') or None)
            if fb_page is None:
                return Response({'detail': 'Chọn Facebook Page của bạn để đăng.'},
                                status=status.HTTP_400_BAD_REQUEST)
        elif platform == CharacterPostPlatform.FACEBOOK_GROUP:
            fb_group = _usable(FacebookGroup, request.data.get('fb_group_id') or None)
            if fb_group is None:
                return Response({'detail': 'Chọn Facebook Group của bạn để đăng.'},
                                status=status.HTTP_400_BAD_REQUEST)

        # ── Resolve images: keep RAW stored URLs (re-presigned at dispatch /
        # publish time) so scheduled posts never carry an expired link. ──────
        stored_urls = [str(u) for u in _as_list(request.data.get('media_urls')) if u]
        for f in request.FILES.getlist('images'):
            data_uri = f'data:{f.content_type or "image/png"};base64,{_b64.b64encode(f.read()).decode()}'
            stored_urls.append(upload_character_image_to_seaweedfs(data_uri, subfolder='posts', sanitize=True))

        if not stored_urls:
            return Response({'detail': 'Cần ít nhất 1 ảnh để đăng.'}, status=status.HTTP_400_BAD_REQUEST)

        # ── Scheduling: queue for later instead of firing now ───────────────
        scheduled_at_raw = (request.data.get('scheduled_at') or '').strip()
        scheduled_at = parse_datetime(scheduled_at_raw) if scheduled_at_raw else None
        if scheduled_at is not None and dj_tz.is_naive(scheduled_at):
            scheduled_at = dj_tz.make_aware(scheduled_at, dj_tz.get_current_timezone())

        if scheduled_at is not None and scheduled_at > dj_tz.now():
            # ``self.get_queryset()`` đã lọc theo OwnedResourceMixin — không dùng
            # ``Character.objects`` trực tiếp, vì thế là lên lịch được bài cho nhân vật
            # của công ty khác (và bài đó sẽ tự đăng sau, không ai kịp phát hiện).
            character = self.get_queryset().filter(
                id=request.data.get('character_id') or None
            ).first()
            if character is None:
                return Response(
                    {'detail': 'Thiếu character_id hợp lệ để lên lịch (chỉ lên lịch được '
                               'cho nhân vật của bạn).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            sched = CharacterScheduledPost.objects.create(
                character=character,
                platform=platform,
                image_urls=stored_urls,
                caption=caption,
                hashtags=hashtags,
                device=device,
                profile=profile,
                fb_profile=fb_profile,
                fb_page=fb_page,
                fb_group=fb_group,
                scheduled_at=scheduled_at,
                owner=request.user,
                team=character.team,
            )
            return Response(
                CharacterScheduledPostSerializer(sched).data,
                status=status.HTTP_201_CREATED,
            )

        # ── Immediate post ──────────────────────────────────────────────────
        image_urls = [get_presigned_image_url(u) for u in stored_urls]
        try:
            result = _dispatch_character_post(
                platform=platform,
                owner=request.user,
                image_urls=image_urls,
                caption=caption,
                hashtags=hashtags,
                device=device,
                profile=profile,
                fb_profile=fb_profile,
                fb_page=fb_page,
                fb_group=fb_group,
            )
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001 — surface a clean 502 to the FE
            logger.error('post_photos dispatch failed (%s): %s', platform, exc)
            return Response({'detail': f'Đăng bài thất bại: {exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(result, status=status.HTTP_201_CREATED)


class CharacterScheduledPostViewSet(viewsets.ReadOnlyModelViewSet):
    """List / inspect / cancel queued character photo-posts.

    Creation happens through ``CharacterViewSet.post_photos`` (with a future
    ``scheduled_at``). This viewset only reads and cancels; the scheduler
    poller does the publishing.
    """
    serializer_class = CharacterScheduledPostSerializer
    permission_classes = [permissions.IsAuthenticated]
    queryset = CharacterScheduledPost.objects.all().select_related(
        'character', 'device', 'profile', 'fb_profile', 'fb_page', 'fb_group',
    )

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        if not user.is_authenticated:
            return qs.none()
        from teams.models import TeamMembership
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        qs = qs.filter(Q(owner=user) | Q(team_id__in=team_ids))
        character_id = self.request.query_params.get('character')
        if character_id:
            qs = qs.filter(character_id=character_id)
        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    @action(detail=True, methods=['post'], url_path='cancel')
    def cancel(self, request, pk=None):
        """Cancel a still-pending scheduled post."""
        post = self.get_object()
        if post.status != CharacterScheduledPostStatus.PENDING:
            return Response(
                {'detail': 'Chỉ huỷ được bài đang chờ (pending).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        post.status = CharacterScheduledPostStatus.CANCELLED
        post.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(post).data)
