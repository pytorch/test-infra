"""One repo's run inside a scan invocation: its safety work (Phase A), then its optional work (Phase B).

The planner (``fanout``) runs pytorch/pytorch's; a worker (``worker``) runs any other repo's. An
``Invocation`` holds what every run of one Lambda invocation shares: its ``quota.TickMeter`` (the request
counts and the rate-limit latch, which follows the state store's shared latch), its ``QuotaGauge``, its
errors (``tick_outcomes.Outcomes``), its start and its ``ExitStack``. A ``RepoRun`` routes its repo by
``repo_scan.repo_work``:

- **Phase A**, safety work, never stopped by a budget or a floor: an ``off`` repo runs its drain slice, a
  ``pytorchbot`` repo ``review.prepare`` (the revert guard and the ineligible revoke), a ``gate`` repo
  nothing yet. A safety-only repo stops here.
- **Phase B**, optional work: ``review.prepare`` (unless Phase A prepared it) and ``review_finish.finish``,
  stopped ``WORKER_DEADLINE`` after the invocation started, below the quota floor (``QUOTA_FLOOR_PRIMARY``
  for the primary, ``QUOTA_FLOOR_OTHERS`` for the others) and, for a repo other than the primary, once its
  Phase B spent ``OTHER_REPO_REQUEST_BUDGET`` requests.

Every GitHub client of a repo shares its ``quota.RequestMeter``; its Phase B ``stop`` raises
``RepoBudgetExceeded`` before the next request, which ends that repo's optional work: a cut. A rate limit
sets the invocation's latch, which every meter then refuses; Phase B reads the shared latch again before it
starts. ``RepoRun.close`` raises, as the repo's error, the safety work's failures of a prepared scan Phase B
did not finish, and logs the repo's request counts per phase with the installation's quota. Only a run
with no optional work marks its full tick done there (when its safety work met no rate limit): a run whose
Phase B was cut short or held back (``hold``, the latch, no dispatch token) leaves it due. How Phase B
ended (``phase_b_outcome``; one that returned with the latch set is a rate-limit stop) or why it did not
run (``held``) is kept for the planner's outcome line.
"""

from __future__ import annotations

import dataclasses
import functools
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import drain, github_client, repo_scan, review, review_finish
from greenlight.constants import (
    OTHER_REPO_REQUEST_BUDGET,
    QUOTA_FLOOR_OTHERS,
    QUOTA_FLOOR_PRIMARY,
    WORKER_DEADLINE,
)
from greenlight.latch import SharedLatch
from greenlight.quota import QuotaGauge, TickMeter, core_quota, phase_b_stop
from greenlight.repo_config import is_primary
from greenlight.tick_outcomes import RATE_LIMITED, Outcome, Outcomes

if TYPE_CHECKING:
    import contextlib
    from collections.abc import Callable
    from datetime import datetime

    from github import Github

    from greenlight.config import Config
    from greenlight.repo_config import RepoEntry
    from greenlight.review_finish import PreparedScan
    from greenlight.scan_memory import ScanMemory
    from greenlight.state_store import StateStore

logger = logging.getLogger(__name__)

NO_DISPATCH_TOKEN = "without the dispatch token no review can be dispatched"  # noqa: S105


@dataclass(frozen=True)
class Seams:
    """The I/O a scan invocation runs through; tests replace them."""

    build_github: Callable[..., Github] = github_client.build_client
    run_prepare: Callable[..., PreparedScan | None] = review.prepare
    run_finish: Callable[..., None] = review_finish.finish
    run_drain: Callable[..., drain.DrainReport] = drain.drain
    read_quota: Callable[[Github], tuple[int, int]] = core_quota
    monotonic: Callable[[], float] = time.monotonic
    clock: Callable[[], float] = time.time
    now: Callable[[], datetime] = review._utcnow


def _quota_text(remaining: int | None, limit: int | None) -> str:
    return "unknown" if remaining is None or limit is None else f"{remaining} of {limit}"


@dataclass
class Invocation:
    """What every repo run of one scan invocation shares; ``store``'s latch is the shared one its latch follows."""

    stack: contextlib.ExitStack
    seams: Seams = field(default_factory=Seams)
    store: StateStore | None = None
    meter: TickMeter = field(init=False)
    outcomes: Outcomes = field(init=False)
    gauge: QuotaGauge = field(init=False)
    started: float = field(init=False)
    start_quota: str = "unknown"

    def __post_init__(self) -> None:
        self.started = self.seams.monotonic()
        shared = None if self.store is None else SharedLatch(self.store, self.seams.clock)
        self.meter = TickMeter(self.seams.clock, shared)
        self.outcomes = Outcomes(self.meter)
        self.gauge = QuotaGauge(self.meter, None)

    def metered(self, repo: str) -> Callable[..., Github]:
        """The client builder of ``repo``'s work: every client it builds counts on ``repo``'s meter."""
        return functools.partial(self.seams.build_github, meter=self.meter.meter(repo))

    def watch_quota(self, token: str) -> None:
        """Read the installation's quota with ``token`` from now on, starting now."""
        client = self.seams.build_github(token)
        self.stack.callback(github_client.close_client, client)
        self.gauge = QuotaGauge(self.meter, functools.partial(self.seams.read_quota, client))
        self.gauge.refresh()
        self.start_quota = self.quota()

    def quota(self) -> str:
        return _quota_text(self.gauge.remaining(), self.gauge.limit)


