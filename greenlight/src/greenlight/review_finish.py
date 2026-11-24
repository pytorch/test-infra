"""The review scan's optional work and its error aggregation, run on what ``review.prepare`` left.

``finish`` fingerprints each eligible PR (``scan_runner``), dispatches the candidates (``scan_dispatch``),
relabels the listed PRs (``verdict_labels``) and, on ``--pr``, posts the recheck refusals; then it
raises one error naming every PR that failed, failed to dispatch or was abandoned to a rate limit,
the safety work's failures (``PreparedScan.failed``) included. The optional work's own failures are
kept apart (``PreparedScan.optional_failed``), so a caller whose optional work was cut short reports
them with the cut. The dispatch goes through a client on the scan's dispatch token when that differs
from its repo token. A fast tick reuses a PR's cached fingerprint result while its listed
``updated_at`` and head and the approver set are unchanged, but fingerprints afresh any PR it would
dispatch (``scan_memory``);
``--pr`` and ``--force`` never touch the cache. Every listing tick that reaches its dispatch phase
without a rate limit, and whose dispatch hits none, relabels the PRs it listed that are reverted, kept
by the recency filter or Stale-skipped. ``optional=False`` (a safety-only repo) skips all of the
optional work and raises only the safety work's errors; a full tick whose safety work met no rate limit
still counts as the last full tick, so a safety-only repo is not listed in full on every tick, unless the
caller says its optional work did not finish (``marks_full_tick=False``). A listing tick counts as the
last full tick once its fan-out and dispatch ended without a stop (``quota.RepoBudgetExceeded``,
``quota.RateLimitStop``, or a rate limit they latched); a PR whose dispatch failed on its own does not hold
it back. The fingerprint results the fan-out stored are kept in the scan memory even when a stop ends it,
with the earlier results of the PRs it never looked up (``FingerprintCache.commit``). The shared rate-limit
latch is read again before the dispatch (``latch.recheck``).
"""

from __future__ import annotations

import logging
import queue
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from greenlight import github_client, latch, scan_dispatch, scan_runner, verdict_labels
from greenlight.scan_memory import FingerprintCache

if TYPE_CHECKING:
    import contextlib
    import threading
    from collections.abc import Callable, Mapping
    from datetime import datetime, timedelta
    from typing import Protocol

    from github import Github

    from greenlight.authority import Authority
    from greenlight.github_types import VerdictPR
    from greenlight.repo_config import RepoEntry
    from greenlight.review_gate import ReviewSkip
    from greenlight.scan_dispatch import DispatchFn
    from greenlight.scan_memory import ScanMemory
    from greenlight.scan_runner import FingerprintFn
    from greenlight.state import PRState

    class BuildClient(Protocol):
        # token positional-only so injected test doubles needn't match the parameter name.
        def __call__(self, token: str, /, *, seconds_between_requests: float = 0.25) -> Github: ...


logger = logging.getLogger(__name__)

# Aggregate fan-out request rate is workers / seconds-between-requests: more workers or a
# shorter interval raise it. Cutting workers (8->4) and lengthening the interval (0.25s->0.5s)
# both lower it, to ~8 req/s, keeping the fan-out under GitHub's secondary (burst-rate) limit
# that the prior 8-worker / 0.25s pool tripped.
_FINGERPRINT_WORKERS = 4
_FINGERPRINT_SECONDS_BETWEEN_REQUESTS = 0.5


