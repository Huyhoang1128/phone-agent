from collections.abc import Callable

from .models import Task, TaskStep

SystemTaskHandler = Callable[[Task, TaskStep], dict]
_REGISTRY: dict[str, SystemTaskHandler] = {}


def register(name: str):
    """Decorator to register a system task handler by name."""

    def decorator(func: SystemTaskHandler):
        _REGISTRY[name] = func
        return func

    return decorator


def get_handler(name: str) -> SystemTaskHandler | None:
    return _REGISTRY.get(name)


def list_handlers() -> list[str]:
    return list(_REGISTRY.keys())
