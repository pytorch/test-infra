from __future__ import annotations

import logging
import threading

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import latch
from greenlight.constants import QUOTA_REFRESH_REQUESTS
from greenlight.latch import RateLimitLatch, SharedLatch
from greenlight.state_store import InProcessStore, StoreError


class _Store(InProcessStore):
    """An ``InProcessStore`` that counts latch reads and fails the latch operations named in ``failing``."""

    def __init__(self) -> None:
        super().__init__()
        self.failing: set[str] = set()
        self.reads = 0

    def read_latch(self, now: float) -> float | None:
        self.reads += 1
        if "read_latch" in self.failing:
            raise StoreError("read_latch refused")
        return super().read_latch(now)

    def extend_latch(self, until: float, now: float) -> None:
        if "extend_latch" in self.failing:
            raise StoreError("extend_latch refused")
        super().extend_latch(until, now)


def _latch(store: _Store, count: list[int] | None = None) -> RateLimitLatch:
    counted = count if count is not None else [0]
    return RateLimitLatch(lambda: 1000.0, SharedLatch(store, lambda: 1000.0), lambda: counted[0])


@pytest.mark.parametrize(
    ("headers", "until"),
    [
        pytest.param({"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1500"}, 1500.0, id="reset"),
        pytest.param({"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1500"}, 1500.0, id="reset-any-case"),
        pytest.param(
            {"x-ratelimit-remaining": "3", "x-ratelimit-reset": "1500", "retry-after": "20"}, 1020.0, id="not-0"
        ),
        pytest.param({"Retry-After": "45"}, 1045.0, id="retry-after"),
        pytest.param({"retry-after": "soon"}, 1060.0, id="unparsable"),
        pytest.param({}, 1060.0, id="default"),
        pytest.param(None, 1060.0, id="no-headers"),
        pytest.param({"x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999"}, 1900.0, id="clamped"),
        pytest.param({"retry-after": "3600"}, 1900.0, id="retry-after-clamped"),
    ],
)
def test_a_rate_limit_waits_until_its_reset_else_retry_after_else_a_minute_never_past_fifteen(headers, until):
    assert latch.rate_limit_until(headers, 1000.0) == until


def test_the_headers_of_a_rate_limit_failure_are_found_when_it_carries_some():
    assert latch.rate_limit_headers(GithubException(429, None, {"retry-after": "5"})) == {"retry-after": "5"}
    assert latch.rate_limit_headers(GithubException(429, None, None)) is None
    assert latch.rate_limit_headers(ValueError("x")) is None


def test_the_latch_keeps_the_latest_wait_any_rate_limit_asked_for():
    found = RateLimitLatch(lambda: 1000.0)
    assert found.until is None

    found.note({"retry-after": "120"})
    found.note({"retry-after": "30"})

    assert found.is_set()
    assert found.until == 1120.0


def test_a_latch_set_with_no_wait_known_waits_the_default():
    found = RateLimitLatch(lambda: 1000.0)

    found.set()

    assert found.is_set()
    assert found.until == 1060.0


def test_caught_rate_limits_keep_the_wait_their_response_asked_for():
    found = RateLimitLatch(lambda: 1000.0)
    plain = threading.Event()
    error = RateLimitExceededException(403, {"message": "secondary rate limit"}, {"retry-after": "300"})

    latch.latch_rate_limit(found, error)
    latch.latch_rate_limit(plain, error)

    assert found.until == 1300.0
    assert plain.is_set()


def test_a_latch_publishes_each_later_wait_to_the_shared_latch_as_it_is_set():
    store = _Store()
    found = _latch(store)

    found.note({"retry-after": "120"})
    assert store.read_latch(1000.0) == 1120.0
    found.note({"retry-after": "300"})
    assert store.read_latch(1000.0) == 1300.0
    found.note({"retry-after": "30"})
    assert store.read_latch(1000.0) == 1300.0


def test_a_failure_publishing_is_logged_and_the_latch_still_holds(caplog):
    store = _Store()
    store.failing = {"extend_latch"}
    found = _latch(store)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        found.note({"retry-after": "120"})

    assert found.until == 1120.0
    [record] = [record for record in caplog.records if "cannot record the shared rate-limit latch" in record.message]
    assert record.exc_info


def test_a_recheck_sets_the_latch_from_a_shared_latch_that_holds_without_publishing_it_back():
    store = _Store()
    found = _latch(store)

    found.recheck()
    assert not found.is_set()
    store.extend_latch(1200.0, 1000.0)
    found.recheck()

    assert found.until == 1200.0
    assert store.reads == 2
    found.recheck()
    assert store.reads == 2


def test_a_failed_read_of_the_shared_latch_after_a_good_one_sets_the_latch_with_no_wait_to_publish(caplog):
    store = _Store()
    count = [0]
    found = _latch(store, count)

    found.recheck()
    assert not found.is_set()
    store.failing = {"read_latch"}
    count[0] = QUOTA_REFRESH_REQUESTS
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        found.poll()

    assert found.is_set()
    assert found.until is None
    assert found.unreadable == "the state store failed reading the shared rate-limit latch: read_latch refused"
    [record] = [record for record in caplog.records if "cannot read the shared rate-limit latch" in record.message]
    assert record.exc_info
    found.recheck()
    assert store.reads == 2


def test_a_poll_reads_the_shared_latch_once_every_refresh_interval_of_requests():
    store = _Store()
    count = [0]
    found = _latch(store, count)

    found.poll()
    count[0] = QUOTA_REFRESH_REQUESTS - 1
    found.poll()
    assert store.reads == 0
    count[0] = QUOTA_REFRESH_REQUESTS
    found.poll()
    found.poll()
    assert store.reads == 1
    count[0] = QUOTA_REFRESH_REQUESTS + 10
    found.recheck()
    assert store.reads == 2
    count[0] = 2 * QUOTA_REFRESH_REQUESTS + 9
    found.poll()
    assert store.reads == 2
    count[0] = 2 * QUOTA_REFRESH_REQUESTS + 10
    found.poll()
    assert store.reads == 3


def test_a_latch_without_a_shared_one_reads_nothing_and_the_module_recheck_ignores_a_plain_event():
    found = RateLimitLatch(lambda: 1000.0)

    found.recheck()
    found.poll()
    latch.recheck(threading.Event())

    assert not found.is_set()


@pytest.mark.parametrize("raw", ["12", "1.5", "soon", None])
def test_seconds_reads_a_number_or_nothing(raw):
    expected = {"12": 12.0, "1.5": 1.5}.get(raw) if raw is not None else None
    assert latch.seconds(raw) == expected
