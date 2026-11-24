"""The scan Lambda's planner, run on each scheduled event: pytorch/pytorch's run, then a worker per other repo.

``Planner.run``:

1. reads the shared rate-limit latch from the state store; pytorch/pytorch's Phase A runs whatever it says;
2. pytorch/pytorch first: mints its repo token and the dispatch token, takes its lease, loads its stored
   item, revalidates its config (``config_cache``), and runs its Phase A (``tick.RepoRun``) here: its
   safety work never waits on a worker;
3. reads the shared latch again, then the fan-out (``fanout_repos.FanOut``), unless the store failed, the
   shared latch holds, or this invocation met a rate limit, in which case every stored repo is skipped;
4. pytorch/pytorch's Phase B, unless one of those holds or the installation listing refuses it; its memory
   is saved under its lease with the tick, and the lease released (``leased_run``);
5. one ``greenlight repo outcome: <repo> <outcome> [<detail>]`` line per repo, pytorch/pytorch's from what
   its Phase B did (``primary_line``), the shared latch extended by any rate limit met, and one error raised
   naming every problem.

The invocation's latch follows the shared one while it runs (``latch``), so a rate limit another invocation
meets stops the fan-out and pytorch/pytorch's Phase B, never its Phase A. A store failure reading the latch,
taking pytorch/pytorch's lease or reading its item leaves the planner running its Phase A on a cold memory,
skipping its Phase B and the fan-out, saving no memory (a lease taken is still released), and failing. Its
lease busy (another planner still runs it) is a problem: that tick runs nothing for it.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import config_cache, github_client, leased_run, repo_scan
from greenlight.constants import AWS_REGION, LEASE_DURATION, TARGET_REPO
from greenlight.fanout_repos import INSTALLATION, FanOut, Line, write_config
from greenlight.repo_config import BUILTIN_PYTORCH
from greenlight.scan_memory import ScanMemory, decode_memory
from greenlight.state_store import RepoItem, StoreError, epoch_text
from greenlight.tick import Invocation, RepoRun, Seams
from greenlight.tick_outcomes import RATE_LIMITED

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from greenlight.app_tokens import AppTokens
    from greenlight.config import Config
    from greenlight.repo_scan import RepoIdentity
    from greenlight.state_store import StateStore

logger = logging.getLogger(__name__)

OUTCOME_LINE = "greenlight repo outcome: %s %s%s"
_ACCEPTED = 202


def primary_line(run: RepoRun) -> Line:
    """pytorch/pytorch's outcome from what its run did: drained, safety-only, or how its Phase B ended."""
    work, outcome = run.work, run.phase_b_outcome
    if work.kind == "drain":
        return Line("draining")
    if not work.optional:
        return Line("safety-only")
    if run.held is not None or outcome is None:
        return Line("safety-only", f"no Phase B: {run.held}")
    if outcome == "done":
        return Line("served")
    if outcome == "failed":
        return Line("failed", "Phase B failed")
    if outcome == "cut":
        return Line("cut", f"Phase B cut short: {run.invocation.meter.meter(run.repo).stopped}")
    return Line("cut", f"Phase B stopped: {RATE_LIMITED}")


def lambda_invoker(function_name: str) -> Callable[[Mapping[str, object]], None]:
    """Invoke ``function_name`` asynchronously with an event; raise unless Lambda accepted it (202)."""
    import boto3
    from botocore.config import Config as BotoConfig

    config = BotoConfig(connect_timeout=5, read_timeout=10, retries={"max_attempts": 3, "mode": "standard"})
    client = boto3.client("lambda", region_name=AWS_REGION, config=config)

    def invoke(event: Mapping[str, object]) -> None:
        response = client.invoke(FunctionName=function_name, InvocationType="Event", Payload=json.dumps(event).encode())
        status = response.get("StatusCode")
        if status != _ACCEPTED:
            raise RuntimeError(f"Lambda answered {status} to an asynchronous invoke of {function_name}")

    return invoke


