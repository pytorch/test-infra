from __future__ import annotations

import hashlib
import json
import logging
import zlib
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

import pytest

from greenlight import scan_memory
from greenlight.backing_memory import BackingKey, BackingMemory
from greenlight.change_feed import Marker
from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE
from greenlight.drain_pass import DrainPass
from greenlight.fingerprint_cache import FingerprintCache
from greenlight.review_gate import CHANGES_REQUESTED, ReviewSkip
from greenlight.scan_memory import MEMORY_VERSION, ScanMemory, decode_memory, encode_memory
from tests.change_helpers import RECENT, record

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


def _three(memory: ScanMemory, *, reuse: bool = True) -> FingerprintCache:
    """A tick that listed PRs 1 to 3, each at head ``h<n>``."""
    return FingerprintCache(
        memory,
        reuse=reuse,
        authorized_logins=_LOGINS,
        updated_at=dict.fromkeys((1, 2, 3), _UPDATED),
        head_sha={1: "h1", 2: "h2", 3: "h3"},
        now=_STARTED,
    )


def _three_cached() -> ScanMemory:
    memory = ScanMemory()
    seed = _three(memory, reuse=False)
    for number in (1, 2, 3):
        seed.store(number, (f"h{number}", "a" * 64))
    seed.commit()
    return memory


def test_a_commit_keeps_only_the_results_its_tick_reused_or_stored():
    memory = _three_cached()
    current = _three(memory)

    # PR1 is reused, PR2 is fingerprinted afresh, and PR3 is not evaluated this tick.
    assert current.lookup(1) == ("h1", "a" * 64)
    current.keep(1)
    current.store(2, ("h2", "b" * 64))
    current.commit()

    after = _three(memory)
    assert after.lookup(1) == ("h1", "a" * 64)
    assert after.lookup(2) == ("h2", "b" * 64)
    assert after.lookup(3) is None


def test_a_partial_commit_also_keeps_the_earlier_results_of_the_prs_its_tick_never_looked_up():
    memory = _three_cached()
    current = _three(memory)

    # PR1 is reused, PR2 is looked up but its fresh fingerprint never comes, and PR3 is never looked up.
    current.lookup(1)
    current.keep(1)
    current.lookup(2)
    current.commit(partial=True)

    after = _three(memory)
    assert after.lookup(1) == ("h1", "a" * 64)
    assert after.lookup(2) is None
    assert after.lookup(3) == ("h3", "a" * 64)


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

    first = memory.start_drain_pass(None)
    assert memory.drain_pass() is first
    assert (first.number, first.blocker, first.checked, first.attempted) == (1, None, set(), {})
    memory.end_drain_pass()
    assert memory.drain_pass() is None

    second = memory.start_drain_pass("runs unfinished")
    assert (second.number, second.blocker) == (2, "runs unfinished")
    memory.clear_drain()
    assert memory.drain_pass() is None


def test_a_completed_drain_is_remembered_until_clear_drain():
    memory = ScanMemory()
    assert memory.drain_completed_by() is None

    memory.complete_drain(3)
    assert memory.drain_completed_by() == 3
    memory.clear_drain()
    assert memory.drain_completed_by() is None


def test_a_drain_pass_orders_unattempted_prs_recorded_first_then_attempted_ones_oldest_attempt_first():
    current = ScanMemory().start_drain_pass(None, recorded=frozenset({6, 9}))
    current.attempt(2)
    current.attempt(9)
    current.attempt(4)
    current.attempt(2)
    current.checked.add(4)

    assert current.pending([1, 2, 3, 4, 5, 6, 7, 8, 9]) == [6, 1, 3, 5, 7, 8, 9, 2]
    assert current.attempted == {2: 4, 9: 2, 4: 3}
    assert current.attempts == 4


def test_a_checked_pr_is_never_pending_again_in_its_pass():
    current = ScanMemory().start_drain_pass(None)
    current.attempt(1)
    current.checked.add(1)

    assert current.pending([1]) == []
    assert current.pending([1, 2]) == [2]


