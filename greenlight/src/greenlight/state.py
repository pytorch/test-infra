"""Read the authoritative per-PR greenlight state from ClickHouse.

The scanner is read-only: it observes the authoritative ``misc.greenlight_pr_state`` row
per PR to decide whether to dispatch a review. Writes go through the S3 -> replicator path
(see ``verdict``), never a direct INSERT. The table keeps every emit as history: the
``SharedReplacingMergeTree`` never collapses rows because the sort key
``(repo, pr_number, run_id, emit_id)`` ends in a per-emit-unique ``emit_id``. So the
authoritative row per PR is selected at read
time: ``ORDER BY pr_number, run_id DESC, version DESC LIMIT 1 BY pr_number`` keeps the
highest ``run_id`` and, within that run, the latest ``version``. Ordering by ``run_id``
ahead of ``version`` is race-proof: a superseded slower dispatch that happens to finish
with a later ``version`` still loses to the newer dispatch's higher ``run_id``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC
from typing import TYPE_CHECKING

from greenlight import clickhouse_client

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from datetime import datetime

    from clickhouse_connect.driver.client import Client

__all__ = ["PRState", "read_latest_states"]

_QUERY = "SELECT pr_number, status, eval_hash, head_sha, version FROM misc.greenlight_pr_state WHERE repo = %(repo)s"
_PR_FILTER = " AND pr_number IN %(pr_numbers)s"
_ORDER_LIMIT = " ORDER BY pr_number, run_id DESC, version DESC LIMIT 1 BY pr_number"


@dataclass(frozen=True, slots=True)
class PRState:
    pr_number: int
    status: str
    eval_hash: str
    head_sha: str
    version: datetime


def _naive_utc(value: datetime) -> datetime:
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
            version=_naive_utc(row["version"]),
        )
        for row in result.named_results()
    }
