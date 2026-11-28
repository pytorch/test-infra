"""The approval-backing check: a ``gate`` repo's scan dismisses every live GreenLight approval no LAND row backs.

A ``gate`` repo has no pytorchbot reading the ledger at land time. This check is the scan's safety work for
every ``gate`` repo whose mode is not ``off``: it dismisses each live GreenLight approval the ledger does not
back on the PR's current head and on ``TARGET_BRANCH``. It does not trust the ledger to find approvals, since
one can exist with no row: it reads GreenLight's reviews through an ``approvals.ReviewReader`` built for the run,
and keeps its progress in the repo's stored scan memory (``backing_memory.BackingMemory``); what each PR was
last read at keeps an unchanged PR from being read again, since each run's new token gets no 304 for an earlier
token's ETag.

Each run (``check``) lists every open PR, drafts and every author included, judges the repo's branch rules
(``gate_rules``), whose answer it logs every run, and reads the latest non-shadow rows and verdicts in one
ClickHouse query and the ledger's newest row version in another, both within ``CHANGE_FEED_DEADLINE_SECONDS``
(``change_feed.call_bounded``). A PR's key (``backing_memory.BackingKey``) is its listed ``updated_at``, head and
base, its latest non-shadow row and the rules' answer; the memory keeps each PR's key as of its last settled
read. The check then reads the reviews of, each PR at most once a run:

- every ledger PR, one with a non-shadow verdict or whose latest non-shadow row is in flight (its record job
  may approve before its row lands), whose key is not the one kept, a PR never read included;
- every other open PR whose kept key is not its key: read before, it changed since;
- every PR left waiting by the last run;
- a slice of the sweep over every open PR (a ``drain_pass.DrainPass``), sized so the sweep reads every PR
  within ``FULL_TICK_INTERVAL`` of its start (``BackingMemory.sweep_started_at``): ``ceil(pending / ticks left
  in the window)`` per run, PRs with a ledger row first. Past the window the sweep is the repo's error and goes
  on at the steady rate, ``ceil(open / ticks in a window)`` per run. A PR checked successfully by any part is
  checked in the sweep; a failed one stays pending. The sweep ends once no open PR is pending, and the next
  starts the next run. A sweep whose check did not run for a whole window is dropped, logged, and the next
  starts over.

A ``shadow`` entry reads only the ledger PRs and the waiting ones, and runs no sweep: GreenLight never approves
on a shadow repo, and an approval left from an active period has a ledger row. A PR outside the ledger that was
never read waits for the sweep.

No review read starts once ``deadline`` has passed. The changed and waiting PRs are read first, within half the
time left; then the sweep's slice, in its order; then the rest of the changed and waiting PRs, so neither starves
the other. The changed ledger PRs and the waiting ones come before the other changed PRs, each group in
``BackingMemory.reading_order``, never attempted first, then the oldest attempt first, so PRs whose reads keep
failing slowly cannot use up every run's time. A changed or
waiting PR the deadline left unread is the repo's error; it keeps its earlier key (or none), a waiting one stays
waiting, and an unread sweep PR stays pending, so the next run reads them.

``backing_reads.TickReads`` reads them and ``backing_judge.judge`` decides each live approval. Before dismissing,
the PR is read fresh and every live approval is judged again on its fresh head and base; those still unbacked
are dismissed by id, through ``ineligible_approvals.dismiss_each``'s guard and failure accounting. A read whose
judgement settles (backed, nothing live, or its dismissals done) keeps the PR's key; a PR judged waiting or
unknown is read again next run.

Listing failures raise. A ClickHouse failure, a read that does not finish in time included, is the repo's error
and the check goes on without the ledger: the PRs whose kept key holds a row stand for the ledger PRs, so a
``shadow`` repo still reads an approval left from an active period once its key changes; each key keeps the row
it was kept with, and an approval the ledger would decide is unknown, never backed by a kept row, so only the
rules, its commit and its base dismiss it. A rate limit on any GitHub read sets ``cancel_event``
(``latch.latch_rate_limit``) and ends the check. Any other failure reading the rules leaves their answer unknown
(None): judging goes on without it, each key keeps the rules answer it was kept with, and a PR read meanwhile
settles no key; one with a live GreenLight approval waits for a run that reads the rules. A stored backing memory
that did not decode (``BackingMemory.decode_error``) is an error of the next report.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import approvals, backing_judge, change_feed, drain, gate_rules, github_client, state
from greenlight.backing_memory import BackingKey
from greenlight.backing_reads import Ledger, TickReads
from greenlight.constants import CHANGE_FEED_DEADLINE_SECONDS, FULL_TICK_INTERVAL, TICK_INTERVAL
from greenlight.guards import IterationTimeout
from greenlight.latch import latch_rate_limit

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Sequence

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.backing_memory import BackingMemory
    from greenlight.config import Config
    from greenlight.drain_pass import DrainPass
    from greenlight.gate_rules import GateRules
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import ScanMemory
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_WINDOW_TICKS = FULL_TICK_INTERVAL // TICK_INTERVAL
_WINDOW_MINUTES = int(FULL_TICK_INTERVAL.total_seconds() // 60)


@dataclass(frozen=True, slots=True)
class BackingReport:
    """One run of a gate repo's approval-backing check; ``rules`` is None when they could not be read.

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


