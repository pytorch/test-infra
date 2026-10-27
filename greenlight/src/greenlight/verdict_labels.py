"""Syncing the ``GL/*`` status labels on a PR.

The ledger decides and the labels only display it: a ``GL/*`` label is read only to work out the
writes that bring a PR's labels to the set it must carry (``sync_labels``), never to decide anything.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight.constants import GL_LABELS

if TYPE_CHECKING:
    from collections.abc import Iterable

    from greenlight.github_types import _RelabelPR

logger = logging.getLogger(__name__)

_LABEL_GONE = "Label does not exist"


def _folded(names: Iterable[str]) -> frozenset[str]:
    return frozenset(name.casefold() for name in names)


_GL_FOLDED = _folded(GL_LABELS)


def _ours(names: Iterable[str]) -> list[str]:
    return [name for name in names if name.casefold() in _GL_FOLDED]


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
