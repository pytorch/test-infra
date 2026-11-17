from __future__ import annotations

import dataclasses
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pytest
from github import RateLimitExceededException

from greenlight import drain, merge_authz, quota, repo_scan, tick
from greenlight.constants import (
    DISPATCH_REPO,
    OTHER_REPO_REQUEST_BUDGET,
    OTHER_REPO_TIME_BUDGET,
    QUOTA_FLOOR_OTHERS,
    QUOTA_FLOOR_PRIMARY,
    TARGET_REPO,
    TICK_DEADLINE,
)
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_CONFIG, BUILTIN_PYTORCH, RepoConfig, RepoEntry
from greenlight.scan_memory import ScanMemory
from greenlight.snapshot_cache import SnapshotCache

_NOW = datetime(2026, 11, 16, 12, 0, 0)
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "write_permission", "shadow")
_AUDIO = RepoEntry("pytorch/audio", "greenlight", "gate", "merge_rules", "shadow")
_DATA = RepoEntry("pytorch/data", "greenlight", "gate", "merge_rules", "off")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())


def _config(
    *served: RepoEntry,
    safety_only: tuple[tuple[RepoEntry, str], ...] = (),
    refused: tuple[tuple[str, str], ...] = (),
) -> RepoConfig:
    return RepoConfig(served=served, safety_only=safety_only, refused=refused)


class _Client:
    def __init__(self, token: str, meter: quota.RequestMeter | None) -> None:
        self.token = token
        self.meter = meter
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


@dataclass
class _Prepared:
    repo: str
    max_dispatches: int | None
    dispatched: int = 0
    optional_failed: list[int] = field(default_factory=list)


class _Tokens:
    def __init__(self, failures: dict[str, BaseException]) -> None:
        self.failures = failures
        self.asked: list[str] = []

    def dispatch_token(self) -> str:
        failure = self.failures.get(DISPATCH_REPO)
        if failure is not None:
            raise failure
        return "dispatch"

    def repo_token(self, entry: RepoEntry) -> str:
        self.asked.append(entry.repo)
        failure = self.failures.get(entry.repo)
        if failure is not None:
            raise failure
        return f"token-{entry.repo}"