def test_a_pass_has_no_blocker_unless_given_one():
    assert DrainPass(1).blocker is None


def test_a_cold_memory_has_an_empty_backing_slot():
    backing = ScanMemory().backing

    assert backing == BackingMemory()
    assert (backing.keys, backing.checked_at, backing.waiting) == ({}, None, frozenset())
    assert (backing.sweep, backing.sweep_started_at, backing.sweeps, backing.decode_error) == (None, None, 0, None)


def test_clearing_the_drain_never_touches_the_backing_slot():
    memory = ScanMemory()
    backing = memory.backing
    sweep = backing.start_sweep(_STARTED, recorded=frozenset({1}))
    backing.waiting = frozenset({2})

    memory.clear_drain()

    assert memory.backing is backing
    assert (backing.sweep, backing.sweep_started_at, backing.sweeps, backing.waiting) == (
        sweep,
        _STARTED,
        1,
        frozenset({2}),
    )


def test_clearing_the_backing_check_starts_it_cold_and_leaves_the_drain():
    memory = ScanMemory()
    memory.off_since(_STARTED)
    current = memory.start_drain_pass(None)
    _with_backing(memory)

    memory.clear_backing()

    assert memory.backing == BackingMemory()
    assert (memory.drain_pass(), memory.off_since(_STARTED + timedelta(hours=1))) == (current, _STARTED)


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


def test_a_landed_prs_result_stored_after_the_clock_misses():
    memory = _marker_cached()
    earlier = _STARTED - timedelta(microseconds=1)

    # The clock stepped back past the time the result was stored: its age is unknown, so it has expired.
    assert _marker_tick(memory, revalidate=frozenset({1}), now=earlier).lookup(1) is None
    assert _marker_tick(memory, revalidate=frozenset({1}), now=_STARTED).lookup(1) == _RESULT
    assert _marker_tick(memory, now=earlier).lookup(1) == _RESULT


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
    memory.view.rebuild([], _STARTED, frozenset())
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


_REPO = "pytorch/vision"
_VIEW_MARKER = Marker(
    pr_updated_at=_UPDATED, reviews=1, review_comments=2, comments=3, comment_updated_at=_UPDATED + timedelta(seconds=1)
)


def _view_record(number: int, base_ref: str, head_ref: str, stack_trunk: str | None, **fields: Any) -> Any:
    return replace(record(number, **fields), repo=_REPO, base_ref=base_ref, head_ref=head_ref, stack_trunk=stack_trunk)


def _full_memory() -> ScanMemory:
    memory = _cached()
    skip = FingerprintCache(
        memory,
        reuse=True,
        authorized_logins=_LOGINS,
        updated_at={1: _UPDATED, 2: _UPDATED},
        head_sha={1: "headsha1", 2: "headsha2"},
        now=_STARTED + timedelta(minutes=1),
        markers={2: (_VIEW_MARKER, _STARTED - FINGERPRINT_QUIET)},
    )
    skip.keep(1)
    skip.store(2, ReviewSkip(CHANGES_REQUESTED, "changes requested by bob"))
    skip.commit()
    memory.mark_full_tick(_STARTED)
    memory.mark_wide_tick(_STARTED + timedelta(minutes=15))
    memory.full_tick_interval = timedelta(hours=4)
    memory.view.rebuild(
        [
            _view_record(5, "main", "alice/fix", None, labels=("Stale", "ci-no-td")),
            _view_record(6, "alice/part-1", "alice/part-2", "main", draft=True, updated_at=None),
            replace(_view_record(7, "release/2.9", "alice/backport", None), base_accepted=False),
        ],
        _STARTED,
        ["Alice"],
    )
    memory.view.note({5: _VIEW_MARKER, 6: Marker()}, _STARTED - timedelta(minutes=3))
    memory.view.record_read(5, _UPDATED, caught_up=False)
    memory.view.record_read(6, _UPDATED, caught_up=True)
    memory.off_since(_STARTED - timedelta(hours=1))
    current = memory.start_drain_pass("2 run(s) unfinished", recorded=frozenset({7, 3}))
    current.attempt(3)
    current.attempt(9)
    current.checked.add(3)
    current.dismissed, current.failures = 1, 1
    memory.complete_drain(4)
    return memory


