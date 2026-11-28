from __future__ import annotations

import contextlib
import dataclasses
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

import pytest
from github import GithubException, RateLimitExceededException

from greenlight import approval_backing, drain, fanout_repos, merge_authz, quota, review, review_finish, tick
from greenlight.change_feed import Marker
from greenlight.constants import (
    BACKING_DEADLINE,
    OTHER_REPO_REQUEST_BUDGET,
    QUOTA_FLOOR_OTHERS,
    QUOTA_FLOOR_PRIMARY,
    QUOTA_REFRESH_REQUESTS,
    TARGET_REPO,
    WORKER_DEADLINE,
)
from greenlight.fanout import primary_line
from greenlight.gate_rules import GateRules
from greenlight.guards import IterationTimeout
from greenlight.latch import SharedLatch
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.review_gate import HUMAN_APPROVED, ReviewSkip
from greenlight.scan_memory import ScanMemory, decode_memory, encode_memory
from greenlight.state import PRState
from greenlight.state_store import InProcessStore, StoreError
from greenlight.tick_outcomes import RATE_LIMITED, Outcomes
from tests.change_helpers import ListingClient, Pull, fresh
from tests.test_review_finish import prepared_scan

if TYPE_CHECKING:
    from github import Github

_NOW = datetime(2026, 11, 24, 12, 0, 0)
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "write_permission", "shadow")
_OFF = RepoEntry("pytorch/data", "greenlight", "gate", "merge_rules", "off")
_SNAPSHOT = merge_authz.MergeRulesSnapshot(authorized=frozenset({"alice"}), rules=())
_ENFORCED = GateRules(enforced=True)
_NOT_ENFORCED = GateRules(enforced=False, problems=("a merge_queue rule applies",))
_ACTIVE = dataclasses.replace(_VISION, mode="active")


def _backing_report(
    rules: GateRules | None = _ENFORCED, errors: tuple[str, ...] = ()
) -> approval_backing.BackingReport:
    return approval_backing.BackingReport(rules, 0, 0, 0, 0, 0, 1, 0, 0, (), errors)


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
        backing: approval_backing.BackingReport | None = None,
    ) -> None:
        self.failures = failures or {}
        self.quota_reading = quota_reading
        self.clock = clock if clock is not None else [0.0]
        self.drain_failed = drain_failed
        self.optional_failed = optional_failed
        self.backing_report = backing or _backing_report()
        self.backing_kwargs: dict[str, Any] = {}
        self.events: list[str] = []
        self.prepare_kwargs: dict[str, Any] = {}
        self.drain_kwargs: dict[str, Any] = {}
        self.stops: list[str | None] = []
        self.marks: list[bool] = []
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

    def finish(self, prepared: _Prepared, *, optional: bool, marks_full_tick: bool = True) -> None:
        self.events.append(f"finish {prepared.repo} optional={optional} max={prepared.max_dispatches}")
        self.marks.append(marks_full_tick)
        if optional:
            meter = self.prepare_kwargs["build_github"].keywords["meter"]
            meter.count()
            self.stops.append(meter.stop())
            prepared.optional_failed.extend(self.optional_failed)
            self._fail("finish")
        else:
            self._fail("safety")

    def drain(self, config: Any, *, repo: str, **kwargs: Any) -> drain.DrainReport:
        self.events.append(f"drain {repo}")
        self.drain_kwargs = {"config": config, **kwargs}
        self._fail("drain")
        return drain.DrainReport(1, 0, 0, False, "x", self.drain_failed)

    def backing(self, config: Any, *, entry: RepoEntry, **kwargs: Any) -> approval_backing.BackingReport:
        self.events.append(f"backing {entry.repo}")
        self.backing_kwargs = {"config": config, "entry": entry, **kwargs}
        self._fail("backing")
        return self.backing_report

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
            run_backing=self.backing,
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
        assert fakes.events == ["backing pytorch/vision"]
        run.phase_b()
        run.close()

    assert fakes.events == [
        "backing pytorch/vision",
        "prepare pytorch/vision max=5",
        "finish pytorch/vision optional=True max=5",
    ]
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


