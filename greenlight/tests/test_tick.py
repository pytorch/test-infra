from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import drain, merge_authz, quota, tick
from greenlight.constants import (
    OTHER_REPO_REQUEST_BUDGET,
    QUOTA_FLOOR_OTHERS,
    QUOTA_FLOOR_PRIMARY,
    TARGET_REPO,
    WORKER_DEADLINE,
)
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.scan_memory import ScanMemory
from greenlight.state_store import InProcessStore
from greenlight.tick_outcomes import RATE_LIMITED, Outcomes

_NOW = datetime(2026, 11, 24, 12, 0, 0)
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "write_permission", "shadow")
_OFF = RepoEntry("pytorch/data", "greenlight", "gate", "merge_rules", "off")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())


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


class _Fakes:
    """The seams of one invocation; ``events`` records each step in order."""

    def __init__(
        self,
        *,
        failures: dict[str, BaseException] | None = None,
        quota_reading: tuple[int, int] = (5000, 5000),
        clock: list[float] | None = None,
        drain_failed: tuple[int, ...] = (),
        optional_failed: tuple[int, ...] = (),
    ) -> None:
        self.failures = failures or {}
        self.quota_reading = quota_reading
        self.clock = clock if clock is not None else [0.0]
        self.drain_failed = drain_failed
        self.optional_failed = optional_failed
        self.events: list[str] = []
        self.prepare_kwargs: dict[str, Any] = {}
        self.drain_kwargs: dict[str, Any] = {}
        self.stops: list[str | None] = []
        self.clients: list[_Client] = []

    def _fail(self, step: str) -> None:
        failure = self.failures.get(step)
        if failure is not None:
            raise failure

    def build(self, token: str, *, meter: quota.RequestMeter | None = None, **_kwargs: Any) -> Any:
        client = _Client(token, meter)
        self.clients.append(client)
        return client

    def prepare(self, config: Any, *, entry: RepoEntry, max_dispatches: int | None, **kwargs: Any) -> Any:
        self.events.append(f"prepare {entry.repo} max={max_dispatches}")
        self.prepare_kwargs = {"config": config, "max_dispatches": max_dispatches, **kwargs}
        kwargs["build_github"].keywords["meter"].count()
        self._fail("prepare")
        return _Prepared(entry.repo, max_dispatches)

    def finish(self, prepared: _Prepared, *, optional: bool) -> int:
        self.events.append(f"finish {prepared.repo} optional={optional} max={prepared.max_dispatches}")
        if optional:
            meter = self.prepare_kwargs["build_github"].keywords["meter"]
            meter.count()
            self.stops.append(meter.stop())
            prepared.optional_failed.extend(self.optional_failed)
            self._fail("finish")
        else:
            self._fail("safety")
        return prepared.dispatched

    def drain(self, config: Any, *, repo: str, **kwargs: Any) -> drain.DrainReport:
        self.events.append(f"drain {repo}")
        self.drain_kwargs = {"config": config, **kwargs}
        self._fail("drain")
        return drain.DrainReport(1, 0, 0, False, "x", self.drain_failed)

    def read_quota(self, _client: Any) -> tuple[int, int]:
        return self.quota_reading

    def monotonic(self) -> float:
        return self.clock.pop(0) if len(self.clock) > 1 else self.clock[0]

    def seams(self) -> tick.Seams:
        return tick.Seams(
            build_github=self.build,
            run_prepare=self.prepare,
            run_finish=self.finish,
            run_drain=self.drain,
            read_quota=self.read_quota,
            monotonic=self.monotonic,
            clock=lambda: 1000.0,
            now=lambda: _NOW,
        )


