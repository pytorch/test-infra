"""Read per-PR greenlight state from ClickHouse.

Two reads live here. ``read_latest_states`` observes the authoritative
``misc.greenlight_pr_state`` row per PR to decide whether to dispatch a review;
``read_reverted_pr_numbers`` asks a separate question -- has this PR *ever* recorded a
``REVERTED`` row -- which deliberately does not depend on that row winning the
authoritative-row selection below.

Writes go through the S3 -> replicator path
(see ``verdict``), never a direct INSERT. The table keeps every emit as history: the
``SharedReplacingMergeTree`` never collapses rows because the sort key
``(repo, pr_number, run_id, emit_id)`` ends in a per-emit-unique ``emit_id``. So the
authoritative row per PR is selected at read
time: ``ORDER BY pr_number, run_id DESC, version DESC LIMIT 1 BY pr_number`` keeps the
highest ``run_id`` and, within that run, the latest ``version``. Ordering by ``run_id``
ahead of ``version`` is race-proof: a superseded slower dispatch that happens to finish
with a later ``version`` still loses to the newer dispatch's higher ``run_id``.

``next_run_id`` is the write-side counterpart of that selection: it is what every scan-written
row stamps to become the row these reads return.

Both reads here are deliberately shadow-UNfiltered, and that is the one place this reader
diverges from the two HUD readers (Dr. CI's ``greenlight_pr_states`` query and the
``/api/greenlight/pr_state`` route), which both filter ``shadow = false`` in ``WHERE``. Those two
answer "does an authoritative verdict exist"; this one answers "has a review already been
dispatched, and at what ``run_id``". Filtering here would blind the scan to its own shadow
markers, so every shadow PR would read as never-dispatched and be re-dispatched on every scan,
forever.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC
from typing import TYPE_CHECKING

from greenlight import clickhouse_client
from greenlight.constants import STATUS_REVERTED

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from datetime import datetime

    from clickhouse_connect.driver.client import Client

__all__ = ["PRState", "naive_utc", "next_run_id", "read_latest_states", "read_reverted_pr_numbers"]

_QUERY = (
    "SELECT pr_number, status, eval_hash, head_sha, version, run_id FROM misc.greenlight_pr_state WHERE repo = %(repo)s"
)
_PR_FILTER = " AND pr_number IN %(pr_numbers)s"
_ORDER_LIMIT = " ORDER BY pr_number, run_id DESC, version DESC LIMIT 1 BY pr_number"
_REVERTED_QUERY = (
    "SELECT DISTINCT pr_number FROM misc.greenlight_pr_state WHERE repo = %(repo)s AND status = %(status)s"
)


@dataclass(frozen=True, slots=True)
class PRState:
    pr_number: int
    status: str
    eval_hash: str
    head_sha: str
    version: datetime
    run_id: int


def next_run_id(recorded: PRState | None) -> int:
    """The ``run_id`` a scan-written row must carry to supersede ``recorded`` as the latest row.

    One above the prior row's, so it wins the ``run_id DESC`` selection above; a PR with no prior
    row has no prior run and so bases at 0, giving 1. The reviewer run's own ``github.run_id`` is
    far higher and supersedes the scan's marker in turn once that run starts.
    """
    return (recorded.run_id if recorded is not None else 0) + 1


def naive_utc(value: datetime) -> datetime:
    # clickhouse-connect returns tz-aware DateTime64 when the effective ClickHouse server
    # timezone is non-UTC; decision._aged_out subtracts a naive ``now`` and would raise on
    # a tz-aware operand. Normalize to naive UTC so version is server-timezone-independent.
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def read_latest_states(
    repo: str,
    pr_numbers: Sequence[int] | None = None,
    *,
    connect: Callable[[], Client] = clickhouse_client.connect,
) -> dict[int, PRState]:
    """Return the latest ``misc.greenlight_pr_state`` row per PR, keyed by ``pr_number``.

    ``pr_numbers`` is None to read every PR for ``repo``, or a sequence to restrict the
    read to those PRs. An empty sequence requests zero PRs and returns ``{}`` without a
    query. Query and connection errors propagate; the connection is always closed.
    """
    if pr_numbers is not None and not pr_numbers:
        return {}
    query = _QUERY
    params: dict[str, object] = {"repo": repo}
    if pr_numbers is not None:
        query += _PR_FILTER
        params["pr_numbers"] = tuple(pr_numbers)
    query += _ORDER_LIMIT
    client = connect()
    try:
        result = client.query(query, parameters=params)
    finally:
        client.close()
    return {
        int(row["pr_number"]): PRState(
            pr_number=int(row["pr_number"]),
            status=row["status"],
            eval_hash=row["eval_hash"],
            head_sha=row["head_sha"],
            version=naive_utc(row["version"]),
            run_id=int(row["run_id"]),
        )
        for row in result.named_results()
    }


def read_reverted_pr_numbers(
    repo: str,
    pr_numbers: Sequence[int] | None = None,
    *,
    connect: Callable[[], Client] = clickhouse_client.connect,
) -> set[int]:
    """Return the PRs of ``repo`` that have ever recorded a ``REVERTED`` row.

    Existence, not recency: a later ``AI_REVIEW_STARTED`` row carries the real
    ``github.run_id`` and outranks any ``REVERTED`` row in ``read_latest_states``' selection,
    so keying the permanent exclusion on the authoritative row would let it lapse.

    ``pr_numbers`` is None to scan every PR for ``repo``, or a sequence to restrict the read
    to those PRs. An empty sequence returns ``set()`` without a query. Query and connection
    errors propagate; the connection is always closed.
    """
    if pr_numbers is not None and not pr_numbers:
        return set()
    query = _REVERTED_QUERY
    params: dict[str, object] = {"repo": repo, "status": STATUS_REVERTED}
    if pr_numbers is not None:
        query += _PR_FILTER
        params["pr_numbers"] = tuple(pr_numbers)
    client = connect()
    try:
        result = client.query(query, parameters=params)
    finally:
        client.close()
    return {int(row["pr_number"]) for row in result.named_results()}