class _Tick:
    """One tick run against fakes; ``events`` records each step in order."""

    def __init__(
        self,
        repo_config: RepoConfig | BaseException,
        *,
        wants: dict[str, int] | None = None,
        failures: dict[tuple[str, str], BaseException] | None = None,
        token_failures: dict[str, BaseException] | None = None,
        quota_reading: tuple[int, int] = (5000, 5000),
        clock: list[float] | None = None,
        drain_failed: tuple[int, ...] = (),
        phase_b_failed: dict[str, list[int]] | None = None,
        quota_failure: BaseException | None = None,
    ) -> None:
        self.repo_config = repo_config
        self.wants = wants or {}
        self.failures = failures or {}
        self.tokens = _Tokens(token_failures or {})
        self.quota_reading = quota_reading
        self.quota_reads = 0
        self.clock = clock if clock is not None else [0.0]
        self.drain_failed = drain_failed
        self.phase_b_failed = phase_b_failed or {}
        self.quota_failure = quota_failure
        self.events: list[str] = []
        self.prepare_kwargs: dict[str, dict[str, Any]] = {}
        self.drain_kwargs: dict[str, dict[str, Any]] = {}
        self.finishes: list[tuple[str, bool, int | None]] = []
        self.clients: list[_Client] = []
        self.memories: dict[str, ScanMemory] = {}
        self.caches: dict[Any, Any] = {}
        self.stops: dict[str, str | None] = {}
        self.cache: SnapshotCache[Any, RepoConfig] = SnapshotCache(
            self._fetch_config, label="repos config", ttl_seconds=0, max_stale_seconds=None, stale_on_broken=True
        )

    def _fetch_config(self, client: _Client) -> RepoConfig:
        self.events.append(f"config with {client.token}")
        if isinstance(self.repo_config, BaseException):
            raise self.repo_config
        return self.repo_config

    def _fail(self, repo: str, step: str) -> None:
        failure = self.failures.get((repo, step))
        if failure is not None:
            raise failure

    def _build(self, token: str, *, meter: quota.RequestMeter | None = None, **_kwargs: Any) -> Any:
        client = _Client(token, meter)
        self.clients.append(client)
        return client

    def _read_quota(self, _client: Any) -> tuple[int, int]:
        self.quota_reads += 1
        if self.quota_failure is not None:
            raise self.quota_failure
        return self.quota_reading

    def _prepare(self, config: Any, *, entry: RepoEntry, max_dispatches: int | None, **kwargs: Any) -> Any:
        repo = entry.repo
        self.events.append(f"prepare {repo}")
        self.prepare_kwargs[repo] = {"config": config, "max_dispatches": max_dispatches, **kwargs}
        kwargs["build_github"].keywords["meter"].count()
        self._fail(repo, "prepare")
        return _Prepared(repo, max_dispatches)

    def _finish(self, prepared: _Prepared, *, optional: bool) -> int:
        self.events.append(f"finish {prepared.repo}" + ("" if optional else " (safety only)"))
        self.finishes.append((prepared.repo, optional, prepared.max_dispatches))
        if optional:
            meter = self.prepare_kwargs[prepared.repo]["build_github"].keywords["meter"]
            meter.count()
            self.stops[prepared.repo] = meter.stop()
            cap = prepared.max_dispatches
            want = self.wants.get(prepared.repo, 0)
            prepared.dispatched = want if cap is None else min(want, cap)
            prepared.optional_failed.extend(self.phase_b_failed.get(prepared.repo, ()))
            self._fail(prepared.repo, "finish")
        else:
            self._fail(prepared.repo, "safety")
        return prepared.dispatched

    def _drain(self, config: Any, *, repo: str, **kwargs: Any) -> drain.DrainReport:
        self.events.append(f"drain {repo}")
        self.drain_kwargs[repo] = {"config": config, **kwargs}
        self._fail(repo, "drain")
        return drain.DrainReport(1, 0, 0, False, "x", self.drain_failed)

    def _monotonic(self) -> float:
        return self.clock.pop(0) if len(self.clock) > 1 else self.clock[0]

    def run(self, make_config: Any, *, max_dispatches: int | None = 30) -> None:
        tick.run_tick(
            make_config(),
            tokens=self.tokens,
            config_cache=self.cache,
            eligibility_caches=self.caches,
            memories=self.memories,
            bot_login="bot[bot]",
            max_dispatches=max_dispatches,
            ref="main",
            timeout_minutes=45,
            build_github=self._build,
            run_prepare=self._prepare,
            run_finish=self._finish,
            run_drain=self._drain,
            read_quota=self._read_quota,
            monotonic=self._monotonic,
            now=lambda: _NOW,
        )


def _caps(run: _Tick) -> dict[str, int | None]:
    return {repo: cap for repo, optional, cap in run.finishes if optional}


def test_phase_a_runs_every_repos_safety_work_before_phase_b_and_the_primary_comes_first(make_config):
    run = _Tick(_config(_VISION, _DATA, BUILTIN_PYTORCH))

    run.run(make_config)

    assert run.events == [
        "config with dispatch",
        "prepare pytorch/pytorch",
        "drain pytorch/data",
        "finish pytorch/pytorch",
        "prepare pytorch/vision",
        "finish pytorch/vision",
    ]
    assert run.tokens.asked == [TARGET_REPO, "pytorch/vision", "pytorch/data"]


def test_each_repo_works_with_its_own_token_meter_memory_and_the_shared_latch(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _DATA))

    run.run(make_config)

    primary = run.prepare_kwargs[TARGET_REPO]
    vision = run.prepare_kwargs["pytorch/vision"]
    assert primary["config"].github_token == f"token-{TARGET_REPO}"
    assert vision["config"].github_token == "token-pytorch/vision"
    assert primary["config"].dispatch_token == vision["dispatch_token"] == primary["dispatch_token"] == "dispatch"
    assert primary["max_dispatches"] == 0
    assert primary["memory"] is run.memories[TARGET_REPO]
    assert vision["memory"] is run.memories["pytorch/vision"]
    assert primary["cancel_event"] is vision["cancel_event"]
    primary_meter = primary["build_github"].keywords["meter"]
    vision_meter = vision["build_github"].keywords["meter"]
    assert primary_meter.repo == TARGET_REPO
    assert vision_meter.repo == "pytorch/vision"
    assert primary["cancel_event"] is primary_meter.latch
    assert (primary["ref"], primary["timeout_minutes"], primary["bot_login"]) == ("main", 45, "bot[bot]")
    off = run.drain_kwargs["pytorch/data"]
    assert off["config"].github_token == "token-pytorch/data"
    assert off["dispatch_token"] == "dispatch"
    assert off["cancel_event"] is primary["cancel_event"]
    assert off["memory"] is run.memories["pytorch/data"]
    assert off["build_github"].keywords["meter"].repo == "pytorch/data"
    assert all(client.closed == 1 for client in run.clients)


