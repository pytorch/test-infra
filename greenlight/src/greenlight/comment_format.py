"""Rendering of greenlight's PR comment bodies.

One place owns the comment layout -- the hidden verdict marker that anchors the single
evolving comment, the ``<details>`` scaffold, and the defanging of untrusted model text --
so the in-flight marker path and the LAND/NO_LAND verdict path stay byte-for-byte consistent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from greenlight import github_client
from greenlight.constants import STATUS_AI_REVIEW_STARTED, STATUS_LAND

if TYPE_CHECKING:
    from collections.abc import Iterable

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
        body_lines=[defang(message), "", f"reason: `{reason}`"],
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
    # The only remaining marker statuses are the retry outcomes (CANCELLED / FAILED); their
    # lowercased name is the human-readable reason shown in the "did not complete" comment.
    return incomplete_body(status.lower(), job_url, run_id)