def _run(
    fakes: _Fakes,
    stack: contextlib.ExitStack,
    make_config: Any,
    entry: RepoEntry,
    *,
    served: bool = True,
    dispatch_token: str | None = "dispatch",  # noqa: S107
    memory: ScanMemory | None = None,
    max_dispatches: int | None = 5,
) -> tick.RepoRun:
    invocation = tick.Invocation(stack, fakes.seams())
    invocation.watch_quota("repo-token")
    return tick.RepoRun(
        invocation,
        tick.run_config(make_config(), "repo-token", dispatch_token),
        entry,
        served,
        ScanMemory() if memory is None else memory,
        InProcessStore(),
        "bot[bot]",
        max_dispatches,
        "main",
        45,
    )


def _all(run: tick.RepoRun) -> list[str]:
    run.phase_a()
    run.phase_b()
    run.close()
    return run.invocation.outcomes.errors


def test_the_primary_prepares_in_phase_a_and_finishes_its_optional_work_in_phase_b(make_config, monkeypatch):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, BUILTIN_PYTORCH, max_dispatches=30)
        errors = _all(run)

        kwargs = fakes.prepare_kwargs
        assert kwargs["cancel_event"] is run.invocation.meter.latch
        assert kwargs["dispatch_token"] == "dispatch"
        assert kwargs["config"].github_token == "repo-token"
        assert kwargs["build_github"].keywords["meter"] is run.invocation.meter.meter(TARGET_REPO)
        assert kwargs["memory"] is run.memory
        assert (kwargs["ref"], kwargs["timeout_minutes"], kwargs["bot_login"]) == ("main", 45, "bot[bot]")
        monkeypatch.setattr(merge_authz, "resolve_merge_rules", lambda _client, _repo: _SNAPSHOT)
        assert kwargs["resolve_merge_rules"]() == _SNAPSHOT

    assert errors == []
    assert fakes.events == [
        f"prepare {TARGET_REPO} max=0",
        f"finish {TARGET_REPO} optional=True max=30",
    ]
    meter = run.invocation.meter.meter(TARGET_REPO)
    assert (meter.requests("A"), meter.requests("B")) == (1, 1)
    assert all(client.closed == 1 for client in fakes.clients)


def test_a_served_gate_repo_prepares_and_finishes_in_phase_b_only(make_config):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        run.phase_a()
        assert fakes.events == []
        run.phase_b()
        run.close()

    assert fakes.events == ["prepare pytorch/vision max=5", "finish pytorch/vision optional=True max=5"]
    assert run.invocation.meter.meter("pytorch/vision").requests("B") == 2


def test_an_off_repo_drains_in_phase_a_with_the_dispatch_token_and_its_failures_are_its_error(make_config):
    fakes = _Fakes(drain_failed=(4, 9))
    memory = ScanMemory()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _OFF, memory=memory)
        errors = _all(run)

    assert fakes.events == ["drain pytorch/data"]
    assert fakes.drain_kwargs["dispatch_token"] == "dispatch"
    assert fakes.drain_kwargs["memory"] is memory
    assert fakes.drain_kwargs["cancel_event"] is run.invocation.meter.latch
    assert errors == ["pytorch/data: the drain failed on 2 PR(s): [4, 9]"]


def test_a_safety_only_gate_repo_runs_nothing_and_forgets_its_drain(make_config):
    fakes = _Fakes()
    memory = ScanMemory()
    memory.off_since(_NOW)
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _VISION, served=False, memory=memory))

    assert fakes.events == []
    assert errors == []
    assert memory.off_since(datetime(2027, 1, 1)) == datetime(2027, 1, 1)


