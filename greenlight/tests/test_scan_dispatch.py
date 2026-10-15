from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, NoReturn, cast

import pytest

from greenlight import scan_dispatch, scan_runner
from greenlight.constants import TARGET_REPO
from greenlight.guards import IterationTimeout
from greenlight.state import PRState

if TYPE_CHECKING:
    from github import Github

# _dispatch_pending threads the client straight through to the dispatch seam and never inspects it.
_CLIENT = cast("Github", object())
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
    failed = scan_dispatch._dispatch_pending(
        _CLIENT,
        pending,
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=_noop_poke,
        shadow_for_pr=_never_shadow,
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

    failed = scan_dispatch._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=2)],
        ref="main",
        max_dispatches=None,
        dispatch=boom_dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        shadow_for_pr=_never_shadow,
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
        failed = scan_dispatch._dispatch_pending(
            _CLIENT,
            [_candidate(1, run_id=None), _candidate(2, run_id=None)],
            ref="main",
            max_dispatches=None,
            dispatch=dispatch,
            emit_dispatched=boom_emit,
            poke=poked.append,
            shadow_for_pr=_never_shadow,
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
        scan_dispatch._dispatch_pending(
            _CLIENT,
            [_candidate(1, run_id=None), _candidate(2, run_id=None)],
            ref="main",
            max_dispatches=None,
            dispatch=dispatch,
            emit_dispatched=timeout_emit,
            poke=_boom_poke,
            shadow_for_pr=_never_shadow,
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

    failed = scan_dispatch._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=4)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poke,
        shadow_for_pr=_never_shadow,
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

    failed = scan_dispatch._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=None)],
        ref="main",
        max_dispatches=1,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        shadow_for_pr=_never_shadow,
    )

    # A candidate deferred by the --max cap was never dispatched or marked, so it must not be poked.
    assert failed == []
    assert poked == [1]


@pytest.mark.parametrize(
    ("shadow", "expected_pokes"),
    [
        pytest.param(True, [], id="shadow-author"),
        pytest.param(False, [1], id="trusted-author"),
    ],
)
def test_dispatch_pending_stamps_shadow_on_the_input_and_the_marker(shadow, expected_pokes):
    dispatch_kwargs: list[dict[str, object]] = []
    emitted: list[dict[str, object]] = []
    poked: list[int] = []

    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, **kwargs):
        dispatch_kwargs.append(kwargs)

    def emit(**kwargs):
        emitted.append(kwargs)

    failed = scan_dispatch._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        shadow_for_pr=lambda _number: shadow,
    )

    # One lookup drives all three: the reviewer workflow input that withholds the approval, the row
    # the merge gate and Dr. CI read, and whether a rebuild is worth requesting at all.
    assert failed == []
    assert dispatch_kwargs == [{"shadow": shadow}]
    assert [call["shadow"] for call in emitted] == [shadow]
    assert poked == expected_pokes


def test_dispatch_pending_resolves_shadow_per_candidate():
    seen: list[tuple[int, object]] = []
    poked: list[int] = []

    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, *, shadow):
        return None

    def emit(*, pr_number, shadow, **_kwargs):
        seen.append((pr_number, shadow))

    scan_dispatch._dispatch_pending(
        _CLIENT,
        [_candidate(1, run_id=None), _candidate(2, run_id=None)],
        ref="main",
        max_dispatches=None,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=poked.append,
        shadow_for_pr=lambda number: number == 2,
    )

    # A mixed batch must not collapse to one answer -- the cohort is per author, and a single scan
    # routinely carries both.
    assert seen == [(1, False), (2, True)]
    assert poked == [1]


def test_dispatch_pending_does_not_poke_a_shadow_pr_whose_emit_failed(caplog):
    def dispatch(_client, _number, _head_sha, _eval_hash, _ref, *, shadow):
        return None

    def boom_emit(**_kwargs):
        raise RuntimeError("emit boom")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        failed = scan_dispatch._dispatch_pending(
            _CLIENT,
            [_candidate(1, run_id=None)],
            ref="main",
            max_dispatches=None,
            dispatch=dispatch,
            emit_dispatched=boom_emit,
            poke=_boom_poke,
            shadow_for_pr=lambda _number: True,
        )

    # Both suppressions apply at once, and the shadow one must not resurrect the failed-emit one:
    # _boom_poke asserts if either is dropped.
    assert failed == []
    assert "failed to emit AI_REVIEW_DISPATCHED marker for PR #1" in caplog.text
