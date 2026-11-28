from __future__ import annotations

import dataclasses
import functools
import logging
from datetime import timedelta
from typing import Any

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import approval_backing
from greenlight.approvals import GREENLIGHT_LOGIN
from greenlight.constants import LEASE_DURATION, OTHER_REPO_MAX_DISPATCHES, STATUS_LAND, TARGET_REPO
from greenlight.gate_rules import GateRules
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state_store import ConfigRecord
from greenlight.tick_outcomes import RATE_LIMITED
from greenlight.worker import Worker, WorkerPayload, parse_payload, worker_cap, worker_event
from tests.fanout_fakes import NOW, OFF, SHADOW, START, World, identity
from tests.test_approval_backing import _GitHub, _pull, _review, _row

_REPO = "pytorch/vision"


def _served(world: World, text: str = SHADOW, *, memory: ScanMemory | None = None) -> None:
    world.store.write_config(_REPO, ConfigRecord(kind="file", text=text, valid_text=text, served=True))
    if memory is not None:
        world.store.save_memory(
            _REPO, encode_memory(memory, _REPO), owner=None, now=0.0, tick="t0", drain_complete=False
        )


def _worker(
    world: World,
    make_config: Any,
    *,
    cap: int = 3,
    tick: str = "t1",
    max_dispatches: int | None = 30,
    bot_login: str = "bot[bot]",
) -> Worker:
    world.events.append("bot login")
    return Worker(
        make_config(),
        WorkerPayload(_REPO, tick, cap),
        world.store,
        world.tokens(),  # type: ignore[arg-type]
        resolve_bot_login=lambda: bot_login,
        ref="main",
        timeout_minutes=45,
        started=START,
        max_dispatches=max_dispatches,
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

    def finish(prepared: Any, *, optional: bool, marks_full_tick: bool = True) -> None:
        item = world.store.read_repo(_REPO)
        leases.append((item.lease_owner, item.lease_expires))
        real_finish(prepared, optional=optional, marks_full_tick=marks_full_tick)

    world.finish = finish  # type: ignore[method-assign]

    assert _worker(world, make_config).run() == "done"

    assert world.events[1:] == [
        f"token {_REPO}",
        "dispatch token",
        f"identity {_REPO}",
        f"backing {_REPO} shadow",
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

    def finish(prepared: Any, *, optional: bool, marks_full_tick: bool = True) -> None:
        world.store.items[f"repo#{_REPO}"]["lease_owner"] = "other"
        real_finish(prepared, optional=optional, marks_full_tick=marks_full_tick)

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


@pytest.mark.parametrize(
    ("found", "problem"),
    [
        pytest.param(identity(_REPO, private=True), "it is private", id="turned-private"),
        pytest.param(identity(_REPO, archived=True), "it is archived", id="archived"),
        pytest.param(identity("pytorch/Vision"), "GitHub names it 'pytorch/Vision'", id="renamed"),
        pytest.param(identity(_REPO, branch="master"), "its default branch is 'master'", id="branch"),
    ],
)
def test_a_repo_that_fails_a_live_check_since_the_planner_read_it_gets_no_work(make_config, found, problem):
    world = World()
    _served(world)
    world.identities[_REPO] = found

    with pytest.raises(RuntimeError, match=f"pytorch/vision: its identity check failed: {problem}"):
        _worker(world, make_config).run()

    assert world.events[1:] == [f"token {_REPO}", "dispatch token", f"identity {_REPO}"]
    item = world.store.read_repo(_REPO)
    assert (item.last_tick, item.memory, item.lease_owner) == (None, None, None)
    [client] = [client for client in world.clients if client.token == f"token-{_REPO}" and client.meter]
    assert client.closed == 1
    assert client.meter is not None
    assert client.meter.repo == _REPO


def test_a_rate_limit_on_the_identity_check_latches_and_runs_nothing(make_config):
    world = World(failures={f"identity {_REPO}": RateLimitExceededException(403, {}, {"retry-after": "90"})})
    _served(world)

    with pytest.raises(RuntimeError, match=RATE_LIMITED):
        _worker(world, make_config).run()

    assert not any(event.startswith("prepare") for event in world.events)
    assert world.store.read_latch(START) == START + 90


@pytest.mark.parametrize(
    ("cap", "max_dispatches", "expected"),
    [(3, None, 3), (3, 30, 3), (20, 30, OTHER_REPO_MAX_DISPATCHES), (3, 0, 0)],
)
def test_the_dispatch_cap_follows_the_handlers_current_max(make_config, cap, max_dispatches, expected):
    world = World()
    _served(world)

    assert _worker(world, make_config, cap=cap, max_dispatches=max_dispatches).run() == "done"

    assert f"finish {_REPO} optional=True max={expected}" in world.events
    assert worker_cap(cap, max_dispatches) == expected


def test_a_drained_off_repo_gets_no_work_and_a_change_away_from_off_forgets_the_drain(make_config):
    world = World()
    drained = ScanMemory()
    drained.complete_drain(1)
    world.store.write_config(_REPO, ConfigRecord(kind="file", text=OFF, valid_text=OFF, served=True))
    world.store.save_memory(_REPO, encode_memory(drained, _REPO), owner=None, now=0.0, tick="t0", drain_complete=True)

    assert _worker(world, make_config).run() == "no work"
    assert world.events == ["bot login"]

    world.store.write_config(_REPO, ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True))
    assert _worker(world, make_config, tick="t2").run() == "done"

    item = world.store.read_repo(_REPO)
    assert not item.drain_complete
    assert decode_memory(item.memory, _REPO).drain_completed_by() is None


def test_a_backing_report_error_fails_the_worker_after_its_memory_is_saved(make_config):
    world = World(backing_errors=("the ledger could not be read: down",))
    _served(world)

    with pytest.raises(RuntimeError, match=r"^pytorch/vision: the ledger could not be read: down$"):
        _worker(world, make_config).run()

    kwargs = world.backing_kwargs[_REPO]
    assert kwargs["config"].github_token == f"token-{_REPO}"
    assert kwargs["bot_login"] == "bot[bot]"
    assert kwargs["build_github"].keywords["meter"].repo == _REPO
    item = world.store.read_repo(_REPO)
    assert (item.last_tick, item.lease_owner) == ("t1", None)


class _GateGitHub(_GitHub):
    """The backing check's GitHub, answering the worker's identity check too."""

    def requestJsonAndCheck(self, verb: str, url: str, *args: Any, **kwargs: Any) -> tuple[dict[str, Any], Any]:
        if url == f"/repos/{_REPO}":
            return {}, identity(_REPO)._asdict()
        return super().requestJsonAndCheck(verb, url, *args, **kwargs)


def test_a_gate_repos_backing_memory_round_trips_through_the_store_and_the_next_run_reads_only_what_changed(
    make_config,
):
    given = NOW - timedelta(minutes=5)
    moved = "c" * 40
    github = _GateGitHub()
    github.reviews = {7: [_review(1, given=given)], 8: [_review(2, given=given)]}
    pulls = [_pull(7, updated_at=given), _pull(8, updated_at=given)]
    rows = {number: _row(number, STATUS_LAND, version=given - timedelta(minutes=1)) for number in (7, 8)}
    meters: list[Any] = []

    def build(_token: str, *, meter: Any = None, **_kwargs: Any) -> Any:
        meters.append(meter)
        return github

    world = World()
    world.seams = lambda: dataclasses.replace(  # type: ignore[method-assign]
        World.seams(world),
        build_github=build,
        run_backing=functools.partial(
            approval_backing.check,
            list_prs=lambda _client, _repo: list(pulls),  # type: ignore[arg-type]
            read_gates=lambda _repo, numbers: ({n: rows[n] for n in numbers if n in rows},) * 2,
            read_ledger_newest=lambda: given,
            read_rules=lambda _client, _repo: GateRules(enforced=True),
        ),
    )
    _served(world)

    assert _worker(world, make_config, tick="t1", bot_login=GREENLIGHT_LOGIN).run() == "done"
    first = sorted(github.read_numbers())
    stored = decode_memory(world.store.read_repo(_REPO).memory, _REPO).backing
    pulls[1] = _pull(8, head=moved, updated_at=given + timedelta(minutes=1))
    github.fresh[8] = (moved, "main")
    github.reads.clear()
    assert _worker(world, make_config, tick="t2", bot_login=GREENLIGHT_LOGIN).run() == "done"

    assert first == [7, 8]
    assert set(stored.keys) == {7, 8}
    assert github.read_numbers() == [8]
    assert [(number, review) for number, review, _message in github.dismissals] == [(8, 2)]
    assert {meter.repo for meter in meters if meter is not None} == {_REPO}
    assert decode_memory(world.store.read_repo(_REPO).memory, _REPO).backing.keys[8].head_sha == moved
