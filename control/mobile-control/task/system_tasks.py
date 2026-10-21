import logging

import requests

from .registry import register

logger = logging.getLogger(__name__)


@register('call_webhook')
def call_webhook(task, step):
    params = step.params if isinstance(step.params, dict) else {}
    url = params.get('url')
    if not url:
        raise ValueError('Missing "url" in step params.')
    reserved_keys = {'task_id', 'url'}
    extra_params = {k: v for k, v in params.items() if k not in reserved_keys}
    payload = {'task_id': task.id, **extra_params}
    try:
        response = requests.post(url, json=payload, timeout=15)
        response.raise_for_status()
    except requests.RequestException as exc:
        status_code = getattr(getattr(exc, 'response', None), 'status_code', None)
        if status_code is not None:
            raise RuntimeError(f'Webhook call to {url} failed with status {status_code}.') from exc
        raise RuntimeError(f'Webhook call to {url} failed: {exc}') from exc
    content_type = response.headers.get('content-type', '')
    if 'application/json' in content_type.lower():
        return response.json()
    return {'status_code': response.status_code, 'body': response.text}


@register('log_task')
def log_task(task, step):
    logger.info('System task %s executed by log_task with params=%s', task.id, step.params)
    return {'logged': True, 'task_id': task.id}
