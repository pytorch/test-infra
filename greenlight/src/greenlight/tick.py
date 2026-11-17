"""One scan tick over every repo the repos config serves: each repo's safety work, then its optional work.

``run_tick`` (``review --all-repos``) reads the repos config with the dispatch token, then runs two
phases over the served and safety-only entries (``repo_scan.scanned_entries``: the primary first):

- **Phase A**, safety work, never stopped by a budget or a floor: a ``pytorchbot`` repo runs
  ``review.prepare`` (the revert guard and the ineligible revoke), an ``off`` repo its drain slice, a
  ``gate`` repo nothing yet. A safety-only entry stops here.
- **Phase B**, optional work: the primary finishes its prepared scan under ``QUOTA_FLOOR_PRIMARY``;
  then each other served ``active`` or ``shadow`` repo, in order, prepares and finishes its scan
  within ``OTHER_REPO_TIME_BUDGET`` and ``OTHER_REPO_REQUEST_BUDGET``, under ``QUOTA_FLOOR_OTHERS``, and
  never past ``TICK_DEADLINE`` from the tick's start. A repo whose turn starts past that gets none.

Every GitHub client of a repo shares its ``quota.RequestMeter``; its Phase B ``stop`` raises
``RepoBudgetExceeded`` before the next request, which ends that repo's optional work: a cut. The
dispatch cap (``--max``) is shared (``tick_outcomes.DispatchShare``). A rate limit sets the tick's
latch, which every meter then refuses, and the tick skips every repo and phase left; any other failure
is that repo's error and the tick goes on (``tick_outcomes.Outcomes``). A repo whose token or live
checks fail (``RepoUnavailable``) gets no work. The tick logs each repo's request counts and the
installation's quota, then raises one error naming every repo's error and every config problem.
"""

from __future__ import annotations

import contextlib
import dataclasses
import functools
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from greenlight import drain, github_client, repo_scan, review, review_finish
from greenlight.constants import (
    OTHER_REPO_REQUEST_BUDGET,
    OTHER_REPO_TIME_BUDGET,
    QUOTA_FLOOR_OTHERS,
    QUOTA_FLOOR_PRIMARY,
    TICK_DEADLINE,
)
from greenlight.guards import IterationTimeout
from greenlight.quota import QuotaGauge, TickMeter, phase_b_stop
from greenlight.repo_config import BUILTIN_CONFIG, is_primary
from greenlight.scan_memory import ScanMemory
from greenlight.tick_outcomes import RATE_LIMITED, DispatchShare, Outcomes

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from github import Github

    from greenlight.config import Config
    from greenlight.quota import RequestMeter
    from greenlight.repo_config import RepoConfig, RepoEntry
    from greenlight.repo_scan import EligibilityCaches
    from greenlight.review_finish import PreparedScan
    from greenlight.snapshot_cache import SnapshotCache

logger = logging.getLogger(__name__)


class RepoUnavailable(Exception):
    """A repo's token cannot be had, or GitHub's report of it fails a live check: no work this tick."""


class TokenSource(Protocol):
    def dispatch_token(self) -> str:
        """The token for the repos config, the dispatch and the review runs, all on ``DISPATCH_REPO``."""

    def repo_token(self, entry: RepoEntry) -> str:
        """``entry``'s token once its live checks pass; ``RepoUnavailable`` otherwise."""


class EnvTokens:
    """Tokens from the environment: the scan token for every repo, the dispatch token or else the scan token."""

    def __init__(self, config: Config, build_github: Callable[[str], Github] = github_client.build_client) -> None:
        self._config = config
        self._build_github = build_github

    def _scan_token(self) -> str:
        if not self._config.github_token:
            raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
        return self._config.github_token

    def dispatch_token(self) -> str:
        scan_token = self._scan_token()
        return self._config.dispatch_token or scan_token

    def repo_token(self, entry: RepoEntry) -> str:
        token = self._scan_token()
        client = self._build_github(token)
        try:
            identity = repo_scan.fetch_identity(client, entry.repo)
        finally:
            github_client.close_client(client)
        problem = repo_scan.identity_problem(entry, identity)
        if problem is not None:
            raise RepoUnavailable(problem)
        return token


def core_quota(client: Github) -> tuple[int, int]:
    """The installation's core ``(remaining, limit)``, from ``GET /rate_limit`` (which costs no quota)."""
    core = client.get_rate_limit().resources.core
    return core.remaining, core.limit


def _quota_text(reading: tuple[int | None, int | None]) -> str:
    remaining, limit = reading
    return "unknown" if remaining is None or limit is None else f"{remaining} of {limit}"


