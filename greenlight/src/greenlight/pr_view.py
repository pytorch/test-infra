"""A ``clickhouse`` repo's view of its open PRs, which its ``ScanMemory`` carries from one tick to the next.

The records (``pr_listing.OpenPR``) come from GitHub listings only and hold the evaluation cohort's PRs,
drafts included. A full listing replaces them with its cohort authors' PRs and records the cohort's
digest (``rebuild``, ``cohort_digest``); the recent walk of open and closed PRs adds or replaces the open
ones a cohort author wrote and removes every PR it sees closed or merged, whoever wrote it (``apply``).
``listed_at`` is the start of the last listing that updated the view, and the view is built once a
listing has. A tick can use it only while its cohort has the digest the last full listing recorded
(``usable``), so a cohort change waits for the next full listing.

Beside each PR the view keeps the last HUD ClickHouse marker (``change_feed.Marker``) the scan read
and since when the scan has seen that value: the first reading of a PR, and any reading that
differs from the one kept, starts it at that tick's clock (``note``). ``candidates`` hands the scan
the records ``pr_listing.is_candidate`` admits, each with its effective ``updated_at``: the later of
the listed one and the marker's newest non-bot comment or ``pull_request`` event, so a PR whose place
in GitHub's updated order lagged still enters the review window. A record listed with no
``updated_at`` keeps none and is never out of the window, as ``candidate_filter`` treats it.

A PR whose marker shows a ``pull_request`` event its record lacks is read alone (``change_listing``).
The view keeps its read state: the marker time it is read at, the attempts at that time, the
view-wide sequence number of its last attempt, and whether that time is acknowledged
(``pending_reads``, ``record_read``). Markers and read states go with their PR's record.

``to_form`` and ``from_form`` are the view's part of the stored scan memory (``scan_memory``): plain
lists and ISO times. A record is stored without its title and URL; its ``base_accepted`` is derived on
restore from its stored branch names (``merge_authz.accepts_refs``), so a release that changes the rule
reaches every stored PR. ``scan_memory`` shares the time and marker encodings defined here.

Main thread only; every time is the scan's naive-UTC wall clock.
"""

from __future__ import annotations

import dataclasses
import hashlib
from datetime import datetime
from typing import TYPE_CHECKING, Any

from greenlight import merge_authz
from greenlight.change_feed import Marker
from greenlight.pr_listing import OpenPR, is_candidate, lowered

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from datetime import timedelta

READ_ALONE_MAX_ATTEMPTS = 5


def cohort_digest(cohort: Iterable[str]) -> str:
    """The sha256 hex digest of the cohort's lower-cased logins, sorted and joined by newlines."""
    return hashlib.sha256("\n".join(sorted(lowered(cohort))).encode()).hexdigest()


