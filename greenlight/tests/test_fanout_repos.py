from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import fanout_repos
from greenlight.config_cache import REMOVED, UNREACHABLE
from greenlight.constants import CONFIG_ABSENT_TTL, FANOUT_BUDGET, STALE_RUN_TICKS, TARGET_REPO, TICK_INTERVAL
from greenlight.fanout import Planner
from greenlight.guards import IterationTimeout
from greenlight.state_store import ConfigRecord, StoreError
from greenlight.tick_outcomes import RATE_LIMITED
from tests.fanout_fakes import OFF, SHADOW, START, World, file_answer, identity

_TICK = "tick-1"
_STALE = STALE_RUN_TICKS * TICK_INTERVAL.total_seconds()


def _tick(world: World, make_config: Any, *, max_dispatches: int | None = 30, max_workers: int = 3) -> Planner:
    planner = Planner(
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
    try:
        planner.run()
    except RuntimeError as exc:
        planner.failure = str(exc)  # type: ignore[attr-defined]
    else:
        planner.failure = None  # type: ignore[attr-defined]
    return planner


def _failure(planner: Planner) -> str | None:
    return planner.failure  # type: ignore[attr-defined,no-any-return]


def _world(*repos: Any, files: dict[str, Any] | None = None) -> World:
    return World(listing=[identity(TARGET_REPO), *repos], files=files or {})


def _caps(world: World) -> dict[str, int]:
    return {event["greenlight_worker"]["repo"]: event["greenlight_worker"]["dispatch_cap"] for event in world.invoked}


def test_only_public_unarchived_repos_are_read_and_the_others_are_only_reported(make_config):
    world = _world(
        identity("pytorch/vision"),
        identity("pytorch/secret", private=True),
        identity("pytorch/old", archived=True),
        files={"pytorch/vision": file_answer(SHADOW)},
    )

    planner = _tick(world, make_config)

    assert world.contents_scope == [["pytorch/vision"]]
    assert [repo for repo, _headers in world.reads] == [TARGET_REPO, "pytorch/vision"]
    assert planner.lines["pytorch/secret"] == fanout_repos.Line("skipped", "it is private")
    assert planner.lines["pytorch/old"] == fanout_repos.Line("skipped", "it is archived")
    assert _failure(planner) is None


def test_an_unchanged_file_is_revalidated_with_its_etag_and_stored_once(make_config):
    world = _world(identity("pytorch/vision"), files={"pytorch/vision": file_answer(SHADOW)})

    _tick(world, make_config)
    world.store.release_lease("pytorch/vision", "worker")
    world.store.items["repo#pytorch/vision"]["last_completed_at"] = START
    _tick(world, make_config)

    vision_reads = [headers for repo, headers in world.reads if repo == "pytorch/vision"]
    assert vision_reads == [None, {"If-None-Match": '"e1"'}]
    assert world.store.config_writes.count("pytorch/vision") == 1
    assert len(world.invoked) == 2


def test_an_absent_file_is_read_again_only_after_its_ttl(make_config):
    world = _world(identity("pytorch/audio"))

    first = _tick(world, make_config)
    _tick(world, make_config)
    world.clock[0] = START + CONFIG_ABSENT_TTL.total_seconds()
    _tick(world, make_config)

    assert [repo for repo, _headers in world.reads].count("pytorch/audio") == 2
    assert first.lines["pytorch/audio"] == fanout_repos.Line("absent")
    assert world.invoked == []


def test_an_invalid_file_is_safety_only_under_the_stored_valid_settings(make_config):
    world = _world(identity("pytorch/vision"), files={"pytorch/vision": file_answer("mode: <bad>\n", '"e2"')})
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=OFF, valid_text=OFF, served=True))

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"].outcome == "invoked"
    assert "safety-only under its last valid settings instead" in (planner.lines["pytorch/vision"].detail or "")
    assert _caps(world) == {"pytorch/vision": 0}
    assert "pytorch/vision: invalid config, refused" in (_failure(planner) or "")


