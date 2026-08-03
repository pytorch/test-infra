import logging
import queue
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast
from unittest.mock import Mock

import pytest

from greenlight import github_client, review
from greenlight.constants import (
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    TARGET_REPO,
)
from greenlight.github_client import OpenPR
from greenlight.guards import IterationTimeout
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.config import Config

# The scan client is threaded through every seam but never inspected by the fakes below,
# so a bare sentinel cast to the client type is all the loop needs.
_CLIENT = cast("Github", object())

_HASH_A = "a" * 64
_HASH_B = "b" * 64
_AUTHORIZED = frozenset({"alband", "alice", "bob"})
_NOW = datetime(2026, 7, 31, 12, 0, 0)
_FRESH = _NOW - timedelta(minutes=10)
_STALE = _NOW - timedelta(minutes=50)
_OLD = _NOW - timedelta(days=2)
_NEW = _NOW - timedelta(hours=1)


def _open_pr(number: int, *, head_sha: str | None = None, updated_at: datetime | None = None) -> OpenPR:
    return OpenPR(
        repo=TARGET_REPO,
        number=number,
        author="albanD",
        title=f"fix {number}",
        url=f"https://example.test/{number}",
        head_sha=head_sha or f"headsha{number}",
        updated_at=updated_at,
    )


def _state(number: int, status: str, eval_hash: str, version: datetime) -> PRState:
    return PRState(pr_number=number, status=status, eval_hash=eval_hash, head_sha=f"rec{number}", version=version)


@dataclass
class _Scan:
    dispatched: list[tuple[int, str, str, str]]
    read_calls: list[tuple[str, list[int]]]
    fingerprinted: list[int]
    listed_calls: int
    resolver_calls: int
    authorized_seen: list[frozenset[str]]


def _run_scan(
    make_config: Callable[..., Config],
    *,
    fingerprints: dict[int, tuple[str, str]],
    listed: Sequence[OpenPR] = (),
    states: dict[int, PRState] | None = None,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    force: bool = False,
    authorized: frozenset[str] = _AUTHORIZED,
    now: datetime = _NOW,
    config_kwargs: dict[str, object] | None = None,
) -> _Scan:
    states = states or {}
    dispatched: list[tuple[int, str, str, str]] = []
    read_calls: list[tuple[str, list[int]]] = []
    fingerprinted: list[int] = []
    listed_calls: list[int] = []
    resolver_calls: list[int] = []
    authorized_seen: list[frozenset[str]] = []

    def fake_fetch(_client):
        listed_calls.append(1)
        return list(listed)

    def fake_fingerprint(_client, number, authorized_logins):
        fingerprinted.append(number)
        authorized_seen.append(authorized_logins)
        return fingerprints[number]

    def fake_read_state(repo, numbers):
        nums = list(numbers)
        read_calls.append((repo, nums))
        return {n: states[n] for n in nums if n in states}

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    def fake_resolve_authorized():
        resolver_calls.append(1)
        return authorized

    review.run(
        make_config(github_token="t", **(config_kwargs or {})),
        pr=pr,
        max_dispatches=max_dispatches,
        ref=ref,
        timeout_minutes=timeout_minutes,
        force=force,
        build_github=lambda _token: _CLIENT,
        fetch=fake_fetch,
        fingerprint=fake_fingerprint,
        read_state=fake_read_state,
        dispatch=fake_dispatch,
        resolve_authorized=fake_resolve_authorized,
        now=lambda: now,
    )
    return _Scan(dispatched, read_calls, fingerprinted, len(listed_calls), len(resolver_calls), authorized_seen)


def test_never_reviewed_dispatches(make_config):
    scan = _run_scan(make_config, listed=[_open_pr(1)], fingerprints={1: ("headsha1", _HASH_A)})

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.fingerprinted == [1]
    assert scan.read_calls == [(TARGET_REPO, [1])]


def test_decided_same_hash_skips(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == []


def test_changed_hash_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1b", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == [(1, "headsha1b", _HASH_B, DEFAULT_DISPATCH_REF)]


def test_in_flight_fresh_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _FRESH)},
    )

    assert scan.dispatched == []


def test_in_flight_stale_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _STALE)},
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_retry_backoff_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_CANCELLED, _HASH_A, _FRESH)},
    )

    assert scan.dispatched == []


