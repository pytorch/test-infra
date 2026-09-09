"""Scan trusted-author pytorch/pytorch PRs and dispatch the AI review workflow.

Each scan lists the open PRs from a fixed trusted-author set, fingerprints each one,
reads its latest recorded state from ClickHouse, and asks ``decision.decide`` whether to
dispatch a review, skip it, or wait. State is re-read from ClickHouse every scan, so the
one-shot and ``--loop`` paths behave identically -- nothing is remembered in memory
between scans. All GitHub, ClickHouse, and dispatch I/O sits behind injectable keyword
seams so the loop is testable without any of them.

Reverted PRs are excluded before any of that, on both the listing and ``--pr`` paths: greenlight
revokes its own approval, records the exclusion, and drops the PR (see ``revert_guard``).

The fingerprint step can also short-circuit: when a human has already decided a PR (an
approval from a merge-authorized login, or changes requested by anyone), the scan skips
its fingerprint and dispatch. On the listing path an approval or changes-requested skips;
on the ``--pr`` recheck path an approval is ignored (reviewed anyway) and changes-requested
is refused with a comment instead of a dispatch.
"""

from __future__ import annotations

import contextlib
import dataclasses
import logging
import queue
import threading
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import candidate_filter, cohort, drci_poke, github_client, revert_guard, scan_runner, state, state_emit
from greenlight import dispatch as dispatch_module
from greenlight.constants import (
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    EXCLUDED_LABELS,
    TARGET_REPO,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from typing import Protocol

    from github import Github

    from greenlight.config import Config
    from greenlight.github_client import OpenPR
    from greenlight.github_types import VerdictPR
    from greenlight.review_gate import ReviewSkip
    from greenlight.scan_runner import FingerprintFn
    from greenlight.state import PRState

    class _BuildClient(Protocol):
        # token positional-only so injected test doubles needn't match the parameter name.
        def __call__(self, token: str, /, *, seconds_between_requests: float = 0.25) -> Github: ...


logger = logging.getLogger(__name__)

# Aggregate fan-out request rate is workers / seconds-between-requests: more workers or a
# shorter interval raise it. Cutting workers (8->4) and lengthening the interval (0.25s->0.5s)
# both lower it, to ~8 req/s, keeping the fan-out under GitHub's secondary (burst-rate) limit
# that the prior 8-worker / 0.25s pool tripped.
_FINGERPRINT_WORKERS = 4
_FINGERPRINT_SECONDS_BETWEEN_REQUESTS = 0.5


def _utcnow() -> datetime:
    # Naive UTC to match the version column: state.read_latest_states normalizes every
    # version to naive UTC on read, and decision.decide subtracts the two, which would
    # raise if either operand were tz-aware.
    return datetime.now(UTC).replace(tzinfo=None)


def _default_fetch(client: Github) -> list[OpenPR]:
    return github_client.list_open_prs_by_authors(client, TARGET_REPO, cohort.TRUSTED_AUTHORS)


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
) -> tuple[list[int], dict[int, datetime | None], dict[int, tuple[str, ...]]]:
    """Return the candidate PR numbers with their ``updated_at`` and, from the listing, their labels.

    The ``--pr`` path has no listing to read labels from, so it returns none and leaves the one
    caller that needs them (``revert_guard``) to fetch that single PR's.
    """
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, TARGET_REPO)
        return [pr], {}, {}
    open_prs = fetch(client)
    logger.info("found %d open PR(s) from %d author(s) in %s", len(open_prs), len(cohort.TRUSTED_AUTHORS), TARGET_REPO)
    for open_pr in open_prs:
        logger.info("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
    return (
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        {open_pr.number: open_pr.labels for open_pr in open_prs},
    )


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
    build_github: _BuildClient = github_client.build_client,
    fetch: Callable[[Github], list[OpenPR]] = _default_fetch,
    fetch_author: Callable[[Github, int], str | None] = _default_fetch_author,
    fetch_labels: Callable[[Github, str, int], tuple[str, ...]] = revert_guard.fetch_pr_labels,
    fingerprint: FingerprintFn = _default_fingerprint,
    read_state: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    read_reverted: Callable[[str, Sequence[int]], set[int]] = state.read_reverted_pr_numbers,
    dispatch: Callable[[Github, int, str, str, str], None] = dispatch_module.dispatch_review,
    emit_dispatched: Callable[..., None] = state_emit.emit_ai_review_dispatched,
    emit_reverted: Callable[..., None] = state_emit.emit_reverted,
    poke_drci: Callable[[str, int, Config], None] = drci_poke.poke,
    get_pr: Callable[[Github, str, int], VerdictPR] = github_client.get_pr,
    dismiss_approvals: Callable[..., list[int]] = github_client.dismiss_prior_greenlight_approvals,
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
        if not cohort.is_trusted(requester):
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
            if not cohort.is_trusted(author):
                logger.warning("refusing --pr %d: author %r is not a trusted author", pr, author)
                return
        # Resolved once per scan and never caught here: a cold failure must fail the scan (one-shot
        # exits non-zero, daemon backs off) rather than silently revert to hashing all human comments.
        authorized_logins = resolve_authorized()
        logger.info("filtering fingerprint comments to %d merge-authorized login(s)", len(authorized_logins))
        pr_numbers, updated_at_by_number, labels_by_number = _candidate_numbers(client, pr=pr, fetch=fetch)
        states = read_state(TARGET_REPO, pr_numbers)
        evaluated_at = now()
        timeout = timedelta(minutes=timeout_minutes)
        failed: list[int] = []
        abandoned: list[int] = []
        skips: list[tuple[int, ReviewSkip]] = []
        # Owned here (not inside the helpers) so run can read it back after the fan-out: a rate limit
        # trips it, which gates the dispatch phase below. It reflects "the cancel event fired," which
        # is broader than a non-empty `abandoned` -- a rate limit on the last task leaves nothing to
        # cancel (abandoned stays empty) yet must still skip dispatch.
        cancel_event = threading.Event()
        # drci_poke's configured delay covers the verdict path's gap between writing the row to /tmp
        # and a later workflow step uploading it. Both emits below have already PUT the object to S3
        # before returning, and neither loop is capped, so keeping the wait would only multiply one
        # sleep per PR into the Lambda's function timeout.
        poke_config = dataclasses.replace(config, drci_poke_delay_seconds=0.0)
        excluded = revert_guard.exclude_reverted(
            client,
            pr_numbers,
            known_labels=labels_by_number,
            states=states,
            bot_login=bot_login,
            read_reverted=read_reverted,
            fetch_labels=fetch_labels,
            get_pr=get_pr,
            dismiss=dismiss_approvals,
            emit=emit_reverted,
            poke=lambda number: poke_drci(TARGET_REPO, number, poke_config),
            failed=failed,
            cancel_event=cancel_event,
        )
        pr_numbers = [number for number in pr_numbers if number not in excluded]
        # A human approval skips only the listing scan; on --pr the recheck reviews anyway (an
        # approval must never suppress a manual recheck). Changes-requested still skips on both.
        skip_on_approval = pr is None
        if pr is None:
            # A single --pr target is always evaluated; the recency window only prunes the
            # listed scan, where a stale untouched PR would waste a fingerprint.
            fingerprint_numbers = candidate_filter.recency_filter(
                pr_numbers,
                updated_at_by_number,
                states,
                candidate_filter.labeled_with(labels_by_number, EXCLUDED_LABELS),
                now=evaluated_at,
                window=timedelta(hours=config.review_window_hours),
            )
        else:
            fingerprint_numbers = pr_numbers
        worker_count = min(_FINGERPRINT_WORKERS, len(fingerprint_numbers))
        # PyGithub is not thread-safe, so each concurrent task borrows a client for its
        # exclusive use; sizing the pool to the worker count keeps queue.get non-blocking
        # and guarantees no two running tasks ever share one.
        client_pool: queue.Queue[Github] = queue.Queue()
        for _ in range(worker_count):
            worker_client = build_github(token, seconds_between_requests=_FINGERPRINT_SECONDS_BETWEEN_REQUESTS)
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
                abandoned=abandoned,
                skips=skips,
                force=force,
                cancel_event=cancel_event,
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
                abandoned=abandoned,
                skips=skips,
                force=force,
                cancel_event=cancel_event,
            )
        dispatch_failed: list[int] = []
        if cancel_event.is_set():
            # A rate limit tripped the fan-out. The completed candidates are deferred, not lost: no
            # state row is written for them, so the next scan re-fingerprints and dispatches them once
            # the limit clears. Firing workflow_dispatch POSTs now on the same throttled token is what
            # GitHub's secondary-rate-limit detection punishes most, so skip the dispatch phase.
            logger.warning(
                "rate limit hit: abandoned %d of %d fingerprint(s) (not evaluated); "
                "skipping dispatch of %d completed candidate(s) this pass; will retry next scan",
                len(abandoned),
                len(fingerprint_numbers),
                len(pending),
            )
        else:
            dispatch_failed = scan_runner._dispatch_pending(
                client,
                pending,
                ref=ref,
                max_dispatches=max_dispatches,
                dispatch=dispatch,
                emit_dispatched=emit_dispatched,
                poke=lambda number: poke_drci(TARGET_REPO, number, poke_config),
            )
        # Only the --pr recheck path posts refusals; a listing-scan skip is dropped silently
        # (already logged). skips can hold a refusal only when skip_on_approval is False (--pr),
        # so this can never comment on a listing-scan approval.
        if pr is not None:
            scan_runner.post_refusals(
                client, TARGET_REPO, skips, bot_login=bot_login, get_pr=get_pr, upsert_comment=upsert_comment
            )
        if failed or dispatch_failed or abandoned:
            errors: list[str] = []
            if failed:
                errors.append(f"{len(failed)} PR(s) failed during scan: {sorted(failed)}")
            if dispatch_failed:
                errors.append(f"failed to dispatch {len(dispatch_failed)} PR(s): {sorted(dispatch_failed)}")
            if abandoned:
                errors.append(f"{len(abandoned)} PR(s) abandoned due to rate limit: {sorted(abandoned)}")
            raise RuntimeError("; ".join(errors))
