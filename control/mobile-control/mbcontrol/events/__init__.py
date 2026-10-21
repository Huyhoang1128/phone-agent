from .enums import EVENT_DEFINITIONS, EventSourceType, SystemEvent


def dispatch_event(*args, **kwargs):
    from .dispatcher import dispatch_event as _dispatch_event

    return _dispatch_event(*args, **kwargs)


__all__ = ['dispatch_event', 'SystemEvent', 'EventSourceType', 'EVENT_DEFINITIONS']
