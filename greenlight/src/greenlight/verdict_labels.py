"""Deciding and syncing the ``GL/*`` status labels on a PR.

The ledger decides and the labels only display it: a ``GL/*`` label is read only to work out the
writes that bring a PR's labels to what its rows imply, never to decide anything. Those rows are the
PR's latest non-shadow row, the one pytorch's land gate reads, and its latest non-shadow LAND or
NO_LAND. ``desired_labels`` decides what they imply: a PR whose verdict is current must carry that
verdict's label (``GL/approved`` for a LAND, ``GL/human`` for a NO_LAND) until greenlight's stamp
could no longer land it on its own and greenlight will not review it again; from then on it must
carry ``GL/superseded`` alone. A reverted PR must also keep the label of a verdict recorded on the
PR's head when the scan recorded the ``REVERTED`` row. ``sync_labels`` makes the writes.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight import decision
from greenlight.constants import (
    GL_APPROVED_LABEL,
    GL_HUMAN_LABEL,
    GL_LABELS,
    GL_SUPERSEDED_LABEL,
    IN_FLIGHT_STATUSES,
    STATUS_LAND,
    STATUS_NO_LAND,
    STATUS_REVERTED,
)

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime, timedelta

    from greenlight.github_types import _RelabelPR
    from greenlight.state import PRState

logger = logging.getLogger(__name__)

_VERDICT_LABELS: dict[str, str] = {STATUS_LAND: GL_APPROVED_LABEL, STATUS_NO_LAND: GL_HUMAN_LABEL}
_SUPERSEDED: frozenset[str] = frozenset({GL_SUPERSEDED_LABEL})
_LABEL_GONE = "Label does not exist"


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
