from __future__ import annotations

import dataclasses
import logging
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import config_cache, fanout, fanout_repos, tick
from greenlight.constants import AWS_REGION, LEASE_DURATION, QUOTA_REFRESH_REQUESTS, TARGET_REPO
from greenlight.fanout import Planner
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state_store import ConfigRecord, StoreError
from greenlight.tick_outcomes import RATE_LIMITED
from tests.fanout_fakes import NOW, SHADOW, START, World, file_answer, identity

_TICK = "2026-11-24T12:00:00Z"


def _planner(world: World, make_config: Any, *, max_dispatches: int | None = 30, max_workers: int = 3) -> Planner:
    return Planner(
        make_config(max_workers=max_workers),
        tick=_TICK,
        store=world.store,
        tokens=world.tokens(),  # type: ignore[arg-type]
        invoke=world.invoke,
        bot_login="bot[bot]",
        max_dispatches=max_dispatches,
        ref="main",
        timeout_minutes=45,
        started=START,
        seams=world.seams(),
        owner="planner",
    )


def _run(world: World, make_config: Any, **kwargs: Any) -> Planner:
    planner = _planner(world, make_config, **kwargs)
    planner.run()
    return planner


def _fails(world: World, make_config: Any, match: str, **kwargs: Any) -> Planner:
    planner = _planner(world, make_config, **kwargs)
    with pytest.raises(RuntimeError, match=match):
        planner.run()
    return planner


def test_pytorchs_phase_a_runs_before_the_fan_out_and_its_phase_b_after(make_config):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision")], files={"pytorch/vision": file_answer(SHADOW)}
    )

    planner = _run(world, make_config)

    assert world.events == [
        f"token {TARGET_REPO}",
        "dispatch token",
        f"prepare {TARGET_REPO} active max=0",
        "listing",
        "contents token",
        "invoke pytorch/vision",
        f"finish {TARGET_REPO} optional=True max=30",
    ]
    assert world.invoked == [{"greenlight_worker": {"repo": "pytorch/vision", "tick": _TICK, "dispatch_cap": 5}}]
    assert planner.lines[TARGET_REPO].outcome == "served"
    assert planner.lines["pytorch/vision"].outcome == "invoked"


def test_pytorch_runs_under_its_lease_on_its_stored_memory_and_saves_it_with_the_tick(make_config):
    world = World()
    memory = ScanMemory()
    memory.mark_full_tick(NOW)
    world.store.save_memory(
        TARGET_REPO, encode_memory(memory, TARGET_REPO), owner=None, now=0.0, tick="old", drain_complete=False
    )
    leases: list[tuple[str | None, float | None]] = []
    real_finish = world.finish

    def finish(prepared: Any, *, optional: bool, marks_full_tick: bool = True) -> None:
        item = world.store.read_repo(TARGET_REPO)
        leases.append((item.lease_owner, item.lease_expires))
        real_finish(prepared, optional=optional, marks_full_tick=marks_full_tick)

    world.finish = finish  # type: ignore[method-assign]

    _run(world, make_config)

    assert leases == [("planner", START + LEASE_DURATION.total_seconds())]
    assert world.prepare_kwargs[TARGET_REPO]["memory"]._last_full_tick_started == NOW
    item = world.store.read_repo(TARGET_REPO)
    assert (item.last_tick, item.last_completed_at, item.lease_owner) == (_TICK, START, None)
    assert decode_memory(item.memory, TARGET_REPO)._last_full_tick_started == NOW


def test_pytorchs_config_goes_through_the_cache_and_a_mode_off_drains_it_in_phase_a(make_config):
    world = World(files={TARGET_REPO: file_answer("mode: off\n")})

    planner = _run(world, make_config)

    assert f"drain {TARGET_REPO}" in world.events
    assert not any(event.startswith("prepare") for event in world.events)
    assert planner.lines[TARGET_REPO].outcome == "draining"
    assert world.store.read_repo(TARGET_REPO).config.valid_text == "mode: off\n"
    _run(world, make_config)
    assert world.reads[-1] == (TARGET_REPO, {"If-None-Match": '"e1"'})


def test_a_pytorch_config_problem_fails_every_tick(make_config):
    world = World(files={TARGET_REPO: file_answer("mode: paused\n")})

    for _ in range(2):
        _fails(world, make_config, "pytorch/pytorch: invalid config, safety-only under the built-in entry")

    assert f"finish {TARGET_REPO} optional=False max=0" in world.events


