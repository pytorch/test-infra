"""The scan Lambda's worker: one repo's run, invoked asynchronously by the planner (``fanout``).

Its event is only ``{"greenlight_worker": {"repo": ..., "tick": ..., "dispatch_cap": n}}`` (``worker_event``);
``parse_payload`` refuses any other shape, and pytorch/pytorch, whose run is the planner's. ``Worker.run``:

1. takes the repo's lease, and ends, logging, when another invocation holds it;
2. reads the repo's item, and ends when its run already completed this tick (a replayed invocation);
3. ends when the shared rate-limit latch holds: a repo other than the primary gets no work then;
4. derives the repo's settings from the config record the planner stored (``config_cache.decide``, the
   planner's own decision), and ends when they give no work (``repo_scan.has_work``: an ``off`` repo
   whose drain is complete has none);
5. resolves the App's bot login, loads the repo's memory, and mints its repo token and the dispatch token
   (``leased_run``);
6. checks GitHub's current report of the repo with its own token (``repo_scan.check_identity``: the exact
   canonical name, public, not archived, default branch ``main``), and on any problem does no work;
7. runs Phase A then Phase B (``tick.RepoRun``), its dispatch cap the payload's clamped to
   ``OTHER_REPO_MAX_DISPATCHES``, and 0 while the handler's current ``--max`` pauses dispatching;
8. saves the memory with the completed tick under its lease, extends the shared latch by any rate limit it
   met, releases the lease, and raises when the repo had errors.

A store failure fails the worker before any GitHub work. Its latch follows the shared one while it runs
(``latch``).
"""

from __future__ import annotations

import contextlib
import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import config_cache, github_client, leased_run, repo_scan
from greenlight.constants import LEASE_DURATION, OTHER_REPO_MAX_DISPATCHES
from greenlight.repo_config import is_primary
from greenlight.scan_memory import decode_memory
from greenlight.state_store import epoch_text
from greenlight.tick import Invocation, Seams

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from greenlight.app_tokens import AppTokens
    from greenlight.config import Config
    from greenlight.repo_config import RepoEntry, Settings
    from greenlight.scan_memory import ScanMemory
    from greenlight.state_store import StateStore

logger = logging.getLogger(__name__)

WORKER_KEY = "greenlight_worker"
_PAYLOAD_KEYS = frozenset({"repo", "tick", "dispatch_cap"})


@dataclass(frozen=True)
class WorkerPayload:
    repo: str
    tick: str
    dispatch_cap: int


def worker_event(repo: str, tick: str, dispatch_cap: int) -> dict[str, object]:
    """The event the planner invokes ``repo``'s worker with."""
    return {WORKER_KEY: {"repo": repo, "tick": tick, "dispatch_cap": dispatch_cap}}


def worker_cap(payload_cap: int, max_dispatches: int | None) -> int:
    """A worker's dispatch cap: the payload's, at most ``OTHER_REPO_MAX_DISPATCHES``, and 0 while the
    handler's current ``max_dispatches`` pauses dispatching."""
    if max_dispatches is not None and max_dispatches <= 0:
        return 0
    return min(payload_cap, OTHER_REPO_MAX_DISPATCHES)


def parse_payload(event: Mapping[str, object]) -> WorkerPayload:
    """The worker payload ``event`` carries; ``ValueError`` on any other shape."""
    body = event.get(WORKER_KEY)
    if set(event) != {WORKER_KEY} or not isinstance(body, dict) or set(body) != _PAYLOAD_KEYS:
        raise ValueError(f"a worker event is exactly {{{WORKER_KEY!r}: {{{', '.join(sorted(_PAYLOAD_KEYS))}}}}}")
    repo, tick, cap = body["repo"], body["tick"], body["dispatch_cap"]
    if not isinstance(repo, str) or repo.count("/") != 1 or not isinstance(tick, str) or not tick:
        raise ValueError(f"a worker event names one owner/name repo and a tick, got {repo!r} and {tick!r}")
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 0:
        raise ValueError(f"a worker event's dispatch_cap is a non-negative integer, got {cap!r}")
    if is_primary(repo):
        raise ValueError(f"{repo} runs in the planner, never in a worker")
    return WorkerPayload(repo, tick, cap)


