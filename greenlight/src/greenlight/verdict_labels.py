"""Deciding and syncing the ``GL/*`` status labels on a PR.

The ledger decides and the labels only display it: a ``GL/*`` label is read only to work out the
writes that bring a PR's labels to what its rows imply, never to decide anything. Those rows are the
PR's latest non-shadow row, the one pytorch's land gate reads, and its latest non-shadow LAND or
NO_LAND. ``desired_labels`` decides what they imply: a PR whose verdict is current must carry that
verdict's label (``GL/approved`` for a LAND, ``GL/human`` for a NO_LAND) until greenlight's stamp
could no longer land it on its own and greenlight will not review it again; from then on it must
carry ``GL/superseded`` alone. A reverted PR must also keep the label of a verdict recorded on the
PR's head when the scan recorded the ``REVERTED`` row. ``sync_labels`` makes the writes.

A listing tick's label pass (``label_listed_prs``) relabels the ``TARGET_REPO`` PRs the tick listed
that are reverted, kept by the recency filter or Stale-skipped, restoring a removed label on any
whose rows imply labels.
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
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
    TARGET_REPO,
)
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
    from datetime import datetime, timedelta

    from greenlight.github_types import _RelabelPR
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
    progress for ``timeout``, measured against ``clock()``.
    """

    fetch_pr: Callable[[int], _RelabelPR]
    reverted: Collection[int]
    recent: Collection[int]
    eligible: Collection[int]
    ineligible: Collection[int]
    skips: Sequence[tuple[int, ReviewSkip]]
    labels: Mapping[int, Sequence[str]]
    heads: Mapping[int, str | None]
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


def label_listed_prs(
    scan: LabelPass,
    *,
    read_gate_rows: Callable[
        [str, Sequence[int]], tuple[dict[int, PRState], dict[int, PRState]]
    ] = state.read_gate_rows,
) -> None:
    """Bring the ``GL/*`` labels of a tick's reverted, ``recent`` and Stale-skipped PRs in line with their rows.

    The rows are read in one query that is not guarded, so a failure to read them
    propagates. The PRs go in number order; one is fetched only when its listed labels differ
    from the ones it must carry, and one found closed keeps its labels. A failure on a PR is logged
    and, ``IterationTimeout`` aside, never propagates: the pass moves on to the next PR.
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
    gates, verdicts = read_gate_rows(TARGET_REPO, candidates)
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
            pr = scan.fetch_pr(number)
            if pr.state != _STATE_OPEN:
                logger.info("PR #%d is now %s; its labels stay as they are", number, pr.state)
                continue
            sync_labels(pr, desired, number=number)
        except IterationTimeout:
            raise
        except Exception as exc:
            logger.error("failed to relabel PR #%d: %s", number, exc, exc_info=True)