@dataclass
class Planner:
    """One planner invocation; ``started`` is its wall-clock start (epoch seconds), its leases' base."""

    config: Config
    tick: str
    store: StateStore
    tokens: AppTokens
    invoke: Callable[[Mapping[str, object]], None]
    bot_login: str
    max_dispatches: int | None
    ref: str
    timeout_minutes: int
    started: float
    seams: Seams = field(default_factory=Seams)
    lines: dict[str, Line] = field(default_factory=dict)
    owner: str = field(default_factory=lambda: uuid.uuid4().hex)
    store_down: bool = False
    latch_until: float | None = None
    leased: bool = False
    refusal: str | None = None
    invocation: Invocation = field(init=False)

    def run(self) -> None:
        """Run the tick; raise one error naming every problem found."""
        with contextlib.ExitStack() as stack:
            self.invocation = Invocation(stack, self.seams, self.store)
            try:
                self._read_latch()
                primary = self._primary_phase_a()
                if (why := self._why_no_fan_out()) is None:
                    self._fan_out()
                else:
                    self._skip_others(why)
                if primary is not None:
                    self._primary_phase_b(primary, why)
            finally:
                self._release()
                if not self.store_down:
                    leased_run.record_latch(self.invocation, self.store)
                for repo, line in sorted(self.lines.items()):
                    level = logging.INFO if line.detail is None else logging.WARNING
                    logger.log(
                        level, OUTCOME_LINE, repo, line.outcome, "" if line.detail is None else f" {line.detail}"
                    )
        outcomes = self.invocation.outcomes
        outcomes.name_the_rate_limit()
        if outcomes.errors:
            raise RuntimeError("; ".join(outcomes.errors))

    def _store_failed(self, step: str, exc: StoreError) -> None:
        logger.error("the state store failed %s", step, exc_info=exc)
        self.invocation.outcomes.problem(f"the state store failed {step}: {exc}")
        self.store_down = True

    def _read_latch(self) -> None:
        try:
            self.latch_until = self.store.read_latch(self.seams.clock())
        except StoreError as exc:
            self._store_failed("reading the rate-limit latch", exc)
            return
        if self.latch_until is not None:
            self.invocation.outcomes.problem(
                f"the shared rate-limit latch holds until {epoch_text(self.latch_until)}: "
                "no Phase B and no other repo's work this tick"
            )

    def _why_no_fan_out(self) -> str | None:
        if self.store_down:
            return "the state store failed"
        if self.latch_until is not None:
            return f"the shared rate-limit latch holds until {epoch_text(self.latch_until)}"
        self.invocation.meter.latch.recheck()
        if self.invocation.meter.latch.is_set():
            return RATE_LIMITED
        return None

    def _take_lease(self, repo: str) -> bool:
        """Take ``repo``'s lease unless the store is down; False when another invocation holds it."""
        if self.store_down:
            return True
        expires = self.started + LEASE_DURATION.total_seconds()
        try:
            self.leased = self.store.acquire_lease(repo, self.owner, expires=expires, now=self.seams.clock())
        except StoreError as exc:
            self._store_failed(f"taking the lease of {repo}", exc)
            return True
        return self.leased

    def _read_item(self, repo: str) -> RepoItem:
        if self.store_down:
            return RepoItem(repo)
        try:
            return self.store.read_repo(repo)
        except StoreError as exc:
            self._store_failed(f"reading {repo}", exc)
            return RepoItem(repo)

    def _primary_phase_a(self) -> RepoRun | None:
        repo, invocation = TARGET_REPO, self.invocation
        minted = leased_run.mint(invocation, self.tokens, repo)
        if minted is None:
            self.lines[repo] = Line("skipped", "its token could not be minted")
            return None
        if not self._take_lease(repo):
            invocation.outcomes.error(repo, "its lease is held by another invocation; nothing runs for it this tick")
            self.lines[repo] = Line("busy", "its lease is held by another invocation")
            return None
        item = self._read_item(repo)
        client = invocation.metered(repo)(minted.repo)
        try:
            read = invocation.outcomes.result(
                repo,
                "its config read",
                lambda: config_cache.revalidate(item.config, client, repo, now=self.seams.clock()),
            )
        finally:
            github_client.close_client(client)
        record, unreadable = read or (item.config, RATE_LIMITED)
        decision = config_cache.decide(
            repo, record, unreadable=unreadable, reachable=True, drain_complete=item.drain_complete
        )
        if not self.store_down:
            write_config(invocation, self.store, repo, item.config, decision.record)
        settings = decision.settings
        if settings.problem is not None:
            invocation.outcomes.error(repo, settings.problem)
        if settings.entry is None:
            raise RuntimeError(f"{repo} has no settings")
        options = leased_run.RunOptions(self.config, self.store, self.bot_login, self.ref, self.timeout_minutes)
        memory = decode_memory(item.memory, repo) if self.leased else ScanMemory()
        run = leased_run.repo_run(
            invocation,
            options,
            minted,
            settings.entry,
            served=settings.served,
            memory=memory,
            max_dispatches=self.max_dispatches,
        )
        run.phase_a()
        return run

    def _stored(self) -> dict[str, RepoItem] | None:
        try:
            return self.store.scan_repos()
        except StoreError as exc:
            logger.error("cannot list the stored repos", exc_info=True)
            self.invocation.outcomes.problem(f"the state store failed listing the stored repos: {exc}")
            return None

    def _skip_others(self, why: str) -> None:
        if self.store_down:
            return
        stored = self._stored()
        if stored is not None:
            self._fan_out_state().skip(stored, why)

    def _fan_out_state(self) -> FanOut:
        return FanOut(
            self.invocation,
            self.store,
            self.tokens,
            self.invoke,
            self.tick,
            self.max_dispatches,
            self.config.max_workers,
            self.lines,
        )

    def _fan_out(self) -> None:
        stored = self._stored()
        if stored is None:
            return
        listing = self._fan_out_state().run(stored)
        if listing is not None:
            self._refuse_primary(listing)

    def _refuse_primary(self, listing: Mapping[str, RepoIdentity]) -> None:
        """Hold back pytorch/pytorch's Phase B when the installation listing refuses it."""
        identity = listing.get(TARGET_REPO.lower())
        if identity is None:
            self.refusal = f"{INSTALLATION} does not list it"
        else:
            self.refusal = repo_scan.identity_problem(BUILTIN_PYTORCH, identity)
        if self.refusal is not None:
            self.invocation.outcomes.error(TARGET_REPO, f"no Phase B this tick: {self.refusal}")

    def _primary_phase_b(self, run: RepoRun, why: str | None) -> None:
        held_back = why or self.refusal
        if held_back is not None:
            run.hold(held_back)
        run.phase_b()
        run.close()
        self.lines[TARGET_REPO] = primary_line(run)
        if self.leased and not self.store_down:
            leased_run.keep_memory(
                self.invocation, self.store, TARGET_REPO, run.memory, owner=self.owner, tick=self.tick
            )

    def _release(self) -> None:
        if self.leased and (problem := leased_run.release(self.store, TARGET_REPO, self.owner)) is not None:
            self.invocation.outcomes.error(TARGET_REPO, problem)
