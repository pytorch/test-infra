from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import state
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from clickhouse_connect.driver.client import Client

_REPO = "pytorch/pytorch"
_V1 = datetime(2026, 7, 30, 12, 0, 0, 0)
_V2 = datetime(2026, 7, 30, 13, 30, 0, 0)


class _FakeResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def named_results(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _FakeClient:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows
        self.queries: list[tuple[str, dict[str, object] | None]] = []
        self.closed = 0

    def query(self, query: str, parameters: dict[str, object] | None = None) -> _FakeResult:
        self.queries.append((query, parameters))
        return _FakeResult(self._rows)

    def close(self) -> None:
        self.closed += 1


class _RaisingClient(_FakeClient):
    def query(self, query: str, parameters: dict[str, object] | None = None) -> _FakeResult:
        self.queries.append((query, parameters))
        raise RuntimeError("query boom")


def _connect_seam(client: _FakeClient) -> tuple[Callable[[], Client], dict[str, int]]:
    calls = {"count": 0}

    def _connect() -> Client:
        calls["count"] += 1
        return cast("Client", client)

    return _connect, calls


def _row(
    pr_number: int, status: str, eval_hash: str, head_sha: str, version: datetime, run_id: int = 0
) -> dict[str, object]:
    return {
        "pr_number": pr_number,
        "status": status,
        "eval_hash": eval_hash,
        "head_sha": head_sha,
        "version": version,
        "run_id": run_id,
    }


def test_query_selects_highest_run_id_then_version_and_drops_final():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_latest_states(_REPO, connect=connect)

    query, params = client.queries[0]
    # run_id DESC before version DESC is the race-proof rule: a superseded slower run that
    # finishes with a later version still loses to the newer run's higher run_id. version DESC
    # only breaks ties within one run (a terminal LAND over that run's earlier AI_REVIEW_STARTED)
    # and decides among legacy run_id=0 rows. The append-only table never collapses, so there
    # is no FINAL.
    assert "FINAL" not in query
    assert "run_id FROM misc.greenlight_pr_state" in query
    assert "repo = %(repo)s" in query
    assert "ORDER BY pr_number, run_id DESC, version DESC" in query
    assert "LIMIT 1 BY pr_number" in query
    assert "pr_number IN" not in query
    assert params == {"repo": _REPO}


def test_pr_filter_and_tuple_param_applied_only_when_pr_numbers_given():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_latest_states(_REPO, [7, 9], connect=connect)

    query, params = client.queries[0]
    assert "pr_number IN %(pr_numbers)s" in query
    assert params == {"repo": _REPO, "pr_numbers": (7, 9)}
    # The IN filter must sit between the WHERE and the ORDER BY/LIMIT selection clause.
    assert query.index("pr_number IN") < query.index("ORDER BY")
    assert query.rstrip().endswith("LIMIT 1 BY pr_number")


@pytest.mark.parametrize(
    ("status", "version", "run_id"),
    [
        # ClickHouse has already applied ORDER BY run_id DESC, version DESC + LIMIT 1 BY
        # pr_number, so it returns exactly the one authoritative row per PR; the fake echoes it
        # back. Each id names the scenario that makes that row the winner. A legacy pre-004 part
        # reads run_id = 0.
        pytest.param("LAND", _V1, 42, id="race-newer-run_id-wins-despite-earlier-version"),
        pytest.param("LAND", _V2, 42, id="within-run-land-beats-earlier-ai_review_started"),
        pytest.param("NO_LAND", _V1, 0, id="legacy-run_id-zero-decided-by-version"),
    ],
)
def test_authoritative_row_maps_to_prstate(status, version, run_id):
    client = _FakeClient([_row(7, status, "a" * 64, "sha7", version, run_id)])
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, [7], connect=connect)

    assert result == {
        7: PRState(pr_number=7, status=status, eval_hash="a" * 64, head_sha="sha7", version=version, run_id=run_id)
    }


def test_maps_single_row_to_prstate_including_datetime():
    client = _FakeClient([_row(7, "LAND", "a" * 64, "deadbeef", _V1, 5)])
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, connect=connect)

    assert result == {
        7: PRState(pr_number=7, status="LAND", eval_hash="a" * 64, head_sha="deadbeef", version=_V1, run_id=5)
    }
    assert result[7].version == _V1
    assert result[7].run_id == 5


def test_tz_aware_version_is_stripped_to_naive_utc():
    aware = datetime(2026, 7, 30, 12, 0, 0, tzinfo=timezone(timedelta(hours=5)))
    client = _FakeClient([_row(7, "LAND", "a" * 64, "deadbeef", aware)])
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, connect=connect)

    version = result[7].version
    assert version.tzinfo is None
    assert version == datetime(2026, 7, 30, 7, 0, 0)


