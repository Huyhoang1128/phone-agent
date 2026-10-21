"""Image provenance utilities (research / audit instruments).

Two capabilities, kept dependency-light so they run inside the backend
container with nothing beyond Pillow (no ``exiftool``, no ``c2pa`` SDK):

1. :func:`sanitize_image` — re-encode an image through Pillow. Decoding then
   re-encoding rebuilds the pixels into a *fresh* container, so EXIF / XMP /
   IPTC side-cars and any embedded C2PA manifest are dropped (Pillow's default
   ``save`` carries none of them). This is the metadata-normalisation step:
   privacy-wise it strips GPS / device EXIF; as a side effect it also strips
   container-level AI-provenance markers.

2. :func:`detect_provenance` — scan the raw bytes for the container-level
   provenance markers the audit cares about (XMP / IPTC ``DigitalSourceType``,
   an embedded C2PA / JUMBF manifest, presence of an EXIF block). Pure byte
   scanning — no external tools, no network.

Limitations (read before interpreting results): this only sees CONTAINER-level
markers. It CANNOT detect invisible pixel watermarks (e.g. Google SynthID) or a
platform's server-side ML classifier. A "clean" result here is therefore
*necessary but not sufficient* evidence that a platform would not flag the
image — confirm with an actual, ethically-run upload test. Use on your own /
synthetic content for robustness research only; this is a measurement
instrument, not a laundering service.
"""
from __future__ import annotations

import io

from PIL import Image

# IPTC ``DigitalSourceType`` URIs/values that denote AI / synthetic origin.
_AI_SOURCE_TYPES = (
    b'trainedAlgorithmicMedia',
    b'compositeWithTrainedAlgorithmicMedia',
    b'algorithmicMedia',
    b'compositeSynthetic',
)
_DIGITAL_SOURCE_TYPE = b'DigitalSourceType'
# JUMBF box label / strings that wrap a C2PA manifest store.
_C2PA_HINTS = (b'jumbf', b'c2pa')
_C2PA_ACTION = b'c2pa.actions'
_EXIF_MARKER = b'Exif\x00\x00'

# Pillow format -> (s3 content-type, file extension).
_FORMAT_META = {
    'JPEG': ('image/jpeg', 'jpg'),
    'PNG': ('image/png', 'png'),
    'WEBP': ('image/webp', 'webp'),
}


def format_meta(fmt: str) -> tuple[str, str]:
    """Return ``(content_type, extension)`` for a Pillow format name."""
    try:
        return _FORMAT_META[fmt.upper()]
    except KeyError as exc:
        raise ValueError(f'Unsupported sanitize format: {fmt!r}') from exc


def sanitize_image(
    raw: bytes,
    fmt: str = 'JPEG',
    quality: int = 95,
    max_edge: int | None = None,
) -> bytes:
    """Return re-encoded image bytes with all container metadata dropped.

    Decoding then re-encoding via Pillow rebuilds the file without EXIF / XMP /
    IPTC or any embedded C2PA manifest. ``fmt`` is a Pillow format name
    (``'JPEG'``, ``'PNG'`` or ``'WEBP'``). ``quality`` applies to lossy formats.
    ``max_edge`` optionally downscales the longest side, preserving aspect ratio
    (mimics a platform that resizes large uploads).

    JPEG is written with chroma subsampling DISABLED (4:4:4). Pillow's default
    (4:2:0) throws away three quarters of the colour resolution, which lands
    hardest on exactly what these images are: faces. Lips, blush, eye rims and
    the red/blue shifts inside skin all bleed and smear under 4:2:0. Measured on
    a real 1024x1024 scene, 4:4:4 costs ~60 KB more than the default at q95
    (276 → 335 KB) yet keeps more real colour detail than q100 at 4:2:0 (469 KB)
    — a better picture AND a smaller file, so this is not a quality/size tradeoff
    that needs a knob.
    """
    im = Image.open(io.BytesIO(raw))
    fmt = fmt.upper()
    if fmt in ('JPEG', 'WEBP'):
        im = im.convert('RGB')

    if max_edge:
        w, h = im.size
        longest = max(w, h)
        if longest > max_edge:
            scale = max_edge / longest
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    out = io.BytesIO()
    save_kwargs: dict = {}
    if fmt in ('JPEG', 'WEBP'):
        save_kwargs['quality'] = quality
    if fmt == 'JPEG':
        save_kwargs['subsampling'] = 0  # 4:4:4 — see docstring
    # NB: no exif= / xmp= keyword is passed, so the new container carries none of
    # the source metadata — this is the whole point.
    im.save(out, fmt, **save_kwargs)
    return out.getvalue()


