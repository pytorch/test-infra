"""The ``GL/*`` status labels greenlight puts on the PRs it reviews.

The ledger decides and the labels only display it: a ``GL/*`` label is read only to work out the
writes that bring a PR's labels to what its rows imply, never to decide anything. Those rows are the
PR's latest non-shadow row, the one pytorch's land gate reads, and its latest non-shadow LAND or
NO_LAND. A PR whose verdict is current carries that verdict's label (``GL/approved`` for a LAND,
``GL/human`` for a NO_LAND) until greenlight's stamp could no longer land it on its own and
greenlight will not review it again; from then on it carries ``GL/superseded`` alone. A reverted PR
also keeps the label of a verdict recorded on the PR's head when the scan recorded the ``REVERTED``
row.

``label_verdict`` gives a PR the label of a verdict just recorded on it, on the verdict's repo. Only ``TARGET_REPO``
PRs get the scan's supersede and restore: every listing tick that reaches its dispatch phase without a
rate limit relabels the PRs it listed that are reverted, kept by the recency filter or Stale-skipped
(``label_listed_prs``), restoring a removed label on any whose rows imply labels.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight import decision, state
from greenlight.candidate_filter import labeled_with
from greenlight.constants import (
    EXCLUDED_LABELS,
    GL_APPROVED_LABEL,
    GL_HUMAN_LABEL,
    GL_LABELS,
    GL_SUPERSEDED_LABEL,
    IN_FLIGHT_STATUSES,
    LABEL_PASS_DEADLINE,
    LABEL_PASS_MAX_FAILURES,
    REVERTED_LABELS,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
    TARGET_REPO,
    carries_any_label,
)
from greenlight.github_client import is_rate_limit_error
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
    from datetime import datetime, timedelta

    from greenlight.github_types import VerdictPR, _RelabelPR
    from greenlight.review_gate import ReviewSkip
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_VERDICT_LABELS: dict[str, str] = {STATUS_LAND: GL_APPROVED_LABEL, STATUS_NO_LAND: GL_HUMAN_LABEL}
_SUPERSEDED: frozenset[str] = frozenset({GL_SUPERSEDED_LABEL})
_LABEL_GONE = "Label does not exist"
_STATE_OPEN = "open"


def verdict_label(status: str) -> str:
    """The label of a LAND or NO_LAND verdict; any other status raises ``KeyError``."""
    return _VERDICT_LABELS[status]


def _folded(names: Iterable[str]) -> frozenset[str]:
    return frozenset(name.casefold() for name in names)


_GL_FOLDED = _folded(GL_LABELS)


def _ours(names: Iterable[str]) -> list[str]:
    return [name for name in names if name.casefold() in _GL_FOLDED]


def _same_commit(left: str, right: str) -> bool:
    return left.lower() == right.lower()


@dataclass(frozen=True, slots=True)
class LabelPass:
    """What the label pass reads from one listing tick.

    ``reverted`` holds the PRs the revert guard excluded, ``recent`` those the recency filter kept,
    and ``eligible`` and ``ineligible`` the ``recent`` PRs whose author is determined eligible or
    not; an undetermined PR is in neither. ``skips`` holds the PRs a human decided, and ``labels``
    and ``heads`` each listed PR's labels and head. An in-flight gate row counts as a review in
    progress for ``timeout``, and a PR is started only while ``clock()`` reads less than
    ``LABEL_PASS_DEADLINE`` after ``listed_at``.
    """

    fetch_pr: Callable[[int], _RelabelPR]
    reverted: Collection[int]
    recent: Collection[int]
    eligible: Collection[int]
    ineligible: Collection[int]
    skips: Sequence[tuple[int, ReviewSkip]]
    labels: Mapping[int, Sequence[str]]
    heads: Mapping[int, str | None]
    listed_at: datetime
    clock: Callable[[], datetime]
    timeout: timedelta


def desired_labels(
    gate: PRState | None,
    verdict: PRState | None,
    head: str | None,
    *,
    reverted: bool,
    eligible: bool,
    ineligible: bool,
    final: bool,
    now: datetime,
    timeout: timedelta,
) -> frozenset[str] | None:
    """The ``GL/*`` labels a listed PR must carry, or None to leave its labels as they are.

    ``gate`` is the PR's latest non-shadow row and ``verdict`` its latest non-shadow LAND or
    NO_LAND; ``head`` is its listed head. The verdict is current when it is the gate row and was
    recorded on that head, compared case-insensitively. ``final`` marks a PR greenlight will not
    review again: human-decided, author determined ineligible, or skipped for its ``Stale`` label. A
    reverted PR waits until its gate row is the ``REVERTED`` row, whose head is the PR's head when
    the scan recorded it.
    """
    if gate is None or verdict is None:
        return None
    if reverted:
        if gate.status != STATUS_REVERTED:
            return None
        if _same_commit(verdict.head_sha, gate.head_sha):
            return _SUPERSEDED | {verdict_label(verdict.status)}
        return _SUPERSEDED
    if gate == verdict and head is not None and _same_commit(verdict.head_sha, head):
        if ineligible:
            return _SUPERSEDED
        return frozenset({verdict_label(verdict.status)}) if eligible else None
    if gate.status in IN_FLIGHT_STATUSES and not decision._aged_out(now, gate.version, timeout):
        return None
    return _SUPERSEDED if final else None


def sync_labels(pr: _RelabelPR, desired: frozenset[str], *, number: int) -> None:
    """Make PR ``number``'s ``GL/*`` labels exactly ``desired``: remove the extras, then add the missing.

    The labels are read off ``pr`` itself and compared case-insensitively; when they already match,
    nothing is written. A label that is already gone when its removal arrives counts as removed.
    """
    current = _ours(label.name for label in pr.labels)
    wanted = _folded(desired)
    held = _folded(current)
    extra = [name for name in current if name.casefold() not in wanted]
    missing = sorted(name for name in desired if name.casefold() not in held)
    for name in extra:
        _remove(pr, name, number=number)
    if missing:
        pr.add_to_labels(*missing)
    if extra or missing:
        logger.info("PR #%d: greenlight labels %s -> %s", number, sorted(current), sorted(desired))


def _remove(pr: _RelabelPR, name: str, *, number: int) -> None:
    from github import GithubException

    try:
        pr.remove_from_labels(name)
    except GithubException as exc:
        if exc.status != 404 or not isinstance(exc.data, dict) or exc.data.get("message") != _LABEL_GONE:
            raise
        logger.info("PR #%d: %s was already removed", number, name)


def label_verdict(pr: VerdictPR, status: str, *, reviewed_head: str, number: int) -> None:
    """Give PR ``number`` the label of the authoritative ``status`` just recorded on it, and no other ``GL/*`` one.

    A closed PR keeps its labels, and one that has moved off ``reviewed_head`` or carries ``Reverted``
    is left to the scan. Never raises: the record job uploads the verdict's row only once the command
    succeeds, so a failure here is logged and swallowed rather than losing the row.
    """
    try:
        if pr.state != _STATE_OPEN:
            logger.info("PR #%d is %s; its labels stay as they are", number, pr.state)
            return
        if not _same_commit(pr.head.sha, reviewed_head):
            logger.info("PR #%d moved off the reviewed head %s; the scan labels it", number, reviewed_head)
            return
        if carries_any_label((label.name for label in pr.labels), REVERTED_LABELS):
            logger.info("PR #%d is reverted; the scan labels it", number)
            return
        sync_labels(pr, frozenset({verdict_label(status)}), number=number)
    except Exception as exc:
        logger.error("failed to label the %s verdict on PR #%d: %s", status, number, exc, exc_info=True)


def label_listed_prs(
    scan: LabelPass,
    *,
    read_gate_rows: Callable[
        [str, Sequence[int]], tuple[dict[int, PRState], dict[int, PRState]]
    ] = state.read_gate_rows,
) -> None:
    """Bring the ``GL/*`` labels of a tick's reverted, ``recent`` and Stale-skipped PRs in line with their rows.

    The rows are read in one query that is not guarded: like the scan's other reads, its failure
    fails the scan. The PRs go in number order; one is fetched only when its listed labels differ
    from the ones it must carry, none is started once the tick is ``LABEL_PASS_DEADLINE`` old, and
    one found closed keeps its labels. A failure on a PR is logged and, ``IterationTimeout`` aside,
    never fails the scan: a rate limit stops the pass, and so does a run of ``LABEL_PASS_MAX_FAILURES``
    other failures with no PR synced between them; a failure short of that moves it on to the next
    PR. As the order is fixed, PRs that keep failing stop the pass at the same place every tick.
    Every PR the pass does not reach waits for the next tick.
    """
    reverted = frozenset(scan.reverted)
    recent = frozenset(scan.recent)
    eligible = frozenset(scan.eligible)
    ineligible = frozenset(scan.ineligible)
    stale_skipped = labeled_with(scan.labels, EXCLUDED_LABELS) - recent - reverted
    final = frozenset(number for number, _ in scan.skips) | ineligible | stale_skipped
    candidates = sorted(reverted | recent | stale_skipped)
    if not candidates:
        return
    now = scan.clock()
    if now - scan.listed_at >= LABEL_PASS_DEADLINE:
        logger.info("label pass skipped: the tick is past its %s deadline", LABEL_PASS_DEADLINE)
        return
    gates, verdicts = read_gate_rows(TARGET_REPO, candidates)
    failures = 0
    for number in candidates:
        try:
            desired = desired_labels(
                gates.get(number),
                verdicts.get(number),
                scan.heads.get(number),
                reverted=number in reverted,
                eligible=number in eligible,
                ineligible=number in ineligible,
                final=number in final,
                now=now,
                timeout=scan.timeout,
            )
            if desired is None or _folded(_ours(scan.labels.get(number, ()))) == _folded(desired):
                continue
            if scan.clock() - scan.listed_at >= LABEL_PASS_DEADLINE:
                logger.info("label pass deadline reached at PR #%d; the rest wait for the next scan", number)
                return
            pr = scan.fetch_pr(number)
            if pr.state != _STATE_OPEN:
                logger.info("PR #%d is now %s; its labels stay as they are", number, pr.state)
                continue
            sync_labels(pr, desired, number=number)
            failures = 0
        except IterationTimeout:
            raise
        except Exception as exc:
            if is_rate_limit_error(exc):
                logger.error(
                    "label pass stopped at PR #%d by a rate limit; the rest wait for the next scan: %s",
                    number,
                    exc,
                    exc_info=True,
                )
                return
            logger.error("failed to relabel PR #%d: %s", number, exc, exc_info=True)
            failures += 1
            if failures >= LABEL_PASS_MAX_FAILURES:
                logger.error(
                    "label pass stopped at PR #%d after %d failures in a row; the rest wait for the next scan",
                    number,
                    failures,
                )
                return
