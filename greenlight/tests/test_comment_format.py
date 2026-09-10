import logging
import re
from pathlib import Path

import pytest

from greenlight import comment_format, github_client, verdict_outline

# A single-paragraph verdict. Nothing enforces the outline shape, so this is a message the reviewer
# can still write today and the fence is the right render for it; separately, every row stored
# before the outline format existed carries this shape, and Dr. CI's query has no time filter, so
# each of those re-renders on every sweep for as long as its PR stays open.
STORED_PROSE = (
    "The change is a two-line guard in torch/distributed/_composable/fsdp/_fsdp_param.py that skips the all-gather "
    "when the parameter group is already resident on the target device, plus the test that covers it in "
    "test/distributed/_composable/fsdp/test_fully_shard_comm.py. Every existing caller keeps its behaviour: the new "
    "branch only fires on a path that previously issued a redundant collective, and the returned handle is the same "
    "object the old code produced, so nothing downstream observes a difference. The rest of the diff is mechanical: "
    "a type annotation on _get_param_group that mypy already inferred, and a docstring fix naming the argument the "
    "signature actually takes. No serialized artifact, no autograd formula and no public API is touched, so a silent "
    "numerical regression is not reachable from here; the worst case is that the guard misfires and the collective "
    "runs as it does today. CI is green on the distributed shards that cover both files, and the new test fails "
    "without the guard, mirroring the fix in #150123."
)

OUTLINE = "\n".join(
    [
        "- Scope: one guard plus its test",
        "  - `_fsdp_param.py` gains a two-line early return",
        "  - the new test fails without it",
        "- Risk: low",
        "  - no serialized artifact or autograd formula is touched",
    ]
)
# Every leaf of it with the bullet marker stripped. A redaction check that named one phrase would
# pass on a log that held all the others.
OUTLINE_LEAVES = [re.sub(r"^\s*-\s*", "", line) for line in OUTLINE.split("\n")]

# Lines that ARE a live pytorchbot command when they start one: the positive control for the test
# below, which a matcher gone inert would otherwise satisfy.
BOT_COMMAND_LINES = [
    "@pytorchbot merge",
    "@pytorchmergebot merge -f 'lint only, everything else is green'",
]
BOT_COMMAND_OUTLINE = "\n".join(
    [
        f"- {BOT_COMMAND_LINES[0]}",
        f"  - {BOT_COMMAND_LINES[1]}",
        "  - and `@pytorchbot merge` inside a code span",
    ]
)
BOT_COMMAND_PROSE = "\n".join([*BOT_COMMAND_LINES, "and `@pytorchbot merge` inside a code span"])
# The same command behind a U+2028, which JavaScript anchors a line start after and
# ``re.MULTILINE`` does not: the positive control that fails if the proxy below ever goes back to
# leaning on ``re.MULTILINE`` and so to matching at fewer positions than the parser it stands in for.
BOT_COMMAND_AFTER_LINE_SEPARATOR = "not a command\u2028" + BOT_COMMAND_LINES[0]

_CLI_PARSER_TS = Path(__file__).resolve().parents[2] / "torchci" / "lib" / "bot" / "cliParser.ts"
_JS_LINE_TERMINATORS_RE = re.compile("[\n\r\u2028\u2029]")
_VERDICT_OUTLINE_PY = Path(__file__).resolve().parents[1] / "src" / "greenlight" / "verdict_outline.py"
_RAISE_RE = re.compile(r"raise \w*Error\([^)]*\)")
# Every way Python can put a runtime value into a message built in place.
_INTERPOLATIONS = ('f"', "f'", "{", "%", ".format(", "+")


def _assert_no_model_text_logged(caplog: pytest.LogCaptureFixture) -> None:
    """Assert the model's message reached neither the log line nor the traceback under it.

    ``caplog.text`` is the formatted record plus its traceback -- what a log sink writes. Asserting
    on ``record.getMessage()`` alone would miss text that arrived through the exception, and
    ``record.exc_info`` holds the exception object, whose message no equality check sees.
    """
    for leaf in OUTLINE_LEAVES:
        assert leaf not in caplog.text