@dataclass(slots=True)
class PreparedScan:
    """One repo's scan after its safety work: what ``finish`` needs, and the failures so far.

    ``dispatch_token`` is None when there is none: such a scan can run only its safety work.
    """

    entry: RepoEntry
    stack: contextlib.ExitStack
    client: Github
    token: str
    dispatch_token: str | None
    build_github: BuildClient
    pr: int | None
    max_dispatches: int | None
    ref: str
    force: bool
    bot_login: str
    timeout: timedelta
    memory: ScanMemory | None
    full_tick: bool
    listed_at: datetime
    evaluated_at: datetime
    states: dict[int, PRState]
    authority: Authority
    authorized_logins: frozenset[str]
    fingerprint_numbers: list[int]
    recent: list[int]
    ineligible: list[int]
    excluded: frozenset[int]
    skip_on_approval: bool
    labels_by_number: Mapping[int, tuple[str, ...]]
    head_sha_by_number: Mapping[int, str | None]
    updated_at_by_number: Mapping[int, datetime | None]
    cancel_event: threading.Event
    poke: Callable[[int], None]
    fingerprint: FingerprintFn
    dispatch: DispatchFn
    emit_dispatched: Callable[..., None]
    label_prs: Callable[[verdict_labels.LabelPass], None]
    get_pr: Callable[[Github, str, int], VerdictPR]
    upsert_comment: Callable[..., None]
    now: Callable[[], datetime]
    failed: list[int] = field(default_factory=list)
    optional_failed: list[int] = field(default_factory=list)


def finish(prepared: PreparedScan, *, optional: bool = True, marks_full_tick: bool = True) -> None:
    abandoned: list[int] = []
    dispatch_failed: list[int] = []
    failed = set(prepared.failed)
    if optional:
        dispatch_failed = _optional_work(prepared, abandoned)
        failed.update(prepared.optional_failed)
    elif marks_full_tick and not prepared.cancel_event.is_set():
        _mark_full_tick(prepared)
    # A PR can land in failed twice (the revert guard's revoke and record) and in failed and abandoned both.
    failed_prs = sorted(failed)
    abandoned_prs = sorted(set(abandoned).difference(failed))
    if failed_prs or dispatch_failed or abandoned_prs:
        errors: list[str] = []
        if failed_prs:
            errors.append(f"{len(failed_prs)} PR(s) failed during scan: {failed_prs}")
        if dispatch_failed:
            errors.append(f"failed to dispatch {len(dispatch_failed)} PR(s): {sorted(dispatch_failed)}")
        if abandoned_prs:
            errors.append(f"{len(abandoned_prs)} PR(s) abandoned due to rate limit: {abandoned_prs}")
        raise RuntimeError("; ".join(errors))


def _mark_full_tick(scan: PreparedScan) -> None:
    if scan.full_tick and scan.memory is not None and scan.pr is None:
        scan.memory.mark_full_tick(scan.listed_at)


def _dispatch_client(scan: PreparedScan) -> Github:
    """The client for the scan's dispatch token (``github_client.dispatch_client``), closed with its stack."""
    if scan.dispatch_token is None:
        raise ValueError(f"{scan.entry.repo}: there is no dispatch token, so no review can be dispatched")
    return scan.stack.enter_context(
        github_client.dispatch_client(scan.client, scan.token, scan.dispatch_token, scan.build_github)
    )


def _fan_out(
    scan: PreparedScan,
    client_pool: queue.Queue[Github],
    worker_count: int,
    abandoned: list[int],
    skips: list[tuple[int, ReviewSkip]],
    cache: FingerprintCache | None,
) -> list[scan_runner._Candidate]:
    """Fingerprint ``scan``'s eligible PRs: every one, or under ``--max`` only until enough would dispatch."""
    if scan.max_dispatches is None:
        return scan_runner._fingerprint_all(
            scan.fingerprint_numbers,
            scan.states,
            repo=scan.entry.repo,
            fingerprint=scan.fingerprint,
            client_pool=client_pool,
            worker_count=worker_count,
            authorized_logins=scan.authorized_logins,
            skip_on_approval=scan.skip_on_approval,
            now=scan.evaluated_at,
            timeout=scan.timeout,
            failed=scan.optional_failed,
            abandoned=abandoned,
            skips=skips,
            force=scan.force,
            cancel_event=scan.cancel_event,
            cache=cache,
        )
    return scan_runner._fingerprint_until_dispatchable(
        scan.fingerprint_numbers,
        scan.states,
        repo=scan.entry.repo,
        fingerprint=scan.fingerprint,
        client_pool=client_pool,
        worker_count=worker_count,
        authorized_logins=scan.authorized_logins,
        skip_on_approval=scan.skip_on_approval,
        limit=max(0, scan.max_dispatches),
        now=scan.evaluated_at,
        timeout=scan.timeout,
        failed=scan.optional_failed,
        abandoned=abandoned,
        skips=skips,
        force=scan.force,
        cancel_event=scan.cancel_event,
        cache=cache,
    )


