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
from greenlight.constants import DEFAULT_DISPATCH_REF, DEFAULT_TIMEOUT_MINUTES
from greenlight.decision import Decision, decide

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from concurrent.futures import Future

    from github import Github

    from greenlight.config import Config
    from greenlight.github_client import OpenPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

TARGET_REPO = "pytorch/pytorch"
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


def _default_fingerprint(client: Github, pr_number: int) -> tuple[str, str]:
    return github_client.fingerprint_pr(client, TARGET_REPO, pr_number)


def _fingerprint_task(
    fingerprint: Callable[[Github, int], tuple[str, str]],
    client_pool: queue.Queue[Github],
    number: int,
) -> tuple[str, str]:
    client = client_pool.get()
    try:
        return fingerprint(client, number)
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


def _staleness_key(candidate: _Candidate) -> tuple[bool, datetime]:
    recorded = candidate.state
    if recorded is None:
        return (False, _MIN_VERSION)
    return (True, recorded.version)


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
) -> None:
    ordered = sorted(pending, key=_staleness_key)
    limit = len(ordered) if max_dispatches is None else max(0, max_dispatches)
    for candidate in ordered[:limit]:
        dispatch(client, candidate.pr_number, candidate.head_sha, candidate.eval_hash, ref)
        logger.info("dispatched review for PR #%d (%s)", candidate.pr_number, candidate.reason)
    for candidate in ordered[limit:]:
        logger.info("deferred PR #%d dispatch: --max cap reached", candidate.pr_number)


def run(
    config: Config,
    *,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    build_github: Callable[[str], Github] = github_client.build_client,
    fetch: Callable[[Github], list[OpenPR]] = _default_fetch,
    fingerprint: Callable[[Github, int], tuple[str, str]] = _default_fingerprint,
    read_state: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    dispatch: Callable[[Github, int, str, str, str], None] = dispatch_module.dispatch_review,
    now: Callable[[], datetime] = _utcnow,
) -> None:
    logger.info("reviewing trusted-author PRs in %s", TARGET_REPO)
    logger.debug("greenlight config: %r", config)
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    with contextlib.ExitStack() as clients:
        client = build_github(token)
        clients.callback(_close_client, client)
        pr_numbers = _candidate_numbers(client, pr=pr, fetch=fetch)
        states = read_state(TARGET_REPO, pr_numbers)
        timeout = timedelta(minutes=timeout_minutes)
        evaluated_at = now()
        pending: list[_Candidate] = []
        failed: list[int] = []
        worker_count = min(_FINGERPRINT_WORKERS, len(pr_numbers))
        worker_clients: list[Github] = []
        for _ in range(worker_count):
            worker_client = build_github(token)
            clients.callback(_close_client, worker_client)
            worker_clients.append(worker_client)
        futures: dict[int, Future[tuple[str, str]]] = {}
        if worker_count:
            # PyGithub is not thread-safe, so each concurrent task borrows a client for its
            # exclusive use; sizing the pool to the client count keeps queue.get non-blocking
            # and guarantees no two running tasks ever share one.
            client_pool: queue.Queue[Github] = queue.Queue()
            for worker_client in worker_clients:
                client_pool.put(worker_client)
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                futures = {
                    number: pool.submit(_fingerprint_task, fingerprint, client_pool, number) for number in pr_numbers
                }
        for number in pr_numbers:
            try:
                head_sha, eval_hash = futures[number].result()
                recorded = states.get(number)
                outcome = decide(
                    current_eval_hash=eval_hash,
                    latest_status=recorded.status if recorded is not None else None,
                    latest_eval_hash=recorded.eval_hash if recorded is not None else None,
                    latest_version=recorded.version if recorded is not None else None,
                    now=evaluated_at,
                    timeout=timeout,
                )
                logger.info("PR #%d: %s (%s)", number, outcome.action.name, outcome.reason)
                if outcome.action is Decision.DISPATCH:
                    pending.append(_Candidate(number, head_sha, eval_hash, recorded, outcome.reason))
            except Exception:
                logger.exception("skipping PR #%d: failed to evaluate", number)
                failed.append(number)
                continue
        _dispatch_pending(client, pending, ref=ref, max_dispatches=max_dispatches, dispatch=dispatch)
        if failed:
            raise RuntimeError(f"{len(failed)} PR(s) failed during scan: {sorted(failed)}")
