"""Small shared types, exceptions, and Lambda helpers.

Grouped together because each piece is too small to justify its own module
and there's no shared abstraction to organise them under.
"""

from __future__ import annotations

import base64
import re
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


def extract_pr_labels(envelope: dict) -> set[str]:
    """Return the set of PR label names from a dispatch/callback envelope.

    Both the webhook dispatch ``client_payload`` and the downstream callback
    ``body`` carry the original webhook under ``payload.pull_request``, so the
    labels live at ``payload.pull_request.labels`` in either case.

    Always empty for a ``push`` event (no ``pull_request`` key).
    """
    pull_request = (envelope.get("payload") or {}).get("pull_request") or {}
    return {lbl.get("name", "") for lbl in (pull_request.get("labels") or [])}


_CIFLOW_TRUNK_REF_RE = re.compile(r"/ciflow/trunk/(\d+)$")
_NULL_SHA = "0" * 40


def extract_pr_context(envelope: dict) -> tuple[str, str]:
    """Return (pr_number, head_sha) from a dispatch/callback envelope.

    Prefers the ``pull_request`` event shape. Falls back to a ``push`` event:
    PR number is recovered only from a ``ciflow/trunk/<pr_number>`` ref (the
    tag ``@pytorchbot merge`` pushes to trigger trunk validation before
    landing) -- other ``ciflow/<label>`` tags are equally PR-scoped but are
    deliberately left unhandled here since trunk validation is the only one
    this relay currently needs to recognize. head_sha comes from
    ``payload.after``. Any other push ref (e.g. a landed merge on main) has
    no PR to attach to, so this returns ``("", head_sha)`` for it, which
    callers already treat as "no upstream check run" correctly.

    A ref *deletion* push (``deleted: true``) reports ``after`` as the null
    SHA with the ref left pointing at whatever was just deleted, so it's special-
    cased to ("", "") rather than returning a pr_number paired with a SHA
    that doesn't exist (GitHub's create-check-run API 422s on it).
    """
    payload = envelope.get("payload") or {}
    pull_request = payload.get("pull_request") or {}
    pr_number = str(pull_request.get("number") or "")
    head_sha = (pull_request.get("head") or {}).get("sha", "")
    if pr_number and head_sha:
        return pr_number, head_sha

    head_sha = payload.get("after", "")
    if payload.get("deleted") or head_sha == _NULL_SHA:
        return "", ""
    match = _CIFLOW_TRUNK_REF_RE.search(payload.get("ref", ""))
    pr_number = match.group(1) if match else ""
    return pr_number, head_sha


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