def _optional_work(scan: PreparedScan, abandoned: list[int]) -> list[int]:
    """Fan out, dispatch, label and post refusals; return the PRs whose dispatch failed."""
    repo = scan.entry.repo
    skips: list[tuple[int, ReviewSkip]] = []
    worker_count = min(_FINGERPRINT_WORKERS, len(scan.fingerprint_numbers))
    # PyGithub is not thread-safe, so each concurrent task borrows a client for its
    # exclusive use; sizing the pool to the worker count keeps queue.get non-blocking
    # and guarantees no two running tasks ever share one.
    client_pool: queue.Queue[Github] = queue.Queue()
    for _ in range(worker_count):
        worker_client = scan.build_github(scan.token, seconds_between_requests=_FINGERPRINT_SECONDS_BETWEEN_REQUESTS)
        scan.stack.callback(github_client.close_client, worker_client)
        client_pool.put(worker_client)
    cache = (
        None
        if scan.memory is None or scan.pr is not None or scan.force
        else FingerprintCache(
            scan.memory,
            reuse=not scan.full_tick,
            authorized_logins=scan.authorized_logins,
            updated_at=scan.updated_at_by_number,
            head_sha=scan.head_sha_by_number,
            now=scan.evaluated_at,
        )
    )
    stopped = True
    try:
        pending = _fan_out(scan, client_pool, worker_count, abandoned, skips, cache)
        stopped = scan.cancel_event.is_set()
    finally:
        if cache is not None:
            cache.commit(partial=stopped)
    latch.recheck(scan.cancel_event)
    dispatch_failed: list[int] = []
    if scan.cancel_event.is_set():
        # A rate limit tripped the fan-out. The completed candidates are deferred, not lost: no
        # state row is written for them, so the next scan re-fingerprints and dispatches them once
        # the limit clears. Firing workflow_dispatch POSTs now on the same throttled token is what
        # GitHub's secondary-rate-limit detection punishes most, so skip the dispatch phase.
        logger.warning(
            "rate limit hit: abandoned %d of %d fingerprint(s) (not evaluated); "
            "skipping dispatch of %d completed candidate(s) this pass; will retry next scan",
            len(abandoned),
            len(scan.fingerprint_numbers),
            len(pending),
        )
    else:
        dispatch_failed = scan_dispatch._dispatch_pending(
            _dispatch_client(scan) if pending else scan.client,
            pending,
            repo=repo,
            ref=scan.ref,
            max_dispatches=scan.max_dispatches,
            dispatch=scan.dispatch,
            emit_dispatched=scan.emit_dispatched,
            poke=scan.poke,
            shadow_for_pr=scan.authority.shadow,
            cancel_event=scan.cancel_event,
        )
        # Marked before finish raises for the per-PR dispatch failures: one failing PR must not hold every
        # later tick to a full listing. A stop (raised, or a rate limit the dispatch latched) leaves it due.
        if not scan.cancel_event.is_set():
            _mark_full_tick(scan)
        if scan.pr is None:
            scan.label_prs(
                verdict_labels.LabelPass(
                    repo=repo,
                    fetch_pr=lambda number: scan.get_pr(scan.client, repo, number),
                    reverted=scan.excluded,
                    recent=scan.recent,
                    eligible=scan.fingerprint_numbers,
                    ineligible=scan.ineligible,
                    skips=skips,
                    labels=scan.labels_by_number,
                    heads=scan.head_sha_by_number,
                    listed_at=scan.listed_at,
                    clock=scan.now,
                    timeout=scan.timeout,
                    cancel_event=scan.cancel_event,
                )
            )
    # Only the --pr recheck path posts refusals; a listing-scan skip gets no refusal
    # (already logged). skips can hold a refusal only when skip_on_approval is False (--pr),
    # so this can never comment on a listing-scan approval.
    if scan.pr is not None:
        scan_runner.post_refusals(
            scan.client, repo, skips, bot_login=scan.bot_login, get_pr=scan.get_pr, upsert_comment=scan.upsert_comment
        )
    return dispatch_failed