def test_a_config_problem_fails_only_the_tick_it_first_appears_or_changes(make_config):
    world = _world(identity("pytorch/vision"), files={"pytorch/vision": file_answer("mode: <bad>\n")})

    first = _tick(world, make_config)
    second = _tick(world, make_config)
    world.files["pytorch/vision"] = file_answer("mode: <worse>\n", '"e2"')
    changed = _tick(world, make_config)
    world.files["pytorch/vision"] = file_answer(
        SHADOW.replace("shadow", "off").replace("gate", "gate\nextra: 1"), '"e3"'
    )
    _tick(world, make_config)
    world.files["pytorch/vision"] = file_answer("mode: <worse>\n", '"e4"')
    again = _tick(world, make_config)

    assert "pytorch/vision: invalid config, refused" in (_failure(first) or "")
    assert _failure(second) is None
    assert second.lines["pytorch/vision"].outcome == "refused"
    assert "<worse>" in (_failure(changed) or "")
    assert "<worse>" in (_failure(again) or "")


def test_an_unreadable_file_serves_the_last_file_read(make_config):
    world = _world(identity("pytorch/vision"), identity("pytorch/audio"))
    world.failures["contents token"] = GithubException(500, {"message": "down"})
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True))

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"].outcome == "invoked"
    assert "config unreadable, serving the last file read" in (planner.lines["pytorch/vision"].detail or "")
    assert planner.lines["pytorch/audio"].outcome == "refused"
    assert "the contents token failed" in (_failure(planner) or "")


def test_a_served_repos_removed_file_drains_it_until_the_drain_completes(make_config):
    world = _world(identity("pytorch/vision"))
    world.store.write_config(
        "pytorch/vision", ConfigRecord(kind="file", text=SHADOW, etag='"e1"', valid_text=SHADOW, served=True)
    )

    draining = _tick(world, make_config)
    assert draining.lines["pytorch/vision"] == fanout_repos.Line("invoked", REMOVED)
    assert _caps(world) == {"pytorch/vision": 0}
    assert REMOVED in (_failure(draining) or "")

    world.store.save_memory("pytorch/vision", b"x", owner=None, now=START, tick="t0", drain_complete=True)
    world.clock[0] = START + CONFIG_ABSENT_TTL.total_seconds()
    drained = _tick(world, make_config)

    assert drained.lines["pytorch/vision"] == fanout_repos.Line("absent")
    assert not world.store.read_repo("pytorch/vision").config.served
    assert len(world.invoked) == 1


def test_a_served_repo_gone_from_the_listing_fails_every_tick(make_config):
    world = _world()
    world.store.write_config(
        "pytorch/vision", ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True, reported=UNREACHABLE)
    )

    for _ in range(2):
        planner = _tick(world, make_config)
        assert planner.lines["pytorch/vision"] == fanout_repos.Line("unreachable", UNREACHABLE)
        assert f"pytorch/vision: {UNREACHABLE}" in (_failure(planner) or "")


def test_a_repo_gone_from_the_listing_never_served_is_only_absent(make_config):
    world = _world()
    world.store.write_config("pytorch/vision", ConfigRecord(kind="absent", read_at=START))

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"] == fanout_repos.Line("absent")
    assert _failure(planner) is None


def test_a_listed_repo_failing_a_live_check_is_refused(make_config):
    world = _world(identity("pytorch/vision", branch="master"), files={"pytorch/vision": file_answer(SHADOW)})

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"].outcome == "refused"
    assert "refused for this tick: its default branch is 'master'" in (_failure(planner) or "")
    assert world.invoked == []


def test_a_private_repo_with_a_stored_config_is_refused_with_its_reason(make_config):
    world = _world(identity("pytorch/vision", private=True))
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True))

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"].outcome == "refused"
    assert "it is private" in (_failure(planner) or "")


def test_a_safety_only_gate_repo_gets_no_worker(make_config):
    world = _world(identity("pytorch/vision"), files={"pytorch/vision": file_answer(SHADOW + "extra: 1\n")})

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"].outcome == "safety-only"
    assert world.invoked == []


def _with_work(world: World, repo: str, *, completed: float | None = None, lease: str | None = None) -> None:
    world.listing.append(identity(repo))
    world.files[repo] = file_answer(SHADOW)
    if completed is not None:
        world.store.items.setdefault(f"repo#{repo}", {"pk": f"repo#{repo}"})["last_completed_at"] = completed
    if lease is not None:
        world.store.acquire_lease(repo, lease, expires=START + 100, now=START)