@dataclass
class _Tick:
    """One tick's shared state and its per-repo steps."""

    config: Config
    tokens: TokenSource
    dispatch_token: str
    eligibility_caches: EligibilityCaches
    memories: dict[str, ScanMemory]
    bot_login: str
    ref: str
    timeout_minutes: int
    build_github: Callable[..., Github]
    run_prepare: Callable[..., PreparedScan | None]
    run_finish: Callable[..., int]
    run_drain: Callable[..., drain.DrainReport]
    monotonic: Callable[[], float]
    now: Callable[[], datetime]
    stack: contextlib.ExitStack
    meter: TickMeter
    gauge: QuotaGauge
    started: float
    outcomes: Outcomes
    repo_tokens: dict[str, str] = field(default_factory=dict)
    prepared: dict[str, PreparedScan] = field(default_factory=dict)
    finished: set[str] = field(default_factory=set)

    def metered(self, meter: RequestMeter) -> Callable[..., Github]:
        return functools.partial(self.build_github, meter=meter)

    def take_token(self, entry: RepoEntry) -> None:
        try:
            self.repo_tokens[entry.repo] = self.tokens.repo_token(entry)
        except RepoUnavailable as exc:
            self.outcomes.error(entry.repo, f"no work this tick: {exc}")

    def repo_config(self, repo: str) -> Config:
        """The tick's config with ``repo``'s token as the scan token."""
        return dataclasses.replace(self.config, github_token=self.repo_tokens[repo], dispatch_token=self.dispatch_token)

    def prepare(self, entry: RepoEntry, memory: ScanMemory, max_dispatches: int | None) -> PreparedScan | None:
        repo = entry.repo
        config = self.repo_config(repo)
        meter = self.meter.meter(repo)
        prepared = self.run_prepare(
            config,
            entry=entry,
            stack=self.stack,
            max_dispatches=max_dispatches,
            ref=self.ref,
            timeout_minutes=self.timeout_minutes,
            bot_login=self.bot_login,
            build_github=self.metered(meter),
            resolve_merge_rules=repo_scan.eligibility_thunk(
                config, entry, self.eligibility_caches, self.repo_tokens[repo], meter=meter
            ),
            memory=memory,
            cancel_event=self.meter.latch,
            dispatch_token=self.dispatch_token,
        )
        if prepared is not None:
            self.prepared[repo] = prepared
        return prepared

    def drain(self, entry: RepoEntry, memory: ScanMemory) -> None:
        report = self.run_drain(
            self.repo_config(entry.repo),
            repo=entry.repo,
            memory=memory,
            bot_login=self.bot_login,
            build_github=self.metered(self.meter.meter(entry.repo)),
            cancel_event=self.meter.latch,
            dispatch_token=self.dispatch_token,
        )
        if (problem := repo_scan.drain_error(report)) is not None:
            self.outcomes.error(entry.repo, problem)

    def phase_a(self, entry: RepoEntry) -> None:
        repo = entry.repo
        if self.outcomes.skipped(repo, "Phase A"):
            return
        self.outcomes.attempt(repo, "its token", lambda: self.take_token(entry))
        if repo not in self.repo_tokens:
            return
        memory = self.memories.setdefault(repo, ScanMemory())
        if entry.mode == "off":
            self.gauge.refresh()
            self.outcomes.attempt(repo, "Phase A (drain)", lambda: self.drain(entry, memory))
            return
        memory.clear_drain()
        if entry.safety == "pytorchbot":
            self.gauge.refresh()
            self.outcomes.attempt(repo, "Phase A (safety work)", lambda: self.prepare(entry, memory, 0))

    def phase_b(self, entry: RepoEntry, share: int | None) -> int:
        """``entry``'s optional work under at most ``share`` dispatches; how many it dispatched."""
        repo = entry.repo
        if self.outcomes.skipped(repo, "Phase B"):
            return 0
        memory = self.memories[repo]
        full_tick_due = memory.full_tick_due(self.now())
        meter = self.meter.meter(repo)
        if is_primary(repo):
            floor, deadline, budget = QUOTA_FLOOR_PRIMARY, None, None
        else:
            turn_start = self.monotonic()
            tick_deadline = self.started + TICK_DEADLINE.total_seconds()
            if turn_start >= tick_deadline:
                self.outcomes.shortfall(
                    repo, "no Phase B turn: the tick's deadline had passed", full_tick_due=full_tick_due
                )
                return 0
            deadline = min(turn_start + OTHER_REPO_TIME_BUDGET.total_seconds(), tick_deadline)
            floor, budget = QUOTA_FLOOR_OTHERS, OTHER_REPO_REQUEST_BUDGET
        self.gauge.refresh()
        meter.phase = "B"
        meter.stop = phase_b_stop(
            meter, gauge=self.gauge, floor=floor, deadline=deadline, request_budget=budget, monotonic=self.monotonic
        )

        def work() -> None:
            prepared = self.prepared.get(repo) or self.prepare(entry, memory, share)
            if prepared is None:
                return
            prepared.max_dispatches = share
            self.run_finish(prepared, optional=True)

        if self.outcomes.attempt(repo, "Phase B", work, full_tick_due=full_tick_due) in ("done", "failed"):
            self.finished.add(repo)
        prepared = self.prepared.get(repo)
        return 0 if prepared is None else prepared.dispatched

    def report_safety_failures(self) -> None:
        """Raise, as each repo's error, the safety work's failures of every prepared scan Phase B did not finish."""
        for repo, prepared in self.prepared.items():
            if repo not in self.finished:
                self.outcomes.attempt(
                    repo, "Phase A (safety work)", functools.partial(self.run_finish, prepared, optional=False)
                )

    def run(self, entries: tuple[tuple[RepoEntry, bool], ...], max_dispatches: int | None) -> None:
        for entry, _served in entries:
            self.phase_a(entry)
        primary = [
            entry for entry, served in entries if served and is_primary(entry.repo) and entry.repo in self.prepared
        ]
        others = [
            entry
            for entry, served in entries
            if served and not is_primary(entry.repo) and entry.mode != "off" and entry.repo in self.repo_tokens
        ]
        share = DispatchShare(max_dispatches, others=bool(others))
        for entry in primary:
            share.spend(self.phase_b(entry, share.primary()))
        for entry in others:
            share.spend(self.phase_b(entry, share.left()))
        self.report_safety_failures()


