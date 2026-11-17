"""A ``clickhouse`` repo's view of its open PRs, which its ``ScanMemory`` carries from one tick to the next.

The records (``pr_listing.OpenPR``) come from GitHub listings only and are unfiltered: any author,
drafts included. A full listing replaces them (``rebuild``); the recent walk of open and closed PRs
updates the open ones it returns and removes the closed and merged ones (``apply``). ``listed_at`` is
the start of the last listing that updated the view, and the view is built once a full listing has.

Beside each PR the view keeps the last HUD ClickHouse marker (``change_feed.Marker``) the scan read
and since when this process has seen that value: the first reading of a PR, and any reading that
differs from the one kept, starts it at that tick's clock (``note``). ``candidates`` hands the scan
the records ``pr_listing.is_candidate`` admits, each with its effective ``updated_at``: the later of
the listed one and the marker's newest non-bot comment or ``pull_request`` event, so a PR whose place
in GitHub's updated order lagged still enters the review window. A record listed with no
``updated_at`` keeps none and is never out of the window, as ``candidate_filter`` treats it.

Main thread only; every time is the scan's naive-UTC wall clock.
"""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

from greenlight.pr_listing import is_candidate, lowered

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from datetime import datetime, timedelta

    from greenlight.change_feed import Marker
    from greenlight.pr_listing import OpenPR


class PRView:
    def __init__(self) -> None:
        self.records: dict[int, OpenPR] = {}
        self.listed_at: datetime | None = None
        self._markers: dict[int, tuple[Marker, datetime]] = {}
        self._read_alone: dict[int, datetime] = {}

    @property
    def built(self) -> bool:
        return self.listed_at is not None

    def rebuild(self, records: Iterable[OpenPR], listed_at: datetime) -> None:
        """Replace every record with a full listing's, forgetting the markers of the PRs it no longer holds."""
        self.records = {record.number: record for record in records}
        self._markers = {number: seen for number, seen in self._markers.items() if number in self.records}
        self._read_alone = {number: at for number, at in self._read_alone.items() if number in self.records}
        self.listed_at = listed_at

    def apply(self, records: Iterable[OpenPR], listed_at: datetime) -> None:
        """Take the recent walk: an open record replaces or adds its PR, a closed one removes it and its marker."""
        for record in records:
            if record.state == "open":
                self.records[record.number] = record
            else:
                self.records.pop(record.number, None)
                self._markers.pop(record.number, None)
                self._read_alone.pop(record.number, None)
        self.listed_at = listed_at

    def read_alone(self, number: int, pr_updated_at: datetime) -> None:
        """Record that the PR was read on its own while its marker's ``pull_request`` event was ``pr_updated_at``."""
        self._read_alone[number] = pr_updated_at

    def read_alone_at(self, number: int) -> datetime | None:
        """The marker's ``pull_request`` event the PR was last read on its own at, or None."""
        return self._read_alone.get(number)

    def note(self, markers: Mapping[int, Marker], now: datetime) -> set[int]:
        """Keep a reading taken at ``now``; return the PRs whose marker it changed."""
        changed: set[int] = set()
        for number, marker in markers.items():
            seen = self._markers.get(number)
            if seen is None or seen[0] != marker:
                self._markers[number] = (marker, now)
                changed.add(number)
        return changed

    def seen(self, number: int) -> tuple[Marker, datetime] | None:
        """The PR's last marker read and since when this process has seen it, or None when none was read."""
        return self._markers.get(number)

    def candidates(self, cohort: Iterable[str], *, now: datetime, window: timedelta | None) -> list[OpenPR]:
        """The records ``is_candidate`` admits, sorted by number, each carrying its effective ``updated_at``.

        With a ``window``, only those whose effective ``updated_at`` is less than ``window`` before ``now``.
        """
        admitted = lowered(cohort)
        picked: list[OpenPR] = []
        for number in sorted(self.records):
            record = self.records[number]
            if not is_candidate(record, admitted):
                continue
            record = self._effective(record)
            if window is not None and record.updated_at is not None and now - record.updated_at >= window:
                continue
            picked.append(record)
        return picked

    def _effective(self, record: OpenPR) -> OpenPR:
        seen = self._markers.get(record.number)
        newest = None if seen is None else seen[0].newest
        if record.updated_at is None or newest is None or newest <= record.updated_at:
            return record
        return dataclasses.replace(record, updated_at=newest)
