"""Small shared types, exceptions, and Lambda helpers.

Grouped together because each piece is too small to justify its own module
and there's no shared abstraction to organise them under.
"""

from __future__ import annotations

import base64
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


class TimingPhase(str, Enum):
    """Phases recorded in the crcr:timing:* Redis keys.

    - ``DISPATCH``: webhook side, when a repository_dispatch is fired.
    - ``IN_PROGRESS``: result side, when the downstream workflow reports it
      has started running.
    """

    DISPATCH = "dispatch"
    IN_PROGRESS = "in_progress"


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
