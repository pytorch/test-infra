"""Turn the greenlight decision export into the set of pull requests worth replaying.

A replay is only informative where the original verdict can be held against a real
outcome, so this narrows the export to rows where greenlight reached a verdict, the code
reached ``main``, and the diff that verdict covers is still recoverable. Reading the file
back is :mod:`.cells`; placing a pull request in time is :mod:`.timeline`. Three properties
of the corpus shape the filter itself and are easy to get wrong.

**``verdict_staleness`` answers the wrong question for a PR that landed more than once.**
It compares the judged head against the PR's *final* head, which for a PR that landed,
was reverted and landed again belongs to the last landing: a verdict covering the first
landing exactly still reads ``content-changed``. Those rows are admitted on a different
test -- that a verdict exists at or before the first landing -- and re-derived as of that
instant. Single-landing rows keep the staleness test, where it means what it says.

**A ``scope_too_large`` verdict is not always a verdict.** The reviewer workflow's diff
size gate declines an oversized PR by copying a canned verdict in, with no model
invocation at all, and replaying one measures nothing: the new policy's gate declines it
again for the same arithmetic reason. The reason code does not separate the two --
measured 2026-09-18 over the full export, 18 rows carry ``scope_too_large`` and only 12
are canned -- so the test is the message text, which the gate copies verbatim.

**The landed commit is a rebase, so the first landing cannot be found by SHA.** mergebot
rewrites the commit onto current ``main`` before pushing, and the resulting SHA appears
nowhere in ``misc.greenlight_pr_state.head_sha`` (0 of 8 multi-landing PRs matched, as of
2026-09-18). The landing is located by its trailer on ``refs/heads/main`` and the verdict
by time, via ``fetch_decisions(as_of=...)``.
"""

from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime
from types import MappingProxyType
from typing import Any, Mapping, Sequence, TYPE_CHECKING

from torchci.greenlight_decisions.loc import (
    compute_loc,
    LOC_STATUS_MISSING_SHA,
    STALENESS_EXACT,
    STALENESS_REBASE_ONLY,
)
from torchci.greenlight_decisions.query import fetch_decisions
from torchci.greenlight_decisions.rows import (
    blank_loc,
    first_sentence,
    LOC_COLUMNS,
    to_utc_naive,
)
from torchci.greenlight_replay.cells import load_rows, to_cell
from torchci.greenlight_replay.timeline import (
    fetch_first_verdicts,
    fetch_landings,
    LAND,
    Landing,
    MAIN_REF,
    REVERT,
    SQL_FIRST_VERDICTS,
    SQL_LANDINGS,
)


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client

# Names carrying a trailing comment are re-exported from the modules this one was split
# out of. Callers meet the whole frame surface here, and a split must not move a name out
# from under them; test_frame asserts each is the same object as its source.
__all__ = [
    "apply_frame",
    "CANNED_TOO_LARGE_MESSAGES",
    "FUNNEL_STAGES",
    "fetch_first_verdicts",  # .timeline
    "fetch_landings",  # .timeline
    "LAND",  # .timeline
    "is_size_gate_decline",
    "Landing",  # .timeline
    "load_rows",  # .cells
    "MAIN_REF",  # .timeline
    "rederive_first_landing",
    "REDERIVED_DECISION_COLUMNS",
    "REVERT",  # .timeline
    "sample_rows",
    "SQL_FIRST_VERDICTS",  # .timeline
    "SQL_LANDINGS",  # .timeline
]

logger = logging.getLogger(__name__)

LIFECYCLE_DECIDED = "decided"
LANDED_CELL = "true"

# How the export renders a datetime cell, parsed back to compare against a landing.
_CELL_UTC_SUFFIX = "Z"
_CELL_UTC_OFFSET = "+00:00"

# The judged diff is still recoverable under exactly these two: same head, or a different
# head whose content is byte-identical.
ADMITTED_STALENESS = frozenset({STALENESS_EXACT, STALENESS_REBASE_ONLY})

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

