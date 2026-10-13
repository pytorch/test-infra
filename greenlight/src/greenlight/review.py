"""Scan pytorch/pytorch PRs from the evaluation cohort and dispatch the AI review workflow.

Each scan lists the open PRs from ``cohort.evaluation_cohort`` (the merge_rules approvers), reads
their latest recorded state from ClickHouse, fingerprints each PR whose author is eligible for it,
and asks ``decision.decide`` whether to dispatch a review, skip it, or wait. An author is eligible
when a merge rule names them and covers every file the PR changes. If the rule is path-scoped, it counts
only on a PR based on ``main`` or on a ghstack PR (see ``authority`` and TRUSTED_AUTHORS.md). The scan never
fingerprints or dispatches any other PR; when a recent one's author is determined ineligible and its
latest recorded row is a LAND, the scan dismisses greenlight's approval on it instead, writing no row.
A PR whose files read failed or was skipped stays undetermined: never dismissed, never dispatched.
The ``shadow`` stamp marks an ineligible ``--pr`` target reviewed under the local-only
``--allow-untrusted-author`` -- never approved, never rendered, no Dr. CI poke -- and the REVERTED
row of an ineligible PR with no recorded row; on a recorded PR the REVERTED row is always
non-shadow, since it can only deny. State is re-read from ClickHouse every scan. ``memory`` decides
how much a listing scan lists: a full tick lists every open PR, on every tick until one completes,
and again ``FULL_TICK_INTERVAL`` (less ``FULL_TICK_TOLERANCE``) after the start of the last full
tick that completed; the fast ticks in between list the recently updated PRs plus the open
Reverted-labelled ones (``pr_listing``). ``memory=None`` makes every tick full. All GitHub,
ClickHouse, and dispatch I/O sits behind injectable keyword seams so the loop is testable without
any of them.

Both authz gates (``authz_gates``) run once the merge rules resolve.

Reverted PRs are excluded before any of that on the listing path, and on the ``--pr`` path once its
gate admits the target or refuses one whose author GitHub can name (a refused target with no author
login never reaches the revert guard): greenlight revokes its own approval, records the exclusion,
and drops the PR (see ``revert_guard``). A refused target is never fingerprinted or dispatched.

The fingerprint step can also short-circuit: when a human has already decided a PR (an
approval from a merge-authorized login, or changes requested by anyone), the scan skips
its fingerprint and dispatch. On the listing path an approval or changes-requested skips;
on the ``--pr`` recheck path an approval is ignored (reviewed anyway) and changes-requested
is refused with a comment instead of a dispatch. A candidate fingerprinted at a head other than
the one its authority was read at is deferred to the next pass; a deferred ``--pr`` recheck exits 0
without dispatching.
"""

from __future__ import annotations