def _bot_command_pattern() -> re.Pattern[str]:
    """pytorchbot's own command matcher, read out of the TypeScript that owns it.

    Scraped rather than copied: what is under test is that greenlight's comment never matches
    whatever pytorchbot actually parses, and a copy would keep passing after the real one moved.
    Compiled without ``re.MULTILINE`` because ``_issues_bot_command`` supplies the line splitting.
    """
    source = _CLI_PARSER_TS.read_text()
    match = re.search(r"^const botCommandPattern = new RegExp\(/(.+)/m\);$", source, re.MULTILINE)
    assert match is not None, f"no botCommandPattern literal in {_CLI_PARSER_TS}"
    return re.compile(match.group(1))


def _issues_bot_command(body: str) -> bool:
    r"""Whether ``lib/bot/pytorchBot.ts`` would read a command out of ``body``.

    The parser under test runs in JavaScript, whose ``/m`` anchors ``^`` and ``$`` after a carriage
    return and the two line separators as well as after ``\n``. ``re.MULTILINE`` anchors after
    ``\n`` alone, so a proxy resting on it matches at *fewer* positions than the parser it stands
    in for -- which for an assertion that nothing matches is a false pass, not a conservative one.
    Splitting on all four and searching each line reproduces the JavaScript anchor set exactly: a
    match has to begin where a line begins and end where it ends, and no line holds a terminator
    for Python's ``.`` to cross where JavaScript's would not.
    """
    pattern = _bot_command_pattern()
    return any(pattern.search(line) is not None for line in _JS_LINE_TERMINATORS_RE.split(body))


def test_defang_neutralizes_at_mentions_and_wraps_in_fence():
    out = comment_format.defang("ping @pytorchbot now")

    assert "@pytorchbot" not in out
    assert "pytorchbot" in out
    assert comment_format._ZERO_WIDTH_SPACE in out
    assert out.startswith("```")
    assert out.endswith("```")


def test_defang_caps_length():
    out = comment_format.defang("x" * 5000)

    assert out.count("x") == 4000


def test_defang_uses_longer_fence_than_backtick_run():
    out = comment_format.defang("before ``` after")

    assert out.split("\n", 1)[0] == "`" * 4
    assert "before ``` after" in out


def test_verdict_body_land_has_marker_run_stamp_headline_reason_and_job_link():
    body = comment_format.verdict_body("LAND", "clean", "looks good", "https://job", 55)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(55) in body
    assert f"**{comment_format.LAND_HEADLINE}**" in body
    assert "<details>" in body
    assert "<summary>Why</summary>" in body
    assert "looks good" in body
    assert "reason: `clean`" in body
    assert "[Inference job](https://job)" in body
    assert body.endswith("</details>")


def test_verdict_body_no_land_headline_and_defangs_message():
    body = comment_format.verdict_body("NO_LAND", "scope_too_large", "ping @pytorchbot", "https://job", None)

    assert f"**{comment_format.NO_LAND_HEADLINE}**" in body
    assert "@pytorchbot" not in body
    assert "pytorchbot" in body
    assert comment_format._ZERO_WIDTH_SPACE in body
    assert "```" in body


def test_verdict_body_omits_job_link_and_run_stamp_when_absent():
    body = comment_format.verdict_body("NO_LAND", "unclear_intent", "hi", "", None)

    assert "[Inference job]" not in body
    assert "https" not in body
    assert "greenlight-run" not in body
    assert "reason: `unclear_intent`" in body
    assert body.endswith("</details>")


