"""What HUD ClickHouse's webhook tables say about a repo's PRs: per-PR markers and the tables' freshness.

pytorchbot's webhooks reach four tables (``TABLES``) through DynamoDB. ``read_markers`` reads, in one query, a
``Marker`` per PR: what changes whenever a non-bot event lands on the PR. ``read_freshness`` reads each table's newest
event org-wide and ClickHouse's own clock, so ``Freshness.problem`` judges staleness on the server's clock, not the
host's.

Both reads run under ``CHANGE_FEED_MAX_EXECUTION_SECONDS`` on a client that gives up after
``CHANGE_FEED_TIMEOUT_SECONDS``; every error propagates. The review tables are sorted by ``tupleElement(pull_request,
'number')``, which reads the whole ``pull_request`` Tuple whenever a filter can use the index, so they are filtered on
the subcolumn ``pull_request.number`` and scanned in full: two narrow columns cost far less than the Tuple.
clickhouse_connect inlines bound parameters into the SQL text, which ClickHouse caps (``max_query_size``), so the PR
numbers are bound once, as ``known``. ``call_bounded`` runs a read on a thread of its own and gives up waiting for it
after a deadline, which those time limits do not guarantee.
"""

from __future__ import annotations

import functools
import threading
from dataclasses import dataclass, fields
from typing import TYPE_CHECKING, Any

from greenlight import clickhouse_client
from greenlight.constants import (
    BOT_LOGIN_SUFFIX,
    CHANGE_FEED_MAX_EXECUTION_SECONDS,
    CHANGE_FEED_TIMEOUT_SECONDS,
    FUTURE_EVENT_TOLERANCE,
    STALE_AFTER,
    TABLE_STALE_AFTER,
)
from greenlight.pr_hash import BOT_LOGINS
from greenlight.state import naive_utc

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Mapping
    from datetime import datetime, timedelta

    from clickhouse_connect.driver.client import Client

TABLES: tuple[str, ...] = tuple(TABLE_STALE_AFTER)


@dataclass(frozen=True, slots=True)
class Marker:
    """One PR's webhook rows, bot authors left out: any new non-bot event on the PR changes it, but an issue
    comment's deletion. Times are naive UTC."""

    pr_updated_at: datetime | None = None
    reviews: int = 0
    review_comments: int = 0
    comments: int = 0
    comment_updated_at: datetime | None = None

    @property
    def newest(self) -> datetime | None:
        """The PR's newest ``pull_request`` event or non-bot issue comment, or None."""
        times = [moment for moment in (self.pr_updated_at, self.comment_updated_at) if moment is not None]
        return max(times) if times else None


EMPTY_MARKER = Marker()


@dataclass(frozen=True, slots=True)
class Freshness:
    """Each table's newest event org-wide (``TABLES``; None when it has none), and ClickHouse's own clock."""

    server_now: datetime
    newest: Mapping[str, datetime | None]

    def problem(self) -> str | None:
        """Why the tables count as stale (``STALE_AFTER``, ``TABLE_STALE_AFTER``), or None when they are fresh."""
        times = [moment for moment in self.newest.values() if moment is not None]
        if times and (age := self.server_now - max(times)) > STALE_AFTER:
            return f"the newest event over all tables is {_seconds(age)} old, over {_seconds(STALE_AFTER)}"
        for table in TABLES:
            newest = self.newest.get(table)
            if newest is None:
                return f"{table} has no row"
            if (age := self.server_now - newest) > TABLE_STALE_AFTER[table]:
                return f"{table}'s newest event is {_seconds(age)} old, over {_seconds(TABLE_STALE_AFTER[table])}"
        return None


def _seconds(delta: timedelta) -> str:
    return f"{int(delta.total_seconds())} s"


_MARKER_COLUMNS = tuple(field.name for field in fields(Marker))
_MARKER_TIMES = frozenset({"pr_updated_at", "comment_updated_at"})

# Only this module's constants are spliced into the SQL below, hence its S608 suppressions; every value a caller gives
# is a bound parameter.


def _human(user: str) -> str:
    """SQL true when the ``user`` Tuple names no bot, by ``pr_hash.is_bot``'s rule."""
    login = f"lower({user}.login)"
    return f"NOT (lower({user}.type) = 'bot' OR endsWith({login}, %(bot_suffix)s) OR {login} IN %(bot_logins)s)"


def _part(table: str, number: str, where: str, **values: str) -> str:
    """One table's ``SELECT``: every marker column, typed alike in every part so ``UNION ALL`` unifies them."""
    columns = ", ".join(
        f"CAST({values.get(name, 'NULL')} AS Nullable(DateTime)) AS {name}"
        if name in _MARKER_TIMES
        else f"toUInt64({values.get(name, '0')}) AS {name}"
        for name in _MARKER_COLUMNS
    )
    return f"SELECT {number}, {columns} FROM default.{table} WHERE {where} GROUP BY number"  # noqa: S608


def _kept_max(event_time: str) -> str:
    """The newest ``event_time``, dropping rows dated past ``FUTURE_EVENT_TOLERANCE``: a row capped at the clock
    instead would read as a fresh event for as long as it stays ahead of it."""
    return f"maxIfOrNull({event_time}, {event_time} <= now() + toIntervalSecond(%(future_tolerance)s))"