def _with_backing(memory: ScanMemory) -> ScanMemory:
    backing = memory.backing
    backing.keys = {
        5: BackingKey(_UPDATED, "headsha5", "main", ("LAND", 9, _STARTED - timedelta(minutes=2)), True),
        6: BackingKey(None, "headsha6", "release/2.9", None, None),
    }
    backing.checked_at = _STARTED
    backing.waiting = frozenset({6})
    backing.attempt(6)
    sweep = backing.start_sweep(_STARTED - timedelta(minutes=4), recorded=frozenset({5}))
    sweep.attempt(5)
    sweep.checked.add(5)
    return memory


def test_the_memory_codec_round_trips_every_part_of_the_memory():
    memory = _full_memory()

    restored = decode_memory(encode_memory(memory, _REPO), _REPO)

    assert restored._last_full_tick_started == memory._last_full_tick_started
    assert restored._last_wide_tick_started == _STARTED + timedelta(minutes=15)
    assert restored.full_tick_interval == timedelta(hours=4)
    assert restored.fingerprints == memory.fingerprints
    assert {number: (entry.key.marker, entry.stored_at) for number, entry in restored.fingerprints.items()} == {
        1: (None, _STARTED),
        2: (_VIEW_MARKER, _STARTED + timedelta(minutes=1)),
    }
    assert restored._off_since == memory._off_since
    assert restored._drain_passes == memory._drain_passes == 1
    assert restored._drain_pass == memory._drain_pass
    assert restored.drain_completed_by() == 4
    assert _tick(restored).lookup(1) == _RESULT


def test_the_memory_codec_round_trips_the_backing_memory_with_the_rest():
    memory = _with_backing(_full_memory())

    restored = decode_memory(encode_memory(memory, _REPO), _REPO)

    assert restored.backing == memory.backing
    assert restored.backing.sweep_started_at == _STARTED - timedelta(minutes=4)
    assert (restored.backing.attempted, restored.backing.attempts) == ({6: 1}, 1)
    assert restored.fingerprints == memory.fingerprints
    assert restored.view.to_form() == memory.view.to_form()
    assert (restored.drain_pass(), restored.drain_completed_by()) == (memory.drain_pass(), 4)


def test_a_cold_backing_memory_is_not_stored():
    form = json.loads(zlib.decompress(encode_memory(_full_memory(), _REPO)))

    assert "backing" not in form
    assert decode_memory(encode_memory(_full_memory(), _REPO), _REPO).backing == BackingMemory()


def test_the_memory_codec_round_trips_the_view():
    memory = _full_memory()

    view = decode_memory(encode_memory(memory, _REPO), _REPO).view

    assert (view.listed_at, view.digest) == (_STARTED, memory.view.digest)
    assert view.usable(["alice"])
    # Title and URL are not stored: a restored record has none of the first and GitHub's form of the second.
    assert view.records == {
        number: replace(original, title="", url=f"https://github.com/{_REPO}/pull/{number}")
        for number, original in memory.view.records.items()
    }
    assert [view.records[number].base_accepted for number in (5, 6, 7)] == [True, True, False]
    assert view.seen(5) == (_VIEW_MARKER, _STARTED - timedelta(minutes=3))
    assert view.seen(6) == (Marker(), _STARTED - timedelta(minutes=3))
    assert view.pending_reads({5: _UPDATED, 6: _UPDATED}) == [5]
    assert view.to_form() == memory.view.to_form()
    assert view.to_form()["read_sequence"] == 2


def test_a_cold_memory_round_trips_cold():
    restored = decode_memory(encode_memory(ScanMemory(), _REPO), _REPO)

    assert restored.full_tick_due(_STARTED)
    assert restored.fingerprints == {}
    assert restored.drain_pass() is None
    assert not restored.view.built
    assert restored.full_tick_interval == FULL_TICK_INTERVAL