def time_form(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def time_from_form(form: object) -> datetime | None:
    return None if form is None else datetime.fromisoformat(str(form))


def required_time(form: object) -> datetime:
    """``time_from_form`` of a time the stored form must hold; ValueError when it holds none."""
    moment = time_from_form(form)
    if moment is None:
        raise ValueError("a stored time is missing")
    return moment


def marker_form(marker: Marker) -> list[Any]:
    return [
        time_form(marker.pr_updated_at),
        marker.reviews,
        marker.review_comments,
        marker.comments,
        time_form(marker.comment_updated_at),
    ]


def marker_from_form(form: Sequence[Any]) -> Marker:
    pr_updated_at, reviews, review_comments, comments, comment_updated_at = form
    return Marker(
        time_from_form(pr_updated_at),
        int(reviews),
        int(review_comments),
        int(comments),
        time_from_form(comment_updated_at),
    )


def _text(form: object) -> str | None:
    return None if form is None else str(form)


def _record_form(record: OpenPR) -> list[Any]:
    return [
        record.number,
        record.author,
        record.head_sha,
        time_form(record.updated_at),
        list(record.labels),
        record.draft,
        record.base_ref,
        record.head_ref,
        record.stack_trunk,
    ]


def _record(form: Sequence[Any], repo: str) -> OpenPR:
    number, author, head_sha, updated_at, labels, draft, base_ref, head_ref, stack_trunk = form
    base, head, trunk = _text(base_ref), _text(head_ref), _text(stack_trunk)
    return OpenPR(
        repo=repo,
        number=int(number),
        author=str(author),
        title="",
        url=f"https://github.com/{repo}/pull/{int(number)}",
        head_sha=_text(head_sha),
        updated_at=time_from_form(updated_at),
        base_accepted=None if base is None or head is None else merge_authz.accepts_refs(base, head, trunk),
        labels=tuple(str(label) for label in labels),
        draft=bool(draft),
        state="open",
        base_ref=base,
        head_ref=head,
        stack_trunk=trunk,
    )


@dataclasses.dataclass(slots=True)
class _ReadState:
    marker_time: datetime
    attempts: int = 0
    last_attempt: int = 0
    acknowledged: bool = False


class PRView:
    def __init__(self) -> None:
        self.records: dict[int, OpenPR] = {}
        self.listed_at: datetime | None = None
        self.digest: str | None = None
        self._markers: dict[int, tuple[Marker, datetime]] = {}
        self._reads: dict[int, _ReadState] = {}
        self._read_sequence = 0

    @property
    def built(self) -> bool:
        return self.listed_at is not None

    def usable(self, cohort: Iterable[str]) -> bool:
        """Whether a tick whose evaluation cohort is ``cohort`` can use the view: built, and fully listed for it."""
        return self.built and self.digest == cohort_digest(cohort)

    def rebuild(self, records: Iterable[OpenPR], listed_at: datetime, cohort: Iterable[str]) -> None:
        """Replace every record with a full listing's cohort PRs and record the cohort's digest.

        The markers and read states of the PRs it no longer holds are forgotten.
        """
        admitted = lowered(cohort)
        self.records = {record.number: record for record in records if record.author.lower() in admitted}
        self._markers = {number: seen for number, seen in self._markers.items() if number in self.records}
        self._reads = {number: state for number, state in self._reads.items() if number in self.records}
        self.listed_at = listed_at
        self.digest = cohort_digest(admitted)

    def apply(self, records: Iterable[OpenPR], listed_at: datetime, cohort: Iterable[str]) -> None:
        """Take the recent walk: an open record a cohort author wrote replaces or adds its PR; a closed one
        removes its PR, with its marker and read state, whoever wrote it."""
        admitted = lowered(cohort)
        for record in records:
            if record.state != "open":
                self.records.pop(record.number, None)
                self._markers.pop(record.number, None)
                self._reads.pop(record.number, None)
            elif record.author.lower() in admitted:
                self.records[record.number] = record
        self.listed_at = listed_at

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
        """The PR's last marker read and since when the scan has seen it, or None when none was read."""
        return self._markers.get(number)

    def pending_reads(self, stale: Mapping[int, datetime]) -> list[int]:
        """The PRs of ``stale`` (each mapped to the marker time its record lacks) still to read alone, in order.

        A PR acknowledged at that same time is left out. Those never attempted at that time come first,
        by number; then the ones attempted, the oldest last attempt first, so a PR whose read keeps
        failing goes behind every PR still awaiting its first read.
        """
        attempted = {
            number: state
            for number, marker_time in stale.items()
            if (state := self._reads.get(number)) is not None and state.marker_time == marker_time
        }

        def order(number: int) -> tuple[bool, int, int]:
            state = attempted.get(number)
            return state is not None, 0 if state is None else state.last_attempt, number

        pending = [number for number in stale if number not in attempted or not attempted[number].acknowledged]
        return sorted(pending, key=order)

    def record_read(self, number: int, marker_time: datetime, *, caught_up: bool) -> bool:
        """Count a read of PR ``number`` alone at ``marker_time``; True when that read gave the time up.

        A marker time other than the one kept starts the count afresh. The time is acknowledged when
        the read caught up, or, giving up, at its ``READ_ALONE_MAX_ATTEMPTS``-th attempt.
        """
        self._read_sequence += 1
        state = self._reads.get(number)
        if state is None or state.marker_time != marker_time:
            state = self._reads[number] = _ReadState(marker_time)
        state.attempts += 1
        state.last_attempt = self._read_sequence
        gave_up = not (caught_up or state.acknowledged) and state.attempts >= READ_ALONE_MAX_ATTEMPTS
        state.acknowledged = state.acknowledged or caught_up or gave_up
        return gave_up

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

    def to_form(self) -> dict[str, Any]:
        return {
            "listed_at": time_form(self.listed_at),
            "digest": self.digest,
            "records": [_record_form(self.records[number]) for number in sorted(self.records)],
            "markers": [
                [number, marker_form(marker), time_form(first_seen)]
                for number, (marker, first_seen) in sorted(self._markers.items())
            ],
            "reads": [
                [number, time_form(state.marker_time), state.attempts, state.last_attempt, state.acknowledged]
                for number, state in sorted(self._reads.items())
            ],
            "read_sequence": self._read_sequence,
        }

    @classmethod
    def from_form(cls, form: Mapping[str, Any], repo: str) -> PRView:
        """The view ``to_form`` stored, its records in ``repo``; raises on a form it does not hold."""
        view = cls()
        view.listed_at = time_from_form(form["listed_at"])
        view.digest = _text(form["digest"])
        view.records = {record.number: record for record in (_record(row, repo) for row in form["records"])}
        view._markers = {
            int(number): (marker_from_form(marker), required_time(first_seen))
            for number, marker, first_seen in form["markers"]
        }
        view._reads = {
            int(number): _ReadState(required_time(marker_time), int(attempts), int(last_attempt), bool(acknowledged))
            for number, marker_time, attempts, last_attempt, acknowledged in form["reads"]
        }
        view._read_sequence = int(form["read_sequence"])
        return view

    def _effective(self, record: OpenPR) -> OpenPR:
        seen = self._markers.get(record.number)
        newest = None if seen is None else seen[0].newest
        if record.updated_at is None or newest is None or newest <= record.updated_at:
            return record
        return dataclasses.replace(record, updated_at=newest)
