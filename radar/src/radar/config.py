"""Immutable runtime configuration for the radar service."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

_DEFAULT_INTERVAL_SECONDS = 60.0
_DEFAULT_LOG_LEVEL = "INFO"
_DEFAULT_MAX_RUNTIME_SECONDS = 0.0
_DEFAULT_BACKOFF_BASE_SECONDS = 1.0
_DEFAULT_BACKOFF_MAX_SECONDS = 60.0


def _read_float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number, got {raw!r}") from exc
    if not math.isfinite(value):
        raise ValueError(f"{key} must be finite, got {value}")
    if value < 0:
        raise ValueError(f"{key} must not be negative, got {value}")
    return value


@dataclass(frozen=True, slots=True)
class Config:
    interval_seconds: float = _DEFAULT_INTERVAL_SECONDS
    log_level: str = _DEFAULT_LOG_LEVEL
    lock_path: str | None = None
    max_runtime_seconds: float = _DEFAULT_MAX_RUNTIME_SECONDS
    backoff_base_seconds: float = _DEFAULT_BACKOFF_BASE_SECONDS
    backoff_max_seconds: float = _DEFAULT_BACKOFF_MAX_SECONDS

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        source = os.environ if env is None else env
        return cls(
            interval_seconds=_read_float(source, "RADAR_INTERVAL_SECONDS", _DEFAULT_INTERVAL_SECONDS),
            log_level=source.get("RADAR_LOG_LEVEL", _DEFAULT_LOG_LEVEL).upper(),
            lock_path=source.get("RADAR_LOCK_PATH") or None,
            max_runtime_seconds=_read_float(source, "RADAR_MAX_RUNTIME_SECONDS", _DEFAULT_MAX_RUNTIME_SECONDS),
            backoff_base_seconds=_read_float(source, "RADAR_BACKOFF_BASE_SECONDS", _DEFAULT_BACKOFF_BASE_SECONDS),
            backoff_max_seconds=_read_float(source, "RADAR_BACKOFF_MAX_SECONDS", _DEFAULT_BACKOFF_MAX_SECONDS),
        )