def test_the_stored_form_is_versioned_compressed_json_with_the_approvers_digest_once():
    form = json.loads(zlib.decompress(encode_memory(_full_memory(), _REPO)))

    assert form["version"] == MEMORY_VERSION == 3
    assert len(form["digests"]) == 1
    assert form["fingerprints"] == [
        [1, _UPDATED.isoformat(), "headsha1", 0, {"hash": list(_RESULT)}, None, _STARTED.isoformat()],
        [
            2,
            _UPDATED.isoformat(),
            "headsha2",
            0,
            {"skip": [CHANGES_REQUESTED, "changes requested by bob"]},
            [_UPDATED.isoformat(), 1, 2, 3, (_UPDATED + timedelta(seconds=1)).isoformat()],
            (_STARTED + timedelta(minutes=1)).isoformat(),
        ],
    ]
    assert form["last_wide_tick_started"] == (_STARTED + timedelta(minutes=15)).isoformat()
    assert form["full_tick_interval"] == 4 * 3600
    assert form["view"]["records"][0] == [
        5,
        "alice",
        "sha5",
        RECENT.isoformat(),
        ["Stale", "ci-no-td"],
        False,
        "main",
        "alice/fix",
        None,
    ]


def _version_two_blob() -> bytes:
    """A memory as the previous version stored it: no wide start, interval or view, fingerprint rows of five."""
    digest = hashlib.sha256("\n".join(sorted(_LOGINS)).encode()).hexdigest()
    form = {
        "version": 2,
        "last_full_tick_started": _STARTED.isoformat(),
        "digests": [digest],
        "fingerprints": [
            [1, _UPDATED.isoformat(), "headsha1", 0, {"hash": list(_RESULT)}],
            [2, _UPDATED.isoformat(), "headsha2", 0, {"skip": [CHANGES_REQUESTED, "changes requested by bob"]}],
        ],
        "off_since": (_STARTED - timedelta(hours=1)).isoformat(),
        "drain_passes": 1,
        "drain_pass": {
            "number": 1,
            "blocker": "2 run(s) unfinished",
            "recorded": [3, 7],
            "checked": [3],
            "attempted": [[3, 1], [9, 2]],
            "attempts": 2,
            "dismissed": 1,
            "failures": 1,
        },
        "drain_completed_by": 4,
    }
    return zlib.compress(json.dumps(form).encode())


def test_a_version_two_memory_is_read_forward_without_a_view():
    restored = decode_memory(_version_two_blob(), _REPO)

    assert restored._last_full_tick_started == _STARTED
    assert restored._last_wide_tick_started is None
    assert restored.full_tick_interval == FULL_TICK_INTERVAL
    assert not restored.view.built
    assert restored._off_since == _STARTED - timedelta(hours=1)
    assert restored.drain_pass() == DrainPass(
        1, "2 run(s) unfinished", frozenset({3, 7}), {3}, {3: 1, 9: 2}, attempts=2, dismissed=1, failures=1
    )
    assert restored.drain_completed_by() == 4
    assert {number: (entry.key.marker, entry.stored_at) for number, entry in restored.fingerprints.items()} == {
        1: (None, datetime(1970, 1, 1)),
        2: (None, datetime(1970, 1, 1)),
    }
    # A github repo reuses the results; a marker read misses them; a LAND revalidation finds them old.
    assert _tick(restored).lookup(1) == _RESULT
    assert _marker_tick(restored).lookup(1) is None
    assert _marker_tick(restored, markers={1: None}).lookup(1) == _RESULT
    assert _marker_tick(restored, markers={1: None}, revalidate=frozenset({1})).lookup(1) is None


def _backing_blob(backing: Any) -> bytes:
    form = json.loads(zlib.decompress(encode_memory(_with_backing(_full_memory()), _REPO)))
    form["backing"] = backing
    return zlib.compress(json.dumps(form).encode())


def _kept_apart_from_its_backing(restored: ScanMemory) -> None:
    memory = _full_memory()
    assert restored.fingerprints == memory.fingerprints
    assert restored.view.to_form() == memory.view.to_form()
    assert (restored.drain_pass(), restored.drain_completed_by()) == (memory.drain_pass(), 4)


