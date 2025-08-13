"""Utilities for marking API compatibility checks."""

from __future__ import annotations

from typing import Callable, TypeVar, Any

F = TypeVar("F", bound=Callable[..., Any])


def check_compat(*, enable: bool = True) -> Callable[[F], F]:
    """Decorator used by stronghold to toggle API compatibility checks.

    When ``enable`` is ``False`` the decorated function will be skipped by the
    backward compatibility linter.
    """

    def decorator(func: F) -> F:
        # Not used in the linter, but useful for debugging.
        setattr(func, "_bc_linter_enable", enable)
        return func

    return decorator

# Alias decorator to unconditionally disable the backward compatibility linter.
skip: Callable[[F], F] = check_compat(enable=False)