@pytest.mark.parametrize("entry", [_VISION, _ACTIVE], ids=["shadow", "active"])
def test_a_safety_only_gate_repo_runs_its_backing_check_alone_and_forgets_its_drain(make_config, entry):
    fakes = _Fakes(clock=[7.0])
    memory = ScanMemory()
    memory.off_since(_NOW)
    memory.backing.waiting = frozenset({4})
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, entry, served=False, memory=memory)
        errors = _all(run)

        kwargs = fakes.backing_kwargs
        assert kwargs["config"].github_token == "repo-token"
        assert kwargs["entry"] == entry
        assert kwargs["memory"] is memory
        assert kwargs["bot_login"] == "bot[bot]"
        assert kwargs["build_github"].keywords["meter"] is run.invocation.meter.meter("pytorch/vision")
        assert kwargs["cancel_event"] is run.invocation.meter.latch
        assert kwargs["now"]() == _NOW
        assert kwargs["deadline"] == 7.0 + BACKING_DEADLINE.total_seconds()
        assert kwargs["monotonic"] == fakes.monotonic

    assert fakes.events == ["backing pytorch/vision"]
    assert errors == []
    assert (run.held, primary_line(run).outcome) == (None, "safety-only")
    assert memory.backing.waiting == frozenset({4})
    assert memory.off_since(datetime(2027, 1, 1)) == datetime(2027, 1, 1)


def test_the_backing_checks_errors_are_the_repos_and_its_phase_b_still_runs(make_config):
    fakes = _Fakes(backing=_backing_report(errors=("sweep 3 incomplete after 15 minutes: 4 PRs unread", "late")))
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _VISION))

    assert errors == [
        "pytorch/vision: sweep 3 incomplete after 15 minutes: 4 PRs unread",
        "pytorch/vision: late",
    ]
    assert fakes.events[-1] == "finish pytorch/vision optional=True max=5"


@pytest.mark.parametrize(
    ("report", "expected"),
    [
        pytest.param(
            _backing_report(None, errors=("GreenLight's gate rules on pytorch/vision could not be read: boom",)),
            [
                "pytorch/vision: GreenLight's gate rules on pytorch/vision could not be read: boom",
                "pytorch/vision: no dispatch this run: the rules could not be read",
            ],
            id="unknown",
        ),
        pytest.param(
            _backing_report(_NOT_ENFORCED),
            [
                "pytorch/vision: no dispatch this run: GreenLight's gate is not enforced on pytorch/vision: "
                "a merge_queue rule applies"
            ],
            id="not-enforced",
        ),
    ],
)
def test_an_active_gate_repo_without_enforced_rules_is_held_from_phase_b(make_config, report, expected):
    fakes = _Fakes(backing=report)
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _ACTIVE)
        errors = _all(run)

    assert errors == expected
    assert fakes.events == ["backing pytorch/vision"]
    assert run.held == expected[-1].removeprefix("pytorch/vision: ")
    assert primary_line(run).detail == f"no Phase B: {run.held}"
    assert run.memory.full_tick_due(_NOW)


def test_a_failed_backing_check_is_the_repos_error_and_holds_an_active_gate_repo(make_config):
    fakes = _Fakes(failures={"backing": ValueError("clickhouse down")})
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _ACTIVE)
        errors = _all(run)

    assert errors == [
        "pytorch/vision: Phase A (approval backing) failed: clickhouse down",
        "pytorch/vision: no dispatch this run: the rules could not be read",
    ]
    assert fakes.events == ["backing pytorch/vision"]


@pytest.mark.parametrize("report", [_backing_report(None), _backing_report(_NOT_ENFORCED)], ids=["unknown", "off"])
def test_a_shadow_gate_repo_runs_phase_b_whatever_its_rules(make_config, report):
    fakes = _Fakes(backing=report)
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        errors = _all(run)

    assert errors == []
    assert run.held is None
    assert fakes.events[-1] == "finish pytorch/vision optional=True max=5"


