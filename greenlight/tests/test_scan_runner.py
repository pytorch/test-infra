from __future__ import annotations

import dataclasses
import logging
import queue
import threading
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import scan_runner
from greenlight.comment_format import RECHECK_REFUSAL_MARKER
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, HUMAN_APPROVED, ReviewSkip
from greenlight.state import PRState

if TYPE_CHECKING:
    from concurrent.futures import Future

    from github import Github

    from greenlight.scan_memory import FingerprintCache

# post_refusals threads the client straight through to the get_pr seam and never inspects it.
_CLIENT = cast("Github", object())
_REPO = "pytorch/pytorch"


def _skip(detail: str = "changes requested by bob") -> ReviewSkip:
    return ReviewSkip(CHANGES_REQUESTED, detail)


class _RaisingFuture:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def result(self) -> object:
        raise self._exc


class _ResultFuture:
    def __init__(self, value: object) -> None:
        self._value = value

    def result(self) -> object:
        return self._value


def test_post_refusals_no_skips_is_noop():
    calls: list[str] = []

    def get_pr(_client, _repo, number):
        calls.append("get_pr")
        return number

    def upsert(_pr, **_kwargs):
        calls.append("upsert")

    scan_runner.post_refusals(_CLIENT, _REPO, [], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert)

    assert calls == []


def test_post_refusals_empty_bot_login_logs_and_skips_posting(caplog):
    upserts: list[object] = []

    def get_pr(_client, _repo, number):
        return number

    def upsert(pr, **_kwargs):
        upserts.append(pr)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan_runner.post_refusals(_CLIENT, _REPO, [(5, _skip())], bot_login="", get_pr=get_pr, upsert_comment=upsert)

    # No bot login -> the comment cannot be author-scoped, so posting is skipped with an error.
    assert upserts == []
    assert "BOT_LOGIN is required to post" in caplog.text


def test_post_refusals_posts_one_comment_per_skip_without_run_id():
    posted: list[tuple[object, dict[str, object]]] = []

    def get_pr(_client, repo, number):
        return (repo, number)

    def upsert(pr, **kwargs):
        posted.append((pr, kwargs))

    scan_runner.post_refusals(
        _CLIENT,
        _REPO,
        [(5, _skip("changes requested by bob")), (7, _skip("changes requested by carol"))],
        bot_login="gl[bot]",
        get_pr=get_pr,
        upsert_comment=upsert,
    )

    assert [pr for pr, _ in posted] == [(_REPO, 5), (_REPO, 7)]
    for _pr, kwargs in posted:
        assert kwargs["marker"] == RECHECK_REFUSAL_MARKER
        assert kwargs["author_login"] == "gl[bot]"
        # A refusal is standalone, not a run-owned status comment, so it passes no run_id.
        assert "run_id" not in kwargs
    assert "changes requested by bob" in str(posted[0][1]["body"])
    assert "changes requested by carol" in str(posted[1][1]["body"])


def test_post_refusals_swallows_per_pr_failure_and_continues(caplog):
    posted: list[int] = []

    def get_pr(_client, _repo, number):
        if number == 5:
            raise RuntimeError("fetch boom")
        return number

    def upsert(pr, **_kwargs):
        posted.append(pr)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan_runner.post_refusals(
            _CLIENT, _REPO, [(5, _skip()), (7, _skip())], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert
        )

    # PR5's post failure is isolated and logged; PR7 still gets its refusal, and nothing is raised.
    assert posted == [7]
    assert "failed to post recheck refusal for PR #5" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_post_refusals_iteration_timeout_propagates():
    def get_pr(_client, _repo, number):
        return number

    def upsert(_pr, **_kwargs):
        raise IterationTimeout("iteration exceeded")

    # IterationTimeout is the per-iteration watchdog signal, not a post failure: it must propagate
    # past the swallow arm rather than being logged and ignored.
    with pytest.raises(IterationTimeout):
        scan_runner.post_refusals(
            _CLIENT, _REPO, [(5, _skip())], bot_login="gl[bot]", get_pr=get_pr, upsert_comment=upsert
        )


