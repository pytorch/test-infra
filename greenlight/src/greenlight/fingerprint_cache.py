"""One listing tick's view of the fingerprint results its ``ScanMemory`` keeps (``FingerprintCache``)."""

from __future__ import annotations

import hashlib
import logging
from datetime import timedelta
from types import MappingProxyType
from typing import TYPE_CHECKING

from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL
from greenlight.scan_memory import _Entry, _Key

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime

    from greenlight.change_feed import Marker
    from greenlight.scan_memory import ScanMemory
    from greenlight.scan_runner import FingerprintResult

    Markers = Mapping[int, tuple[Marker, datetime] | None]

logger = logging.getLogger(__name__)

_NO_MARKERS: Markers = MappingProxyType({})


class FingerprintCache:
    """One listing tick's view of the fingerprint results its ``ScanMemory`` keeps.

    A full tick passes ``reuse=False`` and reads no kept result. ``authorized_logins`` is the set the
    tick's fingerprints filter comments by; ``updated_at`` and ``head_sha`` are the listing's, and
    ``now`` is the clock read after the listing. A result is reused only while the PR's listed
    ``updated_at`` and head, the approver set and its marker are those it was stored under.
    ``markers`` holds each PR's last marker read and since when the scan has seen it
    (``pr_view.PRView.seen``), and is empty on a ``github`` repo. A PR in ``revalidate`` reuses no result
    stored ``FULL_TICK_INTERVAL`` or more before ``now``, however often ``keep`` carried it forward, nor
    one stored after ``now``, as a clock that stepped back makes a full tick due. ``commit`` leaves the
    memory holding only the results this tick reused or ``store`` kept; a ``partial`` commit (a stopped
    fan-out) also keeps the earlier results of the PRs the tick never looked up.
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
        self._looked_up: set[int] = set()
        self._reused = 0
        self._fetched = 0

    def lookup(self, number: int) -> FingerprintResult | None:
        self._looked_up.add(number)
        entry = self._previous.get(number)
        if entry is None or entry.key != self._key(number):
            return None
        age = self._now - entry.stored_at
        if number in self._revalidate and (age < timedelta(0) or age >= FULL_TICK_INTERVAL):
            return None
        return entry.result

    def keep(self, number: int) -> None:
        """Carry a looked-up result into this tick: it settled its PR without a fingerprint."""
        self._kept[number] = self._previous[number]
        self._reused += 1

    def store(self, number: int, result: FingerprintResult) -> None:
        """Count a fresh result, and keep it once the PR's listed ``updated_at`` is ``FINGERPRINT_QUIET`` old.

        A PR with a marker read is also kept only once the scan has seen that marker for
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

    def commit(self, *, partial: bool = False) -> None:
        untouched = (
            {number: entry for number, entry in self._previous.items() if number not in self._looked_up}
            if partial
            else {}
        )
        self._memory._fingerprints = untouched | self._kept
        logger.info("fingerprints: %d reused from the cache, %d fetched fresh", self._reused, self._fetched)

    def _key(self, number: int) -> _Key | None:
        updated_at = self._updated_at.get(number)
        head_sha = self._head_sha.get(number)
        if updated_at is None or head_sha is None:
            return None
        seen = self._markers.get(number)
        return _Key(updated_at, head_sha, self._digest, None if seen is None else seen[0])
