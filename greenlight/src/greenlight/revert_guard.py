"""Permanently exclude reverted pytorch/pytorch PRs from review.

A PR is excluded when it carries the ``Reverted`` label OR has ever recorded a ``REVERTED`` row.
The label can be taken off again, the row cannot, so the row is what makes the exclusion
permanent. Every scan re-runs the same steps for each excluded PR -- revoke greenlight's own
approval, record the row unless one already wins, poke Dr. CI if either changed anything -- and
then drops the PR before it is fingerprinted or dispatched. Re-running is not redundant: a review
already in flight when the revert landed can still post a LAND approval afterwards.

Exclusion and recording deliberately ask different questions of the table. Exclusion keys on a
``REVERTED`` row *existing*, which no later row can outrank -- that is what makes it permanent.
Recording keys on the *latest* row not being ``REVERTED``, because that row is the one Dr. CI
renders: a review that lands its verdict after the exclusion was recorded carries the real
``github.run_id`` and outranks it, and only re-recording puts the exclusion back on top.

Two invariants are load-bearing:

- The row is written whatever the dismissal returns. Recording cannot suppress a retry -- an
  excluded PR is dismissed again on every scan, before any recorded state is read -- whereas
  skipping the row after a failed dismissal loses the exclusion outright the moment the label
  comes off, leaving a candidate PR still carrying the approval nothing revoked.
- A missing row is never read as "no approval". The reviewer workflow posts its approving review a
  step before it uploads the row, so a lost upload, a cancelled job, or replication lag all leave a
  live approval with nothing recorded -- hence the dismissal is attempted whatever the state says.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import constants
from greenlight.constants import REVERTED_LABELS, STATUS_REVERTED, TARGET_REPO
from greenlight.github_client import is_rate_limit_error
from greenlight.guards import IterationTimeout
from greenlight.state import next_run_id

if TYPE_CHECKING:
    import threading
    from collections.abc import Callable, Mapping, Sequence

    from github import Github

    from greenlight.github_types import LabelClient, VerdictPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_DISMISS_MESSAGE = "This pull request was reverted; greenlight's approval no longer applies."


def fetch_pr_labels(client: LabelClient, repo: str, pr_number: int) -> tuple[str, ...]:
    """Read one PR's label names.

    The listing scan gets every PR's labels free from the open-PR payload; the ``--pr`` path has no
    listing, so its single PR is fetched here.
    """
    return tuple(label.name for label in client.get_repo(repo).get_pull(pr_number).labels)


def _carries_reverted_label(
    client: Github,
    number: int,
    known_labels: Mapping[int, Sequence[str]],
    fetch_labels: Callable[[Github, str, int], tuple[str, ...]],
) -> bool:
    labels = known_labels.get(number)
    if labels is None:
        labels = fetch_labels(client, TARGET_REPO, number)
    return constants.carries_any_label(labels, REVERTED_LABELS)


def _note_revoke_failure(number: int, exc: Exception, *, failed: list[int], cancel_event: threading.Event) -> None:
    if is_rate_limit_error(exc):
        cancel_event.set()
    logger.error("failed to revoke greenlight approval on reverted PR #%d: %s", number, exc, exc_info=True)
    failed.append(number)


def _revoke_and_record(
    client: Github,
    number: int,
    *,
    recorded_state: PRState | None,
    bot_login: str,
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    emit: Callable[..., None],
    poke: Callable[[int], None],
    failed: list[int],
    cancel_event: threading.Event,
) -> None:
    """Attempt to revoke greenlight's approval on one reverted PR, then record its row unless one wins.

    The row is stamped with ``state.next_run_id``, so Dr. CI -- which renders a PR's latest row --
    shows the exclusion. Writing whenever the latest row is not ``REVERTED`` is self-limiting: the
    row it writes then *is* the latest, so a settled exclusion writes nothing, and one outranked by
    a later verdict is rewritten exactly once.
    """
    try:
        pr = get_pr(client, TARGET_REPO, number)
    except IterationTimeout:
        raise
    except Exception as exc:
        # The only failure that costs the row: its ``head_sha`` is read off this PR.
        _note_revoke_failure(number, exc, failed=failed, cancel_event=cancel_event)
        return
    try:
        dismissed = dismiss(pr, bot_login=bot_login, message=_DISMISS_MESSAGE)
    except IterationTimeout:
        raise
    except Exception as exc:
        _note_revoke_failure(number, exc, failed=failed, cancel_event=cancel_event)
        dismissed = []
    if dismissed:
        logger.info("dismissed %d greenlight approval(s) on reverted PR #%d", len(dismissed), number)
    if recorded_state is not None and recorded_state.status == STATUS_REVERTED:
        # Dr. CI already renders this PR's REVERTED row, so a settled exclusion is worth a rebuild
        # only when an approval was actually revoked this pass.
        if dismissed:
            poke(number)
        return
    try:
        emit(
            repo=TARGET_REPO,
            pr_number=number,
            head_sha=pr.head.sha,
            run_id=next_run_id(recorded_state),
            shadow=False,
        )
    except IterationTimeout:
        raise
    except Exception as exc:
        logger.error("failed to record REVERTED for PR #%d: %s", number, exc, exc_info=True)
        failed.append(number)
        return
    logger.info("recorded REVERTED for PR #%d", number)
    poke(number)


def exclude_reverted(
    client: Github,
    pr_numbers: Sequence[int],
    *,
    known_labels: Mapping[int, Sequence[str]],
    states: Mapping[int, PRState],
    bot_login: str,
    read_reverted: Callable[[str, Sequence[int]], set[int]],
    fetch_labels: Callable[[Github, str, int], tuple[str, ...]],
    get_pr: Callable[[Github, str, int], VerdictPR],
    dismiss: Callable[..., list[int]],
    emit: Callable[..., None],
    poke: Callable[[int], None],
    failed: list[int],
    cancel_event: threading.Event,
) -> frozenset[int]:
    """Act on every reverted PR in ``pr_numbers`` and return the set the caller must drop.

    ``known_labels`` holds the labels the caller already has; a PR absent from it has its labels
    read from GitHub, which is how the ``--pr`` path (no listing, so no labels) is covered too. A
    per-PR failure is collected into ``failed`` so the scan still fails closed, and a rate limit
    additionally trips ``cancel_event`` so the fingerprint fan-out does not run on a throttled
    token. Either way the PR is still dropped -- an exclusion never lapses because a step failed.
    """
    recorded = read_reverted(TARGET_REPO, pr_numbers)
    excluded = [
        number
        for number in pr_numbers
        if number in recorded or _carries_reverted_label(client, number, known_labels, fetch_labels)
    ]
    if not excluded:
        return frozenset()
    # Dismissal matches greenlight's own reviews by login, so an empty or non-App login silently
    # dismisses nothing while reporting success -- every scan would then report a clean revocation
    # while the approval stays live on a reverted PR. Refuse the whole scan instead of writing
    # anything.
    if not constants.is_app_login(bot_login):
        raise ValueError(
            f"BOT_LOGIN must be the greenlight App login (<app-slug>{constants.BOT_LOGIN_SUFFIX}) to revoke "
            f"approvals on reverted PR(s) {excluded}; got {bot_login!r}"
        )
    logger.info("excluding %d reverted PR(s) from review: %s", len(excluded), excluded)
    for number in excluded:
        _revoke_and_record(
            client,
            number,
            recorded_state=states.get(number),
            bot_login=bot_login,
            get_pr=get_pr,
            dismiss=dismiss,
            emit=emit,
            poke=poke,
            failed=failed,
            cancel_event=cancel_event,
        )
    return frozenset(excluded)