def test_post_refusals_skips_non_changes_requested_reason(caplog):
    posted: list[object] = []

    def get_pr(_client, _repo, number):
        return number

    def upsert(pr, **_kwargs):
        posted.append(pr)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan_runner.post_refusals(
            _CLIENT,
            _REPO,
            [(5, ReviewSkip(HUMAN_APPROVED, "approved by bob"))],
            bot_login="gl[bot]",
            get_pr=get_pr,
            upsert_comment=upsert,
        )

    # The "changes requested" body only fits a CHANGES_REQUESTED skip; any other reason must be
    # dropped with a warning, never posted with a body that misdescribes the skip.
    assert posted == []
    assert "unexpected skip reason" in caplog.text


def test_evaluate_pr_iteration_timeout_propagates():
    failed: list[int] = []
    abandoned: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []
    future = cast(
        "Future[tuple[str, str] | ReviewSkip | scan_runner._Cancelled]", _RaisingFuture(IterationTimeout("boom"))
    )

    # IterationTimeout is the soft per-iteration timeout; _evaluate_pr must let it propagate to
    # abort the iteration, not swallow it into `failed` like an ordinary fingerprint error.
    with pytest.raises(IterationTimeout):
        scan_runner._evaluate_pr(
            5,
            future,
            {},
            now=datetime(2026, 1, 1, tzinfo=UTC),
            timeout=timedelta(hours=1),
            failed=failed,
            abandoned=abandoned,
            skips=skips,
            force=False,
            cache=None,
        )

    assert failed == []
    assert abandoned == []
    assert skips == []


def test_fingerprint_task_returns_result_and_returns_client_to_pool():
    pool: queue.Queue[Github] = queue.Queue()
    client = cast("Github", object())
    pool.put(client)
    event = threading.Event()

    def fingerprint(borrowed, _number, _authorized, _skip):
        assert borrowed is client
        return ("headsha", "b" * 64)

    result = scan_runner._fingerprint_task(fingerprint, pool, 5, frozenset({"alice"}), True, event)

    assert result == ("headsha", "b" * 64)
    assert pool.get_nowait() is client  # borrowed then returned via finally
    assert not event.is_set()


def test_fingerprint_task_returns_cancelled_without_touching_pool_when_event_set():
    pool: queue.Queue[Github] = queue.Queue()
    sentinel = cast("Github", object())
    pool.put(sentinel)
    event = threading.Event()
    event.set()

    def fingerprint(*_args):
        raise AssertionError("fingerprint must not run once the cancel event is set")

    result = scan_runner._fingerprint_task(fingerprint, pool, 5, frozenset(), True, event)

    # A pre-set cancel event short-circuits before borrowing a client, so the already-limited API is
    # never hit again: the client is left untouched in the pool (get was never called).
    assert result is scan_runner._CANCELLED
    assert pool.get_nowait() is sentinel
    assert pool.empty()


def test_fingerprint_task_rate_limit_error_sets_cancel_and_reraises_returning_client():
    from github import RateLimitExceededException

    pool: queue.Queue[Github] = queue.Queue()
    client = cast("Github", object())
    pool.put(client)
    event = threading.Event()

    def fingerprint(*_args):
        raise RateLimitExceededException(403)

    # A rate limit trips the shared cancel event (so sibling tasks abandon) yet still propagates,
    # and the borrowed client returns to the pool via the finally.
    with pytest.raises(RateLimitExceededException):
        scan_runner._fingerprint_task(fingerprint, pool, 5, frozenset(), True, event)

    assert event.is_set()
    assert pool.get_nowait() is client


def test_fingerprint_task_non_rate_limit_error_propagates_without_cancel():
    pool: queue.Queue[Github] = queue.Queue()
    client = cast("Github", object())
    pool.put(client)
    event = threading.Event()

    def fingerprint(*_args):
        raise ValueError("not a rate limit")

    # A non-rate-limit error must NOT be swallowed by the rate-limit arm -- it propagates with its
    # real type, leaves the cancel event untouched, and returns the client.
    with pytest.raises(ValueError, match="not a rate limit"):
        scan_runner._fingerprint_task(fingerprint, pool, 5, frozenset(), True, event)

    assert not event.is_set()
    assert pool.get_nowait() is client