# Everything --as-of moves. PR metadata, human reviews and the size counters read at their
# latest mirrored value whatever the cutoff, so re-deriving those would not recover the past
# -- it would desynchronise these rows from every other row in the file.
REDERIVED_DECISION_COLUMNS = (
    "decision",
    "decision_reason",
    "decision_message",
    "decision_head_sha",
    "decision_run_id",
    "decision_version",
    "lifecycle_status",
    "is_shadow",
    "n_terminal_decisions",
    "verdict_flipped",
)

# Every counter apply_frame reports, in the order they read as a funnel. "multi_landing"
# is not a drop: it counts kept rows whose decision columns still need re-deriving, and
# whose size-gate test therefore cannot be settled here -- see is_size_gate_decline.
FUNNEL_STAGES = (
    "input",
    "unreadable_pr_number",
    "not_landed",
    "not_decided",
    "size_gate",
    "stale",
    "no_verdict_at_first_landing",
    "kept",
    "multi_landing",
)


def is_size_gate_decline(row: Mapping[str, str]) -> bool:
    """Whether this row's verdict was copied in by the diff-size gate, not written by a model.

    Applied to whichever verdict will actually be replayed: ``apply_frame`` settles it for a
    row whose verdict is final, and the caller settles it for a re-derived one. The test is
    the message text rather than ``decision_reason``, because the reviewer writes its own
    prose under the same reason code -- measured 2026-09-18 over the full export, 18 rows
    carry ``scope_too_large`` and only 12 are canned.
    """
    return row.get("decision_message", "").strip() in CANNED_TOO_LARGE_MESSAGES


def apply_frame(
    rows: Sequence[dict[str, str]],
    landings: Mapping[int, list[Landing]],
    first_verdicts: Mapping[int, datetime] = MappingProxyType({}),
) -> tuple[list[dict[str, str]], dict[str, int]]:
    """Narrow the export to the rows a replay can learn something from.

    Returns the surviving rows in input order and a funnel counter keyed by
    ``FUNNEL_STAGES``. Each row is charged to the first stage that rejects it, so the
    counts partition the input and the order of the tests is what they mean: a size-gate
    decline that is also stale reads as ``size_gate``, the more fundamental of the two.

    A row survives when the code landed, greenlight reached a verdict, that verdict was the
    model's own rather than the size gate's, and the diff it judged is recoverable. That last
    test differs by how often the PR landed: with one landing ``verdict_staleness`` compares
    the judged head against the right head; with more it names the wrong landing, so the row
    is instead required to have a verdict at or before the first landing -- the thing
    ``rederive_first_landing`` will go looking for.

    **The size-gate test is only settled here for a row whose verdict is final.** A
    multi-landing row's verdict is replaced by ``rederive_first_landing``, and the two can
    disagree about whether a model ran at all: a PR can be declined by the size gate at its
    first landing and genuinely reviewed by its last, or the reverse. Testing the stored
    verdict would then either admit a canned decline for replay or charge a real verdict to
    ``size_gate``. The caller applies :func:`is_size_gate_decline` to the re-derived row and
    adds it to the same counter.

    ``first_verdicts``, from :func:`fetch_first_verdicts`, is what makes that last test
    exact. Without it the row's own ``decision_version`` stands in, and since that is the
    *selected* verdict rather than the earliest one the test is merely sufficient: it can
    drop a row that did have an earlier verdict, and on the corpus as of 2026-09-18 it drops
    two of six. It can never admit one that has none, so re-derivation cannot fail either
    way -- supplying the mapping buys back rows, it does not buy correctness.
    """
    stats = dict.fromkeys(FUNNEL_STAGES, 0)
    stats["input"] = len(rows)
    kept: list[dict[str, str]] = []

    for row in rows:
        # First, because a row nothing can name is unusable whatever else it says, and
        # charging it to a later stage would hide a corrupt file as an ordinary drop.
        number = _pr_number(row)
        if number is None:
            stats["unreadable_pr_number"] += 1
            continue
        if row.get("landed") != LANDED_CELL:
            stats["not_landed"] += 1
            continue
        if row.get("lifecycle_status") != LIFECYCLE_DECIDED:
            stats["not_decided"] += 1
            continue
        lands = [e for e in landings.get(number, ()) if e.kind == LAND]
        if len(lands) > 1:
            if not _verdict_by(row, number, lands[0].ts, first_verdicts):
                stats["no_verdict_at_first_landing"] += 1
                continue
            stats["multi_landing"] += 1
        elif is_size_gate_decline(row):
            stats["size_gate"] += 1
            continue
        elif row.get("verdict_staleness") not in ADMITTED_STALENESS:
            stats["stale"] += 1
            continue
        kept.append(row)

    stats["kept"] = len(kept)
    return kept, stats