def test_retry_aged_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_CANCELLED, _HASH_A, _STALE)},
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_in_window_pr_is_processed(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW)],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # Updated within the 24h window: fingerprinted and dispatched (never reviewed).
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_out_of_window_never_reviewed_is_skipped(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # Stale and never reviewed: pruned before fingerprinting -- the whole point of the window.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    # State is still read for the full candidate set before the window prunes it.
    assert scan.read_calls == [(TARGET_REPO, [1])]


def test_recency_window_out_of_window_terminal_is_skipped(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _OLD)},
    )

    # Stale and terminal (decided): its hash cannot have changed, so skip without fingerprinting.
    assert scan.fingerprinted == []
    assert scan.dispatched == []


@pytest.mark.parametrize("status", [STATUS_AI_REVIEW_STARTED, STATUS_CANCELLED, STATUS_FAILED])
def test_recency_window_out_of_window_nonterminal_is_still_processed(make_config, status):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, status, _HASH_A, _STALE)},
    )

    # The guard: a non-terminal ledger state (in-flight / retry) is re-checked even when stale, so
    # the aged version lets decide re-dispatch it (timed_out / retry) -- the window never hides it.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_updated_at_none_is_processed(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=None)],
        fingerprints={1: ("headsha1b", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _OLD)},
    )

    # A missing updated_at is never treated as stale: the PR is fingerprinted, and the changed hash
    # re-dispatches it. Were None wrongly treated as out-of-window, this terminal PR would be skipped.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1b", _HASH_B, DEFAULT_DISPATCH_REF)]


def test_recency_window_pr_target_is_exempt(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        states={5: _state(5, STATUS_LAND, _HASH_A, _OLD)},
    )

    # A single --pr target bypasses the window entirely: it is always fingerprinted and evaluated
    # (here it only SKIPs because decide finds the hash unchanged, not because of the window).
    assert scan.fingerprinted == [5]
    assert scan.dispatched == []


def test_recency_window_mixed_batch_prunes_only_stale_skippable(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW), _open_pr(2, updated_at=_OLD), _open_pr(3, updated_at=_OLD)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        states={2: _state(2, STATUS_LAND, _HASH_A, _OLD)},
    )

    # read_state covers all three candidates before the window prunes any. PR1 (in-window) is
    # processed and dispatched; PR2 (stale terminal) and PR3 (stale never-reviewed) are pruned.
    assert scan.read_calls == [(TARGET_REPO, [1, 2, 3])]
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "h1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_config_value_drives_cutoff(make_config):
    recent = _NOW - timedelta(minutes=30)
    old = _NOW - timedelta(hours=2)
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=recent), _open_pr(2, updated_at=old)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
        config_kwargs={"review_window_hours": 1.0},
    )

    # With the window shrunk to 1h, the 30-min-old PR1 is kept but the 2h-old PR2 is pruned. At the
    # 24h default both would be kept, so this proves the config value -- not a hardcoded 24h -- is
    # the cutoff that drives the filter.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "h1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_exactly_at_edge_is_out_of_window(make_config):
    at_edge = _NOW - timedelta(hours=24)
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=at_edge)],
        fingerprints={1: ("h1", _HASH_A)},
    )

    # updated_at exactly window-old: now - updated_at == window, and the strict `<` treats the edge
    # as out-of-window, so this never-reviewed PR is pruned rather than fingerprinted.
    assert scan.fingerprinted == []
    assert scan.dispatched == []


def test_max_caps_only_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
        max_dispatches=1,
    )

    # PR2 skips (decided, same hash); PR1 and PR3 both dispatch, but the cap of 1 must go to
    # the stalest (never-reviewed PR3) and the skip must not consume the single slot.
    assert scan.dispatched == [(3, "headsha3", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_max_zero_dispatches_nothing(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        max_dispatches=0,
    )

    assert scan.dispatched == []
    # A zero cap does no work at all: nothing is fingerprinted, not just nothing dispatched.
    assert scan.fingerprinted == []


def test_max_with_no_candidates_dispatches_nothing(make_config):
    scan = _run_scan(make_config, listed=[], fingerprints={}, max_dispatches=1)

    assert scan.dispatched == []
    assert scan.fingerprinted == []
    assert scan.read_calls == [(TARGET_REPO, [])]


def test_max_early_stop_limits_fingerprints(make_config):
    numbers = list(range(1, 30))
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={n: (f"headsha{n}", _HASH_A) for n in numbers},
        max_dispatches=1,
    )

    # 29 equally stale never-reviewed PRs: staleness ties break on listing order, so PR1 takes the
    # single slot. Early-stop fingerprints only the first worker-sized batch, never all 29.
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert sorted(scan.fingerprinted) == list(range(1, review._FINGERPRINT_WORKERS + 1))


def test_max_dispatches_most_stale_first(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 3: _state(3, STATUS_LAND, _HASH_A, _OLD)},
        max_dispatches=2,
    )

    # Same inputs as the --max-None fairness test but capped at 2: the two stalest dispatchable
    # (never-reviewed PR2, then oldest-recorded PR3) dispatch in staleness order; PR1 is deferred.
    assert [number for number, *_ in scan.dispatched] == [2, 3]


