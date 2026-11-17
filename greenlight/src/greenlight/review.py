"""Scan one configured repo's PRs from the evaluation cohort and dispatch the AI review workflow.

Each scan lists the open PRs from ``cohort.evaluation_cohort`` (the merge_rules approvers), reads
their latest recorded state from ClickHouse, fingerprints each PR whose author is eligible for it,
and asks ``decision.decide`` whether to dispatch a review, skip it, or wait. A PR is eligible when a
valid merge rule names its author, whatever files it changes, and it is based on ``main``, is a
ghstack PR or is in a GitHub-native stack whose trunk is ``main`` (see
``authority`` and TRUSTED_AUTHORS.md). The scan never fingerprints or dispatches any other PR; when
a recent one is ineligible and its latest recorded row is a LAND, the scan dismisses greenlight's
approval on it instead, writing no row. The ``shadow`` stamp marks an ineligible ``--pr`` target
reviewed under the local-only ``--allow-untrusted-author`` -- never approved, never rendered, no Dr.
CI poke -- and the REVERTED row of an ineligible PR with no recorded row; on a recorded PR the
REVERTED row is always non-shadow, since it can only deny. A repo in ``shadow`` mode stamps every
dispatch and marker row shadow. State is re-read from ClickHouse every
scan. ``memory`` decides how much a listing scan lists: a full tick lists every open PR, on every
tick until one completes, and again ``FULL_TICK_INTERVAL`` (less ``FULL_TICK_TOLERANCE``) after the
start of the last full tick that completed; the fast ticks in between list the recently updated PRs
plus the open Reverted-labelled ones (``pr_listing``). ``memory=None`` makes every tick full. All
GitHub, ClickHouse, and dispatch I/O sits behind injectable keyword seams so the loop is testable
without any of them.

``prepare`` runs the safety work: both authz gates (``authz_gates``) once the merge rules resolve,
the listing, the state read, the revert guard, the recency filter and the ineligible revoke.
``review_finish.finish`` runs the optional work (fan-out, dispatch, label pass, refusals) and raises
the errors; ``run`` is both. Dr. CI is poked only for a repo whose ``status_comment`` is ``drci``.

Reverted PRs are excluded before any of that on the listing path, and on the ``--pr`` path once its
gate admits the target or refuses one whose author GitHub can name (a refused target with no author
login never reaches the revert guard): greenlight revokes its own approval, records the exclusion,
and drops the PR (see ``revert_guard``). A refused target is never fingerprinted or dispatched.

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
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from greenlight import (
    candidate_filter,
    cohort,
    drci_poke,
    github_client,
    revert_guard,
    review_finish,
    state,
    state_emit,
    verdict_labels,
)
from greenlight import dispatch as dispatch_module
from greenlight.authority import Authority, Target
from greenlight.authz_gates import admit_target, requester_allowed
from greenlight.constants import DEFAULT_DISPATCH_REF, DEFAULT_TIMEOUT_MINUTES, EXCLUDED_LABELS
from greenlight.ineligible_approvals import revoke_ineligible_approvals
from greenlight.pr_listing import candidate_numbers, default_fetch, default_fetch_updated
from greenlight.repo_config import BUILTIN_PYTORCH
from greenlight.review_finish import PreparedScan

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.config import Config
    from greenlight.github_types import VerdictPR
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.pr_listing import FetchFn, FetchUpdatedFn
    from greenlight.repo_config import RepoEntry
    from greenlight.review_finish import BuildClient
    from greenlight.scan_dispatch import DispatchFn
    from greenlight.scan_memory import ScanMemory
    from greenlight.scan_runner import FingerprintFn, FingerprintResult
    from greenlight.state import PRState


logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    # Naive UTC to match the version column: state.read_latest_states normalizes every
    # version to naive UTC on read, and decision.decide subtracts the two, which would
    # raise if either operand were tz-aware.
    return datetime.now(UTC).replace(tzinfo=None)


def _default_fingerprint(
    client: Github, repo: str, pr_number: int, authorized_logins: frozenset[str], skip_on_approval: bool
) -> FingerprintResult:
    # allow_skip is unconditional: a human-decided PR always short-circuits the fingerprint.
    # skip_on_approval varies by path so an approval skips the listing but never the recheck.
    return github_client.fingerprint_pr(
        client,
        repo,
        pr_number,
        authorized_logins=authorized_logins,
        allow_skip=True,
        skip_on_approval=skip_on_approval,
    )


def _no_poke(_pr_number: int) -> None:
    return None


def run(config: Config, *, entry: RepoEntry = BUILTIN_PYTORCH, optional: bool = True, **kwargs: Any) -> None:
    """``prepare`` then ``review_finish.finish``, inside one ExitStack; ``kwargs`` are ``prepare``'s keywords.

    ``optional=False`` runs only the safety work and raises its errors.
    """
    with contextlib.ExitStack() as stack:
        prepared = prepare(config, entry=entry, stack=stack, **kwargs)
        if prepared is not None:
            review_finish.finish(prepared, optional=optional)


def prepare(
    config: Config,
    *,
    entry: RepoEntry,
    stack: contextlib.ExitStack,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    force: bool = False,
    requester: str | None = None,
    allow_untrusted_author: bool = False,
    bot_login: str = "",
    build_github: BuildClient = github_client.build_client,
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
    label_prs: Callable[[verdict_labels.LabelPass], None] = verdict_labels.label_listed_prs,
    resolve_merge_rules: Callable[[], MergeRulesSnapshot],
    now: Callable[[], datetime] = _utcnow,
    memory: ScanMemory | None = None,
) -> PreparedScan | None:
    """Run ``entry``'s safety work; None when the scan stops early (a refused requester or ``--pr`` target).

    The clients, the Dr. CI poke pool and the fingerprint workers are closed and drained when ``stack``
    exits.
    """
    repo = entry.repo
    if entry.mode == "off":
        raise ValueError(f"{repo} is off: the review scan does not run for it")
    logger.info("reviewing evaluation-cohort PRs in %s", repo)
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
        return None
    client = build_github(token)
    stack.callback(github_client.close_client, client)
    target: Target | None = None
    if pr is not None:
        target = admit_target(
            client,
            pr,
            repo=repo,
            rules=snapshot.rules,
            get_pr=get_pr,
            allow_untrusted_author=allow_untrusted_author,
        )
        if target is None:
            return None
    logger.info("filtering fingerprint comments to %d merge-authorized login(s)", len(authorized_logins))
    window = timedelta(hours=config.review_window_hours)
    listed_at = now()
    full_tick = memory is None or memory.full_tick_due(listed_at)
    pr_numbers, updated_at_by_number, labels_by_number, authors_by_number, head_sha_by_number = candidate_numbers(
        client,
        repo=repo,
        pr=pr,
        authors=evaluable,
        fetch=fetch,
        cutoff=None if full_tick else listed_at - window,
        fetch_updated=fetch_updated,
    )
    states = read_state(repo, pr_numbers)
    evaluated_at = now()
    failed: list[int] = []
    # Owned here (not inside the helpers) so finish can read it back after the fan-out: a rate limit
    # trips it, which gates the dispatch phase. It reflects "the cancel event fired," which
    # is broader than a non-empty `abandoned` -- a rate limit on the last task leaves nothing to
    # cancel (abandoned stays empty) yet must still skip dispatch.
    cancel_event = threading.Event()
    authority = Authority(
        rules=snapshot.rules,
        authors=authors_by_number,
        recorded=states.keys(),
        target=target,
        forced_shadow=entry.mode == "shadow",
    )
    poke = _poke_submitter(entry, config, stack, poke_drci)
    excluded = revert_guard.exclude_reverted(
        client,
        pr_numbers,
        repo=repo,
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
        fingerprint_numbers = [number for number in recent if authority.eligible(number)]
        ineligible = [number for number in recent if not authority.eligible(number)]
        revoke_ineligible_approvals(
            client,
            ineligible,
            repo=repo,
            states=states,
            bot_login=bot_login,
            get_pr=get_pr,
            dismiss=dismiss_approvals,
            failed=failed,
            cancel_event=cancel_event,
        )
    else:
        fingerprint_numbers, recent, ineligible = pr_numbers, [], []
    return PreparedScan(
        entry=entry,
        stack=stack,
        client=client,
        token=token,
        build_github=build_github,
        pr=pr,
        max_dispatches=max_dispatches,
        ref=ref,
        force=force,
        bot_login=bot_login,
        timeout=timedelta(minutes=timeout_minutes),
        memory=memory,
        full_tick=full_tick,
        listed_at=listed_at,
        evaluated_at=evaluated_at,
        states=states,
        authority=authority,
        authorized_logins=authorized_logins,
        fingerprint_numbers=fingerprint_numbers,
        recent=recent,
        ineligible=ineligible,
        excluded=excluded,
        skip_on_approval=skip_on_approval,
        labels_by_number=labels_by_number,
        head_sha_by_number=head_sha_by_number,
        updated_at_by_number=updated_at_by_number,
        cancel_event=cancel_event,
        poke=poke,
        fingerprint=fingerprint,
        dispatch=dispatch,
        emit_dispatched=emit_dispatched,
        label_prs=label_prs,
        get_pr=get_pr,
        upsert_comment=upsert_comment,
        now=now,
        failed=failed,
    )


def _poke_submitter(
    entry: RepoEntry, config: Config, stack: contextlib.ExitStack, poke_drci: Callable[[str, int, Config], None]
) -> Callable[[int], None]:
    """The scan's Dr. CI poke for ``entry``: a no-op unless its status comment is Dr. CI's."""
    if entry.status_comment != "drci":
        return _no_poke
    # drci_poke's configured delay covers the verdict path's gap between writing the row to /tmp
    # and a later workflow step uploading it. Both emits have already PUT the object to S3
    # before returning, so the wait buys nothing here and one such sleep per PR would multiply
    # into the Lambda's function timeout.
    poke_config = dataclasses.replace(config, drci_poke_delay_seconds=0.0)
    # Entered on the ExitStack so the drain is __exit__-driven. AWS Lambda freezes the execution
    # environment the instant the handler returns, so an unjoined poke thread would not finish
    # here -- it would thaw and log its outcome inside some later invocation instead.
    poke_pool = stack.enter_context(
        ThreadPoolExecutor(max_workers=drci_poke.POKE_WORKERS, thread_name_prefix="greenlight-poke")
    )
    return drci_poke.poke_submitter(poke_pool, entry.repo, poke_drci, poke_config)
