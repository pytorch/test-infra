"""What the scan carries for one repo from one tick to the next within a process.

A fresh process starts cold. It is read and written from the main thread only.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal

from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE
from greenlight.pr_view import PRView

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from datetime import datetime

    from greenlight.change_feed import Marker
    from greenlight.scan_runner import FingerprintResult

    Markers = Mapping[int, tuple[Marker, datetime] | None]

logger = logging.getLogger(__name__)

# A clickhouse repo's event tick is a fast one.
TickKind = Literal["full", "wide", "fast"]


@dataclass(frozen=True, slots=True)
class _Key:
    """What a fingerprint result was computed under: the PR as listed before its fetch, the approvers, and
    the PR's HUD ClickHouse marker as last read (None on a ``github`` repo)."""

    updated_at: datetime
    head_sha: str
    approvers_digest: str
    marker: Marker | None


@dataclass(frozen=True, slots=True)
class _Entry:
    key: _Key
    result: FingerprintResult
    stored_at: datetime


_NO_MARKERS: Markers = MappingProxyType({})


@dataclass(slots=True)
class DrainPass:
    """One pass of the ``off`` drain over a repo's open PRs (``drain``, which says why it is safe).

    ``recorded`` holds the PRs that had a ledger row when the pass started. ``checked`` holds the PRs
    the pass read successfully; a PR is pending while it is open and not there, so a later update to
    a checked PR does not make it pending again, while one opened or reopened during the pass is.
    ``attempted`` maps each PR the pass tried to read, successfully or not, to the sequence number of
    its last attempt (``attempts`` is the last one given), which ``pending`` orders failed PRs by.
    ``blocker`` says why the pass cannot complete the drain even if it finds nothing (review runs older
    than the off switch were unfinished, or could not be read, when it started), or is None.
    ``dismissed`` and ``failures`` are the pass's totals so far.
    """

    number: int
    started_at: datetime
    blocker: str | None
    recorded: frozenset[int] = frozenset()
    checked: set[int] = field(default_factory=set)
    attempted: dict[int, int] = field(default_factory=dict)
    attempts: int = 0
    dismissed: int = 0
    failures: int = 0

    def pending(self, open_prs: Iterable[int]) -> list[int]:
        """The open PRs not checked yet, in reading order.

        Never attempted first, those in ``recorded`` before the rest, each by number; then the ones
        attempted already, the oldest attempt first, so a PR whose read keeps failing goes behind
        every PR still awaiting its first read.
        """
        return sorted(
            (number for number in open_prs if number not in self.checked),
            key=lambda number: (
                number in self.attempted,
                self.attempted.get(number, 0),
                number not in self.recorded,
                number,
            ),
        )

    def attempt(self, number: int) -> None:
        """Record a read attempt on ``number``, successful or not, as the pass's latest."""
        self.attempts += 1
        self.attempted[number] = self.attempts


class ScanMemory:
    """When the last full and wide listing ticks that completed started, the fingerprint results to reuse,
    a ``clickhouse`` repo's view of its open PRs (``view``), and the drain: when the process first saw
    the repo off, and the pass under way (``DrainPass``: the PRs it checked and its read attempts), which
    ends when no open PR is pending.

    Times are the scan's naive-UTC wall clock: a monotonic clock may not advance while Lambda freezes
    the execution environment between invocations. A full tick (the sweep) is due when none has
    completed, or once ``full_tick_interval`` less ``FULL_TICK_TOLERANCE`` has passed since the last one
    started; ``change_listing`` sets that interval every tick, ``FULL_TICK_INTERVAL`` but on a
    ``clickhouse`` repo whose HUD reading is fresh. A wide tick is due only once the view is built, when
    no full or wide tick has completed or once ``FULL_TICK_INTERVAL`` less the tolerance has passed since
    the later of the last two to start, a full tick counting as a wide one. A clock that steps back past
    the start it counts from makes either due.
    """

    def __init__(self) -> None:
        self._last_full_tick_started: datetime | None = None
        self._last_wide_tick_started: datetime | None = None
        self.full_tick_interval = FULL_TICK_INTERVAL
        self.view = PRView()
        self._fingerprints: dict[int, _Entry] = {}
        self._off_since: datetime | None = None
        self._drain_passes = 0
        self._drain_pass: DrainPass | None = None

    def sweep_due(self, now: datetime) -> bool:
        return _due(now, self._last_full_tick_started, self.full_tick_interval)

    def wide_due(self, now: datetime) -> bool:
        if not self.view.built:
            return False
        marks = [mark for mark in (self._last_full_tick_started, self._last_wide_tick_started) if mark is not None]
        return _due(now, max(marks, default=None), FULL_TICK_INTERVAL)

    def full_tick_due(self, now: datetime) -> bool:
        """Whether this tick is a full or a wide one: either must complete."""
        return self.sweep_due(now) or self.wide_due(now)

    def mark_full_tick(self, started_at: datetime) -> None:
        self._last_full_tick_started = started_at

    def mark_wide_tick(self, started_at: datetime) -> None:
        self._last_wide_tick_started = started_at

    def off_since(self, now: datetime) -> datetime:
        """When this process first saw the repo off, recording ``now`` the first time."""
        if self._off_since is None:
            self._off_since = now
        return self._off_since

    def clear_drain(self) -> None:
        """Forget the drain: the repo is not off, so a later switch to off starts over."""
        self._off_since = None
        self._drain_pass = None

    def drain_pass(self) -> DrainPass | None:
        return self._drain_pass

    def start_drain_pass(
        self, started_at: datetime, blocker: str | None, *, recorded: frozenset[int] = frozenset()
    ) -> DrainPass:
        self._drain_passes += 1
        self._drain_pass = DrainPass(self._drain_passes, started_at, blocker, recorded)
        return self._drain_pass

    def end_drain_pass(self) -> None:
        self._drain_pass = None