import contextlib
import dataclasses
import logging
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from greenlight import candidate_filter, cohort, drci_poke, github_client, revert_guard, scan_runner, state, state_emit
from greenlight import dispatch as dispatch_module
from greenlight.authority import Authority, Target
from greenlight.authz_gates import admit_target, requester_allowed
from greenlight.constants import DEFAULT_DISPATCH_REF, DEFAULT_TIMEOUT_MINUTES, EXCLUDED_LABELS, TARGET_REPO
from greenlight.ineligible_approvals import revoke_ineligible_approvals
from greenlight.pr_listing import candidate_numbers, default_fetch, default_fetch_updated

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from typing import Protocol

    from github import Github

    from greenlight.config import Config
    from greenlight.github_types import VerdictPR
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.pr_listing import FetchFn, FetchUpdatedFn
    from greenlight.review_gate import ReviewSkip
    from greenlight.scan_memory import ScanMemory
    from greenlight.scan_runner import DispatchFn, FingerprintFn
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
    fetch: FetchFn = default_fetch,
    fetch_updated: FetchUpdatedFn = default_fetch_updated,
    fetch_labels: Callable[[Github, str, int], tuple[str, ...]] = revert_guard.fetch_pr_labels,
    fingerprint: FingerprintFn = _default_fingerprint,
    read_state: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    read_reverted: Callable[[str, Sequence[int]], set[int]] = state.read_reverted_pr_numbers,
    dispatch: DispatchFn = dispatch_module.dispatch_review,
    emit_dispatched: Callable[..., None] = state_emit.emit_ai_review_dispatched,
    emit_reverted: Callable[..., None] = state_emit.emit_reverted,
    poke_drci: Callable[[str, int, Config], None] = drci_poke.poke,
    get_pr: Callable[[Github, str, int], VerdictPR] = github_client.get_pr,
    dismiss_approvals: Callable[..., list[int]] = github_client.dismiss_prior_greenlight_approvals,
    upsert_comment: Callable[..., None] = github_client.upsert_issue_comment,
    resolve_merge_rules: Callable[[], MergeRulesSnapshot],
    now: Callable[[], datetime] = _utcnow,
    memory: ScanMemory | None = None,
) -> None:
    logger.info("reviewing evaluation-cohort PRs in %s", TARGET_REPO)
    logger.debug("greenlight config: %r", config)
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    # Resolved once per scan and never caught here: a cold failure must fail the scan (one-shot
    # exits non-zero, daemon backs off) rather than silently revert to hashing all human comments.
    snapshot = resolve_merge_rules()
    authorized_logins = snapshot.authorized
    evaluable = cohort.evaluation_cohort(authorized_logins)
    if requester is not None and not requester_allowed(requester, evaluable):
        return
    with contextlib.ExitStack() as clients:
        client = build_github(token)
        clients.callback(github_client.close_client, client)
        target: Target | None = None
        if pr is not None:
            target = admit_target(
                client,
                pr,
                rules=snapshot.rules,
                get_pr=get_pr,
                allow_untrusted_author=allow_untrusted_author,
            )
            if target is None:
                return
        logger.info("filtering fingerprint comments to %d merge-authorized login(s)", len(authorized_logins))
        window = timedelta(hours=config.review_window_hours)
        listed_at = now()
        full_tick = memory is None or memory.full_tick_due(listed_at)
        pr_numbers, updated_at_by_number, labels_by_number, authors_by_number = candidate_numbers(
            client,
            pr=pr,
            authors=evaluable,
            fetch=fetch,
            cutoff=None if full_tick else listed_at - window,
            fetch_updated=fetch_updated,
        )
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
        authority = Authority(
            rules=snapshot.rules,
            authors=authors_by_number,
            fetch_pr=lambda number: get_pr(client, TARGET_REPO, number),
            failed=failed,
            cancel_event=cancel_event,
            recorded=states.keys(),
            target=target,
        )
        # drci_poke's configured delay covers the verdict path's gap between writing the row to /tmp
        # and a later workflow step uploading it. Both emits below have already PUT the object to S3
        # before returning, so the wait buys nothing here and one such sleep per PR would multiply
        # into the Lambda's function timeout.
        poke_config = dataclasses.replace(config, drci_poke_delay_seconds=0.0)
        # Entered on the ExitStack so the drain is __exit__-driven. AWS Lambda freezes the execution
        # environment the instant the handler returns, so an unjoined poke thread would not finish
        # here -- it would thaw and log its outcome inside some later invocation instead.
        poke_pool = clients.enter_context(
            ThreadPoolExecutor(max_workers=drci_poke.POKE_WORKERS, thread_name_prefix="greenlight-poke")
        )
        poke = drci_poke.poke_submitter(poke_pool, TARGET_REPO, poke_drci, poke_config)
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
            poke=poke,
            shadow_for_pr=authority.reverted_shadow,
            failed=failed,
            cancel_event=cancel_event,
        )
        refused = target is not None and target.refused
        pr_numbers = [] if refused else [number for number in pr_numbers if number not in excluded]
        # A human approval skips only the listing scan; on --pr the recheck reviews anyway (an
        # approval must never suppress a manual recheck). Changes-requested still skips on both.
        skip_on_approval = pr is None
        if pr is None:
            # A single --pr target is always evaluated: the recency window only prunes the listed
            # scan, where a stale untouched PR would waste a fingerprint.
            recent = candidate_filter.recency_filter(
                pr_numbers,
                updated_at_by_number,
                states,
                candidate_filter.labeled_with(labels_by_number, EXCLUDED_LABELS),
                now=evaluated_at,
                window=window,
            )
            fingerprint_numbers = [number for number in recent if not authority.shadow(number)]
            undetermined = authority.undetermined
            revoke_ineligible_approvals(
                client,
                [number for number in recent if authority.shadow(number) and number not in undetermined],
                states=states,
                bot_login=bot_login,
                get_pr=get_pr,
                dismiss=dismiss_approvals,
                failed=failed,
                cancel_event=cancel_event,
            )
        else:
            fingerprint_numbers = pr_numbers
        undetermined = authority.undetermined
        fingerprint_numbers = [number for number in fingerprint_numbers if number not in undetermined]
        worker_count = min(_FINGERPRINT_WORKERS, len(fingerprint_numbers))
        # PyGithub is not thread-safe, so each concurrent task borrows a client for its
        # exclusive use; sizing the pool to the worker count keeps queue.get non-blocking
        # and guarantees no two running tasks ever share one.
        client_pool: queue.Queue[Github] = queue.Queue()
        for _ in range(worker_count):
            worker_client = build_github(token, seconds_between_requests=_FINGERPRINT_SECONDS_BETWEEN_REQUESTS)
            clients.callback(github_client.close_client, worker_client)
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
        capped = max_dispatches is not None and len(pending) >= max(0, max_dispatches)
        pending = authority.dispatchable(pending)
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
            # Marked before the per-PR failures below can raise: one failing PR must not hold every
            # later tick to a full listing. A capped tick is not marked: the PRs past the cap were
            # never fingerprinted.
            if full_tick and memory is not None and pr is None and not capped:
                memory.mark_full_tick(listed_at)
            dispatch_failed = scan_runner._dispatch_pending(
                client,
                pending,
                ref=ref,
                max_dispatches=max_dispatches,
                dispatch=dispatch,
                emit_dispatched=emit_dispatched,
                poke=poke,
                shadow_for_pr=authority.shadow,
            )
        # Only the --pr recheck path posts refusals; a listing-scan skip is dropped silently
        # (already logged). skips can hold a refusal only when skip_on_approval is False (--pr),
        # so this can never comment on a listing-scan approval.
        if pr is not None:
            scan_runner.post_refusals(
                client, TARGET_REPO, skips, bot_login=bot_login, get_pr=get_pr, upsert_comment=upsert_comment
            )
        # A PR can land in failed twice (lookup and revert guard) and in failed and abandoned both.
        failed_prs = sorted(set(failed))
        abandoned_prs = sorted(set(abandoned).union(authority.abandoned).difference(failed))
        if failed_prs or dispatch_failed or abandoned_prs:
            errors: list[str] = []
            if failed_prs:
                errors.append(f"{len(failed_prs)} PR(s) failed during scan: {failed_prs}")
            if dispatch_failed:
                errors.append(f"failed to dispatch {len(dispatch_failed)} PR(s): {sorted(dispatch_failed)}")
            if abandoned_prs:
                errors.append(f"{len(abandoned_prs)} PR(s) abandoned due to rate limit: {abandoned_prs}")
            raise RuntimeError("; ".join(errors))