def test_a_failed_backing_check_of_a_shadow_gate_repo_is_its_error_and_phase_b_still_runs(make_config):
    fakes = _Fakes(failures={"backing": ValueError("clickhouse down")})
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _VISION))

    assert errors == ["pytorch/vision: Phase A (approval backing) failed: clickhouse down"]
    assert fakes.events[-1] == "finish pytorch/vision optional=True max=5"


def test_an_active_gate_repo_with_enforced_rules_runs_phase_b(make_config):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _ACTIVE))

    assert errors == []
    assert fakes.events == [
        "backing pytorch/vision",
        "prepare pytorch/vision max=5",
        "finish pytorch/vision optional=True max=5",
    ]


def test_a_rate_limit_in_a_backing_check_latches_and_skips_phase_b(make_config):
    error = RateLimitExceededException(403, {"message": "rate limit"}, {"retry-after": "90"})
    fakes = _Fakes(failures={"backing": error})
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _VISION)
        errors = _all(run)

    assert run.invocation.meter.latch.until == 1090.0
    assert errors == [
        f"pytorch/vision: Phase A (approval backing) stopped: {RATE_LIMITED}",
        f"pytorch/vision: Phase B skipped: {RATE_LIMITED}",
    ]
    assert fakes.events == ["backing pytorch/vision"]


def test_a_gate_repo_with_the_latch_set_runs_no_backing_check(make_config):
    fakes = _Fakes()
    with contextlib.ExitStack() as stack:
        run = _run(fakes, stack, make_config, _ACTIVE)
        run.invocation.meter.latch.set()
        errors = _all(run)

    assert fakes.events == []
    assert errors == [
        f"pytorch/vision: Phase A skipped: {RATE_LIMITED}",
        f"pytorch/vision: Phase B skipped: {RATE_LIMITED}",
    ]


@pytest.mark.parametrize("entry", [BUILTIN_PYTORCH, _OFF, dataclasses.replace(_VISION, mode="off")])
def test_a_repo_that_does_not_back_approvals_forgets_the_backing_memory_and_runs_no_check(make_config, entry):
    fakes = _Fakes()
    memory = ScanMemory()
    memory.backing.waiting = frozenset({4})
    with contextlib.ExitStack() as stack:
        _all(_run(fakes, stack, make_config, entry, memory=memory))

    assert memory.backing.waiting == frozenset()
    assert not any(event.startswith("backing") for event in fakes.events)


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
    assert run.invocation.meter.latch.until == 1090.0
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

    assert fakes.events == ["backing pytorch/vision"]
    assert errors == []
    assert "no Phase B: without the dispatch token" in caplog.text


def test_a_failed_phase_b_is_finished_and_its_failure_is_the_repos_error(make_config):
    fakes = _Fakes(failures={"finish": RuntimeError("failed to dispatch 1 PR(s): [2]")})
    with contextlib.ExitStack() as stack:
        errors = _all(_run(fakes, stack, make_config, _VISION))

    assert errors == ["pytorch/vision: Phase B failed: failed to dispatch 1 PR(s): [2]"]
    assert fakes.events == [
        "backing pytorch/vision",
        "prepare pytorch/vision max=5",
        "finish pytorch/vision optional=True max=5",
    ]


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
    assert meter.latch.until == 1005.0
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


