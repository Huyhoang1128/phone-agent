"""CALL_N8N_WORKFLOW action handler — HTTP POST sync sang n8n webhook.

Pattern copy từ chatbot prod `core-chat/agent/rag_agent.py:582-699`
(`call_webhook()`). Adapt:
- Config từ WorkflowStep.action_config (template, retry, timeout)
- Render template (Jinja-like) với context = trigger payload + step outputs
- Parse response theo JSONPath mapping

Config schema (WorkflowStep.action_config):
    type: CALL_N8N_WORKFLOW
    webhook_url: https://n8n.example.com/webhook/tiktok-dm-reply
    timeout_seconds: 120        # default
    retry_count: 3              # default
    retry_backoff_seconds: [2, 5, 10]
    payload_template:
      peer_handle: '{{ trigger.peer_handle }}'
      current_message: '{{ trigger.content }}'
    response_mapping:
      reply_text: '$.reply_text'

Return: dict các field theo `response_mapping`. Vd `{'reply_text': '...'}`.
Step kế tiếp tham chiếu qua `{{ context.step1.reply_text }}`.
"""
from __future__ import annotations

import json
import logging
import time

import requests

from workflow.runner.executor import register_handler
from workflow.runner.template import apply_response_mapping, render_value

logger = logging.getLogger(__name__)


# Default values khi action_config không khai báo.
DEFAULT_TIMEOUT = 120  # seconds
DEFAULT_RETRY_COUNT = 3
DEFAULT_BACKOFF = [2, 5, 10]
N8N_INACTIVE_MARKERS = ('is not registered', 'workflow must be active')


class N8nRetriableError(Exception):
    """Error đáng retry (5xx, timeout, n8n inactive 404)."""


class N8nPermanentError(Exception):
    """Error fail-fast (4xx khác 404-inactive, 200 với body lỗi)."""