@pytest.mark.parametrize("version", [0, 2, True, None])
def test_another_backing_version_starts_the_backing_memory_cold_alone(caplog, version):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        restored = decode_memory(_backing_blob({"version": version, "keys": "anything"}), _REPO)

    assert restored.backing == BackingMemory()
    assert restored.backing.decode_error is None
    _kept_apart_from_its_backing(restored)
    assert f"stored approval-backing memory has version {version!r}, not 1; starting it cold" in caplog.text
    assert [record for record in caplog.records if record.levelno >= logging.ERROR] == []


def _broken_backing(**changes: Any) -> dict[str, Any]:
    form: dict[str, Any] = json.loads(zlib.decompress(encode_memory(_with_backing(_full_memory()), _REPO)))["backing"]
    form.update(changes)
    return form


@pytest.mark.parametrize(
    "backing",
    [
        ["not", "an", "object"],
        {"version": 1},
        _broken_backing(keys=[[5, None, "headsha5", "main"]]),
        _broken_backing(keys=[[5, None, "headsha5", "main", None, "yes"]]),
        _broken_backing(keys=[[5, None, None, "main", None, True]]),
        _broken_backing(keys=[[5, None, "headsha5", "main", ["LAND", 9, None], True]]),
        _broken_backing(sweep_started_at=None),
        _broken_backing(waiting=["6"]),
    ],
    ids=[
        "not-an-object",
        "missing-parts",
        "a-short-key",
        "a-rules-state-not-a-bool",
        "a-key-without-its-head",
        "a-gate-row-without-its-version",
        "a-sweep-without-its-start",
        "a-waiting-pr-not-a-number",
    ],
)
def test_a_backing_memory_that_does_not_decode_starts_cold_alone_and_is_noted(caplog, backing):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        restored = decode_memory(_backing_blob(backing), _REPO)

    assert restored.backing.keys == {}
    assert restored.backing.sweep is None
    assert restored.backing.decode_error is not None
    assert restored.backing.decode_error.startswith("its stored approval-backing memory did not decode (")
    assert restored.backing.decode_error.endswith("); it started cold")
    _kept_apart_from_its_backing(restored)
    [record] = [r for r in caplog.records if "cannot decode its stored approval-backing memory" in r.getMessage()]
    assert record.exc_info
    assert "cannot decode its stored scan memory" not in caplog.text


def test_a_noted_decode_error_is_stored_until_a_report_carries_it():
    restored = decode_memory(_backing_blob({"version": 1}), _REPO)

    again = decode_memory(encode_memory(restored, _REPO), _REPO)

    assert again.backing.decode_error == restored.backing.decode_error


def test_no_memory_starts_cold():
    assert decode_memory(None, _REPO).fingerprints == {}


@pytest.mark.parametrize("version", [1, 4, 99, None])
def test_another_version_starts_cold(caplog, version):
    blob = zlib.compress(json.dumps({"version": version, "last_settings": None}).encode())

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        restored = decode_memory(blob, _REPO)

    assert restored.full_tick_due(_STARTED)
    assert f"stored scan memory has version {version!r}, not 3; starting cold" in caplog.text


def _with(**changes: Any) -> bytes:
    form = json.loads(zlib.decompress(encode_memory(_full_memory(), _REPO)))
    for path, value in changes.items():
        *parents, leaf = path.split("__")
        node = form
        for part in parents:
            node = node[part]
        node[leaf] = value
    return zlib.compress(json.dumps(form).encode())