def test_max_continues_past_non_dispatch_batches(make_config):
    stale_decided = list(range(1, review._FINGERPRINT_WORKERS + 1))
    target = review._FINGERPRINT_WORKERS + 1
    numbers = [*stale_decided, target]
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={
            **{n: (f"headsha{n}", _HASH_A) for n in stale_decided},
            target: (f"headsha{target}", _HASH_B),
        },
        states={
            **{n: _state(n, STATUS_LAND, _HASH_A, _OLD) for n in stale_decided},
            target: _state(target, STATUS_LAND, _HASH_A, _NEW),
        },
        max_dispatches=1,
    )

    # The stalest PRs all SKIP (decided, unchanged) and fill the first batch with no dispatchable, so
    # early-stop must fingerprint into the second batch to reach the lone changed PR -- SKIP PRs
    # ahead of the Kth dispatchable are still fingerprinted.
    assert scan.dispatched == [(target, f"headsha{target}", _HASH_B, DEFAULT_DISPATCH_REF)]
    assert sorted(scan.fingerprinted) == numbers


def test_max_fingerprint_failure_still_raises(make_config, caplog):
    numbers = list(range(1, 30))
    dispatched: list[int] = []

    def boom_fingerprint(_client, number, _authorized):
        if number == 3:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append(number)

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            max_dispatches=1,
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(n) for n in numbers],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR3 sits in the first (only) launched batch, so its fingerprint failure is attempted and
    # surfaces as the aggregate RuntimeError; the healthy stalest PR1 still dispatches first, and the
    # never-fingerprinted PRs beyond that batch are absent from the sorted failed list.
    assert dispatched == [1]
    assert "skipping PR #3" in caplog.text


def test_pr_targets_single_pr_bypasses_listing(make_config):
    scan = _run_scan(make_config, pr=5, listed=[_open_pr(1)], fingerprints={5: ("headsha5", _HASH_A)})

    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.listed_calls == 0
    assert scan.fingerprinted == [5]
    assert scan.read_calls == [(TARGET_REPO, [5])]


def test_pr_decided_still_skips(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == []
    assert scan.listed_calls == 0


def test_force_dispatches_decided_pr_via_fingerprint_all(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
            force=True,
        )

    # The decided PR from test_pr_decided_still_skips (terminal LAND, unchanged hash) normally SKIPs;
    # force bypasses decide on the max_dispatches=None path (_fingerprint_all) and dispatches it,
    # still using the fingerprint's head_sha/eval_hash and tagging the reason "forced".
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert "PR #5: DISPATCH (forced)" in caplog.text
    assert "dispatched review for PR #5 (forced)" in caplog.text


def test_force_dispatches_decided_pr_via_until_dispatchable(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
            max_dispatches=1,
            force=True,
        )

    # The capped path (_fingerprint_until_dispatchable, selected by a non-None --max) must honor
    # force identically: the same decided PR is dispatched with reason "forced".
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert "PR #5: DISPATCH (forced)" in caplog.text


def test_force_fingerprint_failure_still_raises(make_config, caplog):
    dispatched: list[int] = []

    def boom_fingerprint(_client, _number, _authorized):
        raise RuntimeError("fingerprint boom")

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append(number)

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[7\]"),
    ):
        review.run(
            make_config(github_token="t"),
            pr=7,
            force=True,
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # force short-circuits decide, not the try/except: the fingerprint failure is raised before the
    # force branch is reached, so PR7 is still caught, recorded as failed, and surfaces as the
    # aggregate RuntimeError -- force never bypasses failure handling nor dispatches a failed PR.
    assert dispatched == []
    assert "skipping PR #7" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_ref_forwarded_to_dispatch(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        ref="release/2.9",
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, "release/2.9")]


