"""The approval-backing check: a ``gate`` repo's scan dismisses every live GreenLight approval no LAND row backs.

A ``gate`` repo has no pytorchbot reading the ledger at land time. This check is the scan's safety work for
every ``gate`` repo whose mode is not ``off``: it dismisses each live GreenLight approval the ledger does not
back on the PR's current head and on ``TARGET_BRANCH``. It does not trust the ledger to find approvals, since
one can exist with no row: it reads GreenLight's reviews through the ``approvals.ReviewReader`` the repo's
memory keeps between ticks (``scan_memory.BackingMemory``), so an unchanged PR costs a 304.

Each tick (``check``) lists every open PR, drafts and every author included, reads their latest non-shadow
rows and verdicts in one ClickHouse query and the ledger's newest row version in another, and judges the
repo's branch rules (``gate_rules``). It then reads the reviews of:

- every open PR with a non-shadow verdict (the fast part);
- every PR left waiting last tick;
- a slice of the sweep over every open PR (a ``scan_memory.DrainPass``), sized so the sweep reads every PR
  within ``FULL_TICK_INTERVAL`` of its start: ``ceil(pending / ticks left in the window)`` per tick, PRs with
  a ledger row first. Past the window the sweep is the repo's error and goes on at the steady rate,
  ``ceil(open / ticks in a window)`` per tick. A PR checked successfully by any part is checked in the sweep;
  a failed one stays pending. The sweep ends once no open PR is pending, and the next starts the next tick.

``backing_judge.judge`` decides each live approval. Before dismissing, the PR is read fresh and every live
approval is judged again on its fresh head and base; those still unbacked are dismissed by id, through
``ineligible_approvals.dismiss_each``'s guard and failure accounting.

Listing and ClickHouse failures raise. A rate limit on any GitHub read sets ``cancel_event`` and ends the
check. Any other failure reading the rules leaves their answer unknown (None): judging goes on without it.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import approvals, backing_judge, drain, gate_rules, github_client, state
from greenlight.constants import BOT_LOGIN_SUFFIX, FULL_TICK_INTERVAL, SCAN_TICK_INTERVAL, is_app_login
from greenlight.guards import IterationTimeout
from greenlight.ineligible_approvals import dismiss_each

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Iterable, Sequence

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.approvals import PullFacts, ReviewReader, ReviewRecord
    from greenlight.backing_judge import Judgement
    from greenlight.config import Config
    from greenlight.gate_rules import GateRules
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import BackingMemory, DrainPass, ScanMemory
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_DISMISS_MESSAGE = "GreenLight's approval no longer applies"
_WINDOW_TICKS = FULL_TICK_INTERVAL // SCAN_TICK_INTERVAL
_WINDOW_MINUTES = int(FULL_TICK_INTERVAL.total_seconds() // 60)


@dataclass(frozen=True, slots=True)
class BackingReport:
    """One tick of a gate repo's approval-backing check; ``rules`` is None when they could not be read."""

    rules: GateRules | None
    open_prs: int
    fast_reads: int
    sweep_reads: int
    waiting: int
    dismissed: int
    sweep_number: int
    sweep_checked: int
    sweep_pending: int
    failed: tuple[int, ...]
    errors: tuple[str, ...]


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@dataclass
class _Check:
    """One tick's reads and dismissals on a gate repo; every judgement uses the tick's rows, rules and clock."""

    repo: str
    client: Github
    reader: ReviewReader
    sweep: DrainPass
    pulls: dict[int, PullRequest]
    gates: dict[int, PRState]
    rules: GateRules | None
    ledger_newest: datetime | None
    now: datetime
    bot_login: str
    cancel_event: threading.Event
    tried: set[int] = field(default_factory=set)
    checked: set[int] = field(default_factory=set)
    waiting: set[int] = field(default_factory=set)
    failed: list[int] = field(default_factory=list)
    dismissed: int = 0

    def judge(self, approval: ReviewRecord, number: int, head: str, base: str) -> Judgement:
        return backing_judge.judge(
            approval,
            repo=self.repo,
            head=head,
            base=base,
            gate=self.gates.get(number),
            rules=self.rules,
            ledger_newest=self.ledger_newest,
            now=self.now,
        )

    def read_all(self, numbers: Iterable[int]) -> int:
        """Check each PR in ``numbers`` not tried yet this tick, until a rate limit; how many it tried."""
        tried = 0
        for number in numbers:
            if self.cancel_event.is_set():
                break
            if number in self.tried:
                continue
            self.read(number)
            tried += 1
        return tried

    def read(self, number: int) -> None:
        self.tried.add(number)
        self.sweep.attempt(number)
        try:
            reviews = self.reader.reviews(self.repo, number)
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                self.cancel_event.set()
            logger.error("%s: cannot read GreenLight's reviews on PR #%d: %s", self.repo, number, exc, exc_info=True)
            self.failed.append(number)
            return
        pull = self.pulls[number]
        judged = [
            self.judge(approval, number, pull.head.sha, pull.base.ref)
            for approval in approvals.live_approvals(reviews, self.bot_login)
        ]
        if any(judgement.state == "unbacked" for judgement in judged):
            if not self.dismiss(number, reviews):
                return
        elif any(judgement.state == "waiting" for judgement in judged):
            self.waiting.add(number)
        self.checked.add(number)
        self.sweep.checked.add(number)

    def dismiss(self, number: int, reviews: list[ReviewRecord]) -> bool:
        """Judge the live approvals again on a fresh read of the PR and dismiss the unbacked ones; False on failure."""

        def dismiss_unbacked(fresh: PullFacts, *, bot_login: str, message: str) -> list[int]:
            dismissed: list[int] = []
            for approval in approvals.live_approvals(reviews, bot_login):
                judgement = self.judge(approval, number, fresh.head_sha, fresh.base_ref)
                if judgement.state == "waiting":
                    self.waiting.add(number)
                elif judgement.state == "unbacked":
                    approvals.dismiss_review(
                        self.client.requester, self.repo, number, approval.id, f"{message}: {judgement.reason}."
                    )
                    self.dismissed += 1
                    dismissed.append(approval.id)
            return dismissed

        outcome = dismiss_each(
            self.client,
            [number],
            repo=self.repo,
            bot_login=self.bot_login,
            message=_DISMISS_MESSAGE,
            why=f"in {self.repo}, as no LAND row backs it",
            get_pr=lambda _client, repo, pr: self.reader.pull(repo, pr),
            dismiss=dismiss_unbacked,
            failed=self.failed,
            cancel_event=self.cancel_event,
        )
        return number in outcome


