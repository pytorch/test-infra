"""Fingerprint orchestration and recheck-refusal posting for the review scan.

The concurrent fingerprint machinery, the per-PR decision seam, the reuse of cached fingerprint
results, and the ``@greenlight recheck`` refusal comment live here; ``scan_dispatch`` dispatches the
candidates, and ``review.run`` owns the authz gates, candidate listing, recency filter, and client
lifecycle, and drives these helpers.
"""

from __future__ import annotations

import logging
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import TYPE_CHECKING

from greenlight import comment_format
from greenlight.decision import Decision, decide
from greenlight.github_client import is_rate_limit_error
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, ReviewSkip

if TYPE_CHECKING:
    import queue
    import threading
    from collections.abc import Callable, Sequence
    from concurrent.futures import Future
    from datetime import timedelta

    from github import Github

    from greenlight.github_types import VerdictPR
    from greenlight.scan_memory import FingerprintCache
    from greenlight.state import PRState

    # The fingerprint seam returns the PR's (head_sha, eval_hash) or, when a human has already
    # decided it, a ReviewSkip. skip_on_approval (True on the listing scan, False on --pr) is
    # threaded per call so an approval skips the listing but never the manual recheck.
    FingerprintResult = tuple[str, str] | ReviewSkip
    FingerprintFn = Callable[[Github, int, frozenset[str], bool], FingerprintResult]


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


def _fingerprint_task(
    fingerprint: FingerprintFn,
    client_pool: queue.Queue[Github],
    number: int,
    authorized_logins: frozenset[str],
    skip_on_approval: bool,
    cancel_event: threading.Event,
) -> FingerprintResult | _Cancelled:
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


def _judge(
    number: int,
    result: FingerprintResult,
    recorded: PRState | None,
    *,
    now: datetime,
    timeout: timedelta,
    skips: list[tuple[int, ReviewSkip]],
    cached: bool,
) -> _Candidate | None:
    """The PR's candidate when ``decide`` would dispatch it; otherwise None, logging why it is left alone.

    A dispatch is logged by the caller that takes it: a cached result that would dispatch is
    fingerprinted afresh instead. A decision taken from a ``cached`` result is logged as one.
    """
    tag = ", cached" if cached else ""
    # A ReviewSkip is a human decision, never a fingerprint failure: check it before unpacking, which
    # would raise on it, so it is collected as a skip rather than handled as an error.
    if isinstance(result, ReviewSkip):
        logger.info("PR #%d: SKIP (%s%s): %s", number, result.reason, tag, result.detail)
        skips.append((number, result))
        return None
    head_sha, eval_hash = result
    outcome = decide(
        current_eval_hash=eval_hash,
        latest_status=recorded.status if recorded is not None else None,
        latest_eval_hash=recorded.eval_hash if recorded is not None else None,
        latest_version=recorded.version if recorded is not None else None,
        now=now,
        timeout=timeout,
    )
    if outcome.action is Decision.DISPATCH:
        return _Candidate(number, head_sha, eval_hash, recorded, outcome.reason)
    logger.info("PR #%d: %s (%s%s)", number, outcome.action.name, outcome.reason, tag)
    return None


def _evaluate_pr(
    number: int,
    future: Future[FingerprintResult | _Cancelled],
    states: dict[int, PRState],
    *,
    now: datetime,
    timeout: timedelta,
    failed: list[int],
    abandoned: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
    cache: FingerprintCache | None,
) -> _Candidate | None:
    try:
        result = future.result()
        # A cancelled task never ran its fingerprint (an earlier task hit a rate limit and tripped
        # the shared cancel event), so it is not a failure: record it as abandoned (never evaluated),
        # kept distinct from `failed` so the end-of-scan signal can report both without conflating them.
        if result is _CANCELLED:
            abandoned.append(number)
            return None
        recorded = states.get(number)
        if force and not isinstance(result, ReviewSkip):
            head_sha, eval_hash = result
            candidate: _Candidate | None = _Candidate(number, head_sha, eval_hash, recorded, "forced")
        else:
            candidate = _judge(number, result, recorded, now=now, timeout=timeout, skips=skips, cached=False)
        # Stored only once judged cleanly, so a PR that fails here leaves nothing for a later tick to reuse.
        if cache is not None:
            cache.store(number, result)
        if candidate is not None:
            logger.info("PR #%d: DISPATCH (%s)", number, candidate.reason)
        return candidate
    except IterationTimeout:
        raise
    except Exception:
        logger.exception("skipping PR #%d: failed to evaluate", number)
        failed.append(number)
        return None


