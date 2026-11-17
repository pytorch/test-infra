import logging
from collections.abc import Callable
from typing import Any

import pytest
import requests
from github import GithubException, RateLimitExceededException
from urllib3.exceptions import ProtocolError

from greenlight import merge_authz
from greenlight.guards import IterationTimeout
from greenlight.snapshot_cache import SnapshotCache, is_transient


def _snapshot(*logins: str) -> merge_authz.MergeRulesSnapshot:
    return merge_authz.MergeRulesSnapshot(authorized=frozenset(logins), rules=())


class _Clock:
    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


class _Client:
    def __init__(self, *, close_error: bool = False) -> None:
        self.closed = 0
        self._close_error = close_error

    def close(self) -> None:
        self.closed += 1
        if self._close_error:
            raise RuntimeError("close boom")


def _cache(
    fetch: Callable[[Any], merge_authz.MergeRulesSnapshot],
    *,
    clock: Callable[[], float] | None = None,
    ttl: float = 600.0,
    max_stale: float | None = None,
    stale_on_broken: bool = False,
) -> SnapshotCache[Any, merge_authz.MergeRulesSnapshot]:
    return SnapshotCache(
        fetch,
        ttl_seconds=ttl,
        max_stale_seconds=max_stale,
        stale_on_broken=stale_on_broken,
        clock=clock or (lambda: 0.0),
    )


def _good_then(error: BaseException) -> Callable[[Any], merge_authz.MergeRulesSnapshot]:
    calls = {"n": 0}

    def fetch(_client: Any) -> merge_authz.MergeRulesSnapshot:
        calls["n"] += 1
        if calls["n"] == 1:
            return _snapshot("good")
        raise error

    return fetch


def test_cache_is_lazy_no_fetch_before_snapshot():
    calls: list[int] = []

    def fetch(_client):
        calls.append(1)
        return _snapshot("alice")

    _cache(fetch)

    assert calls == []


def test_cache_first_snapshot_builds_client_and_passes_it_to_fetch():
    client = _Client()
    fetched: list[object] = []

    def fetch(passed):
        fetched.append(passed)
        return _snapshot("alice")

    cache = _cache(fetch)

    assert cache.snapshot(lambda: client).authorized == frozenset({"alice"})
    assert fetched == [client]
    assert cache.stale_error is None


def test_cache_serves_cached_within_ttl_and_refetches_at_the_boundary():
    fetch_calls: list[int] = []

    def fetch(_client):
        fetch_calls.append(1)
        return _snapshot(f"fetch{len(fetch_calls)}")

    clock = _Clock(0.0)
    cache = _cache(fetch, clock=clock)

    assert cache.snapshot(_Client).authorized == frozenset({"fetch1"})
    clock.t = 599.0
    assert cache.snapshot(_Client).authorized == frozenset({"fetch1"})
    clock.t = 600.0
    assert cache.snapshot(_Client).authorized == frozenset({"fetch2"})
    assert len(fetch_calls) == 2


def test_cache_with_zero_ttl_fetches_every_time():
    fetch_calls: list[int] = []

    def fetch(_client):
        fetch_calls.append(1)
        return _snapshot("a")

    cache = _cache(fetch, ttl=0)
    cache.snapshot(_Client)
    cache.snapshot(_Client)

    assert len(fetch_calls) == 2


def test_cache_refetches_when_the_clock_steps_back():
    fetch_calls: list[int] = []

    def fetch(_client):
        fetch_calls.append(1)
        return _snapshot("a")

    clock = _Clock(1000.0)
    cache = _cache(fetch, clock=clock)
    cache.snapshot(_Client)
    clock.t = 10.0
    cache.snapshot(_Client)

    assert len(fetch_calls) == 2


def test_cache_cold_failure_raises():
    def fetch(_client):
        raise RuntimeError("merge_rules down")

    with pytest.raises(RuntimeError, match="merge_rules down"):
        _cache(fetch, stale_on_broken=True).snapshot(_Client)


