from __future__ import annotations

import logging
from datetime import datetime, timedelta

import pytest

from greenlight.constants import FINGERPRINT_QUIET
from greenlight.review_gate import CHANGES_REQUESTED, ReviewSkip
from greenlight.scan_memory import FingerprintCache, ScanMemory

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
