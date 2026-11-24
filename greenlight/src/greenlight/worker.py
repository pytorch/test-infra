"""The scan Lambda's worker: one repo's run, invoked asynchronously by the planner (``fanout``).

Its event is only ``{"greenlight_worker": {"repo": ..., "tick": ..., "dispatch_cap": n}}`` (``worker_event``);
``parse_payload`` refuses any other shape, and pytorch/pytorch, whose run is the planner's. ``Worker.run``:

1. takes the repo's lease, and ends, logging, when another invocation holds it;
2. reads the repo's item, and ends when its run already completed this tick (a replayed invocation);
3. ends when the shared rate-limit latch holds: a repo other than the primary gets no work then;
4. derives the repo's settings from the config record the planner stored (``config_cache.decide``, the
   planner's own decision), and ends when they give no work;
5. resolves the App's bot login, clamps the dispatch cap to ``OTHER_REPO_MAX_DISPATCHES``, loads the repo's
   memory, and mints its repo token and the dispatch token;
6. runs Phase A then Phase B (``tick.RepoRun``);
7. saves the memory with the completed tick under its lease, extends the shared latch by any rate limit it
   met, releases the lease, and raises when the repo had errors.

A store failure fails the worker before any GitHub work.
"""

from __future__ import annotations

import contextlib
import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import config_cache, repo_scan
from greenlight.constants import LEASE_DURATION, OTHER_REPO_MAX_DISPATCHES
from greenlight.repo_config import is_primary
from greenlight.scan_memory import decode_memory, encode_memory
from greenlight.state_store import StoreError, epoch_text
from greenlight.tick import Invocation, RepoRun, Seams, run_config

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from greenlight.app_tokens import AppTokens
    from greenlight.config import Config
    from greenlight.repo_config import Settings
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
    """One worker invocation; ``started`` is its wall-clock start (epoch seconds), its lease's base."""

    config: Config
    payload: WorkerPayload
    store: StateStore
    tokens: AppTokens
    resolve_bot_login: Callable[[], str]
    ref: str
    timeout_minutes: int
    started: float
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
        problem: str | None = None
        try:
            status = self._leased()
        finally:
            problem = self._release()
        if problem is not None:
            raise RuntimeError(problem)
        return status

    def _release(self) -> str | None:
        try:
            if not self.store.release_lease(self.repo, self.owner):
                logger.warning("%s: its lease was no longer held at release", self.repo)
        except StoreError as exc:
            logger.error("%s: cannot release its lease", self.repo, exc_info=True)
            return f"{self.repo}: its lease could not be released: {exc}"
        return None

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
        if entry is None or repo_scan.repo_work(entry, served=settings.served).kind == "none":
            logger.warning("%s: its stored settings give no work (%s); this worker ends", repo, settings.problem)
            return "no work"
        bot_login = self.resolve_bot_login()
        memory = decode_memory(item.memory, repo)
        with contextlib.ExitStack() as stack:
            invocation = Invocation(stack, self.seams)
            self._work(invocation, settings, memory, bot_login)
            until = invocation.meter.latch_until
            if until is not None:
                self._record_latch(invocation, until)
        outcomes = invocation.outcomes
        outcomes.name_the_rate_limit()
        if outcomes.errors:
            raise RuntimeError("; ".join(outcomes.errors))
        return "done"

    def _work(self, invocation: Invocation, settings: Settings, memory: ScanMemory, bot_login: str) -> None:
        repo, tokens = self.repo, self.tokens
        token = invocation.outcomes.result(repo, "its token", lambda: tokens.repo_token(repo))
        if token is None or settings.entry is None:
            return
        invocation.watch_quota(token)
        dispatch_token = invocation.outcomes.result(repo, "the dispatch token", tokens.dispatch_token)
        run = RepoRun(
            invocation,
            run_config(self.config, token, dispatch_token),
            settings.entry,
            settings.served,
            memory,
            self.store,
            bot_login,
            min(self.payload.dispatch_cap, OTHER_REPO_MAX_DISPATCHES),
            self.ref,
            self.timeout_minutes,
        )
        run.phase_a()
        run.phase_b()
        run.close()
        try:
            self.store.save_memory(
                repo,
                encode_memory(memory, repo),
                owner=self.owner,
                now=self.seams.clock(),
                tick=self.payload.tick,
                drain_complete=memory.drain_completed_by() is not None,
            )
        except StoreError as exc:
            logger.error("%s: cannot save its memory", repo, exc_info=True)
            invocation.outcomes.error(repo, f"its memory could not be saved: {exc}")

    def _record_latch(self, invocation: Invocation, until: float) -> None:
        try:
            self.store.extend_latch(until, self.seams.clock())
        except StoreError as exc:
            logger.error("cannot record the shared rate-limit latch", exc_info=True)
            invocation.outcomes.problem(f"the state store failed recording the rate-limit latch: {exc}")
