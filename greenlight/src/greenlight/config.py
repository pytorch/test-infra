"""Immutable runtime configuration for the greenlight service."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

_DEFAULT_INTERVAL_SECONDS = 60.0
_DEFAULT_LOG_LEVEL = "INFO"
_DEFAULT_MAX_RUNTIME_SECONDS = 600.0
_DEFAULT_BACKOFF_BASE_SECONDS = 1.0
_DEFAULT_BACKOFF_MAX_SECONDS = 60.0
_DEFAULT_MERGE_RULES_TTL_SECONDS = 600.0
_DEFAULT_REVIEW_WINDOW_HOURS = 24.0
_DEFAULT_DRCI_POKE_DELAY_SECONDS = 10.0
_DEFAULT_DRCI_RENDERS_STATUS_COMMENT = False

# darwin setitimer and Event.wait overflow for values near their 2**63-nanosecond
# ceiling; 30 days sits safely below that yet exceeds any realistic interval or runtime.
_MAX_SECONDS = 2_592_000.0

# The review window is a recency comparison, never fed to setitimer/Event.wait, so it has
# no overflow ceiling; this cap only rejects a fat-fingered value while allowing any
# realistic horizon.
_MAX_REVIEW_WINDOW_HOURS = 8760.0

_POSITIVE_FIELDS = ("interval_seconds", "backoff_base_seconds", "backoff_max_seconds", "merge_rules_ttl_seconds")
_NON_NEGATIVE_FIELDS = ("max_runtime_seconds", "drci_poke_delay_seconds")

_TRUE_VALUES: frozenset[str] = frozenset({"1", "on", "true", "yes"})
_FALSE_VALUES: frozenset[str] = frozenset({"0", "off", "false", "no"})


def _clean(raw: str | None) -> str | None:
    if raw is None or raw.strip() == "":
        return None
    return raw


def _normalize_log_level(raw: str) -> str:
    stripped = raw.strip()
    return stripped.upper() if stripped else _DEFAULT_LOG_LEVEL


def _read_float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = _clean(env.get(key))
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number, got {raw!r}") from exc


def _read_bool(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = _clean(env.get(key))
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    accepted = ", ".join(sorted(_TRUE_VALUES | _FALSE_VALUES))
    raise ValueError(f"{key} must be one of {accepted}, got {raw!r}")


def _validate_bound(name: str, value: float, *, allow_zero: bool, max_value: float = _MAX_SECONDS) -> None:
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite, got {value}")
    if value > max_value:
        raise ValueError(f"{name} must not exceed {max_value:.0f}, got {value}")
    if allow_zero:
        if value < 0:
            raise ValueError(f"{name} must not be negative, got {value}")
    elif value <= 0:
        raise ValueError(f"{name} must be positive, got {value}")


@dataclass(frozen=True, slots=True)
class Config:
    interval_seconds: float = _DEFAULT_INTERVAL_SECONDS
    log_level: str = _DEFAULT_LOG_LEVEL
    lock_path: str | None = None
    max_runtime_seconds: float = _DEFAULT_MAX_RUNTIME_SECONDS
    backoff_base_seconds: float = _DEFAULT_BACKOFF_BASE_SECONDS
    backoff_max_seconds: float = _DEFAULT_BACKOFF_MAX_SECONDS
    merge_rules_ttl_seconds: float = _DEFAULT_MERGE_RULES_TTL_SECONDS
    review_window_hours: float = _DEFAULT_REVIEW_WINDOW_HOURS
    drci_poke_delay_seconds: float = _DEFAULT_DRCI_POKE_DELAY_SECONDS
    drci_renders_status_comment: bool = _DEFAULT_DRCI_RENDERS_STATUS_COMMENT
    github_token: str | None = field(default=None, repr=False)
    drci_token: str | None = field(default=None, repr=False)
    drci_internal_token: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        # Canonicalize string options here so env, CLI, and direct construction share one rule.
        object.__setattr__(self, "log_level", _normalize_log_level(self.log_level))
        object.__setattr__(self, "lock_path", _clean(self.lock_path))
        object.__setattr__(self, "github_token", _clean(self.github_token))
        object.__setattr__(self, "drci_token", _clean(self.drci_token))
        object.__setattr__(self, "drci_internal_token", _clean(self.drci_internal_token))
        for name in _POSITIVE_FIELDS:
            value: float = getattr(self, name)
            _validate_bound(name, value, allow_zero=False)
        for name in _NON_NEGATIVE_FIELDS:
            value = getattr(self, name)
            _validate_bound(name, value, allow_zero=True)
        _validate_bound(
            "review_window_hours", self.review_window_hours, allow_zero=False, max_value=_MAX_REVIEW_WINDOW_HOURS
        )

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        source = os.environ if env is None else env
        return cls(
            interval_seconds=_read_float(source, "PYTORCH_GREENLIGHT_INTERVAL_SECONDS", _DEFAULT_INTERVAL_SECONDS),
            log_level=source.get("PYTORCH_GREENLIGHT_LOG_LEVEL", _DEFAULT_LOG_LEVEL),
            lock_path=source.get("PYTORCH_GREENLIGHT_LOCK_PATH"),
            max_runtime_seconds=_read_float(
                source, "PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS", _DEFAULT_MAX_RUNTIME_SECONDS
            ),
            backoff_base_seconds=_read_float(
                source, "PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS", _DEFAULT_BACKOFF_BASE_SECONDS
            ),
            backoff_max_seconds=_read_float(
                source, "PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS", _DEFAULT_BACKOFF_MAX_SECONDS
            ),
            merge_rules_ttl_seconds=_read_float(
                source, "PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS", _DEFAULT_MERGE_RULES_TTL_SECONDS
            ),
            review_window_hours=_read_float(
                source, "PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS", _DEFAULT_REVIEW_WINDOW_HOURS
            ),
            drci_poke_delay_seconds=_read_float(
                source, "PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS", _DEFAULT_DRCI_POKE_DELAY_SECONDS
            ),
            drci_renders_status_comment=_read_bool(
                source, "PYTORCH_GREENLIGHT_DRCI_RENDERS_STATUS_COMMENT", _DEFAULT_DRCI_RENDERS_STATUS_COMMENT
            ),
            github_token=source.get("PYTORCH_GREENLIGHT_GITHUB_TOKEN"),
            drci_token=source.get("PYTORCH_GREENLIGHT_DRCI_TOKEN"),
            drci_internal_token=source.get("PYTORCH_GREENLIGHT_DRCI_INTERNAL_TOKEN"),
        )
