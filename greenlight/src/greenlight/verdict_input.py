"""The verdict command's input: which status it records, and a LAND/NO_LAND's reason and message.

A marker status needs nothing beyond itself. A FULL status reads its reason and message from the
``--verdict-file`` JSON object; ``verdict.run`` validates them here before it touches GitHub.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight import constants
from greenlight.constants import (
    IN_FLIGHT_STATUSES,
    RETRY_STATUSES,
    SCAN_ONLY_STATUSES,
    TERMINAL_STATUSES,
    VERDICT_STATUSES,
)

if TYPE_CHECKING:
    from greenlight.verdict import VerdictRequest

_FULL_STATUSES = TERMINAL_STATUSES
# Marker statuses the verdict CLI accepts: the retry outcomes plus AI_REVIEW_STARTED, minus the
# scan-only AI_REVIEW_DISPATCHED (which lives in IN_FLIGHT_STATUSES for decide() but is never
# emitted through this command).
_MARKER_STATUSES = (RETRY_STATUSES | IN_FLIGHT_STATUSES) - SCAN_ONLY_STATUSES


@dataclass(frozen=True, slots=True)
class _VerdictDoc:
    status: str | None
    reason: str
    message: str


def _str_field(data: dict[str, object], key: str, path: str) -> str:
    value = data.get(key, "")
    if not isinstance(value, str):
        raise ValueError(f"verdict file {path} field {key!r} must be a string")
    return value


def _optional_str_field(data: dict[str, object], key: str, path: str) -> str | None:
    value = data.get(key)
    if value is not None and not isinstance(value, str):
        raise ValueError(f"verdict file {path} field {key!r} must be a string")
    return value


def _load_verdict_file(path: str) -> _VerdictDoc:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise ValueError(f"cannot read verdict file {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"verdict file {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"verdict file {path} must contain a JSON object")
    return _VerdictDoc(
        status=_optional_str_field(data, "status", path),
        reason=_str_field(data, "reason", path),
        message=_str_field(data, "message", path),
    )


def _resolve_verdict(request: VerdictRequest) -> tuple[str, str, str]:
    cli_status = request.status.strip().upper() if request.status else None
    # A marker status given on the CLI needs no verdict file at all.
    if cli_status in _MARKER_STATUSES:
        return cli_status, "", ""
    doc = _load_verdict_file(request.verdict_file) if request.verdict_file else None
    raw_status = cli_status or (doc.status if doc else None)
    if not raw_status:
        raise ValueError("a verdict status is required: pass --status or a --verdict-file containing 'status'")
    status = raw_status.strip().upper()
    if status in _MARKER_STATUSES:
        return status, "", ""
    if status in _FULL_STATUSES:
        if doc is None:
            raise ValueError(f"{status} requires --verdict-file for its reason and message")
        return status, doc.reason, doc.message
    raise ValueError(f"unknown verdict status {status!r}; expected one of {sorted(VERDICT_STATUSES)}")


def _validate_eval_hash(value: str) -> None:
    constants.validate_eval_hash(value)


def _validate_reason(status: str, reason: str) -> None:
    constants.validate_reason(status, reason)


def _validate_message(message: str) -> None:
    if not message.strip():
        raise ValueError("a non-empty message is required for a LAND/NO_LAND verdict")