def _real_finish_run(
    stack: contextlib.ExitStack,
    make_config: Any,
    entry: RepoEntry,
    *,
    served: bool = True,
    fingerprint: Any = None,
    dispatch_token: str | None = "dispatch",  # noqa: S107
    store: InProcessStore | None = None,
) -> tick.RepoRun:
    """A run whose Phase B finishes through the real ``review_finish.finish`` on a real ``PreparedScan``."""

    def prepare(_config: Any, *, entry: RepoEntry, max_dispatches: int | None, **kwargs: Any) -> Any:
        return prepared_scan(
            entry=entry,
            stack=kwargs["stack"],
            memory=kwargs["memory"],
            cancel_event=kwargs["cancel_event"],
            max_dispatches=max_dispatches,
            listed_at=_NOW,
            evaluated_at=_NOW,
            build_github=lambda _token, **_kwargs: object(),
            fingerprint=fingerprint or (lambda *_args: ReviewSkip(HUMAN_APPROVED, "approved by alice")),
            label_prs=lambda _label_pass: None,
            poke=lambda _number: None,
        )

    seams = dataclasses.replace(_Fakes().seams(), run_prepare=prepare, run_finish=review_finish.finish)
    invocation = tick.Invocation(stack, seams, store)
    return tick.RepoRun(
        invocation,
        tick.run_config(make_config(), "repo-token", dispatch_token),
        entry,
        served,
        ScanMemory(),
        InProcessStore(),
        "bot[bot]",
        5,
        "main",
        45,
    )


def _cut(*_args: Any) -> Any:
    raise quota.RepoBudgetExceeded("pytorch/pytorch: past its deadline")


@pytest.mark.parametrize(
    ("entry", "served", "fingerprint", "dispatch_token", "hold", "marked"),
    [
        pytest.param(BUILTIN_PYTORCH, True, None, "dispatch", None, True, id="phase-b-finished"),
        pytest.param(BUILTIN_PYTORCH, False, None, "dispatch", None, True, id="safety-only"),
        pytest.param(BUILTIN_PYTORCH, True, _cut, "dispatch", None, False, id="cut"),
        pytest.param(BUILTIN_PYTORCH, True, None, "dispatch", "held back", False, id="held-back"),
        pytest.param(BUILTIN_PYTORCH, True, None, None, None, False, id="no-dispatch-token"),
    ],
)
def test_only_a_finished_phase_b_or_a_safety_only_run_marks_the_full_tick_done(
    make_config, entry, served, fingerprint, dispatch_token, hold, marked
):
    with contextlib.ExitStack() as stack:
        run = _real_finish_run(
            stack, make_config, entry, served=served, fingerprint=fingerprint, dispatch_token=dispatch_token
        )
        if hold is not None:
            run.hold(hold)
        run.phase_a()
        run.phase_b()
        run.close()

    assert run.memory.full_tick_due(_NOW + timedelta(minutes=1)) is not marked
    assert run.held == (hold if dispatch_token else tick.NO_DISPATCH_TOKEN)


def test_a_phase_b_stopped_by_the_latch_leaves_the_full_tick_due(make_config):
    with contextlib.ExitStack() as stack:
        run = _real_finish_run(stack, make_config, BUILTIN_PYTORCH)
        run.phase_a()
        run.invocation.meter.latch.set()
        run.phase_b()
        run.close()

    assert run.held == RATE_LIMITED
    assert run.memory.full_tick_due(_NOW + timedelta(minutes=1))


def test_a_phase_b_that_returns_with_the_latch_set_is_a_rate_limit_stop(make_config):
    store = InProcessStore()

    def fingerprint(*_args: Any) -> tuple[str, str]:
        store.extend_latch(1300.0, 1000.0)
        return ("h" * 40, "a" * 64)

    with contextlib.ExitStack() as stack:
        run = _real_finish_run(stack, make_config, BUILTIN_PYTORCH, fingerprint=fingerprint, store=store)
        run.phase_a()
        run.phase_b()
        run.close()

    assert run.phase_b_outcome == "rate limit"
    assert primary_line(run) == fanout_repos.Line("cut", f"Phase B stopped: {RATE_LIMITED}")
    assert run.invocation.outcomes.errors == [f"{TARGET_REPO}: Phase B stopped: {RATE_LIMITED}"]
    assert run.memory.full_tick_due(_NOW + timedelta(minutes=1))


def test_phase_b_records_how_it_ended(make_config):
    fakes = _Fakes(failures={"finish": quota.RepoBudgetExceeded("pytorch/vision: past its deadline")})
    with contextlib.ExitStack() as stack:
        cut = _run(fakes, stack, make_config, _VISION)
        cut.phase_b()
        done = _run(_Fakes(), stack, make_config, _VISION)
        done.phase_b()

    assert (cut.phase_b_outcome, cut.held) == ("cut", None)
    assert (done.phase_b_outcome, done.held) == ("done", None)


