import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

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
    skips: list[tuple[int, ReviewSkip]] = []
    future = cast("Future[tuple[str, str] | ReviewSkip]", _RaisingFuture(IterationTimeout("boom")))

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
            skips=skips,
            force=False,
        )

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


def test_dispatch_pending_emits_marker_with_next_run_id():
    dispatched: list[int] = []
    emitted: list[dict[str, object]] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref):
        dispatched.append(number)

    def emit(**kwargs):
        emitted.append(kwargs)

    pending = [_candidate(1, run_id=None), _candidate(2, run_id=4), _candidate(3, run_id=0)]
    failed = scan_runner._dispatch_pending(
        _CLIENT, pending, ref="main", max_dispatches=None, dispatch=dispatch, emit_dispatched=emit
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

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref):
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
    )

    # A failed dispatch never fired the workflow, so no in-flight marker may be emitted for it.
    assert failed == [1]
    assert emitted == []


def test_dispatch_pending_swallows_emit_failure_and_continues(caplog):
    dispatched: list[int] = []
    emitted: list[int] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref):
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
        )

    # The workflow already fired, so a marker-emit failure is logged and swallowed: PR1's dispatch
    # is not counted as failed, and the remaining PR2 still dispatches and emits.
    assert failed == []
    assert dispatched == [1, 2]
    assert emitted == [2]
    assert "failed to emit AI_REVIEW_DISPATCHED marker for PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_dispatch_pending_emit_iteration_timeout_propagates():
    dispatched: list[int] = []

    def dispatch(_client, number, _head_sha, _eval_hash, _ref):
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
        )

    assert dispatched == [1]
