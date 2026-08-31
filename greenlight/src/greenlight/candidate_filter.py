"""Prune the listed PRs the review scan can safely leave alone this iteration.

Extracted from ``review`` so both modules stay within the per-file line limit. ``review.run``
lists the candidates and their labels; this module decides which of them are worth the cost of
a fingerprint, from the recency window and the ``Stale`` label.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from greenlight.constants import TERMINAL_STATUSES

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from datetime import datetime, timedelta

    from greenlight.state import PRState

logger = logging.getLogger(__name__)


def labeled_with(labels_by_number: Mapping[int, Sequence[str]], wanted: frozenset[str]) -> frozenset[int]:
    """Return the PR numbers carrying at least one of ``wanted``, matched exactly.

    GitHub label names are case-sensitive, and pytorch's stale bot tests ``Stale`` case-sensitively
    too, so a differently-cased label is a different label and must not prune anything.
    """
    return frozenset(number for number, labels in labels_by_number.items() if not wanted.isdisjoint(labels))


def _within_recency_window(updated_at: datetime | None, now: datetime, window: timedelta) -> bool:
    # A missing updated_at is never treated as stale: absence must not hide recent activity.
    if updated_at is None:
        return True
    return now - updated_at < window


def recency_filter(
    pr_numbers: Sequence[int],
    updated_at_by_number: dict[int, datetime | None],
    states: dict[int, PRState],
    stale_labeled_numbers: frozenset[int],
    *,
    now: datetime,
    window: timedelta,
) -> list[int]:
    """Drop PRs the scan can safely leave alone this iteration.

    A PR is kept when it was updated within ``window`` AND is not ``Stale``-labeled, OR its
    recorded state is non-terminal (in-flight or retry-eligible), so ``decide`` can still
    re-dispatch it on timeout/retry. A PR is skipped without fingerprinting when it is stale or
    ``Stale``-labeled and either terminal (its eval_hash cannot have changed) or never reviewed
    (an untouched PR is not worth a first review). The ``Stale`` label matters because the pytorch
    stale bot bumps ``updated_at`` when it applies the label, which would otherwise drag an
    abandoned never-reviewed PR back into the window.
    """
    kept: list[int] = []
    for number in pr_numbers:
        active = _within_recency_window(updated_at_by_number.get(number), now, window)
        stale_labeled = number in stale_labeled_numbers
        if active and not stale_labeled:
            kept.append(number)
            continue
        recorded = states.get(number)
        if recorded is not None and recorded.status not in TERMINAL_STATUSES:
            kept.append(number)
            continue
        detail = recorded.status if recorded is not None else "never reviewed"
        if stale_labeled:
            logger.info("skipping PR #%d: Stale label (%s)", number, detail)
        else:
            logger.info("skipping stale PR #%d: no recent activity (%s)", number, detail)
    return kept