def _shared_run(
    stack: contextlib.ExitStack, make_config: Any, store: InProcessStore, entry: RepoEntry, fakes: _Fakes
) -> tick.RepoRun:
    invocation = tick.Invocation(stack, fakes.seams(), store)
    return tick.RepoRun(
        invocation,
        tick.run_config(make_config(), "repo-token", "dispatch"),
        entry,
        True,
        ScanMemory(),
        store,
        "bot[bot]",
        5,
        "main",
        45,
    )


def test_a_rate_limit_one_invocation_meets_stops_the_others_optional_work_but_never_pytorchs_phase_a(make_config):
    store = InProcessStore()
    with contextlib.ExitStack() as stack:
        vision = _shared_run(stack, make_config, store, _VISION, _Fakes())
        primary = _shared_run(stack, make_config, store, BUILTIN_PYTORCH, _Fakes())
        latching = _shared_run(stack, make_config, store, _OFF, _Fakes())

        latching.invocation.meter.meter("pytorch/data").rate_limited({"retry-after": "120"})
        assert store.read_latch(1000.0) == 1120.0

        pytorch_meter = primary.invocation.meter.meter(TARGET_REPO)
        for _ in range(3 * QUOTA_REFRESH_REQUESTS):
            pytorch_meter.before_request()
            pytorch_meter.count()
        assert not primary.invocation.meter.latch.is_set()

        vision.phase_b()

    assert vision.held == RATE_LIMITED
    assert vision.invocation.meter.latch.until == 1120.0
    assert vision.invocation.outcomes.errors == [f"pytorch/vision: Phase B skipped: {RATE_LIMITED}"]


def test_the_next_optional_request_after_another_invocation_latches_is_refused(make_config):
    store = InProcessStore()
    with contextlib.ExitStack() as stack:
        vision = _shared_run(stack, make_config, store, _VISION, _Fakes())
        meter = vision.invocation.meter.meter("pytorch/vision")
        meter.phase = "B"
        for _ in range(QUOTA_REFRESH_REQUESTS):
            meter.before_request()
            meter.count()
        store.extend_latch(1300.0, 1000.0)

        with pytest.raises(quota.RateLimitStop):
            meter.before_request()

    assert vision.invocation.meter.latch.until == 1300.0


