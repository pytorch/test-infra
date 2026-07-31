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


def _row(pr_number: int, status: str, eval_hash: str, head_sha: str, version: datetime) -> dict[str, object]:
    return {
        "pr_number": pr_number,
        "status": status,
        "eval_hash": eval_hash,
        "head_sha": head_sha,
        "version": version,
    }


def test_query_uses_final_and_repo_filter_without_pr_filter():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_latest_states(_REPO, connect=connect)

    query, params = client.queries[0]
    assert "FINAL" in query
    assert "FROM misc.greenlight_pr_state" in query
    assert "repo = %(repo)s" in query
    assert "pr_number IN" not in query
    assert params == {"repo": _REPO}


def test_pr_filter_and_tuple_param_applied_only_when_pr_numbers_given():
    client = _FakeClient([])
    connect, _ = _connect_seam(client)

    state.read_latest_states(_REPO, [7, 9], connect=connect)

    query, params = client.queries[0]
    assert "pr_number IN %(pr_numbers)s" in query
    assert params == {"repo": _REPO, "pr_numbers": (7, 9)}


def test_maps_single_row_to_prstate_including_datetime():
    client = _FakeClient([_row(7, "LAND", "a" * 64, "deadbeef", _V1)])
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, connect=connect)

    assert result == {7: PRState(pr_number=7, status="LAND", eval_hash="a" * 64, head_sha="deadbeef", version=_V1)}
    assert result[7].version == _V1


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
        _row(7, "LAND", "a" * 64, "sha7", _V1),
        _row(11, "AI_REVIEW_STARTED", "b" * 64, "sha11", _V2),
    ]
    client = _FakeClient(rows)
    connect, _ = _connect_seam(client)

    result = state.read_latest_states(_REPO, [7, 11], connect=connect)

    assert set(result) == {7, 11}
    assert result[7] == PRState(pr_number=7, status="LAND", eval_hash="a" * 64, head_sha="sha7", version=_V1)
    assert result[11] == PRState(
        pr_number=11, status="AI_REVIEW_STARTED", eval_hash="b" * 64, head_sha="sha11", version=_V2
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


def test_prstate_is_frozen():
    st = PRState(pr_number=1, status="LAND", eval_hash="a" * 64, head_sha="sha", version=_V1)

    with pytest.raises(dataclasses.FrozenInstanceError):
        st.status = "NO_LAND"  # type: ignore[misc]