def rederive_first_landing(
    client: Client, repo: str, row: dict[str, str], first_land_ts: datetime
) -> dict[str, str]:
    """Rewrite one row's verdict to the one in effect at its first landing.

    ``first_land_ts`` is the timestamp of the earliest ``Landing`` whose kind is ``land``,
    not simply of the earliest event: reading ``[0]`` unchecked breaks on any later kind.

    Only the columns ``--as-of`` actually moves are replaced; the PR metadata beside them is
    a live read in both fetches, so copying it in would swap the export's snapshot for a later
    one. The LOC columns are recomputed against this row's own ``base_sha`` and
    ``final_head_sha`` because ``decision_head_sha`` has changed and they describe the diff it
    names -- left alone they would go on describing a landing this row no longer refers to.
    The recomputed ``verdict_staleness`` still compares against the PR's *final* head, so on
    these rows it reports drift since the landing being replayed rather than a stale verdict,
    and usually reads ``content-changed``.

    A re-derived row therefore carries two measurements of "how big is this change" from
    different eras: ``loc`` and ``sig_loc`` size the first landing, while ``pr_loc``,
    ``additions``, ``deletions`` and ``changed_files`` stay at the pull request's current
    live values. They are not expected to agree and neither is wrong; they answer different
    questions about different instants.

    Raises ``LookupError`` if greenlight recorded nothing for the PR at that instant --
    ``apply_frame`` drops such rows before they get here -- and propagates what the GitHub
    read raises.
    """
    number = _pr_number(row)
    if number is None:
        raise ValueError(
            f"row names no readable pull request: {row.get('pr_number')!r}"
        )
    record = _decision_at(client, repo, number, first_land_ts)

    rederived = dict(row)
    for column in REDERIVED_DECISION_COLUMNS:
        rederived[column] = to_cell(record.get(column, ""))
    rederived["decision_summary"] = first_sentence(record.get("decision_message"))

    measured = _measure_rederived(repo, rederived)
    for column in LOC_COLUMNS:
        rederived[column] = to_cell(measured.get(column, ""))
    return rederived


