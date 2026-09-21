import json
import re
from pathlib import Path

import pytest

from greenlight.constants import LAND_REASON
from greenlight.verdict import ALLOWED_REASONS

ROOT = Path(__file__).resolve().parents[2]
assert (ROOT / ".claude").is_dir()

_SKILL = ROOT / ".claude/skills/greenlight-review/SKILL.md"
_BACKTICKED = re.compile(r"`([a-z0-9_]+)`")
# A backticked token carrying at least one underscore. Every reason but `clean` is shaped this way
# and no other backticked word in the prose around them is, so this reads the codes a sentence
# names without having to know which sentence it is reading.
_CODE = re.compile(r"`([a-z0-9]+(?:_[a-z0-9]+)+)`")
# Anchored at a line start, so a mid-line mention of either literal in prose is not read as the
# bullet. Nothing about an anchor distinguishes the real passage from a copy of it, so each is
# required below to occur exactly once rather than resolved to its first occurrence.
_LAND_BULLET = re.compile(r"^[ \t]*- LAND:", re.MULTILINE)
_NO_LAND_BULLET = re.compile(r"^[ \t]*- NO_LAND:", re.MULTILINE)
_GUIDANCE = re.compile(r"Choosing a reason")
_HOOK_REASONS = re.compile(r"^ALLOWED_REASONS=\(([^)]*)\)", re.MULTILINE)
# Deliberately looser than the pattern the list is read with: bash assigns from an indented line
# too, and takes the last assignment where a scrape takes the first.
_HOOK_REASONS_ANY = re.compile(r"ALLOWED_REASONS=\(")


def _schema_reasons() -> set[str]:
    data = json.loads((ROOT / ".claude/hooks/greenlight/verdict-schema.json").read_text())
    reasons: set[str] = set(data["properties"]["reason"]["enum"])
    assert reasons
    return reasons


def _sole_match(pattern: re.Pattern[str], text: str, source: str, what: str) -> re.Match[str]:
    """The one match of ``pattern``, refusing to pick a first occurrence out of several.

    Every anchor here locates a passage by how it is written, and a copy is written the same way.
    A correct duplicate placed above the real passage satisfies each check below while the passage
    that is actually read -- by the model, or by bash, which takes the last assignment -- drifts
    freely underneath it.
    """
    matches = list(pattern.finditer(text))
    assert len(matches) == 1, f"{source} holds {len(matches)} {what}; exactly one can be the authoritative copy"
    return matches[0]


def _hook_reasons() -> set[str]:
    text = (ROOT / ".claude/hooks/greenlight/validate-on-stop.sh").read_text()
    _sole_match(_HOOK_REASONS_ANY, text, "validate-on-stop.sh", "ALLOWED_REASONS assignments")
    m = _sole_match(_HOOK_REASONS, text, "validate-on-stop.sh", "line-initial ALLOWED_REASONS lists")
    reasons: set[str] = set(m.group(1).split())
    assert reasons
    return reasons


def _block(text: str, offset: int) -> str:
    """One markdown block: the line holding ``offset`` plus its wrapped continuation lines.

    A sibling bullet or a blank line ends it, which is what keeps each of the three passages below
    to itself however they are nested or reordered relative to one another.
    """
    lines = text[text.rfind("\n", 0, offset) + 1 :].split("\n")
    kept = [lines[0]]
    for line in lines[1:]:
        if not line.strip() or line.lstrip().startswith("- "):
            break
        kept.append(line)
    return "\n".join(kept)


def _skill_reason_sides() -> tuple[set[str], set[str]]:
    """The reason codes the skill's field list offers for a LAND and for a NO_LAND."""
    text = _SKILL.read_text()
    land = _sole_match(_LAND_BULLET, text, _SKILL.name, "line-initial '- LAND:' bullets")
    no_land = _sole_match(_NO_LAND_BULLET, text, _SKILL.name, "line-initial '- NO_LAND:' bullets")
    land_reasons = set(_BACKTICKED.findall(_block(text, land.start())))
    no_land_reasons = set(_BACKTICKED.findall(_block(text, no_land.start())))
    assert land_reasons
    assert no_land_reasons
    return land_reasons, no_land_reasons


def _skill_reasons() -> set[str]:
    land, no_land = _skill_reason_sides()
    return land | no_land


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


def test_skill_offers_no_reason_but_clean_for_a_land() -> None:
    # The union above is blind to which side a code sits on, and the side is the constraint: a code
    # offered for a LAND is one the model may pair with an approval, which constants.LAND_REASON and
    # both Stop-hook layers reject.
    land, no_land = _skill_reason_sides()
    assert land == {LAND_REASON}, f"the skill's LAND bullet offers {sorted(land)}, not just {LAND_REASON!r}"
    expected = ALLOWED_REASONS - {LAND_REASON}
    assert no_land == expected, (
        f"the skill's NO_LAND bullet drifted; symmetric difference: {sorted(no_land ^ expected)}"
    )


def test_skill_reason_guidance_names_only_known_reasons() -> None:
    # The passage that tells the model how to choose between codes is prose rather than a list, so
    # the sides above do not cover it -- and it is the text the model re-reads while writing the
    # verdict. Containment, not equality: it discusses a few codes, never all of them.
    text = _SKILL.read_text()
    guidance = _sole_match(_GUIDANCE, text, _SKILL.name, "'Choosing a reason' passages")
    named = set(_CODE.findall(_block(text, guidance.start())))
    assert named, "the 'Choosing a reason' guidance names no reason code"
    assert named <= ALLOWED_REASONS, f"it names unknown reason code(s): {sorted(named - ALLOWED_REASONS)}"
