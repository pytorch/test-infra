"""Prune the listed PRs the review scan can safely leave alone this iteration.

Extracted from ``review`` so both modules stay within the per-file line limit. ``review.run``
lists the candidates and their labels; this module decides which of them are worth the cost of
a fingerprint, from the recency window, the ``Stale`` label, and the rollout dial.

Everything here takes PR numbers and returns PR numbers. Nothing in this module knows who wrote a
PR or whether its verdict carries authority -- that lives in ``cohort`` and must stay there, so
that sizing the experiment can never become a way of deciding one.
"""

from __future__ import annotations

import hashlib
import logging
from typing import TYPE_CHECKING

from greenlight.constants import TERMINAL_STATUSES

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from datetime import datetime, timedelta

    from greenlight.state import PRState

logger = logging.getLogger(__name__)

# Resolution of the dial: a rollout is rounded down to a multiple of 1/_ROLLOUT_BUCKETS.
_ROLLOUT_BUCKETS = 10_000


def _in_rollout(repo: str, pr_number: int, rollout: float) -> bool:
    """Whether ``pr_number`` sits in the ``rollout`` fraction of a stable, repo-scoped partition.

    sha256 rather than the builtin ``hash``, which is salted per process (PYTHONHASHSEED): the same
    PR would draw a different bucket on every Lambda invocation and flap in and out between scans.
    The key carries ``repo`` so the same number in a second target repo draws an independent bucket,
    and the raw number is hashed rather than taken modulo directly because PR numbers are dense and
    sequential, which biases a bare modulo. Buckets nest: raising the dial only ever adds PRs.
    """
    if rollout >= 1.0:
        return True
    if rollout <= 0.0:
        return False
    digest = hashlib.sha256(f"{repo}#{pr_number}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % _ROLLOUT_BUCKETS < rollout * _ROLLOUT_BUCKETS


def rollout_filter(pr_numbers: Sequence[int], exempt: frozenset[int], *, repo: str, rollout: float) -> list[int]:
    """Keep the ``rollout`` fraction of ``pr_numbers``, plus every number in ``exempt``.

    Applied to the fingerprint candidates and not to the listing, deliberately: the steps upstream
    of the fingerprint must keep seeing every listed PR. A held-out PR still has to reach the revert
    guard, or it silently loses both the revocation of an approval greenlight already granted and
    the ``REVERTED`` row that makes its exclusion outlive the label.
    """
    kept = [number for number in pr_numbers if number in exempt or _in_rollout(repo, number, rollout)]
    held = len(pr_numbers) - len(kept)
    if held:
        logger.info("rollout %g: holding %d of %d candidate(s) out of this scan", rollout, held, len(pr_numbers))
    return kept


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
