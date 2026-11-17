from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import pytest

from greenlight.approvals import ReviewReader
from greenlight.change_feed import Marker
from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE
from greenlight.review_gate import CHANGES_REQUESTED, ReviewSkip
from greenlight.scan_memory import BackingMemory, DrainPass, FingerprintCache, ScanMemory

_STARTED = datetime(2026, 10, 13, 12, 0, 0)


def _marked() -> ScanMemory:
    memory = ScanMemory()
    memory.mark_full_tick(_STARTED)
    return memory


def test_a_cold_memory_is_due_a_full_tick():
    assert ScanMemory().full_tick_due(_STARTED)


def test_a_full_tick_is_not_due_fourteen_minutes_after_the_last_one_started():
    memory = _marked()

    assert not memory.full_tick_due(_STARTED)
    assert not memory.full_tick_due(_STARTED + timedelta(minutes=14))
    assert not memory.full_tick_due(_STARTED + timedelta(minutes=14, seconds=30) - timedelta(microseconds=1))


def test_a_tick_starting_just_under_fifteen_minutes_after_the_last_full_one_is_full():
    memory = _marked()

    # A tick scheduled 15 minutes on can start a fraction early; the tolerance still makes it full.
    assert memory.full_tick_due(_STARTED + timedelta(minutes=14, seconds=59.9))
    assert memory.full_tick_due(_STARTED + timedelta(minutes=14, seconds=30))
    assert memory.full_tick_due(_STARTED + timedelta(hours=3))


def test_a_clock_stepped_back_past_the_last_full_tick_makes_one_due():
    assert _marked().full_tick_due(_STARTED - timedelta(seconds=1))


def test_the_interval_counts_from_the_latest_full_tick_marked():
    memory = _marked()
    memory.mark_full_tick(_STARTED + timedelta(minutes=15))

    assert not memory.full_tick_due(_STARTED + timedelta(minutes=29))


_UPDATED = _STARTED - timedelta(minutes=5)
_LOGINS = frozenset({"alice", "bob"})
_RESULT = ("headsha1", "a" * 64)


def _tick(
    memory: ScanMemory,
    *,
    reuse: bool = True,
    updated_at: datetime | None = _UPDATED,
    head_sha: str | None = "headsha1",
    logins: frozenset[str] = _LOGINS,
) -> FingerprintCache:
    """A tick that listed PR1 with ``updated_at`` and ``head_sha``, with the clock read at ``_STARTED``."""
    return FingerprintCache(
        memory, reuse=reuse, authorized_logins=logins, updated_at={1: updated_at}, head_sha={1: head_sha}, now=_STARTED
    )


def _cached(
    result: tuple[str, str] | ReviewSkip = _RESULT,
    *,
    updated_at: datetime | None = _UPDATED,
    head_sha: str | None = "headsha1",
) -> ScanMemory:
    """A memory whose last tick fingerprinted PR1 as listed with ``updated_at`` and ``head_sha``."""
    memory = ScanMemory()
    tick = _tick(memory, reuse=False, updated_at=updated_at, head_sha=head_sha)
    tick.store(1, result)
    tick.commit()
    return memory


def test_a_pr_listed_as_it_was_when_its_fingerprint_was_stored_reuses_it():
    assert _tick(_cached()).lookup(1) == _RESULT


def test_a_human_decided_skip_is_reused_like_a_fingerprint():
    skip = ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")

    assert _tick(_cached(skip)).lookup(1) == skip


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"updated_at": _UPDATED + timedelta(seconds=1)}, id="updated-at"),
        pytest.param({"head_sha": "headsha2"}, id="head"),
        pytest.param({"head_sha": None}, id="no-head"),
        pytest.param({"logins": _LOGINS | {"carol"}}, id="approvers"),
    ],
)
def test_a_change_to_any_part_of_the_key_misses(change):
    assert _tick(_cached(), **change).lookup(1) is None


def test_a_fingerprint_read_at_a_head_pushed_after_the_listing_is_not_kept():
    memory = _cached(("headsha2", "a" * 64))

    # The listing showed headsha1 and the fetch read the pushed headsha2: the key would describe a head
    # the result was not read at, so nothing is kept under either head.
    assert _tick(memory).lookup(1) is None
    assert _tick(memory, head_sha="headsha2").lookup(1) is None


