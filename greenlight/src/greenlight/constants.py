"""Shared constants for the greenlight service: verdict statuses, storage keys, and dispatch targets."""

from __future__ import annotations

import re

STATUS_LAND = "LAND"
STATUS_NO_LAND = "NO_LAND"
STATUS_CANCELLED = "CANCELLED"
STATUS_FAILED = "FAILED"
STATUS_AI_REVIEW_STARTED = "AI_REVIEW_STARTED"

TERMINAL_STATUSES: frozenset[str] = frozenset({STATUS_LAND, STATUS_NO_LAND})
IN_FLIGHT_STATUSES: frozenset[str] = frozenset({STATUS_AI_REVIEW_STARTED})
RETRY_STATUSES: frozenset[str] = frozenset({STATUS_CANCELLED, STATUS_FAILED})
VERDICT_STATUSES: frozenset[str] = TERMINAL_STATUSES | IN_FLIGHT_STATUSES | RETRY_STATUSES

S3_KEY_PREFIX = "greenlight_pr_state"
EVAL_HASH_RE = re.compile(r"[0-9a-f]{64}")
HEAD_SHA_RE = re.compile(r"[0-9a-fA-F]{40}")

DISPATCH_REPO = "pytorch/test-infra"
WORKFLOW_FILE = "greenlight-pr-review.yml"
DEFAULT_DISPATCH_REF = "main"
DEFAULT_TIMEOUT_MINUTES = 30


def validate_eval_hash(value: str) -> None:
    if not EVAL_HASH_RE.fullmatch(value):
        raise ValueError(f"eval_hash must be 64 lowercase hex characters, got {value!r}")


def validate_head_sha(value: str) -> None:
    if not HEAD_SHA_RE.fullmatch(value):
        raise ValueError(f"head_sha must be a 40-character hex commit sha, got {value!r}")
