"""The verdicts the reviewer workflow writes without a model, recognised by their text.

The size gate and the staging gates decline by copying a canned verdict in, and
replaying one measures the gate rather than the policy, so :mod:`.frame` drops
such rows. Their reason codes are shared with the model's own verdicts, so the
test is the message text, which each gate copies verbatim.
"""

from __future__ import annotations

from typing import Mapping


# Both canned declines the diff-size gate has emitted, from
# .claude/hooks/greenlight/too-large-verdict.json, whose wording 51c10bcf0 rewrote. Drop
# either and half the gate's output stays in the frame as though a model had judged it.
CANNED_TOO_LARGE_MESSAGES = frozenset(
    {
        "This change is too large for the automated reviewer to read in full, so it "
        "is being declined automatically; a human reviewer should assess it.",
        "- Scope\n"
        "  - The diff exceeds the size cap the automated reviewer can read in full\n"
        "  - The size gate declined it before any review ran, so nothing in it was "
        "examined\n"
        "  - A human reviewer should assess this change",
    }
)

# The staging gates' canned declines, from .claude/hooks/greenlight/no-policy-verdict.json
# and greenlight-files-verdict.json. Constants rather than read from a policy tree: the
# frame judges production rows, which whatever tree a replay runs under did not write.
CANNED_STAGING_MESSAGES = frozenset(
    {
        "- Review policy\n"
        "  - No valid repository review policy (`.github/greenlight/review.md` on the "
        "default branch); GreenLight cannot review this repository",
        "- Merge authorization\n"
        "  - The change touches .github/greenlight/, where the repository keeps its "
        "GreenLight config and review policy\n"
        "  - GreenLight never approves a change there; a human reviewer must assess it",
    }
)

CANNED_DECLINE_MESSAGES = CANNED_TOO_LARGE_MESSAGES | CANNED_STAGING_MESSAGES


def is_canned_decline(row: Mapping[str, str]) -> bool:
    """Whether this row's verdict was copied in by a gate, the size gate or a staging
    gate, rather than written by a model.

    Applied to whichever verdict will actually be replayed: ``apply_frame`` settles it for a
    row whose verdict is final, and the caller settles it for a re-derived one. The test is
    the message text rather than ``decision_reason``, because the reviewer writes its own
    prose under the same reason code -- measured 2026-09-18 over the full export, 18 rows
    carry ``scope_too_large`` and only 12 are canned.
    """
    return row.get("decision_message", "").strip() in CANNED_DECLINE_MESSAGES