def _due(now: datetime, since: datetime | None, interval: timedelta) -> bool:
    if since is None:
        return True
    elapsed = now - since
    return elapsed < timedelta(0) or elapsed >= interval - FULL_TICK_TOLERANCE


class FingerprintCache:
    """One listing tick's view of the fingerprint results its ``ScanMemory`` keeps.

    A full tick passes ``reuse=False`` and reads no kept result. ``authorized_logins`` is the set the
    tick's fingerprints filter comments by; ``updated_at`` and ``head_sha`` are the listing's, and
    ``now`` is the clock read after the listing. A result is reused only while the PR's listed
    ``updated_at`` and head, the approver set and its marker are those it was stored under.
    ``markers`` holds each PR's last marker read and since when the process has seen it
    (``pr_view.PRView.seen``), and is empty on a ``github`` repo. A PR in ``revalidate`` reuses no result
    stored ``FULL_TICK_INTERVAL`` or more before ``now``, however often ``keep`` carried it forward.
    ``commit`` leaves the memory holding only the results this tick reused or ``store`` kept.
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
        markers: Markers = _NO_MARKERS,
        revalidate: frozenset[int] = frozenset(),
    ) -> None:
        self._memory = memory
        self._previous = memory._fingerprints if reuse else {}
        self._digest = hashlib.sha256("\n".join(sorted(authorized_logins)).encode()).hexdigest()
        self._updated_at = updated_at
        self._head_sha = head_sha
        self._now = now
        self._markers = markers
        self._revalidate = revalidate
        self._kept: dict[int, _Entry] = {}
        self._reused = 0
        self._fetched = 0

    def lookup(self, number: int) -> FingerprintResult | None:
        entry = self._previous.get(number)
        if entry is None or entry.key != self._key(number):
            return None
        if number in self._revalidate and self._now - entry.stored_at >= FULL_TICK_INTERVAL:
            return None
        return entry.result

    def keep(self, number: int) -> None:
        """Carry a looked-up result into this tick: it settled its PR without a fingerprint."""
        self._kept[number] = self._previous[number]
        self._reused += 1

    def store(self, number: int, result: FingerprintResult) -> None:
        """Count a fresh result, and keep it once the PR's listed ``updated_at`` is ``FINGERPRINT_QUIET`` old.

        A PR with a marker read is also kept only once the process has seen that marker for
        ``FINGERPRINT_QUIET``, so a fetch that lagged an event HUD already shows is never kept; one with
        none is kept under the marker None, and the first tick that reads one misses it. A fingerprint
        read at a head other than the listed one is never kept: after a push the next listing misses it
        anyway, and after a read that lagged the listing it would settle the listed head on an older
        head's hash.
        """
        self._fetched += 1
        key = self._key(number)
        if key is None or self._now - key.updated_at < FINGERPRINT_QUIET:
            return
        seen = self._markers.get(number)
        if seen is not None and self._now - seen[1] < FINGERPRINT_QUIET:
            return
        if isinstance(result, tuple) and result[0] != key.head_sha:
            return
        self._kept[number] = _Entry(key, result, self._now)

    def commit(self) -> None:
        self._memory._fingerprints = self._kept
        logger.info("fingerprints: %d reused from the cache, %d fetched fresh", self._reused, self._fetched)

    def _key(self, number: int) -> _Key | None:
        updated_at = self._updated_at.get(number)
        head_sha = self._head_sha.get(number)
        if updated_at is None or head_sha is None:
            return None
        seen = self._markers.get(number)
        return _Key(updated_at, head_sha, self._digest, None if seen is None else seen[0])
