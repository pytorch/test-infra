"""Scan pytorch/pytorch PRs from the evaluation cohort and dispatch the AI review workflow.

Each scan lists the open PRs from ``cohort.evaluation_cohort`` (the merge_rules approvers), reads
their latest recorded state from ClickHouse, fingerprints each PR whose author is eligible for it,
and asks ``decision.decide`` whether to dispatch a review, skip it, or wait. An author is eligible
when a merge rule names them and covers every file the PR changes; a path-scoped rule also needs a
non-ghstack PR based on ``main`` (see ``authority`` and TRUSTED_AUTHORS.md). The scan never
fingerprints or dispatches any other PR; when a recent one's author is determined ineligible and its
latest recorded row is a LAND, the scan dismisses greenlight's approval on it instead, writing no row.
A PR whose files read failed or was skipped stays undetermined: never dismissed, never dispatched.
The ``shadow`` stamp marks an ineligible ``--pr`` target reviewed under the local-only
``--allow-untrusted-author`` -- never approved, never rendered, no Dr. CI poke -- and the REVERTED
row of an ineligible PR with no recorded row; on a recorded PR the REVERTED row is always
non-shadow, since it can only deny. State is re-read from ClickHouse every scan, so the one-shot and
``--loop`` paths behave identically -- nothing is remembered in memory between scans. All GitHub,
ClickHouse, and dispatch I/O sits behind injectable keyword seams so the loop is testable without any
of them.

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
from greenlight.constants import (
    BOT_LOGIN_SUFFIX,
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    EXCLUDED_LABELS,
    STATUS_LAND,
    TARGET_REPO,
    is_app_login,
)
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence
    from typing import Protocol

    from github import Github

    from greenlight.config import Config
    from greenlight.github_client import OpenPR
    from greenlight.github_types import VerdictPR
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.review_gate import ReviewSkip
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

_NO_LONGER_ELIGIBLE_MESSAGE = (
    "This pull request is no longer eligible for a greenlight review under merge_rules.yaml; "
    "greenlight's approval no longer applies."
)


def _utcnow() -> datetime:
    # Naive UTC to match the version column: state.read_latest_states normalizes every
    # version to naive UTC on read, and decision.decide subtracts the two, which would
    # raise if either operand were tz-aware.
    return datetime.now(UTC).replace(tzinfo=None)


def _default_fetch(client: Github, authors: frozenset[str]) -> list[OpenPR]:
    return github_client.list_open_prs_by_authors(client, TARGET_REPO, authors)


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


def _candidate_numbers(
    client: Github,
    *,
    pr: int | None,
    fetch: Callable[[Github, frozenset[str]], list[OpenPR]],
    authors: frozenset[str],
) -> tuple[list[int], dict[int, datetime | None], dict[int, tuple[str, ...]], dict[int, str]]:
    """Return the candidate PR numbers with their ``updated_at``, labels, and author.

    The ``--pr`` path has no listing to read labels or an author from, so it returns neither: the one
    caller that needs labels (``revert_guard``) fetches that single PR's, and the PR's author and
    authority come from its gate.
    """
    if pr is not None:
        logger.info("targeting single PR #%d in %s", pr, TARGET_REPO)
        return [pr], {}, {}, {}
    open_prs = fetch(client, authors)
    logger.info("found %d open PR(s) from %d author(s) in %s", len(open_prs), len(authors), TARGET_REPO)
    for open_pr in open_prs:
        logger.debug("open PR #%d by %s: %s (%s)", open_pr.number, open_pr.author, open_pr.title, open_pr.url)
    return (
        [open_pr.number for open_pr in open_prs],
        {open_pr.number: open_pr.updated_at for open_pr in open_prs},
        {open_pr.number: open_pr.labels for open_pr in open_prs},
        {open_pr.number: open_pr.author for open_pr in open_prs},
    )


def _revoke_ineligible_approvals(
    client: Github,
    ineligible: Sequence[int],
    *,
    states: Mapping[int, PRState],
    bot_login: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> None:
    """Dismiss greenlight's approval on each PR in ``ineligible`` whose latest recorded row is a LAND.

    Under merge_rules.yaml's wildcard Greenlight Review Bot rule, an approval greenlight gave while the
    PR was eligible still authorizes a merge, and the scan dispatches no review that would revoke it.
    Nothing is recorded, dispatched or poked. A failure is accounted as the revert guard accounts its
    own: a rate limit trips ``cancel_event``, and the PR fails the pass.
    """
    due = [number for number in ineligible if (row := states.get(number)) is not None and row.status == STATUS_LAND]
    if not due:
        return
    # As in revert_guard: an empty or non-App login matches no review, so it would dismiss nothing
    # while reporting success.
    if not is_app_login(bot_login):
        raise ValueError(
            f"BOT_LOGIN must be the greenlight App login (<app-slug>{BOT_LOGIN_SUFFIX}) to revoke approvals "
            f"on PR(s) no longer eligible {due}; got {bot_login!r}"
        )
    for number in due:
        try:
            dismissed = dismiss(
                get_pr(client, TARGET_REPO, number), bot_login=bot_login, message=_NO_LONGER_ELIGIBLE_MESSAGE
            )
        except IterationTimeout:
            raise
        except Exception as exc:
            if github_client.is_rate_limit_error(exc):
                cancel_event.set()
            logger.error(
                "failed to revoke greenlight approval on PR #%d, which is no longer eligible: %s",
                number,
                exc,
                exc_info=True,
            )
            failed.append(number)
            continue
        if dismissed:
            logger.info(
                "dismissed %d greenlight approval(s) on PR #%d, which is no longer eligible", len(dismissed), number
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
    fetch: Callable[[Github, frozenset[str]], list[OpenPR]] = _default_fetch,
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
        pr_numbers, updated_at_by_number, labels_by_number, authors_by_number = _candidate_numbers(
            client, pr=pr, fetch=fetch, authors=evaluable
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
                window=timedelta(hours=config.review_window_hours),
            )
            fingerprint_numbers = [number for number in recent if not authority.shadow(number)]
            undetermined = authority.undetermined
            _revoke_ineligible_approvals(
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