def test_a_fingerprint_from_a_read_that_lagged_the_listing_is_not_kept():
    memory = _cached(("headsha1", "a" * 64), head_sha="headsha2")

    # The listing showed headsha2 but the fetch still read headsha1. Kept, the result would match the
    # next listing of headsha2 and settle that head on headsha1's hash.
    assert _tick(memory, head_sha="headsha2").lookup(1) is None


def test_a_pr_listed_without_a_head_is_never_stored():
    skip = ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")

    # A human-decided skip carries no head for the store to compare, so only the missing listed head
    # keeps it out of the cache.
    assert _tick(_cached(skip, head_sha=None), head_sha=None).lookup(1) is None


def test_a_pr_listed_without_an_updated_at_is_never_stored():
    assert _tick(_cached(updated_at=None), updated_at=None).lookup(1) is None


def test_a_fingerprint_is_stored_only_once_its_pr_has_gone_quiet():
    quiet = _STARTED - FINGERPRINT_QUIET
    young = quiet + timedelta(microseconds=1)

    assert _tick(_cached(updated_at=quiet), updated_at=quiet).lookup(1) == _RESULT
    assert _tick(_cached(updated_at=young), updated_at=young).lookup(1) is None


def test_a_full_tick_never_reads_the_cache_but_refreshes_it():
    memory = _cached()
    full = _tick(memory, reuse=False)
    refreshed = ("headsha1", "b" * 64)

    assert full.lookup(1) is None
    full.store(1, refreshed)
    full.commit()

    assert _tick(memory).lookup(1) == refreshed


def test_a_commit_keeps_only_the_results_its_tick_reused_or_stored():
    memory = ScanMemory()

    def tick(*, reuse: bool) -> FingerprintCache:
        return FingerprintCache(
            memory,
            reuse=reuse,
            authorized_logins=_LOGINS,
            updated_at=dict.fromkeys((1, 2, 3), _UPDATED),
            head_sha={1: "h1", 2: "h2", 3: "h3"},
            now=_STARTED,
        )

    seed = tick(reuse=False)
    for number in (1, 2, 3):
        seed.store(number, (f"h{number}", "a" * 64))
    seed.commit()
    current = tick(reuse=True)

    # PR1 is reused, PR2 is fingerprinted afresh, and PR3 is not evaluated this tick.
    assert current.lookup(1) == ("h1", "a" * 64)
    current.keep(1)
    current.store(2, ("h2", "b" * 64))
    current.commit()

    after = tick(reuse=True)
    assert after.lookup(1) == ("h1", "a" * 64)
    assert after.lookup(2) == ("h2", "b" * 64)
    assert after.lookup(3) is None


def test_a_tick_that_never_commits_leaves_the_cache_as_it_was():
    memory = _cached()
    tick = _tick(memory)
    tick.store(1, ("headsha1", "b" * 64))

    assert _tick(memory).lookup(1) == _RESULT


def test_a_commit_logs_how_many_results_were_reused_and_fetched_fresh(caplog):
    tick = _tick(_cached())
    tick.keep(1)
    # A fresh result counts as fetched even when it is not kept: PR2 is not in this tick's listing.
    tick.store(2, ("headsha2", "a" * 64))

    with caplog.at_level(logging.INFO, logger="greenlight"):
        tick.commit()

    assert "fingerprints: 1 reused from the cache, 1 fetched fresh" in caplog.text


def test_off_since_is_the_first_time_the_repo_was_seen_off_until_the_drain_is_cleared():
    memory = ScanMemory()

    assert memory.off_since(_STARTED) == _STARTED
    assert memory.off_since(_STARTED + timedelta(hours=1)) == _STARTED
    memory.clear_drain()
    assert memory.off_since(_STARTED + timedelta(hours=2)) == _STARTED + timedelta(hours=2)


def test_drain_passes_are_numbered_and_end_or_clear_forgets_the_current_one():
    memory = ScanMemory()
    assert memory.drain_pass() is None

    first = memory.start_drain_pass(_STARTED, None)
    assert memory.drain_pass() is first
    assert (first.number, first.started_at, first.blocker, first.checked, first.attempted) == (
        1,
        _STARTED,
        None,
        set(),
        {},
    )
    memory.end_drain_pass()
    assert memory.drain_pass() is None

    second = memory.start_drain_pass(_STARTED, "runs unfinished")
    assert (second.number, second.blocker) == (2, "runs unfinished")
    memory.clear_drain()
    assert memory.drain_pass() is None


