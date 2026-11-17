"""Drain a repo whose mode is ``off``: dismiss every live greenlight approval on its open PRs.

The scan dispatches nothing for an off repo and runs this instead, as its safety work. It does not
trust the ledger, since an approval can exist with no row (a lost upload, a cancelled record job).
Each tick lists every open PR, drafts and every author included, and reads greenlight's reviews,
from the listed PR objects (one request each), on at most ``DRAIN_PRS_PER_TICK`` of the pass's
pending PRs, dismissing every live approval through the loop the ineligible revoke uses. A PR is
pending while it is open and the pass has not read it successfully (``DrainPass``). Each slice takes
first the PRs the pass has not tried yet, those that had a ledger row when the pass started (where
nearly every real approval is) before the rest, each by number; then those whose read failed, the
oldest attempt first, so failing PRs never starve the others. A failed read stays pending; the pass
ends once no open PR is pending, and the next pass starts over.

A PR read once is not read again in its pass, however often it is updated. That is safe: a pass
completes the drain only with no blocker, that is, it started once no review run older than the off
switch was unfinished, and an off repo is never dispatched and its record jobs read ``off``
(shadow), so no greenlight approval can appear on a PR after that pass read it. A PR opened or
reopened during the pass has not been read and is read before the pass ends. In a blocked pass, an
approval an older run posts after its PR was read is dismissed by the next pass, which reads every
PR again.

"drain complete" is logged only after a pass that found no live approval and failed on no PR, and
that started once no ``WORKFLOW_FILE`` run on ``DISPATCH_REPO`` created before the scan first saw the
repo off was still unfinished. The runs do not say which repo they review, so every older
unfinished run counts, whatever its repo: no review dispatched while the repo was on can still
approve from its older checkout once the line is logged. The scan Lambda drains a served repo whose
config file is removed as an off one (``config_cache``), but cannot drain a repo the GitHub App
installation no longer reaches: uninstall the App from a repo only after the line. Those runs are
read with the dispatch token, since a token scoped to the drained repo cannot read them;
without one, the pass that starts cannot complete the drain. Once the drain is complete no new pass
starts while the repo stays off: each later tick logs that and reads nothing, until the repo leaves
``off`` (``ScanMemory.clear_drain``).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import approvals, github_client, state
from greenlight.constants import DISPATCH_REPO, DRAIN_PRS_PER_TICK, WORKFLOW_FILE
from greenlight.ineligible_approvals import dismiss_each

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github
    from github.PullRequest import PullRequest

    from greenlight.config import Config
    from greenlight.github_types import VerdictPR
    from greenlight.scan_memory import DrainPass, ScanMemory
    from greenlight.state import PRState

    _RunsFn = Callable[[Github, datetime], int]

logger = logging.getLogger(__name__)

_OFF_MESSAGE = "GreenLight is off for this repository; greenlight's approval no longer applies."
_UNFINISHED_RUN_STATUSES = ("queued", "in_progress", "waiting", "pending", "requested")


@dataclass(frozen=True, slots=True)
class DrainReport:
    """One tick of the drain: the pass's totals so far, whether it completed the drain, and why not."""

    pass_number: int
    checked: int
    dismissed: int
    complete: bool
    reason: str
    failed: tuple[int, ...]


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def list_open_pulls(client: Github, repo: str) -> list[PullRequest]:
    """Every open PR of ``repo``, drafts and every author included, as the listing returned them."""
    return list(client.get_repo(repo).get_pulls(state="open"))


def count_unfinished_review_runs(client: Github, before: datetime) -> int:
    """How many review workflow runs created before ``before`` (naive UTC) are not finished."""
    workflow = client.get_repo(DISPATCH_REPO).get_workflow(WORKFLOW_FILE)
    created = f"<{before:%Y-%m-%dT%H:%M:%S}+00:00"
    return sum(workflow.get_runs(status=status, created=created).totalCount for status in _UNFINISHED_RUN_STATUSES)


def _listed(pull: PullRequest) -> Callable[[Github, str, int], VerdictPR]:
    """A ``get_pr`` that returns the PR the listing already holds, so its reviews cost one request."""

    def get_pr(_client: Github, _repo: str, _number: int) -> VerdictPR:
        return pull

    return get_pr