def test_the_shared_latch_skips_phase_b_and_every_other_repo_but_never_pytorchs_phase_a(make_config):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision")], files={"pytorch/vision": file_answer(SHADOW)}
    )
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, served=True))
    world.store.extend_latch(START + 120, START)

    planner = _fails(world, make_config, "the shared rate-limit latch holds until")

    assert f"prepare {TARGET_REPO} active max=0" in world.events
    assert f"finish {TARGET_REPO} optional=False max=0 no-mark" in world.events
    assert "listing" not in world.events
    assert world.invoked == []
    assert planner.lines["pytorch/vision"].outcome == "skipped"
    assert planner.lines[TARGET_REPO].outcome == "safety-only"
    assert world.store.read_repo(TARGET_REPO).last_tick == _TICK


def test_a_rate_limit_in_pytorchs_phase_a_skips_the_fan_out_and_extends_the_shared_latch(make_config):
    world = World(failures={f"prepare {TARGET_REPO}": RateLimitExceededException(403, {}, {"retry-after": "300"})})

    planner = _fails(world, make_config, RATE_LIMITED)

    assert "listing" not in world.events
    assert world.store.read_latch(START) == START + 300
    assert planner.lines[TARGET_REPO].detail == f"no Phase B: {RATE_LIMITED}"


def test_a_store_failure_runs_pytorchs_phase_a_without_a_lease_on_a_cold_memory_then_fails(make_config):
    world = World()
    world.store.failing = {"read_latch"}
    stored = ScanMemory()
    stored.mark_full_tick(NOW)
    world.store.save_memory(
        TARGET_REPO, encode_memory(stored, TARGET_REPO), owner=None, now=0.0, tick=None, drain_complete=False
    )

    planner = _fails(world, make_config, "the state store failed reading the rate-limit latch")

    assert world.prepare_kwargs[TARGET_REPO]["memory"].full_tick_due(NOW)
    assert "listing" not in world.events
    assert world.store.read_repo(TARGET_REPO).last_tick is None
    assert world.store.read_repo(TARGET_REPO).lease_owner is None
    assert planner.lines[TARGET_REPO].detail == "no Phase B: the state store failed"


@pytest.mark.parametrize("operation", ["acquire_lease", "read_repo"])
def test_a_store_failure_taking_or_reading_pytorch_is_the_same_degraded_tick(make_config, operation):
    world = World()
    world.store.failing = {operation}

    planner = _fails(world, make_config, "the state store failed")

    assert f"prepare {TARGET_REPO} active max=0" in world.events
    assert "listing" not in world.events
    assert planner.lines[TARGET_REPO].outcome == "safety-only"


def test_pytorchs_lease_held_by_another_planner_runs_nothing_for_it_but_the_fan_out_goes_on(make_config):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision")], files={"pytorch/vision": file_answer(SHADOW)}
    )
    world.store.acquire_lease(TARGET_REPO, "other", expires=START + 100, now=START)

    planner = _fails(world, make_config, "pytorch/pytorch: its lease is held by another invocation")

    assert not any(event.startswith(("prepare", "finish")) for event in world.events)
    assert planner.lines[TARGET_REPO].outcome == "busy"
    assert world.invoked != []
    assert world.store.read_repo(TARGET_REPO).lease_owner == "other"


def test_pytorchs_token_failure_skips_it_and_the_fan_out_goes_on(make_config):
    world = World(failures={f"token {TARGET_REPO}": GithubException(500, {"message": "down"})})

    planner = _fails(world, make_config, "pytorch/pytorch: its token failed")

    assert planner.lines[TARGET_REPO].outcome == "skipped"
    assert "listing" in world.events


def test_without_the_dispatch_token_pytorch_runs_only_its_safety_work(make_config):
    world = World(failures={"dispatch token": GithubException(500, {"message": "down"})})

    _fails(world, make_config, "the dispatch token failed")

    assert world.prepare_kwargs[TARGET_REPO]["dispatch_token"] is None
    assert f"finish {TARGET_REPO} optional=False max=0 no-mark" in world.events


@pytest.mark.parametrize(
    ("listing", "refusal"),
    [
        ([identity("pytorch/vision")], "does not list it"),
        ([identity(TARGET_REPO, branch="master")], "its default branch is 'master'"),
    ],
)
def test_pytorch_gets_no_phase_b_when_the_listing_refuses_it(make_config, listing, refusal):
    world = World(listing=listing)

    planner = _fails(world, make_config, f"pytorch/pytorch: no Phase B this tick: .*{refusal}")

    assert f"finish {TARGET_REPO} optional=False max=0 no-mark" in world.events
    assert planner.lines[TARGET_REPO].outcome == "safety-only"


