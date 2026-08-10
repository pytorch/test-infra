"""Spec tests for the canned oversized-diff decline verdict.

The size-gate step in greenlight-pr-review.yml copies this fixture to the reviewer's verdict
path when a diff exceeds the byte cap, so it must be a valid NO_LAND verdict that passes the
same checks the record job applies. Reason and status are cross-checked against the greenlight
source of truth and verdict-schema.json rather than hardcoded here.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from greenlight.verdict import ALLOWED_REASONS

_REPO_ROOT = Path(__file__).resolve().parents[2]
_VERDICT_FILE = _REPO_ROOT / ".claude" / "hooks" / "greenlight" / "too-large-verdict.json"
_SCHEMA_FILE = _REPO_ROOT / ".claude" / "hooks" / "greenlight" / "verdict-schema.json"


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def test_verdict_file_present():
    assert _VERDICT_FILE.is_file()


def test_status_is_no_land():
    assert _load(_VERDICT_FILE)["status"] == "NO_LAND"


def test_reason_is_scope_too_large_and_allowed():
    reason = _load(_VERDICT_FILE)["reason"]
    assert reason == "scope_too_large"
    assert reason in ALLOWED_REASONS


def test_message_is_non_empty():
    message = _load(_VERDICT_FILE)["message"]
    assert isinstance(message, str)
    assert message.strip()


def test_matches_schema_shape():
    verdict = _load(_VERDICT_FILE)
    schema = _load(_SCHEMA_FILE)
    required = set(schema["required"])
    # additionalProperties: false plus the required set means exactly these keys, no more.
    assert set(verdict.keys()) == required
    assert schema["additionalProperties"] is False
    assert verdict["status"] in schema["properties"]["status"]["enum"]
    assert verdict["reason"] in schema["properties"]["reason"]["enum"]
    assert len(verdict["message"]) >= schema["properties"]["message"]["minLength"]


def test_validates_against_jsonschema():
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(instance=_load(_VERDICT_FILE), schema=_load(_SCHEMA_FILE))
