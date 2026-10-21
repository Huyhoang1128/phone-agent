import json
import logging

from django.conf import settings

logger = logging.getLogger(__name__)


def get_auto_schedule_params(profile):
    """
    Fetch all ProfileRoutine entries for *profile*, send them to OpenAI
    (gpt-4o-mini), and return a dict of schedule parameters suitable for
    ScheduleSerializer.

    Returns:
        dict   – schedule params on success.
        None   – if the OpenAI API key is not configured.
        raises – RuntimeError if the OpenAI call or JSON parsing fails.
    """
    from .models import ProfileRoutine
    from .serializers import ProfileRoutineSerializer

    api_key = getattr(settings, 'OPENAI_API_KEY', '')
    if not api_key:
        return None

    routines = ProfileRoutine.objects.filter(profile=profile).order_by('schedule_time')
    routines_data = ProfileRoutineSerializer(routines, many=True).data

    if routines_data:
        routines_text = '\n'.join(
            f"- {r['schedule_time']} | cron: {r['cron_expression']} | action: {r['action']}"
            for r in routines_data
        )
    else:
        routines_text = '(No routines defined)'

    system_prompt = (
        'You are a scheduling assistant. Given a profile\'s daily routines, '
        'decide the best time to run an automated task for this profile. '
        'Choose one of the schedule types: "once", "interval", or "cron". '
        'Return ONLY a valid JSON object with the following schema (no extra keys):\n'
        '{\n'
        '  "schedule_type": "once" | "interval" | "cron",\n'
        '  "run_at": "<ISO-8601 datetime, only for once>",\n'
        '  "interval_seconds": <integer, only for interval>,\n'
        '  "cron_expression": "<5-field cron, only for cron>"\n'
        '}\n'
        'Omit keys that do not apply to the chosen schedule_type. '
        'For "once", run_at must be a future UTC datetime. '
        'For "interval", a sensible default is 86400 (24 h). '
        'For "cron", prefer a time that does NOT conflict with the listed routines.'
    )

    user_prompt = (
        f'Profile daily routines:\n{routines_text}\n\n'
        'Pick the best schedule for a background task that should not disrupt the user\'s routine. '
        'Return only the JSON object.'
    )

    try:
        import re  # noqa: PLC0415
        from openai import OpenAI  # noqa: PLC0415

        client = OpenAI(api_key=api_key)
        chat_response = client.chat.completions.create(
            model='gpt-4o-mini',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_prompt},
            ],
            temperature=0.3,
            max_tokens=256,
        )

        raw = chat_response.choices[0].message.content.strip()
        # Extract JSON from optional markdown code fences
        fence_match = re.search(r'```(?:\w+)?\s*([\s\S]*?)```', raw)
        if fence_match:
            raw = fence_match.group(1).strip()

        params = json.loads(raw)
        if not isinstance(params, dict):
            raise ValueError('OpenAI did not return a JSON object')

    except (json.JSONDecodeError, ValueError, KeyError, IndexError) as exc:
        logger.exception('auto_schedule: OpenAI response parsing failed for profile %s', profile.pk)
        raise RuntimeError('Failed to parse OpenAI auto-schedule response') from exc
    except Exception as exc:  # noqa: BLE001 – catch OpenAI network/API errors
        logger.exception('auto_schedule: OpenAI call failed for profile %s', profile.pk)
        raise RuntimeError('OpenAI auto-schedule call failed') from exc

    return params


def generate_profile_topics(profile, existing_topics=None, count=5):
    api_key = getattr(settings, 'OPENAI_API_KEY', '')
    if not api_key:
        return None

    personality = (profile.personality or '').strip()
    goal = (profile.goal or '').strip()
    history = [str(item.get('topic', '')).strip() for item in (profile.topic_history or []) if isinstance(item, dict)]
    existing_topics = [str(item).strip() for item in (existing_topics or []) if str(item).strip()]

    system_prompt = (
        'You are a content strategist. Based on profile personality and goals, '
        f'suggest exactly {count} short channel topics. '
        'Return only valid JSON in this shape: {"topics": ["...", "..."]}. '
        'Each topic must be concise, practical, and unique.'
    )

    user_prompt = (
        f'Personality:\n{personality or "(empty)"}\n\n'
        f'Goal:\n{goal or "(empty)"}\n\n'
        f'Existing topics:\n{", ".join(existing_topics) if existing_topics else "(none)"}\n\n'
        f'Historical topics:\n{", ".join([item for item in history if item]) if history else "(none)"}\n\n'
        'Generate new topics that avoid repeating existing/historical topics.'
    )

    try:
        import re  # noqa: PLC0415
        from openai import OpenAI  # noqa: PLC0415

        client = OpenAI(api_key=api_key)
        chat_response = client.chat.completions.create(
            model='gpt-4o-mini',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_prompt},
            ],
            temperature=0.7,
            max_tokens=300,
        )

        raw = chat_response.choices[0].message.content.strip()
        fence_match = re.search(r'```(?:\w+)?\s*([\s\S]*?)```', raw)
        if fence_match:
            raw = fence_match.group(1).strip()
        payload = json.loads(raw)
        topics = payload.get('topics', []) if isinstance(payload, dict) else []
        if not isinstance(topics, list):
            raise ValueError('OpenAI topics payload must contain list field "topics"')

        normalized = []
        seen = set()
        used = {item.lower() for item in existing_topics if item}
        for value in topics:
            topic = str(value).strip()
            lowered = topic.lower()
            if not topic or lowered in seen or lowered in used:
                continue
            seen.add(lowered)
            normalized.append(topic)
            if len(normalized) >= count:
                break

        if not normalized:
            raise ValueError('OpenAI returned no valid topics')
        return normalized
    except (json.JSONDecodeError, ValueError, KeyError, IndexError) as exc:
        logger.exception('generate_profile_topics: response parsing failed for profile %s', profile.pk)
        raise RuntimeError('Failed to parse generated topics response') from exc
    except Exception as exc:  # noqa: BLE001 – catch OpenAI network/API errors
        logger.exception('generate_profile_topics: OpenAI call failed for profile %s', profile.pk)
        raise RuntimeError('Generated topics call failed') from exc
