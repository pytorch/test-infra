from __future__ import annotations

import logging
from typing import Any

import pytest
from github import GithubException, RateLimitExceededException

from greenlight.constants import LEASE_DURATION, OTHER_REPO_MAX_DISPATCHES, TARGET_REPO
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state_store import ConfigRecord
from greenlight.tick_outcomes import RATE_LIMITED
from greenlight.worker import Worker, WorkerPayload, parse_payload, worker_event
from tests.fanout_fakes import NOW, OFF, SHADOW, START, World

_REPO = "pytorch/vision"


def _served(world: World, text: str = SHADOW, *, memory: ScanMemory | None = None) -> None:
    world.store.write_config(_REPO, ConfigRecord(kind="file", text=text, valid_text=text, served=True))
    if memory is not None:
        world.store.save_memory(
            _REPO, encode_memory(memory, _REPO), owner=None, now=0.0, tick="t0", drain_complete=False
        )


def _worker(world: World, make_config: Any, *, cap: int = 3, tick: str = "t1") -> Worker:
    world.events.append("bot login")
    return Worker(
        make_config(),
        WorkerPayload(_REPO, tick, cap),
        world.store,
        world.tokens(),  # type: ignore[arg-type]
        resolve_bot_login=lambda: "bot[bot]",
        ref="main",
        timeout_minutes=45,
        started=START,
        seams=world.seams(),
        owner="worker",
    )


def test_a_worker_runs_its_repo_under_its_lease_and_saves_the_completed_tick(make_config):
    world = World()
    memory = ScanMemory()
    memory.mark_full_tick(NOW)
    _served(world, memory=memory)
    leases: list[tuple[str | None, float | None]] = []
    real_finish = world.finish

    def finish(prepared: Any, *, optional: bool) -> int:
        item = world.store.read_repo(_REPO)
        leases.append((item.lease_owner, item.lease_expires))
        return real_finish(prepared, optional=optional)

    world.finish = finish  # type: ignore[method-assign]

    assert _worker(world, make_config).run() == "done"

    assert world.events[1:] == [
        f"token {_REPO}",
        "dispatch token",
        f"prepare {_REPO} shadow max=3",
        f"finish {_REPO} optional=True max=3",
    ]
    assert leases == [("worker", START + LEASE_DURATION.total_seconds())]
    kwargs = world.prepare_kwargs[_REPO]
    assert kwargs["config"].github_token == f"token-{_REPO}"
    assert kwargs["dispatch_token"] == "dispatch"
    assert kwargs["bot_login"] == "bot[bot]"
    assert kwargs["memory"]._last_full_tick_started == NOW
    item = world.store.read_repo(_REPO)
    assert (item.last_tick, item.last_completed_at, item.lease_owner) == ("t1", START, None)
    assert decode_memory(item.memory, _REPO)._last_full_tick_started == NOW


def test_the_dispatch_cap_is_clamped(make_config):
    world = World()
    _served(world)

    _worker(world, make_config, cap=OTHER_REPO_MAX_DISPATCHES + 20).run()

    assert f"finish {_REPO} optional=True max={OTHER_REPO_MAX_DISPATCHES}" in world.events


def test_the_settings_are_re_derived_from_the_stored_config_record(make_config):
    world = World()
    _served(world, OFF)

    assert _worker(world, make_config).run() == "done"

    assert f"drain {_REPO}" in world.events
    assert not any(event.startswith("prepare") for event in world.events)
    assert world.reads == []


def test_a_replayed_tick_is_skipped(make_config, caplog):
    world = World()
    _served(world)
    world.store.save_memory(_REPO, b"m", owner=None, now=0.0, tick="t1", drain_complete=False)

    with caplog.at_level(logging.INFO, logger="greenlight"):
        assert _worker(world, make_config, tick="t1").run() == "replayed"

    assert world.events == ["bot login"]
    assert "tick t1 already completed" in caplog.text
    assert world.store.read_repo(_REPO).lease_owner is None


def test_a_held_lease_ends_the_worker(make_config, caplog):
    world = World()
    _served(world)
    world.store.acquire_lease(_REPO, "other", expires=START + 100, now=START)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert _worker(world, make_config).run() == "busy"

    assert world.events == ["bot login"]
    assert world.store.read_repo(_REPO).lease_owner == "other"
    assert "its lease is held by another invocation" in caplog.text


def test_the_shared_latch_gives_the_repo_no_work(make_config):
    world = World()
    _served(world)
    world.store.extend_latch(START + 60, START)

    assert _worker(world, make_config).run() == "skipped"

    assert world.events == ["bot login"]
    assert world.store.read_repo(_REPO).last_tick is None


def test_stored_settings_with_no_work_end_the_worker(make_config):
    world = World()
    world.store.write_config(_REPO, ConfigRecord(kind="absent", read_at=1.0))

    assert _worker(world, make_config).run() == "no work"
    assert world.events == ["bot login"]