def test_each_repos_eligibility_is_read_through_its_cache_with_its_token_and_meter(make_config, monkeypatch):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION))
    run.run(make_config)
    built: list[tuple[str, quota.RequestMeter | None]] = []

    def build_client(token: str, *, meter: quota.RequestMeter | None) -> _Client:
        built.append((token, meter))
        return _Client(token, meter)

    monkeypatch.setattr("greenlight.github_client.build_client", build_client)
    monkeypatch.setattr("greenlight.writers.resolve_writers", lambda _client, _repo: _SNAPSHOT)

    assert run.prepare_kwargs["pytorch/vision"]["resolve_merge_rules"]() is _SNAPSHOT

    meter = run.prepare_kwargs["pytorch/vision"]["build_github"].keywords["meter"]
    assert built == [("token-pytorch/vision", meter)]
    assert set(run.caches) == {(TARGET_REPO, "merge_rules"), ("pytorch/vision", "write_permission")}


def test_a_non_off_repo_forgets_its_drain_and_an_off_repo_failing_on_a_pr_is_an_error(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _DATA), drain_failed=(4,))
    memory = run.memories[TARGET_REPO] = ScanMemory()
    memory.off_since(datetime(2026, 1, 1))

    with pytest.raises(RuntimeError, match=r"pytorch/data: the drain failed on 1 PR\(s\): \[4\]"):
        run.run(make_config)

    assert memory.off_since(_NOW) == _NOW


def test_a_failing_repo_is_isolated_and_named_in_the_error(make_config, caplog):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _AUDIO), failures={("pytorch/vision", "prepare"): ValueError("boom")})

    with caplog.at_level(logging.ERROR, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == "pytorch/vision: Phase B failed: boom"
    assert "finish pytorch/audio" in run.events
    assert "finish pytorch/pytorch" in run.events
    assert any(record.exc_info for record in caplog.records if "pytorch/vision: Phase B failed" in record.getMessage())


@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(RateLimitExceededException(403, {"message": "rate limit"}, {}), id="github"),
        pytest.param(quota.RateLimitStop("pytorch/pytorch: latched"), id="latch"),
    ],
)
def test_a_rate_limit_in_phase_a_skips_everything_after_it_and_still_logs_the_counts(make_config, caplog, failure):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _DATA), failures={(TARGET_REPO, "prepare"): failure})

    with caplog.at_level(logging.INFO, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert run.events == ["config with dispatch", "prepare pytorch/pytorch"]
    assert str(excinfo.value).split("; ") == [
        f"{TARGET_REPO}: Phase A (safety work) stopped: a rate limit stopped this tick's GitHub work",
        "pytorch/vision: Phase A skipped: a rate limit stopped this tick's GitHub work",
        "pytorch/data: Phase A skipped: a rate limit stopped this tick's GitHub work",
    ]
    assert run.prepare_kwargs[TARGET_REPO]["cancel_event"].is_set()
    assert run.quota_reads == 2
    messages = [record.getMessage() for record in caplog.records]
    assert (
        f"{TARGET_REPO}: 1 GitHub request(s) in Phase A, 0 in Phase B; the installation had 5000 of 5000 requests "
        "left at the tick's start, 4999 of 5000 at its end"
    ) in messages
    assert any(message.startswith("pytorch/data: 0 GitHub request(s) in Phase A") for message in messages)


def test_a_latch_set_inside_a_repos_work_skips_every_repo_after_it(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION))
    original = run._prepare

    def prepare(config: Any, **kwargs: Any) -> Any:
        kwargs["cancel_event"].set()
        return original(config, **kwargs)

    run._prepare = prepare  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="pytorch/vision: Phase A skipped") as excinfo:
        run.run(make_config)

    assert f"{TARGET_REPO}: Phase B skipped" in str(excinfo.value)
    assert "finish pytorch/pytorch (safety only)" in run.events