@dataclass
class RepoRun:
    """One repo's run: ``config`` carries its repo token and the dispatch token (None when it could not be had)."""

    invocation: Invocation
    config: Config
    entry: RepoEntry
    served: bool
    memory: ScanMemory
    store: StateStore
    bot_login: str
    max_dispatches: int | None
    ref: str
    timeout_minutes: int
    prepared: PreparedScan | None = None
    finished: bool = False
    held: str | None = None
    phase_b_outcome: Outcome | None = None

    @property
    def repo(self) -> str:
        return self.entry.repo

    @property
    def work(self) -> repo_scan.RepoWork:
        return repo_scan.repo_work(self.entry, served=self.served)

    def _prepare(self, max_dispatches: int | None) -> PreparedScan | None:
        token = self.config.github_token
        if token is None:
            raise ValueError(f"{self.repo}: a run needs its repo token")
        meter = self.invocation.meter.meter(self.repo)
        self.prepared = self.invocation.seams.run_prepare(
            self.config,
            entry=self.entry,
            stack=self.invocation.stack,
            max_dispatches=max_dispatches,
            ref=self.ref,
            timeout_minutes=self.timeout_minutes,
            bot_login=self.bot_login,
            build_github=self.invocation.metered(self.repo),
            resolve_merge_rules=repo_scan.eligibility_thunk(self.config, self.entry, self.store, token, meter=meter),
            memory=self.memory,
            cancel_event=self.invocation.meter.latch,
            dispatch_token=self.config.dispatch_token,
        )
        return self.prepared

    def _drain(self) -> None:
        report = self.invocation.seams.run_drain(
            self.config,
            repo=self.repo,
            memory=self.memory,
            bot_login=self.bot_login,
            build_github=self.invocation.metered(self.repo),
            cancel_event=self.invocation.meter.latch,
            dispatch_token=self.config.dispatch_token,
        )
        if (problem := repo_scan.drain_error(report)) is not None:
            self.invocation.outcomes.error(self.repo, problem)

    def phase_a(self) -> None:
        work, outcomes = self.work, self.invocation.outcomes
        if work.kind != "drain":
            self.memory.clear_drain()
        if work.kind == "none" or outcomes.skipped(self.repo, "Phase A"):
            return
        if work.kind == "drain":
            self.invocation.gauge.refresh()
            outcomes.attempt(self.repo, "Phase A (drain)", self._drain)
        elif self.entry.safety == "pytorchbot":
            self.invocation.gauge.refresh()
            outcomes.attempt(self.repo, "Phase A (safety work)", lambda: self._prepare(0))

    def hold(self, why: str) -> None:
        """Run no Phase B, for ``why``."""
        self.held = why

    def phase_b(self) -> None:
        """The repo's optional work, when it has any."""
        invocation, outcomes = self.invocation, self.invocation.outcomes
        if not self.work.optional or self.held is not None:
            return
        invocation.meter.latch.recheck()
        if outcomes.skipped(self.repo, "Phase B"):
            self.held = RATE_LIMITED
            return
        if self.config.dispatch_token is None:
            logger.warning("%s: no Phase B: %s", self.repo, NO_DISPATCH_TOKEN)
            self.held = NO_DISPATCH_TOKEN
            return
        full_tick_due = self.memory.full_tick_due(invocation.seams.now())
        meter = invocation.meter.meter(self.repo)
        floor, budget = (
            (QUOTA_FLOOR_PRIMARY, None) if is_primary(self.repo) else (QUOTA_FLOOR_OTHERS, OTHER_REPO_REQUEST_BUDGET)
        )
        invocation.gauge.refresh()
        meter.phase = "B"
        meter.stop = phase_b_stop(
            meter,
            gauge=invocation.gauge,
            floor=floor,
            deadline=invocation.started + WORKER_DEADLINE.total_seconds(),
            request_budget=budget,
            monotonic=invocation.seams.monotonic,
        )

        def work() -> None:
            prepared = self.prepared or self._prepare(self.max_dispatches)
            if prepared is None:
                return
            prepared.max_dispatches = self.max_dispatches
            invocation.seams.run_finish(prepared, optional=True)

        outcome = outcomes.attempt(self.repo, "Phase B", work, full_tick_due=full_tick_due)
        if outcome == "done" and invocation.meter.latch.is_set():
            outcomes.error(self.repo, f"Phase B stopped: {RATE_LIMITED}")
            outcome = "rate limit"
        self.phase_b_outcome = outcome
        if outcome in ("done", "failed"):
            self.finished = True
        elif self.prepared is not None:
            outcomes.failed_before(self.repo, outcome, self.prepared.optional_failed)

    def close(self) -> None:
        """Raise the unfinished safety work's failures as the repo's error, and log the repo's requests."""
        invocation = self.invocation
        if self.prepared is not None and not self.finished:
            finish = functools.partial(
                invocation.seams.run_finish, self.prepared, optional=False, marks_full_tick=not self.work.optional
            )
            invocation.outcomes.attempt(self.repo, "Phase A (safety work)", finish)
        invocation.gauge.refresh()
        meter = invocation.meter.meter(self.repo)
        logger.info(
            "%s: %d GitHub request(s) in Phase A, %d in Phase B; the installation had %s requests left at the "
            "invocation's start, %s at the run's end",
            self.repo,
            meter.requests("A"),
            meter.requests("B"),
            invocation.start_quota,
            invocation.quota(),
        )


def run_config(config: Config, repo_token: str, dispatch_token: str | None) -> Config:
    """``config`` with ``repo_token`` as the scan token and ``dispatch_token`` as the dispatch token."""
    return dataclasses.replace(config, github_token=repo_token, dispatch_token=dispatch_token)
