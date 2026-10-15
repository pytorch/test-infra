"""What the review scan carries from one listing tick to the next within a process.

A fresh process starts cold. It is read and written from the main thread only.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING

from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime

    from greenlight.scan_runner import FingerprintResult

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _Key:
    """What a fingerprint result was computed under: the PR as listed before its fetch, and the approvers."""

    updated_at: datetime
    head_sha: str
    approvers_digest: str


@dataclass(frozen=True, slots=True)
class _Entry:
    key: _Key
    result: FingerprintResult


class ScanMemory:
    """When the last full listing tick that completed started, and the fingerprint results to reuse.

    Times are the scan's naive-UTC wall clock: a monotonic clock may not advance while Lambda freezes
    the execution environment between invocations. A full tick is due when none has completed, or once
    ``FULL_TICK_INTERVAL`` less ``FULL_TICK_TOLERANCE`` has passed since the last one started; a clock
    that steps back past the start of the last full tick counts as due.
    """

    def __init__(self) -> None:
        self._last_full_tick_started: datetime | None = None
        self._fingerprints: dict[int, _Entry] = {}

    def full_tick_due(self, now: datetime) -> bool:
        if self._last_full_tick_started is None:
            return True
        elapsed = now - self._last_full_tick_started
        return elapsed < timedelta(0) or elapsed >= FULL_TICK_INTERVAL - FULL_TICK_TOLERANCE

    def mark_full_tick(self, started_at: datetime) -> None:
        self._last_full_tick_started = started_at


class FingerprintCache:
    """One listing tick's view of the fingerprint results its ``ScanMemory`` keeps.

    A full tick passes ``reuse=False`` and reads no kept result. ``authorized_logins`` is the set the
    tick's fingerprints filter comments by; ``updated_at`` and ``head_sha`` are the listing's, and
    ``now`` is the clock read after the listing. A result is reused only while the PR's listed
    ``updated_at`` and head and the approver set are those it was stored under. ``commit`` leaves the
    memory holding only the results this tick reused or ``store`` kept.
    """

    def __init__(
        self,
        memory: ScanMemory,
        *,
        reuse: bool,
        authorized_logins: frozenset[str],
        updated_at: Mapping[int, datetime | None],
        head_sha: Mapping[int, str | None],
        now: datetime,
    ) -> None:
        self._memory = memory
        self._previous = memory._fingerprints if reuse else {}
        self._digest = hashlib.sha256("\n".join(sorted(authorized_logins)).encode()).hexdigest()
        self._updated_at = updated_at
        self._head_sha = head_sha
        self._now = now
        self._kept: dict[int, _Entry] = {}
        self._reused = 0
        self._fetched = 0

    def lookup(self, number: int) -> FingerprintResult | None:
        entry = self._previous.get(number)
        if entry is None or entry.key != self._key(number):
            return None
        return entry.result

    def keep(self, number: int) -> None:
        """Carry a looked-up result into this tick: it settled its PR without a fingerprint."""
        self._kept[number] = self._previous[number]
        self._reused += 1

    def store(self, number: int, result: FingerprintResult) -> None:
        """Count a fresh result, and keep it once the PR's listed ``updated_at`` is ``FINGERPRINT_QUIET`` old.

        A fingerprint read at a head other than the listed one is never kept: after a push the next
        listing misses it anyway, and after a read that lagged the listing it would settle the listed
        head on an older head's hash.
        """
        self._fetched += 1
        key = self._key(number)
        if key is None or self._now - key.updated_at < FINGERPRINT_QUIET:
            return
        if isinstance(result, tuple) and result[0] != key.head_sha:
            return
        self._kept[number] = _Entry(key, result)

    def commit(self) -> None:
        self._memory._fingerprints = self._kept
        logger.info("fingerprints: %d reused from the cache, %d fetched fresh", self._reused, self._fetched)

    def _key(self, number: int) -> _Key | None:
        updated_at = self._updated_at.get(number)
        head_sha = self._head_sha.get(number)
        if updated_at is None or head_sha is None:
            return None
        return _Key(updated_at, head_sha, self._digest)