def test_a_rate_limit_reading_the_config_skips_the_builtin_entry(make_config):
    run = _Tick(RateLimitExceededException(403, {"message": "rate limit"}, {}))

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value).split("; ") == [
        "repos config not read: a rate limit stopped this tick's GitHub work",
        f"{TARGET_REPO}: Phase A skipped: a rate limit stopped this tick's GitHub work",
    ]
    assert run.tokens.asked == []


def test_an_unreadable_config_serves_the_builtin_entry_and_is_an_error(make_config):
    run = _Tick(ValueError("broken yaml"))

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == "repos config unreadable, serving only the built-in entry: broken yaml"
    assert "finish pytorch/pytorch" in run.events


def test_safety_only_and_refused_entries_are_errors_and_get_no_optional_work(make_config):
    run = _Tick(
        _config(
            safety_only=((BUILTIN_PYTORCH, "its entry is missing"), (_VISION, "unknown key(s) ['x']")),
            refused=(("pytorch/audio", "mode is missing"),),
        )
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value).split("; ") == [
        f"{TARGET_REPO} is safety-only: its entry is missing",
        "pytorch/vision is safety-only: unknown key(s) ['x']",
        "pytorch/audio is refused: mode is missing",
    ]
    assert run.events == ["config with dispatch", "prepare pytorch/pytorch", "finish pytorch/pytorch (safety only)"]
    assert run.tokens.asked == [TARGET_REPO]


def test_the_safety_works_failures_of_a_repo_phase_b_did_not_finish_are_reported(make_config):
    run = _Tick(
        _config(safety_only=((BUILTIN_PYTORCH, "its entry is missing"),)),
        failures={(TARGET_REPO, "safety"): RuntimeError("1 PR(s) failed during scan: [7]")},
    )

    with pytest.raises(RuntimeError, match=r"Phase A \(safety work\) failed: 1 PR\(s\) failed during scan: \[7\]"):
        run.run(make_config)


def test_a_repo_whose_token_or_identity_fails_is_isolated(make_config):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION, _AUDIO),
        token_failures={"pytorch/vision": repo_scan.RepoUnavailable("the GitHub App is not installed on it")},
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == "pytorch/vision: no work this tick: the GitHub App is not installed on it"
    assert "prepare pytorch/vision" not in run.events
    assert "finish pytorch/audio" in run.events


def test_any_other_token_failure_is_that_repos_error(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), token_failures={"pytorch/vision": OSError("network")})

    with pytest.raises(RuntimeError, match="pytorch/vision: its token failed: network"):
        run.run(make_config)

    assert _caps(run) == {TARGET_REPO: 30}


def test_a_plain_iteration_timeout_aborts_the_tick(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), failures={(TARGET_REPO, "prepare"): IterationTimeout("late")})

    with pytest.raises(IterationTimeout):
        run.run(make_config)

    assert run.tokens.asked == [TARGET_REPO]


def _full_tick_done(run: _Tick, repo: str) -> None:
    run.memories.setdefault(repo, ScanMemory()).mark_full_tick(_NOW)


@pytest.mark.parametrize("repo", [TARGET_REPO, "pytorch/vision"])
def test_a_budget_cut_on_a_full_tick_is_an_error_and_its_safety_failures_are_reported(make_config, repo):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION),
        failures={(repo, "finish"): quota.RepoBudgetExceeded(f"{repo}: past its deadline")},
    )

    with pytest.raises(RuntimeError, match=f"{repo}: Phase B cut short: .*; its full tick did not fit"):
        run.run(make_config)

    assert f"finish {repo} (safety only)" in run.events


def test_a_budget_cut_on_a_fast_tick_is_a_warning(make_config, caplog):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION),
        failures={("pytorch/vision", "finish"): quota.RepoBudgetExceeded("pytorch/vision: past its deadline")},
    )
    _full_tick_done(run, "pytorch/vision")

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        run.run(make_config)

    assert "pytorch/vision: Phase B cut short: pytorch/vision: past its deadline; its PRs wait for the next tick" in (
        caplog.text
    )