def test_fair_ordering_never_reviewed_then_oldest_first(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 3: _state(3, STATUS_LAND, _HASH_A, _OLD)},
    )

    assert [number for number, *_ in scan.dispatched] == [2, 3, 1]


def test_timeout_minutes_default_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _NOW - timedelta(minutes=20))},
    )

    assert scan.dispatched == []


def test_timeout_minutes_override_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _NOW - timedelta(minutes=20))},
        timeout_minutes=10,
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_read_state_called_once_with_all_candidates(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.read_calls == [(TARGET_REPO, [1, 2, 3])]


def test_no_candidates_dispatches_nothing(make_config):
    scan = _run_scan(make_config, listed=[], fingerprints={})

    assert scan.dispatched == []
    assert scan.fingerprinted == []
    assert scan.read_calls == [(TARGET_REPO, [])]


def test_poison_pill_isolates_pr_but_scan_still_raises(make_config, caplog):
    dispatched: list[tuple[int, str, str, str]] = []

    def boom_fingerprint(_client, number, _authorized):
        if number == 1:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[1\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1's fingerprint raises: it is skipped and recorded as failed, yet PR2 (SKIP, same
    # hash) and PR3 (never-reviewed) are still evaluated and healthy PR3 is dispatched
    # before the aggregate failure surfaces.
    assert [number for number, *_ in dispatched] == [3]
    assert "skipping PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_concurrent_fingerprint_failures_aggregate_sorted(make_config, caplog):
    dispatched: list[tuple[int, str, str, str]] = []

    def boom_fingerprint(_client, number, _authorized):
        if number in (1, 3):
            raise RuntimeError(f"fingerprint boom {number}")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"2 PR\(s\) failed during scan: \[1, 3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(3), _open_pr(1), _open_pr(2)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # Scanned in fetch order [3, 1, 2], so failed is collected as [3, 1]; the sorted(failed) in
    # the RuntimeError reorders that to ascending [1, 3] -- drop that sort and this match fails.
    # Healthy PR2 still dispatches before the aggregate failure surfaces.
    assert [number for number, *_ in dispatched] == [2]
    assert "skipping PR #1" in caplog.text
    assert "skipping PR #3" in caplog.text


def test_dispatch_failure_isolated_others_still_dispatched(make_config, caplog):
    attempted: list[int] = []

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref):
        attempted.append(number)
        if number == 2:
            raise RuntimeError("dispatch boom")

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"failed to dispatch 1 PR\(s\): \[2\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR2's dispatch raises but is isolated: every candidate's dispatch is still attempted, and the
    # failure only surfaces as the aggregate RuntimeError once the whole batch has been processed.
    assert attempted == [1, 2, 3]
    assert "failed to dispatch review for PR #2" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_all_dispatch_failures_all_attempted_then_raise(make_config, caplog):
    attempted: list[int] = []

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref):
        attempted.append(number)
        raise RuntimeError(f"dispatch boom {number}")

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"failed to dispatch 3 PR\(s\): \[1, 2, 3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # Even when every dispatch raises, all three are attempted and collected into the single
    # aggregate RuntimeError -- one bad PR never stalls the rest.
    assert attempted == [1, 2, 3]


def test_dispatch_iteration_timeout_propagates_and_halts(make_config):
    attempted: list[int] = []

    def timeout_dispatch(_client, number, _head_sha, _eval_hash, _ref):
        attempted.append(number)
        if number == 1:
            raise IterationTimeout("iteration exceeded")

    with pytest.raises(IterationTimeout):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            dispatch=timeout_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # IterationTimeout is the soft per-iteration control signal, not a dispatch failure: it must
    # propagate immediately past the bare-Exception arm, halting the loop so PR2 and PR3 are never
    # attempted and PR1 is never collected as a dispatch failure.
    assert attempted == [1]


def test_fingerprint_and_dispatch_failures_surface_together(make_config, caplog):
    attempted: list[int] = []

    def boom_fingerprint(_client, number, _authorized):
        if number == 1:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref):
        attempted.append(number)
        if number == 2:
            raise RuntimeError("dispatch boom")

    with caplog.at_level(logging.ERROR, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1 fails fingerprinting and PR2 fails dispatch: a single end-of-scan RuntimeError surfaces
    # both failure classes distinctly, and healthy PR3 still dispatches.
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [1]" in message
    assert "failed to dispatch 1 PR(s): [2]" in message
    assert attempted == [2, 3]


def test_scan_larger_than_worker_pool_fingerprints_every_pr(make_config):
    numbers = list(range(1, review._FINGERPRINT_WORKERS + 5))
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={n: (f"headsha{n}", _HASH_A) for n in numbers},
    )

    # More tasks than workers must all run with none dropped; worker threads append in
    # nondeterministic order, so the fingerprinted set is compared rather than its order.
    assert sorted(scan.fingerprinted) == numbers
    assert [number for number, *_ in scan.dispatched] == numbers