@pytest.mark.parametrize(
    ("entry", "floor", "budget"),
    [(BUILTIN_PYTORCH, QUOTA_FLOOR_PRIMARY, None), (_VISION, QUOTA_FLOOR_OTHERS, OTHER_REPO_REQUEST_BUDGET)],
)
def test_phase_b_stops_at_the_worker_deadline_below_its_floor_and_past_its_budget(make_config, entry, floor, budget):
    deadline = WORKER_DEADLINE.total_seconds()
    for quota_left, now, expected in [
        (floor + 10, 0.0, None),
        (floor - 1, 0.0, f"the installation has {floor - 3} requests left, below the floor of {floor}"),
        (5000, deadline, "past its deadline"),
    ]:
        fakes = _Fakes(quota_reading=(quota_left, 5000), clock=[0.0, now])
        with contextlib.ExitStack() as stack:
            run = _run(fakes, stack, make_config, entry)
            run.phase_b()
        assert fakes.stops == [expected], (entry.repo, quota_left, now)
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, entry)
        meter = run.invocation.meter.meter(entry.repo)
        meter.phase = "B"
        for _ in range(OTHER_REPO_REQUEST_BUDGET):
            meter.count()
        run.phase_b()
    assert fakes.stops == [None if budget is None else f"its request budget of {budget} is spent"]


@pytest.mark.parametrize(("due", "is_error"), [(True, True), (False, False)])
def test_a_cut_is_the_repos_error_only_when_its_full_tick_was_due(make_config, caplog, due, is_error):
    fakes = _Fakes(failures={"finish": quota.RepoBudgetExceeded("pytorch/vision: past its deadline")})
    memory = ScanMemory()
    if not due:
        memory.mark_full_tick(_NOW)
    with contextlib.ExitStack() as stack, caplog.at_level(logging.WARNING, logger="greenlight"):
        errors = _all(_run(fakes, stack, make_config, _VISION, memory=memory))

    assert bool(errors) is is_error
    assert "Phase B cut short" in caplog.text
    assert fakes.events[-1] == "finish pytorch/vision optional=False max=5"


def test_a_rate_limit_in_phase_b_latches_with_its_wait_and_names_the_prs_failed_before(make_config):
    error = RateLimitExceededException(403, {"message": "rate limit"}, {"retry-after": "90"})
    fakes = _Fakes(failures={"finish": error}, optional_failed=(7,))
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        errors = _all(run)

    assert run.invocation.meter.latch.is_set()
    assert run.invocation.meter.latch_until == 1090.0
    assert errors == [
        f"pytorch/vision: Phase B stopped: {RATE_LIMITED}",
        "pytorch/vision: Phase B failed on 1 PR(s) before it stopped: [7]",
    ]


def test_with_the_latch_set_both_phases_are_skipped_and_a_prepared_scan_reports_its_safety_failures(make_config):
    fakes = _Fakes(failures={"safety": RuntimeError("1 PR(s) failed during scan: [3]")})
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, BUILTIN_PYTORCH)
        run.phase_a()
        run.invocation.meter.latch.set()
        run.phase_b()
        run.close()
        other = tick.RepoRun(
            run.invocation, run.config, _VISION, True, ScanMemory(), run.store, "bot[bot]", 5, "main", 45
        )
        other.phase_a()
        other.phase_b()

    errors = run.invocation.outcomes.errors
    assert f"{TARGET_REPO}: Phase B skipped: {RATE_LIMITED}" in errors
    assert f"{TARGET_REPO}: Phase A (safety work) failed: 1 PR(s) failed during scan: [3]" in errors
    assert "pytorch/vision: Phase B skipped: " + RATE_LIMITED in errors
    assert fakes.events == [f"prepare {TARGET_REPO} max=0", f"finish {TARGET_REPO} optional=False max=0"]


def test_an_off_repo_with_the_latch_set_skips_its_drain(make_config):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _OFF)
        run.invocation.meter.latch.set()
        run.phase_a()

    assert fakes.events == []
    assert run.invocation.outcomes.errors == [f"pytorch/data: Phase A skipped: {RATE_LIMITED}"]


def test_no_dispatch_token_means_no_phase_b(make_config, caplog):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack, caplog.at_level(logging.WARNING, logger="greenlight"):
        errors = _all(_run(fakes, stack, make_config, _VISION, dispatch_token=None))

    assert fakes.events == []
    assert errors == []
    assert "no Phase B: without the dispatch token" in caplog.text