def test_a_pass_has_no_blocker_unless_given_one():
    assert DrainPass(1, _STARTED).blocker is None


def test_a_cold_memory_has_an_empty_backing_slot():
    backing = ScanMemory().backing

    assert backing == BackingMemory()
    assert (backing.reader, backing.sweep, backing.sweeps, backing.waiting) == (None, None, 0, frozenset())


def test_backing_sweeps_are_numbered_and_carry_their_start_and_recorded_prs():
    backing = BackingMemory()

    first = backing.start_sweep(_STARTED, recorded=frozenset({4}))
    assert backing.sweep is first
    assert (first.number, first.started_at, first.blocker, first.recorded) == (1, _STARTED, None, frozenset({4}))
    later = _STARTED + timedelta(minutes=16)
    second = backing.start_sweep(later, recorded=frozenset())
    assert (second.number, second.started_at, backing.sweep) == (2, later, second)


def test_clearing_the_drain_never_touches_the_backing_slot():
    memory = ScanMemory()
    backing = memory.backing
    backing.reader = ReviewReader(object())  # type: ignore[arg-type]
    sweep = backing.start_sweep(_STARTED, recorded=frozenset({1}))
    backing.waiting = frozenset({2})

    memory.clear_drain()

    assert memory.backing is backing
    assert (backing.sweep, backing.sweeps, backing.waiting) == (sweep, 1, frozenset({2}))
    assert backing.reader is not None


def test_a_drain_pass_orders_unattempted_prs_recorded_first_then_attempted_ones_oldest_attempt_first():
    current = ScanMemory().start_drain_pass(_STARTED, None, recorded=frozenset({6, 9}))
    current.attempt(2)
    current.attempt(9)
    current.attempt(4)
    current.attempt(2)
    current.checked.add(4)

    assert current.pending([1, 2, 3, 4, 5, 6, 7, 8, 9]) == [6, 1, 3, 5, 7, 8, 9, 2]
    assert current.attempted == {2: 4, 9: 2, 4: 3}
    assert current.attempts == 4


def test_a_checked_pr_is_never_pending_again_in_its_pass():
    current = ScanMemory().start_drain_pass(_STARTED, None)
    current.attempt(1)
    current.checked.add(1)

    assert current.pending([1]) == []
    assert current.pending([1, 2]) == [2]


_MARKER = Marker(reviews=1, comments=2)


def _seen(since: datetime = _STARTED - FINGERPRINT_QUIET, marker: Marker = _MARKER) -> dict[int, Any]:
    return {1: (marker, since)}


def _marker_tick(
    memory: ScanMemory,
    *,
    reuse: bool = True,
    markers: dict[int, Any] | None = None,
    revalidate: frozenset[int] = frozenset(),
    now: datetime = _STARTED,
) -> FingerprintCache:
    """A tick of a clickhouse repo that listed PR1 as ``_tick`` does, its marker read as ``markers``."""
    return FingerprintCache(
        memory,
        reuse=reuse,
        authorized_logins=_LOGINS,
        updated_at={1: _UPDATED},
        head_sha={1: "headsha1"},
        now=now,
        markers=_seen() if markers is None else markers,
        revalidate=revalidate,
    )


def _marker_cached(*, markers: dict[int, Any] | None = None, now: datetime = _STARTED) -> ScanMemory:
    memory = ScanMemory()
    tick = _marker_tick(memory, reuse=False, markers=markers, now=now)
    tick.store(1, _RESULT)
    tick.commit()
    return memory


def test_a_pr_whose_marker_is_unchanged_reuses_its_result():
    assert _marker_tick(_marker_cached()).lookup(1) == _RESULT


@pytest.mark.parametrize(
    "markers",
    [
        pytest.param(_seen(marker=Marker(reviews=2, comments=2)), id="a-dismissal-or-second-review"),
        pytest.param({1: None}, id="not-read"),
        pytest.param({2: (_MARKER, _STARTED)}, id="absent"),
    ],
)
def test_a_change_of_marker_misses(markers):
    assert _marker_tick(_marker_cached(), markers=markers).lookup(1) is None


def test_a_result_kept_without_a_marker_misses_once_the_marker_is_read():
    assert _marker_tick(_cached()).lookup(1) is None


