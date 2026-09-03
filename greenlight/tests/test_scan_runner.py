from __future__ import annotations

import logging
import queue
import threading
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, NoReturn, cast

import pytest

from greenlight import scan_runner
from greenlight.comment_format import RECHECK_REFUSAL_MARKER
from greenlight.constants import TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, HUMAN_APPROVED, ReviewSkip
from greenlight.state import PRState

if TYPE_CHECKING:
    from concurrent.futures import Future

    from github import Github

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


def _candidate(number: int, *, run_id: int | None) -> scan_runner._Candidate:
    # run_id is None to model a never-reviewed PR (state None); an int models a recorded prior run.
    recorded = None if run_id is None else _pr_state(number, run_id)
    return scan_runner._Candidate(
        pr_number=number,
        head_sha=f"headsha{number}",
        eval_hash=_EVAL_HASH,
        state=recorded,
        reason="never_reviewed" if run_id is None else "changed",
    )


def _noop_poke(_pr_number: int) -> None:
    return None


def _boom_poke(pr_number: int) -> NoReturn:
    raise AssertionError(f"poke should not be called for PR #{pr_number}")


def _never_shadow(_pr_number: int) -> bool:
    return False


def test_dispatch_pending_emits_marker_with_next_run_id():
    dispatched: list[int] = []
    emitted: list[dict[str, object]] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    def emit(**kwargs):
        emitted.append(kwargs)

    pending = [_candidate(1, run_id=None), _candidate(2, run_id=4), _candidate(3, run_id=0)]
    failed = scan_runner._dispatch_pending(
        _CLIENT,
        pending,
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=_noop_poke,
        is_shadow=_never_shadow,
    )

    # One marker per successfully dispatched candidate: never-reviewed (None) and legacy run_id 0
    # both base at run_id 1; a prior run 4 supersedes with run_id 5.
    assert failed == []
    assert sorted(dispatched) == [1, 2, 3]
    assert {call["pr_number"]: call["run_id"] for call in emitted} == {1: 1, 2: 5, 3: 1}
    for call in emitted:
        assert call["repo"] == TARGET_REPO
        assert call["eval_hash"] == _EVAL_HASH
    assert {call["head_sha"] for call in emitted} == {"headsha1", "headsha2", "headsha3"}


def test_dispatch_pending_does_not_emit_when_dispatch_fails():
    emitted: list[dict[str, object]] = []
    poked: list[int] = []

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        raise RuntimeError(f"dispatch boom {number}")

    def emit(**kwargs):
        emitted.append(kwargs)

    failed = scan_runner._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=2)],
        ref="main",
        max_dispatches=None,
        dispatch=boom_dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        is_shadow=_never_shadow,
    )

    # A failed dispatch never fired the workflow, so no in-flight marker may be emitted for it --
    # and with no marker written there is nothing for Dr. CI to re-render, so no poke either.
    assert failed == [1]
    assert emitted == []
    assert poked == []


def test_dispatch_pending_swallows_emit_failure_and_continues(caplog):
    dispatched: list[int] = []
    emitted: list[int] = []
    poked: list[int] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    def boom_emit(*, pr_number, **_kwargs):
        if pr_number == 1:
            raise RuntimeError("emit boom")
        emitted.append(pr_number)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        failed = scan_runner._dispatch_pending(
            _CLIENT,
            [_candidate(1, run_id=None), _candidate(2, run_id=None)],
            ref="main",
            max_dispatches=None,
            dispatch=dispatch,
            emit_dispatched=boom_emit,
            poke=poked.append,
            is_shadow=_never_shadow,
        )

    # The workflow already fired, so a marker-emit failure is logged and swallowed: PR1's dispatch
    # is not counted as failed, and the remaining PR2 still dispatches and emits.
    assert failed == []
    assert dispatched == [1, 2]
    assert emitted == [2]
    # PR1 wrote no marker, so poking it would rebuild the comment from the state the marker was
    # meant to replace; only PR2's successful emit earns a poke.
    assert poked == [2]
    assert "failed to emit AI_REVIEW_DISPATCHED marker for PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_dispatch_pending_emit_iteration_timeout_propagates():
    dispatched: list[int] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    def timeout_emit(**_kwargs):
        raise IterationTimeout("iteration exceeded")

    # IterationTimeout from the marker emit is the per-iteration watchdog signal: it must propagate
    # past the swallow arm, halting the loop so PR2 is never reached.
    with pytest.raises(IterationTimeout):
        scan_runner._dispatch_pending(
            _CLIENT,
            [_candidate(1, run_id=None), _candidate(2, run_id=None)],
            ref="main",
            max_dispatches=None,
            dispatch=dispatch,
            emit_dispatched=timeout_emit,
            poke=_boom_poke,
            is_shadow=_never_shadow,
        )

    assert dispatched == [1]


def test_dispatch_pending_pokes_drci_after_each_successful_emit():
    events: list[str] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        events.append(f"dispatch:{number}")

    def emit(*, pr_number, **_kwargs):
        events.append(f"emit:{pr_number}")

    def poke(pr_number):
        events.append(f"poke:{pr_number}")

    failed = scan_runner._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=4)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poke,
        is_shadow=_never_shadow,
    )

    # Ordering is the contract: Dr. CI re-reads the row on poke, so each PR's poke must follow its
    # own emit, and one candidate must be fully handled before the next is dispatched.
    assert failed == []
    assert events == ["dispatch:1", "emit:1", "poke:1", "dispatch:2", "emit:2", "poke:2"]


def test_dispatch_pending_does_not_poke_deferred_candidates():
    poked: list[int] = []

    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, *, shadow):
        return None

    def emit(**_kwargs):
        return None

    failed = scan_runner._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=None)],
        ref="main",
        max_dispatches=1,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        is_shadow=_never_shadow,
    )

    # A candidate deferred by the --max cap was never dispatched or marked, so it must not be poked.
    assert failed == []
    assert poked == [1]


@pytest.mark.parametrize("shadow", [pytest.param(True, id="shadow-author"), pytest.param(False, id="trusted-author")])
def test_dispatch_pending_stamps_shadow_on_the_input_and_the_marker(shadow):
    dispatch_kwargs: list[dict[str, object]] = []
    emitted: list[dict[str, object]] = []

    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, **kwargs):
        dispatch_kwargs.append(kwargs)

    def emit(**kwargs):
        emitted.append(kwargs)

    failed = scan_runner._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=_noop_poke,
        is_shadow=lambda _number: shadow,
    )

    # One lookup drives both: the reviewer workflow input that withholds the approval, and the row
    # the merge gate and Dr. CI read.
    assert failed == []
    assert dispatch_kwargs == [{"shadow": shadow}]
    assert [call["shadow"] for call in emitted] == [shadow]


def test_dispatch_pending_resolves_shadow_per_candidate():
    seen: list[tuple[int, object]] = []

    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, *, shadow):
        return None

    def emit(*, pr_number, shadow, **_kwargs):
        seen.append((pr_number, shadow))

    scan_runner._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=None)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=_noop_poke,
        is_shadow=lambda number: number == 2,
    )

    # A mixed batch must not collapse to one answer -- the cohort is per author, and a single scan
    # routinely carries both.
    assert seen == [(1, False), (2, True)]


_CHANGED_HASH = "b" * 64


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
) -> list[scan_runner._Candidate]:
    client_pool: queue.Queue[Github] = queue.Queue()
    for _ in range(worker_count):
        client_pool.put(cast("Github", object()))
    return scan_runner._fingerprint_until_dispatchable(
        pr_numbers,
        states or {},
        fingerprint=fingerprint,
        client_pool=client_pool,
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