def test_evaluate_pr_cancelled_result_records_abandoned_not_failed():
    failed: list[int] = []
    abandoned: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []
    future = cast(
        "Future[tuple[str, str] | ReviewSkip | scan_runner._Cancelled]", _ResultFuture(scan_runner._CANCELLED)
    )

    result = scan_runner._evaluate_pr(
        5,
        future,
        {},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        timeout=timedelta(hours=1),
        failed=failed,
        abandoned=abandoned,
        skips=skips,
        force=False,
        cache=None,
    )

    # A cancelled task was never attempted, so it is not a candidate and not a failure: it is recorded
    # as abandoned (distinct from `failed`, which holds only tasks that actually hit the limit) so the
    # scan can surface it instead of dropping it silently.
    assert result is None
    assert abandoned == [5]
    assert failed == []
    assert skips == []


_EVAL_HASH = "a" * 64


def _pr_state(number: int, run_id: int) -> PRState:
    return PRState(
        pr_number=number,
        status="LAND",
        eval_hash=_EVAL_HASH,
        head_sha=f"rec{number}",
        version=datetime(2026, 1, 1),
        run_id=run_id,
    )


_CHANGED_HASH = "b" * 64


class _FakeCache:
    """A fast tick's fingerprint cache holding ``cached``; records every call and the thread it came from."""

    def __init__(self, cached: dict[int, tuple[str, str] | ReviewSkip] | None = None) -> None:
        self.cached = cached or {}
        self.kept: list[int] = []
        self.stored: dict[int, tuple[str, str] | ReviewSkip] = {}
        self.threads: set[int] = set()

    def lookup(self, number: int) -> tuple[str, str] | ReviewSkip | None:
        self.threads.add(threading.get_ident())
        return self.cached.get(number)

    def keep(self, number: int) -> None:
        self.threads.add(threading.get_ident())
        self.kept.append(number)

    def store(self, number: int, result: tuple[str, str] | ReviewSkip) -> None:
        self.threads.add(threading.get_ident())
        self.stored[number] = result


def _client_pool(worker_count: int) -> queue.Queue[Github]:
    client_pool: queue.Queue[Github] = queue.Queue()
    for _ in range(worker_count):
        client_pool.put(cast("Github", object()))
    return client_pool


def _until_dispatchable(
    pr_numbers: list[int],
    *,
    fingerprint: scan_runner.FingerprintFn,
    limit: int,
    worker_count: int = 2,
    states: dict[int, PRState] | None = None,
    failed: list[int] | None = None,
    abandoned: list[int] | None = None,
    skips: list[tuple[int, ReviewSkip]] | None = None,
    cancel_event: threading.Event | None = None,
    cache: _FakeCache | None = None,
) -> list[scan_runner._Candidate]:
    return scan_runner._fingerprint_until_dispatchable(
        pr_numbers,
        states or {},
        fingerprint=fingerprint,
        client_pool=_client_pool(worker_count),
        worker_count=worker_count,
        authorized_logins=frozenset({"alice"}),
        skip_on_approval=True,
        limit=limit,
        now=datetime(2026, 6, 1),
        timeout=timedelta(hours=1),
        failed=failed if failed is not None else [],
        abandoned=abandoned if abandoned is not None else [],
        skips=skips if skips is not None else [],
        force=False,
        cancel_event=cancel_event if cancel_event is not None else threading.Event(),
        cache=cast("FingerprintCache | None", cache),
    )