@pytest.mark.parametrize("fast", [False, True])
def test_a_missed_turn_is_an_error_on_a_full_tick_and_a_warning_on_a_fast_one(make_config, caplog, fast):
    late = TICK_DEADLINE.total_seconds() + 1
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), clock=[0.0, late])
    if fast:
        _full_tick_done(run, "pytorch/vision")

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        if fast:
            run.run(make_config)
        else:
            with pytest.raises(RuntimeError, match="pytorch/vision: no Phase B turn: the tick's deadline had passed"):
                run.run(make_config)

    assert "prepare pytorch/vision" not in run.events
    assert ("its PRs wait for the next tick" in caplog.text) is fast


def test_the_primarys_stop_is_its_floor_alone_and_the_others_have_a_budget_and_a_deadline(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), quota_reading=(QUOTA_FLOOR_PRIMARY + 10, 5000))

    run.run(make_config)

    assert run.stops[TARGET_REPO] is None
    assert run.stops["pytorch/vision"] == (
        f"the installation has {QUOTA_FLOOR_PRIMARY + 10 - 2} requests left, below the floor of {QUOTA_FLOOR_OTHERS}"
    )
    meter = run.prepare_kwargs["pytorch/vision"]["build_github"].keywords["meter"]
    assert (meter.phase, meter.requests("A"), meter.requests("B")) == ("B", 0, 2)
    assert run.prepare_kwargs[TARGET_REPO]["build_github"].keywords["meter"].requests("A") == 1


def test_another_repos_deadline_is_its_time_budget_inside_the_tick_deadline(make_config):
    turn = TICK_DEADLINE.total_seconds() - 5
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), clock=[0.0, turn, turn + 5])

    run.run(make_config)

    assert turn + 5 < turn + OTHER_REPO_TIME_BUDGET.total_seconds()
    assert run.stops["pytorch/vision"] == "past its deadline"


def test_another_repos_deadline_is_its_time_budget_early_in_the_tick(make_config):
    budget = OTHER_REPO_TIME_BUDGET.total_seconds()
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), clock=[0.0, 10.0, 10.0 + budget - 1, 10.0 + budget])

    run.run(make_config)

    assert run.stops["pytorch/vision"] is None
    meter = run.prepare_kwargs["pytorch/vision"]["build_github"].keywords["meter"]
    assert meter.stop() == "past its deadline"


def test_another_repos_request_budget_stops_it(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION))
    run.run(make_config)
    meter = run.prepare_kwargs["pytorch/vision"]["build_github"].keywords["meter"]
    for _ in range(OTHER_REPO_REQUEST_BUDGET):
        meter.count()

    assert meter.stop() == f"its request budget of {OTHER_REPO_REQUEST_BUDGET} is spent"


def test_the_quota_is_read_at_the_start_before_each_phase_with_work_and_at_the_end(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _DATA))

    run.run(make_config)

    assert run.quota_reads == 6
    assert [client.token for client in run.clients if client.meter is None] == ["dispatch", "dispatch"]


@pytest.mark.parametrize(
    ("max_dispatches", "wants", "caps"),
    [
        pytest.param(30, {TARGET_REPO: 100}, {TARGET_REPO: 25, "pytorch/vision": 5}, id="30-primary-uses-its-share"),
        pytest.param(30, {TARGET_REPO: 10}, {TARGET_REPO: 25, "pytorch/vision": 20}, id="30-primary-leaves-some"),
        pytest.param(3, {TARGET_REPO: 100}, {TARGET_REPO: 0, "pytorch/vision": 3}, id="3"),
        pytest.param(0, {TARGET_REPO: 100}, {TARGET_REPO: 0, "pytorch/vision": 0}, id="0"),
        pytest.param(None, {TARGET_REPO: 100}, {TARGET_REPO: None, "pytorch/vision": None}, id="uncapped"),
    ],
)
def test_the_dispatch_share_with_another_repo(make_config, max_dispatches, wants, caps):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), wants=wants)

    run.run(make_config, max_dispatches=max_dispatches)

    assert _caps(run) == caps


@pytest.mark.parametrize(("max_dispatches", "cap"), [(30, 30), (3, 3), (0, 0), (None, None), (-2, 0)])
def test_the_dispatch_share_without_another_repo(make_config, max_dispatches, cap):
    run = _Tick(_config(BUILTIN_PYTORCH, _DATA))

    run.run(make_config, max_dispatches=max_dispatches)

    assert _caps(run) == {TARGET_REPO: cap}


def test_the_other_repos_share_what_is_left_in_order(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _AUDIO), wants={TARGET_REPO: 20, "pytorch/vision": 7})

    run.run(make_config, max_dispatches=30)

    assert _caps(run) == {TARGET_REPO: 25, "pytorch/vision": 10, "pytorch/audio": 3}


