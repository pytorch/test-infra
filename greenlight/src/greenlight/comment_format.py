"""Rendering of greenlight's PR comment bodies.

One place owns the comment layout -- the hidden verdict marker that anchors the single
evolving comment, the ``<details>`` scaffold, and the defanging of untrusted model text --
so the in-flight marker path and the LAND/NO_LAND verdict path stay byte-for-byte consistent.

A verdict message arrives in one of two formats and the renderer is chosen per message, never per
deployment: ``verdict_outline`` takes a bullet outline, and everything else goes out in a backtick
fence. The fence is the render for prose, not a fallback from a failed one -- nothing enforces the
outline shape, so a paragraph is a valid verdict, and it reads better fenced than forced into a
one-item bullet list. Stored rows keep the path alive independently of that: Dr. CI's query carries
no time filter and the scan writes no newer row once a PR is human-decided, ages out of the review
window, or is labelled ``Stale``, so a verdict recorded before the outline format existed re-renders
unchanged for as long as its PR stays open. Either reason alone obliges both renderers to stay, and
each message has to come out in the format it was written in.

The outline block is one line of raw HTML that ``_details_comment`` emits at column 0 with a blank
line ahead of it, and that placement buys a predictable layout rather than containment: cmark-gfm
still reads the block as raw HTML under three spaces of indent, and dropping the blank line leaves
it inside the enclosing ``<details>`` block, raw HTML either way. Containment is
``verdict_outline``'s, and it rests on two properties nothing here may break -- escaping every leaf,
which is what leaves an injected tag inert, and holding the list on one line, which is what keeps a
blank line from ending the block early and what keeps an ``@pytorchbot`` command off a line start,
the only defence an ``@`` inside a code span gets.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.constants import STATUS_AI_REVIEW_STARTED, STATUS_LAND
from greenlight.verdict_outline import is_outline, render_outline_html

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

_MESSAGE_CAP = 4000
_ZERO_WIDTH_SPACE = chr(0x200B)

# The hidden marker anchors the single evolving verdict comment: every run locates its own
# prior comment by this substring and edits it in place, so NO_LAND<->LAND transitions reuse
# one comment instead of stacking new ones.
COMMENT_MARKER = "<!-- greenlight-verdict -->"
LAND_HEADLINE = "PR approved to be merged without human review"
NO_LAND_HEADLINE = "PR requires human review"
REVIEWING_HEADLINE = "Green Light review in progress"
INCOMPLETE_HEADLINE = "Green Light review did not complete"

# A distinct marker from COMMENT_MARKER so a recheck refusal is upserted into its own comment and
# can never overwrite (or be overwritten by) a LAND/NO_LAND verdict comment on the same PR.
RECHECK_REFUSAL_MARKER = "<!-- greenlight-recheck-refusal -->"
RECHECK_REFUSAL_HEADLINE = "Green Light will not re-review this PR"


def defang(text: str) -> str:
    """Render untrusted model text safe to post to GitHub.

    Caps length, neutralizes @-mentions/bot-commands with a zero-width space after each
    '@', and wraps the result in a code fence longer than any backtick run it contains so
    the content cannot break out of the block.
    """
    capped = text[:_MESSAGE_CAP]
    neutralized = capped.replace("@", "@" + _ZERO_WIDTH_SPACE)
    longest = current = 0
    for ch in neutralized:
        current = current + 1 if ch == "`" else 0
        longest = max(longest, current)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{neutralized}\n{fence}"


def _message_block(message: str) -> str:
    """Render one untrusted model message in whichever of the two formats it was written in.

    Both the choice of renderer and the render itself are guarded, and guarded against every
    exception rather than only the containment tripwire's own class: anything that escapes here
    fails the verdict CLI after the row is written to disk but before the workflow's success()-gated
    upload, so the row never reaches S3; the retry branches fire only on a cancelled or failed
    *review* job, which succeeded, and the PR's last recorded status is then AI_REVIEW_STARTED --
    in-flight, not retry-eligible, so no later scan re-dispatches it and the PR shows "reviewing"
    forever. The fence renders any message correctly and is where a prose verdict goes anyway, so
    answering an outline with it here costs a layout and nothing the reader needs, while the
    tripwire keeps its guarantee that an uncontained block is never posted.
    """
    try:
        if is_outline(message):
            rendered = render_outline_html(message)
            if rendered:
                return rendered
    except Exception as exc:
        logger.error("outline render failed, falling back to the fenced renderer: %s", exc, exc_info=True)
    return defang(message)


def _details_comment(
    *,
    run_id: int | None,
    headline: str,
    summary: str,
    body_lines: Iterable[str],
    job_url: str,
) -> str:
    parts = [COMMENT_MARKER]
    if run_id is not None:
        parts.append(github_client.format_run_marker(run_id))
    parts += [f"**{headline}**", "", "<details>", f"<summary>{summary}</summary>", ""]
    parts += list(body_lines)
    if job_url:
        parts += ["", f"[Inference job]({job_url})"]
    parts.append("</details>")
    return "\n".join(parts)


def verdict_body(status: str, reason: str, message: str, job_url: str, run_id: int | None) -> str:
    headline = LAND_HEADLINE if status == STATUS_LAND else NO_LAND_HEADLINE
    return _details_comment(
        run_id=run_id,
        headline=headline,
        summary="Why",
        body_lines=[_message_block(message), "", f"reason: `{reason}`"],
        job_url=job_url,
    )


def reviewing_body(job_url: str, run_id: int | None) -> str:
    return _details_comment(
        run_id=run_id,
        headline=REVIEWING_HEADLINE,
        summary="Details",
        body_lines=["Green Light is reviewing this PR."],
        job_url=job_url,
    )


def incomplete_body(reason: str, job_url: str, run_id: int | None) -> str:
    return _details_comment(
        run_id=run_id,
        headline=INCOMPLETE_HEADLINE,
        summary="Details",
        body_lines=[f"reason: `{reason}`"],
        job_url=job_url,
    )


def marker_body(status: str, job_url: str, run_id: int | None) -> str:
    if status == STATUS_AI_REVIEW_STARTED:
        return reviewing_body(job_url, run_id)
    # AI_REVIEW_STARTED is handled above and AI_REVIEW_DISPATCHED is scan-only (never reaches the
    # verdict CLI), so the only marker statuses left here are the retry outcomes (CANCELLED /
    # FAILED); their lowercased name is the human-readable reason shown in the "did not complete"
    # comment.
    return incomplete_body(status.lower(), job_url, run_id)


def recheck_changes_requested_body(detail: str) -> str:
    """Body for a manual ``@greenlight recheck`` refused because a human requested changes.

    ``detail`` is the ``ReviewSkip.detail`` naming the requester; it is a GitHub login (safe
    charset) rendered inside backticks, so no defanging is needed. Carries no job URL or run
    stamp -- a refusal is not tied to a review run.
    """
    return "\n".join(
        [
            RECHECK_REFUSAL_MARKER,
            f"**{RECHECK_REFUSAL_HEADLINE}**",
            "",
            "Green Light does not re-review a PR while a reviewer's requested changes stand; it "
            "reconsiders once the reviewer dismisses or resolves that review, not on the next push.",
            "",
            f"reason: `{detail}`",
        ]
    )