# Instagram-style colour filters exposed to the UI (provided by ``pilgram``).
# Allow-listed so an ``apply_filter`` request can only ever reach a known filter
# function, never an arbitrary module attribute.
FILTERS = (
    '_1977', 'aden', 'brannan', 'brooklyn', 'clarendon', 'earlybird', 'gingham',
    'hudson', 'inkwell', 'kelvin', 'lark', 'lofi', 'maven', 'mayfair', 'moon',
    'nashville', 'perpetua', 'reyes', 'rise', 'slumber', 'stinson', 'toaster',
    'valencia', 'walden', 'willow', 'xpro2',
)


def apply_filter(raw: bytes, name: str, fmt: str = 'JPEG', quality: int = 95,
                 max_edge: int | None = None) -> bytes:
    """Apply an Instagram-style ``pilgram`` colour filter; return re-encoded bytes.

    ``name`` must be one of :data:`FILTERS`. The image is flattened to RGB and
    re-saved through Pillow (same metadata-free container as
    :func:`sanitize_image`). Raises ``ValueError`` for an unknown filter and
    ``ImportError`` if ``pilgram`` is not installed — it is an optional dependency
    imported lazily so this module still loads without it.

    ``max_edge`` downscales the longest side FIRST, before pilgram runs — it
    exists for the picker's filter strip, which needs 13 small previews rather
    than 13 full-size images. Measured on a real scene: a 1024x1536 image filtered
    at max_edge=260 comes back as 173x260 / ~37 KB in ~200 ms, versus ~576 KB for
    the full size (~35x less pixel work). That is what lets all 13 filters in the
    strip load at once instead of one-per-click.
    """
    if name not in FILTERS:
        raise ValueError(f'Unknown filter: {name!r}')
    import pilgram  # noqa: PLC0415 — optional dep, imported lazily

    fmt = fmt.upper()
    im = Image.open(io.BytesIO(raw)).convert('RGB')
    if max_edge:
        w, h = im.size
        longest = max(w, h)
        if longest > max_edge:
            scale = max_edge / longest
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    im = getattr(pilgram, name)(im)
    out = io.BytesIO()
    save_kwargs: dict = {'quality': quality} if fmt in ('JPEG', 'WEBP') else {}
    im.save(out, fmt, **save_kwargs)
    return out.getvalue()


def detect_provenance(raw: bytes) -> dict:
    """Scan raw image bytes for container-level provenance markers.

    Returns a dict with boolean flags:

    * ``xmp_ai``  — an XMP / IPTC ``DigitalSourceType`` marks the image as AI.
    * ``c2pa``    — an embedded C2PA / JUMBF manifest appears to be present.
    * ``exif``    — an EXIF block is present.
    * ``any``     — convenience: at least one provenance marker was found.

    This is a heuristic byte scan, robust enough for survival measurement; it
    does NOT cryptographically validate the C2PA manifest. For a rigorous
    offline check pair it with the ``c2pa`` SDK.
    """
    has_xmp_ai = _DIGITAL_SOURCE_TYPE in raw and any(t in raw for t in _AI_SOURCE_TYPES)
    has_c2pa = _C2PA_ACTION in raw and any(h in raw for h in _C2PA_HINTS)
    has_exif = _EXIF_MARKER in raw
    return {
        'xmp_ai': bool(has_xmp_ai),
        'c2pa': bool(has_c2pa),
        'exif': bool(has_exif),
        'any': bool(has_xmp_ai or has_c2pa or has_exif),
    }
