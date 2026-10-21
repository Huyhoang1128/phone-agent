"""fal.ai image generation — the two extra models the "Tạo ảnh nhanh" flow offers
besides OpenAI's gpt-image: **Seedream v4.5** and **Grok Imagine**.

Ported from the mika-lab bench (``mika-lab/providers.py``): ONE fal key
(``settings.FAL_KEY`` ← env ``FAL_KEY``) drives both. A reference face routes to the
model's ``/edit`` endpoint so the result keeps that person; otherwise it runs
text-to-image. The endpoint's existing OpenAI ``size`` string ('WIDTHxHEIGHT')
is mapped to whichever frame arg each model wants, so no new size param is needed.

Kept DRF-free (like ``image_utils`` / ``s3_utils``): ``fal_generate_image`` returns
``(image_b64, error_message)`` and the view maps the error to a ``Response``. The
``fal_client`` import is lazy so a server without the dependency still boots.
"""
from __future__ import annotations

import base64
import logging
import time
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

# model_key → {label, t2i, edit, frame}. ``frame`` is which arg controls the shape:
# Seedream takes an ``image_size`` {width,height}; Grok takes an ``aspect_ratio``.
# Slugs verified against fal.ai in the mika-lab bench (both keep the reference face
# via their /edit endpoint).
FAL_MODELS = {
    'seedream45': {
        'label': 'Seedream v4.5',
        't2i': 'fal-ai/bytedance/seedream/v4.5/text-to-image',
        'edit': 'fal-ai/bytedance/seedream/v4.5/edit',
        'frame': 'image_size',
        # Resolution scales the {width,height} for the chosen ratio (px long edge).
        'resolutions': ('1K', '2K', '2.3K'),
        'res_default': '2K',
    },
    'grok': {
        'label': 'Grok Imagine',
        't2i': 'xai/grok-imagine-image',
        'edit': 'xai/grok-imagine-image/edit',
        'frame': 'aspect_ratio',
        # Grok takes a native 'resolution' string alongside aspect_ratio.
        'resolutions': ('1k', '2k'),
        'res_default': '1k',
    },
}

# The three OpenAI sizes (``content.views.OPENAI_IMAGE_SIZES``) → an aspect ratio.
# The endpoint's existing ``size`` param carries the RATIO; the per-model
# ``resolution`` knob carries the scale, mirroring the mika-lab bench.
_SIZE_TO_ASPECT = {'1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2'}

# Ratio (w:h) and resolution target (longest edge, px) → an explicit {width,height}
# for the ``image_size`` models (Seedream). Same as the bench's playground mapping.
_RATIOS = {'1:1': (1, 1), '2:3': (2, 3), '3:2': (3, 2)}
_RES_PX = {'1K': 1024, '2K': 2048, '2.3K': 2304}


def is_fal_model(model_key) -> bool:
    return model_key in FAL_MODELS


def fal_model_label(model_key) -> str:
    spec = FAL_MODELS.get(model_key)
    return spec['label'] if spec else str(model_key)


def _image_size_wh(ratio: str, res: str, max_area: int = 4194304, max_edge: int = 2560) -> dict:
    """Ratio + resolution → {width,height}, clamped to fal's limits (multiple of 16,
    edges ≤2560, area ≤ ~4.2MP). Ported from ``mika-lab/providers.image_size_wh``."""
    rw, rh = _RATIOS.get(ratio, (2, 3))
    long_edge = _RES_PX.get(res, 1024)
    if rw >= rh:
        w, h = float(long_edge), long_edge * rh / rw
    else:
        w, h = long_edge * rw / rh, float(long_edge)
    if w * h > max_area:
        f = (max_area / (w * h)) ** 0.5
        w, h = w * f, h * f
    m = max(w, h)
    if m > max_edge:
        f = max_edge / m
        w, h = w * f, h * f
    r16 = lambda x: max(256, int(round(x / 16)) * 16)  # noqa: E731
    return {'width': r16(w), 'height': r16(h)}


def _frame_args(model_key: str, size: str, resolution=None) -> dict:
    """The frame + resolution args for ``model_key``: ``size`` gives the ratio, the
    per-model ``resolution`` (falling back to the model default) gives the scale."""
    spec = FAL_MODELS[model_key]
    ratio = _SIZE_TO_ASPECT.get(size, '2:3')
    if spec['frame'] == 'aspect_ratio':
        res = resolution if resolution in spec['resolutions'] else spec['res_default']
        return {'aspect_ratio': ratio, 'resolution': res}
    res = resolution if resolution in _RES_PX else spec['res_default']
    return {'image_size': _image_size_wh(ratio, res)}


def _b64_to_bytes(value) -> bytes:
    """Decode base64 tolerantly (strip data-URI, drop whitespace, re-pad) — same
    normalisation as ``ContentViewSet._safe_b64decode``."""
    data = str(value or '')
    data = data.split(',', 1)[-1] if data.startswith('data:') else data
    data = ''.join(data.split())
    data += '=' * (-len(data) % 4)
    return base64.b64decode(data)