def test_a_failed_finish_still_counts_its_dispatches_against_the_share(make_config):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION),
        wants={TARGET_REPO: 25},
        failures={(TARGET_REPO, "finish"): RuntimeError("1 PR(s) failed during scan: [3]")},
    )

    with pytest.raises(RuntimeError, match=r"Phase B failed: 1 PR\(s\) failed during scan: \[3\]"):
        run.run(make_config, max_dispatches=30)

    assert _caps(run) == {TARGET_REPO: 25, "pytorch/vision": 5}
    assert "finish pytorch/pytorch (safety only)" not in run.events


def test_an_off_primary_drains_and_the_others_share_the_whole_cap(make_config):
    run = _Tick(_config(dataclasses.replace(BUILTIN_PYTORCH, mode="off"), _VISION))

    run.run(make_config, max_dispatches=30)

    assert run.events == [
        "config with dispatch",
        "drain pytorch/pytorch",
        "prepare pytorch/vision",
        "finish pytorch/vision",
    ]
    assert _caps(run) == {"pytorch/vision": 30}


class _IdentityClient:
    def __init__(self, data: dict[str, object]) -> None:
        self.requester = self
        self.data = data
        self.closed = 0

    def requestJsonAndCheck(self, verb: str, url: str) -> tuple[dict[str, str], dict[str, object]]:
        return {}, {**self.data, "url": url}

    def close(self) -> None:
        self.closed += 1


def test_env_tokens_use_the_scan_token_for_every_repo_after_its_live_checks(make_config):
    built: list[_IdentityClient] = []

    def build(_token: str) -> Any:
        built.append(_IdentityClient({"full_name": "pytorch/vision", "private": False, "default_branch": "main"}))
        return built[-1]

    tokens = tick.EnvTokens(make_config(github_token="scan"), build)

    assert tokens.repo_token(_VISION) == "scan"
    assert tokens.dispatch_token() == "scan"
    assert tick.EnvTokens(make_config(github_token="scan", dispatch_token="d")).dispatch_token() == "d"
    assert [client.closed for client in built] == [1]


@pytest.mark.parametrize(
    ("identity", "reason"),
    [
        pytest.param({"full_name": "pytorch/Vision"}, "GitHub names it 'pytorch/Vision'", id="case"),
        pytest.param({"private": True}, "it is private", id="private"),
        pytest.param({"default_branch": "master"}, "its default branch is 'master'", id="branch"),
    ],
)
def test_env_tokens_refuse_a_repo_failing_a_live_check(make_config, identity, reason):
    data: dict[str, object] = {"full_name": "pytorch/vision", "private": False, "default_branch": "main", **identity}
    tokens = tick.EnvTokens(make_config(github_token="scan"), lambda _token: _IdentityClient(data))  # type: ignore[arg-type,return-value]

    with pytest.raises(repo_scan.RepoUnavailable, match=reason):
        tokens.repo_token(_VISION)


def test_env_tokens_need_the_scan_token(make_config):
    tokens = tick.EnvTokens(make_config(dispatch_token="d"))

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        tokens.dispatch_token()
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        tokens.repo_token(_VISION)


def test_a_tick_without_a_scan_token_fails_before_any_github_work(make_config):
    with pytest.raises(RuntimeError) as excinfo:
        tick.run_tick(
            make_config(),
            tokens=tick.EnvTokens(make_config()),
            config_cache=SnapshotCache(
                lambda _client: BUILTIN_CONFIG,
                label="repos config",
                ttl_seconds=0,
                max_stale_seconds=None,
                stale_on_broken=True,
            ),
            eligibility_caches={},
            memories={},
            bot_login="",
            max_dispatches=None,
            ref="main",
            timeout_minutes=45,
            build_github=lambda *_args, **_kwargs: pytest.fail("built a client"),
        )

    assert str(excinfo.value).split("; ") == [
        f"{DISPATCH_REPO}: the dispatch token failed: PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub",
        f"{TARGET_REPO}: its token failed: PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub",
    ]