def test_prose_verdict_body_is_byte_identical_to_the_fenced_layout():
    body = comment_format.verdict_body("NO_LAND", "unclear_intent", STORED_PROSE, "https://job", 55)

    assert body == "\n".join(
        [
            comment_format.COMMENT_MARKER,
            github_client.format_run_marker(55),
            f"**{comment_format.NO_LAND_HEADLINE}**",
            "",
            "<details>",
            "<summary>Why</summary>",
            "",
            "```",
            STORED_PROSE,
            "```",
            "",
            "reason: `unclear_intent`",
            "",
            "[Inference job](https://job)",
            "</details>",
        ]
    )


def test_prose_is_neither_clipped_nor_bulleted():
    # Why the fence is the better render here, not merely an acceptable one: the outline renderer
    # would clip this at its 400-character leaf cap, bold what survived into one bullet, and guard
    # the `#150123` -- permanently, on every PR the message lands on.
    body = comment_format.verdict_body("LAND", "clean", STORED_PROSE, "", None)

    assert STORED_PROSE in body
    assert "<ul>" not in body
    assert "<li>" not in body
    assert comment_format._ZERO_WIDTH_SPACE not in body


def test_outline_message_renders_as_a_contained_html_list():
    body = comment_format.verdict_body("LAND", "clean", OUTLINE, "https://job", 55)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert "<ul><li><b>Scope: one guard plus its test</b><ul>" in body
    assert "<li>the new test fails without it</li>" in body
    assert "<code>_fsdp_param.py</code>" in body
    assert "```" not in body
    assert body.endswith("</details>")


def test_the_outline_block_is_one_line_at_column_zero_after_a_blank_line():
    # The one-line assertion is the containment one: a break is how the blank line that would end
    # the block gets in, and it is what puts leaf text at a line start. Column 0 and the blank
    # lines either side are layout -- cmark-gfm reads the block as raw HTML under three spaces of
    # indent, and without the blank line ahead it stays inside the enclosing <details> block --
    # pinned here so the parse never turns on what _details_comment puts around it.
    lines = comment_format.verdict_body("LAND", "clean", OUTLINE, "https://job", 55).split("\n")
    index = next(number for number, line in enumerate(lines) if line.startswith("<ul>"))

    assert [line.startswith("<ul>") for line in lines].count(True) == 1
    assert lines[index - 1] == ""
    assert lines[index].endswith("</ul>")
    assert lines[index + 1] == ""


def test_an_outline_whose_leaves_all_flatten_away_renders_in_the_fence():
    message = "\n".join([f"- {verdict_outline.ZERO_WIDTH_SPACE}"] * verdict_outline.MIN_BULLETS)
    body = comment_format.verdict_body("NO_LAND", "review_error", message, "", None)

    assert verdict_outline.is_outline(message) is True
    assert verdict_outline.render_outline_html(message) == ""
    assert "<ul>" not in body
    assert comment_format.defang(message) in body


def test_a_tripped_containment_guard_falls_back_to_the_fence(monkeypatch, caplog):
    # A raise out of here fails the verdict CLI before the row is uploaded, and the workflow only
    # retries a cancelled or failed review job -- so the PR would sit on AI_REVIEW_STARTED forever.
    def boom(message):
        raise RuntimeError("verdict outline holds a line break, which would end the HTML block")

    monkeypatch.setattr(comment_format, "render_outline_html", boom)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        body = comment_format.verdict_body("LAND", "clean", OUTLINE, "https://job", 55)

    assert comment_format.defang(OUTLINE) in body
    assert "<ul>" not in body
    assert body.startswith(comment_format.COMMENT_MARKER)
    assert "reason: `clean`" in body
    assert body.endswith("</details>")
    record = next(record for record in caplog.records if "falling back to the fenced renderer" in record.getMessage())
    assert record.levelno == logging.ERROR
    assert record.exc_info is not None
    _assert_no_model_text_logged(caplog)


