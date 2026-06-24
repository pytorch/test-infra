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


# Specific check_run_id used to identify callbacks
# from dispatches that didn't specify a real check_run_id.
# Here we set as a string for better readability,
# but it could be any unique identifier.
DISPATCH_CHECK_RUN_ID = "dispatched"


class CallbackState(str, Enum):
    """Unified state machine for callback lifecycle (both webhook and callback sides).

    - ``DISPATCHED``: webhook side, when repository_dispatch is sent (job_name=DISPATCH_JOB_NAME).
    - ``IN_PROGRESS``: callback side, when downstream workflow reports started (per-job).
    - ``COMPLETED``: callback side, when downstream workflow reports finished (per-job).
    """

    DISPATCHED = "DISPATCHED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"


@dataclass
class CallbackStateRecord:
    """Record containing state, timestamp, and job metadata for HUD grouping."""

    state: CallbackState
    timestamp: float
    job_name: str
    run_id: str


def extract_pr_labels(envelope: dict) -> set[str]:
    """Return the set of PR label names from a dispatch/callback envelope.

    Both the webhook dispatch ``client_payload`` and the downstream callback
    ``body`` carry the original webhook under ``payload.pull_request``, so the
    labels live at ``payload.pull_request.labels`` in either case.
    """
    pull_request = (envelope.get("payload") or {}).get("pull_request") or {}
    return {lbl.get("name", "") for lbl in (pull_request.get("labels") or [])}


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
