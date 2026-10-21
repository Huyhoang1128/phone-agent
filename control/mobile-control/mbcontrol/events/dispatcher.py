from __future__ import annotations

import logging
from collections.abc import Mapping

from .enums import EventSourceType, SystemEvent
from .handlers import handle_event_triggers

logger = logging.getLogger(__name__)


def dispatch_event(
    event_name: SystemEvent | str,
    source_type: EventSourceType | str,
    source_id: int,
    payload: Mapping[str, object] | None = None,
) -> None:
    """Dispatch a system event to matching workflow event triggers."""
    normalized_event = event_name.value if isinstance(event_name, SystemEvent) else str(event_name)
    normalized_source = source_type.value if isinstance(source_type, EventSourceType) else str(source_type)
    event_payload = dict(payload or {})

    logger.info(
        'Dispatching event=%s source=%s:%s',
        normalized_event,
        normalized_source,
        source_id,
    )
    handle_event_triggers(
        event_name=normalized_event,
        source_type=normalized_source,
        source_id=source_id,
        payload=event_payload,
    )