def test_a_failed_save_or_release_of_pytorch_fails_the_tick(make_config):
    world = World()
    world.store.failing = {"save_memory", "release_lease"}

    _fails(world, make_config, "its memory could not be saved: save_memory refused; .*its lease could not be released")


def test_a_lease_taken_over_before_the_release_is_only_logged(make_config, caplog):
    world = World()
    real_finish = world.finish

    def finish(prepared: Any, *, optional: bool, marks_full_tick: bool = True) -> None:
        world.store.items[f"repo#{TARGET_REPO}"]["lease_owner"] = "other"
        real_finish(prepared, optional=optional, marks_full_tick=marks_full_tick)

    world.finish = finish  # type: ignore[method-assign]

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        _fails(world, make_config, "its memory could not be saved")

    assert "its lease was no longer held at release" in caplog.text


def test_a_failed_latch_record_fails_the_tick(make_config):
    world = World(failures={f"prepare {TARGET_REPO}": RateLimitExceededException(403, {}, {})})
    world.store.failing = {"extend_latch"}

    _fails(world, make_config, "the state store failed recording the rate-limit latch")


def test_every_repo_gets_one_outcome_line(make_config, caplog):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision"), identity("pytorch/audio")],
        files={"pytorch/vision": file_answer(SHADOW)},
    )

    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run(world, make_config)

    lines = [
        record.getMessage() for record in caplog.records if record.getMessage().startswith("greenlight repo outcome:")
    ]
    assert lines == [
        "greenlight repo outcome: pytorch/audio absent",
        "greenlight repo outcome: pytorch/pytorch served",
        "greenlight repo outcome: pytorch/vision invoked",
    ]


def test_the_lambda_invoker_invokes_this_function_asynchronously(monkeypatch):
    fake_boto3 = MagicMock()
    fake_boto3.client.return_value.invoke.side_effect = [{"StatusCode": 202}, {"StatusCode": 500}]
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)

    invoke = fanout.lambda_invoker("greenlight-scan")
    invoke({"greenlight_worker": {"repo": "pytorch/vision"}})
    with pytest.raises(RuntimeError, match="Lambda answered 500 to an asynchronous invoke of greenlight-scan"):
        invoke({})

    args, kwargs = fake_boto3.client.call_args
    assert args == ("lambda",)
    assert kwargs["region_name"] == AWS_REGION
    first = fake_boto3.client.return_value.invoke.call_args_list[0].kwargs
    assert first == {
        "FunctionName": "greenlight-scan",
        "InvocationType": "Event",
        "Payload": b'{"greenlight_worker": {"repo": "pytorch/vision"}}',
    }


def test_pytorch_with_no_settings_is_a_bug_that_raises(make_config, monkeypatch):
    world = World()
    real_decide = config_cache.decide

    def decide(*args: Any, **kwargs: Any) -> Any:
        decision = real_decide(*args, **kwargs)
        return config_cache.Decision(dataclasses.replace(decision.settings, entry=None), decision.record)

    monkeypatch.setattr(config_cache, "decide", decide)

    _fails(world, make_config, "pytorch/pytorch has no settings")

    assert world.store.read_repo(TARGET_REPO).lease_owner is None


def test_a_store_failure_reading_pytorch_under_its_lease_saves_nothing_over_its_memory(make_config):
    world = World()
    stored = ScanMemory()
    stored.mark_full_tick(NOW)
    world.store.save_memory(
        TARGET_REPO, encode_memory(stored, TARGET_REPO), owner=None, now=0.0, tick="old", drain_complete=False
    )
    real_read = world.store.read_repo

    def read_repo(repo: str) -> Any:
        raise StoreError("down")

    world.store.read_repo = read_repo  # type: ignore[method-assign]

    _fails(world, make_config, "the state store failed reading pytorch/pytorch")

    world.store.read_repo = real_read  # type: ignore[method-assign]
    item = world.store.read_repo(TARGET_REPO)
    assert (item.last_tick, item.lease_owner) == ("old", None)
    assert decode_memory(item.memory, TARGET_REPO)._last_full_tick_started == NOW


def _cut_finish(world: World) -> Any:
    """A finish whose next request meets its meter's stop: pytorch/pytorch's Phase B is cut short."""

    def finish(prepared: Any, *, optional: bool, marks_full_tick: bool = True) -> None:
        world.events.append(f"finish {prepared.repo} optional={optional}")
        if optional:
            meter = world.prepare_kwargs[TARGET_REPO]["build_github"].keywords["meter"]
            meter.stop = lambda: "past its deadline"
            meter.before_request()

    return finish