def _all(
    pr_numbers: list[int],
    *,
    fingerprint: scan_runner.FingerprintFn,
    states: dict[int, PRState],
    abandoned: list[int],
    cancel_event: threading.Event,
    cache: _FakeCache,
) -> list[scan_runner._Candidate]:
    return scan_runner._fingerprint_all(
        pr_numbers,
        states,
        fingerprint=fingerprint,
        client_pool=_client_pool(2),
        worker_count=2,
        authorized_logins=frozenset({"alice"}),
        skip_on_approval=True,
        now=datetime(2026, 6, 1),
        timeout=timedelta(hours=1),
        failed=[],
        abandoned=abandoned,
        skips=[],
        force=False,
        cancel_event=cancel_event,
        cache=cast("FingerprintCache", cache),
    )


def test_fingerprint_until_dispatchable_stops_submitting_once_the_limit_is_reached():
    fingerprinted: list[int] = []
    lock = threading.Lock()

    def fingerprint(_client, number, _authorized, _skip):
        with lock:
            fingerprinted.append(number)
        return (f"headsha{number}", _CHANGED_HASH)

    pending = _until_dispatchable(list(range(1, 9)), fingerprint=fingerprint, limit=1, worker_count=2)

    # Eight dispatchable PRs but a cap of one: submission stops after the first evaluation round, so
    # only the in-flight pair is ever fingerprinted -- the whole point of the capped path.
    assert sorted(fingerprinted) == [1, 2]
    # Both are still evaluated and returned: their GitHub calls are already paid for, and the cap
    # itself is applied later, by _dispatch_pending.
    assert [candidate.pr_number for candidate in pending] == [1, 2]


def test_fingerprint_until_dispatchable_zero_limit_submits_nothing():
    def boom_fingerprint(*_args):
        raise AssertionError("no PR may be fingerprinted under a zero cap")

    assert _until_dispatchable([1, 2, 3], fingerprint=boom_fingerprint, limit=0) == []


def test_fingerprint_until_dispatchable_refills_the_pool_without_waiting_for_the_slowest_task():
    later_task_started = threading.Event()
    failed: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        if number == 1:
            # PR1 finishes only once a task beyond the first pool-sized group has started. Under a
            # batch barrier that task is never submitted (it waits on PR1), so this times out.
            assert later_task_started.wait(timeout=5)
        elif number == 3:
            later_task_started.set()
        return (f"headsha{number}", _CHANGED_HASH)

    pending = _until_dispatchable([1, 2, 3, 4], fingerprint=fingerprint, limit=4, worker_count=2, failed=failed)

    assert failed == []
    assert sorted(candidate.pr_number for candidate in pending) == [1, 2, 3, 4]


def test_fingerprint_until_dispatchable_returns_ranked_order_not_completion_order():
    stalest_waiting = threading.Event()
    other_finished = threading.Event()
    failed: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        # A two-way handshake pins the completion order: PR5 cannot finish until PR9 is parked, and
        # PR9 cannot finish until PR5 has. The stalest PR therefore always completes last.
        if number == 9:
            stalest_waiting.set()
            assert other_finished.wait(timeout=5)
        else:
            assert stalest_waiting.wait(timeout=5)
            other_finished.set()
        return (f"headsha{number}", _CHANGED_HASH)

    pending = _until_dispatchable(
        [9, 5],
        fingerprint=fingerprint,
        limit=4,
        worker_count=2,
        states={5: _pr_state(5, run_id=3)},
        failed=failed,
    )

    assert failed == []

    # PR9 (never reviewed) outranks the recorded PR5 but deliberately finishes last. _dispatch_pending
    # breaks staleness ties on this order, so completion order here would silently hand the last
    # dispatch slot to whichever PR happened to answer first.
    assert [candidate.pr_number for candidate in pending] == [9, 5]


