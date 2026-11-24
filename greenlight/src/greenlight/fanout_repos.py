"""The planner's fan-out: every repo but the primary, its work decided and its worker invoked.

``FanOut.run`` lists the repos the GitHub App installation reaches (``app_tokens.AppTokens.installation``),
mints the ``contents: read`` tokens of the public, unarchived ones, and goes through each listed or stored
repo but the primary, the one whose config was read longest ago first: it revalidates the repo's config
file (``config_cache.revalidate``; a private or archived repo's is not read, and one with no stored config
is only reported), decides its settings (``config_cache.decide``), refuses an entry the listing fails
(``repo_scan.identity_problem``), and stores the updated config record before any worker can read it. A
repo with work (``repo_scan.has_work``: an ``off`` repo whose drain is complete has none) is a candidate.
Each candidate whose lease is free gets one worker, at most ``max_workers`` running at once, the repos
whose last completed run is oldest first, each with an equal share of ``OTHERS_DISPATCH_POOL`` (at least
one, at most ``OTHER_REPO_MAX_DISPATCHES``; none while ``--max`` is zero or below). The fan-out starts no
repo and no invoke ``FANOUT_BUDGET`` after it started: the repos it did not reach are deferred, and their
configs, read longest ago, go first on the next tick.

Every repo gets one outcome (``Line``). These fail the planner: a failed listing or token, a failed
invoke, more candidates than ``max_workers``, a candidate whose last completed run (or the start of its
run of ticks with work) is older than ``STALE_RUN_TICKS`` ticks, a store failure, and a config problem on
the tick it first appears or changes (``ConfigRecord.reported``), or on every tick for a persistent one.
A rate limit sets the latch: the repos not yet read get no work.
"""

from __future__ import annotations

import dataclasses
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import config_cache, github_client, repo_scan
from greenlight.constants import (
    FANOUT_BUDGET,
    OTHER_REPO_MAX_DISPATCHES,
    OTHERS_DISPATCH_POOL,
    STALE_RUN_TICKS,
    TICK_INTERVAL,
)
from greenlight.guards import IterationTimeout
from greenlight.repo_config import is_primary
from greenlight.state_store import RepoItem, StoreError
from greenlight.tick_outcomes import RATE_LIMITED
from greenlight.worker import worker_event

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from greenlight.app_tokens import AppTokens
    from greenlight.repo_config import RepoEntry
    from greenlight.repo_scan import RepoIdentity, RepoWork
    from greenlight.state_store import ConfigRecord, StateStore
    from greenlight.tick import Invocation

logger = logging.getLogger(__name__)

INSTALLATION = "the GitHub App installation"
DEFERRED = f"the fan-out's {FANOUT_BUDGET.total_seconds():g} s budget ran out; it goes first next tick"


@dataclass
class Line:
    """A repo's outcome this tick, and what to say about it."""

    outcome: str
    detail: str | None = None


@dataclass(frozen=True)
class _Candidate:
    repo: str
    item: RepoItem
    entry: RepoEntry
    work: RepoWork
    work_since: float | None


def write_config(invocation: Invocation, store: StateStore, repo: str, old: ConfigRecord, new: ConfigRecord) -> bool:
    """Store ``repo``'s config record when it changed; False, recorded as its error, when the store fails."""
    if old == new:
        return True
    try:
        store.write_config(repo, new)
    except StoreError as exc:
        logger.error("%s: cannot store its config record", repo, exc_info=True)
        invocation.outcomes.error(repo, f"the state store failed storing its config record: {exc}")
        return False
    return True