def test_multiple_prs_map_by_pr_number():
    rows = [
        _row(7, "LAND", "a" * 64, "sha7", _V1, 100),
        _row(11, "AI_REVIEW_STARTED", "b" * 64, "sha11", _V2, 101),
    ]
    client = _FakeClient(rows)
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, [7, 11], connect=connect)

    assert set(result) == {7, 11}
    assert result[7] == PRState(
        pr_number=7, status="LAND", eval_hash="a" * 64, head_sha="sha7", version=_V1, run_id=100
    )
    assert result[11] == PRState(
        pr_number=11, status="AI_REVIEW_STARTED", eval_hash="b" * 64, head_sha="sha11", version=_V2, run_id=101
    )


def test_empty_rows_returns_empty_dict():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    assert state.read_latest_states(_REPO, connect=connect) == {}


def test_empty_pr_numbers_returns_empty_dict_without_connecting():
    client = _FakeClient([_row(7, "LAND", "a" * 64, "sha7", _V1)])
    connect, calls = _connect_seam(client)

    assert state.read_latest_states(_REPO, [], connect=connect) == {}
    assert calls["count"] == 0
    assert client.queries == []


def test_connection_is_closed_after_read():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_latest_states(_REPO, connect=connect)

    assert client.closed == 1


def test_query_error_propagates_and_closes_connection():
    client = _RaisingClient([])
    connect, _ = _connect_seam(client)

    with pytest.raises(RuntimeError, match="query boom"):
        state.read_latest_states(_REPO, connect=connect)

    assert client.closed == 1


def test_reverted_query_asks_for_existence_not_the_authoritative_row():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_reverted_pr_numbers(_REPO, connect=connect)

    query, params = client.queries[0]
    # Existence, not recency: a later AI_REVIEW_STARTED row outranks a REVERTED one in
    # read_latest_states' selection, so this read must carry none of that ordering/limit.
    assert "SELECT DISTINCT pr_number" in query
    assert "status = %(status)s" in query
    assert "ORDER BY" not in query
    assert "LIMIT" not in query
    assert "pr_number IN" not in query
    assert params == {"repo": _REPO, "status": "REVERTED"}


def test_reverted_pr_filter_and_tuple_param_applied_only_when_pr_numbers_given():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_reverted_pr_numbers(_REPO, [7, 9], connect=connect)

    query, params = client.queries[0]
    assert "pr_number IN %(pr_numbers)s" in query
    assert params == {"repo": _REPO, "status": "REVERTED", "pr_numbers": (7, 9)}


def test_reverted_rows_map_to_a_set_of_ints():
    client = _FakeClient([{"pr_number": 7}, {"pr_number": "9"}])
    connect, _ = _connect_seam(client)

    assert state.read_reverted_pr_numbers(_REPO, [7, 9], connect=connect) == {7, 9}


def test_reverted_empty_rows_returns_empty_set():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    assert state.read_reverted_pr_numbers(_REPO, [7], connect=connect) == set()


def test_reverted_empty_pr_numbers_returns_empty_set_without_connecting():
    client = _FakeClient([{"pr_number": 7}])
    connect, calls = _connect_seam(client)

    assert state.read_reverted_pr_numbers(_REPO, [], connect=connect) == set()
    assert calls["count"] == 0
    assert client.queries == []


def test_reverted_connection_is_closed_after_read():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_reverted_pr_numbers(_REPO, [7], connect=connect)

    assert client.closed == 1


def test_reverted_query_error_propagates_and_closes_connection():
    client = _RaisingClient([])
    connect, _ = _connect_seam(client)

    # The read gates a permanent exclusion, so a failed query must fail the scan rather than
    # silently read as "nothing was ever reverted".
    with pytest.raises(RuntimeError, match="query boom"):
        state.read_reverted_pr_numbers(_REPO, [7], connect=connect)

    assert client.closed == 1


@pytest.mark.parametrize(
    ("recorded", "expected"),
    [
        pytest.param(None, 1, id="never-reviewed-bases-at-zero"),
        pytest.param(0, 1, id="legacy-zero-run-id"),
        pytest.param(4, 5, id="supersedes-prior-row"),
        pytest.param(19283746, 19283747, id="supersedes-a-real-github-run-id"),
    ],
)
def test_next_run_id_is_one_above_the_prior_row(recorded, expected):
    # The write-side counterpart of the ORDER BY run_id DESC selection: one above the prior row is
    # what makes a scan-written row the one read_latest_states returns.
    prior = (
        None
        if recorded is None
        else PRState(pr_number=1, status="LAND", eval_hash="a" * 64, head_sha="sha", version=_V1, run_id=recorded)
    )

    assert state.next_run_id(prior) == expected


def test_prstate_is_frozen():
    st = PRState(pr_number=1, status="LAND", eval_hash="a" * 64, head_sha="sha", version=_V1, run_id=3)

    with pytest.raises(dataclasses.FrozenInstanceError):
        st.status = "NO_LAND"  # type: ignore[misc]
