"""Pure dispatch decision for the greenlight scanner.

Given a PR's freshly computed ``eval_hash`` and the latest recorded state row, decide
whether to dispatch a review, skip it, or wait. The verdict keys on ``eval_hash``
equality (clock-free) except for the in-flight and retry age windows.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.constants import IN_FLIGHT_STATUSES, RETRY_STATUSES, TERMINAL_STATUSES

if TYPE_CHECKING:
    from datetime import datetime, timedelta


class Decision(enum.Enum):
    DISPATCH = enum.auto()
    SKIP = enum.auto()
    WAIT = enum.auto()


@dataclass(frozen=True)
class Outcome:
    action: Decision
    reason: str


def _aged_out(now: datetime, version: datetime | None, timeout: timedelta) -> bool:
    return version is None or now - version >= timeout


def decide(
    *,
    current_eval_hash: str,
    latest_status: str | None,
    latest_eval_hash: str | None,
    latest_version: datetime | None,
    now: datetime,
    timeout: timedelta,
) -> Outcome:
    if latest_status is None:
        return Outcome(Decision.DISPATCH, "never_reviewed")

    if latest_status in TERMINAL_STATUSES:
        if latest_eval_hash == current_eval_hash:
            return Outcome(Decision.SKIP, "decided")
        return Outcome(Decision.DISPATCH, "changed")

    if latest_status in IN_FLIGHT_STATUSES:
        if latest_eval_hash != current_eval_hash:
            return Outcome(Decision.DISPATCH, "changed")
        if _aged_out(now, latest_version, timeout):
            return Outcome(Decision.DISPATCH, "timed_out")
        return Outcome(Decision.WAIT, "in_flight")

    if latest_status in RETRY_STATUSES:
        if _aged_out(now, latest_version, timeout):
            return Outcome(Decision.DISPATCH, "retry")
        return Outcome(Decision.WAIT, "retry_backoff")

    return Outcome(Decision.DISPATCH, "unknown_status")
