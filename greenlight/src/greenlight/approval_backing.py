"""The approval-backing check: a ``gate`` repo's scan dismisses every live GreenLight approval no LAND row backs.

A ``gate`` repo has no pytorchbot reading the ledger at land time. This check is the scan's safety work for
every ``gate`` repo whose mode is not ``off``: it dismisses each live GreenLight approval the ledger does not
back on the PR's current head and on ``TARGET_BRANCH``. It does not trust the ledger to find approvals, since
one can exist with no row: it reads GreenLight's reviews through the ``approvals.ReviewReader`` the repo's
memory keeps between ticks (``scan_memory.BackingMemory``); what each PR was last read at keeps an unchanged PR
from being read again, since the Lambda's new token each tick gets no 304 for an earlier token's ETag.

Each tick (``check``) lists every open PR, drafts and every author included, reads their latest non-shadow
rows and verdicts in one ClickHouse query and the ledger's newest row version in another, and judges the
repo's branch rules (``gate_rules``). A PR's key (``scan_memory.BackingKey``) is its listed ``updated_at``,
head and base, its latest non-shadow row and the rules' answer; the memory keeps each PR's key as of its last
settled read. The check then reads the reviews of, each PR at most once a tick:

- every ledger PR, one with a non-shadow verdict or whose latest non-shadow row is in flight (its record job
  may approve before its row lands), whose key is not the one kept, a PR never read included;
- every other open PR whose kept key is not its key: read before, it changed since;
- every PR left waiting last tick;
- a slice of the sweep over every open PR (a ``scan_memory.DrainPass``), sized so the sweep reads every PR
  within ``FULL_TICK_INTERVAL`` of its start: ``ceil(pending / ticks left in the window)`` per tick, PRs with
  a ledger row first. Past the window the sweep is the repo's error and goes on at the steady rate,
  ``ceil(open / ticks in a window)`` per tick. A PR checked successfully by any part is checked in the sweep;
  a failed one stays pending. The sweep ends once no open PR is pending, and the next starts the next tick.

A PR outside the ledger that was never read waits for the sweep. ``backing_reads.TickReads`` reads them and
``backing_judge.judge`` decides each live approval. Before dismissing, the PR is read fresh and every live
approval is judged again on its fresh head and base; those still unbacked are dismissed by id, through
``ineligible_approvals.dismiss_each``'s guard and failure accounting. A read whose judgement settles (backed,
nothing live, or its dismissals done) keeps the PR's key; a PR judged waiting or unknown is read again next tick.

Listing failures raise. A ClickHouse failure is the repo's error and the check goes on without the ledger: no PR
is a ledger PR, each key keeps the row it was kept with, and an approval the ledger would decide is unknown, so
only the rules, its commit and its base dismiss it. A rate limit on any GitHub read sets ``cancel_event`` and
ends the check. Any other failure reading the rules leaves their answer unknown (None): judging goes on without it.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import approvals, backing_judge, drain, gate_rules, github_client, state
from greenlight.backing_reads import Ledger, TickReads
from greenlight.constants import FULL_TICK_INTERVAL, SCAN_TICK_INTERVAL
from greenlight.guards import IterationTimeout
from greenlight.scan_memory import BackingKey

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Sequence

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.approvals import ReviewReader
    from greenlight.config import Config
    from greenlight.gate_rules import GateRules
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import BackingMemory, DrainPass, ScanMemory
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_WINDOW_TICKS = FULL_TICK_INTERVAL // SCAN_TICK_INTERVAL
_WINDOW_MINUTES = int(FULL_TICK_INTERVAL.total_seconds() // 60)


@dataclass(frozen=True, slots=True)
class BackingReport:
    """One tick of a gate repo's approval-backing check; ``rules`` is None when they could not be read.

    ``changed_reads`` counts the ledger PRs and the PRs read before that it read because their key changed.
    """

    rules: GateRules | None
    open_prs: int
    changed_reads: int
    sweep_reads: int
    waiting: int
    dismissed: int
    sweep_number: int
    sweep_checked: int
    sweep_pending: int
    failed: tuple[int, ...]
    errors: tuple[str, ...]


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


def _attempt[T](
    read: Callable[[], T], what: str, repo: str, cancel_event: threading.Event, errors: list[str]
) -> T | None:
    """``read()``, or None, the failure logged and added to ``errors``; a rate limit also sets ``cancel_event``."""
    try:
        return read()
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            cancel_event.set()
        logger.error("%s: cannot read %s: %s", repo, what, exc, exc_info=True)
        errors.append(f"{what} on {repo} could not be read: {exc}")
        return None


def _key(pull: PullRequest, ledger: Ledger | None, kept: BackingKey | None, rules: GateRules | None) -> BackingKey:
    """``pull``'s key this tick; with the ledger unknown, its row is the one its kept key holds."""
    if ledger is None:
        gate_row = None if kept is None else kept.gate_row
    else:
        row = ledger.gates.get(pull.number)
        gate_row = None if row is None else (row.status, row.run_id, row.version)
    updated_at = pull.updated_at
    return BackingKey(
        updated_at=None if updated_at is None else state.naive_utc(updated_at),
        head_sha=pull.head.sha,
        base_ref=pull.base.ref,
        gate_row=gate_row,
        rules_state=None if rules is None else rules.enforced,
    )


