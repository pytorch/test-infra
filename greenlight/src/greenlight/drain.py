"""Drain a repo whose mode is ``off``: dismiss every live greenlight approval on its open PRs.

The scan dispatches nothing for an off repo and runs this instead, as its safety work. It does not
trust the ledger, since an approval can exist with no row (a lost upload, a cancelled record job).
Each tick lists every open PR, drafts and every author included, and works through the pass's
queue: first the PRs that had a ledger row when the pass started, where nearly every real approval
is, then every open PR by number, so a PR opened or recorded during the pass is still reached. It
reads greenlight's reviews on at most ``DRAIN_PRS_PER_TICK`` of them, from the listed PR objects (one
request each), dismissing every live approval through the loop the ineligible revoke uses, and
keeps a cursor in the repo's ``ScanMemory`` so the next tick resumes there. A pass ends when the
queue has been covered once. Within a pass a PR found clean is skipped while its listed
``updated_at`` is unchanged, and is remembered as clean only when that ``updated_at`` was at least
``FINGERPRINT_QUIET`` old at the clock read after the listing; a new pass forgets them.

"drain complete" is logged only after a whole pass that found no live approval and failed on no PR,
and that started once no ``WORKFLOW_FILE`` run on ``DISPATCH_REPO`` created before the scan first
saw the repo off was still unfinished. The runs do not say which repo they review, so every older
unfinished run counts, whatever its repo: no review dispatched while the repo was on can still
approve from its older checkout once the line is logged. Remove a repo's config file only after it.
Those runs are read with the dispatch token, since a token scoped to the drained repo cannot read them.
Once the drain is complete no new pass starts while the repo stays off: each later tick logs that
and reads nothing, until the repo leaves ``off`` (``ScanMemory.clear_drain``).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import github_client, state
from greenlight.constants import DISPATCH_REPO, DRAIN_PRS_PER_TICK, WORKFLOW_FILE
from greenlight.ineligible_approvals import dismiss_each
from greenlight.state import naive_utc

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


def _older_unfinished_runs(
    client: Github,
    *,
    token: str,
    runs_token: str,
    build_github: Callable[[str], Github],
    unfinished_runs: _RunsFn,
    off_since: datetime,
) -> int:
    """``unfinished_runs`` through ``client``, or through a client on ``runs_token`` when that is another token."""
    if runs_token == token:
        return unfinished_runs(client, off_since)
    runs_client = build_github(runs_token)
    try:
        return unfinished_runs(runs_client, off_since)
    finally:
        github_client.close_client(runs_client)


def _start_pass(memory: ScanMemory, older: int, recorded: frozenset[int]) -> DrainPass:
    blocker = (
        f"{older} {WORKFLOW_FILE} run(s) created before the repo went off were unfinished when the pass started"
        if older
        else None
    )
    return memory.start_drain_pass(blocker, recorded=recorded)


def drain(
    config: Config,
    *,
    repo: str,
    memory: ScanMemory,
    bot_login: str,
    build_github: Callable[[str], Github] = github_client.build_client,
    list_prs: Callable[[Github, str], Sequence[PullRequest]] = list_open_pulls,
    read_states: Callable[[str, Sequence[int]], dict[int, PRState]] = state.read_latest_states,
    unfinished_runs: _RunsFn = count_unfinished_review_runs,
    dismiss: Callable[..., list[int]] = github_client.dismiss_prior_greenlight_approvals,
    now: Callable[[], datetime] = _utcnow,
    cancel_event: threading.Event | None = None,
    dispatch_token: str | None = None,
) -> DrainReport:
    """Run one tick's slice of ``repo``'s drain. Listing and state-read failures raise; a PR's failure is reported.

    A rate limit on a PR sets ``cancel_event`` (a fresh event by default) and ends the slice, as does an
    event already set. The older review runs are read with ``dispatch_token`` (default the scan token).
    """
    if cancel_event is None:
        cancel_event = threading.Event()
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to drain a repo")
    runs_token = token if dispatch_token is None else dispatch_token
    off_since = memory.off_since(now())
    completed_by = memory.drain_completed_by()
    if completed_by is not None:
        logger.info("%s: drain complete (pass %d); nothing to do while the repo stays off", repo, completed_by)
        return DrainReport(completed_by, 0, 0, True, "", ())
    client = build_github(token)
    try:
        pulls = {pull.number: pull for pull in list_prs(client, repo)}
        listed_at = now()
        current = memory.drain_pass()
        if current is None:
            recorded = frozenset(read_states(repo, sorted(pulls)).keys())
            older = _older_unfinished_runs(
                client,
                token=token,
                runs_token=runs_token,
                build_github=build_github,
                unfinished_runs=unfinished_runs,
                off_since=off_since,
            )
            current = _start_pass(memory, older, recorded)
        queue = [(0, number) for number in sorted(current.recorded) if number in pulls]
        queue.extend((1, number) for number in sorted(pulls))
        failed: list[int] = []
        reached_end = _work(client, repo, current, queue, pulls, listed_at, bot_login, dismiss, failed, cancel_event)
    finally:
        github_client.close_client(client)
    return _report(memory, repo, current, reached_end=reached_end, failed=failed)


def _work(
    client: Github,
    repo: str,
    current: DrainPass,
    queue: Sequence[tuple[int, int]],
    pulls: dict[int, PullRequest],
    listed_at: datetime,
    bot_login: str,
    dismiss: Callable[..., list[int]],
    failed: list[int],
    cancel_event: threading.Event,
) -> bool:
    """Work the queue from the pass's cursor; True once the pass reached its end."""
    reads = 0
    for key in queue:
        if current.cursor is not None and key <= current.cursor:
            continue
        number = key[1]
        pull = pulls[number]
        updated_at = naive_utc(pull.updated_at) if pull.updated_at is not None else None
        if current.is_clean(number, updated_at):
            current.cursor = key
            continue
        if reads >= DRAIN_PRS_PER_TICK or cancel_event.is_set():
            return False
        reads += 1
        outcome = dismiss_each(
            client,
            [number],
            repo=repo,
            bot_login=bot_login,
            message=_OFF_MESSAGE,
            why=f"in {repo}, which is off",
            get_pr=_listed(pull),
            dismiss=dismiss,
            failed=failed,
            cancel_event=cancel_event,
        )
        current.cursor = key
        if number not in outcome:
            current.failures += 1
            continue
        current.checked += 1
        current.dismissed += outcome[number]
        if outcome[number] == 0:
            current.remember_clean(number, updated_at, listed_at)
    return not cancel_event.is_set()


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
        logger.info("%s: drain complete (pass %d, checked %d)", repo, current.number, current.checked)
    else:
        logger.info(
            "%s: pass %d, checked %d, dismissed %d, not complete: %s",
            repo,
            current.number,
            current.checked,
            current.dismissed,
            reason,
        )
    return DrainReport(current.number, current.checked, current.dismissed, complete, reason, tuple(failed))
