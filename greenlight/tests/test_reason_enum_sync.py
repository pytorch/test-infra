import json
import re
from pathlib import Path

import pytest

from greenlight.verdict import ALLOWED_REASONS

ROOT = Path(__file__).resolve().parents[2]
assert (ROOT / ".claude").is_dir()


def _schema_reasons() -> set[str]:
    data = json.loads((ROOT / ".claude/hooks/greenlight/verdict-schema.json").read_text())
    reasons: set[str] = set(data["properties"]["reason"]["enum"])
    assert reasons
    return reasons


def _hook_reasons() -> set[str]:
    text = (ROOT / ".claude/hooks/greenlight/validate-on-stop.sh").read_text()
    m = re.search(r"^ALLOWED_REASONS=\(([^)]*)\)", text, re.MULTILINE)
    assert m is not None
    reasons: set[str] = set(m.group(1).split())
    assert reasons
    return reasons


def _skill_reasons() -> set[str]:
    text = (ROOT / ".claude/skills/greenlight-review/SKILL.md").read_text()
    start = text.index("- LAND:")
    end = text.index("- **`message`**", start)
    region = text[start:end]
    reasons: set[str] = set(re.findall(r"`([a-z0-9_]+)`", region))
    assert reasons
    return reasons


_SOURCES = {
    "schema": _schema_reasons,
    "hook": _hook_reasons,
    "skill": _skill_reasons,
}


@pytest.mark.parametrize("source", list(_SOURCES))
def test_reason_enum_matches_canonical(source: str) -> None:
    extracted = _SOURCES[source]()
    assert extracted == ALLOWED_REASONS, (
        f"{source} reason enum drifted from greenlight.verdict.ALLOWED_REASONS; "
        f"symmetric difference: {sorted(extracted ^ ALLOWED_REASONS)}"
    )