def test_a_repo_with_errors_saves_its_memory_and_raises(make_config):
    world = World(failures={f"finish {_REPO}": RuntimeError("failed to dispatch 1 PR(s): [4]")})
    _served(world)

    with pytest.raises(RuntimeError, match=r"pytorch/vision: Phase B failed: failed to dispatch 1 PR\(s\): \[4\]"):
        _worker(world, make_config).run()

    item = world.store.read_repo(_REPO)
    assert (item.last_tick, item.lease_owner) == ("t1", None)


def test_a_rate_limit_extends_the_shared_latch(make_config):
    world = World(failures={f"finish {_REPO}": RateLimitExceededException(403, {}, {"retry-after": "200"})})
    _served(world)

    with pytest.raises(RuntimeError, match=RATE_LIMITED):
        _worker(world, make_config).run()

    assert world.store.read_latch(START) == START + 200


def test_a_token_failure_runs_nothing_and_completes_no_tick(make_config):
    world = World(failures={f"token {_REPO}": GithubException(500, {"message": "down"})})
    _served(world)

    with pytest.raises(RuntimeError, match="pytorch/vision: its token failed"):
        _worker(world, make_config).run()

    assert world.store.read_repo(_REPO).last_tick is None
    assert world.store.read_repo(_REPO).lease_owner is None


@pytest.mark.parametrize("operation", ["read_repo", "acquire_lease"])
def test_a_store_failure_fails_the_worker_before_any_github_work(make_config, operation):
    world = World()
    _served(world)
    world.store.failing = {operation}

    with pytest.raises(Exception, match=f"{operation} refused"):
        _worker(world, make_config).run()

    assert world.events == ["bot login"]


@pytest.mark.parametrize(
    ("failing", "match", "rate_limited"),
    [
        ("save_memory", "its memory could not be saved: save_memory refused", False),
        ("release_lease", "its lease could not be released: release_lease refused", False),
        ("extend_latch", "the state store failed recording the rate-limit latch", True),
    ],
)
def test_a_store_failure_after_the_run_fails_the_worker(make_config, failing, match, rate_limited):
    world = World(failures={f"finish {_REPO}": RateLimitExceededException(403, {}, {})} if rate_limited else {})
    _served(world)
    world.store.failing = {failing}

    with pytest.raises(RuntimeError, match=match):
        _worker(world, make_config).run()


def test_a_failed_release_after_a_failed_run_is_logged_and_the_runs_errors_are_raised(make_config, caplog):
    world = World(failures={f"finish {_REPO}": RuntimeError("boom")})
    _served(world)
    world.store.failing = {"release_lease"}

    with caplog.at_level(logging.ERROR, logger="greenlight"), pytest.raises(RuntimeError, match="Phase B failed: boom"):
        _worker(world, make_config).run()

    [record] = [record for record in caplog.records if "cannot release its lease" in record.getMessage()]
    assert record.exc_info


def test_a_lease_lost_before_the_release_is_only_logged(make_config, caplog):
    world = World()
    _served(world)
    real_finish = world.finish

    def finish(prepared: Any, *, optional: bool) -> int:
        world.store.items[f"repo#{_REPO}"]["lease_owner"] = "other"
        return real_finish(prepared, optional=optional)

    world.finish = finish  # type: ignore[method-assign]

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError, match="memory could not"):
        _worker(world, make_config).run()

    assert "its lease was no longer held at release" in caplog.text


def test_a_worker_event_round_trips_through_its_parser():
    assert parse_payload(worker_event(_REPO, "t1", 2)) == WorkerPayload(_REPO, "t1", 2)


@pytest.mark.parametrize(
    ("event", "match"),
    [
        ({"greenlight_worker": {"repo": _REPO, "tick": "t"}}, "a worker event is exactly"),
        ({"greenlight_worker": {"repo": _REPO, "tick": "t", "dispatch_cap": 1}, "x": 1}, "a worker event is exactly"),
        ({"greenlight_worker": "nope"}, "a worker event is exactly"),
        ({"greenlight_worker": {"repo": "vision", "tick": "t", "dispatch_cap": 1}}, "one owner/name repo"),
        ({"greenlight_worker": {"repo": _REPO, "tick": "", "dispatch_cap": 1}}, "one owner/name repo"),
        ({"greenlight_worker": {"repo": _REPO, "tick": "t", "dispatch_cap": -1}}, "non-negative integer"),
        ({"greenlight_worker": {"repo": _REPO, "tick": "t", "dispatch_cap": True}}, "non-negative integer"),
        ({"greenlight_worker": {"repo": TARGET_REPO, "tick": "t", "dispatch_cap": 1}}, "runs in the planner"),
    ],
)
def test_any_other_worker_event_is_refused(event, match):
    with pytest.raises(ValueError, match=match):
        parse_payload(event)
