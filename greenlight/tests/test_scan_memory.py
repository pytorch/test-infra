from datetime import datetime, timedelta

from greenlight.scan_memory import ScanMemory

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