def _sweep_slice(
    sweep: DrainPass, started_at: datetime, open_prs: Collection[int], tried: set[int], now: datetime
) -> tuple[list[int], int]:
    """The sweep's PRs to read this run, in its order, and how many were unread once its window had passed."""
    pending = sweep.pending(open_prs)
    left = started_at + FULL_TICK_INTERVAL - now
    if left > timedelta(0):
        ticks_left = max(1, min(_WINDOW_TICKS, left // TICK_INTERVAL))
        size, late = math.ceil(len(pending) / ticks_left), 0
    else:
        size, late = math.ceil(len(open_prs) / _WINDOW_TICKS), len(pending)
    return [number for number in pending if number not in tried][:size], late


def _drop_interrupted_sweep(repo: str, backing: BackingMemory, last: datetime | None, at: datetime) -> None:
    """Drop the sweep under way when the check, last run at ``last``, did not run for a whole window before ``at``
    (the repo was off, or its token could not be had), so the next sweep starts over instead of reporting the gap
    as an incomplete sweep."""
    if backing.sweep is not None and last is not None and at - last > FULL_TICK_INTERVAL:
        logger.info("%s: the approval-backing check last ran at %s; starting a new sweep", repo, last)
        backing.end_sweep()


def _sweep(
    repo: str, backing: BackingMemory, at: datetime, ledger: Ledger | None, *, sweeping: bool
) -> tuple[DrainPass, datetime] | None:
    """The sweep this run reads a slice of and its start: the one under way, else a new one. None when the run
    sweeps nothing, which drops a sweep under way, so a later switch to ``active`` starts its own."""
    if not sweeping:
        if backing.sweep is not None:
            logger.info("%s: a shadow gate repo runs no sweep; dropping sweep %d", repo, backing.sweep.number)
            backing.end_sweep()
        return None
    sweep, started_at = backing.sweep, backing.sweep_started_at
    if sweep is None or started_at is None:
        sweep, started_at = backing.start_sweep(at, recorded=frozenset(() if ledger is None else ledger.gates)), at
    return sweep, started_at


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
            latch_rate_limit(cancel_event, exc)
        logger.error("%s: cannot read %s: %s", repo, what, exc, exc_info=True)
        errors.append(f"{what} on {repo} could not be read: {exc}")
        return None


def _key(pull: PullRequest, ledger: Ledger | None, kept: BackingKey | None, rules: GateRules | None) -> BackingKey:
    """``pull``'s key this run; with the ledger unknown, its row is the one its kept key holds, and with the rules
    unknown, so is their answer."""
    if ledger is None:
        gate_row = None if kept is None else kept.gate_row
    else:
        row = ledger.gates.get(pull.number)
        gate_row = None if row is None else (row.status, row.run_id, row.version)
    kept_rules = None if kept is None else kept.rules_state
    updated_at = pull.updated_at
    return BackingKey(
        updated_at=None if updated_at is None else state.naive_utc(updated_at),
        head_sha=pull.head.sha,
        base_ref=pull.base.ref,
        gate_row=gate_row,
        rules_state=kept_rules if rules is None else rules.enforced,
    )


def _changed(
    keys: dict[int, BackingKey], kept: dict[int, BackingKey], ledger: Ledger | None, *, others: bool
) -> tuple[list[int], list[int]]:
    """The ledger PRs whose key is not the kept one, and, when ``others``, every other PR whose kept key is not
    its key. With the ledger unknown, the PRs whose kept key holds a row stand for the ledger PRs."""

    def drives(number: int) -> bool:
        if ledger is not None:
            return ledger.drives(number)
        key = kept.get(number)
        return key is not None and key.gate_row is not None

    driven = sorted(number for number in keys if drives(number))
    rest = sorted(number for number in keys.keys() - set(driven) if number in kept) if others else []
    return (
        [number for number in driven if keys[number] != kept.get(number)],
        [number for number in rest if keys[number] != kept.get(number)],
    )


def _halfway(deadline: float | None, monotonic: Callable[[], float]) -> float | None:
    """Half the time left before ``deadline`` from now on ``monotonic``; None with no deadline."""
    if deadline is None:
        return None
    now = monotonic()
    return now + max(0.0, deadline - now) / 2


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
    deadline: float | None = None,
    monotonic: Callable[[], float] = time.monotonic,
) -> BackingReport:
    """Run ``entry``'s approval-backing check once. Listing failures raise; a ClickHouse failure is an error.

    A rate limit sets ``cancel_event`` (a fresh event by default) and ends the check, as does an event already
    set. No review read starts once ``monotonic`` reaches ``deadline`` (None: no deadline). A ``bot_login`` other
    than ``approvals.GREENLIGHT_LOGIN`` would judge another account's approvals than the merge gate does, so it
    raises before any read.
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
    started = monotonic()
    backing = memory.backing
    errors: list[str] = []
    client = build_github(token)
    try:
        pulls = {pull.number: pull for pull in list_prs(client, repo)}
        at = now()
        kept = backing.keys = {number: key for number, key in backing.keys.items() if number in pulls}
        backing.attempted = {number: seq for number, seq in backing.attempted.items() if number in pulls}
        rules = _attempt(lambda: read_rules(client, repo), "GreenLight's gate rules", repo, cancel_event, errors)
        if cancel_event.is_set():
            decode_error, backing.decode_error = backing.decode_error, None
            return _report(repo, backing, rules, pulls, None, (0, 0), decode_error, errors, monotonic() - started)

        def read_ledger() -> Ledger:
            gates, verdicts = read_gates(repo, sorted(pulls))
            return Ledger(gates, verdicts, read_ledger_newest())

        ledger = _attempt(
            lambda: change_feed.call_bounded(read_ledger, seconds=CHANGE_FEED_DEADLINE_SECONDS),
            "GreenLight's ledger",
            repo,
            cancel_event,
            errors,
        )
        last, backing.checked_at = backing.checked_at, at
        _drop_interrupted_sweep(repo, backing, last, at)
        window = _sweep(repo, backing, at, ledger, sweeping=entry.mode == "active")
        keys = {number: _key(pull, ledger, kept.get(number), rules) for number, pull in pulls.items()}
        run = TickReads(
            repo=repo,
            client=client,
            reader=approvals.ReviewReader(client.requester),
            sweep=None if window is None else window[0],
            pulls=pulls,
            ledger=ledger,
            rules=rules,
            keys=keys,
            backing=backing,
            now=at,
            bot_login=bot_login,
            cancel_event=cancel_event,
            monotonic=monotonic,
        )
        driven, rest = _changed(keys, kept, ledger, others=window is not None)
        waiting = sorted(number for number in backing.waiting if number in pulls)
        priority = backing.reading_order(dict.fromkeys([*driven, *waiting]))
        first = [*priority, *backing.reading_order(number for number in rest if number not in set(priority))]
        first_reads = run.read_all(first, until=_halfway(deadline, monotonic))
        sweep_reads: list[int] = []
        if window is not None:
            sweep_part, late = _sweep_slice(*window, pulls, run.tried, at)
            if late:
                errors.append(f"sweep {window[0].number} incomplete after {_WINDOW_MINUTES} minutes: {late} PRs unread")
            sweep_reads = run.read_all(sweep_part, until=deadline)
        first_reads += run.read_all(first, until=deadline)
        unread = [number for number in first if number not in run.tried]
        if unread and not cancel_event.is_set():
            errors.append(f"the deadline left {len(unread)} changed or waiting PR(s) unread: {unread}")
    finally:
        github_client.close_client(client)
    unread_waiting = {number for number in backing.waiting if number in pulls and number not in run.checked}
    backing.waiting = frozenset(run.waiting | unread_waiting)
    changed_reads = len(set(first_reads) & {*driven, *rest})
    decode_error, backing.decode_error = backing.decode_error, None
    reads = (changed_reads, len(sweep_reads))
    report = _report(repo, backing, rules, pulls, run, reads, decode_error, errors, monotonic() - started)
    if window is not None and not window[0].pending(pulls):
        backing.end_sweep()
    return report


def _rules_answer(rules: GateRules | None) -> str:
    if rules is None:
        return "gate rules unread"
    if rules.enforced:
        return "gate rules enforced"
    return f"gate rules not enforced: {'; '.join(rules.problems)}"


def _report(
    repo: str,
    backing: BackingMemory,
    rules: GateRules | None,
    pulls: dict[int, PullRequest],
    run: TickReads | None,
    reads: tuple[int, int],
    decode_error: str | None,
    errors: list[str],
    elapsed: float,
) -> BackingReport:
    """The run's report, logged; ``decode_error`` (why the stored memory did not decode) goes first among its
    errors."""
    errors = errors if decode_error is None else [decode_error, *errors]
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
        "%d dismissed, %d failed, in %.1f s, %s",
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
        elapsed,
        _rules_answer(rules),
    )
    return report