def test_workers_go_to_the_oldest_runs_first_and_more_work_than_workers_is_a_problem(make_config):
    world = _world()
    _with_work(world, "pytorch/a", completed=START - 10)
    _with_work(world, "pytorch/b", completed=START - 100)
    _with_work(world, "pytorch/c")
    _with_work(world, "pytorch/d", completed=START - 50)

    planner = _tick(world, make_config, max_workers=2)

    assert [event["greenlight_worker"]["repo"] for event in world.invoked] == ["pytorch/c", "pytorch/b"]
    assert planner.lines["pytorch/a"] == fanout_repos.Line("skipped", "no free worker this tick")
    assert planner.lines["pytorch/d"].outcome == "skipped"
    assert "4 repos have work, more than PYTORCH_GREENLIGHT_MAX_WORKERS (2)" in (_failure(planner) or "")


def test_a_busy_lease_is_left_alone_and_takes_a_worker_slot(make_config):
    world = _world()
    _with_work(world, "pytorch/a", lease="worker")
    _with_work(world, "pytorch/b")
    _with_work(world, "pytorch/c")

    planner = _tick(world, make_config, max_workers=2)

    assert planner.lines["pytorch/a"] == fanout_repos.Line("busy", "its lease is held by another invocation")
    assert [event["greenlight_worker"]["repo"] for event in world.invoked] == ["pytorch/b"]
    assert planner.lines["pytorch/c"].outcome == "skipped"


@pytest.mark.parametrize(("repos", "cap"), [(1, 5), (2, 5), (3, 3), (4, 2), (11, 1)])
def test_the_others_share_the_dispatch_pool(make_config, repos, cap):
    world = _world()
    for index in range(repos):
        _with_work(world, f"pytorch/r{index:02}")

    _tick(world, make_config, max_workers=11)

    assert set(_caps(world).values()) == {cap}


@pytest.mark.parametrize("max_dispatches", [0, -1])
def test_a_paused_dispatch_cap_pauses_every_worker(make_config, max_dispatches):
    world = _world()
    _with_work(world, "pytorch/a")

    _tick(world, make_config, max_dispatches=max_dispatches)

    assert _caps(world) == {"pytorch/a": 0}
    assert fanout_repos.dispatch_cap(None, 2) == 5


def test_a_repo_whose_last_completed_run_is_stale_fails_the_tick(make_config):
    world = _world()
    _with_work(world, "pytorch/a", completed=START - _STALE - 1)
    _with_work(world, "pytorch/b", completed=START - _STALE)
    for repo in ("pytorch/a", "pytorch/b"):
        world.store.items[f"repo#{repo}"]["work_since"] = START - 10 * _STALE

    planner = _tick(world, make_config)

    failure = _failure(planner) or ""
    assert f"pytorch/a: its last completed run is older than {STALE_RUN_TICKS} ticks" in failure
    assert "pytorch/b" not in failure
    assert planner.lines["pytorch/a"].outcome == "invoked"


def test_a_run_of_ticks_with_work_that_just_began_is_never_stale(make_config):
    world = _world()
    _with_work(world, "pytorch/a", completed=START - 100 * _STALE)

    planner = _tick(world, make_config)

    assert _failure(planner) is None


def test_a_repo_that_never_completed_is_stale_only_once_its_work_is_older_than_the_limit(make_config):
    world = _world()
    _with_work(world, "pytorch/a")

    first = _tick(world, make_config)
    world.store.release_lease("pytorch/a", "x")
    world.clock[0] = START + _STALE + 1
    later = _tick(world, make_config)

    assert _failure(first) is None
    assert world.store.read_repo("pytorch/a").config.work_since == START
    assert "pytorch/a: its last completed run is older" in (_failure(later) or "")


