"""Small shared types, exceptions, and Lambda helpers.

Grouped together because each piece is too small to justify its own module
and there's no shared abstraction to organise them under.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from enum import Enum
from typing import TypedDict


JSON_HEADERS = {"content-type": "application/json"}


class HTTPException(Exception):
    def __init__(self, status_code: int, detail):
        self.status_code = status_code
        self.detail = detail


class EventDispatchPayload(TypedDict):
    event_type: str
    delivery_id: str
    payload: dict


# Sentinels for dispatch records in the state machine.
# DISPATCH_RUN_ID = 0 is used as the run_id for dispatch records
# (real GitHub Actions run_ids are positive integers).
# DISPATCH_RUN_ATTEMPT = 0 is used as the run_attempt for dispatch records.
DISPATCH_RUN_ID = 0
DISPATCH_RUN_ATTEMPT = 0


class CallbackState(str, Enum):
    """Unified state machine for callback lifecycle (both webhook and callback sides).

    - ``DISPATCHED``: webhook side, when repository_dispatch is sent (run_id=DISPATCH_RUN_ID).
    - ``IN_PROGRESS``: callback side, when downstream workflow reports started (per-workflow).
    - ``COMPLETED``: callback side, when downstream workflow reports finished (per-workflow).
    """

    DISPATCHED = "DISPATCHED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"


@dataclass
class CallbackStateRecord:
    """Record containing state, timestamp, and stored payload (optional)."""

    state: CallbackState
    timestamp: float
    payload: dict | None


def parse_lambda_event(event: dict) -> tuple[str, str, bytes, dict]:
    """Extract method, path, body bytes, and lower-cased headers from a Lambda event dict."""
    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", "").upper()
    path = http.get("path", "")
    raw_body = event.get("body") or ""
    body_bytes = (
        base64.b64decode(raw_body)
        if event.get("isBase64Encoded")
        else raw_body.encode("utf-8")
    )
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    return method, path, body_bytes, headers