@pytest.mark.parametrize(
    "error",
    [
        GithubException(502),
        requests.exceptions.ConnectionError("reset"),
        requests.exceptions.Timeout("slow"),
        requests.exceptions.RetryError("too many 503 error responses"),
        ProtocolError("aborted"),
        OSError("network down"),
    ],
)
def test_cache_serves_stale_on_a_transient_failure_within_the_bound(caplog, error):
    clock = _Clock(0.0)
    cache = _cache(_good_then(error), clock=clock, max_stale=1800.0)

    cache.snapshot(_Client)
    clock.t = 700.0
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert cache.snapshot(_Client).authorized == frozenset({"good"})

    assert cache.stale_error is error
    assert "(transient); serving the snapshot fetched 700s ago" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_cache_raises_a_transient_failure_past_the_stale_bound():
    clock = _Clock(0.0)
    cache = _cache(_good_then(GithubException(503)), clock=clock, max_stale=1800.0)

    cache.snapshot(_Client)
    clock.t = 1800.0
    with pytest.raises(GithubException):
        cache.snapshot(_Client)


def test_cache_with_no_stale_bound_serves_a_transient_failure_at_any_age():
    clock = _Clock(0.0)
    cache = _cache(_good_then(OSError("down")), clock=clock, ttl=0, max_stale=None)

    cache.snapshot(_Client)
    clock.t = 10**9
    assert cache.snapshot(_Client).authorized == frozenset({"good"})


@pytest.mark.parametrize("error", [ValueError("broken yaml"), GithubException(404), GithubException(403)])
def test_cache_raises_a_broken_source_unless_stale_on_broken(error):
    clock = _Clock(0.0)
    cache = _cache(_good_then(error), clock=clock)

    cache.snapshot(_Client)
    clock.t = 700.0
    with pytest.raises(type(error)):
        cache.snapshot(_Client)


def test_cache_serves_stale_on_a_broken_source_when_stale_on_broken(caplog):
    error = ValueError("broken yaml")
    clock = _Clock(0.0)
    cache = _cache(_good_then(error), clock=clock, ttl=0, stale_on_broken=True)

    cache.snapshot(_Client)
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert cache.snapshot(_Client).authorized == frozenset({"good"})

    assert cache.stale_error is error
    assert "(broken source)" in caplog.text


def test_cache_clears_stale_error_once_a_fetch_succeeds():
    results: list[object] = [_snapshot("a"), ValueError("broken"), _snapshot("b")]

    def fetch(_client):
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    cache = _cache(fetch, ttl=0, stale_on_broken=True)
    cache.snapshot(_Client)
    cache.snapshot(_Client)
    assert cache.stale_error is not None
    assert cache.snapshot(_Client).authorized == frozenset({"b"})
    assert cache.stale_error is None


@pytest.mark.parametrize(
    "error",
    [
        RateLimitExceededException(403),
        GithubException(429),
        GithubException(403, headers={"retry-after": "60"}),
    ],
)
def test_cache_never_serves_stale_on_a_rate_limit(error):
    clock = _Clock(0.0)
    cache = _cache(_good_then(error), clock=clock, ttl=0, max_stale=None, stale_on_broken=True)

    cache.snapshot(_Client)
    with pytest.raises(type(error)):
        cache.snapshot(_Client)


def test_cache_warm_refetch_propagates_iteration_timeout():
    clock = _Clock(0.0)
    cache = _cache(
        _good_then(IterationTimeout("iteration exceeded")), clock=clock, max_stale=None, stale_on_broken=True
    )

    cache.snapshot(_Client)
    clock.t = 700.0
    # A warm cache must NOT mask the soft timeout as a transient refresh error and serve stale.
    with pytest.raises(IterationTimeout):
        cache.snapshot(_Client)


def test_cache_closes_the_client_after_fetch():
    client = _Client()
    cache = _cache(lambda _c: _snapshot("alice"))

    assert cache.snapshot(lambda: client).authorized == frozenset({"alice"})
    assert client.closed == 1


def test_cache_closes_the_client_even_when_fetch_raises():
    client = _Client()

    def fetch(_client):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        _cache(fetch).snapshot(lambda: client)
    assert client.closed == 1


def test_cache_swallows_client_close_error(caplog):
    client = _Client(close_error=True)
    cache = _cache(lambda _c: _snapshot("alice"))

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert cache.snapshot(lambda: client).authorized == frozenset({"alice"})

    assert client.closed == 1
    assert "failed to close GitHub client" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_is_transient_classes():
    assert is_transient(GithubException(500)) is True
    assert is_transient(GithubException(404)) is False
    assert is_transient(GithubException(None)) is False  # type: ignore[arg-type]
    assert is_transient(ValueError("x")) is False
    assert is_transient(requests.exceptions.ConnectionError()) is True