@pytest.mark.parametrize(
    ("failure", "line", "match"),
    [
        pytest.param(None, fanout_repos.Line("served"), None, id="ran"),
        pytest.param(
            "cut", fanout_repos.Line("cut", "Phase B cut short: past its deadline"), "Phase B cut short", id="cut"
        ),
        pytest.param(
            RateLimitExceededException(403, {}, {}),
            fanout_repos.Line("cut", f"Phase B stopped: {RATE_LIMITED}"),
            RATE_LIMITED,
            id="rate-limit",
        ),
        pytest.param(RuntimeError("boom"), fanout_repos.Line("failed", "Phase B failed"), "boom", id="failed"),
        pytest.param(
            "no dispatch token",
            fanout_repos.Line("safety-only", f"no Phase B: {tick.NO_DISPATCH_TOKEN}"),
            "the dispatch token failed",
            id="no-dispatch-token",
        ),
    ],
)
def test_pytorchs_line_says_what_its_phase_b_did(make_config, failure, line, match):
    world = World()
    if failure == "cut":
        world.finish = _cut_finish(world)  # type: ignore[method-assign]
    elif failure == "no dispatch token":
        world.failures["dispatch token"] = GithubException(500, {"message": "down"})
    elif failure is not None:
        world.failures[f"finish {TARGET_REPO}"] = failure

    planner = _planner(world, make_config)
    if match is None:
        planner.run()
    else:
        with pytest.raises(RuntimeError, match=match):
            planner.run()

    assert planner.lines[TARGET_REPO] == line


def test_a_rate_limit_another_invocation_meets_during_pytorchs_phase_a_holds_back_the_rest(make_config):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision")], files={"pytorch/vision": file_answer(SHADOW)}
    )
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, served=True))
    real_prepare = world.prepare

    def prepare(config: Any, *, entry: Any, max_dispatches: int | None, **kwargs: Any) -> Any:
        world.store.extend_latch(START + 200, START)
        meter = kwargs["build_github"].keywords["meter"]
        for _ in range(3 * QUOTA_REFRESH_REQUESTS):
            meter.before_request()
            meter.count()
        return real_prepare(config, entry=entry, max_dispatches=max_dispatches, **kwargs)

    world.prepare = prepare  # type: ignore[method-assign]

    planner = _fails(world, make_config, RATE_LIMITED)

    assert f"prepare {TARGET_REPO} active max=0" in world.events
    assert "listing" not in world.events
    assert world.invoked == []
    assert planner.lines["pytorch/vision"] == fanout_repos.Line("skipped", RATE_LIMITED)
    assert planner.lines[TARGET_REPO] == fanout_repos.Line("safety-only", f"no Phase B: {RATE_LIMITED}")
    assert world.store.read_latch(START) == START + 200


def test_a_failed_read_of_the_shared_latch_after_a_good_one_holds_back_the_rest_but_never_pytorchs_phase_a(
    make_config,
):
    world = World(
        listing=[identity(TARGET_REPO), identity("pytorch/vision")], files={"pytorch/vision": file_answer(SHADOW)}
    )
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, served=True))
    real_prepare = world.prepare

    def prepare(config: Any, *, entry: Any, max_dispatches: int | None, **kwargs: Any) -> Any:
        world.store.failing = {"read_latch"}
        meter = kwargs["build_github"].keywords["meter"]
        for _ in range(3 * QUOTA_REFRESH_REQUESTS):
            meter.before_request()
            meter.count()
        return real_prepare(config, entry=entry, max_dispatches=max_dispatches, **kwargs)

    world.prepare = prepare  # type: ignore[method-assign]
    planner = _planner(world, make_config)

    with pytest.raises(RuntimeError) as excinfo:
        planner.run()

    assert str(excinfo.value) == "the state store failed reading the shared rate-limit latch: read_latch refused"
    assert "listing" not in world.events
    assert world.invoked == []
    assert planner.lines["pytorch/vision"] == fanout_repos.Line("skipped", RATE_LIMITED)
    assert planner.lines[TARGET_REPO] == fanout_repos.Line("safety-only", f"no Phase B: {RATE_LIMITED}")
    assert "ratelimit" not in world.store.items
    assert world.store.read_repo(TARGET_REPO).last_tick == _TICK