def _blocker(
    client: Github,
    *,
    token: str,
    dispatch_token: str | None,
    build_github: Callable[[str], Github],
    unfinished_runs: _RunsFn,
    off_since: datetime,
) -> str | None:
    """Why a pass starting now cannot complete the drain, or None: review runs older than the off switch."""
    if dispatch_token is None:
        return "the review runs could not be read: there is no dispatch token"
    with github_client.dispatch_client(client, token, dispatch_token, build_github) as runs_client:
        older = unfinished_runs(runs_client, off_since)
    if not older:
        return None
    return f"{older} {WORKFLOW_FILE} run(s) created before the repo went off were unfinished when the pass started"


def drain(
    config: Config,
    *,
    repo: str,
    memory: ScanMemory,
    bot_login: str,
    dispatch_token: str | None,
    build_github: Callable[[str], Github] = github_client.build_client,
    list_prs: Callable[[Github, str], Sequence[PullRequest]] = list_open_pulls,
    read_states: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    unfinished_runs: _RunsFn = count_unfinished_review_runs,
    dismiss: Callable[..., list[int]] = approvals.dismiss_prior_greenlight_approvals,
    now: Callable[[], datetime] = _utcnow,
    cancel_event: threading.Event | None = None,
) -> DrainReport:
    """Run one tick's slice of ``repo``'s drain. Listing and state-read failures raise; a PR's failure is reported.

    A rate limit on a PR sets ``cancel_event`` (a fresh event by default) and ends the slice, as does an
    event already set. The older review runs are read with ``dispatch_token``; None cannot read them.
    """
    if cancel_event is None:
        cancel_event = threading.Event()
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to drain a repo")
    off_since = memory.off_since(now())
    completed_by = memory.drain_completed_by()
    if completed_by is not None:
        logger.info("%s: drain complete (pass %d); nothing to do while the repo stays off", repo, completed_by)
        return DrainReport(completed_by, 0, 0, True, "", ())
    client = build_github(token)
    try:
        pulls = {pull.number: pull for pull in list_prs(client, repo)}
        current = memory.drain_pass()
        if current is None:
            recorded = frozenset(read_states(repo, sorted(pulls)).keys())
            blocker = _blocker(
                client,
                token=token,
                dispatch_token=dispatch_token,
                build_github=build_github,
                unfinished_runs=unfinished_runs,
                off_since=off_since,
            )
            current = memory.start_drain_pass(blocker, recorded=recorded)
        failed: list[int] = []
        reached_end = _work(client, repo, current, pulls, bot_login, dismiss, failed, cancel_event)
    finally:
        github_client.close_client(client)
    return _report(memory, repo, current, reached_end=reached_end, failed=failed)


def _work(
    client: Github,
    repo: str,
    current: DrainPass,
    pulls: dict[int, PullRequest],
    bot_login: str,
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> bool:
    """Read at most ``DRAIN_PRS_PER_TICK`` of the pass's pending PRs, in its order; True once none is pending."""
    for number in current.pending(pulls)[:DRAIN_PRS_PER_TICK]:
        if cancel_event.is_set():
            break
        current.attempt(number)
        outcome = dismiss_each(
            client,
            [number],
            repo=repo,
            bot_login=bot_login,
            message=_OFF_MESSAGE,
            why=f"in {repo}, which is off",
            get_pr=_listed(pulls[number]),
            dismiss=dismiss,
            failed=failed,
            cancel_event=cancel_event,
        )
        if number not in outcome:
            current.failures += 1
            continue
        current.dismissed += outcome[number]
        current.checked.add(number)
    return not cancel_event.is_set() and not current.pending(pulls)


def _report(memory: ScanMemory, repo: str, current: DrainPass, *, reached_end: bool, failed: list[int]) -> DrainReport:
    if not reached_end:
        reason = "the pass continues next tick"
    elif current.blocker is not None:
        reason = current.blocker
    elif current.dismissed:
        reason = f"the pass dismissed {current.dismissed} approval(s)"
    elif current.failures:
        reason = f"the pass failed on {current.failures} PR(s)"
    else:
        reason = ""
    complete = reached_end and not reason
    if reached_end:
        memory.end_drain_pass()
    if complete:
        memory.complete_drain(current.number)
        logger.info("%s: drain complete (pass %d, checked %d)", repo, current.number, len(current.checked))
    else:
        logger.info(
            "%s: pass %d, checked %d, dismissed %d, not complete: %s",
            repo,
            current.number,
            len(current.checked),
            current.dismissed,
            reason,
        )
    return DrainReport(current.number, len(current.checked), current.dismissed, complete, reason, tuple(failed))