@pytest.mark.parametrize(
    "blob",
    [
        b"not zlib",
        zlib.compress(b"not json"),
        zlib.compress(json.dumps({"version": MEMORY_VERSION}).encode()),
        zlib.compress(json.dumps({"version": 2}).encode()),
        _with(fingerprints=[[1, _UPDATED.isoformat(), "headsha1", 0, {"hash": list(_RESULT)}]]),
        _with(fingerprints=[[1, None, "headsha1", 0, {"hash": list(_RESULT)}, None, _STARTED.isoformat()]]),
        _with(view__records=[[5, "alice"]]),
        _with(view__markers=[[5, [None, 0, 0], _STARTED.isoformat()]]),
        _with(view__reads=[[5, None, 1, 1, False]]),
        _with(full_tick_interval="four hours"),
    ],
    ids=[
        "not-zlib",
        "not-json",
        "missing-parts",
        "version-two-missing-parts",
        "a-fingerprint-row-of-the-previous-version",
        "a-fingerprint-without-its-update",
        "a-short-record",
        "a-short-marker",
        "a-read-without-its-time",
        "a-bad-interval",
    ],
)
def test_a_blob_that_does_not_decode_starts_cold_and_logs_the_error(caplog, blob):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        restored = decode_memory(blob, _REPO)

    assert restored.fingerprints == {}
    assert not restored.view.built
    [record] = [record for record in caplog.records if "cannot decode its stored scan memory" in record.getMessage()]
    assert record.exc_info


def _size(memory: ScanMemory, *, fingerprints: bool, view: bool) -> int:
    return len(scan_memory._compress(scan_memory._form(memory, fingerprints=fingerprints, view=view)))


def test_a_memory_over_the_size_cap_is_saved_without_its_fingerprints(monkeypatch, caplog):
    memory = _full_memory()
    monkeypatch.setattr(scan_memory, "MEMORY_MAX_BYTES", _size(memory, fingerprints=False, view=True))

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        restored = decode_memory(encode_memory(memory, _REPO), _REPO)

    assert restored.fingerprints == {}
    assert restored.view.to_form() == memory.view.to_form()
    assert restored.drain_completed_by() == 4
    assert restored._last_full_tick_started == _STARTED
    assert "saved without its 2 fingerprint result(s)" in caplog.text
    assert "view" not in caplog.text


def test_a_memory_still_over_the_size_cap_without_its_fingerprints_is_saved_without_its_view_too(monkeypatch, caplog):
    memory = _with_backing(_full_memory())
    full = _size(memory, fingerprints=True, view=True)
    without_fingerprints = _size(memory, fingerprints=False, view=True)
    smallest = _size(memory, fingerprints=False, view=False)
    monkeypatch.setattr(scan_memory, "MEMORY_MAX_BYTES", without_fingerprints - 1)

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        blob = encode_memory(memory, _REPO)
    restored = decode_memory(blob, _REPO)

    assert len(blob) == smallest
    assert restored.fingerprints == {}
    assert not restored.view.built
    assert restored.drain_completed_by() == 4
    assert restored.backing == memory.backing
    assert restored._last_wide_tick_started == _STARTED + timedelta(minutes=15)
    assert f"its scan memory is {full} bytes, over {without_fingerprints - 1}; saved without its 2 fingerprint" in (
        caplog.text
    )
    assert (
        f"still {without_fingerprints} bytes without its fingerprint results, over {without_fingerprints - 1}; "
        f"saved without its view of 3 PR(s) too, in {smallest} bytes"
    ) in caplog.text
    # With no view the repo's next tick cannot be a wide one, and its sweep still counts from the last full tick.
    assert not restored.full_tick_due(_STARTED + timedelta(minutes=30))


def test_a_memory_over_the_size_cap_in_its_smallest_form_is_still_encoded(monkeypatch):
    memory = _with_backing(_full_memory())
    monkeypatch.setattr(scan_memory, "MEMORY_MAX_BYTES", 0)

    restored = decode_memory(encode_memory(memory, _REPO), _REPO)

    assert restored.drain_completed_by() == 4
    assert restored.backing == memory.backing
    assert restored.fingerprints == {}
    assert not restored.view.built


def test_the_fingerprint_entries_are_read_only_outside_replace_fingerprints():
    memory = _cached()
    entries = dict(memory.fingerprints)

    with pytest.raises(TypeError):
        memory.fingerprints[2] = entries[1]  # type: ignore[index]
    memory.replace_fingerprints(entries)
    entries.clear()

    assert set(memory.fingerprints) == {1}
    assert _tick(memory).lookup(1) == _RESULT