def test_fingerprint_until_dispatchable_stops_submitting_once_the_fan_out_is_cancelled():
    from github import RateLimitExceededException

    cancel_event = threading.Event()
    reached_fingerprint = threading.Event()
    fingerprinted: list[int] = []
    lock = threading.Lock()
    failed: list[int] = []
    abandoned: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        with lock:
            fingerprinted.append(number)
        if number == 2:
            # PR2 is past _fingerprint_task's pre-flight cancel check before PR1 can trip the limit,
            # so it is provably in flight -- not abandoned -- when submission stops. Waiting on the
            # shared event (which _fingerprint_task sets from PR1's rate limit) is also what pins the
            # interleaving: no completion is observable until the cancel has landed.
            reached_fingerprint.set()
            assert cancel_event.wait(timeout=5)
            return _skip("changes requested by bob")
        assert reached_fingerprint.wait(timeout=5)
        raise RateLimitExceededException(403)

    pending = _until_dispatchable(
        list(range(1, 9)),
        fingerprint=fingerprint,
        limit=8,
        worker_count=2,
        failed=failed,
        abandoned=abandoned,
        skips=skips,
        cancel_event=cancel_event,
    )

    # Eight PRs and a cap of eight, so the cap can never be what stops submission: the cancel event
    # is the only remaining sub-condition of the `while` guard, and it is the rate-limit safety valve
    # on the path production takes (the Lambda always passes --max). Coverage cannot see this --
    # it tracks the branch out of the `while`, not which sub-condition short-circuited.
    assert sorted(fingerprinted) == [1, 2]
    # The already-in-flight pair is still drained: PR1's rate limit is recorded as a failure and PR2's
    # human-decision skip is still collected, rather than both being dropped with the fan-out.
    assert failed == [1]
    assert [number for number, _ in skips] == [2]
    # PRs 3-8 were never submitted, so they are not abandoned tasks either -- abandoned holds only
    # tasks that reached the pool and found the event already set.
    assert abandoned == []
    assert pending == []


def test_a_cached_result_that_settles_its_pr_is_judged_without_a_fingerprint(caplog):
    fingerprinted: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []
    cache = _FakeCache({1: ("headsha1", _EVAL_HASH), 2: _skip("changes requested by bob")})

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        fingerprinted.append(number)
        return (f"headsha{number}", _EVAL_HASH)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        pending = _until_dispatchable(
            [1, 2, 3],
            fingerprint=fingerprint,
            limit=4,
            states={1: _pr_state(1, run_id=1), 3: _pr_state(3, run_id=1)},
            skips=skips,
            cache=cache,
        )

    # PR1's cached hash is the one its LAND was recorded for, and PR2's cached human decision still
    # stands, so neither costs a fingerprint; PR3 has nothing cached and is fingerprinted as before.
    assert fingerprinted == [3]
    assert sorted(cache.kept) == [1, 2]
    # Decisions taken from the cache are tagged; PR3's fresh one is not.
    assert "PR #1: SKIP (decided, cached)" in caplog.text
    assert "PR #2: SKIP (changes_requested, cached): changes requested by bob" in caplog.text
    assert "PR #3: SKIP (decided)" in caplog.text
    assert skips == [(2, _skip("changes requested by bob"))]
    assert pending == []
    assert cache.stored == {3: ("headsha3", _EVAL_HASH)}


def test_a_cached_result_that_would_dispatch_is_fingerprinted_afresh_and_the_fresh_one_dispatches(caplog):
    cache = _FakeCache({1: ("stalehead", _EVAL_HASH)})
    fingerprinted: list[int] = []

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        fingerprinted.append(number)
        return ("freshhead", _CHANGED_HASH)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        pending = _until_dispatchable([1], fingerprint=fingerprint, limit=4, cache=cache)

    # PR1 was never reviewed, so its cached result would dispatch; the head and hash a dispatch hands
    # the reviewer are read this tick, never taken from the cache, and the decision is logged once.
    assert fingerprinted == [1]
    assert cache.kept == []
    assert [(c.pr_number, c.head_sha, c.eval_hash) for c in pending] == [(1, "freshhead", _CHANGED_HASH)]
    assert cache.stored == {1: ("freshhead", _CHANGED_HASH)}
    assert caplog.text.count("PR #1: DISPATCH (never_reviewed)") == 1


