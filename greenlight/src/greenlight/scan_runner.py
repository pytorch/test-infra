"""Fingerprint orchestration, dispatch, and recheck-refusal posting for the review scan.

Extracted from ``review`` so both modules stay within the per-file line limit. The concurrent
fingerprint machinery, the per-PR decision seam, dispatch, and the ``@greenlight recheck``
refusal comment live here; ``review.run`` owns the authz gates, candidate listing, recency
filter, and client lifecycle, and drives these helpers.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import TYPE_CHECKING

from greenlight import comment_format, constants
from greenlight.decision import Decision, decide
from greenlight.github_client import is_rate_limit_error
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, ReviewSkip

if TYPE_CHECKING:
    import queue
    from collections.abc import Callable, Sequence
    from concurrent.futures import Future
    from datetime import timedelta

    from github import Github

    from greenlight.github_types import VerdictPR
    from greenlight.state import PRState

    # The fingerprint seam returns the PR's (head_sha, eval_hash) or, when a human has already
    # decided it, a ReviewSkip. skip_on_approval (True on the listing scan, False on --pr) is
    # threaded per call so an approval skips the listing but never the manual recheck.
    FingerprintFn = Callable[[Github, int, frozenset[str], bool], tuple[str, str] | ReviewSkip]

logger = logging.getLogger(__name__)

# Never-reviewed candidates sort ahead of every recorded one; this stands in for their
# absent version so the sort key stays a homogeneous (bool, datetime) tuple.
_MIN_VERSION = datetime.min


class _Cancelled(Enum):
    # A typed sentinel (single Enum member) for a task skipped after a rate limit tripped the
    # shared cancel event: mypy strict can narrow this out of the result union; object() cannot.
    TOKEN = auto()


_CANCELLED = _Cancelled.TOKEN


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


def _fingerprint_task(
    fingerprint: FingerprintFn,
    client_pool: queue.Queue[Github],
    number: int,
    authorized_logins: frozenset[str],
    skip_on_approval: bool,
    cancel_event: threading.Event,
) -> tuple[str, str] | ReviewSkip | _Cancelled:
    if cancel_event.is_set():
        return _CANCELLED
    client = client_pool.get()
    try:
        return fingerprint(client, number, authorized_logins, skip_on_approval)
    except Exception as exc:
        if is_rate_limit_error(exc):
            cancel_event.set()
        raise
    finally:
        client_pool.put(client)


def _evaluate_pr(
    number: int,
    future: Future[tuple[str, str] | ReviewSkip | _Cancelled],
    states: dict[int, PRState],
    *,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
) -> _Candidate | None:
    try:
        result = future.result()
        # A cancelled task never ran its fingerprint (an earlier task hit a rate limit and tripped
        # the shared cancel event), so it is neither a candidate nor a failure: drop it silently.
        if result is _CANCELLED:
            return None
        # A ReviewSkip is a human decision, never a fingerprint failure: check before unpacking
        # so it is collected/dropped, not mistaken for an error and appended to failed.
        if isinstance(result, ReviewSkip):
            logger.info("PR #%d: SKIP (%s): %s", number, result.reason, result.detail)
            skips.append((number, result))
            return None
        head_sha, eval_hash = result
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
    except IterationTimeout:
        raise
    except Exception:
        logger.exception("skipping PR #%d: failed to evaluate", number)
        failed.append(number)
        return None


def _fingerprint_all(
    pr_numbers: Sequence[int],
    states: dict[int, PRState],
    *,
    fingerprint: FingerprintFn,
    client_pool: queue.Queue[Github],
    worker_count: int,
    authorized_logins: frozenset[str],
    skip_on_approval: bool,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
) -> list[_Candidate]:
    cancel_event = threading.Event()
    futures: dict[int, Future[tuple[str, str] | ReviewSkip | _Cancelled]] = {}
    if worker_count:
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = {
                number: pool.submit(
                    _fingerprint_task,
                    fingerprint,
                    client_pool,
                    number,
                    authorized_logins,
                    skip_on_approval,
                    cancel_event,
                )
                for number in pr_numbers
            }
    pending: list[_Candidate] = []
    for number in pr_numbers:
        candidate = _evaluate_pr(
            number, futures[number], states, now=now, timeout=timeout, failed=failed, skips=skips, force=force
        )
        if candidate is not None:
            pending.append(candidate)
    return pending


def _fingerprint_until_dispatchable(
    pr_numbers: Sequence[int],
    states: dict[int, PRState],
    *,
    fingerprint: FingerprintFn,
    client_pool: queue.Queue[Github],
    worker_count: int,
    authorized_logins: frozenset[str],
    skip_on_approval: bool,
    limit: int,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
) -> list[_Candidate]:
    ranked = sorted(pr_numbers, key=lambda number: _staleness_key_for_state(states.get(number)))
    pending: list[_Candidate] = []
    cancel_event = threading.Event()
    if worker_count:
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            for start in range(0, len(ranked), worker_count):
                if len(pending) >= limit:
                    break
                if cancel_event.is_set():
                    break
                batch = ranked[start : start + worker_count]
                futures = {
                    number: pool.submit(
                        _fingerprint_task,
                        fingerprint,
                        client_pool,
                        number,
                        authorized_logins,
                        skip_on_approval,
                        cancel_event,
                    )
                    for number in batch
                }
                for number in batch:
                    candidate = _evaluate_pr(
                        number,
                        futures[number],
                        states,
                        now=now,
                        timeout=timeout,
                        failed=failed,
                        skips=skips,
                        force=force,
                    )
                    if candidate is not None:
                        pending.append(candidate)
    return pending


def _emit_dispatch_marker(candidate: _Candidate, emit_dispatched: Callable[..., None]) -> None:
    # run_id is prior_run_id + 1 so this AI_REVIEW_DISPATCHED row supersedes the PR's prior row,
    # while the reviewer run's own later, higher github.run_id supersedes it in turn once that run
    # starts. A None state (never-reviewed PR) has no prior run, so it bases at 0 -> run_id 1.
    # The workflow was already fired, so an emit failure is logged and swallowed: a missing marker
    # self-heals (next scan re-dispatches, the reviewer's per-PR concurrency group cancels the dup),
    # and must not fail the scan or block dispatching the remaining candidates.
    prior_run_id = candidate.state.run_id if candidate.state else 0
    try:
        emit_dispatched(
            repo=constants.TARGET_REPO,
            pr_number=candidate.pr_number,
            head_sha=candidate.head_sha,
            eval_hash=candidate.eval_hash,
            run_id=prior_run_id + 1,
        )
    except IterationTimeout:
        raise
    except Exception as exc:
        logger.error(
            "failed to emit AI_REVIEW_DISPATCHED marker for PR #%d: %s", candidate.pr_number, exc, exc_info=True
        )


def _dispatch_pending(
    client: Github,
    pending: list[_Candidate],
    *,
    ref: str,
    max_dispatches: int | None,
    dispatch: Callable[[Github, int, str, str, str], None],
    emit_dispatched: Callable[..., None],
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
        _emit_dispatch_marker(candidate, emit_dispatched)
    for candidate in ordered[limit:]:
        logger.info("deferred PR #%d dispatch: --max cap reached", candidate.pr_number)
    return dispatch_failed


def post_refusals(
    client: Github,
    repo: str,
    skips: Sequence[tuple[int, ReviewSkip]],
    *,
    bot_login: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    upsert_comment: Callable[..., None],
) -> None:
    """Post one recheck-refusal comment per collected skip on the ``--pr`` path.

    Runs on the main thread after the concurrent fingerprint loop (PyGithub clients are not
    thread-safe). A refusal is a courtesy comment, not the scan's product, so a per-PR post
    failure is logged and swallowed rather than failing the scan; ``IterationTimeout`` still
    propagates so the per-iteration watchdog can abort. With no ``bot_login`` the write cannot be
    author-scoped, so posting is skipped with an error rather than crashing the scan.
    """
    if not skips:
        return
    if not bot_login:
        logger.error("cannot post %d recheck refusal comment(s): BOT_LOGIN is required to post", len(skips))
        return
    for pr_number, skip in skips:
        if skip.reason != CHANGES_REQUESTED:
            logger.warning("not posting refusal for PR #%d: unexpected skip reason %r", pr_number, skip.reason)
            continue
        try:
            pr = get_pr(client, repo, pr_number)
            upsert_comment(
                pr,
                marker=comment_format.RECHECK_REFUSAL_MARKER,
                body=comment_format.recheck_changes_requested_body(skip.detail),
                author_login=bot_login,
            )
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.error("failed to post recheck refusal for PR #%d: %s", pr_number, exc, exc_info=True)
            continue
        logger.info("posted recheck refusal for PR #%d (%s)", pr_number, skip.reason)
