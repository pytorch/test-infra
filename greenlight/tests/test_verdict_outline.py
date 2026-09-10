"""Tests for the verdict outline renderer and its TypeScript mirror.

Three things are pinned here. The first is containment: whatever the model was talked into
writing, the rendered block stays one line of raw HTML whose only tags are the ones this module
emits. The second is that the switch between the outline renderer and the fenced one is
conservative enough that a paragraph goes out fenced, which is where prose belongs and where
every already-stored row stays. The third is cross-language
parity -- ``torchci/lib/greenlight/greenlightOutline.ts`` renders the same rows into the Dr. CI
comment, so the shared fixture and the literal scrape below fail when the two drift.

``outline_parity_cases.json`` holds the ``html`` and ``isOutline`` this implementation produces
for each ``message``; ``torchci/test/greenlightOutline.test.ts`` asserts the same values, so a
change either side lands as a failure rather than as two comments that disagree. To rebuild it
after a deliberate change, rewrite each row's two outputs from this module and leave ``message``
alone -- the inputs are the corpus, and dropping one silently narrows what parity means.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

import pytest

from greenlight import comment_format, verdict_outline
from greenlight.verdict_outline import is_outline, render_outline_html
from tests import ts_source

PARITY_CASES_PATH = Path(__file__).resolve().parent / "outline_parity_cases.json"

_TS_OUTLINE = "torchci/lib/greenlight/greenlightOutline.ts"
_TS_GUARDS = "torchci/lib/greenlight/greenlightReferenceGuards.ts"
_TS_SWEEP = "torchci/lib/greenlight/greenlightSweep.ts"
_TS_ADVISOR = "torchci/lib/advisor/advisorBadge.ts"
_PY_OUTLINE = "greenlight/src/greenlight/verdict_outline.py"

ZWSP = verdict_outline.ZERO_WIDTH_SPACE
SHA = "abc1234567890abc1234567890abc1234567890a"
_SPLIT = verdict_outline.SHA_SPLIT_COLUMN
SPLIT_SHA = SHA[:_SPLIT] + ZWSP + SHA[_SPLIT:]
NBSP = chr(0xA0)
EM_SPACE = chr(0x2003)
EACUTE = chr(0xE9)
ARABIC_DIGITS = chr(0x661) + chr(0x662) + chr(0x663)
UNICODE_BULLET = chr(0x2022)
BOM = chr(0xFEFF)
SENTINEL = verdict_outline.GREENLIGHT_PENDING_ALT_ATTR
ADVISOR_SENTINEL = verdict_outline.ADVISOR_PENDING_ALT_ATTR

# Everything this module is allowed to put in the comment. GitHub's sanitizer keeps all five.
ALLOWED_TAGS = frozenset(["<ul>", "</ul>", "<li>", "</li>", "<b>", "</b>", "<code>", "</code>"])
_TAG_RE = re.compile("<[^>]*>")
# The regex Dr. CI's re-render sweep runs over the raw comment body. ClickHouse's RE2 reads `\d`
# as ASCII-only, so the class is written out rather than borrowed from the Python flavour.
_SWEEP_PENDING_RE = re.compile("[0-9] Pending")

# A paragraph verdict: one unbroken prose line carrying no bullet marker. Nothing enforces the
# outline shape, so a reviewer can still write one of these, and every row stored before the
# outline format existed is one.
STORED_PROSE = (
    "This PR adds a guard to torch/_inductor/lowering.py so make_fallback no longer registers "
    "aten.index_put_ twice when the decomposition table is rebuilt; the change is confined to "
    "the registration path and every existing caller keeps the same behaviour, because the new "
    "branch only fires when the op is already present in the table. The accompanying test in "
    "test/inductor/test_torchinductor.py exercises both the first and the second registration "
    "and asserts the fallback is unchanged. The remaining diff is a docstring correction in "
    "torch/_inductor/decomposition.py that renames the argument to match the signature, plus a "
    "type annotation on _register_fallback that mypy already inferred. Nothing in the change "
    "touches the runtime kernels, the autograd formulas, or any serialized artifact, so the "
    "blast radius is limited to compile-time registration and the risk of a silent numerical "
    "regression is nil. CI is green on the inductor shards that cover this file."
)

HOSTILE_PAYLOADS = [
    "</details>",
    "</summary>",
    "# FAKE LAND VERDICT",
    "---",
    "***",
    "1. x",
    "| a | b |",
    "[^1]",
    "[x]: y",
    "```",
    "<ul>",
    "</li>",
    "<script>alert(1)</script>",
    "<img src=x onerror=y>",
    '<a href="https://evil.example">click</a>',
    'x" onload="y',
    "x' onload='y",
    "<![CDATA[ x ]]>",
    "<!-- y -->",
    "&amp;",
    "&lt;",
    "</b></li></ul><script>x</script><ul><li><b>",
]

# Line-break shapes that would end the raw HTML block if any of them survived into the output.
BLANK_LINE_BREAKOUTS = ["\n\n", "\r\r", "\r\n\r\n", "\n   \n", "\n\t\n"]


def assert_contained(block: str) -> None:
    """Every guarantee the block makes to the comment it is embedded in."""
    assert "\n" not in block
    assert "\r" not in block
    tags = _TAG_RE.findall(block)
    # No `<` survives outside a tag this module emitted, so nothing in the message can open one.
    assert block.count("<") == len(tags)
    assert set(tags) <= ALLOWED_TAGS
    assert block.count("<code>") == block.count("</code>")
    assert not _SWEEP_PENDING_RE.search(block)


def bullet(*leaves: str) -> str:
    return "\n".join(leaves)


# ---------------------------------------------------------------- is_outline


def test_prose_is_not_an_outline() -> None:
    assert is_outline(STORED_PROSE) is False


@pytest.mark.parametrize(
    "message",
    [
        "",
        "   ",
        "No bullets here at all.",
        "-no space after the marker",
        "- ",
        "-\t",
        "1.no space",
        "a - b",
        "  indented prose",
        f"{UNICODE_BULLET} a unicode bullet",
        f"{ARABIC_DIGITS}. arabic-indic digits are not [0-9]",
        "- x",
        "prose first\n- then one bullet",
        "- one bullet\nthen prose",
        f"{STORED_PROSE}\n- x",
    ],
)
def test_not_an_outline(message: str) -> None:
    assert is_outline(message) is False


def test_one_bullet_line_leaves_a_paragraph_on_the_fenced_renderer() -> None:
    # The cheap attack on the switch: two characters appended to a long paragraph move it onto a
    # renderer that shows the reader one leaf of it and clips the rest.
    assert len(STORED_PROSE) > verdict_outline.LEAF_CAP
    assert is_outline(f"{STORED_PROSE}\n- x") is False
    assert is_outline(f"{STORED_PROSE}\n- x\n- y") is True


@pytest.mark.parametrize(
    "message",
    [
        "- x\n- y",
        "* x\n* y",
        "+ x\n+ y",
        "1. x\n2. y",
        "2) x\n3) y",
        "\t- x\n\t- y",
        "   - x\n   - y",
        "-\tx\n-\ty",
        "prose first\n- then a bullet\n- and another",
        "- x\r\n- y",
        "- x\r- y",
    ],
)
def test_is_an_outline(message: str) -> None:
    assert is_outline(message) is True


def test_the_classifier_reads_the_same_prefix_the_renderer_does() -> None:
    # Bullets past the cap are text the renderer never sees, so they cannot decide which renderer
    # runs -- otherwise the outline path receives a message it renders as a single clipped leaf.
    beyond = "x" * verdict_outline.MESSAGE_CAP + "\n- a\n- b"
    assert is_outline(beyond) is False
    assert is_outline("- a\n- b\n" + beyond) is True


# ---------------------------------------------------------------- structure


def test_topics_and_details() -> None:
    block = render_outline_html(bullet("- Topic one", "  - detail a", "  - detail b", "- Topic two"))
    assert block == (
        "<ul><li><b>Topic one</b><ul><li>detail a</li><li>detail b</li></ul></li><li><b>Topic two</b></li></ul>"
    )


def test_topic_without_details_has_no_inner_list() -> None:
    assert render_outline_html("- Only a topic") == "<ul><li><b>Only a topic</b></li></ul>"


def test_prose_without_bullets_becomes_one_capped_topic() -> None:
    # A prose verdict never reaches this renderer -- is_outline sends it to the fence -- but if it
    # ever did, the whole paragraph is one leaf and the leaf cap clips it.
    clipped = STORED_PROSE[: verdict_outline.LEAF_CAP] + verdict_outline.TRUNCATION_SUFFIX
    assert render_outline_html(STORED_PROSE) == f"<ul><li><b>{clipped}</b></li></ul>"


def test_continuation_line_joins_the_bullet_above_it() -> None:
    block = render_outline_html(bullet("- Topic that the model", "  wrapped over two lines"))
    assert block == "<ul><li><b>Topic that the model wrapped over two lines</b></li></ul>"


def test_continuation_line_joins_a_detail() -> None:
    block = render_outline_html(bullet("- Topic", "  - detail that", "    kept going"))
    assert block == "<ul><li><b>Topic</b><ul><li>detail that kept going</li></ul></li></ul>"


def test_a_blank_line_ends_a_continuation() -> None:
    # A closing paragraph is not evidence for the last detail above it, and the blank line is the
    # one signal in the format that says so.
    block = render_outline_html(bullet("- Scope", "  - one file", "", "Overall this looks safe."))
    assert block == ("<ul><li><b>Scope</b><ul><li>one file</li></ul></li><li><b>Overall this looks safe.</b></li></ul>")


def test_a_blank_line_ends_a_prose_continuation() -> None:
    block = render_outline_html(bullet("first paragraph", "still the first", "", "second"))
    assert block == "<ul><li><b>first paragraph still the first</b></li><li><b>second</b></li></ul>"


def test_numbered_markers_flatten_to_the_same_shape() -> None:
    block = render_outline_html(bullet("1. First", "2) Second", "   1. nested"))
    assert block == "<ul><li><b>First</b></li><li><b>Second</b><ul><li>nested</li></ul></li></ul>"


def test_the_shallowest_bullet_is_the_top_level() -> None:
    assert render_outline_html(" - one space") == "<ul><li><b>one space</b></li></ul>"


def test_a_uniformly_indented_outline_keeps_its_shape() -> None:
    # Against an absolute threshold every one of these is a detail, so the second topic renders as
    # evidence for the first -- a relationship the reviewer never wrote, posted permanently.
    block = render_outline_html(bullet("  - Testing", "    - covers it", "  - Scope", "    - one file"))
    assert block == (
        "<ul><li><b>Testing</b><ul><li>covers it</li></ul></li><li><b>Scope</b><ul><li>one file</li></ul></li></ul>"
    )


@pytest.mark.parametrize("indent", [" ", "\t", "  ", "\t\t"])
def test_any_deeper_indent_nests(indent: str) -> None:
    block = render_outline_html(bullet("- topic", f"{indent}- nested"))
    assert block == "<ul><li><b>topic</b><ul><li>nested</li></ul></li></ul>"


def test_depth_is_clamped_to_one() -> None:
    block = render_outline_html(bullet("- topic", "  - detail", "      - deeper still"))
    assert block == "<ul><li><b>topic</b><ul><li>detail</li><li>deeper still</li></ul></li></ul>"


def test_detail_before_any_topic_is_promoted() -> None:
    block = render_outline_html(bullet("  - nested first", "- topic after"))
    assert block == "<ul><li><b>nested first</b></li><li><b>topic after</b></li></ul>"


def test_every_leading_orphan_is_promoted() -> None:
    # Two orphans are peers. Promoting only the first makes the second read as evidence for it.
    block = render_outline_html(bullet("  - first orphan", "  - second orphan", "- topic after"))
    assert block == ("<ul><li><b>first orphan</b></li><li><b>second orphan</b></li><li><b>topic after</b></li></ul>")


def test_details_survive_a_topic_that_flattens_away() -> None:
    block = render_outline_html(bullet(f"- {ZWSP}{ZWSP}", "  - survivor"))
    assert block == "<ul><li><b>survivor</b></li></ul>"


@pytest.mark.parametrize("dropped", ["- ", "-\t", f"- {ZWSP}{ZWSP}", f"- {BOM} {chr(0)}"])
def test_a_dropped_topic_never_hands_its_details_to_the_topic_above_it(dropped: str) -> None:
    # One stray empty bullet, and a blocker renders as evidence for an unrelated topic -- exactly
    # the relationship promotion exists to prevent, and posted permanently. No adversary needed.
    block = render_outline_html(bullet("- Scope", "  - one file", dropped, "  - NO_LAND: secrets leak"))
    assert block == "<ul><li><b>Scope</b><ul><li>one file</li></ul></li><li><b>NO_LAND: secrets leak</b></li></ul>"


def test_a_dropped_topic_between_two_real_ones_keeps_all_three_apart() -> None:
    block = render_outline_html(bullet("- Scope", "- ", "  - promoted", "- Testing"))
    assert block == "<ul><li><b>Scope</b></li><li><b>promoted</b></li><li><b>Testing</b></li></ul>"


def test_details_under_a_dropped_topic_stay_peers() -> None:
    # Two details of one dropped marker are siblings, exactly as two leading orphans are. Nesting
    # the second under the first invents a parent and child out of two of the reviewer's claims.
    block = render_outline_html(bullet("- Scope", "- ", "  - promoted", "  - second claim"))
    assert block == "<ul><li><b>Scope</b></li><li><b>promoted</b></li><li><b>second claim</b></li></ul>"


def test_a_detail_that_flattens_away_is_dropped_silently() -> None:
    block = render_outline_html(bullet("- topic", f"  - {ZWSP}", "  - kept"))
    assert block == "<ul><li><b>topic</b><ul><li>kept</li></ul></li></ul>"


def test_empty_leaves_emit_no_list_item() -> None:
    block = render_outline_html(bullet("- ", "- kept", "- \t"))
    assert block == "<ul><li><b>kept</b></li></ul>"


@pytest.mark.parametrize("message", ["", "   ", "\n\n\n", f"- {ZWSP}", f"- {chr(0)}{chr(0x7F)}{BOM}"])
def test_nothing_to_render_hands_the_message_to_the_fence(message: str) -> None:
    assert render_outline_html(message) == ""


# ---------------------------------------------------------------- containment


@pytest.mark.parametrize("payload", HOSTILE_PAYLOADS)
def test_hostile_payload_stays_contained(payload: str) -> None:
    block = render_outline_html(bullet(f"- {payload}", f"  - {payload}"))
    assert_contained(block)
    assert _TAG_RE.findall(block) == [
        "<ul>",
        "<li>",
        "<b>",
        "</b>",
        "<ul>",
        "<li>",
        "</li>",
        "</ul>",
        "</li>",
        "</ul>",
    ]


@pytest.mark.parametrize("payload", HOSTILE_PAYLOADS)
@pytest.mark.parametrize("breakout", BLANK_LINE_BREAKOUTS)
def test_hostile_payload_with_a_blank_line_stays_one_line(payload: str, breakout: str) -> None:
    assert_contained(render_outline_html(f"- {payload}{breakout}- {payload}"))


def test_markup_is_escaped_not_stripped() -> None:
    block = render_outline_html("- <script>alert(1)</script>")
    assert block == "<ul><li><b>&lt;script&gt;alert(1)&lt;/script&gt;</b></li></ul>"


def test_pre_encoded_entities_are_double_escaped() -> None:
    assert render_outline_html("- &amp; &lt;") == "<ul><li><b>&amp;amp; &amp;lt;</b></li></ul>"


def test_apostrophe_uses_the_entity_the_reference_guard_leaves_alone() -> None:
    # `&#39;` would carry a `#` followed by a digit, which the issue-reference guard then splits
    # into a broken entity the reader sees verbatim.
    assert render_outline_html("- it's") == "<ul><li><b>it&#x27;s</b></li></ul>"


def test_quotes_are_escaped() -> None:
    assert render_outline_html('- x" onload="y') == "<ul><li><b>x&quot; onload=&quot;y</b></li></ul>"


# ---------------------------------------------------------------- flattening


def test_invisible_characters_become_spaces_not_deletions() -> None:
    # A deletion would splice `Pen` onto `ding` and hand the sweep a live predicate.
    block = render_outline_html(f"- 9 Pen{ZWSP}ding jobs")
    assert block == "<ul><li><b>9 Pen ding jobs</b></li></ul>"
    assert not _SWEEP_PENDING_RE.search(block)


def test_space_runs_collapse_and_edges_are_stripped() -> None:
    assert render_outline_html("-    a     b   ") == "<ul><li><b>a b</b></li></ul>"


def test_non_ascii_spaces_are_left_alone() -> None:
    # `\s` would have eaten these in Python and not in JavaScript, which is the whole reason no
    # shorthand class appears in either implementation.
    block = render_outline_html(f"- a{NBSP}b{EM_SPACE}c")
    assert block == f"<ul><li><b>a{NBSP}b{EM_SPACE}c</b></li></ul>"


def test_leaf_is_capped_before_escaping() -> None:
    block = render_outline_html("- " + "<" * 500)
    ellipsis = verdict_outline.TRUNCATION_SUFFIX
    assert block == "<ul><li><b>" + "&lt;" * verdict_outline.LEAF_CAP + ellipsis + "</b></li></ul>"


def test_a_leaf_exactly_at_the_cap_is_not_marked() -> None:
    block = render_outline_html("- " + "x" * verdict_outline.LEAF_CAP)
    assert block == "<ul><li><b>" + "x" * verdict_outline.LEAF_CAP + "</b></li></ul>"
    assert verdict_outline.TRUNCATION_SUFFIX not in block


def test_a_clipped_leaf_says_so() -> None:
    # Without the mark, a bullet cut mid-word reads as the whole of what the reviewer wrote.
    block = render_outline_html("- " + "x" * (verdict_outline.LEAF_CAP + 1))
    assert block.endswith(f"{verdict_outline.TRUNCATION_SUFFIX}</b></li></ul>")


def test_message_is_capped_in_codepoints() -> None:
    block = render_outline_html("- " + "\U0001f600" * 4100)
    leaf = "\U0001f600" * verdict_outline.LEAF_CAP + verdict_outline.TRUNCATION_SUFFIX
    assert block == f"<ul><li><b>{leaf}</b></li>{verdict_outline.TRUNCATED_ITEM}</ul>"


def test_message_cap_matches_the_fenced_renderer() -> None:
    assert verdict_outline.MESSAGE_CAP == comment_format._MESSAGE_CAP


def test_zero_width_space_matches_the_fenced_renderer() -> None:
    # Each Python copy is pinned to the TypeScript beside it and to nothing else, so without this
    # the two pairs can move apart together and stay green. Both routes write into the one Dr. CI
    # comment body the sweep greps, and this character is what every defuse substitutes.
    assert verdict_outline.ZERO_WIDTH_SPACE == comment_format._ZERO_WIDTH_SPACE


# Everything a browser or a markdown parser treats as a line break, spelled with chr() so the
# source itself cannot carry one.
_LINE_BREAK_CODEPOINTS = ["\n", "\r", "\v", "\f", chr(0x85), chr(0x2028), chr(0x2029)]


@pytest.mark.parametrize("char", _LINE_BREAK_CODEPOINTS)
def test_every_line_break_character_is_flattened(char: str) -> None:
    assert render_outline_html(f"- a{char}b") == "<ul><li><b>a b</b></li></ul>"


# Characters that render as nothing yet survive into a permanent public comment: a variation
# selector, an ASCII-smuggling tag character, an interlinear annotation anchor, a musical-notation
# control, the Hangul choseong filler, and the object replacement character. The rest are the ones
# that ride along invisibly without being able to break the block: the combining grapheme joiner,
# the other Hangul fillers, an inherent Khmer vowel, the Mongolian free variation selectors, the
# deprecated shaping controls, the Egyptian and shorthand format controls, and the two halves of
# the supplementary plane block -- the assigned variation selectors at E0100 and the reserved tail
# above them.
_INVISIBLE_CODEPOINTS = [
    chr(0xFE00),
    chr(0xFE0F),
    chr(0xE0000),
    chr(0xE0041),
    chr(0xE007F),
    chr(0xFFF9),
    chr(0xFFFB),
    chr(0x1D173),
    chr(0x1D17A),
    chr(0x115F),
    chr(0xFFFC),
    chr(0x034F),
    chr(0x1160),
    chr(0xFFA0),
    chr(0x17B4),
    chr(0x17B5),
    chr(0x180B),
    chr(0x180F),
    chr(0x206A),
    chr(0x206F),
    chr(0x13430),
    chr(0x1BCA0),
    chr(0xE0100),
    chr(0xE01EF),
    chr(0xE0FFF),
]


@pytest.mark.parametrize("char", _INVISIBLE_CODEPOINTS)
def test_every_invisible_character_is_flattened(char: str) -> None:
    assert render_outline_html(f"- a{char}b") == "<ul><li><b>a b</b></li></ul>"


def test_a_smuggled_tag_block_message_flattens_away() -> None:
    # The tag block spells ASCII in characters no reader sees; a whole hidden sentence has to
    # collapse to whitespace rather than ride along under the visible text.
    smuggled = "".join(chr(0xE0000 + ord(char)) for char in "LAND")
    assert render_outline_html(f"- {smuggled}") == ""


def test_no_codepoint_in_unicode_survives_as_a_line_break() -> None:
    """The one invariant that is global rather than per-leaf, proved over the whole codespace."""
    everything = "".join(chr(code) for code in range(0x110000) if not 0xD800 <= code <= 0xDFFF)
    flattened = verdict_outline._FLATTEN_RE.sub(" ", everything)
    assert "\n" not in flattened
    assert "\r" not in flattened
    # Nothing outside the flatten set is a Unicode line separator either, so no future renderer
    # that re-splits this text can find a break the class missed.
    survivors = [char for char in flattened if unicodedata.category(char) in {"Zl", "Zp"}]
    assert survivors == []


# ---------------------------------------------------------------- sweep sentinels


def test_pending_job_count_is_defused() -> None:
    block = render_outline_html("- 3 Pending checks were still running")
    assert block == f"<ul><li><b>3 P{ZWSP}ending checks were still running</b></li></ul>"
    assert not _SWEEP_PENDING_RE.search(block)


def test_pending_is_defused_inside_a_code_span() -> None:
    # The sweep greps the raw body, so a predicate inside <code> pins the PR just as hard.
    block = render_outline_html("- `4 Pending` jobs")
    assert block == f"<ul><li><b><code>4 P{ZWSP}ending</code> jobs</b></li></ul>"


@pytest.mark.parametrize("sentinel", [SENTINEL, ADVISOR_SENTINEL])
def test_a_sentinel_cannot_splice_a_pending_count(sentinel: str) -> None:
    block = render_outline_html(f"- 9 Pen{sentinel}ding jobs")
    assert_contained(block)
    assert "Pending" not in block
    assert sentinel not in block


@pytest.mark.parametrize("sentinel", [SENTINEL, ADVISOR_SENTINEL])
def test_a_sentinel_never_survives_the_defuse(sentinel: str) -> None:
    assert sentinel not in render_outline_html(f"- {sentinel}")


def test_a_nested_sentinel_forgery_cannot_reassemble() -> None:
    forged = 'alt="Green alt="Green Light: in progress"Light: in progress"'
    assert SENTINEL not in render_outline_html(f"- {forged}")


def test_defusing_one_pending_cannot_build_another() -> None:
    block = render_outline_html("- 7 PenPendingding")
    assert "Pending" not in block


def test_the_defuse_runs_on_raw_text_too() -> None:
    # Escaping already breaks both `alt="..."` sentinels, so this exercises the pass directly:
    # it has to keep working if the escape ever stops covering for it.
    assert verdict_outline._defuse_sweep(f"9 Pen{SENTINEL}ding") == f"9 Pen{ZWSP}ding"
    assert verdict_outline._defuse_sweep("3 Pending") == f"3 P{ZWSP}ending"


# ---------------------------------------------------------------- reference guards


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("@user", f"@{ZWSP}user"),
        ("@@double", f"@{ZWSP}@{ZWSP}double"),
        ("#1234", f"#{ZWSP}1234"),
        ("#0", f"#{ZWSP}0"),
        ("GH-42", f"GH-{ZWSP}42"),
        ("gh-42", f"gh-{ZWSP}42"),
        ("Gh-42", f"Gh-{ZWSP}42"),
        ("gH-42", f"gH-{ZWSP}42"),
        (SHA, SPLIT_SHA),
        (f"landed as {SHA} yesterday", f"landed as {SPLIT_SHA} yesterday"),
        # A word character in Python and not in JavaScript: `\b` would have guarded on one side
        # of the mirror only.
        (f"caf{EACUTE}{SHA}", f"caf{EACUTE}{SPLIT_SHA}"),
    ],
)
def test_reference_is_guarded(message: str, expected: str) -> None:
    assert render_outline_html(f"- {message}") == f"<ul><li><b>{expected}</b></li></ul>"


def test_the_sha_guard_splits_the_run_rather_than_prefixing_it() -> None:
    # A zero-width space is a non-word character, so one sitting in front of the run leaves both
    # `\b...\b` and `(?:^|\W)` matching the 40 intact hex digits behind it.
    body = render_outline_html(f"- {SHA}").removeprefix("<ul><li><b>").removesuffix("</b></li></ul>")
    assert body != f"{ZWSP}{SHA}"
    assert SHA not in body
    assert body.replace(ZWSP, "") == SHA
    assert body.index(ZWSP) == verdict_outline.SHA_SPLIT_COLUMN


@pytest.mark.parametrize(
    "message",
    [
        "#ifdef",
        "#include <stdio.h>",
        "#pragma once",
        "GH-x",
        "GH-",
        "a" * 39,
        "a" * 41,
        f"z{SHA}",
        f"{SHA}z",
    ],
)
def test_reference_is_not_guarded(message: str) -> None:
    assert ZWSP not in render_outline_html(f"- {message}")


def test_a_sha_in_a_code_span_is_left_intact() -> None:
    # `code` is in GitHub's MentionFilter.IGNORE_PARENTS, and a zero-width space here would
    # corrupt the sha a reader copies out.
    block = render_outline_html(f"- see `{SHA}` there")
    assert block == f"<ul><li><b>see <code>{SHA}</code> there</b></li></ul>"


def test_a_mention_in_a_code_span_is_left_intact() -> None:
    assert render_outline_html("- `@echo off`") == "<ul><li><b><code>@echo off</code></b></li></ul>"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (":white_check_mark: APPROVED", f":{ZWSP}white_check_mark: APPROVED"),
        (":shipit:", f":{ZWSP}shipit:"),
        (":+1:", f":{ZWSP}+1:"),
        (":e-mail:", f":{ZWSP}e-mail:"),
        ("done:tada:now", f"done:{ZWSP}tada:{ZWSP}now"),
        ("::smile::", f"::{ZWSP}smile::"),
        (":a::b:", f":{ZWSP}a::{ZWSP}b:"),
    ],
)
def test_an_emoji_shortcode_cannot_render(message: str, expected: str) -> None:
    # GitHub's EmojiFilter ignores pre, code and tt -- not li -- so an unguarded shortcode draws a
    # green tick beside a verdict only the renderer is trusted to state.
    assert render_outline_html(f"- {message}") == f"<ul><li><b>{expected}</b></li></ul>"


@pytest.mark.parametrize(
    "message",
    [
        "Scope: one file",
        "the ratio is 3 : 1",
        "cast to Tensor:Long",
        "https://hud.pytorch.org",
        "::",
    ],
)
def test_a_colon_that_cannot_open_a_shortcode_is_left_alone(message: str) -> None:
    # A name is lowercase and starts immediately after the colon, so nothing here can open one --
    # and a zero-width space in ordinary prose is a character the reader copies out unawares.
    assert ZWSP not in render_outline_html(f"- {message}")


def test_an_emoji_shortcode_in_a_code_span_is_left_intact() -> None:
    # `code` is one of the parents EmojiFilter ignores, so the span is already inert, and a
    # zero-width space here would corrupt what the reader copies out.
    assert render_outline_html("- `:shipit:`") == "<ul><li><b><code>:shipit:</code></b></li></ul>"


def test_the_gh_guard_fires_on_every_occurrence() -> None:
    # A missed GH- guard writes a permanent backlink onto an unrelated issue, so one per leaf is
    # not enough -- including the occurrences sitting between escaped characters.
    block = render_outline_html('- GH-42 & "gh-7"')
    assert block == f"<ul><li><b>GH-{ZWSP}42 &amp; &quot;gh-{ZWSP}7&quot;</b></li></ul>"


# ---------------------------------------------------------------- code spans


def test_code_span_round_trip() -> None:
    assert render_outline_html("- call `foo(bar)` now") == "<ul><li><b>call <code>foo(bar)</code> now</b></li></ul>"


def test_unbalanced_backticks_fall_back_to_text() -> None:
    assert render_outline_html("- one ` backtick") == "<ul><li><b>one ` backtick</b></li></ul>"


def test_a_leaf_that_is_only_backticks_stays_text() -> None:
    assert render_outline_html("- ```") == "<ul><li><b>```</b></li></ul>"


def test_a_code_span_cannot_close_the_block() -> None:
    block = render_outline_html("- `</code></li></ul></details>`")
    assert block == "<ul><li><b><code>&lt;/code&gt;&lt;/li&gt;&lt;/ul&gt;&lt;/details&gt;</code></b></li></ul>"
    assert_contained(block)


def test_backtick_runs_are_not_split_apart() -> None:
    assert render_outline_html("- ``a`b`` tail") == "<ul><li><b>``a`b`` tail</b></li></ul>"


def test_several_code_spans_alternate() -> None:
    block = render_outline_html("- `a` and `b`")
    assert block == "<ul><li><b><code>a</code> and <code>b</code></b></li></ul>"


# ---------------------------------------------------------------- bounds


def test_topics_are_clamped() -> None:
    block = render_outline_html(bullet(*(f"- topic {index}" for index in range(20))))
    assert block.count("<li><b>") == verdict_outline.MAX_TOPICS
    assert "topic 11" in block
    assert "topic 12" not in block
    # A NO_LAND whose thirteenth bullet held the blocker must not read as a complete list.
    assert block.endswith(f"{verdict_outline.TRUNCATED_ITEM}</ul>")


def test_exactly_max_topics_is_not_marked_truncated() -> None:
    topics = verdict_outline.MAX_TOPICS
    block = render_outline_html(bullet(*(f"- topic {index}" for index in range(topics))))
    assert block.count("<li><b>") == topics
    assert verdict_outline.TRUNCATED_ITEM not in block


def test_details_are_clamped_per_topic() -> None:
    block = render_outline_html(bullet("- topic", *(f"  - detail {index}" for index in range(20))))
    assert block.count("<li>detail") == verdict_outline.MAX_DETAILS
    assert "detail 7" in block
    assert "detail 8" not in block
    # The marker belongs inside the detail list: it is the details that were dropped.
    assert block.endswith(f"{verdict_outline.TRUNCATED_ITEM}</ul></li></ul>")


def test_exactly_max_details_is_not_marked_truncated() -> None:
    details = verdict_outline.MAX_DETAILS
    block = render_outline_html(bullet("- topic", *(f"  - detail {index}" for index in range(details))))
    assert block.count("<li>detail") == details
    assert verdict_outline.TRUNCATED_ITEM not in block


def test_the_block_budget_stops_the_emit() -> None:
    block = render_outline_html(bullet(*("- " + '"' * 390 for _ in range(10))))
    assert block.endswith(f"{verdict_outline.TRUNCATED_ITEM}</ul>")
    assert block.count("<li><b>") < 10
    assert_contained(block)


def _sized_topic(item_length: int) -> str:
    """A bullet whose rendered ``<li>`` is exactly ``item_length`` characters long."""
    # Each `"` escapes to the six characters of `&quot;`; each `x` stays one and is not hex, so it
    # cannot join a sha guard. Spending as much of the length as possible on quotes keeps the leaf
    # itself under LEAF_CAP, where nothing clips it.
    quotes, spare = divmod(item_length - len("<li><b></b></li>"), 6)
    return "- " + '"' * quotes + "x" * spare


def test_an_item_that_exactly_fills_the_budget_is_kept() -> None:
    # The boundary the emit loop turns on. Five of these reach the budget to the character, so
    # testing `>=` rather than `>` would silently drop the last item that fits.
    item = 2400
    topics = verdict_outline.BLOCK_BUDGET // item
    block = render_outline_html(bullet(*([_sized_topic(item)] * (topics + 1))))
    assert block.count("<li><b>") == topics
    assert len(block) == verdict_outline.BLOCK_BUDGET + len("<ul></ul>") + len(verdict_outline.TRUNCATED_ITEM)


def test_the_emitted_block_never_exceeds_the_budget() -> None:
    # The last item used to be unbounded: the check ran before the append and the increment after,
    # so one maximally escaped topic could carry the block past the budget by 9,000 characters.
    ceiling = verdict_outline.BLOCK_BUDGET + len("<ul></ul>") + len(verdict_outline.TRUNCATED_ITEM)
    quotes = '"' * verdict_outline.LEAF_CAP
    widest = bullet(*((f"- {quotes}",) * verdict_outline.MAX_TOPICS))
    assert len(render_outline_html(widest)) <= ceiling
    deepest = bullet(f"- {quotes}", *((f"  - {quotes}",) * verdict_outline.MAX_DETAILS))
    assert len(render_outline_html(deepest)) <= ceiling


def test_a_single_item_over_the_budget_hands_the_message_to_the_fence() -> None:
    # One topic with eight maximally escaped details is worth 21,000 characters on its own. It is
    # dropped rather than emitted, so the bound above holds for every input -- and with nothing
    # left but the marker there is no list to post, so the caller falls through to the fence,
    # where the reader gets the message capped rather than a bare "(truncated)".
    quotes = '"' * verdict_outline.LEAF_CAP
    deepest = bullet(f"- {quotes}", *((f"  - {quotes}",) * verdict_outline.MAX_DETAILS))
    assert render_outline_html(deepest) == ""


def test_a_message_within_budget_is_not_marked_truncated() -> None:
    assert verdict_outline.TRUNCATED_ITEM not in render_outline_html(bullet("- a", "- b"))


def _sized_message(length: int, topics: int) -> str:
    """A ``topics``-bullet outline exactly ``length`` characters long, no leaf near the leaf cap."""
    body = length - (topics - 1) - topics * len("- ")
    base, spare = divmod(body, topics)
    return bullet(*("- " + "x" * (base + (1 if index < spare else 0)) for index in range(topics)))


def test_a_message_exactly_at_the_cap_is_not_marked_truncated() -> None:
    message = _sized_message(verdict_outline.MESSAGE_CAP, 10)
    assert len(message) == verdict_outline.MESSAGE_CAP
    block = render_outline_html(message)
    assert block.count("<li><b>") == 10
    assert verdict_outline.TRUNCATED_ITEM not in block


def test_a_message_past_the_cap_says_the_list_is_short() -> None:
    # The cap cuts the message before the first bullet is parsed, so no later clamp can notice it:
    # without this mark, a list missing whatever the reviewer wrote past 4,000 characters -- and
    # ending mid-sentence -- reads as the whole verdict.
    block = render_outline_html(_sized_message(verdict_outline.MESSAGE_CAP + 1, 10))
    # Neither of the clamps that already marked themselves fired here: ten topics is under the
    # clamp, and no leaf is long enough to be clipped.
    assert block.count("<li><b>") == 10
    assert verdict_outline.TRUNCATION_SUFFIX not in block
    assert block.endswith(f"{verdict_outline.TRUNCATED_ITEM}</ul>")


# ---------------------------------------------------------------- runtime tripwire


def test_a_line_break_in_the_assembled_block_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verdict_outline, "_topic_html", lambda topic: "<li><b>a\nb</b></li>")
    with pytest.raises(RuntimeError, match="line break"):
        render_outline_html("- a")


def test_unbalanced_code_tags_in_the_assembled_block_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verdict_outline, "_topic_html", lambda topic: "<li><b><code>a</b></li>")
    with pytest.raises(RuntimeError, match="unbalanced"):
        render_outline_html("- a")


# ---------------------------------------------------------------- cross-language parity


def _parity_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = json.loads(PARITY_CASES_PATH.read_text())
    assert cases, f"{PARITY_CASES_PATH} holds no cases"
    return cases


PARITY_CASES = _parity_cases()


@pytest.mark.parametrize("case", PARITY_CASES, ids=lambda case: str(case["name"]))
def test_parity_case(case: dict[str, Any]) -> None:
    message = str(case["message"])
    assert is_outline(message) is case["isOutline"]
    assert render_outline_html(message) == case["html"]


def test_parity_fixture_covers_the_divergent_character_classes() -> None:
    """The fixture is only worth reading if it holds the inputs `\\s`, `\\d` and `\\b` split on."""
    corpus = "".join(str(case["message"]) for case in PARITY_CASES)
    assert f"{EACUTE}{SHA}" in corpus, "no accented letter before a 40-hex sha (the `\\b` divergence)"
    assert ARABIC_DIGITS in corpus, "no Unicode digits (the `\\d` divergence)"
    assert NBSP in corpus, "no no-break space (the `\\s` divergence)"
    assert EM_SPACE in corpus, "no em space (the `\\s` divergence)"


def test_parity_fixture_covers_the_hand_written_unicode_helpers() -> None:
    """Each helper written out to match Python needs a case that a stdlib call would fail.

    ``trimSpaces``, ``isHorizontalSpaceOnly`` and ``codePointLength`` all exist because the
    obvious JavaScript -- ``trim()`` and ``.length`` -- means something else. Without an input
    that separates them, every one of those three can be replaced by the wrong call and both
    suites stay green while the two comments diverge.
    """
    messages = [str(case["message"]) for case in PARITY_CASES]
    assert any(message.startswith(f"- {NBSP}") and message.endswith(NBSP) for message in messages), (
        "no leaf with a no-break space at both edges (`strip(' ')` against `trim()`)"
    )
    assert any(NBSP in message.split("\n") for message in messages), (
        "no line that is a single no-break space (horizontal-space-only against `trim()`)"
    )
    assert any(
        "\U0001f600" in str(case["message"]) and verdict_outline.TRUNCATED_ITEM in str(case["html"])
        for case in PARITY_CASES
    ), "no astral character in a message that overruns the block budget (code points against UTF-16)"


# ---------------------------------------------------------------- TypeScript drift


def _drift(ts_file: str, detail: str) -> str:
    return ts_source.drift(ts_file, _PY_OUTLINE, detail)


_MIRRORED_NUMBERS = [
    "MESSAGE_CAP",
    "LEAF_CAP",
    "MAX_TOPICS",
    "MAX_DETAILS",
    "BLOCK_BUDGET",
    "MIN_BULLETS",
]
# Every character set the two implementations have to agree on, plus the literals built from them.
# A drift in any one of these renders two different comments from a single stored row.
_MIRRORED_STRINGS = [
    "TRUNCATED_ITEM",
    "TRUNCATION_SUFFIX",
    "LINE_BREAKS",
    "HORIZONTAL_SPACE",
    "BULLET_MARKERS",
    "ORDERED_TERMINATORS",
    "FLATTEN_CONTROL_CODEPOINTS",
    "FLATTEN_FORMAT_CODEPOINTS",
    "FLATTEN_BLANK_CODEPOINTS",
]
# Python keeps the reference guards in this one module; the TypeScript puts them in their own,
# below the renderer that calls them, so these are scraped unprefixed and from there. DIGITS is
# among them because the guards own it: greenlightOutline.ts reads the same class back for the
# ordered-list marker rather than writing "0-9" a second time.
_MIRRORED_GUARD_NUMBERS = [
    "SHA_LENGTH",
    "SHA_SPLIT_COLUMN",
]
_MIRRORED_GUARD_STRINGS = [
    "DIGITS",
    "HEX_DIGITS",
    "ALPHANUMERIC",
    "SHORTCODE_CHARACTERS",
]
# The sweep vocabulary sits one module below both TypeScript renderers rather than inside the
# mirror, so those literals are scraped unprefixed and from there instead: ZERO_WIDTH_SPACE below,
# SWEEP_PENDING_WORD in test_render_sync.py, and the two `alt="..."` attributes -- composed there
# from a phrase rather than declared whole -- each against the declaration it is composed from,
# which is the value the sweep actually greps for.


@pytest.mark.parametrize("name", _MIRRORED_NUMBERS)
def test_typescript_number_matches_python(name: str) -> None:
    extracted = ts_source.ts_number(_TS_OUTLINE, f"OUTLINE_{name}")
    canonical = getattr(verdict_outline, name)
    assert extracted == canonical, _drift(_TS_OUTLINE, f"OUTLINE_{name} is {extracted}, Python has {canonical}")


@pytest.mark.parametrize("name", _MIRRORED_STRINGS)
def test_typescript_string_matches_python(name: str) -> None:
    extracted = ts_source.ts_string(_TS_OUTLINE, f"OUTLINE_{name}")
    canonical = getattr(verdict_outline, name)
    assert extracted == canonical, _drift(_TS_OUTLINE, f"OUTLINE_{name} is {extracted!r}, Python has {canonical!r}")


@pytest.mark.parametrize("name", _MIRRORED_GUARD_NUMBERS)
def test_typescript_guard_number_matches_python(name: str) -> None:
    extracted = ts_source.ts_number(_TS_GUARDS, name)
    canonical = getattr(verdict_outline, name)
    assert extracted == canonical, _drift(_TS_GUARDS, f"{name} is {extracted}, Python has {canonical}")


@pytest.mark.parametrize("name", _MIRRORED_GUARD_STRINGS)
def test_typescript_guard_string_matches_python(name: str) -> None:
    extracted = ts_source.ts_string(_TS_GUARDS, name)
    canonical = getattr(verdict_outline, name)
    assert extracted == canonical, _drift(_TS_GUARDS, f"{name} is {extracted!r}, Python has {canonical!r}")


def test_typescript_zero_width_space_matches_python() -> None:
    extracted = ts_source.ts_string(_TS_SWEEP, "ZERO_WIDTH_SPACE")
    canonical = verdict_outline.ZERO_WIDTH_SPACE
    assert extracted == canonical, _drift(_TS_SWEEP, f"ZERO_WIDTH_SPACE is {extracted!r}, Python has {canonical!r}")


_SHORTHAND_CLASS_RE = re.compile(r"\\[sSdDwWb]")


def test_no_python_pattern_uses_a_shorthand_class() -> None:
    """`\\s`, `\\d`, `\\w` and `\\b` all mean something different in JavaScript."""
    patterns = [value.pattern for value in vars(verdict_outline).values() if isinstance(value, re.Pattern)]
    assert patterns
    offenders = [pattern for pattern in patterns if _SHORTHAND_CLASS_RE.search(pattern)]
    assert offenders == [], f"language-dependent shorthand class in {offenders}"


# Every TypeScript module the mirror is spread across. A regex that moves between them must not
# fall out of this check on the way.
_SHORTHAND_CLASS_FILES = [_TS_OUTLINE, _TS_GUARDS, _TS_SWEEP]


@pytest.mark.parametrize("ts_file", _SHORTHAND_CLASS_FILES)
def test_no_typescript_pattern_uses_a_shorthand_class(ts_file: str) -> None:
    # Every comment in these modules is a whole line, so dropping those leaves only code to search.
    code = [line for line in ts_source.read(ts_file).splitlines() if not line.lstrip().startswith("//")]
    offenders = [line for line in code if _SHORTHAND_CLASS_RE.search(line)]
    assert offenders == [], f"language-dependent shorthand class in {ts_file}: {offenders}"


def test_greenlight_sentinel_matches_the_sweep_vocabulary() -> None:
    alt = ts_source.ts_string(_TS_SWEEP, "GREENLIGHT_PENDING_ALT")
    assert f'alt="{alt}"' == verdict_outline.GREENLIGHT_PENDING_ALT_ATTR, _drift(
        _TS_SWEEP,
        f'the sweep matches alt="{alt}", which this module does not defuse. A live sentinel in a '
        f"terminal render pins the PR into every Dr. CI sweep forever.",
    )


def test_advisor_sentinel_matches_the_badge() -> None:
    prefix = ts_source.ts_string(_TS_ADVISOR, "ADVISOR_ALT_PREFIX")
    pattern = r"^export const ADVISOR_PENDING_ALT = `\$\{ADVISOR_ALT_PREFIX\}([^`]*)`;$"
    match = re.search(pattern, ts_source.read(_TS_ADVISOR), re.MULTILINE)
    assert match is not None, f"no `ADVISOR_PENDING_ALT` template in {_TS_ADVISOR}: {ts_source.RESTRUCTURED}"
    assert f'alt="{prefix}{match.group(1)}"' == verdict_outline.ADVISOR_PENDING_ALT_ATTR, _drift(
        _TS_ADVISOR, "the advisor's in-progress sentinel is not the one this module defuses"
    )


def test_the_parity_fixture_is_reachable_from_the_typescript_suite() -> None:
    # torchci/test/greenlightOutline.test.ts resolves this exact path; a rename here that misses
    # it turns the parity suite into a load error rather than a failure anyone can read.
    ts_test = ts_source.ROOT / "torchci/test/greenlightOutline.test.ts"
    assert ts_test.is_file()
    assert PARITY_CASES_PATH.name in ts_test.read_text()


def test_python_and_typescript_agree_on_the_escape_table() -> None:
    """Both sides must produce the same entity for all five escaped characters."""
    assert render_outline_html("- & < > \" '") == "<ul><li><b>&amp; &lt; &gt; &quot; &#x27;</b></li></ul>"