def test_a_failed_phase_b_is_finished_and_its_failure_is_the_repos_error(make_config):
    fakes = _Fakes(failures={"finish": RuntimeError("failed to dispatch 1 PR(s): [2]")})
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _VISION))

    assert errors == ["pytorch/vision: Phase B failed: failed to dispatch 1 PR(s): [2]"]
    assert fakes.events == ["prepare pytorch/vision max=5", "finish pytorch/vision optional=True max=5"]


def test_a_failed_phase_a_prepare_leaves_phase_b_to_prepare_again(make_config):
    fakes = _Fakes(failures={"prepare": RuntimeError("merge rules down")})
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, BUILTIN_PYTORCH))

    assert errors == [
        f"{TARGET_REPO}: Phase A (safety work) failed: merge rules down",
        f"{TARGET_REPO}: Phase B failed: merge rules down",
    ]


def test_a_run_needs_its_repo_token(make_config):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        run.config = make_config(dispatch_token="dispatch")
        run.phase_b()

    assert run.invocation.outcomes.errors == [
        "pytorch/vision: Phase B failed: pytorch/vision: a run needs its repo token"
    ]


def test_close_logs_the_repos_requests_per_phase_with_the_installations_quota(make_config, caplog):
    fakes = _Fakes(quota_reading=(4000, 5000))
    with contextlib.ExitStack() as stack, caplog.at_level(logging.INFO, logger="greenlight"):
        _all(_run(fakes, stack, make_config, _VISION))

    assert (
        "pytorch/vision: 0 GitHub request(s) in Phase A, 2 in Phase B; the installation had 4000 of 5000 requests "
        "left at the invocation's start, 4000 of 5000 at the run's end"
    ) in caplog.text


def test_an_invocation_without_a_quota_reader_reports_it_unknown():
    with contextlib.ExitStack() as stack:
        invocation = tick.Invocation(stack, tick.Seams())

    assert (invocation.start_quota, invocation.quota()) == ("unknown", "unknown")


def test_outcomes_sort_how_a_step_ended():
    meter = quota.TickMeter(clock=lambda: 1000.0)
    outcomes = Outcomes(meter)

    assert outcomes.attempt("r", "s", lambda: None) == "done"
    assert outcomes.attempt("r", "s", _raise(ValueError("boom"))) == "failed"
    assert outcomes.attempt("r", "s", _raise(quota.RateLimitStop("x"))) == "rate limit"
    assert not meter.latch.is_set()
    assert outcomes.attempt("r", "s", _raise(GithubException(429, None, {"retry-after": "5"}))) == "rate limit"
    assert meter.latch_until == 1005.0
    with pytest.raises(IterationTimeout):
        outcomes.attempt("r", "s", _raise(IterationTimeout("late")))
    assert outcomes.errors == ["r: s failed: boom", f"r: s stopped: {RATE_LIMITED}", f"r: s stopped: {RATE_LIMITED}"]


def test_outcomes_result_returns_what_finished_and_none_when_it_did_not():
    outcomes = Outcomes(quota.TickMeter())

    assert outcomes.result("r", "s", lambda: 3) == 3
    assert outcomes.result("r", "s", _raise(ValueError("no"))) is None
    outcomes.problem("the planner itself")
    assert outcomes.errors == ["r: s failed: no", "the planner itself"]


def _raise(error: BaseException) -> Any:
    def work() -> None:
        raise error

    return work


def test_a_scan_prepare_stopped_early_finishes_nothing(make_config):
    fakes = _Fakes()
    fakes.prepare = lambda *_args, **_kwargs: None  # type: ignore[method-assign]
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        run.phase_b()
        run.close()

    assert run.finished
    assert fakes.events == []


def test_a_latch_set_by_work_that_absorbed_the_rate_limit_is_still_named():
    meter = quota.TickMeter()
    outcomes = Outcomes(meter)
    outcomes.attempt("r", "s", meter.latch.set)

    outcomes.name_the_rate_limit()
    outcomes.name_the_rate_limit()

    assert outcomes.errors == [RATE_LIMITED]