def _review_part(table: str, author: str, column: str) -> str:
    where = f"pull_request.number IN known AND repository.full_name = %(repo)s AND {_human(author)}"
    return _part(table, "pull_request.number AS number", where, **{column: "uniqExact(dynamoKey)"})


_PARTS = (
    _part(
        "pull_request",
        "number",
        "number IN known AND startsWith(dynamoKey, %(pr_prefix)s)",
        pr_updated_at=_kept_max("parseDateTimeBestEffortOrNull(updated_at)"),
    ),
    _review_part("pull_request_review", "review.user", "reviews"),
    _review_part("pull_request_review_comment", "comment.user", "review_comments"),
    _part(
        "issue_comment",
        "toInt64OrZero(substring(issue_url, length(%(issue_prefix)s) + 1)) AS number",
        f"startsWith(issue_url, %(issue_prefix)s) AND number IN known AND {_human('user')}",
        comments="uniqExact(id)",
        comment_updated_at="max(updated_at)",
    ),
)
_TOTALS = ", ".join(f"{'max' if name in _MARKER_TIMES else 'sum'}({name}) AS {name}" for name in _MARKER_COLUMNS)
_MARKERS_SQL = f"WITH %(known)s AS known SELECT number, {_TOTALS} FROM ({' UNION ALL '.join(_PARTS)}) GROUP BY number"  # noqa: S608

_EVENT_TIMES = {
    "pull_request": "parseDateTimeBestEffortOrNull(updated_at)",
    "issue_comment": "updated_at",
    "pull_request_review": "review.submitted_at",
    "pull_request_review_comment": "comment.updated_at",
}


def _newest(table: str) -> str:
    return f"(SELECT {_kept_max(_EVENT_TIMES[table])} FROM default.{table}) AS {table}"  # noqa: S608


_FRESHNESS_SQL = f"SELECT now() AS server_now, {', '.join(_newest(table) for table in TABLES)}"
_FUTURE: dict[str, object] = {"future_tolerance": int(FUTURE_EVENT_TOLERANCE.total_seconds())}


def _query(sql: str, params: dict[str, object], connect: Callable[[], Client] | None) -> list[dict[str, Any]]:
    return clickhouse_client.query(
        sql,
        params,
        connect=connect
        or functools.partial(clickhouse_client.connect, send_receive_timeout=CHANGE_FEED_TIMEOUT_SECONDS),
        settings={"max_execution_time": CHANGE_FEED_MAX_EXECUTION_SECONDS},
    )


def _time(value: datetime | None) -> datetime | None:
    return None if value is None else naive_utc(value)


def read_markers(
    repo: str, numbers: Collection[int], *, connect: Callable[[], Client] | None = None
) -> dict[int, Marker]:
    """Every PR of ``numbers`` in ``repo`` with its marker (``EMPTY_MARKER`` when it has no row); ``{}`` for none."""
    if not numbers:
        return {}
    known = sorted(set(numbers))
    params: dict[str, object] = {
        "known": known,
        "repo": repo,
        "pr_prefix": f"{repo}/",
        "issue_prefix": f"https://api.github.com/repos/{repo}/issues/",
        "bot_logins": tuple(sorted(BOT_LOGINS)),
        "bot_suffix": BOT_LOGIN_SUFFIX,
        **_FUTURE,
    }
    markers = dict.fromkeys(known, EMPTY_MARKER)
    for row in _query(_MARKERS_SQL, params, connect):
        number = int(row["number"])
        if number in markers:
            markers[number] = Marker(
                pr_updated_at=_time(row["pr_updated_at"]),
                reviews=int(row["reviews"]),
                review_comments=int(row["review_comments"]),
                comments=int(row["comments"]),
                comment_updated_at=_time(row["comment_updated_at"]),
            )
    return markers


def read_freshness(*, connect: Callable[[], Client] | None = None) -> Freshness:
    """The four tables' freshness, read now."""
    (row,) = _query(_FRESHNESS_SQL, dict(_FUTURE), connect)
    return Freshness(server_now=naive_utc(row["server_now"]), newest={table: _time(row[table]) for table in TABLES})


def call_bounded[T](fn: Callable[..., T], *args: object, seconds: float) -> T:
    """``fn(*args)`` run on a daemon thread: its value, or its exception raised again here.

    Raises ``TimeoutError`` once ``fn`` has run ``seconds`` without returning; its thread is left to end on its own,
    and what it returns or raises after that is dropped.
    """
    done = threading.Event()
    returned: list[T] = []
    raised: list[BaseException] = []

    def run() -> None:
        try:
            returned.append(fn(*args))
        except BaseException as exc:
            raised.append(exc)
        finally:
            done.set()

    threading.Thread(target=run, name="greenlight-change-feed", daemon=True).start()
    if not done.wait(seconds):
        raise TimeoutError(f"a HUD ClickHouse read did not finish within {seconds} s")
    if raised:
        raise raised[0]
    return returned[0]
