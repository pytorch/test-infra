"""What the review scan carries from one listing tick to the next within a process.

A fresh process starts cold. It is read and written from the main thread only.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from greenlight.constants import FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE

if TYPE_CHECKING:
    from datetime import datetime


class ScanMemory:
    """When the last full listing tick that completed started.

    Times are the scan's naive-UTC wall clock: a monotonic clock may not advance while Lambda freezes
    the execution environment between invocations. A full tick is due when none has completed, or once
    ``FULL_TICK_INTERVAL`` less ``FULL_TICK_TOLERANCE`` has passed since the last one started; a clock
    that steps back past the start of the last full tick counts as due.
    """

    def __init__(self) -> None:
        self._last_full_tick_started: datetime | None = None

    def full_tick_due(self, now: datetime) -> bool:
        if self._last_full_tick_started is None:
            return True
        elapsed = now - self._last_full_tick_started
        return elapsed < timedelta(0) or elapsed >= FULL_TICK_INTERVAL - FULL_TICK_TOLERANCE

    def mark_full_tick(self, started_at: datetime) -> None:
        self._last_full_tick_started = started_at