def _read_repo_config(
    cache: SnapshotCache[Github, RepoConfig], build_client: Callable[[], Github], outcomes: Outcomes
) -> RepoConfig:
    """The repos config, its problems in ``outcomes.errors``; a rate limit sets the latch and serves the built-in."""
    errors = outcomes.errors
    try:
        repo_config = repo_scan.read_config(cache, build_client, errors)
    except IterationTimeout:
        raise
    except Exception as exc:
        if not github_client.is_rate_limit_error(exc):
            raise
        outcomes.tick.latch.set()
        logger.warning("repos config not read: %s", RATE_LIMITED)
        errors.append(f"repos config not read: {RATE_LIMITED}")
        return BUILTIN_CONFIG
    errors.extend(problem for problem in repo_config.problems if problem not in errors)
    return repo_config


def run_tick(
    config: Config,
    *,
    tokens: TokenSource,
    config_cache: SnapshotCache[Github, RepoConfig],
    eligibility_caches: EligibilityCaches,
    memories: dict[str, ScanMemory],
    bot_login: str,
    max_dispatches: int | None,
    ref: str,
    timeout_minutes: int,
    build_github: Callable[..., Github] = github_client.build_client,
    run_prepare: Callable[..., PreparedScan | None] = review.prepare,
    run_finish: Callable[..., int] = review_finish.finish,
    run_drain: Callable[..., drain.DrainReport] = drain.drain,
    read_quota: Callable[[Github], tuple[int, int]] = core_quota,
    monotonic: Callable[[], float] = time.monotonic,
    now: Callable[[], datetime] = review._utcnow,
) -> None:
    """Run one tick over every served and safety-only repo; raise one error naming every problem found."""
    started = monotonic()
    dispatch_token = tokens.dispatch_token()
    meter = TickMeter()
    outcomes = Outcomes(meter)
    with contextlib.ExitStack() as stack:
        quota_client = build_github(dispatch_token)
        stack.callback(github_client.close_client, quota_client)
        gauge = QuotaGauge(meter, lambda: read_quota(quota_client))
        gauge.refresh()
        start_quota = (gauge.remaining(), gauge.limit)
        repo_config = _read_repo_config(config_cache, lambda: build_github(dispatch_token), outcomes)
        entries = repo_scan.scanned_entries(repo_config)
        _Tick(
            config=config,
            tokens=tokens,
            dispatch_token=dispatch_token,
            eligibility_caches=eligibility_caches,
            memories=memories,
            bot_login=bot_login,
            ref=ref,
            timeout_minutes=timeout_minutes,
            build_github=build_github,
            run_prepare=run_prepare,
            run_finish=run_finish,
            run_drain=run_drain,
            monotonic=monotonic,
            now=now,
            stack=stack,
            meter=meter,
            gauge=gauge,
            started=started,
            outcomes=outcomes,
        ).run(entries, max_dispatches)
        gauge.refresh()
        end_quota = (gauge.remaining(), gauge.limit)
    for entry, _served in entries:
        repo_meter = meter.meter(entry.repo)
        logger.info(
            "%s: %d GitHub request(s) in Phase A, %d in Phase B; the installation had %s requests left at the "
            "tick's start, %s at its end",
            entry.repo,
            repo_meter.requests("A"),
            repo_meter.requests("B"),
            _quota_text(start_quota),
            _quota_text(end_quota),
        )
    if outcomes.errors:
        raise RuntimeError("; ".join(outcomes.errors))
