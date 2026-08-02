"""Scan trusted-author pytorch/pytorch PRs and dispatch the AI review workflow.

Each scan lists the open PRs from a fixed trusted-author set, fingerprints each one,
reads its latest recorded state from ClickHouse, and asks ``decision.decide`` whether to
dispatch a review, skip it, or wait. State is re-read from ClickHouse every scan, so the
one-shot and ``--loop`` paths behave identically -- nothing is remembered in memory
between scans. All GitHub, ClickHouse, and dispatch I/O sits behind injectable keyword
seams so the loop is testable without any of them.
"""

from __future__ import annotations

import contextlib
import logging
import queue
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import dispatch as dispatch_module
from greenlight import github_client, state
from greenlight.constants import DEFAULT_DISPATCH_REF, DEFAULT_TIMEOUT_MINUTES, TARGET_REPO
from greenlight.decision import Decision, decide
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from concurrent.futures import Future

    from github import Github

    from greenlight.config import Config
    from greenlight.github_client import OpenPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

TRUSTED_AUTHORS: set[str] = {
    "albanD",  # Alban Desmaison
    "jathu",  # Jathu Satkunarajah
    "atalman",  # Andrey Talman
    "huydhn",  # Huy Do
    "izaitsevfb",  # Ivan Zaitsev
    "georgehong",  # George Hong
    "jeanschmidt",  # Jean Schmidt
}

_FINGERPRINT_WORKERS = 8

# Never-reviewed candidates sort ahead of every recorded one; this stands in for their
# absent version so the sort key stays a homogeneous (bool, datetime) tuple.
_MIN_VERSION = datetime.min


def _utcnow() -> datetime:
    # Naive UTC to match the version column: state.read_latest_states normalizes every
    # version to naive UTC on read, and decision.decide subtracts the two, which would
    # raise if either operand were tz-aware.
    return datetime.now(UTC).replace(tzinfo=None)


def _default_fetch(client: Github) -> list[OpenPR]:
    return github_client.list_open_prs_by_authors(client, TARGET_REPO, TRUSTED_AUTHORS)


def _default_fingerprint(client: Github, pr_number: int, authorized_logins: frozenset[str]) -> tuple[str, str]:
    return github_client.fingerprint_pr(client, TARGET_REPO, pr_number, authorized_logins=authorized_logins)


def _fingerprint_task(
    fingerprint: Callable[[Github, int, frozenset[str]], tuple[str, str]],
    client_pool: queue.Queue[Github],
    number: int,
    authorized_logins: frozenset[str],
) -> tuple[str, str]:
    client = client_pool.get()
    try:
        return fingerprint(client, number, authorized_logins)
    finally:
        client_pool.put(client)


def _close_client(client: Github) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            logger.exception("failed to close GitHub client")


@dataclass(frozen=True, slots=True)
class _Candidate:
    pr_number: int
    head_sha: str
    eval_hash: str
    state: PRState | None
    reason: str


def _staleness_key_for_state(recorded: PRState | None) -> tuple[bool, datetime]:
    if recorded is None:
        return (False, _MIN_VERSION)
    return (True, recorded.version)


def _staleness_key(candidate: _Candidate) -> tuple[bool, datetime]:
    return _staleness_key_for_state(candidate.state)