def sample_rows(
    rows: Sequence[dict[str, str]],
    *,
    frac: float | None = None,
    n: int | None = None,
    seed: int,
) -> list[dict[str, str]]:
    """Draw a reproducible subset of ``rows``, keeping them in input order.

    Exactly one of ``frac`` and ``n`` must be given; passing both or neither raises
    ``ValueError``, because a harness that silently preferred one would report a sample size
    nobody asked for.

    **Selection is by a hash of the seed and the pull request, never by position in the
    frame.** The corpus grows every day, so re-exporting between runs is ordinary, and a
    positional draw reassigns almost the whole sample when one row is added ahead of the
    others -- measured at seed 0, growing a 100-row frame by one row left 1 of 10 sampled
    rows in common. That silently voids every verdict already paid for: a resumed run finds
    its completed pull requests are no longer in the sample. Ranking each row by
    ``sha256(seed, repo, pr_number)`` and taking the lowest instead means an existing row's
    rank never moves, so growth changes the selection only where a new row genuinely
    outranks an old one, and ``seed`` identifies a set of pull requests rather than a set of
    offsets into one particular file.

    ``frac`` rounds up, so a nonzero share of a non-empty frame never sizes to nothing and
    cannot be mistaken for the frame having admitted nothing.
    """
    if (frac is None) == (n is None):
        raise ValueError("pass exactly one of frac or n")

    if frac is not None:
        if not 0 < frac <= 1:
            raise ValueError(f"frac must be in (0, 1], got {frac!r}")
        size = math.ceil(len(rows) * frac)
    elif n is not None:
        if n < 0:
            raise ValueError(f"n must not be negative, got {n!r}")
        size = min(n, len(rows))
        if size < n:
            logger.warning(
                "asked for %d rows but the frame holds %d; sampling all of them",
                n,
                size,
            )

    ranked = sorted(range(len(rows)), key=lambda index: _sample_key(rows[index], seed))
    drawn = set(ranked[:size])
    return [row for index, row in enumerate(rows) if index in drawn]


def _sample_key(row: Mapping[str, str], seed: int) -> bytes:
    """A row's rank, fixed by the seed and the pull request it names.

    NUL-joined rather than concatenated so that no two different pull requests can spell
    the same payload, and hashed rather than seeded into a PRNG so that the rank depends on
    nothing but this row -- not on how many rows precede it, nor on which other rows the
    frame happens to hold today.
    """
    payload = "\x00".join((str(seed), row.get("repo", ""), row.get("pr_number", "")))
    return hashlib.sha256(payload.encode("utf-8")).digest()


def _pr_number(row: Mapping[str, str]) -> int | None:
    """This row's pull request number, or ``None`` if the cell cannot be read."""
    raw = row.get("pr_number", "")
    try:
        return int(raw)
    except ValueError:
        logger.warning("unreadable pr_number %r; dropping the row", raw)
        return None


def _verdict_by(
    row: Mapping[str, str],
    number: int,
    first_land_ts: datetime,
    first_verdicts: Mapping[int, datetime],
) -> bool:
    """Whether a verdict this row could be re-derived to exists at or before the landing.

    Falls back to the row's own ``decision_version`` when the ledger's earliest verdict was
    not fetched. Both are real verdict times, so a true answer is always sound; only the
    fallback can be needlessly false, because the selected verdict need not be the first.
    """
    earliest = first_verdicts.get(number) or _verdict_time(row)
    return earliest is not None and earliest <= first_land_ts


def _verdict_time(row: Mapping[str, str]) -> datetime | None:
    """The selected verdict's instant, parsed back out of its cell. Blank means none."""
    cell = row.get("decision_version", "")
    if not cell:
        return None
    if cell.endswith(_CELL_UTC_SUFFIX):
        cell = cell[: -len(_CELL_UTC_SUFFIX)] + _CELL_UTC_OFFSET
    try:
        return to_utc_naive(datetime.fromisoformat(cell))
    except ValueError:
        logger.warning(
            "unreadable decision_version %r; treating it as no verdict", cell
        )
        return None


def _decision_at(
    client: Client, repo: str, number: int, as_of: datetime
) -> Mapping[str, Any]:
    for record in fetch_decisions(client, repo, as_of=as_of):
        if record["pr_number"] == number:
            return record
    raise LookupError(
        f"greenlight recorded no state for {repo} PR {number} at or before {as_of}, "
        "so the verdict covering its first landing cannot be recovered"
    )


def _measure_rederived(repo: str, row: Mapping[str, str]) -> Mapping[str, Any]:
    base_sha = row.get("base_sha", "")
    head_sha = row.get("decision_head_sha", "")
    if not base_sha or not head_sha:
        return blank_loc(LOC_STATUS_MISSING_SHA)
    return compute_loc(repo, base_sha, head_sha, row.get("final_head_sha", ""))