def test_a_scan_prepare_stops_early_gets_no_finish_and_no_error(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION))
    original = run._prepare

    def prepare(config: Any, **kwargs: Any) -> Any:
        prepared = original(config, **kwargs)
        return None if prepared.repo == "pytorch/vision" else prepared

    run._prepare = prepare  # type: ignore[method-assign]

    run.run(make_config)

    assert run.events[-1] == "prepare pytorch/vision"
    assert _caps(run) == {TARGET_REPO: 25}


def test_an_iteration_timeout_reading_the_config_aborts_the_tick(make_config):
    run = _Tick(IterationTimeout("late"))

    with pytest.raises(IterationTimeout):
        run.run(make_config)

    assert run.tokens.asked == []


def test_a_config_read_failure_the_reader_does_not_absorb_propagates(make_config, monkeypatch):
    def read_config(*_args: Any) -> RepoConfig:
        raise KeyError("unexpected")

    monkeypatch.setattr("greenlight.repo_scan.read_config", read_config)

    with pytest.raises(KeyError):
        _Tick(_config(BUILTIN_PYTORCH)).run(make_config)


def test_a_rate_limit_minting_a_repo_token_stops_the_ticks_github_work(make_config):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION, _AUDIO),
        token_failures={"pytorch/vision": RateLimitExceededException(403, {"message": "rate limit"}, {})},
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value).split("; ") == [
        "pytorch/vision: its token stopped: a rate limit stopped this tick's GitHub work",
        "pytorch/audio: Phase A skipped: a rate limit stopped this tick's GitHub work",
        f"{TARGET_REPO}: Phase B skipped: a rate limit stopped this tick's GitHub work",
    ]
    assert run.tokens.asked == [TARGET_REPO, "pytorch/vision"]
    assert "finish pytorch/pytorch (safety only)" in run.events


def test_a_rate_limited_quota_read_latches_the_tick_and_is_named_in_its_error(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), quota_failure=RateLimitExceededException(403, {"message": "x"}, {}))

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == f"{TARGET_REPO}: Phase A skipped: a rate limit stopped this tick's GitHub work"
    assert run.quota_reads == 1
    assert run.tokens.asked == []
    assert run.events == []


def test_a_latch_the_last_repos_work_set_without_raising_still_fails_the_tick(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION))
    original = run._finish

    def finish(prepared: _Prepared, *, optional: bool) -> int:
        if prepared.repo == "pytorch/vision":
            run.prepare_kwargs[prepared.repo]["cancel_event"].set()
        return original(prepared, optional=optional)

    run._finish = finish  # type: ignore[method-assign]

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == "a rate limit stopped this tick's GitHub work"
    assert "finish pytorch/vision" in run.events


def test_a_failed_dispatch_token_serves_the_builtin_entry_runs_phase_a_and_skips_phase_b(make_config, caplog):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION), token_failures={DISPATCH_REPO: OSError("mint failed")})

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == f"{DISPATCH_REPO}: the dispatch token failed: mint failed"
    assert run.events == ["prepare pytorch/pytorch", "finish pytorch/pytorch (safety only)"]
    assert run.tokens.asked == [TARGET_REPO]
    primary = run.prepare_kwargs[TARGET_REPO]
    assert (primary["dispatch_token"], primary["max_dispatches"]) == (None, 0)
    assert primary["config"].github_token == f"token-{TARGET_REPO}"
    assert (run.quota_reads, run.clients) == (0, [])
    assert "repos config not read: there is no dispatch token; serving only the built-in entry" in caplog.text
    assert "no Phase B this tick: without the dispatch token no review can be dispatched" in caplog.text


def test_without_the_dispatch_token_a_drain_runs_with_none(make_config, monkeypatch):
    off = dataclasses.replace(BUILTIN_PYTORCH, mode="off")
    monkeypatch.setattr(tick, "BUILTIN_CONFIG", _config(off))
    run = _Tick(_config(off), token_failures={DISPATCH_REPO: OSError("mint failed")})

    with pytest.raises(RuntimeError, match="the dispatch token failed"):
        run.run(make_config)

    assert run.events == [f"drain {TARGET_REPO}"]
    assert run.drain_kwargs[TARGET_REPO]["dispatch_token"] is None


