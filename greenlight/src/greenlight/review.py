"""Scan trusted-author pytorch/pytorch PRs and dispatch the AI review workflow.

Each scan lists the open PRs from a fixed trusted-author set, fingerprints each one,
reads its latest recorded state from ClickHouse, and asks ``decision.decide`` whether to
dispatch a review, skip it, or wait. State is re-read from ClickHouse every scan, so the
one-shot and ``--loop`` paths behave identically -- nothing is remembered in memory
between scans. All GitHub, ClickHouse, and dispatch I/O sits behind injectable keyword
seams so the loop is testable without any of them.

The fingerprint step can also short-circuit: when a human has already decided a PR (an
approval from a merge-authorized login, or changes requested by anyone), the scan skips
its fingerprint and dispatch. On the listing path an approval or changes-requested skips;
on the ``--pr`` recheck path an approval is ignored (reviewed anyway) and changes-requested
is refused with a comment instead of a dispatch.
"""

from __future__ import annotations

import contextlib
import logging
import queue
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import dispatch as dispatch_module
from greenlight import github_client, scan_runner, state, state_emit
from greenlight.constants import (
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    EXCLUDED_LABELS,
    TARGET_REPO,
    TERMINAL_STATUSES,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.config import Config
    from greenlight.github_client import OpenPR, VerdictPR
    from greenlight.review_gate import ReviewSkip
    from greenlight.scan_runner import FingerprintFn
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

# Case-insensitive membership for the two authz gates (target-PR author and recheck requester);
# GitHub logins are case-insensitive, so gate on the lowercased login against this derived set.
_TRUSTED_LOWER: frozenset[str] = frozenset(author.lower() for author in TRUSTED_AUTHORS)


def _is_trusted(login: str | None) -> bool:
    return login is not None and login.lower() in _TRUSTED_LOWER


_FINGERPRINT_WORKERS = 8


def _utcnow() -> datetime:
    # Naive UTC to match the version column: state.read_latest_states normalizes every
    # version to naive UTC on read, and decision.decide subtracts the two, which would
    # raise if either operand were tz-aware.
    return datetime.now(UTC).replace(tzinfo=None)


def _default_fetch(client: Github) -> list[OpenPR]:
    return github_client.list_open_prs_by_authors(client, TARGET_REPO, TRUSTED_AUTHORS)


def _default_fetch_author(client: Github, pr_number: int) -> str | None:
    return github_client.get_pr_author(client, TARGET_REPO, pr_number)


def _default_fingerprint(
    client: Github, pr_number: int, authorized_logins: frozenset[str], skip_on_approval: bool
) -> tuple[str, str] | ReviewSkip:
    # allow_skip is unconditional: a human-decided PR always short-circuits the fingerprint.
    # skip_on_approval varies by path so an approval skips the listing but never the recheck.
    return github_client.fingerprint_pr(
        client,
        TARGET_REPO,
        pr_number,
        authorized_logins=authorized_logins,
        allow_skip=True,
        skip_on_approval=skip_on_approval,
    )


def _close_client(client: Github) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            logger.exception("failed to close GitHub client")


def _candidate_numbers(
    client: Github, *, pr: int | None, fetch: Callable[[Github], list[OpenPR]]
) -> tuple[list[int], dict[int, datetime | None], frozenset[int]]:
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, TARGET_REPO)
        return [pr], {}, frozenset()
    open_prs = fetch(client)
    logger.info("found %d open PR(s) from %d author(s) in %s", len(open_prs), len(TRUSTED_AUTHORS), TARGET_REPO)
    for open_pr in open_prs:
        logger.info("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
    stale_labeled_numbers = frozenset(
        open_pr.number for open_pr in open_prs if not EXCLUDED_LABELS.isdisjoint(open_pr.labels)
    )
    return (
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        stale_labeled_numbers,
    )


def _within_recency_window(updated_at: datetime | None, now: datetime, window: timedelta) -> bool:
    # A missing updated_at is never treated as stale: absence must not hide recent activity.
    if updated_at is None:
        return True
    return now - updated_at < window


def _recency_filter(
    pr_numbers: Sequence[int],
    updated_at_by_number: dict[int, datetime | None],
    states: dict[int, PRState],
    stale_labeled_numbers: frozenset[int],
    *,
    now: datetime,
    window: timedelta,
) -> list[int]:
    """Drop PRs the scan can safely leave alone this iteration.

    A PR is kept when it was updated within ``window`` AND is not ``Stale``-labeled, OR its
    recorded state is non-terminal (in-flight or retry-eligible), so ``decide`` can still
    re-dispatch it on timeout/retry. A PR is skipped without fingerprinting when it is stale or
    ``Stale``-labeled and either terminal (its eval_hash cannot have changed) or never reviewed
    (an untouched PR is not worth a first review). The ``Stale`` label matters because the pytorch
    stale bot bumps ``updated_at`` when it applies the label, which would otherwise drag an
    abandoned never-reviewed PR back into the window.
    """
    kept: list[int] = []
    for number in pr_numbers:
        active = _within_recency_window(updated_at_by_number.get(number), now, window)
        stale_labeled = number in stale_labeled_numbers
        if active and not stale_labeled:
            kept.append(number)
            continue
        recorded = states.get(number)
        if recorded is not None and recorded.status not in TERMINAL_STATUSES:
            kept.append(number)
            continue
        detail = recorded.status if recorded is not None else "never reviewed"
        if stale_labeled:
            logger.info("skipping PR #%d: Stale label (%s)", number, detail)
        else:
            logger.info("skipping stale PR #%d: no recent activity (%s)", number, detail)
    return kept


def run(
    config: Config,
    *,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    force: bool = False,
    requester: str | None = None,
    allow_untrusted_author: bool = False,
    bot_login: str = "",
    build_github: Callable[[str], Github] = github_client.build_client,
    fetch: Callable[[Github], list[OpenPR]] = _default_fetch,
    fetch_author: Callable[[Github, int], str | None] = _default_fetch_author,
    fingerprint: FingerprintFn = _default_fingerprint,
    read_state: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    dispatch: Callable[[Github, int, str, str, str], None] = dispatch_module.dispatch_review,
    emit_dispatched: Callable[..., None] = state_emit.emit_ai_review_dispatched,
    get_pr: Callable[[Github, str, int], VerdictPR] = github_client.get_pr,
    upsert_comment: Callable[..., None] = github_client.upsert_issue_comment,
    resolve_authorized: Callable[[], frozenset[str]],
    now: Callable[[], datetime] = _utcnow,
) -> None:
    logger.info("reviewing trusted-author PRs in %s", TARGET_REPO)
    logger.debug("greenlight config: %r", config)
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    # Requester gate (recheck path): an untrusted requester is rejected before any network work,
    # so a spammed @greenlight recheck from an untrusted login costs nothing. A policy refusal is
    # not a failure -- return cleanly rather than raising (no non-zero exit, no daemon backoff).
    if requester is not None:
        if not _is_trusted(requester):
            logger.warning("refusing review: requester %r is not a trusted author", requester)
            return
        logger.info("review requested by trusted author %s", requester)
    with contextlib.ExitStack() as clients:
        client = build_github(token)
        clients.callback(_close_client, client)
        # Target-author gate: the listing path is already trusted-only, but --pr names an arbitrary
        # PR, so its author MUST be trusted too or greenlight would review/approve any PR on request.
        # allow_untrusted_author bypasses ONLY this check (local iteration; never a workflow input).
        if pr is not None and not allow_untrusted_author:
            author = fetch_author(client, pr)
            if not _is_trusted(author):
                logger.warning("refusing --pr %d: author %r is not a trusted author", pr, author)
                return
        # Resolved once per scan and never caught here: a cold failure must fail the scan (one-shot
        # exits non-zero, daemon backs off) rather than silently revert to hashing all human comments.
        authorized_logins = resolve_authorized()
        logger.info("filtering fingerprint comments to %d merge-authorized login(s)", len(authorized_logins))
        pr_numbers, updated_at_by_number, stale_labeled_numbers = _candidate_numbers(client, pr=pr, fetch=fetch)
        states = read_state(TARGET_REPO, pr_numbers)
        evaluated_at = now()
        timeout = timedelta(minutes=timeout_minutes)
        # A human approval skips only the listing scan; on --pr the recheck reviews anyway (an
        # approval must never suppress a manual recheck). Changes-requested still skips on both.
        skip_on_approval = pr is None
        if pr is None:
            # A single --pr target is always evaluated; the recency window only prunes the
            # listed scan, where a stale untouched PR would waste a fingerprint.
            fingerprint_numbers = _recency_filter(
                pr_numbers,
                updated_at_by_number,
                states,
                stale_labeled_numbers,
                now=evaluated_at,
                window=timedelta(hours=config.review_window_hours),
            )
        else:
            fingerprint_numbers = pr_numbers
        failed: list[int] = []
        skips: list[tuple[int, ReviewSkip]] = []
        worker_count = min(_FINGERPRINT_WORKERS, len(fingerprint_numbers))
        # PyGithub is not thread-safe, so each concurrent task borrows a client for its
        # exclusive use; sizing the pool to the worker count keeps queue.get non-blocking
        # and guarantees no two running tasks ever share one.
        client_pool: queue.Queue[Github] = queue.Queue()
        for _ in range(worker_count):
            worker_client = build_github(token)
            clients.callback(_close_client, worker_client)
            client_pool.put(worker_client)
        if max_dispatches is None:
            pending = scan_runner._fingerprint_all(
                fingerprint_numbers,
                states,
                fingerprint=fingerprint,
                client_pool=client_pool,
                worker_count=worker_count,
                authorized_logins=authorized_logins,
                skip_on_approval=skip_on_approval,
                now=evaluated_at,
                timeout=timeout,
                failed=failed,
                skips=skips,
                force=force,
            )
        else:
            pending = scan_runner._fingerprint_until_dispatchable(
                fingerprint_numbers,
                states,
                fingerprint=fingerprint,
                client_pool=client_pool,
                worker_count=worker_count,
                authorized_logins=authorized_logins,
                skip_on_approval=skip_on_approval,
                limit=max(0, max_dispatches),
                now=evaluated_at,
                timeout=timeout,
                failed=failed,
                skips=skips,
                force=force,
            )
        dispatch_failed = scan_runner._dispatch_pending(
            client, pending, ref=ref, max_dispatches=max_dispatches, dispatch=dispatch, emit_dispatched=emit_dispatched
        )
        # Only the --pr recheck path posts refusals; a listing-scan skip is dropped silently
        # (already logged). skips can hold a refusal only when skip_on_approval is False (--pr),
        # so this can never comment on a listing-scan approval.
        if pr is not None:
            scan_runner.post_refusals(
                client, TARGET_REPO, skips, bot_login=bot_login, get_pr=get_pr, upsert_comment=upsert_comment
            )
        if failed or dispatch_failed:
            errors: list[str] = []
            if failed:
                errors.append(f"{len(failed)} PR(s) failed during scan: {sorted(failed)}")
            if dispatch_failed:
                errors.append(f"failed to dispatch {len(dispatch_failed)} PR(s): {sorted(dispatch_failed)}")
            raise RuntimeError("; ".join(errors))
