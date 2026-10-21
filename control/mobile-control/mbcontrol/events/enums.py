from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class EventSourceType(str, Enum):
    DEVICE = 'device'
    TEAM = 'team'
    USER = 'user'

    @classmethod
    def choices(cls) -> list[tuple[str, str]]:
        return [(member.value, member.value.capitalize()) for member in cls]


class SystemEvent(str, Enum):
    DEVICE_NOTIFY = 'device.notify'
    DEVICE_CONNECTED = 'device.connected'
    DEVICE_DISCONNECTED = 'device.disconnected'
    TASK_CREATED = 'task.created'
    TASK_DONE = 'task.done'
    SCHEDULE_CREATED = 'schedule.created'
    SCHEDULE_RUN = 'schedule.run'

    @classmethod
    def choices(cls) -> list[tuple[str, str]]:
        return [(member.value, member.value) for member in cls]


@dataclass(frozen=True, slots=True)
class EventDefinition:
    name: SystemEvent
    label: str
    source_type: EventSourceType


EVENT_DEFINITIONS: tuple[EventDefinition, ...] = (
    EventDefinition(SystemEvent.DEVICE_NOTIFY, 'Device Notification', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.DEVICE_CONNECTED, 'Device Connected', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.DEVICE_DISCONNECTED, 'Device Disconnected', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.TASK_CREATED, 'Task Created', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.TASK_CREATED, 'Task Created', EventSourceType.TEAM),
    EventDefinition(SystemEvent.TASK_CREATED, 'Task Created', EventSourceType.USER),
    EventDefinition(SystemEvent.TASK_DONE, 'Task Done', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.TASK_DONE, 'Task Done', EventSourceType.TEAM),
    EventDefinition(SystemEvent.TASK_DONE, 'Task Done', EventSourceType.USER),
    EventDefinition(SystemEvent.SCHEDULE_CREATED, 'Schedule Created', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.SCHEDULE_CREATED, 'Schedule Created', EventSourceType.TEAM),
    EventDefinition(SystemEvent.SCHEDULE_CREATED, 'Schedule Created', EventSourceType.USER),
    EventDefinition(SystemEvent.SCHEDULE_RUN, 'Schedule Run', EventSourceType.DEVICE),
    EventDefinition(SystemEvent.SCHEDULE_RUN, 'Schedule Run', EventSourceType.TEAM),
    EventDefinition(SystemEvent.SCHEDULE_RUN, 'Schedule Run', EventSourceType.USER),
)