def _changed(keys: dict[int, BackingKey], kept: dict[int, BackingKey], ledger: Ledger | None) -> list[int]:
    """The ledger PRs whose key is not the kept one, then every other PR whose kept key is not its key."""
    driven = sorted(number for number in keys if ledger is not None and ledger.drives(number))
    others = sorted(number for number in keys.keys() - set(driven) if number in kept)
    return [number for number in [*driven, *others] if keys[number] != kept.get(number)]


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
    now: Callable[[], datetime] = drain._utcnow,
    list_prs: Callable[[Github, str], Sequence[PullRequest]] = drain.list_open_pulls,
    read_gates: Callable[[str, Sequence[int]], tuple[dict[int, PRState], dict[int, PRState]]] = state.read_gate_rows,
    read_ledger_newest: Callable[[], datetime | None] = backing_judge.read_newest_version,
    read_rules: Callable[[Github, str], GateRules] = gate_rules.read_gate_rules,
) -> BackingReport:
    """Run one tick of ``entry``'s approval-backing check. Listing failures raise; a ClickHouse failure is an error.

    A rate limit sets ``cancel_event`` (a fresh event by default) and ends the check, as does an event already
    set. A ``bot_login`` other than ``approvals.GREENLIGHT_LOGIN`` would judge another account's approvals than
    the merge gate does, so it raises before any read.
    """
    repo = entry.repo
    if cancel_event is None:
        cancel_event = threading.Event()
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to check a repo's approvals")
    if bot_login != approvals.GREENLIGHT_LOGIN:
        raise ValueError(
            f"BOT_LOGIN must be {approvals.GREENLIGHT_LOGIN}, the account the merge gate judges, to check the "
            f"approvals on {repo}; got {bot_login!r}"
        )
    started = time.monotonic()
    backing = memory.backing
    errors: list[str] = []
    client = build_github(token)
    try:
        pulls = {pull.number: pull for pull in list_prs(client, repo)}
        at = now()
        kept = backing.keys = {number: key for number, key in backing.keys.items() if number in pulls}
        rules = _attempt(lambda: read_rules(client, repo), "GreenLight's gate rules", repo, cancel_event, errors)
        if cancel_event.is_set():
            return _report(repo, backing, rules, pulls, None, (0, 0), errors, started)

        def read_ledger() -> Ledger:
            gates, verdicts = read_gates(repo, sorted(pulls))
            return Ledger(gates, verdicts, read_ledger_newest())

        ledger = _attempt(read_ledger, "GreenLight's ledger", repo, cancel_event, errors)
        _drop_interrupted_sweep(repo, backing, at)
        sweep = backing.sweep or backing.start_sweep(at, recorded=frozenset(() if ledger is None else ledger.gates))
        keys = {number: _key(pull, ledger, kept.get(number), rules) for number, pull in pulls.items()}
        run = TickReads(
            repo=repo,
            client=client,
            reader=_reader(backing, client),
            sweep=sweep,
            pulls=pulls,
            ledger=ledger,
            rules=rules,
            keys=keys,
            kept=kept,
            now=at,
            bot_login=bot_login,
            cancel_event=cancel_event,
        )
        changed_reads = run.read_all(_changed(keys, kept, ledger))
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
    report = _report(repo, backing, rules, pulls, run, (changed_reads, sweep_reads), errors, started)
    if not sweep.pending(pulls):
        backing.sweep = None
    return report


def _report(
    repo: str,
    backing: BackingMemory,
    rules: GateRules | None,
    pulls: dict[int, PullRequest],
    run: TickReads | None,
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
        changed_reads=reads[0],
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
        "%s: approval backing: %d open PR(s), %d changed, sweep %d (%d checked, %d pending, %d read), %d waiting, "
        "%d dismissed, %d failed, in %.1f s, gate rules %s",
        repo,
        report.open_prs,
        report.changed_reads,
        report.sweep_number,
        report.sweep_checked,
        report.sweep_pending,
        report.sweep_reads,
        report.waiting,
        report.dismissed,
        len(report.failed),
        time.monotonic() - started,
        _rules_answer(rules),
    )
    return report


def _rules_answer(rules: GateRules | None) -> str:
    if rules is None:
        return "unread"
    if rules.enforced:
        return "enforced"
    return "not enforced: " + "; ".join(rules.problems)