def _is_content_policy(text: str) -> bool:
    low = (text or '').lower()
    return ('content_policy' in low or 'content checker' in low
            or 'flagged by a content' in low or 'content moderation' in low)


def _first_image_url(result):
    """fal image apps return {"images":[{"url":…}]} or {"image":{"url":…}}, a few a
    bare url string. Cover the common shapes."""
    if not isinstance(result, dict):
        return None
    for key in ('images', 'image'):
        val = result.get(key)
        if isinstance(val, list) and val:
            val = val[0]
        if isinstance(val, dict) and val.get('url'):
            return val['url']
        if isinstance(val, str) and val.startswith('http'):
            return val
    return None


def _download(url: str, timeout: float = 60.0) -> bytes:
    if url.startswith('data:'):
        return base64.b64decode(url.split(',', 1)[1])
    req = urllib.request.Request(url, headers={'User-Agent': 'mobile-control'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fal_generate_image(prompt, model_key, reference_b64=None, size='1024x1536',
                       resolution=None, api_key=None):
    """Render one image via fal → ``(image_b64, None)`` or ``(None, error_message)``.

    ``reference_b64`` may be a single base64 / data-URI string or a list; when
    present (and the model has an ``/edit`` endpoint) the call keeps that face.
    ``resolution`` is the model's own scale knob (Seedream '1K'/'2K'/'2.3K', Grok
    '1k'/'2k'); an unknown/absent value falls back to the model default. Never
    raises for an expected failure — the caller turns the message into a
    ``Response``. A content-policy rejection fails fast (no retry).

    ``api_key`` là key fal của CÔNG TY gọi request này (xem ``content.ai_tenant``).
    Bỏ trống thì rơi về ``settings.FAL_KEY`` — giữ tương thích cho các caller cũ.
    """
    api_key = (api_key or getattr(settings, 'FAL_KEY', '') or '').strip()
    if not api_key:
        return None, 'Dịch vụ fal.ai chưa được cấu hình (thiếu FAL_KEY).'
    spec = FAL_MODELS.get(model_key)
    if not spec:
        return None, f'Model fal không hợp lệ: {model_key!r}.'

    try:
        import fal_client  # noqa: PLC0415 — lazy, like `from openai import OpenAI`
    except ImportError:
        return None, 'Thư viện fal-client chưa được cài trên server.'

    # Key đi qua CLIENT RIÊNG của lời gọi này, KHÔNG qua os.environ['FAL_KEY'].
    # Bản trước set biến môi trường của cả tiến trình: với một key duy nhất thì vô
    # hại, nhưng khi mỗi công ty một key thì hai request song song ghi đè key của
    # nhau — công ty A đang chạy, request công ty B set key B, rồi A gọi fal và bị
    # TÍNH TIỀN SANG CÔNG TY B. Sai tiền một cách im lặng, không log nào bắt được.
    client = fal_client.SyncClient(key=api_key)
    label = spec['label']

    # References → upload → image_urls; a model with an /edit endpoint uses it.
    refs = reference_b64 if isinstance(reference_b64, (list, tuple)) else ([reference_b64] if reference_b64 else [])
    refs = [r for r in refs if r]
    ref_arg = {}
    endpoint = spec['t2i']
    if refs and spec.get('edit'):
        endpoint = spec['edit']
        try:
            ref_arg = {'image_urls': [client.upload(_b64_to_bytes(r), 'image/png') for r in refs]}
        except Exception as exc:  # noqa: BLE001
            logger.exception('fal upload failed')
            return None, f'{label}: tải ảnh tham chiếu lên fal thất bại: {str(exc)[:200]}'

    timeout = float(getattr(settings, 'FAL_IMAGE_TIMEOUT', 180) or 180)
    base = {'prompt': prompt, **ref_arg}
    full = {**base, **_frame_args(model_key, size, resolution)}
    reduced = dict(base)  # retry without the frame/resolution args if full is rejected
    attempts = [full] + ([reduced] if reduced != full else [])

    t0 = time.monotonic()
    last_err = None
    for args in attempts:
        try:
            result = client.subscribe(endpoint, arguments=args, with_logs=False, client_timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            text = str(exc)
            logger.warning('fal %s failed: %s', endpoint, text[:300])
            if _is_content_policy(text):
                return None, (f'{label}: bị bộ lọc nội dung từ chối (content policy). '
                              'Thử đổi mô tả hoặc chọn model khác.')
            last_err = f'{label} lỗi: {text[:200]}'
            continue
        url = _first_image_url(result)
        if not url:
            last_err = f'{label} không trả về ảnh.'
            continue
        try:
            raw = _download(url)
        except Exception as exc:  # noqa: BLE001
            return None, f'{label}: tải ảnh kết quả từ fal thất bại: {str(exc)[:200]}'
        logger.info('fal image %s in %dms (reference=%s)', endpoint,
                    int((time.monotonic() - t0) * 1000), bool(refs))
        return base64.b64encode(raw).decode(), None
    return None, last_err or f'{label}: lỗi không rõ.'