def test_a_classifier_that_raises_falls_back_to_the_fence(monkeypatch, caplog):
    # Choosing the renderer reads the same untrusted text rendering it does, so it sits inside the
    # same guard -- a raise here strands the PR on AI_REVIEW_STARTED exactly as one from the render.
    def boom(message):
        raise RuntimeError("classifier read a message it could not handle")

    monkeypatch.setattr(comment_format, "is_outline", boom)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        body = comment_format.verdict_body("LAND", "clean", OUTLINE, "https://job", 55)

    assert comment_format.defang(OUTLINE) in body
    assert "<ul>" not in body
    assert body.startswith(comment_format.COMMENT_MARKER)
    assert "reason: `clean`" in body
    assert body.endswith("</details>")
    record = next(record for record in caplog.records if "falling back to the fenced renderer" in record.getMessage())
    assert record.exc_info is not None
    _assert_no_model_text_logged(caplog)


def test_an_outline_failure_of_any_type_falls_back_to_the_fence(monkeypatch, caplog):
    # The containment tripwire raises RuntimeError, but nothing about the fallback is specific to
    # it: any other bug in the renderer costs the reader a nicer layout, and none may cost the
    # verdict. The Dr. CI mirror of this dispatch catches everything, so narrowing here would also
    # mean one row degrading gracefully on one surface and killing the CLI on the other.
    def boom(message):
        raise ValueError("a renderer bug that is not the containment tripwire")

    monkeypatch.setattr(comment_format, "render_outline_html", boom)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        body = comment_format.verdict_body("NO_LAND", "unclear_intent", OUTLINE, "", None)

    assert comment_format.defang(OUTLINE) in body
    assert "<ul>" not in body
    assert "reason: `unclear_intent`" in body
    assert body.endswith("</details>")
    record = next(record for record in caplog.records if "falling back to the fenced renderer" in record.getMessage())
    assert record.exc_info is not None
    _assert_no_model_text_logged(caplog)


def test_the_outline_renderer_raises_nothing_but_fixed_strings():
    """Pin the half of the redaction the three tests above cannot reach.

    Each of them supplies its own exception, so between them they pin only what the guard hands the
    log -- never what the renderer they stand in for puts inside the exception, which the same
    record renders in full. A raise that interpolated the message would carry it into a log those
    three would still read as clean. The tripwire is unreachable from any input, every line break
    being flattened long before it, so no fixture can raise a real one and the source is the only
    place the property can be pinned. Mirrors the TypeScript scan in greenlightRender.test.ts.
    """
    raises = _RAISE_RE.findall(_VERDICT_OUTLINE_PY.read_text())

    # Without this a pattern that stopped matching would pass on an empty list.
    assert raises, f"no raise statements found in {_VERDICT_OUTLINE_PY}"
    for statement in raises:
        for interpolation in _INTERPOLATIONS:
            assert interpolation not in statement, statement


# A verdict is model prose a PR diff can prompt-inject, and pytorchbot parses the RAW comment body
# it lands in -- not the HTML GitHub renders from it. Neither renderer targets that parser: the
# outline path emits one line that starts `<ul><li><b>`, and both paths put a zero-width space after
# every `@` outside a code span. Inside one neither does, so `<code>@pytorchbot merge</code>` lands
# on a public PR as a live command literal and the one-line shape -- an invariant held for
# containment, not for this -- is the whole of what keeps it off a line start. No per-mechanism test
# reaches that: the defanging tests assert no literal `@pytorchbot` survives, which is exactly what
# the outline path does not hold. Hence an end-to-end assertion, against a pattern scraped from the
# parser rather than a copy of it, so this also fails if pytorchbot widens what it accepts.
# Greenlight's login is not one of the ids pytorchbot skips.
@pytest.mark.parametrize("status", ["LAND", "NO_LAND"])
def test_no_rendered_verdict_can_issue_a_pytorchbot_command(status):
    # Positive control: unrendered, these are commands pytorchbot acts on.
    for line in BOT_COMMAND_LINES:
        assert _issues_bot_command(line) is True
    assert _issues_bot_command(BOT_COMMAND_PROSE) is True
    assert _issues_bot_command(BOT_COMMAND_AFTER_LINE_SEPARATOR) is True
    # Without this both payloads could reach the comment through the same renderer, leaving the
    # other path unexercised.
    assert verdict_outline.is_outline(BOT_COMMAND_OUTLINE) is True
    assert verdict_outline.is_outline(BOT_COMMAND_PROSE) is False

    for message in (BOT_COMMAND_OUTLINE, BOT_COMMAND_PROSE, BOT_COMMAND_AFTER_LINE_SEPARATOR):
        body = comment_format.verdict_body(status, "clean", message, "https://job", 55)

        assert _issues_bot_command(body) is False


