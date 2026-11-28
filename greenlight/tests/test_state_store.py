from __future__ import annotations

import threading
from datetime import timedelta

import pytest

from greenlight import state_store
from greenlight.constants import RATE_LIMIT_LATCH_MAX
from greenlight.state_store import ConfigRecord, EligibilityKey, InProcessStore, LeaseLost, RepoItem, StoreError

_REPO = "pytorch/vision"
_MAX = RATE_LIMIT_LATCH_MAX.total_seconds()


def _save(store: InProcessStore, owner: str | None, now: float, *, tick: str | None = "t1") -> None:
    store.save_memory(_REPO, b"memory", owner=owner, now=now, tick=tick, drain_complete=True)


def test_a_repo_with_no_item_reads_empty_and_its_lease_is_free():
    item = InProcessStore().read_repo(_REPO)

    assert item == RepoItem(_REPO)
    assert item.lease_free(0.0)


def test_a_lease_is_taken_only_when_none_is_held_or_the_held_one_expired():
    store = InProcessStore()

    assert store.acquire_lease(_REPO, "a", expires=100.0, now=0.0)
    assert not store.acquire_lease(_REPO, "b", expires=150.0, now=50.0)
    assert store.read_repo(_REPO).lease_owner == "a"
    assert store.acquire_lease(_REPO, "b", expires=300.0, now=100.0)
    item = store.read_repo(_REPO)
    assert (item.lease_owner, item.lease_expires) == ("b", 300.0)


def test_two_holders_racing_for_a_lease_get_one_winner():
    store = InProcessStore()
    start = threading.Barrier(16)
    won: list[str] = []

    def race(owner: str) -> None:
        start.wait()
        if store.acquire_lease(_REPO, owner, expires=100.0, now=0.0):
            won.append(owner)

    threads = [threading.Thread(target=race, args=(f"o{index}",)) for index in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(won) == 1
    assert store.read_repo(_REPO).lease_owner == won[0]


def test_a_save_under_a_lease_needs_its_owner_and_an_unexpired_lease():
    store = InProcessStore()
    with pytest.raises(LeaseLost):
        _save(store, "a", 0.0)
    store.acquire_lease(_REPO, "a", expires=100.0, now=0.0)

    with pytest.raises(LeaseLost, match="the lease of b is gone"):
        _save(store, "b", 10.0)
    with pytest.raises(LeaseLost):
        _save(store, "a", 100.0)
    _save(store, "a", 99.0)

    item = store.read_repo(_REPO)
    assert (item.memory, item.last_tick, item.last_completed_at, item.drain_complete) == (b"memory", "t1", 99.0, True)
    assert issubclass(LeaseLost, StoreError)


def test_a_save_with_no_owner_takes_no_lease_and_without_a_tick_records_none():
    store = InProcessStore()

    _save(store, None, 5.0, tick=None)

    item = store.read_repo(_REPO)
    assert (item.memory, item.last_tick, item.last_completed_at, item.lease_owner) == (b"memory", None, None, None)


def test_a_release_clears_only_its_owners_lease():
    store = InProcessStore()
    store.acquire_lease(_REPO, "a", expires=100.0, now=0.0)

    assert not store.release_lease(_REPO, "b")
    assert store.read_repo(_REPO).lease_owner == "a"
    assert store.release_lease(_REPO, "a")
    assert store.read_repo(_REPO).lease_free(0.0)
    assert not store.release_lease(_REPO, "a")


def test_a_config_write_replaces_the_config_cache_and_nothing_else():
    store = InProcessStore()
    store.acquire_lease(_REPO, "a", expires=100.0, now=0.0)
    _save(store, "a", 1.0)
    record = ConfigRecord(kind="file", text="mode: shadow\n", etag='"e"', size=13, read_at=2.0, served=True)

    store.write_config(_REPO, record)
    second = ConfigRecord(kind="absent", read_at=3.0, attempted_at=4.0, valid_text="x", work_since=1.0, reported="p")
    store.write_config(_REPO, second)

    item = store.read_repo(_REPO)
    assert item.config == second
    assert (item.lease_owner, item.memory, item.last_tick) == ("a", b"memory", "t1")
    assert "cfg_text" not in store.items[f"repo#{_REPO}"]


def test_scan_repos_lists_every_repo_item_without_its_memory():
    store = InProcessStore()
    _save(store, None, 1.0)
    store.write_config("pytorch/audio", ConfigRecord(kind="absent", read_at=1.0))
    store.write_eligibility(EligibilityKey(_REPO, "merge_rules", "write"), b"s", 1.0)
    store.extend_latch(50.0, 0.0)

    found = store.scan_repos()

    assert set(found) == {_REPO, "pytorch/audio"}
    assert found[_REPO].memory is None
    assert found[_REPO].last_tick == "t1"
    assert found["pytorch/audio"].config.kind == "absent"


def test_an_eligibility_snapshot_round_trips_per_key():
    store = InProcessStore()
    key = EligibilityKey(_REPO, "write_permission", "maintain")

    assert store.read_eligibility(key) is None
    store.write_eligibility(key, b"snapshot", 12.5)

    assert store.read_eligibility(key) == (b"snapshot", 12.5)
    assert store.read_eligibility(EligibilityKey(_REPO, "write_permission", "write")) is None
    assert f"eligibility#{_REPO}#write_permission#maintain" in store.items


def test_the_latch_holds_until_its_time_and_only_extends():
    store = InProcessStore()
    assert store.read_latch(0.0) is None

    store.extend_latch(60.0, 0.0)
    store.extend_latch(30.0, 0.0)

    assert store.read_latch(10.0) == 60.0
    assert store.read_latch(60.0) is None
    store.extend_latch(120.0, 70.0)
    assert store.read_latch(70.0) == 120.0


def test_the_latch_is_clamped_on_write_and_on_read():
    store = InProcessStore()

    store.extend_latch(10_000.0, 0.0)
    assert store.read_latch(0.0) == _MAX
    store.items[state_store.LATCH_KEY][state_store.UNTIL] = 10_000.0
    assert store.read_latch(100.0) == 100.0 + _MAX
    assert timedelta(minutes=15) == RATE_LIMIT_LATCH_MAX


def test_ttl_is_set_on_the_latch_item_alone():
    store = InProcessStore()
    store.acquire_lease(_REPO, "a", expires=100.0, now=0.0)
    _save(store, "a", 1.0)
    store.write_config(_REPO, ConfigRecord(kind="absent", read_at=1.0))
    store.write_eligibility(EligibilityKey(_REPO, "merge_rules", "write"), b"s", 1.0)
    store.extend_latch(60.4, 0.0)

    with_ttl = {key for key, item in store.items.items() if state_store.TTL_AT in item}

    assert with_ttl == {state_store.LATCH_KEY}
    assert store.items[state_store.LATCH_KEY][state_store.TTL_AT] == 61


def test_an_item_with_unknown_values_reads_as_empty_fields():
    item = state_store.repo_item(_REPO, {"cfg_kind": "weird", "cfg_size": "x", "served": "yes", "memory": "not bytes"})

    assert item.config == ConfigRecord()
    assert item.memory is None


def test_the_epoch_is_shown_as_utc():
    assert state_store.epoch_text(0.0) == "1970-01-01T00:00:00+00:00"