def test_a_repo_without_work_forgets_when_its_work_began(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    _tick(world, make_config)
    world.files["pytorch/a"] = file_answer(SHADOW + "extra: 1\n", '"e9"')

    _tick(world, make_config)

    assert world.store.read_repo("pytorch/a").config.work_since is None


def test_a_failed_invoke_fails_the_tick_and_the_other_workers_still_start(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    _with_work(world, "pytorch/b")
    world.failures["invoke pytorch/a"] = RuntimeError("throttled")

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/a"] == fanout_repos.Line("failed", "its worker could not be invoked: throttled")
    assert planner.lines["pytorch/b"].outcome == "invoked"
    assert "pytorch/a: its worker could not be invoked: throttled" in (_failure(planner) or "")


def test_a_rate_limit_reading_configs_skips_the_rest_and_extends_the_shared_latch(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    _with_work(world, "pytorch/b")
    world.files["pytorch/a"] = RateLimitExceededException(403, {}, {"retry-after": "120"})

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/a"] == fanout_repos.Line("skipped", f"its config read stopped: {RATE_LIMITED}")
    assert planner.lines["pytorch/b"] == fanout_repos.Line("skipped", RATE_LIMITED)
    assert world.invoked == []
    assert world.store.read_latch(START) == START + 120
    assert f"finish {TARGET_REPO} optional=True max=30" not in world.events


def test_a_failed_listing_skips_every_stored_repo(make_config):
    world = _world()
    world.failures["listing"] = GithubException(500, {"message": "down"})
    world.store.write_config("pytorch/vision", ConfigRecord(kind="file", text=SHADOW, served=True))

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/vision"] == fanout_repos.Line("skipped", "the installation listing failed")
    assert "the GitHub App installation: the installation listing failed" in (_failure(planner) or "")


def test_a_config_record_that_cannot_be_stored_starts_no_worker(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    real_write = world.store.write_config

    def write_config(repo: str, record: ConfigRecord) -> None:
        if repo == "pytorch/a":
            raise StoreError("refused")
        real_write(repo, record)

    world.store.write_config = write_config  # type: ignore[method-assign]

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/a"] == fanout_repos.Line("failed", "its config record could not be stored")
    assert world.invoked == []
    assert "pytorch/a: the state store failed storing its config record: refused" in (_failure(planner) or "")


def test_a_failed_listing_of_the_stored_repos_skips_the_fan_out(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    world.store.failing = {"scan_repos"}

    planner = _tick(world, make_config)

    assert world.invoked == []
    assert "the state store failed listing the stored repos" in (_failure(planner) or "")


def test_the_planner_stores_each_record_before_any_worker_reads_it(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    seen: list[ConfigRecord] = []
    real_invoke = world.invoke

    def invoke(event: Any) -> None:
        seen.append(world.store.read_repo(event["greenlight_worker"]["repo"]).config)
        real_invoke(event)

    world.invoke = invoke  # type: ignore[method-assign]

    _tick(world, make_config)

    assert [record.text for record in seen] == [SHADOW]
    assert dataclasses.replace(seen[0], read_at=None).served


def test_a_rate_limit_after_a_repo_was_planned_starts_no_worker(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    _with_work(world, "pytorch/b")
    world.files["pytorch/b"] = RateLimitExceededException(403, {}, {})

    planner = _tick(world, make_config)

    assert planner.lines["pytorch/a"] == fanout_repos.Line("skipped", RATE_LIMITED)
    assert world.invoked == []


def test_an_iteration_timeout_invoking_a_worker_propagates(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    world.failures["invoke pytorch/a"] = IterationTimeout("late")

    with pytest.raises(IterationTimeout):
        _tick(world, make_config)


def _invoked(world: World) -> list[str]:
    return [event["greenlight_worker"]["repo"] for event in world.invoked]


def _next_tick(world: World, tick: int) -> None:
    world.reads.clear()
    world.invoked.clear()
    world.clock[0] = START + tick * TICK_INTERVAL.total_seconds()


def test_slow_config_reads_still_start_every_planned_worker_and_the_deferred_repo_is_read_first_next_tick(
    make_config,
):
    repos = ["pytorch/audio", "pytorch/data", "pytorch/text", "pytorch/vision"]
    world = _world(*(identity(repo) for repo in repos), files=dict.fromkeys(repos, file_answer(SHADOW)))
    world.read_seconds = FANOUT_BUDGET.total_seconds() * 4 / 9

    first = _tick(world, make_config)

    assert [repo for repo, _headers in world.reads] == [TARGET_REPO, *repos[:3]]
    assert _invoked(world) == repos[:3]
    assert first.lines["pytorch/vision"] == fanout_repos.Line("deferred", fanout_repos.DEFERRED)
    assert first.lines[TARGET_REPO].outcome == "served"
    assert f"finish {TARGET_REPO} optional=True max=30" in world.events
    assert _failure(first) is None

    _next_tick(world, 1)
    second = _tick(world, make_config)

    assert [repo for repo, _headers in world.reads] == ["pytorch/vision", *repos[:2]]
    assert sorted(_invoked(world)) == ["pytorch/audio", "pytorch/data", "pytorch/vision"]
    assert second.lines["pytorch/text"].outcome == "deferred"

    _next_tick(world, 2)
    third = _tick(world, make_config)

    assert [repo for repo, _headers in world.reads] == ["pytorch/text", *repos[:2]]
    assert len(world.invoked) == 3
    assert _failure(third) is None


def test_a_repo_whose_read_hangs_goes_behind_the_others_so_they_still_get_workers(make_config):
    repos = ["pytorch/audio", "pytorch/hang", "pytorch/vision"]
    world = _world(*(identity(repo) for repo in repos), files=dict.fromkeys(repos, file_answer(SHADOW)))
    world.files["pytorch/hang"] = ConnectionError("read timed out")
    world.read_delays.update({"pytorch/audio": 1.0, "pytorch/hang": 46.0, "pytorch/vision": 1.0})
    attempted = {"pytorch/audio": START - 100, "pytorch/hang": START - 600, "pytorch/vision": START - 100}
    for repo, attempted_at in attempted.items():
        world.store.write_config(
            repo, ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True, attempted_at=attempted_at)
        )

    first = _tick(world, make_config)

    assert [repo for repo, _headers in world.reads] == [TARGET_REPO, "pytorch/hang"]
    assert _invoked(world) == ["pytorch/hang"]
    assert first.lines["pytorch/audio"].outcome == "deferred"
    assert world.store.read_repo("pytorch/hang").config.attempted_at == START
    assert world.store.read_repo("pytorch/audio").config.attempted_at == START - 100

    for tick in (1, 2):
        _next_tick(world, tick)
        _tick(world, make_config)

        assert [repo for repo, _headers in world.reads] == ["pytorch/audio", "pytorch/vision", "pytorch/hang"]
        assert sorted(_invoked(world)) == repos


def test_a_repo_with_stored_work_deferred_past_the_stale_limit_fails_the_tick(make_config):
    world = _world()
    _with_work(world, "pytorch/a")
    world.read_seconds = FANOUT_BUDGET.total_seconds()
    for repo, work_since in (("pytorch/b", START - _STALE - 1), ("pytorch/c", START - _STALE), ("pytorch/d", None)):
        _with_work(world, repo)
        world.store.write_config(
            repo,
            ConfigRecord(kind="file", text=SHADOW, valid_text=SHADOW, served=True, work_since=work_since),
        )

    planner = _tick(world, make_config)

    failure = _failure(planner) or ""
    stale = f"its last completed run is older than {STALE_RUN_TICKS} ticks"
    assert planner.lines["pytorch/b"] == fanout_repos.Line("deferred", f"{fanout_repos.DEFERRED}; {stale}")
    assert f"pytorch/b: {stale}" in failure
    assert "pytorch/c" not in failure
    assert planner.lines["pytorch/d"] == fanout_repos.Line("deferred", fanout_repos.DEFERRED)
    assert _invoked(world) == ["pytorch/a"]


def test_a_fan_out_inside_its_budget_reads_every_repo_and_invokes_their_workers(make_config):
    repos = ["pytorch/audio", "pytorch/vision"]
    world = _world(*(identity(repo) for repo in repos), files=dict.fromkeys(repos, file_answer(SHADOW)))
    world.read_seconds = 1.0

    planner = _tick(world, make_config)

    assert sorted(_caps(world)) == repos
    assert all(planner.lines[repo].outcome == "invoked" for repo in repos)


def test_a_drained_off_repo_gets_no_worker_and_takes_no_worker_slot_until_its_file_changes(make_config):
    world = _world(
        identity("pytorch/data"),
        identity("pytorch/vision"),
        files={"pytorch/data": file_answer(OFF), "pytorch/vision": file_answer(SHADOW)},
    )
    world.store.save_memory("pytorch/data", b"m", owner=None, now=0.0, tick="t0", drain_complete=True)

    planner = _tick(world, make_config, max_workers=1)

    assert planner.lines["pytorch/data"] == fanout_repos.Line("drained")
    assert _caps(world) == {"pytorch/vision": 5}
    assert _failure(planner) is None

    world.files["pytorch/data"] = file_answer(SHADOW, '"e2"')
    world.store.release_lease("pytorch/vision", "worker")
    world.clock[0] = START + TICK_INTERVAL.total_seconds()
    changed = _tick(world, make_config, max_workers=2)

    assert changed.lines["pytorch/data"].outcome == "invoked"