def test_a_rate_limit_minting_the_dispatch_token_skips_every_repo(make_config):
    run = _Tick(
        _config(BUILTIN_PYTORCH),
        token_failures={DISPATCH_REPO: RateLimitExceededException(403, {"message": "rate limit"}, {})},
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value).split("; ") == [
        f"{DISPATCH_REPO}: the dispatch token stopped: a rate limit stopped this tick's GitHub work",
        f"{TARGET_REPO}: Phase A skipped: a rate limit stopped this tick's GitHub work",
    ]
    assert run.events == []


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        pytest.param(
            quota.RepoBudgetExceeded("pytorch/pytorch: floor"),
            f"{TARGET_REPO}: Phase B failed on 1 PR(s) before it stopped: [123]; its full tick did not fit",
            id="cut",
        ),
        pytest.param(
            quota.RateLimitStop("pytorch/pytorch: latched"),
            f"{TARGET_REPO}: Phase B failed on 1 PR(s) before it stopped: [123]",
            id="rate-limit",
        ),
    ],
)
def test_phase_b_failures_go_with_the_stop_and_not_with_the_safety_work(make_config, failure, message):
    run = _Tick(
        _config(BUILTIN_PYTORCH),
        failures={(TARGET_REPO, "finish"): failure},
        phase_b_failed={TARGET_REPO: [123, 123]},
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value).endswith(f"; {message}")
    assert "Phase A (safety work)" not in str(excinfo.value)
    assert "finish pytorch/pytorch (safety only)" in run.events


def test_phase_b_failures_of_a_fast_tick_cut_are_a_warning(make_config, caplog):
    run = _Tick(
        _config(BUILTIN_PYTORCH),
        failures={(TARGET_REPO, "finish"): quota.RepoBudgetExceeded("pytorch/pytorch: floor")},
        phase_b_failed={TARGET_REPO: [123]},
    )
    _full_tick_done(run, TARGET_REPO)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        run.run(make_config)

    assert "Phase B failed on 1 PR(s) before it stopped: [123]; its PRs wait for the next tick" in caplog.text


@pytest.mark.parametrize("fast", [False, True])
def test_a_repo_left_no_dispatches_by_a_positive_max_gets_no_turn(make_config, caplog, fast):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _AUDIO), wants={TARGET_REPO: 100, "pytorch/vision": 100})
    if fast:
        _full_tick_done(run, "pytorch/audio")

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        if fast:
            run.run(make_config, max_dispatches=30)
        else:
            with pytest.raises(RuntimeError) as excinfo:
                run.run(make_config, max_dispatches=30)
            assert str(excinfo.value) == "pytorch/audio: no Phase B turn: --max was used up; its full tick did not fit"

    assert _caps(run) == {TARGET_REPO: 25, "pytorch/vision": 5}
    assert "prepare pytorch/audio" not in run.events
    assert ("pytorch/audio: no Phase B turn: --max was used up; its PRs wait for the next tick" in caplog.text) is fast


def test_max_zero_pauses_every_repo_but_each_still_runs_with_limit_zero(make_config):
    run = _Tick(_config(BUILTIN_PYTORCH, _VISION, _AUDIO), wants={TARGET_REPO: 100, "pytorch/vision": 100})

    run.run(make_config, max_dispatches=0)

    assert _caps(run) == {TARGET_REPO: 0, "pytorch/vision": 0, "pytorch/audio": 0}


def test_a_safety_only_gate_entry_gets_nothing_and_forgets_its_drain(make_config):
    memory = ScanMemory()
    memory.off_since(datetime(2026, 1, 1))
    run = _Tick(_config(BUILTIN_PYTORCH, safety_only=((_VISION, "unknown key(s) ['x']"),)))
    run.memories["pytorch/vision"] = memory

    with pytest.raises(RuntimeError, match=r"pytorch/vision is safety-only"):
        run.run(make_config)

    assert run.tokens.asked == [TARGET_REPO]
    assert "prepare pytorch/vision" not in run.events
    assert memory.off_since(_NOW) == _NOW


def test_a_cut_while_another_repo_prepares_reports_the_cut_alone(make_config):
    run = _Tick(
        _config(BUILTIN_PYTORCH, _VISION),
        failures={("pytorch/vision", "prepare"): quota.RepoBudgetExceeded("pytorch/vision: past its deadline")},
    )

    with pytest.raises(RuntimeError) as excinfo:
        run.run(make_config)

    assert str(excinfo.value) == (
        "pytorch/vision: Phase B cut short: pytorch/vision: past its deadline; its full tick did not fit"
    )
    assert "pytorch/vision" not in {repo for repo, _optional, _cap in run.finishes}