def _settle_from_cache(
    pr_numbers: Sequence[int],
    states: dict[int, PRState],
    *,
    cache: FingerprintCache | None,
    now: datetime,
    timeout: timedelta,
    skips: list[tuple[int, ReviewSkip]],
) -> list[int]:
    """Judge each PR the cache still holds a result for, and return the rest, in order, to fingerprint.

    A cached result that would dispatch, or whose judgment raises, goes back with the rest: every
    dispatch carries a fresh head and hash, and the fresh path contains a PR's errors.
    """
    if cache is None:
        return list(pr_numbers)
    unsettled: list[int] = []
    for number in pr_numbers:
        try:
            cached = cache.lookup(number)
            settled = (
                cached is not None
                and _judge(number, cached, states.get(number), now=now, timeout=timeout, skips=skips, cached=True)
                is None
            )
        except IterationTimeout:
            raise
        except Exception:
            logger.exception("PR #%d: failed to judge its cached fingerprint; fingerprinting it afresh", number)
            settled = False
        if settled:
            cache.keep(number)
        else:
            unsettled.append(number)
    return unsettled


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
    abandoned: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
    cancel_event: threading.Event,
    cache: FingerprintCache | None,
) -> list[_Candidate]:
    unsettled = _settle_from_cache(pr_numbers, states, cache=cache, now=now, timeout=timeout, skips=skips)
    futures: dict[int, Future[FingerprintResult | _Cancelled]] = {}
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
                for number in unsettled
            }
    pending: list[_Candidate] = []
    for number in unsettled:
        candidate = _evaluate_pr(
            number,
            futures[number],
            states,
            now=now,
            timeout=timeout,
            failed=failed,
            abandoned=abandoned,
            skips=skips,
            force=force,
            cache=cache,
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
    abandoned: list[int],
    skips: list[tuple[int, ReviewSkip]],
    force: bool,
    cancel_event: threading.Event,
    cache: FingerprintCache | None,
) -> list[_Candidate]:
    """Fingerprint the stalest PRs first, submitting only until ``limit`` candidates are in hand.

    The pool is kept saturated: each completion frees its slot immediately, so no task ever waits
    on a slower sibling. Submission stops the moment the cap is reached or the fan-out is
    cancelled, but whatever is already in flight is still evaluated -- its GitHub call is already
    paid for, and dropping the result would lose a failure or a human-decision skip. A PR its cached
    result settles is never submitted, so it takes no slot and never counts toward ``limit``.
    """
    ranked = sorted(pr_numbers, key=lambda number: _staleness_key_for_state(states.get(number)))
    unsettled = _settle_from_cache(ranked, states, cache=cache, now=now, timeout=timeout, skips=skips)
    found: dict[int, _Candidate] = {}
    if worker_count:
        queued = iter(unsettled)
        in_flight: dict[Future[FingerprintResult | _Cancelled], int] = {}
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            while True:
                while len(in_flight) < worker_count and len(found) < limit and not cancel_event.is_set():
                    queued_number = next(queued, None)
                    if queued_number is None:
                        break
                    task = pool.submit(
                        _fingerprint_task,
                        fingerprint,
                        client_pool,
                        queued_number,
                        authorized_logins,
                        skip_on_approval,
                        cancel_event,
                    )
                    in_flight[task] = queued_number
                if not in_flight:
                    break
                done, _unfinished = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in done:
                    number = in_flight.pop(future)
                    candidate = _evaluate_pr(
                        number,
                        future,
                        states,
                        now=now,
                        timeout=timeout,
                        failed=failed,
                        abandoned=abandoned,
                        skips=skips,
                        force=force,
                        cache=cache,
                    )
                    if candidate is not None:
                        found[number] = candidate
    # Ranked order, not completion order: the dispatch cap is applied by a stable staleness sort,
    # so returning these in whichever order the pool happened to finish would hand the last slot
    # to the fastest task rather than the stalest PR.
    return [found[number] for number in ranked if number in found]


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