def test_cache_hits_take_no_slot_and_never_count_toward_the_limit():
    fingerprinted: list[int] = []
    lock = threading.Lock()
    newer = datetime(2026, 2, 1)
    states = {
        **{n: _pr_state(n, run_id=1) for n in (1, 2)},
        **{n: dataclasses.replace(_pr_state(n, run_id=1), version=newer) for n in (3, 4, 5)},
    }
    cache = _FakeCache({1: ("headsha1", _EVAL_HASH), 2: ("headsha2", _EVAL_HASH)})

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        with lock:
            fingerprinted.append(number)
        return (f"headsha{number}", _CHANGED_HASH)

    pending = _until_dispatchable(
        [1, 2, 3, 4, 5], fingerprint=fingerprint, limit=1, worker_count=2, states=states, cache=cache
    )

    # PRs 1 and 2 rank stalest, but their cached results settle them before anything is submitted, so
    # the pool's first pair goes to PRs 3 and 4, and the cap of one then keeps PR5 from being submitted.
    assert sorted(cache.kept) == [1, 2]
    assert sorted(fingerprinted) == [3, 4]
    assert [candidate.pr_number for candidate in pending] == [3, 4]
    assert cache.threads == {threading.get_ident()}


def test_cache_hits_are_still_judged_when_a_rate_limit_cancels_the_fan_out():
    from github import RateLimitExceededException

    cancel_event = threading.Event()
    reached_fingerprint = threading.Event()
    fingerprinted: list[int] = []
    lock = threading.Lock()
    failed: list[int] = []
    abandoned: list[int] = []
    skips: list[tuple[int, ReviewSkip]] = []
    cache = _FakeCache({11: ("headsha11", _EVAL_HASH), 12: ("headsha12", _EVAL_HASH)})

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        with lock:
            fingerprinted.append(number)
        if number == 2:
            reached_fingerprint.set()
            assert cancel_event.wait(timeout=5)
            return _skip("changes requested by bob")
        assert reached_fingerprint.wait(timeout=5)
        raise RateLimitExceededException(403)

    pending = _until_dispatchable(
        [*range(1, 9), 11, 12],
        fingerprint=fingerprint,
        limit=8,
        worker_count=2,
        states={11: _pr_state(11, run_id=1), 12: _pr_state(12, run_id=1)},
        failed=failed,
        abandoned=abandoned,
        skips=skips,
        cancel_event=cancel_event,
        cache=cache,
    )

    # The cached PRs 11 and 12 are settled before submission starts; the uncached PRs go exactly as in
    # the uncached cancellation test: PR1's rate limit stops submission after the first pair, both are
    # drained, and PRs 3-8 are never submitted. Of the drained pair only PR2 completed, so only its
    # skip is cached.
    assert sorted(cache.kept) == [11, 12]
    assert sorted(fingerprinted) == [1, 2]
    assert failed == [1]
    assert [number for number, _ in skips] == [2]
    assert abandoned == []
    assert pending == []
    assert cache.stored == {2: _skip("changes requested by bob")}


def test_fingerprint_all_judges_cache_hits_fingerprints_the_rest_and_never_caches_an_abandoned_task():
    fingerprinted: list[int] = []
    lock = threading.Lock()
    abandoned: list[int] = []
    cache = _FakeCache({1: ("headsha1", _EVAL_HASH), 2: ("stalehead", _EVAL_HASH)})

    def fingerprint(_client, number, _authorized, _skip_on_approval):
        with lock:
            fingerprinted.append(number)
        return (f"freshhead{number}", _CHANGED_HASH)

    pending = _all(
        [1, 2, 3],
        fingerprint=fingerprint,
        states={1: _pr_state(1, run_id=1)},
        abandoned=abandoned,
        cancel_event=threading.Event(),
        cache=cache,
    )

    # PR1 settles from the cache; PR2's cached result would dispatch, so it is fingerprinted afresh
    # with the uncached PR3, and both dispatch on the fresh results.
    assert cache.kept == [1]
    assert sorted(fingerprinted) == [2, 3]
    assert [(c.pr_number, c.head_sha) for c in pending] == [(2, "freshhead2"), (3, "freshhead3")]
    assert cache.stored == {2: ("freshhead2", _CHANGED_HASH), 3: ("freshhead3", _CHANGED_HASH)}
    assert abandoned == []
    assert cache.threads == {threading.get_ident()}

    cancelled = threading.Event()
    cancelled.set()
    cache = _FakeCache({1: ("headsha1", _EVAL_HASH)})

    pending = _all(
        [1, 2],
        fingerprint=fingerprint,
        states={1: _pr_state(1, run_id=1)},
        abandoned=abandoned,
        cancel_event=cancelled,
        cache=cache,
    )

    # Once the fan-out is cancelled the cached PR1 still settles, while PR2's task is abandoned as
    # before and nothing is cached for it.
    assert cache.kept == [1]
    assert abandoned == [2]
    assert pending == []
    assert cache.stored == {}