def test_fingerprints_run_concurrently_across_workers(make_config):
    # Fill the pool to prove full concurrency, but demand >=2 parties even if the pool is
    # shrunk to 1: a 1-party barrier is satisfied by a single serial task and proves nothing.
    k = max(2, review._FINGERPRINT_WORKERS)
    numbers = list(range(1, k + 1))
    barrier = threading.Barrier(k, timeout=5)
    dispatched: list[int] = []

    def barrier_fingerprint(_client, number, _authorized):
        barrier.wait()
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append(number)

    review.run(
        make_config(github_token="t"),
        build_github=lambda _token: _CLIENT,
        fetch=lambda _client: [_open_pr(n) for n in numbers],
        fingerprint=barrier_fingerprint,
        read_state=lambda _repo, _numbers: {},
        dispatch=fake_dispatch,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    # Every task blocks on the k-party barrier before returning, so only genuine concurrency
    # (k workers running at once) lets all parties arrive and release. Serial execution would
    # leave the barrier short, time out into BrokenBarrierError, and raise RuntimeError here.
    assert sorted(dispatched) == numbers


def test_worker_clients_are_isolated_and_exclude_main_client(make_config):
    # Force >=2 tasks in flight at once (see the concurrency test): isolation is only
    # meaningful when multiple borrowed clients are held simultaneously.
    k = max(2, review._FINGERPRINT_WORKERS)
    numbers = list(range(1, k + 1))
    barrier = threading.Barrier(k, timeout=5)
    built: list[object] = []

    def factory(_token):
        client = object()
        built.append(client)
        return cast("Github", client)

    seen: dict[int, object] = {}

    def recording_fingerprint(client, number, _authorized):
        seen[number] = client
        barrier.wait()
        return (f"headsha{number}", _HASH_A)

    dispatched: list[int] = []

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append(number)

    review.run(
        make_config(github_token="t"),
        build_github=factory,
        fetch=lambda _client: [_open_pr(n) for n in numbers],
        fingerprint=recording_fingerprint,
        read_state=lambda _repo, _numbers: {},
        dispatch=fake_dispatch,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    main_client = built[0]
    worker_clients = set(built[1:])
    passed = set(seen.values())
    # The barrier holds all k tasks in-flight at once, so each must be holding a different
    # borrowed client -- proving per-task isolation. The main client drives fetch/dispatch
    # only and must never reach a worker, or the shared-client data race would be back.
    assert passed <= worker_clients
    assert main_client not in passed
    assert len(passed) > 1
    assert sorted(dispatched) == numbers


def test_run_closes_main_and_worker_clients(make_config):
    class _Closeable:
        def __init__(self) -> None:
            self.closed = 0

        def close(self) -> None:
            self.closed += 1

    built: list[_Closeable] = []

    def factory(_token):
        client = _Closeable()
        built.append(client)
        return cast("Github", client)

    review.run(
        make_config(github_token="t"),
        build_github=factory,
        fetch=lambda _client: [_open_pr(1), _open_pr(2)],
        fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
        read_state=lambda _repo, _numbers: {},
        dispatch=lambda *_args: None,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    # main client + min(_FINGERPRINT_WORKERS, 2 PRs) = 2 worker clients are all built, and
    # each is closed exactly once as the scan unwinds -- the connection pools are not leaked.
    assert len(built) == 3
    assert all(client.closed == 1 for client in built)


def test_close_client_swallows_close_errors(caplog):
    class _Boom:
        def close(self) -> None:
            raise RuntimeError("close boom")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        review._close_client(cast("Github", _Boom()))

    # A failing close must never raise, so it cannot mask the scan's real outcome; it is
    # logged with exc_info instead.
    assert "failed to close GitHub client" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_fingerprint_task_returns_client_on_exception():
    pool: queue.Queue[Github] = queue.Queue()
    client = cast("Github", object())
    pool.put(client)

    def boom(_client, _number, _authorized):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        review._fingerprint_task(boom, pool, 1, _AUTHORIZED)

    # The borrowed client must return to the pool even when fingerprint raises; otherwise a scan
    # with more PRs than workers drains the pool and queue.get blocks the scan forever.
    assert pool.get_nowait() is client


def test_fetch_failure_still_closes_main_client(make_config):
    client = Mock()

    def boom_fetch(_client):
        raise RuntimeError("fetch boom")

    with pytest.raises(RuntimeError, match="fetch boom"):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: cast("Github", client),
            fetch=boom_fetch,
            fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            dispatch=lambda *_args: None,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # fetch raises after the main client is built but before any worker exists; the ExitStack must
    # still close it as it unwinds, or every early failure leaks the client's connection pool.
    client.close.assert_called_once()


def test_deferred_dispatch_is_logged(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run_scan(
            make_config,
            listed=[_open_pr(1), _open_pr(2)],
            fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
            max_dispatches=1,
        )

    assert "dispatched review for PR #" in caplog.text
    assert "deferred PR #" in caplog.text
    assert "--max cap reached" in caplog.text


def test_listing_path_logs_open_prs_and_decisions(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run_scan(
            make_config,
            listed=[_open_pr(1), _open_pr(2)],
            fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
            states={2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
        )

    messages = caplog.text
    assert "found 2 open PR(s)" in messages
    assert "open PR #1 by albanD" in messages
    assert "PR #1: DISPATCH (never_reviewed)" in messages
    assert "PR #2: SKIP (decided)" in messages


def test_run_without_token_raises(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        review.run(make_config(github_token=None), resolve_authorized=lambda: _AUTHORIZED)


def test_run_missing_token_does_not_resolve_authorized(make_config):
    resolved: list[int] = []

    def counting_resolve() -> frozenset[str]:
        resolved.append(1)
        return _AUTHORIZED

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        review.run(make_config(github_token=None), resolve_authorized=counting_resolve)

    # The token check precedes authorization resolution, so a tokenless scan never builds an
    # authz client -- it fails fast on the cheaper local check.
    assert resolved == []


def test_run_cold_authorized_failure_propagates(make_config):
    def boom_resolve() -> frozenset[str]:
        raise RuntimeError("merge_rules unreachable")

    # A cold resolver failure must propagate out of run() (the daemon backs off, the one-shot exits
    # non-zero); run never falls back to hashing all human comments.
    with pytest.raises(RuntimeError, match="merge_rules unreachable"):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1)],
            fingerprint=lambda _client, number, _authorized: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            dispatch=lambda *_args: None,
            resolve_authorized=boom_resolve,
            now=lambda: _NOW,
        )


def test_run_resolves_authorized_once_and_threads_to_fingerprints(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        authorized=frozenset({"alice", "bob"}),
    )

    # The resolver is called exactly once per scan (not once per PR), and that one resolved set is
    # threaded into every fingerprint call.
    assert scan.resolver_calls == 1
    assert scan.authorized_seen == [frozenset({"alice", "bob"})] * 3


def test_default_fetch_forwards_to_list_open_prs(monkeypatch):
    captured: dict[str, object] = {}
    expected = [_open_pr(1)]

    def fake_list(client, repo, authors):
        captured["client"] = client
        captured["repo"] = repo
        captured["authors"] = set(authors)
        return expected

    monkeypatch.setattr(github_client, "list_open_prs_by_authors", fake_list)

    result = review._default_fetch(_CLIENT)

    assert result is expected
    assert captured["client"] is _CLIENT
    assert captured["repo"] == TARGET_REPO
    assert captured["authors"] == review.TRUSTED_AUTHORS


def test_default_fingerprint_forwards_to_fingerprint_pr(monkeypatch):
    captured: dict[str, object] = {}

    def fake_fingerprint_pr(client, repo, pr_number, *, authorized_logins):
        captured["client"] = client
        captured["repo"] = repo
        captured["pr_number"] = pr_number
        captured["authorized_logins"] = authorized_logins
        return ("headsha", _HASH_A)

    monkeypatch.setattr(github_client, "fingerprint_pr", fake_fingerprint_pr)

    result = review._default_fingerprint(_CLIENT, 7, _AUTHORIZED)

    assert result == ("headsha", _HASH_A)
    assert captured["client"] is _CLIENT
    assert captured["repo"] == TARGET_REPO
    assert captured["pr_number"] == 7
    assert captured["authorized_logins"] is _AUTHORIZED


def test_utcnow_is_naive_utc():
    now = review._utcnow()

    assert now.tzinfo is None
