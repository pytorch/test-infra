from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, cast

import pytest
from clickhouse_connect.driver.binding import bind_query

from greenlight import change_feed, clickhouse_client, constants, pr_hash
from greenlight.change_feed import EMPTY_MARKER, TABLES, Freshness, Marker

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from clickhouse_connect.driver.client import Client

_REPO = "pytorch/pytorch"
# Far from the host's clock, so a reading judged on the host's clock would come out stale.
_SERVER_NOW = datetime(2020, 1, 2, 3, 4, 5)
_PLUS_TWO = timezone(timedelta(hours=2))
_EVENT_TIMES = {
    "pull_request": "parseDateTimeBestEffortOrNull(updated_at)",
    "issue_comment": "updated_at",
    "pull_request_review": "review.submitted_at",
    "pull_request_review_comment": "comment.updated_at",
}


class _FakeResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def named_results(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _FakeClient:
    def __init__(self, rows: list[dict[str, object]], error: Exception | None = None) -> None:
        self._rows = rows
        self._error = error
        self.calls: list[tuple[str, dict[str, object], dict[str, object]]] = []
        self.closed = 0

    def query(self, query: str, parameters: dict[str, object], settings: dict[str, object]) -> _FakeResult:
        self.calls.append((query, parameters, settings))
        if self._error is not None:
            raise self._error
        return _FakeResult(self._rows)

    def close(self) -> None:
        self.closed += 1


def _connect_seam(client: _FakeClient) -> tuple[Callable[[], Client], list[int]]:
    calls: list[int] = []

    def _connect() -> Client:
        calls.append(1)
        return cast("Client", client)

    return _connect, calls


def _freshness_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {"server_now": _SERVER_NOW, **dict.fromkeys(TABLES, _SERVER_NOW)}
    return row | overrides


def _marker_row(number: object, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "number": number,
        "pr_updated_at": None,
        "reviews": 0,
        "review_comments": 0,
        "comments": 0,
        "comment_updated_at": None,
    }
    return row | overrides


def _any_row() -> dict[str, object]:
    """A row both reads parse."""
    return _marker_row(7) | _freshness_row()


def _read_markers_query(numbers: list[int]) -> tuple[str, dict[str, object], dict[str, object]]:
    client = _FakeClient([])
    connect, _ = _connect_seam(client)
    change_feed.read_markers(_REPO, numbers, connect=connect)
    return client.calls[0]


def test_markers_bind_the_numbers_once_and_reach_every_table_through_the_alias():
    query, params, _ = _read_markers_query([11, 7, 9, 7])

    assert query.startswith("WITH %(known)s AS known SELECT number, ")
    assert query.count("%(known)s") == 1
    assert query.count(" IN known") == 4
    assert params["known"] == [7, 9, 11]
    rendered, _ = bind_query(query, params)
    assert isinstance(rendered, str)
    assert rendered.count("[7, 9, 11]") == 1


def test_markers_bind_the_repo_and_the_bot_rule_from_pr_hash_and_constants():
    _, params, _ = _read_markers_query([7])

    assert params == {
        "known": [7],
        "repo": _REPO,
        "pr_prefix": "pytorch/pytorch/",
        "issue_prefix": "https://api.github.com/repos/pytorch/pytorch/issues/",
        "bot_logins": tuple(sorted(pr_hash.BOT_LOGINS)),
        "bot_suffix": constants.BOT_LOGIN_SUFFIX,
    }
    assert frozenset(cast("tuple[str, ...]", params["bot_logins"])) == pr_hash.BOT_LOGINS


@pytest.mark.parametrize("author", ["review.user", "comment.user", "user"])
def test_markers_leave_out_bot_authors_by_is_bots_rule(author):
    query, _, _ = _read_markers_query([7])

    login = f"lower({author}.login)"
    assert (
        f"NOT (lower({author}.type) = 'bot' OR endsWith({login}, %(bot_suffix)s) OR {login} IN %(bot_logins)s)"
    ) in query
    assert "sender" not in query


def test_markers_read_each_table_by_its_repo_through_its_cheapest_columns():
    query, _, _ = _read_markers_query([7])

    assert "FROM default.pull_request WHERE number IN known AND startsWith(dynamoKey, %(pr_prefix)s)" in query
    assert "max(parseDateTimeBestEffortOrNull(updated_at))" in query
    for table in ("pull_request_review", "pull_request_review_comment"):
        assert f"FROM default.{table} WHERE pull_request.number IN known AND repository.full_name = %(repo)s" in query
    assert query.count("uniqExact(dynamoKey)") == 2
    assert "tupleElement" not in query
    assert "toInt64OrZero(substring(issue_url, length(%(issue_prefix)s) + 1)) AS number" in query
    assert "FROM default.issue_comment WHERE startsWith(issue_url, %(issue_prefix)s) AND number IN known" in query
    assert "uniqExact(id)" in query
    assert "max(updated_at)" in query
    assert query.count(" UNION ALL ") == 3
    assert query.endswith(") GROUP BY number")


@pytest.mark.parametrize(
    "read",
    [
        pytest.param(lambda connect: change_feed.read_markers(_REPO, [7], connect=connect), id="markers"),
        pytest.param(lambda connect: change_feed.read_freshness(connect=connect), id="freshness"),
    ],
)
def test_reads_run_under_the_change_feed_time_limit_and_close_the_connection(read):
    client = _FakeClient([_any_row()])
    connect, _ = _connect_seam(client)

    read(connect)

    assert client.calls[0][2] == {"max_execution_time": constants.CHANGE_FEED_MAX_EXECUTION_SECONDS}
    assert client.closed == 1


@pytest.mark.parametrize(
    "read",
    [
        pytest.param(lambda: change_feed.read_markers(_REPO, [7]), id="markers"),
        pytest.param(change_feed.read_freshness, id="freshness"),
    ],
)
def test_reads_default_to_a_client_with_the_change_feed_timeout(monkeypatch, read):
    client = _FakeClient([_any_row()])
    connects: list[dict[str, object]] = []

    def fake_connect(**kwargs: object) -> Client:
        connects.append(kwargs)
        return cast("Client", client)

    monkeypatch.setattr(clickhouse_client, "connect", fake_connect)

    read()

    assert connects == [{"send_receive_timeout": constants.CHANGE_FEED_TIMEOUT_SECONDS}]


@pytest.mark.parametrize(
    "read",
    [
        pytest.param(lambda connect: change_feed.read_markers(_REPO, [7], connect=connect), id="markers"),
        pytest.param(lambda connect: change_feed.read_freshness(connect=connect), id="freshness"),
    ],
)
def test_read_errors_propagate_and_close_the_connection(read):
    client = _FakeClient([], error=RuntimeError("query boom"))
    connect, _ = _connect_seam(client)

    with pytest.raises(RuntimeError, match="query boom"):
        read(connect)

    assert client.closed == 1


def test_markers_parse_rows_with_aware_times_normalized_to_naive_utc():
    row = _marker_row(
        "7",
        pr_updated_at=datetime(2026, 11, 17, 10, 0, tzinfo=_PLUS_TWO),
        reviews="3",
        review_comments=2,
        comments=5,
        comment_updated_at=datetime(2026, 11, 17, 9, 30),
    )
    client = _FakeClient([row])
    connect, _ = _connect_seam(client)

    markers = change_feed.read_markers(_REPO, [7], connect=connect)

    assert markers == {
        7: Marker(
            pr_updated_at=datetime(2026, 11, 17, 8, 0),
            reviews=3,
            review_comments=2,
            comments=5,
            comment_updated_at=datetime(2026, 11, 17, 9, 30),
        )
    }


def test_markers_give_every_number_asked_a_marker_and_only_those():
    client = _FakeClient([_marker_row(7, reviews=1), _marker_row(13, reviews=4)])
    connect, _ = _connect_seam(client)

    markers = change_feed.read_markers(_REPO, {9, 7}, connect=connect)

    assert markers == {7: Marker(reviews=1), 9: EMPTY_MARKER}


def test_markers_of_no_numbers_read_nothing():
    client = _FakeClient([_marker_row(7)])
    connect, calls = _connect_seam(client)

    assert change_feed.read_markers(_REPO, [], connect=connect) == {}
    assert calls == []


@pytest.mark.parametrize(
    ("pr_updated_at", "comment_updated_at", "newest"),
    [
        pytest.param(None, None, None, id="none"),
        pytest.param(datetime(2026, 1, 1), None, datetime(2026, 1, 1), id="pr-only"),
        pytest.param(None, datetime(2026, 1, 2), datetime(2026, 1, 2), id="comment-only"),
        pytest.param(datetime(2026, 1, 3), datetime(2026, 1, 2), datetime(2026, 1, 3), id="pr-newer"),
        pytest.param(datetime(2026, 1, 1), datetime(2026, 1, 2), datetime(2026, 1, 2), id="comment-newer"),
    ],
)
def test_marker_newest_is_its_latest_pull_request_event_or_comment(pr_updated_at, comment_updated_at, newest):
    marker = Marker(pr_updated_at=pr_updated_at, reviews=9, comment_updated_at=comment_updated_at)

    assert marker.newest == newest


def test_the_tables_read_are_the_ones_table_stale_after_names():
    assert tuple(constants.TABLE_STALE_AFTER) == TABLES
    assert tuple(change_feed._EVENT_TIMES) == TABLES
    assert sorted(re.findall(r"FROM default\.(\w+) WHERE", change_feed._MARKERS_SQL)) == sorted(TABLES)
    assert re.findall(r"FROM default\.(\w+)\) AS", change_feed._FRESHNESS_SQL) == list(TABLES)


def test_freshness_reads_each_tables_newest_event_dropping_future_rows():
    client = _FakeClient([_freshness_row()])
    connect, _ = _connect_seam(client)

    change_feed.read_freshness(connect=connect)

    query, params, _ = client.calls[0]
    assert query.startswith("SELECT now() AS server_now, ")
    for table, event_time in _EVENT_TIMES.items():
        kept = f"{event_time} <= now() + toIntervalSecond(%(future_tolerance)s)"
        assert f"(SELECT maxIfOrNull({event_time}, {kept}) FROM default.{table}) AS {table}" in query  # noqa: S608
    assert "least(" not in query
    assert params == {"future_tolerance": int(constants.FUTURE_EVENT_TOLERANCE.total_seconds())}


def test_freshness_parses_its_row_with_times_naive_utc_and_missing_tables_none():
    row = _freshness_row(
        server_now=datetime(2026, 11, 17, 12, 0, tzinfo=_PLUS_TWO),
        pull_request=datetime(2026, 11, 17, 11, 58, tzinfo=_PLUS_TWO),
        issue_comment=None,
        pull_request_review=datetime(2026, 11, 17, 9, 57),
    )
    client = _FakeClient([row])
    connect, _ = _connect_seam(client)

    freshness = change_feed.read_freshness(connect=connect)

    assert freshness == Freshness(
        server_now=datetime(2026, 11, 17, 10, 0),
        newest={
            "pull_request": datetime(2026, 11, 17, 9, 58),
            "issue_comment": None,
            "pull_request_review": datetime(2026, 11, 17, 9, 57),
            "pull_request_review_comment": _SERVER_NOW,
        },
    )
    assert tuple(freshness.newest) == TABLES


def _freshness(**ages: timedelta | None) -> Freshness:
    newest = {
        table: None if (age := ages.get(table, timedelta(minutes=1))) is None else _SERVER_NOW - age for table in TABLES
    }
    return Freshness(server_now=_SERVER_NOW, newest=newest)


@pytest.mark.parametrize(
    "ages",
    [
        pytest.param({}, id="all-recent"),
        pytest.param(dict.fromkeys(TABLES, constants.STALE_AFTER), id="overall-exactly-at-the-limit"),
        pytest.param({"pull_request": -constants.FUTURE_EVENT_TOLERANCE}, id="kept-future-row"),
        pytest.param(
            {table: limit for table, limit in constants.TABLE_STALE_AFTER.items() if table != "issue_comment"},
            id="each-table-exactly-at-its-own-limit",
        ),
    ],
)
def test_fresh_tables_have_no_problem_on_the_servers_clock(ages):
    assert _freshness(**ages).problem() is None


def test_tables_whose_newest_event_is_past_stale_after_are_stale_overall():
    stale = constants.STALE_AFTER + timedelta(minutes=1)

    problem = _freshness(**dict.fromkeys(TABLES, stale)).problem()

    assert problem == "the newest event over all tables is 660 s old, over 600 s"


def test_the_overall_reason_comes_before_a_table_without_rows():
    stale = constants.STALE_AFTER + timedelta(minutes=1)
    ages: dict[str, timedelta | None] = {**dict.fromkeys(TABLES, stale), "pull_request": None}

    assert _freshness(**ages).problem() == "the newest event over all tables is 660 s old, over 600 s"


@pytest.mark.parametrize(
    ("ages", "problem"),
    [
        pytest.param({"issue_comment": None}, "issue_comment has no row", id="one-table"),
        pytest.param(dict.fromkeys(TABLES), "pull_request has no row", id="every-table"),
    ],
)
def test_a_table_without_rows_is_stale(ages, problem):
    assert _freshness(**ages).problem() == problem


@pytest.mark.parametrize("table", TABLES)
def test_a_table_past_its_own_limit_is_stale_while_another_is_recent(table):
    limit = constants.TABLE_STALE_AFTER[table]

    problem = _freshness(**{table: limit + timedelta(seconds=1)}).problem()

    assert problem == (
        f"{table}'s newest event is {int(limit.total_seconds()) + 1} s old, over {int(limit.total_seconds())} s"
    )