def test_a_result_is_kept_only_once_the_process_has_seen_its_marker_for_the_quiet_period():
    young = _STARTED - FINGERPRINT_QUIET + timedelta(microseconds=1)

    assert _marker_tick(_marker_cached()).lookup(1) == _RESULT
    assert _marker_tick(_marker_cached(markers=_seen(young)), markers=_seen(young)).lookup(1) is None


@pytest.mark.parametrize(
    "markers", [pytest.param({1: None}, id="none"), pytest.param({2: (_MARKER, _STARTED)}, id="absent")]
)
def test_a_pr_with_no_marker_read_is_kept_under_none_on_its_updated_at_alone(markers):
    memory = _marker_cached(markers=markers)

    assert _marker_tick(memory, markers=markers).lookup(1) == _RESULT
    assert _tick(memory).lookup(1) == _RESULT
    assert _marker_tick(memory).lookup(1) is None


def test_a_landed_prs_result_is_reused_until_it_is_a_full_tick_interval_old():
    memory = _marker_cached()
    almost = _STARTED + FULL_TICK_INTERVAL - timedelta(microseconds=1)

    assert _marker_tick(memory, revalidate=frozenset({1}), now=almost).lookup(1) == _RESULT
    assert _marker_tick(memory, revalidate=frozenset({1}), now=_STARTED + FULL_TICK_INTERVAL).lookup(1) is None
    assert _marker_tick(memory, now=_STARTED + FULL_TICK_INTERVAL).lookup(1) == _RESULT


def test_keep_carries_a_result_forward_with_the_time_it_was_stored():
    memory = _marker_cached()
    later = _STARTED + timedelta(minutes=10)
    carried = _marker_tick(memory, now=later)
    assert carried.lookup(1) == _RESULT
    carried.keep(1)
    carried.commit()

    # Kept at 10 minutes, the result still dates from the tick that fetched it.
    assert _marker_tick(memory, revalidate=frozenset({1}), now=_STARTED + FULL_TICK_INTERVAL).lookup(1) is None


def _view_built(memory: ScanMemory) -> ScanMemory:
    memory.view.rebuild([], _STARTED)
    return memory


def test_the_sweep_follows_the_interval_the_tick_set():
    memory = _marked()
    memory.full_tick_interval = timedelta(hours=4)

    assert not memory.sweep_due(_STARTED + timedelta(hours=4) - FULL_TICK_TOLERANCE - timedelta(microseconds=1))
    assert memory.sweep_due(_STARTED + timedelta(hours=4) - FULL_TICK_TOLERANCE)
    assert memory.sweep_due(_STARTED - timedelta(seconds=1))
    assert ScanMemory().sweep_due(_STARTED)


def test_a_wide_tick_is_never_due_before_the_view_is_built():
    memory = ScanMemory()

    assert not memory.wide_due(_STARTED)
    assert memory.full_tick_due(_STARTED) is memory.sweep_due(_STARTED)


def test_a_wide_tick_is_due_a_full_tick_interval_after_the_later_full_or_wide_start():
    memory = _view_built(ScanMemory())
    memory.full_tick_interval = timedelta(hours=4)
    due = FULL_TICK_INTERVAL - FULL_TICK_TOLERANCE

    assert memory.wide_due(_STARTED)
    memory.mark_full_tick(_STARTED)
    assert not memory.wide_due(_STARTED + due - timedelta(microseconds=1))
    assert memory.wide_due(_STARTED + due)
    memory.mark_wide_tick(_STARTED + timedelta(minutes=15))
    assert not memory.wide_due(_STARTED + timedelta(minutes=15) + due - timedelta(microseconds=1))
    assert memory.wide_due(_STARTED + timedelta(minutes=15) + due)
    # A clock stepped back past the later start makes one due.
    assert memory.wide_due(_STARTED + timedelta(minutes=14))


def test_a_full_tick_is_due_for_tick_py_when_a_sweep_or_a_wide_tick_is():
    memory = _view_built(_marked())
    memory.full_tick_interval = timedelta(hours=4)

    assert not memory.full_tick_due(_STARTED + timedelta(minutes=10))
    assert memory.full_tick_due(_STARTED + timedelta(minutes=15))
    memory.mark_wide_tick(_STARTED + timedelta(minutes=15))
    assert not memory.full_tick_due(_STARTED + timedelta(minutes=20))
    assert memory.full_tick_due(_STARTED + timedelta(hours=4))