@register_handler('CALL_N8N_WORKFLOW')
def call_n8n_workflow(step, run, ctx: dict) -> dict:
    """Execute CALL_N8N_WORKFLOW step.

    Raises:
        N8nPermanentError: lỗi fail-fast (no retry).
        N8nRetriableError: hết max retry mà vẫn fail → stream layer pickup retry.

    Returns:
        dict các field extracted theo `response_mapping`.
    """
    cfg = step.action_config or {}

    webhook_url = cfg.get('webhook_url') or ''
    if not webhook_url:
        raise N8nPermanentError(
            f'CALL_N8N_WORKFLOW step={step.id} thiếu webhook_url'
        )

    timeout = int(cfg.get('timeout_seconds') or DEFAULT_TIMEOUT)
    max_retry = int(cfg.get('retry_count') or DEFAULT_RETRY_COUNT)
    backoff = cfg.get('retry_backoff_seconds') or DEFAULT_BACKOFF
    payload_template = cfg.get('payload_template') or {}
    response_mapping = cfg.get('response_mapping') or {'reply_text': '$.reply_text'}

    # Render payload từ template.
    payload = render_value(payload_template, ctx)
    if not isinstance(payload, dict):
        # Fallback: nếu template render ra non-dict (vd template rỗng) → empty dict.
        payload = {}

    logger.info(
        'CALL_N8N_WORKFLOW run=%s step=%s url=%s timeout=%ss',
        run.id, step.id, webhook_url, timeout,
    )

    attempt_errors: list[str] = []
    last_error = ''
    for attempt in range(max_retry):
        try:
            resp = requests.post(
                webhook_url,
                json=payload,
                timeout=timeout,
                headers={'Content-Type': 'application/json'},
            )
        except requests.exceptions.Timeout as exc:
            last_error = f'timeout after {timeout}s: {exc!r}'
            attempt_errors.append(f'attempt {attempt + 1}: {last_error}')
            logger.warning(
                'CALL_N8N_WORKFLOW timeout run=%s attempt=%s/%s url=%s',
                run.id, attempt + 1, max_retry, webhook_url,
            )
            if attempt < max_retry - 1:
                _sleep_backoff(backoff, attempt)
                continue
            raise N8nRetriableError(last_error)
        except requests.exceptions.ConnectionError as exc:
            last_error = f'connection error: {exc!r}'
            attempt_errors.append(f'attempt {attempt + 1}: {last_error}')
            logger.warning(
                'CALL_N8N_WORKFLOW connection error run=%s attempt=%s/%s',
                run.id, attempt + 1, max_retry,
            )
            if attempt < max_retry - 1:
                _sleep_backoff(backoff, attempt)
                continue
            raise N8nRetriableError(last_error)
        except requests.exceptions.RequestException as exc:
            # Lỗi khác (vd InvalidURL) — fail fast.
            raise N8nPermanentError(f'requests exception: {exc!r}')

        # ── 200 OK ──────────────────────────────────────────────────────────
        if resp.status_code == 200:
            response_body = _parse_response_body(resp)
            mapped = apply_response_mapping(response_body, response_mapping)

            # Guard: nếu response_mapping CÓ định nghĩa keys NHƯNG toàn extract
            # ra None/empty → n8n response không khớp schema (vd LLM trả JSON
            # bọc trong markdown ```json...``` khiến downstream parse fail).
            # Fail fast ở đây thay vì để empty payload cascade xuống Step kế.
            if response_mapping and mapped and _all_empty(mapped):
                raise N8nPermanentError(
                    f'n8n trả 200 nhưng response_mapping extract toàn None/empty. '
                    f'mapped={mapped} | response_body[:300]={str(response_body)[:300]!r} | '
                    f'Có thể LLM trả JSON wrapped trong markdown ```json...``` — '
                    f'kiểm tra Respond to Webhook node expression hoặc enable JSON output.'
                )

            logger.info(
                'CALL_N8N_WORKFLOW success run=%s step=%s mapped_keys=%s',
                run.id, step.id, list(mapped.keys()),
            )
            return mapped

        # ── 404 — phân biệt n8n inactive vs URL sai ─────────────────────────
        if resp.status_code == 404:
            body_text = resp.text or ''
            is_n8n_inactive = any(m in body_text for m in N8N_INACTIVE_MARKERS)
            if is_n8n_inactive:
                last_error = f'404 n8n inactive: {body_text[:200]!r}'
                attempt_errors.append(f'attempt {attempt + 1}: {last_error}')
                logger.warning(
                    'CALL_N8N_WORKFLOW n8n inactive run=%s attempt=%s/%s',
                    run.id, attempt + 1, max_retry,
                )
                if attempt < max_retry - 1:
                    _sleep_backoff(backoff, attempt)
                    continue
                raise N8nRetriableError(last_error)
            # 404 URL sai — fail fast.
            raise N8nPermanentError(
                f'404 URL not found: {webhook_url} body[:300]={body_text[:300]!r}'
            )

        # ── 5xx — retry ─────────────────────────────────────────────────────
        if 500 <= resp.status_code < 600:
            last_error = (
                f'HTTP {resp.status_code} | body[:300]={resp.text[:300]!r}'
            )
            attempt_errors.append(f'attempt {attempt + 1}: {last_error}')
            logger.warning(
                'CALL_N8N_WORKFLOW 5xx run=%s attempt=%s/%s status=%s',
                run.id, attempt + 1, max_retry, resp.status_code,
            )
            if attempt < max_retry - 1:
                # Honor Retry-After header nếu có.
                retry_after = resp.headers.get('Retry-After')
                if retry_after and retry_after.isdigit():
                    time.sleep(int(retry_after))
                else:
                    _sleep_backoff(backoff, attempt)
                continue
            raise N8nRetriableError(last_error)

        # ── 4xx khác (400, 401, 403, ...) — fail fast ───────────────────────
        raise N8nPermanentError(
            f'HTTP {resp.status_code} | body[:300]={resp.text[:300]!r}'
        )

    # Defensive — không nên reach.
    raise N8nRetriableError(
        f'CALL_N8N_WORKFLOW exhausted {max_retry} retries: {attempt_errors}'
    )


# ── Helpers ──────────────────────────────────────────────────────────────────


def _all_empty(mapped: dict) -> bool:
    """True nếu mọi value trong mapped đều None/empty-string/empty-collection."""
    for v in mapped.values():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, (list, tuple, dict)) and not v:
            continue
        return False  # có ít nhất 1 value hợp lệ
    return True


def _sleep_backoff(backoff_seconds: list, attempt: int) -> None:
    """Sleep theo backoff config — chỉ số attempt (0-based)."""
    if not backoff_seconds:
        return
    idx = min(attempt, len(backoff_seconds) - 1)
    seconds = backoff_seconds[idx]
    if seconds and seconds > 0:
        time.sleep(seconds)


def _parse_response_body(resp: requests.Response) -> dict:
    """Parse response body sang dict.

    Xử lý n8n response variance (theo chatbot prod):
    - JSON dict: return as-is.
    - JSON string (vd n8n trả "Hello"): wrap thành `{'_text': string}` để
      JSONPath `$._text` extract được.
    - Plain text: wrap thành `{'_text': text}`.
    - Empty: `{}`.
    """
    text = resp.text or ''
    if not text.strip():
        return {}
    try:
        parsed = resp.json()
    except (ValueError, json.JSONDecodeError):
        return {'_text': text}

    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, str):
        # n8n trả "..." quoted JSON string
        try:
            inner = json.loads(parsed)
            if isinstance(inner, dict):
                return inner
        except (ValueError, json.JSONDecodeError):
            pass
        return {'_text': parsed}
    # list / number / bool — wrap.
    return {'_value': parsed}
