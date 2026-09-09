"""Spec tests for the canned oversized-diff decline verdict.

The size-gate step in greenlight-pr-review.yml copies this fixture to the reviewer's verdict
path when a diff exceeds the byte cap, so it must be a valid NO_LAND verdict that passes the
same checks the record job applies. Reason and status are cross-checked against the greenlight
source of truth and verdict-schema.json rather than hardcoded here.

Its message reaches the PR through the same renderer as a model-written one, so it is held to
the outline shape the greenlight-review skill asks the model for. Nothing enforces that shape on
a model's message and nothing is meant to: the Stop hook checks the schema and no more, a prose
verdict is a valid verdict that the fenced renderer shows correctly, and rejecting one on the
record path would write no row and hang the PR. This fixture is the one message greenlight writes
itself, so it is the one place the shape can be held to without any of that, and it is held here.
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


def _outline(message: str) -> list[tuple[str, list[str]]]:
    """The message parsed as (topic bullet, detail bullets) pairs.

    Rejects any line that is neither a top-level ``- `` bullet nor a two-space-indented
    ``  - `` one, which is what "nothing outside the outline" amounts to in text.
    """
    groups: list[tuple[str, list[str]]] = []
    for line in message.split("\n"):
        if line.startswith("  - "):
            assert groups, f"detail bullet precedes any topic bullet: {line!r}"
            groups[-1][1].append(line)
        else:
            assert line.startswith("- "), f"neither a topic nor a detail bullet: {line!r}"
            groups.append((line, []))
    return groups


@pytest.mark.parametrize(
    "message",
    [
        "This change is too large for the automated reviewer to read in full, so it is being "
        "declined automatically; a human reviewer should assess it.",
        "- Scope\n  - Too large to read in full\nA human reviewer should assess it.",
        "  - Too large to read in full",
    ],
    ids=["prose", "trailing-paragraph", "orphan-detail"],
)
def test_the_outline_parse_rejects_what_is_not_an_outline(message):
    # The shape check below only ever sees one message, so nothing there separates a parse that
    # discriminates from one that accepts anything. Each of these renders correctly on its own --
    # prose goes out fenced -- and each would pass every other test in this file, so rejecting them
    # is the whole of what makes the check below mean anything.
    with pytest.raises(AssertionError):
        _outline(message)


def test_message_is_a_bullet_outline():
    groups = _outline(_load(_VERDICT_FILE)["message"])
    # One topic per lever the decision turned on, and this one turns on scope alone. The skill caps
    # the count and asks for no padding, so a floor above one would be a standing instruction to
    # invent a second lever here.
    assert 1 <= len(groups) <= 4, f"the skill asks for at most 4 topic bullets, this has {len(groups)}"
    for topic, details in groups:
        assert 1 <= len(details) <= 3, f"{topic!r} carries {len(details)} detail bullets, not 1 to 3"


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