def dispatch_cap(max_dispatches: int | None, optional: int) -> int:
    """Each of ``optional`` repos' dispatches this tick: an equal share of the pool, at least one, at most
    ``OTHER_REPO_MAX_DISPATCHES``; none while ``max_dispatches`` pauses dispatching."""
    if optional == 0 or (max_dispatches is not None and max_dispatches <= 0):
        return 0
    return min(OTHER_REPO_MAX_DISPATCHES, max(1, OTHERS_DISPATCH_POOL // optional))


@dataclass
class FanOut:
    """One tick's fan-out; ``lines`` collects each repo's outcome."""

    invocation: Invocation
    store: StateStore
    tokens: AppTokens
    invoke: Callable[[Mapping[str, object]], None]
    tick: str
    max_dispatches: int | None
    max_workers: int
    lines: dict[str, Line]
    started: float = field(init=False, default=0.0)

    def _now(self) -> float:
        return self.invocation.seams.clock()

    def _out_of_time(self) -> bool:
        return self.invocation.seams.monotonic() - self.started >= FANOUT_BUDGET.total_seconds()

    def run(self, stored: Mapping[str, RepoItem]) -> dict[str, RepoIdentity] | None:
        """Fan out over the listing and ``stored``; the listing, or None when it failed."""
        self.started = self.invocation.seams.monotonic()
        listing = self.invocation.outcomes.result(
            INSTALLATION,
            "the installation listing",
            lambda: self.tokens.installation(self.invocation.metered(INSTALLATION)),
        )
        if listing is None:
            self.skip(stored, "the installation listing failed")
            return None
        readable = sorted(
            identity.full_name
            for identity in listing.values()
            if not identity.private and not identity.archived and not is_primary(identity.full_name)
        )
        tokens: dict[str, str] = {}
        if readable:
            minted = self.invocation.outcomes.result(
                INSTALLATION, "the contents token", lambda: self.tokens.contents_tokens(readable)
            )
            tokens = minted or {}
        names = {identity.full_name for identity in listing.values()} | set(stored)
        items = {name: stored.get(name) or RepoItem(name) for name in names if not is_primary(name)}
        candidates: list[_Candidate] = []
        for repo in sorted(items, key=lambda name: (items[name].config.read_at or float("-inf"), name)):
            if self._out_of_time():
                self.lines[repo] = Line("deferred", DEFERRED)
            elif candidate := self._plan(repo, listing.get(repo.lower()), items[repo], tokens):
                candidates.append(candidate)
        self._invoke(candidates)
        return listing

    def skip(self, stored: Mapping[str, RepoItem], why: str) -> None:
        for repo in stored:
            if not is_primary(repo):
                self.lines[repo] = Line("skipped", why)

    def _settle(self, repo: str, outcome: str, note: str | None = None) -> None:
        """Set ``repo``'s outcome, keeping what its line already said."""
        detail = self.lines[repo].detail
        self.lines[repo] = Line(outcome, note if detail is None else detail if note is None else f"{detail}; {note}")

    def _read(self, repo: str, record: ConfigRecord, token: str | None) -> tuple[ConfigRecord, str | None] | None:
        """``repo``'s record revalidated with ``token``; None when a rate limit stopped the read."""
        if token is None:
            return record, "no contents token could be minted"
        client = self.invocation.metered(repo)(token)
        try:
            return self.invocation.outcomes.result(
                repo,
                "its config read",
                lambda: config_cache.revalidate(record, client, repo, now=self._now()),
            )
        finally:
            github_client.close_client(client)

    def _report(self, repo: str, problem: str | None, previous: str | None, *, persistent: bool) -> None:
        if problem is None:
            return
        if persistent or problem != previous:
            self.invocation.outcomes.error(repo, problem)
        else:
            logger.warning("%s: %s (reported on an earlier tick)", repo, problem)

    def _plan(
        self, repo: str, identity: RepoIdentity | None, item: RepoItem, tokens: Mapping[str, str]
    ) -> _Candidate | None:
        """Decide ``repo``'s work and store its record; the candidate when it has work, else its line."""
        record, unreadable = item.config, None
        if identity is not None and not identity.private and not identity.archived:
            if self.invocation.meter.latch.is_set():
                self.lines[repo] = Line("skipped", RATE_LIMITED)
                return None
            read = self._read(repo, record, tokens.get(repo))
            if read is None:
                self.lines[repo] = Line("skipped", f"its config read stopped: {RATE_LIMITED}")
                return None
            record, unreadable = read
        elif identity is not None and record.kind is None:
            self.lines[repo] = Line("skipped", repo_scan.visibility_problem(identity))
            return None
        decision = config_cache.decide(
            repo, record, unreadable=unreadable, reachable=identity is not None, drain_complete=item.drain_complete
        )
        settings, entry, problem = decision.settings, decision.settings.entry, decision.settings.problem
        if entry is not None and identity is not None and (refusal := repo_scan.identity_problem(entry, identity)):
            refused = f"refused for this tick: {refusal}"
            problem, entry = refused if problem is None else f"{problem}; {refused}", None
        work = None if entry is None else repo_scan.repo_work(entry, served=settings.served)
        has_work = work is not None and repo_scan.has_work(work, drain_complete=item.drain_complete)
        now = self._now()
        work_since = (decision.record.work_since or now) if has_work else None
        updated = dataclasses.replace(decision.record, work_since=work_since, reported=problem)
        self._report(repo, problem, item.config.reported, persistent=decision.persistent)
        if not write_config(self.invocation, self.store, repo, item.config, updated):
            self.lines[repo] = Line("failed", "its config record could not be stored")
            return None
        if entry is None or work is None:
            outcome = "unreachable" if identity is None and decision.persistent else "refused" if problem else "absent"
            self.lines[repo] = Line(outcome, problem)
            return None
        if not has_work:
            self.lines[repo] = Line("drained" if work.kind == "drain" else "safety-only", problem)
            return None
        self.lines[repo] = Line("draining" if work.kind == "drain" else "served", problem)
        return _Candidate(repo, item, entry, work, work_since)

    def _stale(self, candidate: _Candidate, now: float) -> None:
        since = [at for at in (candidate.item.last_completed_at, candidate.work_since) if at is not None]
        limit = STALE_RUN_TICKS * TICK_INTERVAL.total_seconds()
        if since and now - max(since) > limit:
            problem = f"its last completed run is older than {STALE_RUN_TICKS} ticks"
            self.invocation.outcomes.error(candidate.repo, problem)
            self._settle(candidate.repo, self.lines[candidate.repo].outcome, problem)

    def _invoke(self, candidates: list[_Candidate]) -> None:
        now = self._now()
        if candidates and self.invocation.meter.latch.is_set():
            for candidate in candidates:
                self._settle(candidate.repo, "skipped", RATE_LIMITED)
            return
        busy = [candidate for candidate in candidates if not candidate.item.lease_free(now)]
        free = sorted(
            (candidate for candidate in candidates if candidate.item.lease_free(now)),
            key=lambda candidate: (candidate.item.last_completed_at or float("-inf"), candidate.repo),
        )
        if len(candidates) > self.max_workers:
            self.invocation.outcomes.problem(
                f"{len(candidates)} repos have work, more than PYTORCH_GREENLIGHT_MAX_WORKERS ({self.max_workers})"
            )
        chosen = free[: max(0, self.max_workers - len(busy))]
        cap = dispatch_cap(self.max_dispatches, sum(1 for candidate in chosen if candidate.work.optional))
        for candidate in busy:
            self._settle(candidate.repo, "busy", "its lease is held by another invocation")
        for candidate in free[len(chosen) :]:
            self._settle(candidate.repo, "skipped", "no free worker this tick")
        for candidate in chosen:
            if self._out_of_time():
                self._settle(candidate.repo, "deferred", DEFERRED)
            else:
                self._start(candidate, cap if candidate.work.optional else 0)
        for candidate in candidates:
            self._stale(candidate, now)

    def _start(self, candidate: _Candidate, cap: int) -> None:
        try:
            self.invoke(worker_event(candidate.repo, self.tick, cap))
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.exception("%s: cannot invoke its worker", candidate.repo)
            self.invocation.outcomes.error(candidate.repo, f"its worker could not be invoked: {exc}")
            self._settle(candidate.repo, "failed", f"its worker could not be invoked: {exc}")
            return
        self._settle(candidate.repo, "invoked")