@pytest.mark.parametrize("result", [("headsha5", _EVAL_HASH), _skip()], ids=["fingerprint", "human-decided"])
def test_evaluate_pr_stores_every_completed_fingerprint(result):
    cache = _FakeCache()
    future = cast("Future[tuple[str, str] | ReviewSkip | scan_runner._Cancelled]", _ResultFuture(result))

    scan_runner._evaluate_pr(
        5,
        future,
        {},
        now=datetime(2026, 6, 1),
        timeout=timedelta(hours=1),
        failed=[],
        abandoned=[],
        skips=[],
        force=False,
        cache=cast("FingerprintCache", cache),
    )

    assert cache.stored == {5: result}


@pytest.mark.parametrize(
    "future",
    [_RaisingFuture(RuntimeError("fingerprint boom")), _ResultFuture(scan_runner._CANCELLED)],
    ids=["failed", "abandoned"],
)
def test_evaluate_pr_stores_neither_a_failed_nor_an_abandoned_task(future):
    cache = _FakeCache()

    scan_runner._evaluate_pr(
        5,
        cast("Future[tuple[str, str] | ReviewSkip | scan_runner._Cancelled]", future),
        {},
        now=datetime(2026, 6, 1),
        timeout=timedelta(hours=1),
        failed=[],
        abandoned=[],
        skips=[],
        force=False,
        cache=cast("FingerprintCache", cache),
    )

    assert cache.stored == {}


def test_evaluate_pr_does_not_store_a_result_whose_judgment_raises(monkeypatch):
    def boom_decide(**_kwargs):
        raise RuntimeError("decide boom")

    monkeypatch.setattr(scan_runner, "decide", boom_decide)
    cache = _FakeCache()
    failed: list[int] = []
    future = cast(
        "Future[tuple[str, str] | ReviewSkip | scan_runner._Cancelled]", _ResultFuture(("headsha5", _EVAL_HASH))
    )

    result = scan_runner._evaluate_pr(
        5,
        future,
        {},
        now=datetime(2026, 6, 1),
        timeout=timedelta(hours=1),
        failed=failed,
        abandoned=[],
        skips=[],
        force=False,
        cache=cast("FingerprintCache", cache),
    )

    # The fingerprint completed but its judgment failed, so the PR is failed and leaves nothing cached
    # for a later tick to settle on.
    assert result is None
    assert failed == [5]
    assert cache.stored == {}


def test_an_iteration_timeout_while_judging_a_cached_result_propagates(monkeypatch):
    def timeout_decide(**_kwargs):
        raise IterationTimeout("iteration exceeded")

    def fingerprint(*_args):
        raise AssertionError("no PR may be fingerprinted once the iteration has timed out")

    monkeypatch.setattr(scan_runner, "decide", timeout_decide)

    # The per-iteration watchdog must abort the tick from the cached path too, never be logged and
    # swallowed like an ordinary judgment error that sends the PR to the fresh path.
    with pytest.raises(IterationTimeout):
        _until_dispatchable(
            [1],
            fingerprint=fingerprint,
            limit=4,
            states={1: _pr_state(1, run_id=1)},
            cache=_FakeCache({1: ("headsha1", _EVAL_HASH)}),
        )
