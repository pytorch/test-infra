"""When each pull request landed, was reverted, and was first judged.

Three timestamps place a row in time, and the replay frame needs all three: a verdict can
only be replayed against an outcome it could have caused. Two of them come from the
trailers mergebot writes on ``refs/heads/main``, which record every landing and every
revert whatever state the pull request itself ended in. The third comes from greenlight's
own ledger.

The trailer patterns are the export's, imported rather than copied. Two definitions of
"landed" would let the export and the replay disagree about which pull requests exist,
silently and in opposite directions, and the format is load-bearing enough that a change
to it degrades to an empty answer rather than to an error -- which is why
``fetch_landings`` refuses a scan that matched nothing at all, as ``fetch_decisions``
already does for the same reason.

``fetch_first_verdicts`` exists because the export cannot answer its question.
``decision_version`` timestamps the verdict the export *selected*, which for a pull request
that landed more than once is usually a later one; the earliest verdict is what says whether
there is anything to re-derive as of the first landing.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Mapping, NamedTuple, TYPE_CHECKING

from torchci.greenlight_decisions.query import SYNTHETIC_PR_NUMBER
from torchci.greenlight_decisions.rows import to_utc_naive
from torchci.greenlight_decisions.sql import _LANDED_PATTERN, _REVERT_PATTERN


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client

__all__ = [
    "fetch_first_verdicts",
    "fetch_landings",
    "LAND",
    "Landing",
    "MAIN_REF",
    "REVERT",
    "SQL_FIRST_VERDICTS",
    "SQL_LANDINGS",
    "TERMINAL_STATUSES",
]

logger = logging.getLogger(__name__)

LAND = "land"
REVERT = "revert"

# Must stay the ref greenlight_decisions reads its trailers off: a PR that landed on a
# branch this does not name is framed as never having landed.
MAIN_REF = "refs/heads/main"

# Must stay the set SQL_DECISIONS' terminal_rows CTE selects on, or the earliest verdict
# read here would not be the earliest verdict the export could have chosen.
TERMINAL_STATUSES = ("LAND", "NO_LAND")


# One row per (kind, PR, commit) rather than per push row: default.push is a
# SharedReplacingMergeTree whose rows need not have collapsed, and a redelivered webhook
# would otherwise report one landing twice and push a single-landing PR down the
# multi-landing branch. min() over the duplicates keeps the earliest reported time. The two
# scans are unioned rather than branched between because one message can match both -- a
# revert of a revert carries the trailer of the PR it restores.
SQL_LANDINGS = """
WITH main_commits AS (
    SELECT
        lower(tupleElement(commit, 'id')) AS sha,
        tupleElement(commit, 'message') AS msg,
        tupleElement(commit, 'timestamp') AS ts
    FROM default.push
    ARRAY JOIN commits AS commit
    WHERE repository.full_name = {repo:String}
      AND ref = {main_ref:String}
),
events AS (
    SELECT
        {land_kind:String} AS kind,
        toInt64OrZero(extract(msg, {landed_pattern:String})) AS pr_number,
        sha,
        ts
    FROM main_commits
    UNION ALL
    SELECT
        {revert_kind:String} AS kind,
        toInt64OrZero(extract(msg, {revert_pattern:String})) AS pr_number,
        sha,
        ts
    FROM main_commits
)
SELECT kind, pr_number, sha, min(ts) AS ts
FROM events
WHERE pr_number > 0
GROUP BY kind, pr_number, sha
"""


# The earliest verdict greenlight ever recorded for a pull request, which the export does
# not carry: decision_version timestamps the *selected* verdict, and for a PR that landed
# more than once that is usually a later one. Measured 2026-09-18 over the six multi-landing
# rows that reach re-derivation, the selected verdict postdates the first landing on two of
# them while an earlier verdict exists -- so the export's own column cannot answer whether
# there is anything to re-derive.
SQL_FIRST_VERDICTS = """
SELECT pr_number, min(version) AS first_verdict
FROM misc.greenlight_pr_state
WHERE repo = {repo:String}
  AND pr_number != {synthetic_pr:Int64}
  AND status IN {terminal_statuses:Array(String)}
GROUP BY pr_number
"""


class Landing(NamedTuple):
    """One commit on ``main`` that landed or reverted a pull request."""

    kind: str
    sha: str
    ts: datetime


def fetch_landings(client: Client, repo: str) -> dict[int, list[Landing]]:
    """Every landing and revert on ``main``, per pull request, oldest first.

    ``client`` is a ``clickhouse_connect`` client, as built by
    ``torchci.clickhouse.get_clickhouse_client``. The caller owns it; this does not close
    it. Timestamps come back as naive UTC, matching ``fetch_decisions``. Covers the whole
    repository rather than the greenlight corpus: the caller holds the corpus, and a PR
    absent from the result is a PR that never landed.

    Raises ``RuntimeError`` if the scan matched nothing at all -- see
    :func:`_require_trailer_scan_matched`.
    """
    parameters = {
        "repo": repo,
        "main_ref": MAIN_REF,
        "landed_pattern": _LANDED_PATTERN.format(repo=re.escape(repo)),
        "revert_pattern": _REVERT_PATTERN.format(repo=re.escape(repo)),
        "land_kind": LAND,
        "revert_kind": REVERT,
    }
    landings: dict[int, list[Landing]] = {}
    for row in client.query(SQL_LANDINGS, parameters=parameters).named_results():
        landings.setdefault(int(row["pr_number"]), []).append(
            Landing(str(row["kind"]), str(row["sha"]), to_utc_naive(row["ts"]))
        )
    for events in landings.values():
        events.sort(key=lambda event: (event.ts, event.kind, event.sha))
    _require_trailer_scan_matched(landings, repo)
    return landings


def fetch_first_verdicts(client: Client, repo: str) -> dict[int, datetime]:
    """The instant greenlight first reached a verdict on each pull request, naive UTC.

    ``apply_frame`` needs this to tell a multi-landing row whose verdict predates its first
    landing -- and so has something to re-derive -- from one greenlight only saw afterwards,
    whose re-derivation would find nothing. Marker rows are excluded: a dispatch that never
    produced a verdict is not a verdict.
    """
    parameters = {
        "repo": repo,
        "synthetic_pr": SYNTHETIC_PR_NUMBER,
        "terminal_statuses": list(TERMINAL_STATUSES),
    }
    results = client.query(SQL_FIRST_VERDICTS, parameters=parameters).named_results()
    return {
        int(row["pr_number"]): to_utc_naive(row["first_verdict"]) for row in results
    }


def _require_trailer_scan_matched(
    landings: Mapping[int, list[Landing]], repo: str
) -> None:
    """Refuse a scan that matched no pull request at all.

    The same failure the export guards in ``fetch_decisions``, in the same direction: a
    change to the trailer mergebot writes degrades to silence rather than to an error, and
    here the silence empties the frame instead of mislabelling it. Every row would drop as
    ``not_landed`` or ``stale`` and the funnel would read like a finding about the corpus.
    """
    if landings:
        return
    raise RuntimeError(
        f"The landing-trailer scan matched no pull request on {repo} {MAIN_REF}, so the "
        f"frame would be empty. Check that {_LANDED_PATTERN!r} still describes the trailer "
        "mergebot writes on the default branch."
    )