@dataclass
class Worker:
    """One worker invocation; ``started`` is its wall-clock start (epoch seconds), its lease's base, and
    ``max_dispatches`` the handler's current ``--max``."""

    config: Config
    payload: WorkerPayload
    store: StateStore
    tokens: AppTokens
    resolve_bot_login: Callable[[], str]
    ref: str
    timeout_minutes: int
    started: float
    max_dispatches: int | None
    seams: Seams = field(default_factory=Seams)
    owner: str = field(default_factory=lambda: uuid.uuid4().hex)

    @property
    def repo(self) -> str:
        return self.payload.repo

    def run(self) -> str:
        """Run the repo once; how it ended (``done``, ``busy``, ``replayed``, ``skipped``, ``no work``)."""
        expires = self.started + LEASE_DURATION.total_seconds()
        if not self.store.acquire_lease(self.repo, self.owner, expires=expires, now=self.seams.clock()):
            logger.warning("%s: its lease is held by another invocation; this worker ends", self.repo)
            return "busy"
        try:
            status = self._leased()
        finally:
            problem = leased_run.release(self.store, self.repo, self.owner)
        if problem is not None:
            raise RuntimeError(f"{self.repo}: {problem}")
        return status

    def _leased(self) -> str:
        repo, clock = self.repo, self.seams.clock
        item = self.store.read_repo(repo)
        if item.last_tick == self.payload.tick:
            logger.info("%s: tick %s already completed; this worker ends", repo, self.payload.tick)
            return "replayed"
        if (until := self.store.read_latch(clock())) is not None:
            logger.warning("%s: the shared rate-limit latch holds until %s; no work this tick", repo, epoch_text(until))
            return "skipped"
        settings = config_cache.decide(
            repo, item.config, unreadable=None, reachable=True, drain_complete=item.drain_complete
        ).settings
        entry = settings.entry
        work = None if entry is None else repo_scan.repo_work(entry, served=settings.served)
        if work is None or not repo_scan.has_work(work, drain_complete=item.drain_complete):
            logger.warning("%s: its stored settings give no work (%s); this worker ends", repo, settings.problem)
            return "no work"
        bot_login = self.resolve_bot_login()
        memory = decode_memory(item.memory, repo)
        with contextlib.ExitStack() as stack:
            invocation = Invocation(stack, self.seams, self.store)
            self._work(invocation, settings, memory, bot_login)
            leased_run.record_latch(invocation, self.store)
        outcomes = invocation.outcomes
        outcomes.name_the_rate_limit()
        if outcomes.errors:
            raise RuntimeError("; ".join(outcomes.errors))
        return "done"

    def _work(self, invocation: Invocation, settings: Settings, memory: ScanMemory, bot_login: str) -> None:
        repo, entry = self.repo, settings.entry
        minted = leased_run.mint(invocation, self.tokens, repo)
        if minted is None or entry is None or not self._identity_checked(invocation, entry, minted.repo):
            return
        options = leased_run.RunOptions(self.config, self.store, bot_login, self.ref, self.timeout_minutes)
        cap = worker_cap(self.payload.dispatch_cap, self.max_dispatches)
        run = leased_run.repo_run(
            invocation, options, minted, entry, served=settings.served, memory=memory, max_dispatches=cap
        )
        run.phase_a()
        run.phase_b()
        run.close()
        leased_run.keep_memory(invocation, self.store, repo, memory, owner=self.owner, tick=self.payload.tick)

    def _identity_checked(self, invocation: Invocation, entry: RepoEntry, token: str) -> bool:
        """Whether GitHub's current report of the repo passes every live check; a problem is the repo's error."""
        client = invocation.metered(self.repo)(token)
        try:
            outcome = invocation.outcomes.attempt(
                self.repo,
                "its identity check",
                lambda: repo_scan.check_identity(entry, repo_scan.fetch_identity(client, self.repo)),
            )
        finally:
            github_client.close_client(client)
        return outcome == "done"
