"""AI Scenario v3 — Django views (11 endpoints MVP).

Endpoints (xem doc §13):

  POST   /api/content-scenarios/preview-intent/   Layer 1+2 (extract + parse) → IntentJSON preview
  POST   /api/content-scenarios/generate/         Layer 1+2+3 → ScenarioJSON (chưa lưu DB)
  POST   /api/content-scenarios/save/             Lưu ScenarioJSON → DB + audit 'generate'
  GET    /api/content-scenarios/                  List (anti-IDOR qua OwnedResourceMixin)
  GET    /api/content-scenarios/{id}/             Detail
  PATCH  /api/content-scenarios/{id}/             Update title/brief metadata
  DELETE /api/content-scenarios/{id}/
  PATCH  /api/content-scenarios/{id}/update-shot/        Update 1 shot + audit
  PATCH  /api/content-scenarios/{id}/update-character/   Update 1 character + audit
  PATCH  /api/content-scenarios/{id}/restore-shot/       Restore 1 shot từ origin_data
  PATCH  /api/content-scenarios/{id}/restore-all/        Restore cả scenario
  GET    /api/content-scenarios/{id}/audits/             Audit log
  GET/POST /api/content-scenarios/{id}/script-chat/      DB-backed chat refine
  POST   /api/content-scenarios/preview-script-chat/     Stateless chat (cho draft page)
  GET/POST /api/content-scenarios/brand-prompt/          Team brand voice (Cách C Lớp 2)

Mỗi action có throttle scope riêng (xem settings.py DEFAULT_THROTTLE_RATES).
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
from typing import Any

import requests
from django.conf import settings
from django.db import transaction
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from content.models import FeatureSystemPrompt
from mbcontrol.mixins import OwnedResourceMixin

from django.utils import timezone

import time  # v3.2.2 Phase 1 — telemetry duration tracking

from .models import (
    ApprovalStatus,
    AuditAction,
    ChatSender,
    ContentScenario,
    ContentScenarioAuditLog,
    ContentScenarioChatMessage,
    ContentScenarioPendingApproval,
    ContentScenarioPlan,    # v3.2.2 Phase 2
    ContentScenarioShot,
    ContinuityMode,
    PlanStatus,             # v3.2.2 Phase 2
    ScenarioGenre,
)
from .serializers import (
    ContentScenarioAuditLogSerializer,
    ContentScenarioChatMessageSerializer,
    ContentScenarioListSerializer,
    ContentScenarioSerializer,
    ContentScenarioShotSerializer,
)

logger = logging.getLogger(__name__)


# ─── Constants ───────────────────────────────────────────────────────────────

MAX_UPLOAD_BYTES = 10 * 1024 * 1024            # OQ3: 10 MB
MAX_BRIEF_CHARS = 4000
MAX_RAW_TEXT_CHARS = 50_000                     # Layer 1 truncate cap
MAX_INTENT_RAW_TRUNCATE = 2_000                 # Layer 2 raw_truncated field

AGENT_TEAMS_TIMEOUT_SECONDS = 300
# T37 — TTL backstop cho khóa chống stream-trùng (nhả chủ động ở finally; TTL chỉ phòng crash).
SCN_CHAT_LOCK_TTL_SECONDS = AGENT_TEAMS_TIMEOUT_SECONDS + 30

ALLOWED_UPLOAD_EXT = {'.xlsx', '.docx', '.pdf', '.txt'}

VOICE_OVER_WORD_WARN_THRESHOLD = 30              # OQ7: ≥30 từ → soft warning

FEATURE_BRAND_PROMPT_ID = 'ai_scenario_v3'

# v3.2 — Memory cache cho preview_intent (Chốt #15 v3.2, OQ5 deferred from v3.1)
# Cache `hash(file_bytes)+hash(brief)` → IntentJSON, TTL 1h. In-process only.
# v3.3+ có thể nâng cấp lên Redis cho multi-instance.
_INTENT_CACHE: dict[str, tuple[float, dict]] = {}
_INTENT_CACHE_TTL_SEC = 3600
_INTENT_CACHE_MAX_ENTRIES = 200  # cap để tránh memory leak nếu user spam


def _intent_cache_key(raw_text: str, brief: str) -> str:
    import hashlib
    h = hashlib.sha256()
    h.update(raw_text.encode('utf-8', errors='replace'))
    h.update(b'||')
    h.update(brief.encode('utf-8', errors='replace'))
    return h.hexdigest()


def _intent_cache_get(key: str) -> dict | None:
    import time
    entry = _INTENT_CACHE.get(key)
    if not entry:
        return None
    ts, data = entry
    if time.time() - ts > _INTENT_CACHE_TTL_SEC:
        _INTENT_CACHE.pop(key, None)
        return None
    return data


def _intent_cache_set(key: str, data: dict) -> None:
    import time
    # Evict oldest nếu quá size
    if len(_INTENT_CACHE) >= _INTENT_CACHE_MAX_ENTRIES:
        oldest = min(_INTENT_CACHE.items(), key=lambda kv: kv[1][0])[0]
        _INTENT_CACHE.pop(oldest, None)
    _INTENT_CACHE[key] = (time.time(), data)

# Lớp 3 fallback brand voice (Q14 Chốt #10).
# v3.2.1 BUG FIX — trước đây hard-code "Dr Đình Khanh / phòng khám thẩm mỹ"
# làm AI BIAS toward 1 clinic bất kể brief (vd brief "lợi ích trái cây" vẫn
# kết CTA bằng "Logo phòng khám Dr Đình Khanh"). Giờ generic — brand cụ thể
# PHẢI đến từ Lớp 1 (per-request brand_override) hoặc Lớp 2 (FeatureSystemPrompt
# per-user/team). Lớp 3 này CHỈ là safety net khi cả 2 lớp trên trống.
DEFAULT_BRAND_PROMPT = (
    'Brand: (chưa cấu hình — dùng tone marketing chung).\n'
    'Tone: Friendly trung tính, gần gũi, phù hợp TikTok/Reels/Shorts.\n'
    'Persona target: (theo brief — KHÔNG mặc định).\n'
    'Claim quảng cáo thận trọng:\n'
    '  - KHÔNG hứa "100% hiệu quả", "tuyệt đối", "chắc chắn"\n'
    '  - Dùng "giúp", "có thể", "thường thấy"\n'
    'Brand mention: chỉ đề cập khi brief có brand cụ thể. KHÔNG bịa brand,\n'
    'KHÔNG chèn logo/thương hiệu ngoài context brief. Shot CTA cuối có thể\n'
    'để dạng generic ("Liên hệ để biết thêm chi tiết") nếu không có brand.'
)


# ─── Layer 1 — Extract Text from File ────────────────────────────────────────

def _extract_text_from_upload(file_obj) -> tuple[str, str | None]:
    """Extract raw text từ file user upload.

    Returns: (raw_text, error_message). error_message = None nếu thành công.
    Theo Chốt #12 — Parse fail soft: lỗi extract → trả ('', error_msg) thay vì raise.
    """
    if not file_obj:
        return '', None

    name = file_obj.name or ''
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_UPLOAD_EXT:
        return '', f'Format không hỗ trợ ({ext!r}). Cho phép: .xlsx/.docx/.pdf/.txt'
    if file_obj.size > MAX_UPLOAD_BYTES:
        return '', f'File quá lớn (>{MAX_UPLOAD_BYTES // (1024 * 1024)} MB)'

    try:
        file_obj.seek(0)
        data = file_obj.read()
    except Exception as exc:  # noqa: BLE001
        return '', f'Đọc file thất bại: {exc}'

    try:
        if ext == '.txt':
            text = data.decode('utf-8', errors='replace')
        elif ext == '.xlsx':
            text = _extract_xlsx(data)
        elif ext == '.docx':
            text = _extract_docx(data)
        elif ext == '.pdf':
            text = _extract_pdf(data)
        else:  # pragma: no cover — đã check ext ở trên
            return '', f'Unsupported ext {ext!r}'
    except Exception as exc:  # noqa: BLE001
        logger.warning('extract %s failed: %s', ext, exc)
        return '', f'Parse {ext} thất bại: {str(exc)[:200]}'

    return text[:MAX_RAW_TEXT_CHARS], None


def _extract_xlsx(data: bytes) -> str:
    """Extract text từ xlsx — gom tất sheet, mỗi cell 1 dòng."""
    from openpyxl import load_workbook  # imported lazily — openpyxl đã có trong Gen Content

    wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    lines: list[str] = []
    for sheet in wb.worksheets:
        lines.append(f'[Sheet: {sheet.title}]')
        for row in sheet.iter_rows(values_only=True):
            row_text = ' | '.join(str(c) for c in row if c is not None)
            if row_text.strip():
                lines.append(row_text)
    return '\n'.join(lines)


def _extract_docx(data: bytes) -> str:
    """Extract text từ docx — chỉ paragraphs (bỏ qua image/table phức tạp)."""
    try:
        from docx import Document  # python-docx
    except ImportError as exc:
        raise RuntimeError('python-docx chưa được cài đặt') from exc

    doc = Document(io.BytesIO(data))
    return '\n'.join(p.text for p in doc.paragraphs if p.text.strip())


def _extract_pdf(data: bytes) -> str:
    """Extract text từ PDF qua pypdf."""
    import pypdf  # đã verify có sẵn

    reader = pypdf.PdfReader(io.BytesIO(data))
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            pages.append(page.extract_text() or '')
        except Exception:  # noqa: BLE001 — skip page bị lỗi
            pages.append(f'[Page {i+1}: extract failed]')
    return '\n\n'.join(pages)


# ─── agent_teams calls ───────────────────────────────────────────────────────

def _agent_teams_base() -> str | None:
    base = (getattr(settings, 'AGENT_TEAMS_URL', '') or '').rstrip('/')
    return base or None


def _agent_teams_post(path: str, payload: dict, jwt_auth: str | None,
                      timeout: int = AGENT_TEAMS_TIMEOUT_SECONDS,
                      *,
                      session_id: str = '',
                      user_id: str | int = '',
                      request_id: str = '') -> tuple[dict | None, str | None]:
    """Generic POST agent_teams + JWT forward.

    v3.2.1 Phase 2: optional session_id + user_id kwargs auto-merge vào payload.
    v3.2.1 Option 3D: optional request_id auto-merge — agent_teams orchestrator
    dùng để check_cancel signal qua Redis trước mỗi LLM call.

    Returns: (data, error_message). data is None nếu fail.
    Khi BE trả HTTP 499 (Client Closed Request — user cancel mid-pipeline),
    error message bắt đầu bằng 'CANCELLED:' để caller phân biệt với server error.
    """
    base = _agent_teams_base()
    if not base:
        return None, 'Scenario engine chưa được cấu hình.'

    # v3.2.1: chèn các identifier vào payload nếu caller cung cấp (KHÔNG ghi đè
    # nếu payload đã có sẵn).
    if session_id and 'session_id' not in payload:
        payload = {**payload, 'session_id': session_id}
    if user_id and 'user_id' not in payload:
        payload = {**payload, 'user_id': str(user_id)}
    if request_id and 'request_id' not in payload:
        payload = {**payload, 'request_id': request_id}

    headers = {'Content-Type': 'application/json'}
    if jwt_auth:
        headers['Authorization'] = jwt_auth

    try:
        resp = requests.post(f'{base}{path}', json=payload, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        logger.error('agent_teams %s failed: %s', path, exc)
        return None, f'Lỗi gọi engine: {str(exc)[:200]}'

    # v3.2.1 3D: phân biệt 499 (user cancel) với các lỗi khác
    if resp.status_code == 499:
        logger.info('agent_teams %s cancelled by user (request_id=%s)', path, request_id)
        return None, f'CANCELLED: {resp.text[:200]}'

    if not resp.ok:
        logger.warning('agent_teams %s returned %s: %s', path, resp.status_code, resp.text[:300])
        return None, f'Engine trả lỗi {resp.status_code}'

    try:
        return resp.json(), None
    except ValueError:
        return None, 'Engine trả về JSON không hợp lệ'


# ─── v3.2.1 Option 3D — Redis cancel signal helper ───────────────────────────

def _scenario_signal_cancel(request_id: str, ttl_seconds: int = 60) -> bool:
    """SET Redis cancel flag cho request_id. agent_teams orchestrator check key
    này trước mỗi LLM call boundary → raise ScenarioCancelled → return 499.

    Lưu ý: cùng module logic với agent-teams/utils/cancel.py (key namespace
    `scenario:cancel:{request_id}`) — phải đồng bộ nếu refactor một bên.

    Trả True nếu set OK, False nếu Redis fail (best-effort, không block).
    """
    if not request_id:
        return False
    try:
        import redis as redis_pkg  # local import — soft dep
        client = redis_pkg.from_url(
            settings.REDIS_URL,
            socket_timeout=2,
            socket_connect_timeout=2,
        )
        client.set(f'scenario:cancel:{request_id}', '1', ex=ttl_seconds)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning('[cancel] Redis signal_cancel(%s) failed: %s', request_id, exc)
        return False


# ─── Agno session ID helper (v3.2.1 Phase 2) ─────────────────────────────────

def _agno_session_id(user_id: int | None, scenario_id: int | None) -> str:
    """Deterministic Agno session ID: 1 session per (user × scenario).

    Pattern: `scenario:<user_id>:<scenario_id>`. Phải có scenario_id (positive int)
    → nếu None/0 trả '' (caller skip session injection, mất Agno memory nhưng vẫn chạy).

    Examples:
        _agno_session_id(7, 42) → 'scenario:7:42'
        _agno_session_id(None, 42) → 'scenario:anon:42'
        _agno_session_id(7, None) → '' (no scenario_id, can't isolate session)
    """
    if not scenario_id:
        return ''
    if not user_id:
        return f'scenario:anon:{scenario_id}'
    return f'scenario:{user_id}:{scenario_id}'


# ─── Chat history cho agent stateless (v5) ──────────────────────────────────

_CHAT_HISTORY_MAX_TURNS = 12       # số message gần nhất gửi kèm (≈6 lượt hỏi-đáp)
_CHAT_HISTORY_BODY_CAP = 800       # cap mỗi message tránh phình prompt


def _build_chat_history(scenario, exclude_id=None, limit: int = _CHAT_HISTORY_MAX_TURNS) -> list[dict]:
    """Trí nhớ hội thoại cho agent-teams (STATELESS — agentdb không có session table → Agno
    auto-memory NO-OP). Django (ContentScenarioChatMessage) là nguồn sự thật.

    Trả N message gần nhất (cũ→mới) dạng [{role, content}]. Với message của AI có kèm
    `structured_actions` (options/clarification) → đính các lựa chọn vào content để agent NHỚ
    chính xác nó đã đề xuất gì (giúp hiểu 'nhân vật thứ 2', 'option vừa rồi'). KHÔNG gửi
    scenario JSON ở đây (đã có scenario_context riêng) để tránh bloat.
    """
    qs = ContentScenarioChatMessage.objects.filter(scenario=scenario)
    if exclude_id is not None:
        qs = qs.exclude(id=exclude_id)
    recent = list(qs.order_by('-created_at')[:limit])
    recent.reverse()  # cũ → mới

    history: list[dict] = []
    for m in recent:
        role = 'user' if m.sender == ChatSender.USER else 'assistant'
        content = (m.body or '').strip()[:_CHAT_HISTORY_BODY_CAP]
        if role == 'assistant' and m.structured_actions:
            labels: list[str] = []
            for sa in m.structured_actions:
                if not isinstance(sa, dict):
                    continue
                for opt in (sa.get('options') or []):
                    if isinstance(opt, dict):
                        labels.append((opt.get('label') or opt.get('description') or '').strip())
                    elif opt:
                        labels.append(str(opt).strip())
            labels = [l for l in labels if l]
            if labels:
                content = (content + "\n(Các lựa chọn bạn đã đưa ra: "
                           + "; ".join(labels) + ")").strip()
        # T26 (Đợt 8) — đóng vòng Reviewer→Refiner (passive): đính cảnh báo reviewer
        # (artistic_check) đã chấm ở lượt đó vào trí nhớ, để khi user nhắc "reviewer nói X"
        # agent ĐỐI CHIẾU được (thay vì mù → user phải copy tay). Cap gọn tránh phình prompt.
        if role == 'assistant' and m.artistic_checks:
            rv_lines: list[str] = []
            for ac in m.artistic_checks:
                if not isinstance(ac, dict):
                    continue
                reviewer = (ac.get('reviewer') or 'Reviewer').strip()
                sid = ac.get('shot_id')
                warns = ac.get('warnings') or ac.get('issues') or []
                warn = warns[0] if warns else ''
                if isinstance(warn, str) and warn.strip():
                    tag = f"[shot {sid}] " if sid else ""
                    rv_lines.append(f"{reviewer} {tag}cảnh báo: {warn.strip()}")
            rv_lines = rv_lines[:4]
            if rv_lines:
                content = (content + "\n(Reviewer đã chấm ở lượt đó: "
                           + " | ".join(rv_lines) + ")").strip()
        if content:
            history.append({'role': role, 'content': content[:_CHAT_HISTORY_BODY_CAP + 600]})
    return history


# ─── Structural proposal → FE StructuredAction shape (v5.1) ─────────────────
# Brain (agent-teams) phát structural dạng {op, args, impact} (op khớp url_path Django).
# Nhưng FE `StructuredAction` union dùng kind RỜI RẠC + field PHẲNG (insert_shot/delete_shot/
# move_shot/duplicate_shot/reorder_shots) — KHÔNG có kind='structural'. Django (lớp adapter
# trong kiến trúc Brain⇄Hands) chuẩn hoá khi PERSIST để card lịch sử (ScenarioChatProposalCards)
# render + bấm Duyệt execute đúng (handler FE đọc action.after_shot_id/brief/shot_id...).
# (Live SSE Django forward verbatim → FE tự chuẩn hoá op→kind ở client; chỗ này chỉ lo persist.)
_STRUCTURAL_OP_TO_KIND = {
    'insert-shot': 'insert_shot',
    'delete-shot': 'delete_shot',
    'reorder-shots': 'reorder_shots',
    'move-shot': 'move_shot',
    'duplicate-shot': 'duplicate_shot',
}


def _structural_to_fe_action(op, args, impact) -> dict | None:
    """Map structural proposal (op/args/impact) → FE StructuredAction (kind rời rạc, field phẳng).
    Trả None nếu op không nhận diện (caller giữ shape thô để khỏi mất dữ liệu)."""
    kind = _STRUCTURAL_OP_TO_KIND.get(op)
    if not kind:
        return None
    args = args or {}
    impact = impact if impact in ('safe', 'destructive', 'expensive') else 'safe'
    fe: dict = {'kind': kind, 'requires_approval': impact != 'safe', 'data_impact_class': impact}
    if kind == 'insert_shot':
        try:
            fe['after_shot_id'] = int(args.get('after_shot_id') or 0)
        except (TypeError, ValueError):
            fe['after_shot_id'] = 0
        fe['brief'] = (args.get('brief') or '').strip()
    elif kind == 'delete_shot':
        fe['shot_id'] = args.get('shot_id')
    elif kind == 'reorder_shots':
        fe['new_order'] = args.get('new_order') or []
    elif kind == 'move_shot':
        fe['shot_id'] = args.get('shot_id')
        fe['new_position'] = args.get('new_position')
    elif kind == 'duplicate_shot':
        fe['shot_id'] = args.get('shot_id')
    return fe


# ─── Creative treatment → ContentScenarioPlan executable (T5) ───────────────
# propose_creative_treatment phát `creative_steps` (prose + affected_shot_ids) — KHÔNG phải
# tool call thực thi được. Để FE PlanCard → execute-plan chạy thật, map mỗi creative_step →
# 1 plan step `apply_shot_patch` (shot_ids=affected, brief=creative_description); lúc execute,
# `_execute_plan_step` gọi agent_teams refine từng shot theo brief. Plan lưu DB (PROPOSED),
# structured_action `plan_proposed` mang plan_id để FE gọi execute-plan.

# T15 — gợi ý "chèn cảnh mới" trong mô tả bước (khi agent quên đặt action='insert').
_INSERT_STEP_HINT = re.compile(
    r"chèn|thêm\s+(?:một\s+)?(?:phân\s+)?cảnh|cảnh\s+mới|phân\s+cảnh\s+mới|xuất\s+hiện\s+trong\s+(?:một\s+)?(?:phân\s+)?cảnh\s+mới",
    re.IGNORECASE,
)


def _create_treatment_plan(scenario, owner, treatment: dict) -> dict:
    """Tạo ContentScenarioPlan (PROPOSED) từ 1 creative treatment → trả structured_action
    `kind:'plan_proposed'` KÈM plan_id.

    T15 — mỗi creative_step map theo `action`:
      • action='insert' (hoặc tự suy ra: không có affected_shot_ids + mô tả nói 'chèn/thêm cảnh
        mới') → step `insert_shot` (after_shot_id + brief → executor sinh content thật).
      • còn lại → step `apply_shot_patch` (edit các shot bị ảnh hưởng).
    Nhờ vậy treatment 'thêm cảnh cho nhân vật + sửa cảnh khác' ra ĐỦ bước (insert + edit)."""
    goal = (treatment.get('creative_goal') or '').strip()
    analysis = (treatment.get('artistic_analysis') or '').strip()
    creative_steps = treatment.get('creative_steps') or []
    valid_ids = set(scenario.shots.values_list('shot_id', flat=True))

    steps: list[dict] = []
    for cs in creative_steps:
        if not isinstance(cs, dict):
            continue
        affected: list[int] = []
        for s in (cs.get('affected_shot_ids') or []):
            try:
                sid = int(s)
            except (TypeError, ValueError):
                continue
            if sid in valid_ids and sid not in affected:
                affected.append(sid)
        desc = (cs.get('step_goal') or cs.get('creative_description') or 'Bước sáng tạo').strip()
        brief = (cs.get('creative_description') or cs.get('step_goal') or '').strip()

        action = (cs.get('action') or '').strip().lower()
        is_insert = (action == 'insert') or (
            not action and not affected and bool(_INSERT_STEP_HINT.search(desc + ' ' + brief))
        )

        if is_insert:
            try:
                after = int(cs.get('after_shot_id') or 0)
            except (TypeError, ValueError):
                after = 0
            if after and after not in valid_ids:
                after = max(valid_ids) if valid_ids else 0  # chèn cuối nếu after lạ
            steps.append({
                'description': desc[:300],
                'tool_name': 'insert_shot',
                'tool_args_preview': {'after_shot_id': after, 'brief': brief},
                'status': 'pending', 'result': None, 'error': None,
            })
        else:
            steps.append({
                'description': desc[:300],
                'tool_name': 'apply_shot_patch',
                'tool_args_preview': {
                    'shot_ids': affected,
                    'brief': brief,
                    'fields': [],
                    'reviewer_focus': 'style',
                },
                'status': 'pending', 'result': None, 'error': None,
            })

    plan = ContentScenarioPlan.objects.create(
        scenario=scenario, owner=owner, goal=goal[:500], analysis=analysis,
        steps=steps, status=PlanStatus.PROPOSED,
    )
    return {
        'kind': 'plan_proposed',
        'plan_id': plan.id,
        'goal': goal,
        'analysis': analysis,
        'steps': steps,
        'requires_approval': False,
        'data_impact_class': 'expensive',
    }


# ─── Khử trùng đề xuất vs plan (T22) ────────────────────────────────────────

def _dedup_proposals_against_plan(patches, structured_actions):
    """T22 — gpt-4o-mini hay gọi CẢ tool lẻ (add_shot...) LẪN `propose_creative_treatment` cho
    CÙNG 1 ý → ra 2 bảng trùng (thẻ lẻ + plan), bấm duyệt cả 2 = nhân đôi. Khi 1 lượt có plan_proposed,
    BỎ các đề xuất lẻ ĐÃ NẰM trong plan, GIỮ plan làm đại diện duy nhất (1 bảng).
    Khớp: insert_shot theo (after_shot_id, brief[:80]); shot patch theo shot_id (plan apply_shot_patch)."""
    plans = [a for a in structured_actions if isinstance(a, dict) and a.get('kind') == 'plan_proposed']
    if not plans:
        return patches, structured_actions
    insert_keys, shot_ids = set(), set()
    for pl in plans:
        for st in (pl.get('steps') or []):
            tn = st.get('tool_name')
            a = st.get('tool_args_preview') or {}
            if tn == 'insert_shot':
                insert_keys.add((a.get('after_shot_id'), (a.get('brief') or '').strip()[:80]))
            elif tn == 'apply_shot_patch':
                for sid in (a.get('shot_ids') or []):
                    shot_ids.add(sid)

    def _sa_dup(a):
        return (isinstance(a, dict) and a.get('kind') == 'insert_shot'
                and (a.get('after_shot_id'), (a.get('brief') or '').strip()[:80]) in insert_keys)

    new_sa = [a for a in structured_actions
              if (isinstance(a, dict) and a.get('kind') == 'plan_proposed') or not _sa_dup(a)]
    new_patches = [p for p in patches
                   if not (isinstance(p, dict) and p.get('kind') == 'shot' and p.get('shot_id') in shot_ids)]
    return new_patches, new_sa


# ─── Chống shot mồ côi (T8) ─────────────────────────────────────────────────

def _ensure_character_registered(sc, name) -> bool:
    """Nếu một shot gán `character_in_frame = name` nhưng `name` CHƯA có trong registry →
    thêm 1 entry nhân vật tối thiểu để shot không "mồ côi" (badge 'Character không tồn tại').
    User có thể tinh chỉnh nhân vật sau. Bỏ qua tên rỗng/'None'. Trả True nếu vừa thêm."""
    name = (name or '').strip()
    if not name or name.lower() == 'none':
        return False
    registry = list(sc.character_registry or [])
    if any(isinstance(c, dict) and (c.get('name') or '').strip().lower() == name.lower()
           for c in registry):
        return False
    registry.append({
        'name': name, 'age': '', 'outfit_style': '',
        'ethnicity': 'Việt Nam', 'voice_id_hint': '',
    })
    sc.character_registry = registry
    sc.save(update_fields=['character_registry', 'updated_at'])
    return True


# ─── Lỗi engine/LLM thân thiện (T12 — báo quota/auth cho FE) ─────────────────
_ENGINE_ERR_SIGNATURES = re.compile(
    r"exceeded your current quota|resource_exhausted|insufficient_quota|"
    r"check your plan and billing|rate.?limit|too many requests|"
    r"invalid api key|incorrect api key|api key not valid|"
    r"authenticationerror|ratelimiterror|permission_denied|"
    r"error code:\s*429|\b429\b|\b401\b|\b403\b",
    re.IGNORECASE,
)


def _is_quota_error(source) -> bool:
    """True nếu chuỗi lỗi trông như quota/429/rate-limit/auth của nhà cung cấp LLM."""
    return bool(source and _ENGINE_ERR_SIGNATURES.search(str(source)))


def _friendly_engine_error(source) -> dict:
    """Phân loại lỗi engine/LLM → {code, message, detail} (cùng contract với agent-teams SSE).
    FE đọc `code` để hiển thị thông báo 'hết hạn mức' thân thiện thay vì lỗi tiếng Anh."""
    s = str(source or "")
    low = s.lower()
    if "quota" in low or "resource_exhausted" in low or "insufficient_quota" in low or "billing" in low:
        code, message = "quota_exceeded", (
            "Hệ thống AI đã hết hạn mức sử dụng (quota) tạm thời. "
            "Vui lòng thử lại sau ít phút, hoặc liên hệ quản trị để nâng hạn mức."
        )
    elif ("rate" in low and "limit" in low) or "too many requests" in low:
        code, message = "rate_limited", (
            "Bạn đang gửi yêu cầu quá nhanh. Vui lòng chờ một lát rồi thử lại."
        )
    elif "api key" in low or "authentication" in low or "permission_denied" in low or " 401" in low or " 403" in low:
        code, message = "auth_error", (
            "Cấu hình khóa AI không hợp lệ hoặc thiếu quyền. Vui lòng liên hệ quản trị."
        )
    else:
        code, message = "engine_error", "Hệ thống AI gặp sự cố tạm thời. Vui lòng thử lại."
    return {"code": code, "message": message, "detail": s[:300]}


# ─── Brand voice 3-lớp fallback (Chốt #10) ───────────────────────────────────

def _resolve_brand_prompt(user, override_text: str | None) -> str:
    """3-lớp fallback: user override → team FeatureSystemPrompt → hard-code."""
    if override_text and override_text.strip():
        return override_text.strip()[:4000]

    # Lớp 2: per-user override trong FeatureSystemPrompt. v3.2 sẽ thêm team-level
    # khi FeatureSystemPrompt thêm field `team` (cascading change, không làm MVP).
    if user.is_authenticated:
        prompt = FeatureSystemPrompt.objects.filter(
            feature_id=FEATURE_BRAND_PROMPT_ID, user=user,
        ).order_by('-updated_at').first()
        if prompt and prompt.system_prompt.strip():
            return prompt.system_prompt.strip()

    # Lớp 3 fallback
    return DEFAULT_BRAND_PROMPT


# ─── Chat refine: 2 tool function calling + sticky context ───────────────────

# NOTE v3.2.2: tool description nhấn mạnh GỘP các thay đổi cùng shot vào 1 call —
# tránh AI tạo N patch riêng lẻ cho cùng shot_id (bug #5). Dạy AI làm đúng từ đầu.
APPLY_SHOT_PATCH_TOOL = {
    'type': 'function',
    'function': {
        'name': 'apply_shot_patch',
        'description': (
            'Đề xuất sửa 1 hoặc nhiều shot trong kịch bản. Dùng khi user yêu cầu '
            'cụ thể về 1 hoặc nhóm shot (vd "shot 3 hook mạnh hơn", "tất cả camera '
            'phải static"). KHÔNG dùng khi user hỏi mở (tư vấn thuần). '
            'QUAN TRỌNG: nếu cần đổi NHIỀU field của CÙNG 1 shot trong 1 turn '
            '(vd "shot 2 sửa voice + lighting + pose"), GỌI TOOL NÀY 1 LẦN DUY '
            'NHẤT với fields = nhiều field cùng lúc. KHÔNG gọi tool nhiều lần '
            'cùng shot_id — gây 3 patch trùng lặp khó manage.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'shot_ids': {
                    'type': 'array',
                    'items': {'type': 'integer'},
                    'description': 'Danh sách shot_id (logical, không phải DB pk) cần sửa.',
                },
                'fields': {
                    'type': 'array',
                    'items': {
                        'type': 'string',
                        'enum': [
                            'voice_over', 'kinetic_action', 'camera_articulation',
                            'background', 'character_pose', 'prop_description',
                            'texture_and_lighting', 'music_hint', 'funnel_part',
                        ],
                    },
                    'description': 'Field cụ thể cần sửa. Bỏ trống = sửa tất các field nội dung.',
                },
                'brief': {'type': 'string', 'description': 'Yêu cầu cụ thể.'},
                'reviewer_focus': {
                    'type': 'string',
                    'enum': ['cinematic', 'kinetic', 'continuity', 'brand', 'style'],
                    'description': 'Reviewer nào chấm sau refine. Default "style".',
                },
            },
            'required': ['shot_ids', 'brief'],
        },
    },
}

APPLY_CHARACTER_PATCH_TOOL = {
    'type': 'function',
    'function': {
        'name': 'apply_character_patch',
        'description': (
            'Đề xuất sửa thông tin nhân vật trong registry. Dùng khi user yêu cầu '
            'đổi outfit, tuổi, ethnicity... của 1 character.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'character_name': {'type': 'string'},
                'fields': {
                    'type': 'array',
                    'items': {
                        'type': 'string',
                        'enum': ['outfit_style', 'age', 'ethnicity', 'voice_id_hint'],
                    },
                },
                'brief': {'type': 'string'},
            },
            'required': ['character_name', 'brief'],
        },
    },
}

# v3.2.2 Phase 0 — fix bug #2 (xoá nhân vật "không có modal")
DELETE_CHARACTER_TOOL = {
    'type': 'function',
    'function': {
        'name': 'delete_character',
        'description': (
            'Xoá 1 nhân vật khỏi character_registry. ⚠️ DESTRUCTIVE — cần Human '
            'Approval ở UI. Tự động xử lý các shot đang dùng character này: '
            'character_in_frame sẽ được đổi sang `replace_in_shots_with` nếu user '
            'chỉ định, hoặc bỏ trống ("None") nếu không. Dùng khi user nói rõ '
            '"xoá nhân vật X", "bỏ character X". KHÔNG dùng cho yêu cầu mơ hồ.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'name': {
                    'type': 'string',
                    'description': 'Tên character cần xoá (case-insensitive match với registry).',
                },
                'replace_in_shots_with': {
                    'type': 'string',
                    'description': (
                        'Tên character thay thế ở các shot đang dùng. Để rỗng → '
                        'các shot mất character_in_frame (set "None"). Optional.'
                    ),
                },
            },
            'required': ['name'],
        },
    },
}

INSERT_SHOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'insert_shot',
        'description': (
            'Chèn 1 shot mới sau shot có shot_id chỉ định. Dùng khi user muốn thêm'
            ' shot mới (vd "thêm B-roll close-up sản phẩm giữa shot 2 và 3", "chèn'
            ' shot CTA cuối", "thêm shot transition"). AI mới sinh content cho'
            ' shot này dựa trên `brief`.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'after_shot_id': {
                    'type': 'integer',
                    'description': 'shot_id (logical) mà shot mới sẽ được chèn ngay sau. 0 = chèn ở đầu.',
                },
                'brief': {
                    'type': 'string',
                    'description': 'Mô tả shot mới để AI sinh content (vd "B-roll close-up sản phẩm xoay 360", "CTA giật gân").',
                },
            },
            'required': ['after_shot_id', 'brief'],
        },
    },
}

DELETE_SHOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'delete_shot',
        'description': (
            'Xoá 1 shot. ⚠️ DANGEROUS — cần Human Approval ở UI (BE pause). Dùng'
            ' khi user yêu cầu rõ "bỏ shot N", "xoá shot M". KHÔNG dùng khi user'
            ' chỉ chê chất lượng — đề xuất refine trước.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'shot_id': {'type': 'integer', 'description': 'shot_id (logical) cần xoá'},
            },
            'required': ['shot_id'],
        },
    },
}

REORDER_SHOTS_TOOL = {
    'type': 'function',
    'function': {
        'name': 'reorder_shots',
        'description': (
            'Đổi thứ tự shot mà KHÔNG đổi nội dung. Dùng khi user nói "đảo shot 3'
            ' và 4", "đưa CTA lên đầu", "shot Hook phải ở đầu". Anchor FK không bị'
            ' break (chỉ ảnh hưởng visual flow).'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'new_order': {
                    'type': 'array',
                    'items': {'type': 'integer'},
                    'description': 'Mảng shot_id theo thứ tự mới mong muốn. Phải chứa ĐÚNG các shot_id hiện có.',
                },
            },
            'required': ['new_order'],
        },
    },
}

OPTIMIZE_WHOLE_TOOL = {
    'type': 'function',
    'function': {
        'name': 'optimize_whole_scenario',
        'description': (
            'Chạy LẠI full 3E pipeline trên TOÀN BỘ kịch bản. ⚠️ DANGEROUS + tốn'
            ' ~30s + cost cao. Dùng khi user yêu cầu "viết lại cả kịch bản tone X",'
            ' "tối ưu toàn bộ", "thay đổi atmospherre tổng thể". KHÔNG dùng cho'
            ' sửa nhỏ 1-2 shot (dùng apply_shot_patch).'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'variant_brief': {
                    'type': 'string',
                    'description': 'Yêu cầu tone variant (vd "tone bí ẩn hơn", "cảm xúc cá nhân hơn"). Có thể rỗng nếu chỉ optimize quality.',
                },
            },
            'required': [],
        },
    },
}

ASK_CLARIFICATION_TOOL = {
    'type': 'function',
    'function': {
        'name': 'ask_clarification',
        'description': (
            'Hỏi user 1 câu NGẮN có cấu trúc khi intent CHƯA RÕ. KHÔNG bao giờ trả'
            ' "Bạn nói rõ hơn được không?" generic — luôn ĐOÁN 2-3 hướng có thể'
            ' rồi cho user pick (vd "Bạn muốn trẻ hơn theo nghĩa: (a) đổi character'
            ' 25-27 tuổi, (b) tone giọng GenZ hơn, hay (c) cả 2?"). Confidence thấp.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'question': {
                    'type': 'string',
                    'description': 'Câu hỏi cấu trúc với 2-3 lựa chọn đánh số (a)(b)(c).',
                },
            },
            'required': ['question'],
        },
    },
}

PROPOSE_OPTIONS_TOOL = {
    'type': 'function',
    'function': {
        'name': 'propose_options',
        'description': (
            'Đề xuất 2-3 hướng đánh số khi user hỏi MỞ ("shot 3 nên thế nào?", "ý'
            ' tưởng cho hook?"). KHÔNG tự ý thực hiện — chờ user pick. Sau đó user'
            ' chọn hướng N → AI sẽ gọi apply_shot_patch với brief từ hướng đã chọn.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'options': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'label': {'type': 'string', 'description': 'Tên ngắn (vd "Hướng số liệu giật")'},
                            'description': {'type': 'string', 'description': 'Mô tả 1-2 câu'},
                        },
                        'required': ['label', 'description'],
                    },
                    'description': '2-3 hướng để user chọn',
                },
                'preamble': {
                    'type': 'string',
                    'description': 'Câu giới thiệu ngắn (vd "Tôi có 3 hướng cho Hook shot 3:")',
                },
            },
            'required': ['options'],
        },
    },
}

# ─── v3.2.2 Phase 2 — Verb tools (toolset expansion) ─────────────────────────

ADD_CHARACTER_TOOL = {
    'type': 'function',
    'function': {
        'name': 'add_character',
        'description': (
            'Thêm 1 nhân vật mới vào character_registry. Dùng khi user yêu cầu '
            '"thêm nhân vật bác sĩ", "có thêm character khách hàng". AI tự sinh '
            'age/outfit_style/ethnicity/voice_id_hint khớp brief.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Tên character (duy nhất trong registry).'},
                'age': {'type': 'string', 'description': 'Tuổi (vd "30 tuổi", "25-30 tuổi").'},
                'outfit_style': {'type': 'string', 'description': 'Trang phục mô tả ngắn.'},
                'ethnicity': {'type': 'string', 'description': 'Sắc tộc (vd "Việt Nam"). Optional.'},
                'voice_id_hint': {
                    'type': 'string',
                    'description': 'Gợi ý voice ID (vd "male_vn_young", "female_vn_adult"). Optional.',
                },
            },
            'required': ['name', 'age', 'outfit_style'],
        },
    },
}

MOVE_SHOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'move_shot',
        'description': (
            'Di chuyển 1 shot tới vị trí mới (shot_order). KHÔNG đổi nội dung. '
            'Anchor FK của các shot khác sẽ giữ nguyên — chỉ visual order đổi. '
            'Dùng khi user nói "chuyển shot 5 lên trước shot 2", "move shot 3 to end".'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'shot_id': {'type': 'integer', 'description': 'shot_id (logical) cần di chuyển.'},
                'new_position': {
                    'type': 'integer',
                    'description': 'Vị trí mới (1-based shot_order). Vd 1 = đầu, 0 = giữ nguyên.',
                },
            },
            'required': ['shot_id', 'new_position'],
        },
    },
}

DUPLICATE_SHOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'duplicate_shot',
        'description': (
            'Sao chép 1 shot (tạo shot mới với content giống hệt, chèn ngay sau '
            'shot gốc). shot_id mới = max(shot_id) + 1. Dùng khi user nói "duplicate '
            'shot 3", "copy shot 5 thành 2 bản".'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'shot_id': {'type': 'integer', 'description': 'shot_id gốc cần copy.'},
            },
            'required': ['shot_id'],
        },
    },
}

BATCH_UPDATE_SHOTS_TOOL = {
    'type': 'function',
    'function': {
        'name': 'batch_update_shots',
        'description': (
            'Update nhiều shot cùng lúc (text fields). Cap N=5 chống accident. '
            'Dùng khi user nói "tất cả shot CTA voice mạnh hơn", "đổi background '
            'shot 2 và 5 sang outdoor". KHÁC apply_shot_patch (gọi agent_teams '
            'sinh content) — batch_update là update text user CHỈ ĐỊNH cụ thể, '
            'KHÔNG gen content mới.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'updates': {
                    'type': 'array',
                    'maxItems': 5,
                    'items': {
                        'type': 'object',
                        'properties': {
                            'shot_id': {'type': 'integer'},
                            'fields': {
                                'type': 'object',
                                'description': 'Dict field→giá trị mới (vd {"voice_over": "...", "camera_articulation": "..."}).',
                            },
                        },
                        'required': ['shot_id', 'fields'],
                    },
                },
            },
            'required': ['updates'],
        },
    },
}

# ─── v3.2.2 Phase 2 — Plan & Execute (multi-step coordination) ───────────────

PROPOSE_PLAN_TOOL = {
    'type': 'function',
    'function': {
        'name': 'propose_plan',
        'description': (
            'Đề xuất KẾ HOẠCH nhiều bước khi yêu cầu user PHỨC TẠP — touch >2 '
            'shot, cần coordination cross-shot, hoặc keyword "tổng thể/toàn bộ/'
            'chiều sâu/refactor". User sẽ approve plan trước khi BE execute '
            'từng step tuần tự. KHÔNG dùng cho yêu cầu đơn (1-2 field, 1 shot) '
            '— gọi tool trực tiếp.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'goal': {'type': 'string', 'description': 'Mục tiêu chung của plan (≤100 từ).'},
                'analysis': {
                    'type': 'string',
                    'description': 'Phân tích vì sao plan này phù hợp (≤150 từ).',
                },
                'steps': {
                    'type': 'array',
                    'maxItems': 10,
                    'items': {
                        'type': 'object',
                        'properties': {
                            'description': {
                                'type': 'string',
                                'description': 'Mô tả ngắn bước làm gì (≤80 từ).',
                            },
                            'tool_name': {
                                'type': 'string',
                                'enum': [
                                    'apply_shot_patch', 'apply_character_patch',
                                    'insert_shot', 'delete_shot',
                                    'add_character', 'delete_character',
                                    'move_shot', 'duplicate_shot',
                                    'batch_update_shots', 'reorder_shots',
                                ],
                                'description': 'Tool sẽ gọi ở step này.',
                            },
                            'tool_args_preview': {
                                'type': 'object',
                                'description': (
                                    'Args dự kiến cho tool. Có thể refine khi '
                                    'execute. KHÔNG bắt buộc field đầy đủ.'
                                ),
                            },
                        },
                        'required': ['description', 'tool_name'],
                    },
                },
            },
            'required': ['goal', 'steps'],
        },
    },
}

# ─── v3.2.2 Phase 1 — Read tools (no side-effect, Layer 3 retrieval pattern) ──

READ_SHOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'read_shot',
        'description': (
            'Đọc đầy đủ 14 field của 1 shot. Dùng KHI user yêu cầu sửa field '
            'của shot CHƯA có trong L2 focus (target_shots), hoặc cần xem giá '
            'trị hiện tại trước khi patch. Tránh đoán mò — đọc rồi mới sửa.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'shot_id': {'type': 'integer', 'description': 'shot_id logical (1-based, không phải DB pk).'},
            },
            'required': ['shot_id'],
        },
    },
}

READ_CHARACTER_TOOL = {
    'type': 'function',
    'function': {
        'name': 'read_character',
        'description': (
            'Đọc đầy đủ 5 field của 1 character trong registry (name, age, '
            'ethnicity, outfit_style, voice_id_hint). Dùng khi user yêu cầu '
            'sửa character CHƯA focus.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Tên character (case-insensitive).'},
            },
            'required': ['name'],
        },
    },
}

READ_SCENARIO_TOOL = {
    'type': 'function',
    'function': {
        'name': 'read_scenario',
        'description': (
            'Đọc full scenario JSON (title, genre, duration, characters đầy đủ, '
            'shots đầy đủ với mọi field). NẶNG — chỉ gọi khi cần OVERVIEW toàn '
            'kịch bản (vd "kịch bản này thế nào?", "có gì cần cải thiện?"). '
            'Đối với 1-2 shot cụ thể, dùng read_shot.'
        ),
        'parameters': {'type': 'object', 'properties': {}},
    },
}

READ_VOICE_OVERS_TOOL = {
    'type': 'function',
    'function': {
        'name': 'read_voice_overs',
        'description': (
            'Đọc voice_over đầy đủ của TẤT CẢ shot (mỗi item: shot_id, '
            'funnel_part, voice_over, word_count). Dùng khi cần SCAN consistency '
            'giọng kể cross-shot (vd "kiểm tra giọng kể có nhất quán không?").'
        ),
        'parameters': {'type': 'object', 'properties': {}},
    },
}

# ─── v3.2.2 Phase 4 hotfix — respond_with_text tool (chống Hallucinate Pattern) ──
# Cho phép AI trả text TRONG tool framework thay vì bypass tool_choice='auto'.
# Combined với force tool_choice='required' khi detect action intent → AI BẮT
# BUỘC phải chọn 1 tool, không thể trả text-only "hứa làm" mà không gọi tool.

RESPOND_WITH_TEXT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'respond_with_text',
        'description': (
            'Trả text thuần khi user HỎI/THẢO LUẬN không cần action gì (vd "vì '
            'sao hook quan trọng?", "voice over là gì?", "bạn nghĩ shot 3 thế '
            'nào?"). DÙNG khi không có yêu cầu xoá/sửa/thêm/đổi/chỉnh cụ thể. '
            'KHÔNG dùng khi user dùng động từ hành động — phải gọi tool action '
            'tương ứng (apply_shot_patch / delete_* / add_* / move_shot ...).'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'message': {
                    'type': 'string',
                    'description': 'Câu trả lời tiếng Việt, ≤150 từ, friendly.',
                },
            },
            'required': ['message'],
        },
    },
}

# ─── v3.2.2 Phase 3 — Measurable Cross-shot Scoring (scan_scenario tool) ────

SCAN_SCENARIO_TOOL = {
    'type': 'function',
    'function': {
        'name': 'scan_scenario',
        'description': (
            'Quét toàn kịch bản và chấm điểm 5 dimension: cinematic (camera + '
            'visual fidelity), kinetic (hành động), continuity (anchor + flow), '
            'brand (brand voice + medical claim), style (voice ≤5s + no-dash). '
            'Mỗi điểm 0-5. Trả strengths/weaknesses + recommendations cụ thể. '
            'Dùng khi user hỏi "kịch bản này thế nào?", "có gì cải thiện?", '
            '"chấm điểm kịch bản". Sau scan, có thể follow-up bằng propose_plan.'
        ),
        'parameters': {'type': 'object', 'properties': {}},
    },
}


def _handle_scan_scenario(scenario_dict: dict, brand_prompt: str) -> dict:
    """Gọi 1 OpenAI completion để chấm 5 dimension của scenario.

    Output JSON structured:
      {
        "scores": {"cinematic": 4.2, "kinetic": 3.5, ...},
        "strengths": ["...", "..."],
        "weaknesses": ["...", "..."],
        "recommendations": ["..."]
      }

    Total cost ~1 LLM call (~5-8s gpt-4o-mini). Simpler hơn rerun 5 Reviewer
    agents trong agent_teams (nặng + risk break).
    """
    try:
        from openai import OpenAI
    except ImportError:
        return {'error': 'OpenAI SDK chưa được cài'}
    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return {'error': 'OPENAI_API_KEY chưa cấu hình'}
    client = OpenAI(api_key=api_key)
    model = os.environ.get('SCENARIO_SCAN_MODEL', 'gpt-4o-mini')

    # Build compact scenario representation cho LLM (full nhưng ngắn)
    shots = scenario_dict.get('shots', []) or []
    chars = scenario_dict.get('character_registry', []) or []
    shots_repr = '\n'.join(
        f'Shot {s.get("shot_id")} ({s.get("funnel_part") or "?"}): '
        f'voice="{(s.get("voice_over") or "")[:120]}" · '
        f'camera="{(s.get("camera_articulation") or "")[:60]}" · '
        f'pose="{(s.get("character_pose") or "")[:60]}" · '
        f'lighting="{(s.get("texture_and_lighting") or "")[:60]}" · '
        f'continuity={s.get("continuity_mode")}'
        for s in shots
    )

    system = (
        'Bạn là Senior Scriptwriter Reviewer — chấm điểm kịch bản video '
        'marketing trên 5 dimension. Mỗi điểm 0.0-5.0 (1 chữ số thập phân).\n\n'
        f'BRAND VOICE: {brand_prompt[:400]}\n\n'
        '5 DIMENSION:\n'
        '- cinematic: camera angles + visual fidelity (variation, không lặp)\n'
        '- kinetic: hành động (1 action/shot, micro-movement, không tĩnh)\n'
        '- continuity: anchor chain valid + narrative flow (Hook→Vấn đề→...)\n'
        '- brand: bám brand voice + không medical hype + không bịa\n'
        '- style: voice_over ≤25 từ (~5s), no "-" dấu câu, friendly\n\n'
        'OUTPUT JSON đúng schema:\n'
        '{"scores": {"cinematic": 4.2, "kinetic": 3.5, "continuity": 4.8, '
        '"brand": 4.0, "style": 3.0}, "strengths": ["..."], "weaknesses": ["..."], '
        '"recommendations": ["..."]}\n'
        'KHÔNG trả markdown. KHÔNG giải thích ngoài JSON.'
    )
    user_prompt = (
        f'Title: {scenario_dict.get("title", "")} · '
        f'Genre: {scenario_dict.get("genre", "seeding")} · '
        f'{scenario_dict.get("duration_target_seconds", "?")}s · '
        f'{len(shots)} shots\n\n'
        f'CHARACTERS:\n' + '\n'.join(
            f'- {c.get("name")}: {c.get("age")} ({c.get("outfit_style")})'
            for c in chars if isinstance(c, dict)
        ) + '\n\n'
        f'SHOTS:\n{shots_repr}'
    )
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': user_prompt},
            ],
            response_format={'type': 'json_object'},
            temperature=0.3,
            max_tokens=800,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception('scan_scenario LLM failed')
        return {'error': f'LLM call thất bại: {str(exc)[:200]}'}
    try:
        result = json.loads(completion.choices[0].message.content or '{}')
    except json.JSONDecodeError:
        return {'error': 'LLM trả về JSON không hợp lệ'}
    # Validate + normalize
    scores = result.get('scores') or {}
    valid_dims = ['cinematic', 'kinetic', 'continuity', 'brand', 'style']
    norm_scores = {}
    for d in valid_dims:
        try:
            norm_scores[d] = max(0.0, min(5.0, float(scores.get(d, 0))))
        except (TypeError, ValueError):
            norm_scores[d] = 0.0
    return {
        'scores': norm_scores,
        'strengths': result.get('strengths') or [],
        'weaknesses': result.get('weaknesses') or [],
        'recommendations': result.get('recommendations') or [],
    }

# Tool registry — 18 tool (v3.2.1: 8, v3.2.2 Phase 0: +1, Phase 1: +4 read, Phase 2: +4 verb + 1 plan)
SCENARIO_TOOLS = [
    # Content tools (11 — tương ứng 11 BE endpoint)
    APPLY_SHOT_PATCH_TOOL,
    APPLY_CHARACTER_PATCH_TOOL,
    DELETE_CHARACTER_TOOL,        # v3.2.2 Phase 0 — fix bug #2
    INSERT_SHOT_TOOL,
    DELETE_SHOT_TOOL,
    REORDER_SHOTS_TOOL,
    OPTIMIZE_WHOLE_TOOL,
    ADD_CHARACTER_TOOL,           # v3.2.2 Phase 2 — verb expansion
    MOVE_SHOT_TOOL,               # v3.2.2 Phase 2
    DUPLICATE_SHOT_TOOL,          # v3.2.2 Phase 2
    BATCH_UPDATE_SHOTS_TOOL,      # v3.2.2 Phase 2
    # Plan & Execute (1 — v3.2.2 Phase 2, multi-step coordination)
    PROPOSE_PLAN_TOOL,
    # Read tools (4 — v3.2.2 Phase 1, no side-effect)
    READ_SHOT_TOOL,
    READ_CHARACTER_TOOL,
    READ_SCENARIO_TOOL,
    READ_VOICE_OVERS_TOOL,
    # Scoring tool (1 — v3.2.2 Phase 3, measurable cross-shot analysis)
    SCAN_SCENARIO_TOOL,
    # Meta tools (3 — chỉ trả text, không call BE)
    ASK_CLARIFICATION_TOOL,
    PROPOSE_OPTIONS_TOOL,
    RESPOND_WITH_TEXT_TOOL,  # v3.2.2 Phase 4 hotfix — chống Hallucinate Pattern
]

# Tool nào cần Human Approval (Phase 4) — DANGEROUS = có side-effect lớn
# v3.2.2 Phase 0: thêm delete_character (xoá nhân vật + handle char_in_frame của shot)
DANGEROUS_TOOLS = {'delete_shot', 'delete_character', 'optimize_whole_scenario', 'reorder_shots'}
META_TOOLS = {'ask_clarification', 'propose_options', 'respond_with_text'}
# v3.2.2 Phase 1 — read tools (no-side-effect, used for context retrieval)
READ_TOOLS = {'read_shot', 'read_character', 'read_scenario', 'read_voice_overs'}

# ─── v3.2.2 Phase 2 — Approval reframe: Safe / Destructive / Expensive ───────
# Thay vì "dangerous tool" (developer-centric), phân loại theo data impact:
#   SAFE        = update/insert text → auto execute, KHÔNG cần modal
#   DESTRUCTIVE = delete/replace data → cần modal confirm + diff preview
#   EXPENSIVE   = rerun pipeline LLM ~20-30s + cost cao → cần modal confirm + ETA
# FE quyết định show modal qua data_impact_class trong structured_action,
# KHÔNG còn dùng requires_approval boolean cứng (vẫn giữ cho backward compat).

IMPACT_SAFE = 'safe'
IMPACT_DESTRUCTIVE = 'destructive'
IMPACT_EXPENSIVE = 'expensive'

TOOL_IMPACT_MAP: dict[str, str] = {
    # Safe — auto execute
    'apply_shot_patch': IMPACT_SAFE,
    'apply_character_patch': IMPACT_SAFE,
    'insert_shot': IMPACT_SAFE,
    'add_character': IMPACT_SAFE,
    'move_shot': IMPACT_SAFE,           # có warning anchor break, không modal
    'duplicate_shot': IMPACT_SAFE,
    'batch_update_shots': IMPACT_SAFE,  # cap N=5 chống accident
    # Read — no-op data
    'read_shot': IMPACT_SAFE,
    'read_character': IMPACT_SAFE,
    'read_scenario': IMPACT_SAFE,
    'read_voice_overs': IMPACT_SAFE,
    # v3.2.2 Phase 3 — scoring (read-only, no side-effect, nhưng LLM call ~5-8s)
    'scan_scenario': IMPACT_SAFE,
    # Destructive — cần modal preview
    'delete_shot': IMPACT_DESTRUCTIVE,
    'delete_character': IMPACT_DESTRUCTIVE,
    'reorder_shots': IMPACT_DESTRUCTIVE,  # touch >50% có thể break nhiều anchor
    # Expensive — cần modal confirm cost
    'optimize_whole_scenario': IMPACT_EXPENSIVE,
    # Meta — chỉ trả text
    'ask_clarification': IMPACT_SAFE,
    'propose_options': IMPACT_SAFE,
    'respond_with_text': IMPACT_SAFE,  # v3.2.2 Phase 4 hotfix
    # Plan & Execute — meta (text), nhưng execute_plan inherit từ steps
    'propose_plan': IMPACT_SAFE,
}


# ─── v3.2.2 Phase 1 — Read tool handlers (Layer 3 retrieval, no side-effect) ──

# Cap tổng số read tool call trong 1 turn (chống loop vô hạn / token explosion)
MAX_READ_TOOL_CALLS_PER_TURN = 5
# Cap iterations của OpenAI loop khi có read tools (safety guard)
MAX_TOOL_LOOP_ITERATIONS = 4
# Cap kích thước JSON result trả về AI (mỗi read response) — tránh nổ token
MAX_READ_RESULT_CHARS = 1500


def _handle_read_shot(args: dict, scenario_dict: dict) -> dict:
    sid = args.get('shot_id')
    try:
        sid = int(sid)
    except (TypeError, ValueError):
        return {'error': f'shot_id không hợp lệ: {sid!r}'}
    for s in scenario_dict.get('shots', []) or []:
        if s.get('shot_id') == sid:
            # Trả 14 field cần thiết (clone để không leak ref)
            return {k: s.get(k) for k in (
                'shot_id', 'shot_order', 'funnel_part', 'character_in_frame',
                'continuity_mode', 'anchor_source_id',
                'voice_over', 'kinetic_action', 'camera_articulation',
                'background', 'character_pose', 'prop_description',
                'texture_and_lighting', 'music_hint', 'brand_mention',
                'prompt_injection', 'warnings',
            )}
    return {'error': f'Shot {sid} không tồn tại'}


def _handle_read_character(args: dict, scenario_dict: dict) -> dict:
    name = (args.get('name') or '').strip().lower()
    if not name:
        return {'error': 'name rỗng'}
    for c in scenario_dict.get('character_registry', []) or []:
        if isinstance(c, dict) and (c.get('name') or '').lower() == name:
            return {k: c.get(k) for k in (
                'name', 'age', 'ethnicity', 'outfit_style', 'voice_id_hint',
            )}
    return {'error': f'Character {name!r} không tồn tại'}


def _handle_read_scenario(args: dict, scenario_dict: dict) -> dict:
    """Trả gọn scenario (toàn shot + char) — có cap kích thước."""
    return {
        'title': scenario_dict.get('title'),
        'genre': scenario_dict.get('genre'),
        'duration_target_seconds': scenario_dict.get('duration_target_seconds'),
        'shot_count': len(scenario_dict.get('shots', []) or []),
        'character_registry': scenario_dict.get('character_registry', []),
        'shots': scenario_dict.get('shots', []),
    }


def _handle_read_voice_overs(args: dict, scenario_dict: dict) -> dict:
    """Trả list voice_over của tất cả shot — dùng cho cross-shot scan."""
    return {
        'voice_overs': [
            {
                'shot_id': s.get('shot_id'),
                'funnel_part': s.get('funnel_part'),
                'voice_over': s.get('voice_over') or '',
                'word_count': len((s.get('voice_over') or '').split()),
            }
            for s in scenario_dict.get('shots', []) or []
        ],
    }


def _handle_read_tool(name: str, args: dict, scenario_dict: dict,
                      cache: dict[str, dict]) -> dict:
    """Dispatch read tool + cache trong cùng turn. Idempotent."""
    # Cache key gồm tool name + args quan trọng
    if name == 'read_shot':
        key = f'read_shot:{args.get("shot_id")}'
    elif name == 'read_character':
        key = f'read_character:{(args.get("name") or "").lower()}'
    else:
        key = name  # read_scenario / read_voice_overs no args
    if key in cache:
        cached = dict(cache[key])
        cached['_cache_hit'] = True
        return cached
    handler = {
        'read_shot': _handle_read_shot,
        'read_character': _handle_read_character,
        'read_scenario': _handle_read_scenario,
        'read_voice_overs': _handle_read_voice_overs,
    }.get(name)
    if not handler:
        return {'error': f'Unknown read tool: {name}'}
    result = handler(args, scenario_dict)
    cache[key] = result
    return result


# v3.2.2 Phase 2 — Plan execute helper (chia nhỏ tool dispatch theo tool_name)
def _execute_plan_step(
    sc: ContentScenario,
    user,
    tool_name: str,
    args: dict,
    *,
    jwt_auth: str | None,
) -> dict:
    """Execute 1 step của plan = call BE handler tương ứng với tool_name.

    KHÔNG re-use FE mutation flow (vì server-side). Dùng direct DB ops cho
    tool đơn giản (insert/delete/move/duplicate/batch_update/add_character/
    delete_character), và call agent_teams cho tool phức tạp (apply_shot_patch,
    optimize_whole_scenario).

    Returns dict mô tả kết quả (sẽ persist vào step['result']).
    Raise Exception nếu fail → caller mark step status='failed'.
    """
    if tool_name == 'apply_shot_patch':
        # Call agent_teams refine — tương tự _handle_apply_shot_patch
        scenario_dict = _scenario_to_dict(sc)
        patches = _handle_apply_shot_patch(scenario_dict, args, jwt_auth)
        # Apply patches: update shot trực tiếp
        applied = []
        for p in patches:
            if p.get('kind') != 'shot':
                continue
            sid = p.get('shot_id')
            after = p.get('after') or {}
            try:
                shot = sc.shots.get(shot_id=sid)
            except ContentScenarioShot.DoesNotExist:
                continue
            allowed = {
                'character_in_frame', 'background', 'character_pose', 'kinetic_action',
                'camera_articulation', 'prop_description', 'texture_and_lighting',
                'voice_over', 'music_hint', 'funnel_part', 'brand_mention',
                'continuity_mode', 'prompt_injection',
            }
            applied_after = {k: v for k, v in after.items() if k in allowed}
            before = {k: getattr(shot, k) for k in applied_after}  # T17(R3) — chụp trước khi áp
            for k, v in applied_after.items():
                setattr(shot, k, v)
            shot.save()
            # T8 — chống mồ côi khi refine đặt nhân vật mới.
            _ensure_character_registered(sc, shot.character_in_frame)
            # T17 (R3) — plan-execute áp THẬT → ghi audit/lịch sử per-shot (trước đây thiếu).
            if applied_after:
                ContentScenarioAuditLog.objects.create(
                    scenario=sc, actor=user, action=AuditAction.REFINE_SHOT,
                    shot_id=sid, fields_changed=applied_after, previous_value=before,
                )
            applied.append(sid)
        return {'applied_shot_ids': applied, 'patch_count': len(patches)}

    if tool_name == 'apply_character_patch':
        scenario_dict = _scenario_to_dict(sc)
        patches = _handle_apply_character_patch(scenario_dict, args, jwt_auth)
        applied = []
        for p in patches:
            if p.get('kind') != 'character':
                continue
            char_name = p.get('character_name')
            after = p.get('after') or {}
            registry = list(sc.character_registry or [])
            for c in registry:
                if isinstance(c, dict) and (c.get('name') or '').lower() == (char_name or '').lower():
                    for k, v in after.items():
                        if k in ('outfit_style', 'age', 'ethnicity', 'voice_id_hint'):
                            c[k] = v
                    applied.append(char_name)
                    break
            sc.character_registry = registry
            sc.save(update_fields=['character_registry', 'updated_at'])
        return {'applied_characters': applied}

    if tool_name == 'insert_shot':
        # T15 — chèn shot trong plan: gọi agent_teams sinh CONTENT THẬT (như endpoint insert-shot),
        # fallback brief nếu lỗi; + tự đăng ký nhân vật nếu shot tham chiếu tên chưa có (T8).
        after_shot_id = int(args.get('after_shot_id') or 0)
        brief = (args.get('brief') or '').strip()
        shots = list(sc.shots.order_by('shot_order'))
        insert_at = 1 if after_shot_id == 0 else next(
            (s.shot_order + 1 for s in shots if s.shot_id == after_shot_id), len(shots) + 1,
        )
        for s in shots:
            if s.shot_order >= insert_at:
                s.shot_order += 1
                s.save(update_fields=['shot_order'])
        new_id = max((s.shot_id for s in shots), default=0) + 1
        nd = {}
        try:
            scenario_dict = _scenario_to_dict(sc)
            data, err = _agent_teams_post('/scenario/refine-shot', {
                'shot': {
                    'shot_id': new_id, 'shot_order': insert_at, 'character_in_frame': 'None',
                    'continuity_mode': 'NEW_SCENE', 'voice_over': '', 'kinetic_action': '',
                    'camera_articulation': '', 'background': '', 'character_pose': '',
                    'prop_description': '', 'texture_and_lighting': '', 'music_hint': '',
                    'funnel_part': '', 'brand_mention': 'none',
                },
                'scenario_context': {
                    'title': scenario_dict.get('title', ''),
                    'genre': scenario_dict.get('genre', 'seeding'),
                    'character_registry': scenario_dict.get('character_registry', []),
                    'shots_summary': [
                        {'shot_id': s.get('shot_id'), 'funnel_part': s.get('funnel_part'),
                         'voice_over': (s.get('voice_over') or '')[:120]}
                        for s in scenario_dict.get('shots', [])
                    ],
                },
                'brief': brief, 'fields': [], 'reviewer_focus': 'style',
            }, jwt_auth)
            if not err and data:
                nd = data.get('shot', {}) or {}
        except Exception:  # noqa: BLE001 — best-effort, fallback brief bên dưới
            nd = {}
        new_shot = ContentScenarioShot.objects.create(
            scenario=sc, shot_id=new_id, shot_order=insert_at,
            character_in_frame=nd.get('character_in_frame', 'None'),
            continuity_mode=nd.get('continuity_mode', 'NEW_SCENE'),
            prompt_injection=nd.get('prompt_injection', ''),
            background=nd.get('background', ''),
            character_pose=nd.get('character_pose', ''),
            kinetic_action=nd.get('kinetic_action', ''),
            camera_articulation=nd.get('camera_articulation', ''),
            prop_description=nd.get('prop_description', ''),
            texture_and_lighting=nd.get('texture_and_lighting', ''),
            voice_over=nd.get('voice_over') or brief[:200],
            music_hint=nd.get('music_hint', ''),
            funnel_part=nd.get('funnel_part') or 'B-roll',
            brand_mention=nd.get('brand_mention', 'none'),
        )
        _ensure_character_registered(sc, new_shot.character_in_frame)
        # T17 (R3) — ghi audit lúc plan chèn shot thật.
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=user, action=AuditAction.INSERT_SHOT,
            shot_id=new_id, fields_changed={'after_shot_id': after_shot_id, 'brief': brief},
        )
        _renumber_shot_ids(sc)  # v3.2.2 hotfix
        return {'new_shot_id': new_id, 'inserted_at_order': insert_at}

    if tool_name == 'delete_shot':
        sid = int(args.get('shot_id') or 0)
        try:
            shot = sc.shots.get(shot_id=sid)
        except ContentScenarioShot.DoesNotExist:
            raise ValueError(f'Shot {sid} không tồn tại')
        deleted_order = shot.shot_order
        shot.delete()
        for s in sc.shots.filter(shot_order__gt=deleted_order):
            s.shot_order -= 1
            s.save(update_fields=['shot_order'])
        _renumber_shot_ids(sc)  # v3.2.2 hotfix
        return {'deleted_shot_id': sid}

    if tool_name == 'add_character':
        registry = list(sc.character_registry or [])
        name = (args.get('name') or '').strip()
        if not name:
            raise ValueError('name rỗng')
        if any(isinstance(c, dict) and (c.get('name') or '').lower() == name.lower()
               for c in registry):
            raise ValueError(f'Character {name} đã tồn tại')
        new_char = {
            'name': name,
            'age': (args.get('age') or '').strip(),
            'outfit_style': (args.get('outfit_style') or '').strip(),
            'ethnicity': (args.get('ethnicity') or 'Việt Nam').strip(),
            'voice_id_hint': (args.get('voice_id_hint') or '').strip(),
        }
        registry.append(new_char)
        sc.character_registry = registry
        sc.save(update_fields=['character_registry', 'updated_at'])
        return {'added_character': name}

    if tool_name == 'delete_character':
        name = (args.get('name') or '').strip()
        replace_with = (args.get('replace_in_shots_with') or '').strip()
        registry = list(sc.character_registry or [])
        idx = next(
            (i for i, c in enumerate(registry)
             if isinstance(c, dict) and (c.get('name') or '').lower() == name.lower()),
            None,
        )
        if idx is None:
            raise ValueError(f'Character {name} không tồn tại')
        replacement = replace_with or 'None'
        for shot in sc.shots.filter(character_in_frame__iexact=name):
            shot.character_in_frame = replacement
            shot.save(update_fields=['character_in_frame'])
        registry.pop(idx)
        sc.character_registry = registry
        sc.save(update_fields=['character_registry', 'updated_at'])
        return {'deleted_character': name, 'replaced_with': replacement}

    if tool_name == 'move_shot':
        sid = int(args.get('shot_id') or 0)
        new_pos = int(args.get('new_position') or 0)
        shots = list(sc.shots.order_by('shot_order'))
        target = next((s for s in shots if s.shot_id == sid), None)
        if not target:
            raise ValueError(f'Shot {sid} không tồn tại')
        new_pos = max(1, min(new_pos, len(shots)))
        old_pos = target.shot_order
        if new_pos != old_pos:
            if new_pos < old_pos:
                for s in shots:
                    if new_pos <= s.shot_order < old_pos and s.shot_id != sid:
                        s.shot_order += 1
                        s.save(update_fields=['shot_order'])
            else:
                for s in shots:
                    if old_pos < s.shot_order <= new_pos and s.shot_id != sid:
                        s.shot_order -= 1
                        s.save(update_fields=['shot_order'])
            target.shot_order = new_pos
            target.save(update_fields=['shot_order'])
        _renumber_shot_ids(sc)  # v3.2.2 hotfix
        target.refresh_from_db()
        return {'moved_shot_id': target.shot_id, 'from': old_pos, 'to': new_pos}

    if tool_name == 'duplicate_shot':
        sid = int(args.get('shot_id') or 0)
        shots = list(sc.shots.order_by('shot_order'))
        source = next((s for s in shots if s.shot_id == sid), None)
        if not source:
            raise ValueError(f'Shot {sid} không tồn tại')
        for s in shots:
            if s.shot_order > source.shot_order:
                s.shot_order += 1
                s.save(update_fields=['shot_order'])
        new_id = max((s.shot_id for s in shots), default=0) + 1
        ContentScenarioShot.objects.create(
            scenario=sc, shot_id=new_id, shot_order=source.shot_order + 1,
            funnel_part=source.funnel_part,
            character_in_frame=source.character_in_frame,
            continuity_mode=source.continuity_mode,
            anchor_source_shot=source.anchor_source_shot,
            voice_over=source.voice_over, kinetic_action=source.kinetic_action,
            camera_articulation=source.camera_articulation,
            background=source.background, character_pose=source.character_pose,
            prop_description=source.prop_description,
            texture_and_lighting=source.texture_and_lighting,
            music_hint=source.music_hint, brand_mention=source.brand_mention,
            prompt_injection=source.prompt_injection,
            warnings=source.warnings or [],
        )
        _renumber_shot_ids(sc)  # v3.2.2 hotfix
        return {'duplicated_from': sid}

    if tool_name == 'batch_update_shots':
        updates = args.get('updates') or []
        allowed = {
            'character_in_frame', 'background', 'character_pose', 'kinetic_action',
            'camera_articulation', 'prop_description', 'texture_and_lighting',
            'voice_over', 'music_hint', 'funnel_part', 'brand_mention',
            'continuity_mode', 'prompt_injection',
        }
        applied = []
        for u in updates[:5]:
            if not isinstance(u, dict):
                continue
            try:
                sid = int(u.get('shot_id'))
            except (TypeError, ValueError):
                continue
            try:
                shot = sc.shots.get(shot_id=sid)
            except ContentScenarioShot.DoesNotExist:
                continue
            fields = u.get('fields') or {}
            if not isinstance(fields, dict):
                continue
            for k, v in fields.items():
                if k in allowed:
                    setattr(shot, k, v)
            shot.save()
            applied.append(sid)
        return {'batch_applied_shot_ids': applied}

    if tool_name == 'reorder_shots':
        new_order = args.get('new_order') or []
        if not isinstance(new_order, list):
            raise ValueError('new_order phải là list')
        for new_pos, sid in enumerate(new_order, start=1):
            try:
                shot = sc.shots.get(shot_id=int(sid))
            except (ContentScenarioShot.DoesNotExist, ValueError, TypeError):
                continue
            shot.shot_order = new_pos
            shot.save(update_fields=['shot_order'])
        _renumber_shot_ids(sc)  # v3.2.2 hotfix
        return {'reordered': new_order}

    raise ValueError(f'Unknown tool_name in plan step: {tool_name!r}')


# v3.2.2 Phase 1 — Telemetry helper
def _record_ai_refine_event(
    *,
    scenario_obj,
    owner_user,
    result: dict,
    target_shots: list[int],
    target_character: str,
    duration_ms: int,
) -> None:
    """Persist 1 row AiRefineEvent từ result của _process_scenario_chat_turn.

    Best-effort: nếu fail (vd DB lỗi) → KHÔNG block user chat. Log warning.
    """
    if owner_user is None or not getattr(owner_user, 'is_authenticated', False):
        return
    try:
        # Import lazily để tránh circular nếu có
        from .models import AiRefineEvent
        telemetry = result.get('_telemetry') or {}
        tool_names: list[str] = []
        patches_count = len(result.get('patches') or [])
        structured = result.get('structured_actions') or []
        # Reconstruct tool_names từ patches + structured_actions + meta presence
        for p in (result.get('patches') or []):
            tool_names.append(
                'apply_shot_patch' if p.get('kind') == 'shot'
                else 'apply_character_patch'
            )
        for sa in structured:
            kind = sa.get('kind')
            if kind:
                tool_names.append(kind)
        if result.get('proposed_options'):
            tool_names.append('propose_options')
        if result.get('clarification_question'):
            tool_names.append('ask_clarification')
        # Read tool count (chỉ biết count, không know specific id — đủ cho stats)
        read_count = int(telemetry.get('read_tool_calls') or 0)
        if read_count > 0:
            tool_names.extend(['read_tool'] * read_count)
        AiRefineEvent.objects.create(
            scenario=scenario_obj,
            owner=owner_user,
            tool_names=tool_names,
            read_tool_count=read_count,
            loop_iterations=int(telemetry.get('loop_iterations') or 1),
            tokens_input=int(telemetry.get('tokens_input') or 0),
            tokens_output=int(telemetry.get('tokens_output') or 0),
            llm_model=result.get('llm_model', '')[:80],
            patches_count=patches_count,
            structured_actions_count=len(structured),
            has_proposed_options=bool(result.get('proposed_options')),
            has_clarification=bool(result.get('clarification_question')),
            target_shots=target_shots or [],
            target_character=(target_character or '')[:120],
            duration_ms=duration_ms,
        )
    except Exception as exc:  # noqa: BLE001 — telemetry không được block chat
        logger.warning('AiRefineEvent log failed: %s', exc)


# v3.2.2 Phase 0 — fix bug #5 (multiline prompt → 3 patch trùng cùng shot)
def _renumber_shot_ids(sc: ContentScenario) -> dict[int, int]:
    """v3.2.2 hotfix: renumber shot_id để khớp shot_order (1, 2, ..., N).

    Mỗi khi insert/delete/move/duplicate/reorder shot, label "Shot N" trong
    timeline phải luôn = position. Trước fix: shot_id giữ max+1 → label nhảy
    (vd "Shot 10" ở vị trí 1 vì là shot mới nhất).

    Trả mapping {old_shot_id: new_shot_id} cho caller có thể remap audit/patches
    nếu cần.

    KHÔNG BREAK FK: `anchor_source_shot` là FK đến PK (DB id), không phải
    `shot_id` field. Renumber chỉ đổi shot_id (logical) — pk + FK ref giữ nguyên.

    2-pass với offset (PositiveIntegerField không cho negative):
      Pass 1: offset shot_id = max + i + 1000 (tránh conflict unique_together)
      Pass 2: gán shot_id = position (1, 2, ..., N)
    """
    shots = list(sc.shots.order_by('shot_order'))
    if not shots:
        return {}
    # No-op nếu shot_id đã khớp position
    if all(s.shot_id == i + 1 for i, s in enumerate(shots)):
        return {}
    mapping: dict[int, int] = {}
    offset = max(s.shot_id for s in shots) + 1000
    # Pass 1: offset all shot_ids để né conflict unique_together(scenario, shot_id)
    for i, s in enumerate(shots):
        s.shot_id = offset + i + 1
        s.save(update_fields=['shot_id'])
    # Pass 2: final IDs by position (1, 2, ..., N)
    for new_id, s in enumerate(shots, start=1):
        old_id = offset + new_id  # tra ngược offset
        # Tìm shot có shot_id offset tương ứng để map old → new
        # (Thực tế shots list giữ thứ tự shot_order, new_id chính là position)
        s.shot_id = new_id
        s.save(update_fields=['shot_id'])
    # Build mapping từ tham chiếu ban đầu — không cần thiết nếu caller không dùng
    # (offset là internal, không expose). Trả empty dict cho simplicity.
    return mapping


def _process_scenario_chat_turn(
    scenario_dict: dict,
    history: list[dict],
    user_body: str,
    target_shots: list[int],
    target_character: str,
    brand_prompt: str,
    jwt_auth: str | None,
    *,
    session_id: str = '',
    user_id: str = '',
    scenario_obj: ContentScenario | None = None,
    owner_user=None,
) -> dict:
    """Old Django-side LLM call logic removed in v4.0. Relocated to FastAPI agent-teams."""
    raise NotImplementedError("Sử dụng endpoint FastAPI /scenario/refine-chat-stream thay thế.")


def _handle_apply_shot_patch(scenario_dict: dict, args: dict, jwt_auth: str | None,
                              *, session_id: str = '', user_id: str = '') -> list[dict]:
    """Gọi agent_teams refine-shot cho mỗi shot_id, build patch.

    v3.2.1 Phase 2: thread session_id + user_id để scripter dùng Agno memory.
    """
    shot_ids = args.get('shot_ids') or []
    if not isinstance(shot_ids, list):
        return []
    brief = (args.get('brief') or '').strip()
    fields = args.get('fields') or []
    reviewer_focus = args.get('reviewer_focus') or 'style'

    patches: list[dict] = []
    all_shots = scenario_dict.get('shots') or []
    by_id = {s.get('shot_id'): s for s in all_shots if isinstance(s, dict)}

    for sid in shot_ids:
        if sid not in by_id:
            continue
        original = by_id[sid]
        payload = {
            'shot': original,
            'scenario_context': {
                'title': scenario_dict.get('title', ''),
                'genre': scenario_dict.get('genre', 'seeding'),
                'character_registry': scenario_dict.get('character_registry', []),
                'shots_summary': [
                    {'shot_id': s.get('shot_id'), 'funnel_part': s.get('funnel_part'),
                     'voice_over': s.get('voice_over', '')[:120]}
                    for s in all_shots
                ],
            },
            'brief': brief,
            'fields': fields,
            'reviewer_focus': reviewer_focus,
        }
        data, err = _agent_teams_post(
            '/scenario/refine-shot', payload, jwt_auth,
            session_id=session_id, user_id=user_id,
        )
        if not data or 'shot' not in data:
            logger.warning('refine-shot failed for shot %s: %s', sid, err)
            continue

        new_shot = data['shot']
        before = {k: original.get(k, '') for k in (
            'voice_over', 'kinetic_action', 'camera_articulation',
            'background', 'character_pose', 'prop_description',
            'texture_and_lighting', 'music_hint',
        )}
        after = {k: new_shot.get(k, original.get(k, '')) for k in before}

        # Drop no-op patch
        if before == after:
            continue

        patches.append({
            'kind': 'shot',
            'shot_id': sid,
            'before': before,
            'after': after,
        })
    return patches


def _handle_apply_character_patch(scenario_dict: dict, args: dict, jwt_auth: str | None,
                                    *, session_id: str = '', user_id: str = '') -> list[dict]:
    """Gọi agent_teams refine-character (nếu có), hoặc đơn giản hơn — chỉ build
    patch dùng brief làm đề xuất (vì registry không cần multi-agent refine).

    v3.1 MVP: dùng brief trực tiếp build patch không qua agent_teams.
    v3.2.1 Phase 2: thread session_id + user_id để scripter dùng Agno memory.
    """
    character_name = (args.get('character_name') or '').strip()
    brief = (args.get('brief') or '').strip()
    fields = args.get('fields') or []
    if not character_name or not brief:
        return []

    registry = scenario_dict.get('character_registry') or []
    original = next(
        (c for c in registry if isinstance(c, dict) and c.get('name') == character_name),
        None,
    )
    if not original:
        return []

    # Single-call agent_teams refine cho character (nhẹ — chỉ Reviser)
    payload = {
        'character': original,
        'scenario_context': {
            'title': scenario_dict.get('title', ''),
            'genre': scenario_dict.get('genre', 'seeding'),
            # v3.2.1 Phase 2.3: include full registry để Context Provider chèn ràng buộc
            'character_registry': scenario_dict.get('character_registry', []),
        },
        'brief': brief,
        'fields': fields,
    }
    data, err = _agent_teams_post(
        '/scenario/refine-character', payload, jwt_auth,
        session_id=session_id, user_id=user_id,
    )
    if not data or 'character' not in data:
        logger.warning('refine-character failed: %s', err)
        return []

    new_char = data['character']
    before = {k: original.get(k, '') for k in ('outfit_style', 'age', 'ethnicity', 'voice_id_hint')}
    after = {k: new_char.get(k, original.get(k, '')) for k in before}
    if before == after:
        return []

    return [{
        'kind': 'character',
        'character_name': character_name,
        'before': before,
        'after': after,
    }]


# ─── Audit snapshot summarizer (v3.2.1 Phase 5) ─────────────────────────────

_SUMMARY_FIELDS_ORDER = (
    'voice_over', 'kinetic_action', 'camera_articulation', 'background',
    'character_pose', 'prop_description', 'texture_and_lighting', 'music_hint',
    'funnel_part', 'brand_mention', 'continuity_mode',
)


def _summarize_previous_value(prev: dict | None, max_fields: int = 3, max_chars: int = 60) -> str:
    """Short text preview của 1 audit snapshot — FE dùng làm label dropdown khôi phục.

    BUG FIX v3.2.1 UX-E: trước chỉ show 1 field đầu tiên có content (voice_over),
    dẫn tới mọi entry trông giống nhau khi user chỉ đổi 1 field khác (vd kinetic).
    Giờ show TOP `max_fields` field có content, mỗi field max `max_chars` char.

    Output: 'voice_over: "...", kinetic_action: "...", camera: "..."'
    """
    if not isinstance(prev, dict) or not prev:
        return '(không có snapshot)'
    parts: list[str] = []
    for key in _SUMMARY_FIELDS_ORDER:
        if len(parts) >= max_fields:
            break
        val = prev.get(key)
        if isinstance(val, str) and val.strip():
            text = val.strip()
            preview = text[:max_chars] + ('...' if len(text) > max_chars else '')
            parts.append(f'{key}: "{preview}"')
    if not parts:
        return '(snapshot không có text)'
    return ' · '.join(parts)


# ─── SSE event helper (v3.2.1 Phase 3) ──────────────────────────────────────

def _sse_event(event_name: str, data: dict | None = None) -> str:
    """Format 1 Server-Sent Event đúng spec text/event-stream (v3.2.1 Phase 3).

    Output: 'event: <name>\\ndata: <json>\\n\\n'

    Bắt buộc `\\n\\n` cuối để client flush event. Nếu data là None → gửi '{}'.
    """
    payload = json.dumps(data or {}, ensure_ascii=False)
    return f'event: {event_name}\ndata: {payload}\n\n'


# ─── voice_over duration warning (OQ7) ───────────────────────────────────────

def _check_voice_over_warning(voice_over: str) -> list[str]:
    """Soft warning nếu voice_over >30 từ (≈5s đọc TTS Việt)."""
    if not voice_over:
        return []
    word_count = len(voice_over.split())
    if word_count > VOICE_OVER_WORD_WARN_THRESHOLD:
        return [f'voice_over có {word_count} từ (>{VOICE_OVER_WORD_WARN_THRESHOLD}) — có thể vượt 5s khi TTS']
    return []


# ─── Helper: serialize scenario thành dict cho chat context / patches ────────

def _scenario_to_dict(scenario: ContentScenario) -> dict:
    """Trả scenario dạng dict (cho chat context + patch operations)."""
    serializer = ContentScenarioSerializer(scenario)
    return serializer.data


# ─── Helper: persist scenario JSON vào DB ────────────────────────────────────

# v3.2 — Build XLSX export (Chốt #17)
def _build_scenario_xlsx(sc):
    """Build .xlsx file với 2 sheet (Characters + Shots). Trả BytesIO."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill

    wb = Workbook()
    bold = Font(bold=True)
    header_fill = PatternFill('solid', fgColor='E6E6FA')
    wrap = Alignment(wrap_text=True, vertical='top')

    # Sheet 1: Characters
    ws_chars = wb.active
    ws_chars.title = 'Characters'
    char_headers = ['Name', 'Age', 'Ethnicity', 'Outfit style', 'Voice ID hint']
    for col, h in enumerate(char_headers, start=1):
        cell = ws_chars.cell(row=1, column=col, value=h)
        cell.font = bold
        cell.fill = header_fill
    for row_idx, c in enumerate((sc.character_registry or []), start=2):
        if not isinstance(c, dict):
            continue
        ws_chars.cell(row=row_idx, column=1, value=c.get('name', ''))
        ws_chars.cell(row=row_idx, column=2, value=c.get('age', ''))
        ws_chars.cell(row=row_idx, column=3, value=c.get('ethnicity', ''))
        ws_chars.cell(row=row_idx, column=4, value=c.get('outfit_style', '')).alignment = wrap
        ws_chars.cell(row=row_idx, column=5, value=c.get('voice_id_hint', ''))
    for col_idx, width in enumerate([15, 12, 15, 40, 18], start=1):
        ws_chars.column_dimensions[chr(64 + col_idx)].width = width

    # Sheet 2: Shots
    ws_shots = wb.create_sheet('Shots')
    shot_headers = [
        'Shot ID', 'Order', 'Funnel', 'Character', 'Continuity', 'Anchor from',
        'Background', 'Pose', 'Action', 'Camera', 'Prop', 'Texture/Lighting',
        'Voice over', 'Music', 'Brand mention',
    ]
    for col, h in enumerate(shot_headers, start=1):
        cell = ws_shots.cell(row=1, column=col, value=h)
        cell.font = bold
        cell.fill = header_fill
    shots = sc.shots.order_by('shot_order').select_related('anchor_source_shot')
    for row_idx, s in enumerate(shots, start=2):
        anchor_id = s.anchor_source_shot.shot_id if s.anchor_source_shot else ''
        values = [
            s.shot_id, s.shot_order, s.funnel_part, s.character_in_frame,
            s.continuity_mode, anchor_id,
            s.background, s.character_pose, s.kinetic_action, s.camera_articulation,
            s.prop_description, s.texture_and_lighting,
            s.voice_over, s.music_hint, s.brand_mention,
        ]
        for col, v in enumerate(values, start=1):
            cell = ws_shots.cell(row=row_idx, column=col, value=v)
            if col >= 7:  # wrap text cho các field dài
                cell.alignment = wrap
    # Auto-width cho shots
    widths = [8, 8, 10, 14, 14, 12, 30, 25, 30, 25, 25, 30, 40, 20, 14]
    for col_idx, width in enumerate(widths, start=1):
        col_letter = ws_shots.cell(row=1, column=col_idx).column_letter
        ws_shots.column_dimensions[col_letter].width = width

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


@transaction.atomic
def _persist_scenario(user, scenario_json: dict, source_file_name: str = '',
                       intent_json: dict | None = None) -> ContentScenario:
    """Lưu ScenarioJSON → ContentScenario + N ContentScenarioShot + audit 'generate'.

    Sử dụng transaction.atomic để đảm bảo nguyên tử.
    """
    sc = ContentScenario.objects.create(
        owner=user,
        title=scenario_json.get('title', '') or 'AI Scenario',
        brief=scenario_json.get('brief', ''),
        duration_target_seconds=int(scenario_json.get('duration_target_seconds') or 30),
        shot_count_target=int(scenario_json.get('shot_count_target') or 6),
        genre=scenario_json.get('genre', ScenarioGenre.SEEDING),
        source_file_name=source_file_name[:255],
        intent_json=intent_json or {},
        character_registry=scenario_json.get('global_character_registry') or [],
        origin_data={
            'character_registry': scenario_json.get('global_character_registry') or [],
            'shots': scenario_json.get('shots') or [],
        },
    )

    # First pass: tạo shot row, KHÔNG set anchor_source_shot (FK sẽ làm pass 2)
    shot_objs: dict[int, ContentScenarioShot] = {}
    for s in (scenario_json.get('shots') or []):
        warnings = _check_voice_over_warning(s.get('voice_over', ''))
        shot = ContentScenarioShot.objects.create(
            scenario=sc,
            shot_id=int(s.get('shot_id') or 1),
            shot_order=int(s.get('shot_order') or s.get('shot_id') or 1),
            character_in_frame=s.get('character_in_frame', '') or '',
            continuity_mode=s.get('continuity_mode', ContinuityMode.NEW_SCENE),
            prompt_injection=s.get('prompt_injection', '') or '',
            background=s.get('background', '') or '',
            character_pose=s.get('character_pose', '') or '',
            kinetic_action=s.get('kinetic_action', '') or '',
            camera_articulation=s.get('camera_articulation', '') or '',
            prop_description=s.get('prop_description', '') or '',
            texture_and_lighting=s.get('texture_and_lighting', '') or '',
            voice_over=s.get('voice_over', '') or '',
            music_hint=s.get('music_hint', '') or '',
            funnel_part=s.get('funnel_part', '') or '',
            brand_mention=s.get('brand_mention', 'none') or 'none',
            warnings=warnings,
        )
        shot_objs[shot.shot_id] = shot

    # Second pass: set anchor_source_shot FK (logical shot_id → DB FK)
    for s in (scenario_json.get('shots') or []):
        anchor_id = s.get('anchor_source_id')
        if anchor_id and anchor_id in shot_objs:
            shot = shot_objs[int(s.get('shot_id') or 1)]
            shot.anchor_source_shot = shot_objs[anchor_id]
            shot.save(update_fields=['anchor_source_shot'])

    # Audit
    ContentScenarioAuditLog.objects.create(
        scenario=sc, actor=user, action=AuditAction.GENERATE,
        fields_changed={'shot_count': len(shot_objs)},
    )
    return sc


# ═════════════════════════════════════════════════════════════════════════════
# ViewSet
# ═════════════════════════════════════════════════════════════════════════════


class ContentScenarioViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    """ContentScenario CRUD + Generate + Refine + Restore + Chat.

    Anti-IDOR qua OwnedResourceMixin (filter owner + team_membership).
    """
    queryset = ContentScenario.objects.all().select_related('owner', 'team').prefetch_related('shots')
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]

    def get_serializer_class(self):
        if self.action == 'list':
            return ContentScenarioListSerializer
        return ContentScenarioSerializer

    # ─── POST /{id}/generate-video/ — dispatch render to video-agent-worker ─
    @action(detail=True, methods=['post'], url_path='generate-video')
    def generate_video(self, request, pk=None):
        """Publish a Kafka task that asks video-agent-worker to render this
        scenario's shots into an mp4. Async: poll ``/video-status/`` for the
        result (the worker uploads the video and a consumer fills it in)."""
        import uuid as _uuid

        scenario = self.get_object()
        shots = ContentScenarioShotSerializer(
            scenario.shots.order_by('shot_order'), many=True,
        ).data
        if not shots:
            return Response({'detail': 'Kịch bản chưa có shot nào để tạo video.'},
                            status=status.HTTP_400_BAD_REQUEST)

        task_id = f'scn{scenario.id}-{_uuid.uuid4().hex[:12]}'
        fmt = {'name': 'Portrait', 'width': 1080, 'height': 1920, 'ratio': '9:16'}
        message = {
            'task_id': task_id,
            # name must contain "generate video" so the worker routes it.
            'name': 'Tiktok generate video',
            'format': fmt,
            'payload': {
                'format': fmt,
                'shots': shots,
                'duration_target_seconds': scenario.duration_target_seconds,
                'title': scenario.title,
            },
        }
        from mbcontrol.kafka_utils import send_message
        # Publish to the DEDICATED render topic (not the shared task_execution) so
        # only the video-agent-worker picks it up — device workers never see it.
        topic = getattr(settings, 'KAFKA_GENERATE_VIDEO_TOPIC', 'generate-video')
        if not send_message(topic, message, key=task_id):
            return Response({'detail': 'Không gửi được yêu cầu tạo video (Kafka).'},
                            status=status.HTTP_502_BAD_GATEWAY)

        scenario.video_task_id = task_id
        scenario.video_status = 'processing'
        scenario.video_url = ''
        scenario.video_error = ''
        scenario.save(update_fields=['video_task_id', 'video_status', 'video_url',
                                     'video_error', 'updated_at'])
        return Response({'task_id': task_id, 'video_status': 'processing'},
                        status=status.HTTP_202_ACCEPTED)

    # ─── GET /{id}/video-status/ — current render state (presigned URL) ─────
    @action(detail=True, methods=['get'], url_path='video-status')
    def video_status(self, request, pk=None):
        scenario = self.get_object()
        url = scenario.video_url or ''
        if url:
            from facebook.s3_utils import get_presigned_image_url
            try:
                url = get_presigned_image_url(url)
            except Exception:  # noqa: BLE001 — fall back to raw url on presign failure
                logger.exception('video-status: presign failed for scenario %s', scenario.id)
        return Response({
            'video_status': scenario.video_status or '',
            'video_url': url,
            'video_error': scenario.video_error or '',
            'video_task_id': scenario.video_task_id or '',
        })

    # ─── 1. POST /preview-intent/ — Layer 1+2 only ─────────────────────────
    @action(detail=False, methods=['post'], url_path='preview-intent',
            parser_classes=[__import__('rest_framework.parsers', fromlist=['MultiPartParser']).MultiPartParser])
    def preview_intent(self, request):
        """Extract file + Parse Agent → IntentJSON. Trả để FE preview cho user confirm."""
        self.throttle_scope = 'scenario_generate'

        brief = (request.data.get('brief') or '').strip()
        file_obj = request.FILES.get('file')
        paste_text = (request.data.get('paste_text') or '').strip()

        if len(brief) > MAX_BRIEF_CHARS:
            return Response({'detail': f'Brief quá dài (>{MAX_BRIEF_CHARS} chars)'},
                            status=status.HTTP_400_BAD_REQUEST)

        # Layer 1 extract
        raw_text = ''
        parse_warning: str | None = None
        if file_obj:
            raw_text, parse_warning = _extract_text_from_upload(file_obj)
        elif paste_text:
            raw_text = paste_text[:MAX_RAW_TEXT_CHARS]

        if not raw_text:
            return Response({
                'intent_json': {},
                'raw_text_preview': '',
                'warning': parse_warning or 'Không có file/paste — sẽ chỉ dùng brief',
            })

        # Layer 2 parse via agent_teams — v3.2 memory cache wrap
        auth = request.headers.get('Authorization')
        cache_key = _intent_cache_key(raw_text, brief)
        cached = _intent_cache_get(cache_key)
        if cached is not None:
            return Response({
                'intent_json': cached,
                'raw_text_preview': raw_text[:MAX_INTENT_RAW_TRUNCATE],
                'warning': parse_warning,
                '_cache_hit': True,  # telemetry — FE có thể log
            })
        data, err = _agent_teams_post('/scenario/parse-intent',
                                       {'raw_text': raw_text, 'brief': brief},
                                       auth, timeout=60)
        if err:
            return Response({
                'intent_json': {},
                'raw_text_preview': raw_text[:MAX_INTENT_RAW_TRUNCATE],
                'warning': f'Parse fail soft: {err}. Sẽ chỉ dùng brief khi gen.',
            })

        intent = data.get('intent_json', {}) or {}
        _intent_cache_set(cache_key, intent)
        return Response({
            'intent_json': intent,
            'raw_text_preview': raw_text[:MAX_INTENT_RAW_TRUNCATE],
            'warning': parse_warning,
        })

    # ─── 2. POST /generate/ — Layer 1+2+3 → ScenarioJSON (chưa lưu) ────────
    @action(detail=False, methods=['post'], url_path='generate',
            parser_classes=[__import__('rest_framework.parsers', fromlist=['MultiPartParser']).MultiPartParser])
    def generate(self, request):
        """Sinh kịch bản v3 — return ScenarioJSON. FE navigate /content-scenarios/draft."""
        self.throttle_scope = 'scenario_generate'

        brief = (request.data.get('brief') or '').strip()
        if not brief:
            return Response({'detail': 'Brief là bắt buộc.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(brief) > MAX_BRIEF_CHARS:
            return Response({'detail': f'Brief quá dài (>{MAX_BRIEF_CHARS})'},
                            status=status.HTTP_400_BAD_REQUEST)

        try:
            duration = int(request.data.get('duration_target_seconds') or 30)
        except (ValueError, TypeError):
            duration = 30
        duration = max(10, min(120, duration))

        try:
            shot_count = int(request.data.get('shot_count_target') or max(3, round(duration / 5)))
        except (ValueError, TypeError):
            shot_count = max(3, round(duration / 5))
        shot_count = max(1, min(20, shot_count))

        genre = request.data.get('genre') or ScenarioGenre.SEEDING
        if genre not in [c[0] for c in ScenarioGenre.choices]:
            genre = ScenarioGenre.SEEDING

        brand_override = (request.data.get('brand_override') or '').strip() or None
        brand_prompt = _resolve_brand_prompt(request.user, brand_override)

        # v3.2.1 Option 3D — request_id từ FE để cancel mid-pipeline. FE nên gửi
        # UUIDv4. Nếu trống → backend tự generate (cancel sẽ không hoạt động
        # vì FE không biết ID để POST cancel endpoint).
        request_id = (request.data.get('request_id') or '').strip()

        # Layer 1
        file_obj = request.FILES.get('file')
        paste_text = (request.data.get('paste_text') or '').strip()
        raw_text = ''
        parse_warning: str | None = None
        source_file_name = ''
        if file_obj:
            raw_text, parse_warning = _extract_text_from_upload(file_obj)
            source_file_name = file_obj.name[:255]
        elif paste_text:
            raw_text = paste_text[:MAX_RAW_TEXT_CHARS]

        # Layer 2 (optional) — v3.2 memory cache wrap
        auth = request.headers.get('Authorization')
        intent_json: dict = {}
        if raw_text:
            cache_key = _intent_cache_key(raw_text, brief)
            cached = _intent_cache_get(cache_key)
            if cached is not None:
                intent_json = cached
            else:
                intent_data, intent_err = _agent_teams_post(
                    '/scenario/parse-intent',
                    {'raw_text': raw_text, 'brief': brief},
                    auth, timeout=60,
                    request_id=request_id,
                )
                if intent_data:
                    intent_json = intent_data.get('intent_json', {}) or {}
                    if intent_json:
                        _intent_cache_set(cache_key, intent_json)
                elif intent_err:
                    # 3D: check cancel error pattern → propagate 499 ngay
                    if intent_err.startswith('CANCELLED:'):
                        return Response(
                            {'detail': 'Đã hủy sinh kịch bản.', 'cancelled': True},
                            status=499,
                        )
                    parse_warning = (parse_warning or '') + f' | Layer 2: {intent_err}'

        # Layer 3 — ScripterAgent generate
        gen_payload = {
            'brief': brief,
            'duration_target_seconds': duration,
            'shot_count_target': shot_count,
            'genre': genre,
            'brand_prompt': brand_prompt,
            'intent_json': intent_json,
            'raw_text': raw_text[:MAX_INTENT_RAW_TRUNCATE] if not intent_json else '',
        }
        data, err = _agent_teams_post('/scenario/generate', gen_payload, auth,
                                       request_id=request_id)
        if err:
            # v3.2.1 3D: phân biệt cancel vs server error
            if err.startswith('CANCELLED:'):
                return Response(
                    {'detail': 'Đã hủy sinh kịch bản.', 'cancelled': True},
                    status=499,
                )
            return Response({'detail': f'Sinh kịch bản thất bại: {err}'},
                            status=status.HTTP_502_BAD_GATEWAY)
        if not data or 'scenario' not in data:
            return Response({'detail': 'Engine trả về dữ liệu không hợp lệ.'},
                            status=status.HTTP_502_BAD_GATEWAY)

        return Response({
            'scenario': data['scenario'],
            'intent_json': intent_json,
            'source_file_name': source_file_name,
            'warning': parse_warning,
        })

    # ─── 3. POST /save/ — lưu ScenarioJSON đã preview vào DB ───────────────
    @action(detail=False, methods=['post'], url_path='save')
    def save_scenario(self, request):
        """Lưu ScenarioJSON đã preview vào DB. Trả ContentScenario detail."""
        self.throttle_scope = 'scenario_generate'

        scenario_json = request.data.get('scenario')
        if not isinstance(scenario_json, dict):
            return Response({'detail': 'scenario JSON thiếu/sai.'},
                            status=status.HTTP_400_BAD_REQUEST)

        source_file_name = request.data.get('source_file_name', '') or ''
        intent_json = request.data.get('intent_json') or {}

        try:
            sc = _persist_scenario(request.user, scenario_json, source_file_name, intent_json)
        except Exception as exc:  # noqa: BLE001
            logger.exception('persist_scenario failed')
            return Response({'detail': f'Lưu thất bại: {str(exc)[:200]}'},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(ContentScenarioSerializer(sc).data, status=status.HTTP_201_CREATED)

    # ─── 4. PATCH /{id}/update-shot/ — sửa 1 shot ─────────────────────────
    @action(detail=True, methods=['patch'], url_path='update-shot')
    def update_shot(self, request, pk=None):
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()

        try:
            shot_id = int(request.data.get('shot_id'))
        except (ValueError, TypeError):
            return Response({'detail': 'shot_id thiếu/sai'}, status=status.HTTP_400_BAD_REQUEST)

        fields = request.data.get('fields') or {}
        if not isinstance(fields, dict) or not fields:
            return Response({'detail': 'fields rỗng'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            shot = sc.shots.get(shot_id=shot_id)
        except ContentScenarioShot.DoesNotExist:
            return Response({'detail': 'Shot không tồn tại'}, status=status.HTTP_404_NOT_FOUND)

        allowed = {
            'character_in_frame', 'background', 'character_pose', 'kinetic_action',
            'camera_articulation', 'prop_description', 'texture_and_lighting',
            'voice_over', 'music_hint', 'funnel_part', 'brand_mention',
            'continuity_mode', 'prompt_injection',
        }
        previous_value = {k: getattr(shot, k) for k in fields if k in allowed}
        for k, v in fields.items():
            if k in allowed:
                setattr(shot, k, v)
        # Recompute warning OQ7
        shot.warnings = _check_voice_over_warning(shot.voice_over)
        shot.save()

        # T8 — chống mồ côi: nếu đổi character_in_frame sang nhân vật chưa có → tự đăng ký.
        if 'character_in_frame' in fields:
            _ensure_character_registered(sc, shot.character_in_frame)

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.UPDATE_SHOT,
            shot_id=shot_id, fields_changed=fields, previous_value=previous_value,
        )
        return Response(ContentScenarioShotSerializer(shot).data)

    # ─── 5. PATCH /{id}/update-character/ — sửa 1 character ────────────────
    @action(detail=True, methods=['patch'], url_path='update-character')
    def update_character(self, request, pk=None):
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()

        character_name = (request.data.get('character_name') or '').strip()
        fields = request.data.get('fields') or {}
        if not character_name or not isinstance(fields, dict):
            return Response({'detail': 'character_name + fields bắt buộc'},
                            status=status.HTTP_400_BAD_REQUEST)

        registry = list(sc.character_registry or [])
        idx = next(
            (i for i, c in enumerate(registry) if isinstance(c, dict) and c.get('name') == character_name),
            None,
        )
        if idx is None:
            return Response({'detail': 'Character không tồn tại trong registry'},
                            status=status.HTTP_404_NOT_FOUND)

        allowed = {'outfit_style', 'age', 'ethnicity', 'voice_id_hint', 'name'}
        previous_value = {k: registry[idx].get(k) for k in fields if k in allowed}
        for k, v in fields.items():
            if k in allowed:
                registry[idx][k] = v

        sc.character_registry = registry
        sc.save(update_fields=['character_registry', 'updated_at'])

        # v5 — Cascade: đổi TÊN nhân vật → đồng bộ character_in_frame ở MỌI shot tham chiếu.
        # (Tái dùng pattern của delete_character.) Chỉ chạy khi tên thực sự đổi.
        new_name = (fields.get('name') or '').strip()
        cascaded_shots = 0
        if 'name' in fields and new_name and new_name != character_name:
            # T18 (R1) — đổi tên: ngoài tag character_in_frame, thay tên cũ→mới trong các TEXT
            # FIELD của chính shot đó (hành động/thoại/... thường nhắc tên nhân vật). Thay theo
            # RANH GIỚI TỪ để tránh thay nhầm chuỗi con. Chỉ động vào shot có nhân vật này.
            _name_pat = re.compile(r'(?<!\w)' + re.escape(character_name) + r'(?!\w)')
            _text_fields = ('kinetic_action', 'voice_over', 'character_pose',
                            'prompt_injection', 'prop_description', 'background')
            for shot in sc.shots.filter(character_in_frame__iexact=character_name):
                shot.character_in_frame = new_name
                changed = ['character_in_frame']
                for tf in _text_fields:
                    val = getattr(shot, tf) or ''
                    new_val = _name_pat.sub(new_name, val)
                    if new_val != val:
                        setattr(shot, tf, new_val)
                        changed.append(tf)
                shot.save(update_fields=changed)
                cascaded_shots += 1

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.UPDATE_CHARACTER,
            character_name=character_name, fields_changed=fields,
            previous_value=previous_value,
        )
        return Response({'character': registry[idx], 'cascaded_shots': cascaded_shots})

    # ─── 6. PATCH /{id}/restore-shot/ ──────────────────────────────────────
    @action(detail=True, methods=['patch'], url_path='restore-shot')
    def restore_shot(self, request, pk=None):
        sc = self.get_object()
        try:
            shot_id = int(request.data.get('shot_id'))
        except (ValueError, TypeError):
            return Response({'detail': 'shot_id thiếu/sai'}, status=status.HTTP_400_BAD_REQUEST)

        origin_shots = (sc.origin_data or {}).get('shots') or []
        origin_shot = next(
            (s for s in origin_shots if isinstance(s, dict) and int(s.get('shot_id') or 0) == shot_id),
            None,
        )
        if not origin_shot:
            return Response({'detail': 'Không có snapshot cho shot này'},
                            status=status.HTTP_404_NOT_FOUND)

        try:
            shot = sc.shots.get(shot_id=shot_id)
        except ContentScenarioShot.DoesNotExist:
            return Response({'detail': 'Shot hiện tại không tồn tại'}, status=status.HTTP_404_NOT_FOUND)

        previous_value = ContentScenarioShotSerializer(shot).data
        for k in ('character_in_frame', 'background', 'character_pose', 'kinetic_action',
                  'camera_articulation', 'prop_description', 'texture_and_lighting',
                  'voice_over', 'music_hint', 'funnel_part', 'brand_mention',
                  'continuity_mode', 'prompt_injection'):
            if k in origin_shot:
                setattr(shot, k, origin_shot.get(k, ''))
        shot.warnings = _check_voice_over_warning(shot.voice_over)
        shot.save()

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.RESTORE_SHOT,
            shot_id=shot_id, previous_value=previous_value,
        )
        return Response(ContentScenarioShotSerializer(shot).data)

    # ─── 7. PATCH /{id}/restore-all/ ───────────────────────────────────────
    @action(detail=True, methods=['patch'], url_path='restore-all')
    @transaction.atomic
    def restore_all(self, request, pk=None):
        sc = self.get_object()
        origin = sc.origin_data or {}
        if not origin:
            return Response({'detail': 'Không có snapshot origin'}, status=status.HTTP_404_NOT_FOUND)

        previous_value = ContentScenarioSerializer(sc).data
        sc.character_registry = origin.get('character_registry', [])
        sc.save(update_fields=['character_registry', 'updated_at'])

        # Xoá hết shots hiện tại + tạo lại từ origin
        sc.shots.all().delete()
        shot_objs: dict[int, ContentScenarioShot] = {}
        for s in origin.get('shots', []):
            shot = ContentScenarioShot.objects.create(
                scenario=sc,
                shot_id=int(s.get('shot_id') or 1),
                shot_order=int(s.get('shot_order') or s.get('shot_id') or 1),
                character_in_frame=s.get('character_in_frame', '') or '',
                continuity_mode=s.get('continuity_mode', ContinuityMode.NEW_SCENE),
                prompt_injection=s.get('prompt_injection', '') or '',
                background=s.get('background', '') or '',
                character_pose=s.get('character_pose', '') or '',
                kinetic_action=s.get('kinetic_action', '') or '',
                camera_articulation=s.get('camera_articulation', '') or '',
                prop_description=s.get('prop_description', '') or '',
                texture_and_lighting=s.get('texture_and_lighting', '') or '',
                voice_over=s.get('voice_over', '') or '',
                music_hint=s.get('music_hint', '') or '',
                funnel_part=s.get('funnel_part', '') or '',
                brand_mention=s.get('brand_mention', 'none') or 'none',
                warnings=_check_voice_over_warning(s.get('voice_over', '')),
            )
            shot_objs[shot.shot_id] = shot

        # Re-link anchor FK
        for s in origin.get('shots', []):
            anchor_id = s.get('anchor_source_id')
            if anchor_id and anchor_id in shot_objs:
                shot = shot_objs[int(s.get('shot_id') or 1)]
                shot.anchor_source_shot = shot_objs[anchor_id]
                shot.save(update_fields=['anchor_source_shot'])

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.RESTORE_ALL,
            previous_value=previous_value,
        )
        return Response(ContentScenarioSerializer(sc).data)

    # ─── 8. GET /{id}/audits/ ──────────────────────────────────────────────
    @action(detail=True, methods=['get'], url_path='audits')
    def audits(self, request, pk=None):
        sc = self.get_object()
        qs = sc.audits.all()[:200]
        return Response(ContentScenarioAuditLogSerializer(qs, many=True).data)

    # ─── 8.1. GET /{id}/history/ — list shot snapshots cho rollback (v3.2.1 Phase 5)
    @action(detail=True, methods=['get'], url_path='history')
    def shot_history(self, request, pk=None):
        """List audit entries có previous_value để FE render dropdown khôi phục.

        Query params:
          - shot_id (int, optional): filter chỉ snapshot cho 1 shot
          - limit (int, default 50, max 200)

        Trả về list entries có thể restore back to. Mỗi entry chứa đủ data
        cho FE preview trước khi user click khôi phục.
        """
        sc = self.get_object()
        try:
            limit = min(int(request.query_params.get('limit', 50)), 200)
        except (ValueError, TypeError):
            limit = 50

        shot_id_filter = request.query_params.get('shot_id')
        qs = sc.audits.filter(
            action__in=[
                AuditAction.UPDATE_SHOT,
                AuditAction.REFINE_SHOT,
                AuditAction.RESTORE_SHOT,
                AuditAction.OPTIMIZE_WHOLE,
            ],
        ).exclude(previous_value={}).order_by('-created_at')

        if shot_id_filter:
            try:
                qs = qs.filter(shot_id=int(shot_id_filter))
            except (ValueError, TypeError):
                return Response(
                    {'detail': 'shot_id phải là int'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        entries = []
        for a in qs[:limit]:
            entries.append({
                'audit_id': a.id,
                'action': a.action,
                'shot_id': a.shot_id,
                'character_name': a.character_name,
                'created_at': a.created_at,
                'actor_id': a.actor_id,
                # v3.2.1 UX-E: summary tách riêng 2 phần để FE render diff rõ ràng
                # - previous_value_summary: shot TRƯỚC change này (restore sẽ về đây)
                # - fields_changed_summary: shot SAU change này (audit ghi lại gì đã đổi)
                'previous_value_summary': _summarize_previous_value(a.previous_value),
                'fields_changed_summary': _summarize_previous_value(a.fields_changed),
                # Full snapshots cho FE compare hoặc render detail
                'previous_value': a.previous_value,
                'fields_changed': a.fields_changed,
            })
        return Response(entries)

    # ─── 8.2. POST /{id}/restore-from-audit/ ────────────────────────────────
    @action(detail=True, methods=['post'], url_path='restore-from-audit')
    @transaction.atomic
    def restore_from_audit(self, request, pk=None):
        """Khôi phục shot từ snapshot trong audit log (v3.2.1 Phase 5).

        Body: { audit_id: int }

        Phân biệt với /restore-shot/ (cũ — chỉ về origin_data lúc generate):
        endpoint mới này về snapshot AT ANY POINT in time qua audit log.

        Anti-IDOR: audit phải thuộc scenario người dùng có quyền view.
        """
        sc = self.get_object()
        try:
            audit_id = int(request.data.get('audit_id'))
        except (ValueError, TypeError):
            return Response(
                {'detail': 'audit_id thiếu/sai'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            audit = sc.audits.get(id=audit_id)
        except ContentScenarioAuditLog.DoesNotExist:
            return Response(
                {'detail': 'Audit không tồn tại trong scenario này'},
                status=status.HTTP_404_NOT_FOUND,
            )

        prev = audit.previous_value or {}
        if not prev:
            return Response(
                {'detail': 'Audit không có previous_value để khôi phục'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not audit.shot_id:
            return Response(
                {'detail': 'Audit không gắn shot_id — không thể restore per-shot'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            shot = sc.shots.get(shot_id=audit.shot_id)
        except ContentScenarioShot.DoesNotExist:
            return Response(
                {'detail': f'Shot {audit.shot_id} đã bị xoá, không thể khôi phục'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Snapshot current state để audit
        current_snapshot = {k: getattr(shot, k, '') for k in (
            'voice_over', 'kinetic_action', 'camera_articulation',
            'background', 'character_pose', 'prop_description',
            'texture_and_lighting', 'music_hint', 'funnel_part', 'brand_mention',
        )}

        # Apply previous_value (chỉ các field nội dung, KHÔNG đụng FK/anchor để tránh
        # phá graph)
        restorable_fields = (
            'voice_over', 'kinetic_action', 'camera_articulation',
            'background', 'character_pose', 'prop_description',
            'texture_and_lighting', 'music_hint', 'funnel_part', 'brand_mention',
        )
        for k in restorable_fields:
            if k in prev:
                setattr(shot, k, prev[k])
        shot.warnings = _check_voice_over_warning(getattr(shot, 'voice_over', ''))
        shot.save()

        # Audit RESTORE_SHOT
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.RESTORE_SHOT,
            shot_id=audit.shot_id,
            fields_changed={
                'restored_from_audit_id': audit.id,
                'restored_from_action': audit.action,
            },
            previous_value=current_snapshot,
        )

        return Response(ContentScenarioShotSerializer(shot).data)

    # ─── 8.5. GET /{id}/approvals/ — list pending approvals (v3.2.1 Phase 4)
    @action(detail=True, methods=['get'], url_path='approvals')
    def list_approvals(self, request, pk=None):
        """List pending approvals của scenario (chỉ trả của user hiện tại)."""
        sc = self.get_object()
        status_filter = (request.query_params.get('status') or '').strip()
        qs = sc.pending_approvals.filter(owner=request.user).order_by('-created_at')[:100]
        if status_filter:
            qs = sc.pending_approvals.filter(
                owner=request.user, status=status_filter,
            ).order_by('-created_at')[:100]
        return Response([{
            'id': a.id,
            'tool_name': a.tool_name,
            'tool_args': a.tool_args,
            'status': a.status,
            'created_at': a.created_at,
            'resolved_at': a.resolved_at,
            'execution_result': a.execution_result,
        } for a in qs])

    # ─── 8.6. POST /{id}/approvals/{approval_id}/resolve/ ───────────────────
    @action(
        detail=True, methods=['post'],
        url_path='approvals/(?P<approval_id>[0-9]+)/resolve',
    )
    @transaction.atomic
    def resolve_approval(self, request, pk=None, approval_id=None):
        """Resolve pending approval (v3.2.1 Phase 4).

        Body: { action: 'approve' | 'reject' }

        Nếu `approve` → execute tương ứng:
          - delete_shot: gọi internal self.delete_shot(...) logic — nhưng vì shot
            có thể có orphan, FE NÊN gọi /delete-shot/ trực tiếp với orphan_resolution.
            → Resolve approve chỉ MARK approved, NOT execute. FE responsible execute.
          - reorder_shots: tương tự — FE gọi /reorder-shots/ với new_order.
          - optimize_whole_scenario: FE gọi /optimize-whole/ với variant_brief.

        Tại sao approve KHÔNG auto-execute? Vì dangerous tool có thể cần resolve
        thêm (orphan, preview confirm) — pattern cleanest là FE drive execute.
        Approval row = audit trail "AI proposed → user approved/rejected at X".

        Anti-IDOR: chỉ owner gốc của approval mới resolve được.
        """
        sc = self.get_object()
        action_choice = (request.data.get('action') or '').strip().lower()
        if action_choice not in {'approve', 'reject'}:
            return Response(
                {'detail': "action phải là 'approve' hoặc 'reject'"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            approval = sc.pending_approvals.select_for_update().get(
                id=approval_id, owner=request.user,
            )
        except ContentScenarioPendingApproval.DoesNotExist:
            return Response(
                {'detail': 'Approval không tồn tại hoặc không thuộc bạn'},
                status=status.HTTP_404_NOT_FOUND,
            )

        if approval.status != ApprovalStatus.PENDING:
            return Response(
                {'detail': f'Approval đã ở trạng thái {approval.status}, không thể resolve lại'},
                status=status.HTTP_409_CONFLICT,
            )

        approval.status = (
            ApprovalStatus.APPROVED if action_choice == 'approve' else ApprovalStatus.REJECTED
        )
        approval.resolved_at = timezone.now()
        approval.resolved_by = request.user
        approval.save(update_fields=['status', 'resolved_at', 'resolved_by'])

        # Audit
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user,
            action=(AuditAction.APPROVAL_APPROVED if action_choice == 'approve'
                    else AuditAction.APPROVAL_REJECTED),
            fields_changed={
                'approval_id': approval.id,
                'tool_name': approval.tool_name,
                'tool_args': approval.tool_args,
            },
        )

        return Response({
            'id': approval.id,
            'status': approval.status,
            'tool_name': approval.tool_name,
            'tool_args': approval.tool_args,
            'resolved_at': approval.resolved_at,
            # Hint cho FE biết endpoint nào execute (nếu approve)
            'execute_endpoint': {
                'delete_shot': f'/api/content-scenarios/{sc.id}/delete-shot/',
                'delete_character': f'/api/content-scenarios/{sc.id}/delete-character/',  # v3.2.2 Phase 0
                'reorder_shots': f'/api/content-scenarios/{sc.id}/reorder-shots/',
                'optimize_whole_scenario': f'/api/content-scenarios/{sc.id}/optimize-whole/',
            }.get(approval.tool_name) if action_choice == 'approve' else None,
        })

    # ─── 9. GET/POST /{id}/script-chat/ — DB-backed chat refine ────────────
    @action(detail=True, methods=['post'],
            url_path=r'chat-messages/(?P<message_id>\d+)/resolve')
    def resolve_proposal(self, request, pk=None, message_id=None):
        """T20 (R6) — đánh dấu 1 đề xuất trong 1 chat message đã giải quyết (applied/rejected)
        để FE render trạng thái BỀN sau reload (chống re-apply trùng).

        Body: {key: str (khoá đề xuất, do FE đặt ổn định vd 'patch-0'/'action-1'), status: 'applied'|'rejected'}
        FE gọi sau khi apply/bỏ qua thành công 1 đề xuất.
        """
        sc = self.get_object()
        try:
            msg = sc.chat_messages.get(pk=int(message_id), owner=request.user)
        except (ContentScenarioChatMessage.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Chat message không tồn tại'},
                            status=status.HTTP_404_NOT_FOUND)
        key = (request.data.get('key') or '').strip()
        status_val = (request.data.get('status') or '').strip().lower()
        if not key or status_val not in ('applied', 'rejected'):
            return Response({'detail': 'key + status (applied|rejected) bắt buộc'},
                            status=status.HTTP_400_BAD_REQUEST)
        resolved = dict(msg.resolved_actions or {})
        resolved[key] = {'status': status_val, 'at': timezone.now().isoformat()}
        msg.resolved_actions = resolved
        msg.save(update_fields=['resolved_actions'])
        return Response({'message_id': msg.id, 'resolved_actions': resolved})

    @action(detail=True, methods=['get', 'post'], url_path='script-chat')
    def script_chat(self, request, pk=None):
        sc = self.get_object()

        if request.method == 'GET':
            qs = sc.chat_messages.filter(owner=request.user)
            return Response(ContentScenarioChatMessageSerializer(qs, many=True).data)

        # POST
        self.throttle_scope = 'scenario_chat'
        body = (request.data.get('body') or '').strip()
        if not body:
            return Response({'detail': 'body rỗng'}, status=status.HTTP_400_BAD_REQUEST)

        target_shots = request.data.get('target_shots') or []
        if not isinstance(target_shots, list):
            target_shots = []
        target_character = (request.data.get('target_character') or '').strip()

        # Save user turn
        user_msg = ContentScenarioChatMessage.objects.create(
            scenario=sc, owner=request.user, sender=ChatSender.USER, body=body,
            target_shots=target_shots, target_character=target_character,
        )

        jwt_auth = request.headers.get('Authorization')
        
        # Build payload for FastAPI
        payload = {
            "message": body,
            "scenario_context": _scenario_to_dict(sc),
            "target_shots": target_shots,
            "target_character": target_character,
            "session_id": _agno_session_id(request.user.id if request.user.is_authenticated else None, sc.id),
            "user_id": str(request.user.id) if request.user.is_authenticated else '',
            "request_id": request.data.get('request_id') or f"req_sync_{int(time.time())}_{sc.id}",
        }

        url = f"{_agent_teams_base()}/scenario/refine-chat-stream"
        headers = {'Content-Type': 'application/json'}
        if jwt_auth:
            headers['Authorization'] = jwt_auth

        assistant_body = ""
        patches = []
        structured_actions = []
        llm_model = "gpt-4o-mini"
        event_type = None
        data_buffer = []

        _turn_start = time.monotonic()

        try:
            import requests
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=120)
            if not resp.ok:
                return Response({'detail': f'Engine returned error {resp.status_code}'}, status=status.HTTP_502_BAD_GATEWAY)

            for line_bytes in resp.iter_lines():
                line = line_bytes.decode('utf-8', errors='replace').strip()
                if not line:
                    if event_type and data_buffer:
                        data_str = "".join(data_buffer)
                        try:
                            data_json = json.loads(data_str)
                        except Exception:
                            data_json = data_str

                        if event_type == "creative_directing":
                            if isinstance(data_json, dict):
                                tool_name = data_json.get("tool")
                                if tool_name == "propose_creative_treatment":
                                    structured_actions.append({
                                        'kind': 'propose_creative_treatment',
                                        'goal': data_json.get('creative_goal'),
                                        'analysis': data_json.get('artistic_analysis'),
                                        'steps': data_json.get('creative_steps'),
                                    })
                                else:
                                    shot_id = data_json.get("shot_id") or data_json.get("to_shot_id")
                                    patch = data_json.get("patch")
                                    if shot_id and patch:
                                        original_shot = sc.shots.filter(shot_id=shot_id).first()
                                        if original_shot:
                                            before = {}
                                            after = {}
                                            for key, val in patch.items():
                                                orig_val = getattr(original_shot, key, None)
                                                if orig_val is not None:
                                                    before[key] = orig_val
                                                    after[key] = val
                                            if before:
                                                patches.append({
                                                    'kind': 'shot',
                                                    'shot_id': shot_id,
                                                    'before': before,
                                                    'after': after,
                                                })
                        elif event_type == "final":
                            if isinstance(data_json, dict):
                                assistant_body = data_json.get("assistant") or ""
                                if "llm_model" in data_json:
                                    llm_model = data_json["llm_model"]
                    event_type = None
                    data_buffer = []
                elif line.startswith("event:"):
                    event_type = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    data_buffer.append(line[len("data:"):].strip())

            # Save assistant turn
            asst_msg = ContentScenarioChatMessage.objects.create(
                scenario=sc, owner=request.user, sender=ChatSender.ASSISTANT,
                body=assistant_body,
                target_shots=target_shots, target_character=target_character,
                attached_patches=patches,
                llm_model=llm_model,
            )

            # T17 (R5) — KHÔNG ghi audit propose-time: patches là ĐỀ XUẤT chờ Duyệt (xem
            # _persist_assistant_turn). Audit chỉ ghi lúc APPLY thật.

            # Telemetry
            _record_ai_refine_event(
                scenario_obj=sc, owner_user=request.user,
                result={
                    'assistant': assistant_body,
                    'patches': patches,
                    'structured_actions': structured_actions,
                    'llm_model': llm_model,
                },
                target_shots=target_shots, target_character=target_character,
                duration_ms=int((time.monotonic() - _turn_start) * 1000),
            )

            return Response({
                'user_message': ContentScenarioChatMessageSerializer(user_msg).data,
                'assistant_message': ContentScenarioChatMessageSerializer(asst_msg).data,
                'structured_actions': structured_actions,
                'proposed_options': None,
                'clarification_question': None,
            }, status=status.HTTP_201_CREATED)

        except Exception as exc:
            logger.exception("Sync refine chat failed")
            return Response({'detail': f'Refine error: {exc}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    # ─── 9.5. POST /{id}/script-chat-stream/ — SSE streaming chat (v3.2.1 Phase 3)
    @action(detail=True, methods=['post'], url_path='script-chat-stream')
    def script_chat_stream(self, request, pk=None):
        """SSE streaming chat endpoint — đẩy event ngay khi AI có output (v4.0 proxy).

        Chuyển tiếp (proxy) request sang FastAPI agent-teams/scenario/refine-chat-stream
        bằng requests stream, đồng thời lưu trữ chat message và telemetry khi hoàn tất.
        """
        from django.http import StreamingHttpResponse
        from asgiref.sync import sync_to_async
        import httpx

        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        body = (request.data.get('body') or '').strip()
        if not body:
            return Response({'detail': 'body rỗng'}, status=status.HTTP_400_BAD_REQUEST)

        target_shots = request.data.get('target_shots') or []
        if not isinstance(target_shots, list):
            target_shots = []
        target_character = (request.data.get('target_character') or '').strip()

        request_user = request.user
        jwt_auth = request.headers.get('Authorization')

        # T37 (Đợt 8 #2) — chống stream TRÙNG / double-submit (Zero-Trust: KHÔNG tin FE khóa
        # Enter). Khóa Redis per (scenario, user) TRƯỚC khi tạo USER turn → đang có stream thì
        # trả 409 + KHÔNG tạo lượt user trùng. Nhả khóa ở finally của event_stream (kể cả client
        # disconnect); TTL backstop phòng crash; Redis lỗi → fail-open (không chặn chat).
        from mbcontrol.redis_utils import get_redis_client
        _chat_lock_key = f"scn_chat_lock:{sc.id}:{getattr(request_user, 'id', '') or 'anon'}"
        _chat_lock_acquired = False
        try:
            if get_redis_client().set(_chat_lock_key, '1', nx=True, ex=SCN_CHAT_LOCK_TTL_SECONDS):
                _chat_lock_acquired = True
            else:
                return Response(
                    {'detail': 'Mình đang trả lời câu hỏi trước, bạn đợi xong rồi gửi tiếp nhé.',
                     'code': 'chat_in_progress'},
                    status=status.HTTP_409_CONFLICT,
                )
        except Exception:  # noqa: BLE001 — Redis lỗi → fail-open, không chặn chat
            logger.warning('scn_chat_lock acquire failed (fail-open)', exc_info=True)

        # Save user turn
        user_msg = ContentScenarioChatMessage.objects.create(
            scenario=sc, owner=request_user, sender=ChatSender.USER, body=body,
            target_shots=target_shots, target_character=target_character,
        )

        # Lịch sử hội thoại — agent-teams STATELESS (agentdb không có session table → Agno
        # auto-memory NO-OP). Django là nguồn sự thật: gửi N turn gần nhất (loại trừ message
        # user vừa tạo) để agent hiểu tham chiếu ('nhân vật thứ 2', 'như trên', 'option vừa rồi').
        history = _build_chat_history(sc, exclude_id=user_msg.id)

        # Build payload for FastAPI
        payload = {
            "message": body,
            "scenario_context": _scenario_to_dict(sc),
            "target_shots": target_shots,
            "target_character": target_character,
            "history": history,
            "session_id": _agno_session_id(request_user.id if request_user.is_authenticated else None, sc.id),
            "user_id": str(request_user.id) if request_user.is_authenticated else '',
            "request_id": request.data.get('request_id') or f"req_{int(time.time())}_{sc.id}",
        }

        # v4.1 — prefetch shots 1 lần (sync ORM) để async generator KHÔNG chạm ORM trong loop
        shots_by_id = {s.shot_id: s for s in sc.shots.all()}

        def _persist_assistant_turn(assistant_body: str, patches: list, structured_actions: list, llm_model: str, duration_ms: int, artistic_checks: list = None):
            """Lưu assistant turn + audit + telemetry (sync ORM) — gọi qua sync_to_async."""
            ContentScenarioChatMessage.objects.create(
                scenario=sc, owner=request_user, sender=ChatSender.ASSISTANT,
                body=assistant_body,
                target_shots=target_shots, target_character=target_character,
                attached_patches=patches,
                structured_actions=structured_actions,
                artistic_checks=artistic_checks or [],  # T11 — bảng điểm reviewer persist
                llm_model=llm_model,
            )
            # T17 (R5) — KHÔNG ghi audit ở đây: `patches` chỉ là ĐỀ XUẤT chờ Duyệt, chưa áp.
            # Audit/lịch sử shot CHỈ ghi lúc APPLY thật (update-shot / plan-execute). Ghi ở
            # propose-time làm lịch sử shot "bẩn" (đề xuất chưa duyệt) + trùng khi user apply.
            _record_ai_refine_event(
                scenario_obj=sc, owner_user=request_user,
                result={'assistant': assistant_body, 'patches': patches, 'llm_model': llm_model},
                target_shots=target_shots, target_character=target_character,
                duration_ms=duration_ms,
            )

        async def event_stream():
            assistant_body = ""
            patches = []
            structured_actions = []
            artistic_checks = []  # T11 — gom bảng điểm reviewer để persist
            llm_model = "gpt-4o-mini"
            saved_assistant = False
            cancelled_seen = False  # T32 — user huỷ giữa chừng → KHÔNG persist lượt dở

            event_type = None
            data_buffer = []

            url = f"{_agent_teams_base()}/scenario/refine-chat-stream"
            headers = {'Content-Type': 'application/json'}
            if jwt_auth:
                headers['Authorization'] = jwt_auth

            _turn_start = time.monotonic()
            client = None
            resp = None

            try:
                # Báo FE "AI đang suy nghĩ..."
                yield _sse_event('thinking', {'text': 'AI Director đang phân tích yêu cầu...'})

                # v4.1 — async httpx stream (KHÔNG block thread-sensitive executor của Daphne).
                # Dùng send(stream=True) + aclose thủ công để GIỮ NGUYÊN cấp lồng của vòng parse.
                timeout = httpx.Timeout(AGENT_TEAMS_TIMEOUT_SECONDS, connect=10.0)
                client = httpx.AsyncClient(timeout=timeout)
                resp = await client.send(
                    client.build_request('POST', url, json=payload, headers=headers),
                    stream=True,
                )
                if resp.status_code >= 400:
                    yield _sse_event('error', _friendly_engine_error(f'Engine returned error {resp.status_code}'))
                    await resp.aclose()
                    await client.aclose()
                    resp = None
                    client = None
                    return

                async for raw_line in resp.aiter_lines():
                    # Forward verbatim (tái tạo ranh giới \n\n cho client)
                    yield raw_line + "\n"

                    line = raw_line.strip()
                    if not line:
                        # Event boundary
                        if event_type and data_buffer:
                            data_str = "".join(data_buffer)
                            try:
                                data_json = json.loads(data_str)
                            except Exception:
                                data_json = data_str

                            if event_type == "creative_directing":
                                if isinstance(data_json, dict):
                                    _kind = data_json.get("kind")
                                    _tool = data_json.get("tool")
                                    if _kind == "character":
                                        # v5 — thao tác nhân vật (manage_character). Phân biệt:
                                        #  • nhân vật ĐÃ CÓ → patch update (FE → update-character + cascade)
                                        #  • nhân vật CHƯA CÓ → add_character (FE → add-character). Tránh
                                        #    update-character trả 404 "Character không tồn tại" (bug user gặp).
                                        cname = (data_json.get("character_name") or "").strip()
                                        cpatch = data_json.get("patch") or {}
                                        if cname and cpatch:
                                            registry = sc.character_registry or []
                                            cur = next(
                                                (c for c in registry if isinstance(c, dict)
                                                 and (c.get('name') or '').strip().lower() == cname.lower()),
                                                None,
                                            )
                                            if cur is None:
                                                # Nhân vật MỚI → add_character (kind rời rạc FE hỗ trợ sẵn)
                                                structured_actions.append({
                                                    'kind': 'add_character',
                                                    'name': (cpatch.get('name') or cname).strip(),
                                                    'age': cpatch.get('age') or '',
                                                    'outfit_style': cpatch.get('outfit_style') or '',
                                                    'ethnicity': cpatch.get('ethnicity') or 'Việt Nam',
                                                    'voice_id_hint': cpatch.get('voice_id_hint') or '',
                                                    'requires_approval': False,
                                                    'data_impact_class': 'safe',
                                                })
                                            else:
                                                before = {k: cur.get(k) for k in cpatch.keys()}
                                                patches.append({
                                                    'kind': 'character',
                                                    'character_name': cname,
                                                    'before': before,
                                                    'after': cpatch,
                                                })
                                    elif _kind == "structural":
                                        # v5.1 — thao tác cấu trúc (add/remove/reorder/move/duplicate).
                                        # Chuẩn hoá op→kind rời rạc cho FE card (ấn Duyệt mới execute được).
                                        _fe_action = _structural_to_fe_action(
                                            data_json.get('op'),
                                            data_json.get('args') or {},
                                            data_json.get('impact') or 'safe',
                                        )
                                        if _fe_action:
                                            structured_actions.append(_fe_action)
                                        else:
                                            # op lạ → giữ shape thô để khỏi mất dữ liệu (FE hiển thị generic)
                                            structured_actions.append({
                                                'kind': 'structural',
                                                'op': data_json.get('op'),
                                                'args': data_json.get('args') or {},
                                                'impact': data_json.get('impact') or 'safe',
                                                'tool': _tool,
                                            })
                                    elif _tool == "propose_creative_treatment":
                                        # T5 — treatment → tạo ContentScenarioPlan (PROPOSED) executable,
                                        # cấp plan_id. Persist kind:'plan_proposed' (FE render PlanCard
                                        # + execute-plan). Emit 'plan_created' để FE LIVE có plan_id
                                        # (event creative_directing raw không kèm plan_id).
                                        _treatment = {
                                            'creative_goal': data_json.get('creative_goal'),
                                            'artistic_analysis': data_json.get('artistic_analysis'),
                                            'creative_steps': data_json.get('creative_steps') or [],
                                        }
                                        if request_user.is_authenticated:
                                            _plan_action = await sync_to_async(_create_treatment_plan)(
                                                sc, request_user, _treatment
                                            )
                                            structured_actions.append(_plan_action)
                                            yield _sse_event('plan_created', _plan_action)
                                        else:
                                            structured_actions.append({'kind': 'treatment', **_treatment})
                                    else:
                                        shot_id = data_json.get("shot_id") or data_json.get("to_shot_id")
                                        patch = data_json.get("patch")
                                        if shot_id and patch:
                                            original_shot = shots_by_id.get(shot_id)
                                            if original_shot:
                                                before = {}
                                                after = {}
                                                for key, val in patch.items():
                                                    orig_val = getattr(original_shot, key, None)
                                                    if orig_val is not None:
                                                        before[key] = orig_val
                                                        after[key] = val
                                                if before:
                                                    patches.append({
                                                        'kind': 'shot',
                                                        'shot_id': shot_id,
                                                        'before': before,
                                                        'after': after,
                                                    })
                            elif event_type == "options":
                                if isinstance(data_json, dict):
                                    structured_actions.append({
                                        'kind': 'options',
                                        'intro': data_json.get('intro'),
                                        'options': data_json.get('options') or [],
                                    })
                            elif event_type == "clarification":
                                if isinstance(data_json, dict):
                                    structured_actions.append({
                                        'kind': 'clarification',
                                        'question': data_json.get('question'),
                                        'options': data_json.get('options') or [],
                                    })
                            elif event_type == "artistic_check":
                                # T11 — gom bảng điểm reviewer để persist (FE render lại sau reload).
                                if isinstance(data_json, dict):
                                    artistic_checks.append(data_json)
                            elif event_type == "diagnosis":
                                # T26 (Đợt 8) — persist kết quả CHẨN ĐOÁN (diagnose_scenario) để FE
                                # render lại sau reload. Informational (kind:'diagnosis'), KHÔNG phải
                                # đề xuất execute. (Live đã forward verbatim ở đầu vòng.)
                                # T29 — `findings` GHÉP CẶP [{target, target_kind, problem, suggestion}]
                                # là CANONICAL (FE T30 render); issues/fixes giữ back-compat.
                                if isinstance(data_json, dict):
                                    structured_actions.append({
                                        'kind': 'diagnosis',
                                        'focus': data_json.get('focus'),
                                        'focus_label': data_json.get('focus_label'),
                                        'reviewer': data_json.get('reviewer'),
                                        'shots_examined': data_json.get('shots_examined') or [],
                                        'score': data_json.get('score'),
                                        'scores': data_json.get('scores') or {},
                                        'findings': data_json.get('findings') or [],
                                        'issues': data_json.get('issues') or [],
                                        'fixes': data_json.get('fixes') or [],
                                    })
                            elif event_type == "cancelled":
                                # T32 — agent-teams báo ĐÃ DỪNG theo yêu cầu → KHÔNG persist lượt
                                # assistant dở (event đã forward verbatim cho FE ở đầu vòng).
                                cancelled_seen = True
                            elif event_type == "final":
                                if isinstance(data_json, dict):
                                    assistant_body = data_json.get("assistant") or ""
                                    if "llm_model" in data_json:
                                        llm_model = data_json["llm_model"]

                                    # Save assistant turn immediately to avoid losing it on disconnect
                                    if not saved_assistant:
                                        # T22 — khử trùng đề xuất lẻ đã nằm trong plan (giữ 1 bảng).
                                        patches, structured_actions = _dedup_proposals_against_plan(
                                            patches, structured_actions)
                                        await sync_to_async(_persist_assistant_turn)(
                                            assistant_body, patches, structured_actions, llm_model,
                                            int((time.monotonic() - _turn_start) * 1000),
                                            artistic_checks,
                                        )
                                        saved_assistant = True

                        event_type = None
                        data_buffer = []
                    elif line.startswith("event:"):
                        event_type = line[len("event:"):].strip()
                    elif line.startswith("data:"):
                        data_buffer.append(line[len("data:"):].strip())

                # Stream xong → đóng response + client
                await resp.aclose()
                await client.aclose()
                resp = None
                client = None

                # Fallback nếu 'final' không tới mà vẫn có nội dung (T32: bỏ qua nếu user đã huỷ).
                if not saved_assistant and not cancelled_seen and (assistant_body or patches or structured_actions or artistic_checks):
                    patches, structured_actions = _dedup_proposals_against_plan(patches, structured_actions)
                    await sync_to_async(_persist_assistant_turn)(
                        assistant_body, patches, structured_actions, llm_model,
                        int((time.monotonic() - _turn_start) * 1000),
                        artistic_checks,
                    )

            except Exception as exc:
                logger.exception('SSE async proxy generator error')
                if resp is not None:
                    await resp.aclose()
                if client is not None:
                    await client.aclose()
                yield _sse_event('error', _friendly_engine_error(exc))
            finally:
                # T37 — LUÔN nhả khóa chat (kể cả client disconnect / GeneratorExit / lỗi) để
                # lượt kế tiếp gửi được. TTL chỉ là backstop phòng tiến trình chết hẳn.
                if _chat_lock_acquired:
                    def _release_chat_lock():
                        try:
                            get_redis_client().delete(_chat_lock_key)
                        except Exception:  # noqa: BLE001
                            logger.warning('scn_chat_lock release failed', exc_info=True)
                    await sync_to_async(_release_chat_lock)()

        response = StreamingHttpResponse(
            event_stream(),
            content_type='text/event-stream',
        )
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'
        return response

    # ─── 10. POST /preview-script-chat/ — stateless chat (cho /draft page) ─
    @action(detail=False, methods=['post'], url_path='preview-script-chat')
    def preview_script_chat(self, request):
        """Stateless chat — KHÔNG lưu DB. FE tự manage state ở ContentScenarioDraftPage."""
        self.throttle_scope = 'scenario_chat'

        scenario_dict = request.data.get('scenario')
        if not isinstance(scenario_dict, dict):
            return Response({'detail': 'scenario thiếu/sai'}, status=status.HTTP_400_BAD_REQUEST)

        body = (request.data.get('body') or '').strip()
        if not body:
            return Response({'detail': 'body rỗng'}, status=status.HTTP_400_BAD_REQUEST)

        target_shots = request.data.get('target_shots') or []
        if not isinstance(target_shots, list):
            target_shots = []
        target_character = (request.data.get('target_character') or '').strip()

        # Build payload for FastAPI
        payload = {
            "message": body,
            "scenario_context": scenario_dict,
            "target_shots": target_shots,
            "target_character": target_character,
            "session_id": f"preview:{request.user.id if request.user.is_authenticated else 'anon'}",
            "user_id": str(request.user.id) if request.user.is_authenticated else '',
            "request_id": f"req_preview_{int(time.time())}",
        }

        url = f"{_agent_teams_base()}/scenario/refine-chat-stream"
        headers = {'Content-Type': 'application/json'}
        jwt_auth = request.headers.get('Authorization')
        if jwt_auth:
            headers['Authorization'] = jwt_auth

        assistant_body = ""
        patches = []
        structured_actions = []
        llm_model = "gpt-4o-mini"
        event_type = None
        data_buffer = []

        _turn_start = time.monotonic()

        try:
            import requests
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=120)
            if not resp.ok:
                return Response({'detail': f'Engine returned error {resp.status_code}'}, status=status.HTTP_502_BAD_GATEWAY)

            for line_bytes in resp.iter_lines():
                line = line_bytes.decode('utf-8', errors='replace').strip()
                if not line:
                    if event_type and data_buffer:
                        data_str = "".join(data_buffer)
                        try:
                            data_json = json.loads(data_str)
                        except Exception:
                            data_json = data_str

                        if event_type == "creative_directing":
                            if isinstance(data_json, dict):
                                _kind = data_json.get("kind")
                                tool_name = data_json.get("tool")
                                if _kind == "character":
                                    # T9 — nhân vật (draft dùng registry in-memory): mới → add_character,
                                    # đã có → character patch (FE Draft áp client-side vào scenario_dict).
                                    cname = (data_json.get("character_name") or "").strip()
                                    cpatch = data_json.get("patch") or {}
                                    if cname and cpatch:
                                        registry = scenario_dict.get('character_registry') or []
                                        cur = next((c for c in registry if isinstance(c, dict)
                                                    and (c.get('name') or '').strip().lower() == cname.lower()), None)
                                        if cur is None:
                                            structured_actions.append({
                                                'kind': 'add_character',
                                                'name': (cpatch.get('name') or cname).strip(),
                                                'age': cpatch.get('age') or '',
                                                'outfit_style': cpatch.get('outfit_style') or '',
                                                'ethnicity': cpatch.get('ethnicity') or 'Việt Nam',
                                                'voice_id_hint': cpatch.get('voice_id_hint') or '',
                                                'requires_approval': False,
                                                'data_impact_class': 'safe',
                                            })
                                        else:
                                            before = {k: cur.get(k) for k in cpatch.keys()}
                                            patches.append({
                                                'kind': 'character', 'character_name': cname,
                                                'before': before, 'after': cpatch,
                                            })
                                elif _kind == "structural":
                                    _fe = _structural_to_fe_action(
                                        data_json.get('op'), data_json.get('args') or {},
                                        data_json.get('impact') or 'safe')
                                    structured_actions.append(_fe or {
                                        'kind': 'structural', 'op': data_json.get('op'),
                                        'args': data_json.get('args') or {},
                                        'impact': data_json.get('impact') or 'safe', 'tool': tool_name,
                                    })
                                elif tool_name == "propose_creative_treatment":
                                    # Draft chưa lưu DB → không tạo ContentScenarioPlan được; giữ render-only.
                                    structured_actions.append({
                                        'kind': 'propose_creative_treatment',
                                        'goal': data_json.get('creative_goal'),
                                        'analysis': data_json.get('artistic_analysis'),
                                        'steps': data_json.get('creative_steps'),
                                    })
                                else:
                                    shot_id = data_json.get("shot_id") or data_json.get("to_shot_id")
                                    patch = data_json.get("patch")
                                    if shot_id and patch:
                                        all_shots = scenario_dict.get('shots') or []
                                        original_shot = next((s for s in all_shots if s.get('shot_id') == shot_id), None)
                                        if original_shot:
                                            before = {}
                                            after = {}
                                            for key, val in patch.items():
                                                orig_val = original_shot.get(key)
                                                if orig_val is not None:
                                                    before[key] = orig_val
                                                    after[key] = val
                                            if before:
                                                patches.append({
                                                    'kind': 'shot',
                                                    'shot_id': shot_id,
                                                    'before': before,
                                                    'after': after,
                                                })
                        elif event_type == "options":
                            if isinstance(data_json, dict):
                                structured_actions.append({
                                    'kind': 'options',
                                    'intro': data_json.get('intro'),
                                    'options': data_json.get('options') or [],
                                })
                        elif event_type == "clarification":
                            if isinstance(data_json, dict):
                                structured_actions.append({
                                    'kind': 'clarification',
                                    'question': data_json.get('question'),
                                    'options': data_json.get('options') or [],
                                })
                        elif event_type == "final":
                            if isinstance(data_json, dict):
                                assistant_body = data_json.get("assistant") or ""
                                if "llm_model" in data_json:
                                    llm_model = data_json["llm_model"]
                    event_type = None
                    data_buffer = []
                elif line.startswith("event:"):
                    event_type = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    data_buffer.append(line[len("data:"):].strip())

            # Telemetry (scenario=None vì draft preview chưa save)
            _record_ai_refine_event(
                scenario_obj=None, owner_user=request.user,
                result={
                    'assistant': assistant_body,
                    'patches': patches,
                    'structured_actions': structured_actions,
                    'llm_model': llm_model,
                },
                target_shots=target_shots, target_character=target_character,
                duration_ms=int((time.monotonic() - _turn_start) * 1000),
            )

            return Response({
                'assistant': assistant_body,
                'patches': patches,
                'structured_actions': structured_actions,
                'llm_model': llm_model,
            })
        except Exception as exc:
            logger.exception("Stateless preview refine failed")
            return Response({'detail': f'Refine error: {exc}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    # ─── 10.5. POST /cancel/ — TRUE cancel mid-pipeline (v3.2.1 3D) ─────────
    @action(detail=False, methods=['post'], url_path='cancel')
    def cancel_scenario(self, request):
        """SET Redis cancel flag cho request_id → agent_teams orchestrator check
        signal trước mỗi LLM call → raise ScenarioCancelled → return 499.

        Body: { request_id: str (UUID FE đã gửi khi generate) }

        Cancel là BEST-EFFORT:
        - Nếu signal đến TRƯỚC layer boundary check → tiết kiệm ~50-70% cost
        - Nếu signal đến TRONG khi LLM đang chạy → LLM call tiếp tục đến hết
          (OpenAI/Gemini API không support cancel), nhưng NEXT layer sẽ raise

        Anti-IDOR: KHÔNG validate request_id thuộc user vì:
        - request_id là UUIDv4 (entropy cao, không guess được)
        - Cancel chỉ STOP pipeline, không expose data → impact thấp
        - Validate sẽ cần lưu request_id↔user mapping (overhead)
        """
        request_id = (request.data.get('request_id') or '').strip()
        if not request_id:
            return Response(
                {'detail': 'request_id bắt buộc'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ok = _scenario_signal_cancel(request_id, ttl_seconds=60)
        return Response({
            'request_id': request_id,
            'signalled': ok,
            'detail': (
                'Đã gửi signal hủy. Backend sẽ stop ở layer boundary tiếp theo.'
                if ok else
                'Redis không khả dụng — cancel signal không lưu được (backend vẫn chạy đến hết).'
            ),
        })

    # ─── 11. GET/POST /brand-prompt/ — team brand voice (Lớp 2) ────────────
    @action(detail=False, methods=['get', 'post'], url_path='brand-prompt')
    def brand_prompt(self, request):
        """Reuse FeatureSystemPrompt model. v3.1 default = per-owner; team-level
        sẽ tinh chỉnh sau khi multi-tenant scale."""
        if request.method == 'GET':
            existing = FeatureSystemPrompt.objects.filter(
                feature_id=FEATURE_BRAND_PROMPT_ID, user=request.user,
            ).order_by('-updated_at').first()
            return Response({
                'system_prompt': existing.system_prompt if existing else '',
                'is_default': not bool(existing),
                'default_preview': DEFAULT_BRAND_PROMPT,
            })

        # POST
        new_prompt = (request.data.get('system_prompt') or '').strip()
        if not new_prompt:
            return Response({'detail': 'system_prompt không được rỗng'},
                            status=status.HTTP_400_BAD_REQUEST)

        obj, _ = FeatureSystemPrompt.objects.update_or_create(
            feature_id=FEATURE_BRAND_PROMPT_ID,
            user=request.user,
            defaults={'system_prompt': new_prompt[:8000]},
        )
        return Response({'system_prompt': obj.system_prompt})

    # ═════════════════════════════════════════════════════════════════════
    # v3.2 — Nhóm A: Graph mutation toolkit + optimize_whole_scenario
    # ═════════════════════════════════════════════════════════════════════

    # ─── 12. POST /{id}/insert-shot/ ──────────────────────────────────────
    @action(detail=True, methods=['post'], url_path='insert-shot')
    @transaction.atomic
    def insert_shot(self, request, pk=None):
        """Chèn 1 shot mới sau `after_shot_id`. AI sinh content khớp context.

        Body: { after_shot_id: int (0 = insert đầu), brief: str (mô tả shot mới) }
        """
        self.throttle_scope = 'scenario_refine'
        sc = self.get_object()

        try:
            after_shot_id = int(request.data.get('after_shot_id') or 0)
        except (ValueError, TypeError):
            return Response({'detail': 'after_shot_id sai'}, status=status.HTTP_400_BAD_REQUEST)

        brief = (request.data.get('brief') or '').strip()
        if not brief:
            return Response({'detail': 'brief bắt buộc'}, status=status.HTTP_400_BAD_REQUEST)

        # Tìm vị trí insert
        shots = list(sc.shots.order_by('shot_order'))
        if after_shot_id == 0:
            insert_at_order = 1
            anchor_for_new = None
        else:
            anchor_for_new = next((s for s in shots if s.shot_id == after_shot_id), None)
            if not anchor_for_new:
                return Response({'detail': f'after_shot_id {after_shot_id} không tồn tại'},
                                status=status.HTTP_404_NOT_FOUND)
            insert_at_order = anchor_for_new.shot_order + 1

        # Tính shot_id mới (max + 1 trong scenario, tránh trùng)
        next_shot_id = max((s.shot_id for s in shots), default=0) + 1

        # Reindex shot_order cho shots phía sau
        for s in shots:
            if s.shot_order >= insert_at_order:
                s.shot_order += 1
                s.save(update_fields=['shot_order'])

        # AI sinh content cho shot mới (gọi agent_teams refine với prompt khác)
        scenario_dict = _scenario_to_dict(sc)
        auth = request.headers.get('Authorization')
        # Reuse refine-shot endpoint với shot rỗng làm seed
        seed_shot = {
            'shot_id': next_shot_id,
            'shot_order': insert_at_order,
            'character_in_frame': 'None',
            'continuity_mode': 'NEW_SCENE',
            'voice_over': '', 'kinetic_action': '', 'camera_articulation': '',
            'background': '', 'character_pose': '', 'prop_description': '',
            'texture_and_lighting': '', 'music_hint': '',
            'funnel_part': '', 'brand_mention': 'none',
        }
        # v3.2.1 Phase 2: Agno session để scripter nhớ context insert
        agno_session = _agno_session_id(
            request.user.id if request.user.is_authenticated else None, sc.id
        )
        data, err = _agent_teams_post('/scenario/refine-shot', {
            'shot': seed_shot,
            'scenario_context': {
                'title': scenario_dict.get('title', ''),
                'genre': scenario_dict.get('genre', 'seeding'),
                'character_registry': scenario_dict.get('character_registry', []),
                'shots_summary': [
                    {'shot_id': s.shot_id, 'funnel_part': s.funnel_part,
                     'voice_over': s.voice_over[:120]}
                    for s in sc.shots.order_by('shot_order')
                ],
            },
            'brief': brief,
            'fields': [],
            'reviewer_focus': 'style',
        }, auth, session_id=agno_session,
            user_id=str(request.user.id) if request.user.is_authenticated else '')
        if err:
            # T12 — quota/auth của LLM → 429 + payload thân thiện cho FE; còn lại giữ 502.
            if _is_quota_error(err):
                return Response(_friendly_engine_error(err), status=status.HTTP_429_TOO_MANY_REQUESTS)
            return Response({'detail': f'AI sinh shot mới thất bại: {err}'},
                            status=status.HTTP_502_BAD_GATEWAY)

        new_shot_data = data.get('shot', {}) if data else {}

        # Tạo DB row
        new_shot = ContentScenarioShot.objects.create(
            scenario=sc,
            shot_id=next_shot_id,
            shot_order=insert_at_order,
            character_in_frame=new_shot_data.get('character_in_frame', 'None'),
            continuity_mode=new_shot_data.get('continuity_mode', 'NEW_SCENE'),
            prompt_injection=new_shot_data.get('prompt_injection', ''),
            background=new_shot_data.get('background', ''),
            character_pose=new_shot_data.get('character_pose', ''),
            kinetic_action=new_shot_data.get('kinetic_action', ''),
            camera_articulation=new_shot_data.get('camera_articulation', ''),
            prop_description=new_shot_data.get('prop_description', ''),
            texture_and_lighting=new_shot_data.get('texture_and_lighting', ''),
            voice_over=new_shot_data.get('voice_over', ''),
            music_hint=new_shot_data.get('music_hint', ''),
            funnel_part=new_shot_data.get('funnel_part', ''),
            brand_mention=new_shot_data.get('brand_mention', 'none'),
            warnings=_check_voice_over_warning(new_shot_data.get('voice_over', '')),
        )

        # T8 — chống mồ côi: shot mới có thể tham chiếu nhân vật chưa có trong registry
        # (AI sinh content theo brief nhắc tên nhân vật mới) → tự đăng ký tối thiểu.
        _ensure_character_registered(sc, new_shot.character_in_frame)

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.INSERT_SHOT,
            shot_id=next_shot_id,
            fields_changed={'after_shot_id': after_shot_id, 'brief': brief},
        )
        # v3.2.2 hotfix: renumber shot_id để khớp position trong timeline
        _renumber_shot_ids(sc)
        new_shot.refresh_from_db()
        return Response(ContentScenarioShotSerializer(new_shot).data,
                        status=status.HTTP_201_CREATED)

    # ─── 13. POST /{id}/delete-shot/ (orphan 409 flow) ────────────────────
    @action(detail=True, methods=['post'], url_path='delete-shot')
    @transaction.atomic
    def delete_shot(self, request, pk=None):
        """Xoá 1 shot. Nếu shot bị xoá là anchor của shot khác → 409 + info để FE
        show modal hỏi user (Chốt #14): convert orphan sang NEW_SCENE hay re-anchor.

        Body: {
            shot_id: int,
            orphan_resolution?: 'convert_new_scene' | 'reanchor:<new_anchor_shot_id>'
        }
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()

        try:
            shot_id = int(request.data.get('shot_id'))
        except (ValueError, TypeError):
            return Response({'detail': 'shot_id sai'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            target = sc.shots.get(shot_id=shot_id)
        except ContentScenarioShot.DoesNotExist:
            return Response({'detail': 'Shot không tồn tại'}, status=status.HTTP_404_NOT_FOUND)

        orphans = list(sc.shots.filter(anchor_source_shot__shot_id=shot_id))
        orphan_resolution = request.data.get('orphan_resolution')

        # Nếu có orphan + user CHƯA cung cấp resolution → 409
        if orphans and not orphan_resolution:
            return Response({
                'detail': 'Orphan resolution required',
                'orphans': [{'shot_id': o.shot_id, 'character_in_frame': o.character_in_frame}
                            for o in orphans],
                'reanchor_candidates': [
                    {'shot_id': s.shot_id, 'character_in_frame': s.character_in_frame,
                     'continuity_mode': s.continuity_mode}
                    for s in sc.shots.exclude(shot_id=shot_id).order_by('shot_order')
                ],
            }, status=status.HTTP_409_CONFLICT)

        # Apply orphan resolution
        if orphan_resolution == 'convert_new_scene':
            for o in orphans:
                o.continuity_mode = ContinuityMode.NEW_SCENE
                o.anchor_source_shot = None
                o.prompt_injection = ''
                o.save(update_fields=['continuity_mode', 'anchor_source_shot', 'prompt_injection'])
        elif orphan_resolution and orphan_resolution.startswith('reanchor:'):
            try:
                new_anchor_id = int(orphan_resolution.split(':', 1)[1])
                new_anchor = sc.shots.get(shot_id=new_anchor_id)
            except (ValueError, ContentScenarioShot.DoesNotExist):
                return Response({'detail': 'reanchor shot_id sai'}, status=status.HTTP_400_BAD_REQUEST)
            for o in orphans:
                o.anchor_source_shot = new_anchor
                o.save(update_fields=['anchor_source_shot'])

        # Snapshot trước khi xoá
        previous_value = ContentScenarioShotSerializer(target).data
        deleted_order = target.shot_order
        target.delete()

        # Reindex shot_order cho shots phía sau
        for s in sc.shots.filter(shot_order__gt=deleted_order):
            s.shot_order -= 1
            s.save(update_fields=['shot_order'])

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.DELETE_SHOT,
            shot_id=shot_id, previous_value=previous_value,
            fields_changed={'orphan_resolution': orphan_resolution or 'no_orphan'},
        )
        # v3.2.2 hotfix: renumber shot_id sau delete
        _renumber_shot_ids(sc)
        return Response({'deleted_shot_id': shot_id, 'orphans_handled': len(orphans)})

    # ─── 13.5. POST /{id}/delete-character/ — v3.2.2 Phase 0 (fix bug #2) ──
    @action(detail=True, methods=['post'], url_path='delete-character')
    @transaction.atomic
    def delete_character(self, request, pk=None):
        """Xoá 1 nhân vật khỏi character_registry + cập nhật shot reference.

        Body: {
            name: str,                            # tên character (case-insensitive)
            replace_in_shots_with?: str | null,   # tên thay thế cho char_in_frame
                                                  # của các shot. None/rỗng → set "None".
        }

        Flow:
          1. Find character trong character_registry (case-insensitive name).
          2. Tìm shots đang dùng `character_in_frame=<name>`.
          3. Replace `character_in_frame` qua `replace_in_shots_with` (hoặc 'None').
          4. Remove character khỏi registry.
          5. Audit log: action=DELETE_CHARACTER, previous_value chứa registry + shot patches.
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()

        name = (request.data.get('name') or '').strip()
        if not name:
            return Response({'detail': 'name là bắt buộc'},
                            status=status.HTTP_400_BAD_REQUEST)
        replace_with = (request.data.get('replace_in_shots_with') or '').strip()

        registry = list(sc.character_registry or [])
        # Find character (case-insensitive)
        target_idx = next(
            (i for i, c in enumerate(registry)
             if isinstance(c, dict) and (c.get('name') or '').lower() == name.lower()),
            None,
        )
        if target_idx is None:
            return Response({'detail': f'Character "{name}" không tồn tại trong registry'},
                            status=status.HTTP_404_NOT_FOUND)

        # Verify replacement character exists (nếu chỉ định)
        if replace_with:
            replacement_exists = any(
                isinstance(c, dict) and (c.get('name') or '').lower() == replace_with.lower()
                for c in registry
            )
            if not replacement_exists:
                return Response(
                    {'detail': f'Replacement character "{replace_with}" không tồn tại'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Snapshot trước khi xoá (cho audit + restore)
        previous_registry = list(registry)
        affected_shots = list(sc.shots.filter(character_in_frame__iexact=name))
        previous_shot_chars = [
            {'shot_id': s.shot_id, 'character_in_frame': s.character_in_frame}
            for s in affected_shots
        ]

        # Update shot references
        replacement_value = replace_with or 'None'
        for shot in affected_shots:
            shot.character_in_frame = replacement_value
            shot.save(update_fields=['character_in_frame'])

        # Remove character from registry
        removed_character = registry.pop(target_idx)
        sc.character_registry = registry
        sc.save(update_fields=['character_registry', 'updated_at'])

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.DELETE_CHARACTER,
            character_name=name,
            previous_value={
                'character_registry': previous_registry,
                'affected_shots': previous_shot_chars,
            },
            fields_changed={
                'removed_character': removed_character,
                'replace_in_shots_with': replacement_value,
                'affected_shot_ids': [s.shot_id for s in affected_shots],
            },
        )
        return Response({
            'deleted_character': name,
            'affected_shot_ids': [s.shot_id for s in affected_shots],
            'replaced_with': replacement_value,
        })

    # ─── 14. POST /{id}/reorder-shots/ ────────────────────────────────────
    @action(detail=True, methods=['post'], url_path='reorder-shots')
    @transaction.atomic
    def reorder_shots(self, request, pk=None):
        """Đảo thứ tự shots. shot_id giữ nguyên (anchor không break), chỉ đổi
        shot_order theo thứ tự `new_order` user đưa.

        Body: { new_order: [shot_id_1, shot_id_2, ...] }
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()

        new_order = request.data.get('new_order') or []
        if not isinstance(new_order, list) or not new_order:
            return Response({'detail': 'new_order rỗng'}, status=status.HTTP_400_BAD_REQUEST)

        existing_ids = set(sc.shots.values_list('shot_id', flat=True))
        new_order_set = set(new_order)
        if existing_ids != new_order_set:
            return Response({
                'detail': 'new_order phải chứa đúng các shot_id hiện có',
                'expected': sorted(existing_ids),
                'got': new_order,
            }, status=status.HTTP_400_BAD_REQUEST)

        previous_value = {
            'order': list(sc.shots.order_by('shot_order').values_list('shot_id', flat=True)),
        }
        for idx, shot_id in enumerate(new_order, start=1):
            sc.shots.filter(shot_id=shot_id).update(shot_order=idx)

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.REORDER_SHOTS,
            previous_value=previous_value,
            fields_changed={'new_order': new_order},
        )
        # v3.2.2 hotfix: renumber shot_id sau reorder
        _renumber_shot_ids(sc)
        sc.refresh_from_db()
        return Response(ContentScenarioSerializer(sc).data)

    # ─── 15. POST /{id}/optimize-whole/ ───────────────────────────────────
    @action(detail=True, methods=['post'], url_path='optimize-whole')
    def optimize_whole(self, request, pk=None):
        """Re-run full 3E pipeline trên scenario có sẵn. ~30s.

        Body: { variant_brief?: str }
        Returns: scenario đã optimize (CHƯA lưu DB — FE confirm rồi POST save).
        """
        self.throttle_scope = 'scenario_generate'
        sc = self.get_object()

        variant_brief = (request.data.get('variant_brief') or '').strip()
        brand_prompt = _resolve_brand_prompt(request.user, None)

        scenario_dict = _scenario_to_dict(sc)
        # Strip FE-only fields trước khi gửi
        scenario_dict_clean = {
            'title': scenario_dict.get('title', ''),
            'genre': scenario_dict.get('genre', 'seeding'),
            'duration_target_seconds': scenario_dict.get('duration_target_seconds', 30),
            'shot_count_target': scenario_dict.get('shot_count_target', 6),
            'global_character_registry': scenario_dict.get('character_registry', []),
            'shots': scenario_dict.get('shots', []),
        }

        auth = request.headers.get('Authorization')
        # v3.2.1 Phase 2
        agno_session = _agno_session_id(
            request.user.id if request.user.is_authenticated else None, sc.id
        )
        data, err = _agent_teams_post('/scenario/optimize-whole', {
            'scenario': scenario_dict_clean,
            'brand_prompt': brand_prompt,
            'variant_brief': variant_brief,
        }, auth, session_id=agno_session,
            user_id=str(request.user.id) if request.user.is_authenticated else '')
        if err:
            return Response({'detail': f'Optimize whole thất bại: {err}'},
                            status=status.HTTP_502_BAD_GATEWAY)

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.OPTIMIZE_WHOLE,
            fields_changed={
                'variant_brief': variant_brief,
                'iterations_used': data.get('iterations_used', 0),
                'final_avg_score': data.get('final_avg_score', 0.0),
            },
        )
        return Response({
            'scenario': data.get('scenario', {}),
            'warnings': data.get('warnings', []),
            'iterations_used': data.get('iterations_used', 0),
            'final_avg_score': data.get('final_avg_score', 0.0),
        })

    # ═════════════════════════════════════════════════════════════════════
    # v3.2.2 Phase 2 — 4 verb tool endpoint mới (toolset expansion)
    # ═════════════════════════════════════════════════════════════════════

    # ─── 15.1. POST /{id}/add-character/ ──────────────────────────────────
    @action(detail=True, methods=['post'], url_path='add-character')
    @transaction.atomic
    def add_character(self, request, pk=None):
        """Thêm 1 character mới vào registry.

        Body: {name, age, outfit_style, ethnicity?, voice_id_hint?}
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        name = (request.data.get('name') or '').strip()
        if not name:
            return Response({'detail': 'name là bắt buộc'},
                            status=status.HTTP_400_BAD_REQUEST)
        registry = list(sc.character_registry or [])
        # Check name unique (case-insensitive)
        if any(isinstance(c, dict) and (c.get('name') or '').lower() == name.lower()
               for c in registry):
            return Response({'detail': f'Character "{name}" đã tồn tại'},
                            status=status.HTTP_400_BAD_REQUEST)
        new_char = {
            'name': name,
            'age': (request.data.get('age') or '').strip(),
            'outfit_style': (request.data.get('outfit_style') or '').strip(),
            'ethnicity': (request.data.get('ethnicity') or 'Việt Nam').strip(),
            'voice_id_hint': (request.data.get('voice_id_hint') or '').strip(),
        }
        registry.append(new_char)
        sc.character_registry = registry
        sc.save(update_fields=['character_registry', 'updated_at'])
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.UPDATE_CHARACTER,
            character_name=name,
            fields_changed={'added_character': new_char},
            previous_value={'registry_before': registry[:-1]},
        )
        return Response({'added_character': new_char, 'registry': registry})

    # ─── 15.2. POST /{id}/move-shot/ ──────────────────────────────────────
    @action(detail=True, methods=['post'], url_path='move-shot')
    @transaction.atomic
    def move_shot(self, request, pk=None):
        """Di chuyển 1 shot tới vị trí mới (shot_order). KHÔNG đụng nội dung.

        Body: {shot_id: int, new_position: int (1-based)}
        Anchor FK self-reference KHÔNG break (DB FK giữ nguyên), nhưng visual
        flow có thể không hợp lý sau move — FE warn user.
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        try:
            shot_id = int(request.data.get('shot_id'))
            new_pos = int(request.data.get('new_position'))
        except (TypeError, ValueError):
            return Response({'detail': 'shot_id hoặc new_position sai'},
                            status=status.HTTP_400_BAD_REQUEST)
        shots = list(sc.shots.order_by('shot_order'))
        target = next((s for s in shots if s.shot_id == shot_id), None)
        if not target:
            return Response({'detail': f'Shot {shot_id} không tồn tại'},
                            status=status.HTTP_404_NOT_FOUND)
        new_pos = max(1, min(new_pos, len(shots)))
        old_pos = target.shot_order
        if new_pos == old_pos:
            return Response({'detail': 'new_position trùng vị trí hiện tại — bỏ qua'},
                            status=status.HTTP_200_OK)
        # Shift các shot khác
        if new_pos < old_pos:
            # Di chuyển lên: shots [new_pos, old_pos-1] +1
            for s in shots:
                if new_pos <= s.shot_order < old_pos and s.shot_id != shot_id:
                    s.shot_order += 1
                    s.save(update_fields=['shot_order'])
        else:
            # Di chuyển xuống: shots (old_pos, new_pos] -1
            for s in shots:
                if old_pos < s.shot_order <= new_pos and s.shot_id != shot_id:
                    s.shot_order -= 1
                    s.save(update_fields=['shot_order'])
        target.shot_order = new_pos
        target.save(update_fields=['shot_order'])

        # Check anchor break (shot bị move có anchor_source_shot không còn ở trước nó)
        anchor_break = False
        if target.anchor_source_shot:
            anchor_shot = next((s for s in shots if s.id == target.anchor_source_shot_id), None)
            if anchor_shot and anchor_shot.shot_order > new_pos:
                anchor_break = True

        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.REORDER_SHOTS,
            shot_id=shot_id,
            fields_changed={'from_order': old_pos, 'to_order': new_pos,
                            'anchor_break': anchor_break},
        )
        # v3.2.2 hotfix: renumber shot_id sau move
        _renumber_shot_ids(sc)
        # Shot_id của target có thể đã đổi → query lại by anchor (DB pk không đổi)
        target.refresh_from_db()
        return Response({
            'moved_shot_id': target.shot_id,
            'from_order': old_pos,
            'to_order': new_pos,
            'anchor_break_warning': anchor_break,
        })

    # ─── 15.3. POST /{id}/duplicate-shot/ ─────────────────────────────────
    @action(detail=True, methods=['post'], url_path='duplicate-shot')
    @transaction.atomic
    def duplicate_shot(self, request, pk=None):
        """Sao chép 1 shot. Shot mới chèn ngay sau shot gốc, shot_id = max+1."""
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        try:
            shot_id = int(request.data.get('shot_id'))
        except (TypeError, ValueError):
            return Response({'detail': 'shot_id sai'},
                            status=status.HTTP_400_BAD_REQUEST)
        shots = list(sc.shots.order_by('shot_order'))
        source = next((s for s in shots if s.shot_id == shot_id), None)
        if not source:
            return Response({'detail': f'Shot {shot_id} không tồn tại'},
                            status=status.HTTP_404_NOT_FOUND)
        # Reindex các shot order > source.shot_order +1
        for s in shots:
            if s.shot_order > source.shot_order:
                s.shot_order += 1
                s.save(update_fields=['shot_order'])
        new_shot_id = max((s.shot_id for s in shots), default=0) + 1
        new_shot = ContentScenarioShot.objects.create(
            scenario=sc, shot_id=new_shot_id, shot_order=source.shot_order + 1,
            funnel_part=source.funnel_part,
            character_in_frame=source.character_in_frame,
            continuity_mode=source.continuity_mode,
            anchor_source_shot=source.anchor_source_shot,
            voice_over=source.voice_over,
            kinetic_action=source.kinetic_action,
            camera_articulation=source.camera_articulation,
            background=source.background,
            character_pose=source.character_pose,
            prop_description=source.prop_description,
            texture_and_lighting=source.texture_and_lighting,
            music_hint=source.music_hint,
            brand_mention=source.brand_mention,
            prompt_injection=source.prompt_injection,
            warnings=source.warnings or [],
        )
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.INSERT_SHOT,
            shot_id=new_shot_id,
            fields_changed={'duplicated_from': shot_id, 'inserted_at_order': new_shot.shot_order},
        )
        # v3.2.2 hotfix: renumber shot_id sau duplicate
        _renumber_shot_ids(sc)
        new_shot.refresh_from_db()
        return Response({
            'duplicated_shot_id': new_shot.shot_id,
            'duplicated_from': shot_id,
            'shot_order': new_shot.shot_order,
        })

    # ─── 15.4. POST /{id}/batch-update-shots/ ─────────────────────────────
    @action(detail=True, methods=['post'], url_path='batch-update-shots')
    @transaction.atomic
    def batch_update_shots(self, request, pk=None):
        """Update nhiều shot cùng lúc (text fields). Cap N=5.

        Body: { updates: [{shot_id: int, fields: {field: value, ...}}, ...] }
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        updates = request.data.get('updates')
        if not isinstance(updates, list) or not updates:
            return Response({'detail': 'updates phải là list non-empty'},
                            status=status.HTTP_400_BAD_REQUEST)
        if len(updates) > 5:
            return Response({'detail': 'Cap N=5 — vượt giới hạn batch'},
                            status=status.HTTP_400_BAD_REQUEST)
        allowed_fields = {
            'character_in_frame', 'background', 'character_pose', 'kinetic_action',
            'camera_articulation', 'prop_description', 'texture_and_lighting',
            'voice_over', 'music_hint', 'funnel_part', 'brand_mention',
            'continuity_mode', 'prompt_injection',
        }
        results = []
        for u in updates:
            if not isinstance(u, dict):
                continue
            try:
                shot_id = int(u.get('shot_id'))
            except (TypeError, ValueError):
                continue
            try:
                shot = sc.shots.get(shot_id=shot_id)
            except ContentScenarioShot.DoesNotExist:
                results.append({'shot_id': shot_id, 'error': 'not_found'})
                continue
            fields = u.get('fields') or {}
            if not isinstance(fields, dict):
                continue
            previous = {k: getattr(shot, k) for k in fields if k in allowed_fields}
            applied = {}
            for k, v in fields.items():
                if k in allowed_fields:
                    setattr(shot, k, v)
                    applied[k] = v
            shot.warnings = _check_voice_over_warning(shot.voice_over) if 'voice_over' in applied else (shot.warnings or [])
            shot.save()
            ContentScenarioAuditLog.objects.create(
                scenario=sc, actor=request.user, action=AuditAction.UPDATE_SHOT,
                shot_id=shot_id, fields_changed=applied, previous_value=previous,
            )
            results.append({'shot_id': shot_id, 'updated_fields': list(applied.keys())})
        return Response({'batch_results': results, 'count': len(results)})

    # ─── 15.5. POST /{id}/plans/{plan_id}/execute/ — Plan & Execute ───────
    @action(detail=True, methods=['post'], url_path=r'plans/(?P<plan_id>\d+)/execute')
    def execute_plan(self, request, pk=None, plan_id=None):
        """Execute 1 plan đã proposed → chạy từng step tuần tự (best-effort).

        Sync trong v3.2.2 — Daphne SSE buffer chưa fix (defer §8 doc 2A).
        Trả về plan state cuối cùng (status, steps[].status).

        Body: {} (không cần data — plan_id trong URL)
        Returns:
          {plan_id, status, steps: [{tool_name, status, result, error}], ...}
        """
        self.throttle_scope = 'scenario_generate'
        sc = self.get_object()
        try:
            plan = ContentScenarioPlan.objects.get(pk=int(plan_id), scenario=sc,
                                                    owner=request.user)
        except (ContentScenarioPlan.DoesNotExist, ValueError):
            return Response({'detail': 'Plan không tồn tại'},
                            status=status.HTTP_404_NOT_FOUND)
        if plan.status not in (PlanStatus.PROPOSED, PlanStatus.FAILED):
            return Response(
                {'detail': f'Plan đang ở status {plan.status} — không thể execute'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        plan.status = PlanStatus.EXECUTING
        plan.executed_at = timezone.now()
        plan.save(update_fields=['status', 'executed_at', 'updated_at'])

        # Reset counters
        completed = 0
        failed = 0
        # T22 — cho phép duyệt 1 PHẦN: body {step_indices:[0,2]} → chỉ chạy các bước đó, còn lại 'skipped'.
        # (User có thể chấp nhận ít thay đổi hơn số AI đề xuất.) Không gửi → chạy tất cả.
        _sel = request.data.get('step_indices')
        sel_idx = set(_sel) if isinstance(_sel, list) else None
        # Execute steps sequential — best-effort
        steps = list(plan.steps or [])
        for i, step in enumerate(steps):
            if step.get('status') == 'done':
                continue  # T22 — đã chạy lần trước (duyệt từng phần) → KHÔNG chạy lại.
            if sel_idx is not None and i not in sel_idx:
                step['status'] = 'skipped'
                plan.steps = steps
                plan.save(update_fields=['steps', 'updated_at'])
                continue
            tool_name = step.get('tool_name')
            args = step.get('tool_args_preview') or {}
            step['status'] = 'running'
            plan.steps = steps
            plan.save(update_fields=['steps', 'updated_at'])

            try:
                result = _execute_plan_step(
                    sc, request.user, tool_name, args,
                    jwt_auth=request.headers.get('Authorization'),
                )
                step['status'] = 'done'
                step['result'] = result
                step['error'] = None
                completed += 1
            except Exception as exc:  # noqa: BLE001
                logger.exception('Plan step %s (tool=%s) failed', i, tool_name)
                step['status'] = 'failed'
                step['error'] = str(exc)[:200]
                step['result'] = None
                failed += 1
                # Best-effort: continue next step (KHÔNG rollback prior done steps)

        plan.steps = steps
        plan.completed_steps = sum(1 for s in steps if s.get('status') == 'done')
        plan.failed_steps = failed
        plan.completed_at = timezone.now()
        # T22 — còn bước 'skipped'/'pending' (duyệt 1 phần) → giữ PROPOSED để execute phần còn lại sau.
        _has_pending = any(s.get('status') in ('skipped', 'pending') for s in steps)
        if failed:
            plan.status = PlanStatus.FAILED
        elif _has_pending:
            plan.status = PlanStatus.PROPOSED
        else:
            plan.status = PlanStatus.COMPLETED
        plan.save(update_fields=[
            'steps', 'completed_steps', 'failed_steps',
            'completed_at', 'status', 'updated_at',
        ])
        ContentScenarioAuditLog.objects.create(
            scenario=sc, actor=request.user, action=AuditAction.UPDATE_SHOT,
            fields_changed={
                'plan_id': plan.id,
                'plan_goal': plan.goal,
                'completed': completed,
                'failed': failed,
            },
        )
        return Response({
            'plan_id': plan.id,
            'status': plan.status,
            'steps': steps,
            'completed_steps': completed,
            'failed_steps': failed,
            'completed_at': plan.completed_at,
        })

    # ─── 15.7. POST /{id}/scan/ — v3.2.2 Phase 3 (measurable scoring) ─────
    @action(detail=True, methods=['post'], url_path='scan')
    def scan_scenario(self, request, pk=None):
        """Chấm 5 dimension cho scenario. ~5-8s LLM call.

        FE có thể trigger trực tiếp (không qua chat) — vd nút "Phân tích" trên
        header. Trả về scores + strengths/weaknesses/recommendations.
        """
        self.throttle_scope = 'scenario_chat'
        sc = self.get_object()
        scenario_dict = _scenario_to_dict(sc)
        brand_prompt = _resolve_brand_prompt(request.user, None)
        result = _handle_scan_scenario(scenario_dict, brand_prompt)
        if 'error' in result:
            return Response({'detail': result['error']},
                            status=status.HTTP_502_BAD_GATEWAY)
        return Response(result)

    # ─── 15.6. POST /{id}/plans/{plan_id}/cancel/ ─────────────────────────
    @action(detail=True, methods=['post'], url_path=r'plans/(?P<plan_id>\d+)/cancel')
    def cancel_plan(self, request, pk=None, plan_id=None):
        """Đánh dấu plan = CANCELLED (chưa execute hoặc đang EXECUTING)."""
        sc = self.get_object()
        try:
            plan = ContentScenarioPlan.objects.get(pk=int(plan_id), scenario=sc,
                                                    owner=request.user)
        except (ContentScenarioPlan.DoesNotExist, ValueError):
            return Response({'detail': 'Plan không tồn tại'},
                            status=status.HTTP_404_NOT_FOUND)
        if plan.status in (PlanStatus.COMPLETED, PlanStatus.CANCELLED):
            return Response({'detail': f'Plan đã ở status {plan.status}'},
                            status=status.HTTP_400_BAD_REQUEST)
        plan.status = PlanStatus.CANCELLED
        plan.save(update_fields=['status', 'updated_at'])
        return Response({'plan_id': plan.id, 'status': plan.status})

    # ═════════════════════════════════════════════════════════════════════
    # v3.2 — Nhóm C: Generate variant + Export xlsx
    # ═════════════════════════════════════════════════════════════════════

    # ─── 16. POST /{id}/generate-variant/ ──────────────────────────────────
    @action(detail=True, methods=['post'], url_path='generate-variant')
    def generate_variant(self, request, pk=None):
        """Sinh variant từ scenario gốc. Reuse intent_json + brief cũ → skip
        Layer 2 Parser → tiết kiệm ~5s + $0.002.

        Body: {
            brief?: str (default = brief gốc),
            variant_prompt?: str ('tone bí ẩn hơn'),
            duration_target_seconds?: int,
            shot_count_target?: int,
            genre?: str,
        }
        Trả ScenarioJSON mới (chưa lưu DB — FE navigate /draft với state này).
        """
        self.throttle_scope = 'scenario_generate'
        original = self.get_object()

        brief = (request.data.get('brief') or original.brief).strip()
        variant_prompt = (request.data.get('variant_prompt') or '').strip()
        genre = request.data.get('genre') or original.genre

        try:
            duration = int(request.data.get('duration_target_seconds') or original.duration_target_seconds)
            shot_count = int(request.data.get('shot_count_target') or original.shot_count_target)
        except (ValueError, TypeError):
            return Response({'detail': 'duration/shot_count sai'}, status=status.HTTP_400_BAD_REQUEST)

        duration = max(10, min(120, duration))
        shot_count = max(1, min(20, shot_count))

        brand_prompt = _resolve_brand_prompt(request.user, None)

        # Compose brief với variant_prompt nếu có
        composed_brief = (
            f'{brief}\n\n[VARIANT REQUEST]: {variant_prompt}'
            if variant_prompt else brief
        )

        auth = request.headers.get('Authorization')
        # v3.2.1 Phase 2: dùng session từ scenario gốc (variant share session với scenario cha
        # → AI nhớ "lần variant trước user thích tone X")
        agno_session = _agno_session_id(
            request.user.id if request.user.is_authenticated else None, original.id
        )
        data, err = _agent_teams_post('/scenario/generate', {
            'brief': composed_brief,
            'duration_target_seconds': duration,
            'shot_count_target': shot_count,
            'genre': genre,
            'brand_prompt': brand_prompt,
            'intent_json': original.intent_json or {},  # ← REUSE — skip Layer 2 Parser
            'raw_text': '',
        }, auth, session_id=agno_session,
            user_id=str(request.user.id) if request.user.is_authenticated else '')
        if err:
            return Response({'detail': f'Sinh variant thất bại: {err}'},
                            status=status.HTTP_502_BAD_GATEWAY)

        ContentScenarioAuditLog.objects.create(
            scenario=original, actor=request.user, action=AuditAction.GENERATE_VARIANT,
            fields_changed={'variant_prompt': variant_prompt, 'genre': genre,
                            'duration': duration, 'shot_count': shot_count},
        )
        return Response({
            'scenario': data.get('scenario', {}),
            'intent_json': original.intent_json or {},
            'source_file_name': '',
            'warning': None,
        })

    # ─── 17. GET /{id}/export/?as=xlsx ────────────────────────────────────
    @action(detail=True, methods=['get'], url_path='export')
    def export_scenario(self, request, pk=None):
        """Export scenario sang format share-able.

        Query: ?as=xlsx (v3.2 chỉ hỗ trợ xlsx; pdf/gen3 v3.3+).

        BUG FIX v3.2.1: trước dùng `?format=xlsx` — collide với DRF's content
        negotiation `format` query (DRF không match được URL với format=xlsx
        → trả 404). Đổi sang `?as=xlsx` để né.
        """
        sc = self.get_object()
        fmt = (request.query_params.get('as') or 'xlsx').lower()

        if fmt != 'xlsx':
            return Response({
                'detail': f'Format {fmt!r} chưa hỗ trợ ở v3.2. Chỉ xlsx.',
            }, status=status.HTTP_400_BAD_REQUEST)

        buf = _build_scenario_xlsx(sc)
        from django.http import HttpResponse
        response = HttpResponse(
            buf.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        safe_title = ''.join(c if c.isalnum() else '_' for c in (sc.title or 'scenario'))[:64]
        response['Content-Disposition'] = (
            f'attachment; filename="scenario-{sc.id}-{safe_title}.xlsx"'
        )
        return response