@pytest.mark.parametrize("message", [STORED_PROSE, OUTLINE], ids=["prose", "outline"])
def test_run_stamp_reason_line_and_job_link_do_not_move_with_the_message_format(message):
    body = comment_format.verdict_body("NO_LAND", "scope_too_large", message, "https://job", 7)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(7) in body
    assert "\nreason: `scope_too_large`\n" in body
    assert body.endswith("\n[Inference job](https://job)\n</details>")


@pytest.mark.parametrize(
    "message",
    ["", "   ", "\n\n\n", "-", "- ", "-\t", "```", "- ```", "</details>", "- </details>"],
)
def test_a_badly_shaped_message_still_renders_a_whole_comment(message):
    # The renderer coerces; nothing on this path may reject a message the model wrote badly.
    body = comment_format.verdict_body("NO_LAND", "review_error", message, "", None)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert body.endswith("</details>")


def test_reviewing_body_structure():
    body = comment_format.reviewing_body("https://run", 3)

    assert body.startswith(comment_format.COMMENT_MARKER)
    assert github_client.format_run_marker(3) in body
    assert f"**{comment_format.REVIEWING_HEADLINE}**" in body
    assert "<summary>Details</summary>" in body
    assert "Green Light is reviewing this PR." in body
    assert "[Inference job](https://run)" in body
    assert body.endswith("</details>")


def test_incomplete_body_omits_job_link_and_run_stamp_when_absent():
    body = comment_format.incomplete_body("failed", "", None)

    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `failed`" in body
    assert "[Inference job]" not in body
    assert "greenlight-run" not in body


def test_marker_body_reviewing_for_ai_review_started():
    body = comment_format.marker_body("AI_REVIEW_STARTED", "https://run", 4)

    assert f"**{comment_format.REVIEWING_HEADLINE}**" in body
    assert github_client.format_run_marker(4) in body
    assert "[Inference job](https://run)" in body


def test_marker_body_incomplete_uses_lowercased_status_as_reason():
    body = comment_format.marker_body("CANCELLED", "", None)

    assert f"**{comment_format.INCOMPLETE_HEADLINE}**" in body
    assert "reason: `cancelled`" in body


def test_recheck_changes_requested_body_has_marker_headline_and_detail():
    body = comment_format.recheck_changes_requested_body("changes requested by octocat")

    assert body.startswith(comment_format.RECHECK_REFUSAL_MARKER)
    assert f"**{comment_format.RECHECK_REFUSAL_HEADLINE}**" in body
    assert "changes requested by octocat" in body
    # A refusal is not tied to a review run, so it carries no job link or run stamp.
    assert "[Inference job]" not in body
    assert "greenlight-run" not in body
    # A CHANGES_REQUESTED review persists across pushes until the reviewer dismisses/resolves it,
    # so the body must not claim the next push resumes review automatically.
    assert "not on the next push" in body
    assert "reviewed automatically" not in body


def test_recheck_refusal_marker_is_distinct_from_verdict_marker():
    # A refusal must live in its own comment, never overwriting a LAND/NO_LAND verdict comment.
    assert comment_format.RECHECK_REFUSAL_MARKER != comment_format.COMMENT_MARKER
    body = comment_format.recheck_changes_requested_body("changes requested by octocat")
    assert comment_format.COMMENT_MARKER not in body