class _LatchStore(InProcessStore):
    """An ``InProcessStore`` that counts latch reads and fails them once ``failing`` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.failing = False
        self.reads = 0

    def read_latch(self, now: float) -> float | None:
        self.reads += 1
        if self.failing:
            raise StoreError("read_latch refused")
        return super().read_latch(now)


_UNREADABLE = "the state store failed reading the shared rate-limit latch: read_latch refused"


def test_a_failed_read_of_the_shared_latch_stops_the_others_optional_work_but_never_pytorchs_phase_a(make_config):
    store = _LatchStore()
    with contextlib.ExitStack() as stack:
        vision = _shared_run(stack, make_config, store, _VISION, _Fakes())
        primary = _shared_run(stack, make_config, store, BUILTIN_PYTORCH, _Fakes())
        vision.invocation.meter.latch.recheck()
        store.failing = True

        pytorch_meter = primary.invocation.meter.meter(TARGET_REPO)
        for _ in range(3 * QUOTA_REFRESH_REQUESTS):
            pytorch_meter.before_request()
            pytorch_meter.count()
        assert store.reads == 1

        vision.phase_b()
    vision.invocation.outcomes.name_the_rate_limit()

    assert vision.held == RATE_LIMITED
    assert vision.invocation.meter.latch.until is None
    assert vision.invocation.outcomes.errors == [f"pytorch/vision: Phase B skipped: {RATE_LIMITED}", _UNREADABLE]


def test_a_latch_set_by_a_failed_read_of_the_shared_one_is_named_by_that_failure():
    store = _LatchStore()
    store.failing = True
    meter = quota.TickMeter(lambda: 1000.0, SharedLatch(store, lambda: 1000.0))
    outcomes = Outcomes(meter)

    meter.latch.recheck()
    outcomes.name_the_rate_limit()
    assert outcomes.errors == [_UNREADABLE]
    meter.latch.note({"retry-after": "60"})
    outcomes.name_the_rate_limit()

    assert outcomes.errors == [_UNREADABLE, RATE_LIMITED]


def test_a_clickhouse_primary_refetches_only_the_pr_whose_marker_changed_without_an_update(make_config):
    entry = dataclasses.replace(BUILTIN_PYTORCH, change_source="clickhouse")
    updated = _NOW - timedelta(hours=1)
    github = ListingClient([Pull(number, updated) for number in (1, 2, 3)])
    markers = dict.fromkeys((1, 2, 3), Marker(reviews=1))
    hashed = "a" * 64
    states = {
        number: PRState(
            pr_number=number, status="NO_LAND", eval_hash=hashed, head_sha=f"sha{number}", version=updated, run_id=1
        )
        for number in (1, 2, 3)
    }
    snapshot = merge_authz.MergeRulesSnapshot(
        authorized=frozenset({"alice"}), rules=(merge_authz.compile_rule("all", ["*"], frozenset({"alice"})),)
    )
    clock = [_NOW]
    fingerprinted: list[list[int]] = []
    dispatched: list[int] = []

    def fingerprint(_client, _repo, number, _authorized, _skip):
        fingerprinted[-1].append(number)
        return (f"sha{number}", hashed)

    def run_prepare(config, **kwargs):
        kwargs.update(
            resolve_merge_rules=lambda: snapshot,
            read_markers=lambda _repo, numbers: {number: markers[number] for number in numbers},
            read_freshness=fresh,
            fingerprint=fingerprint,
            read_state=lambda _repo, numbers: {number: states[number] for number in numbers},
            read_reverted=lambda _repo, _numbers: set(),
            dispatch=lambda _client, number, *_args, **_kwargs: dispatched.append(number),
            emit_dispatched=lambda **_kwargs: None,
            poke_drci=lambda *_args: None,
            label_prs=lambda _label_pass: None,
            now=lambda: clock[0],
        )
        return review.prepare(config, **kwargs)

    stored = encode_memory(ScanMemory(), TARGET_REPO)

    def run(at: datetime) -> list[int]:
        nonlocal stored
        clock[0] = at
        fingerprinted.append([])
        seams = tick.Seams(
            build_github=lambda *_args, **_kwargs: cast("Github", github),
            run_prepare=run_prepare,
            run_finish=review_finish.finish,
            read_quota=lambda _client: (5000, 5000),
            clock=lambda: 1000.0,
            now=lambda: at,
        )
        with contextlib.ExitStack() as stack:
            repo_run = tick.RepoRun(
                tick.Invocation(stack, seams),
                tick.run_config(make_config(), "repo-token", "dispatch"),
                entry,
                True,
                decode_memory(stored, TARGET_REPO),
                InProcessStore(),
                "bot[bot]",
                30,
                "main",
                45,
            )
            assert _all(repo_run) == []
        stored = encode_memory(repo_run.memory, TARGET_REPO)
        return sorted(fingerprinted[-1])

    full = run(_NOW)
    event = run(_NOW + timedelta(minutes=2))
    markers[2] = Marker(reviews=2)
    dismissed = run(_NOW + timedelta(minutes=4))

    # The first tick lists in full and keeps nothing, its markers first seen then; the second keeps
    # every fetch. The third sees a dismissal on PR2 that moved no updated_at: only PR2 is refetched.
    assert (full, event, dismissed) == ([1, 2, 3], [1, 2, 3], [2])
    reverted = "issues open ['Reverted']"
    assert github.listed == ["pulls open", "pulls all", reverted, "pulls all", reverted]
    assert dispatched == []