def _sweep_slice(sweep: DrainPass, open_prs: Collection[int], tried: set[int], now: datetime) -> tuple[list[int], int]:
    """The sweep's PRs to read this tick, in its order, and how many were unread once its window had passed."""
    pending = sweep.pending(open_prs)
    left = sweep.started_at + FULL_TICK_INTERVAL - now
    if left > timedelta(0):
        ticks_left = max(1, min(_WINDOW_TICKS, left // SCAN_TICK_INTERVAL))
        size, late = math.ceil(len(pending) / ticks_left), 0
    else:
        size, late = math.ceil(len(open_prs) / _WINDOW_TICKS), len(pending)
    return [number for number in pending if number not in tried][:size], late


def _drop_interrupted_sweep(repo: str, backing: BackingMemory, at: datetime) -> None:
    """Drop the sweep under way when the check did not run for a whole window (the repo was off, or its token
    could not be had), so the next sweep starts over instead of reporting the gap as an incomplete sweep."""
    last, backing.checked_at = backing.checked_at, at
    if backing.sweep is not None and last is not None and at - last > FULL_TICK_INTERVAL:
        logger.info("%s: the approval-backing check last ran at %s; starting a new sweep", repo, last)
        backing.sweep = None


def _read_rules(
    read_rules: Callable[[Github, str], GateRules],
    client: Github,
    repo: str,
    cancel_event: threading.Event,
    errors: list[str],
) -> GateRules | None:
    """``repo``'s gate rules, or None, the failure added to ``errors``; a rate limit also sets ``cancel_event``."""
    try:
        return read_rules(client, repo)
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            cancel_event.set()
        logger.error("%s: cannot read GreenLight's gate rules: %s", repo, exc, exc_info=True)
        errors.append(f"GreenLight's gate rules on {repo} could not be read: {exc}")
        return None


def _reader(backing: BackingMemory, client: Github) -> ReviewReader:
    if backing.reader is None:
        backing.reader = approvals.ReviewReader(client.requester)
    else:
        backing.reader.rebind(client.requester)
    return backing.reader


def check(
    config: Config,
    *,
    entry: RepoEntry,
    memory: ScanMemory,
    bot_login: str,
    build_github: Callable[[str], Github] = github_client.build_client,
    cancel_event: threading.Event | None = None,
    now: Callable[[], datetime] = _utcnow,
    list_prs: Callable[[Github, str], Sequence[PullRequest]] = drain.list_open_pulls,
    read_gates: Callable[[str, Sequence[int]], tuple[dict[int, PRState], dict[int, PRState]]] = state.read_gate_rows,
    read_ledger_newest: Callable[[], datetime | None] = backing_judge.read_newest_version,
    read_rules: Callable[[Github, str], GateRules] = gate_rules.read_gate_rules,
) -> BackingReport:
    """Run one tick of ``entry``'s approval-backing check. Listing and ClickHouse failures raise.

    A rate limit sets ``cancel_event`` (a fresh event by default) and ends the check, as does an event already
    set. A ``bot_login`` that is not the App's matches no approval, so it raises before any read.
    """
    repo = entry.repo
    if cancel_event is None:
        cancel_event = threading.Event()
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to check a repo's approvals")
    if not is_app_login(bot_login):
        raise ValueError(
            f"BOT_LOGIN must be the greenlight App login (<app-slug>{BOT_LOGIN_SUFFIX}) to check the approvals on "
            f"{repo}; got {bot_login!r}"
        )
    started = time.monotonic()
    backing = memory.backing
    errors: list[str] = []
    client = build_github(token)
    try:
        pulls = {pull.number: pull for pull in list_prs(client, repo)}
        at = now()
        rules = _read_rules(read_rules, client, repo, cancel_event, errors)
        if cancel_event.is_set():
            return _report(repo, backing, rules, pulls, None, (0, 0), errors, started)
        gates, verdicts = read_gates(repo, sorted(pulls))
        ledger_newest = read_ledger_newest()
        _drop_interrupted_sweep(repo, backing, at)
        sweep = backing.sweep or backing.start_sweep(at, recorded=frozenset(gates))
        run = _Check(
            repo=repo,
            client=client,
            reader=_reader(backing, client),
            sweep=sweep,
            pulls=pulls,
            gates=gates,
            rules=rules,
            ledger_newest=ledger_newest,
            now=at,
            bot_login=bot_login,
            cancel_event=cancel_event,
        )
        fast_reads = run.read_all(sorted(number for number in verdicts if number in pulls))
        run.read_all(sorted(number for number in backing.waiting if number in pulls))
        sweep_part, late = _sweep_slice(sweep, pulls, run.tried, at)
        if late:
            errors.append(f"sweep {sweep.number} incomplete after {_WINDOW_MINUTES} minutes: {late} PRs unread")
        sweep_reads = run.read_all(sweep_part)
    finally:
        github_client.close_client(client)
    unread = {number for number in backing.waiting if number in pulls and number not in run.checked}
    backing.waiting = frozenset(run.waiting | unread)
    run.reader.prune(pulls.keys())
    report = _report(repo, backing, rules, pulls, run, (fast_reads, sweep_reads), errors, started)
    if not sweep.pending(pulls):
        backing.sweep = None
    return report


def _report(
    repo: str,
    backing: BackingMemory,
    rules: GateRules | None,
    pulls: dict[int, PullRequest],
    run: _Check | None,
    reads: tuple[int, int],
    errors: list[str],
    started: float,
) -> BackingReport:
    failed = tuple(run.failed) if run is not None else ()
    if failed:
        errors.append(f"the approval-backing check failed on {len(failed)} PR(s): {list(failed)}")
    sweep = backing.sweep
    report = BackingReport(
        rules=rules,
        open_prs=len(pulls),
        fast_reads=reads[0],
        sweep_reads=reads[1],
        waiting=len(backing.waiting),
        dismissed=0 if run is None else run.dismissed,
        sweep_number=0 if sweep is None else sweep.number,
        sweep_checked=0 if sweep is None else len(sweep.checked & pulls.keys()),
        sweep_pending=0 if sweep is None else len(sweep.pending(pulls)),
        failed=failed,
        errors=tuple(errors),
    )
    logger.info(
        "%s: approval backing: %d open PR(s), fast part %d, sweep %d (%d checked, %d pending, %d read), %d waiting, "
        "%d dismissed, %d failed, in %.1f s",
        repo,
        report.open_prs,
        report.fast_reads,
        report.sweep_number,
        report.sweep_checked,
        report.sweep_pending,
        report.sweep_reads,
        report.waiting,
        report.dismissed,
        len(report.failed),
        time.monotonic() - started,
    )
    return report