def _candidate_numbers(client: Github, *, pr: int | None, fetch: Callable[[Github], list[OpenPR]]) -> list[int]:
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, TARGET_REPO)
        return [pr]
    open_prs = fetch(client)
    logger.info("found %d open PR(s) from %d author(s) in %s", len(open_prs), len(TRUSTED_AUTHORS), TARGET_REPO)
    for open_pr in open_prs:
        logger.info("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
    return [open_pr.number for open_pr in open_prs]


def _dispatch_pending(
    client: Github,
    pending: list[_Candidate],
    *,
    ref: str,
    max_dispatches: int | None,
    dispatch: Callable[[Github, int, str, str, str], None],
) -> list[int]:
    ordered = sorted(pending, key=_staleness_key)
    limit = len(ordered) if max_dispatches is None else max(0, max_dispatches)
    dispatch_failed: list[int] = []
    for candidate in ordered[:limit]:
        try:
            dispatch(client, candidate.pr_number, candidate.head_sha, candidate.eval_hash, ref)
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.error("failed to dispatch review for PR #%d: %s", candidate.pr_number, exc, exc_info=True)
            dispatch_failed.append(candidate.pr_number)
            continue
        logger.info("dispatched review for PR #%d (%s)", candidate.pr_number, candidate.reason)
    for candidate in ordered[limit:]:
        logger.info("deferred PR #%d dispatch: --max cap reached", candidate.pr_number)
    return dispatch_failed


def _evaluate_pr(
    number: int,
    future: Future[tuple[str, str]],
    states: dict[int, PRState],
    *,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    force: bool,
) -> _Candidate | None:
    try:
        head_sha, eval_hash = future.result()
        recorded = states.get(number)
        if force:
            logger.info("PR #%d: DISPATCH (forced)", number)
            return _Candidate(number, head_sha, eval_hash, recorded, "forced")
        outcome = decide(
            current_eval_hash=eval_hash,
            latest_status=recorded.status if recorded is not None else None,
            latest_eval_hash=recorded.eval_hash if recorded is not None else None,
            latest_version=recorded.version if recorded is not None else None,
            now=now,
            timeout=timeout,
        )
        logger.info("PR #%d: %s (%s)", number, outcome.action.name, outcome.reason)
        if outcome.action is Decision.DISPATCH:
            return _Candidate(number, head_sha, eval_hash, recorded, outcome.reason)
        return None
    except Exception:
        logger.exception("skipping PR #%d: failed to evaluate", number)
        failed.append(number)
        return None


def _fingerprint_all(
    pr_numbers: Sequence[int],
    states: dict[int, PRState],
    *,
    fingerprint: Callable[[Github, int, frozenset[str]], tuple[str, str]],
    client_pool: queue.Queue[Github],
    worker_count: int,
    authorized_logins: frozenset[str],
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    force: bool,
) -> list[_Candidate]:
    futures: dict[int, Future[tuple[str, str]]] = {}
    if worker_count:
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = {
                number: pool.submit(_fingerprint_task, fingerprint, client_pool, number, authorized_logins)
                for number in pr_numbers
            }
    pending: list[_Candidate] = []
    for number in pr_numbers:
        candidate = _evaluate_pr(number, futures[number], states, now=now, timeout=timeout, failed=failed, force=force)
        if candidate is not None:
            pending.append(candidate)
    return pending


def _fingerprint_until_dispatchable(
    pr_numbers: Sequence[int],
    states: dict[int, PRState],
    *,
    fingerprint: Callable[[Github, int, frozenset[str]], tuple[str, str]],
    client_pool: queue.Queue[Github],
    worker_count: int,
    authorized_logins: frozenset[str],
    limit: int,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    force: bool,
) -> list[_Candidate]:
    ranked = sorted(pr_numbers, key=lambda number: _staleness_key_for_state(states.get(number)))
    pending: list[_Candidate] = []
    if worker_count:
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            for start in range(0, len(ranked), worker_count):
                if len(pending) >= limit:
                    break
                batch = ranked[start : start + worker_count]
                futures = {
                    number: pool.submit(_fingerprint_task, fingerprint, client_pool, number, authorized_logins)
                    for number in batch
                }
                for number in batch:
                    candidate = _evaluate_pr(
                        number, futures[number], states, now=now, timeout=timeout, failed=failed, force=force
                    )
                    if candidate is not None:
                        pending.append(candidate)
    return pending


def run(
    config: Config,
    *,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    force: bool = False,
    build_github: Callable[[str], Github] = github_client.build_client,
    fetch: Callable[[Github], list[OpenPR]] = _default_fetch,
    fingerprint: Callable[[Github, int, frozenset[str]], tuple[str, str]] = _default_fingerprint,
    read_state: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    dispatch: Callable[[Github, int, str, str, str], None] = dispatch_module.dispatch_review,
    resolve_authorized: Callable[[], frozenset[str]],
    now: Callable[[], datetime] = _utcnow,
) -> None:
    logger.info("reviewing trusted-author PRs in %s", TARGET_REPO)
    logger.debug("greenlight config: %r", config)
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    # Resolved once per scan and never caught here: a cold failure must fail the scan (one-shot
    # exits non-zero, daemon backs off) rather than silently revert to hashing all human comments.
    authorized_logins = resolve_authorized()
    logger.info("filtering fingerprint comments to %d merge-authorized login(s)", len(authorized_logins))
    with contextlib.ExitStack() as clients:
        client = build_github(token)
        clients.callback(_close_client, client)
        pr_numbers = _candidate_numbers(client, pr=pr, fetch=fetch)
        states = read_state(TARGET_REPO, pr_numbers)
        timeout = timedelta(minutes=timeout_minutes)
        evaluated_at = now()
        failed: list[int] = []
        worker_count = min(_FINGERPRINT_WORKERS, len(pr_numbers))
        # PyGithub is not thread-safe, so each concurrent task borrows a client for its
        # exclusive use; sizing the pool to the worker count keeps queue.get non-blocking
        # and guarantees no two running tasks ever share one.
        client_pool: queue.Queue[Github] = queue.Queue()
        for _ in range(worker_count):
            worker_client = build_github(token)
            clients.callback(_close_client, worker_client)
            client_pool.put(worker_client)
        if max_dispatches is None:
            pending = _fingerprint_all(
                pr_numbers,
                states,
                fingerprint=fingerprint,
                client_pool=client_pool,
                worker_count=worker_count,
                authorized_logins=authorized_logins,
                now=evaluated_at,
                timeout=timeout,
                failed=failed,
                force=force,
            )
        else:
            pending = _fingerprint_until_dispatchable(
                pr_numbers,
                states,
                fingerprint=fingerprint,
                client_pool=client_pool,
                worker_count=worker_count,
                authorized_logins=authorized_logins,
                limit=max(0, max_dispatches),
                now=evaluated_at,
                timeout=timeout,
                failed=failed,
                force=force,
            )
        dispatch_failed = _dispatch_pending(client, pending, ref=ref, max_dispatches=max_dispatches, dispatch=dispatch)
        if failed or dispatch_failed:
            errors: list[str] = []
            if failed:
                errors.append(f"{len(failed)} PR(s) failed during scan: {sorted(failed)}")
            if dispatch_failed:
                errors.append(f"failed to dispatch {len(dispatch_failed)} PR(s): {sorted(dispatch_failed)}")
            raise RuntimeError("; ".join(errors))
