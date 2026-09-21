"""Run the greenlight decision query and shape its rows for the export.

One row per pull request greenlight has recorded state for: the PR's own metadata, the verdict
that applies to it, whether humans approved or requested changes, and the PR's size. No GitHub
calls happen here.

``sql`` holds the query itself and documents the table quirks that shape it; read that before
changing anything about how a column is derived.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, TYPE_CHECKING

from torchci.greenlight_decisions.sql import (
    _LANDED_PATTERN,
    _REVERT_PATTERN,
    _TRAILER_HEALTH_FIELD,
    MULTI_VALUE_SEPARATOR,
    SQL_DECISIONS,
)


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client

__all__ = [
    "DEFAULT_REPO",
    "FIELDS",
    "MULTI_VALUE_SEPARATOR",
    "SQL_DECISIONS",
    "SYNTHETIC_PR_NUMBER",
    "fetch_decisions",
]

DEFAULT_REPO = "pytorch/pytorch"

# The greenlight corpus carries one synthetic PR that exercises the emit path end to end.
SYNTHETIC_PR_NUMBER = 999999

FIELDS = (
    "repo",
    "pr_number",
    "pr_url",
    "pr_status",
    "landed",
    "base_ref",
    "decision",
    "decision_reason",
    "decision_message",
    "decision_head_sha",
    "decision_run_id",
    "decision_version",
    "final_head_sha",
    "base_sha",
    "lifecycle_status",
    "reverted",
    "is_shadow",
    "n_terminal_decisions",
    "verdict_flipped",
    "human_approvals",
    "human_approvers",
    "human_changes_requested",
    "human_change_requesters",
    "additions",
    "deletions",
    "changed_files",
)


_INT_FIELDS = (
    "pr_number",
    "n_terminal_decisions",
    "human_approvals",
    "human_changes_requested",
    "additions",
    "deletions",
    "changed_files",
)

_BOOL_FIELDS = ("landed", "reverted", "is_shadow", "verdict_flipped")


def _as_utc(value: datetime) -> datetime:
    """Attach UTC to a naive datetime, or convert an aware one to UTC.

    A naive ``as_of`` must not simply be handed to the driver: clickhouse-connect reads a naive
    datetime as *client-local* time, so a cutoff of midnight submitted from a UTC-7 host would
    reach the server as 07:00 and admit seven hours of rows past it.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_of_literal(value: datetime) -> str:
    """Render ``value`` as the millisecond-precision UTC text the query casts.

    Formatting here rather than binding a datetime is what preserves the milliseconds, so the
    conversion to UTC has to happen here too -- the rendered text carries no offset.
    """
    return _as_utc(value).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _require_trailer_scan_matched(rows: list[dict[str, Any]]) -> None:
    """Refuse a result in which no PR at all was matched by the landing trailer.

    The trailer classifies the large majority of landed PRs, and a format change degrades to
    silence rather than to an error: every affected PR simply reads ``closed-abandoned``. A corpus
    holding closed PRs but not one trailer match is not a state pytorch/pytorch reaches.
    """
    if not any(row["pr_status"] != "open" for row in rows):
        return
    if any(row[_TRAILER_HEALTH_FIELD] for row in rows):
        return
    raise RuntimeError(
        "The landing-trailer scan matched no pull request, yet the corpus holds closed ones. "
        f"Every landed PR would be reported as closed-abandoned. Check that {_LANDED_PATTERN!r} "
        "still describes the trailer mergebot writes on the default branch."
    )


def _coerce(row: dict[str, Any]) -> dict[str, Any]:
    coerced = {name: row[name] for name in FIELDS}
    for name in _INT_FIELDS:
        coerced[name] = int(coerced[name])
    for name in _BOOL_FIELDS:
        coerced[name] = bool(coerced[name])
    run_id = coerced["decision_run_id"]
    coerced["decision_run_id"] = None if run_id is None else int(run_id)
    version = coerced["decision_version"]
    coerced["decision_version"] = (
        None if version is None else _as_utc(version).replace(tzinfo=None)
    )
    return coerced


def fetch_decisions(
    client: Client,
    repo: str = DEFAULT_REPO,
    as_of: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return one row per PR greenlight has recorded state for, newest PR first.

    ``client`` is a ``clickhouse_connect`` client, as built by
    ``torchci.clickhouse.get_clickhouse_client``. The caller owns it; this does not close it.

    ``as_of`` bounds the greenlight state table to rows at or before that instant, inclusive and
    to the millisecond, making the verdict side of the export replayable -- feeding a row's own
    ``decision_version`` back in reproduces that verdict. It pins nothing else: PR metadata and
    human reviews are always read at their latest mirrored value. A naive ``as_of`` is read as
    UTC rather than as local time; the default is now. ``decision_version`` comes back as naive
    UTC to match.

    Raises ``RuntimeError`` if the landing-trailer scan matched nothing while the corpus holds
    closed PRs, which means the trailer format changed and every landing went undetected.

    Every PR in the corpus gets a row, including those greenlight never reached a verdict on --
    ``lifecycle_status`` says which of those it is, and ``decision`` is empty.

    ``landed`` and ``reverted`` are read from ``refs/heads/main`` and describe what happened to
    the code, independently of both the PR's own state and of anything greenlight recorded. They
    are live reads like ``pr_status``, so ``as_of`` does not bound them.
    """
    parameters = {
        "repo": repo,
        "synthetic_pr": SYNTHETIC_PR_NUMBER,
        "as_of": _as_of_literal(
            as_of if as_of is not None else datetime.now(timezone.utc)
        ),
        "landed_pattern": _LANDED_PATTERN.format(repo=re.escape(repo)),
        "revert_pattern": _REVERT_PATTERN.format(repo=re.escape(repo)),
        "main_ref": "refs/heads/main",
        "multi_value_separator": MULTI_VALUE_SEPARATOR,
    }
    rows = list(client.query(SQL_DECISIONS, parameters=parameters).named_results())
    _require_trailer_scan_matched(rows)
    return [_coerce(row) for row in rows]
