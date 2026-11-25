"""What the scan carries for one repo from one tick to the next, and its stored form.

It is read and written from the main thread only. ``encode_memory`` and ``decode_memory`` are the form
the state store keeps between invocations (``state_store``): versioned JSON, zlib-compressed, the
approvers digest of the fingerprint results stored once, times and markers in ``pr_view``'s encodings.
A form over ``MEMORY_MAX_BYTES`` is saved without its fingerprint results, and, still over, without its
view of the open PRs too, each logged as an error. A blob of the previous version is read forward
without a view; one of another version, or one that does not decode, starts the repo cold.
``save_memory`` saves it with whether its drain is complete, for the CLI's scan and the scan Lambda's
(``leased_run``) alike. ``fingerprint_cache.FingerprintCache`` is a tick's view of the fingerprint
results.
"""

from __future__ import annotations

import json
import logging
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from greenlight.constants import FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE, MEMORY_MAX_BYTES
from greenlight.pr_view import PRView, marker_form, marker_from_form, required_time, time_form, time_from_form
from greenlight.review_gate import ReviewSkip

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from greenlight.change_feed import Marker
    from greenlight.scan_runner import FingerprintResult
    from greenlight.state_store import StateStore

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
    ``clickhouse`` repo whose view is usable and whose HUD reading is fresh. A wide tick is due only once
    the view is built, when no full or wide tick has completed or once ``FULL_TICK_INTERVAL`` less the
    tolerance has passed since the later of the last two to start, a full tick counting as a wide one. A
    clock that steps back past the start it counts from makes either due.
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
        self._drain_completed_by: int | None = None

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
        self._drain_completed_by = None

    def drain_pass(self) -> DrainPass | None:
        return self._drain_pass

    def start_drain_pass(self, blocker: str | None, *, recorded: frozenset[int] = frozenset()) -> DrainPass:
        self._drain_passes += 1
        self._drain_pass = DrainPass(self._drain_passes, blocker, recorded)
        return self._drain_pass

    def end_drain_pass(self) -> None:
        self._drain_pass = None

    def drain_completed_by(self) -> int | None:
        """The pass that completed the drain while the repo stayed off, or None."""
        return self._drain_completed_by

    def complete_drain(self, pass_number: int) -> None:
        self._drain_completed_by = pass_number


def _due(now: datetime, since: datetime | None, interval: timedelta) -> bool:
    if since is None:
        return True
    elapsed = now - since
    return elapsed < timedelta(0) or elapsed >= interval - FULL_TICK_TOLERANCE


MEMORY_VERSION = 3
_FORWARD_VERSION = 2
_FORWARD_STORED_AT = datetime(1970, 1, 1)


def _result_form(result: FingerprintResult) -> dict[str, list[str]]:
    if isinstance(result, ReviewSkip):
        return {"skip": [result.reason, result.detail]}
    return {"hash": [result[0], result[1]]}


def _result(form: Mapping[str, list[str]]) -> FingerprintResult:
    if "skip" in form:
        reason, detail = form["skip"]
        return ReviewSkip(str(reason), str(detail))
    head_sha, eval_hash = form["hash"]
    return str(head_sha), str(eval_hash)


def _drain_form(current: DrainPass | None) -> dict[str, Any] | None:
    if current is None:
        return None
    return {
        "number": current.number,
        "blocker": current.blocker,
        "recorded": sorted(current.recorded),
        "checked": sorted(current.checked),
        "attempted": sorted(current.attempted.items()),
        "attempts": current.attempts,
        "dismissed": current.dismissed,
        "failures": current.failures,
    }


def _drain(form: Mapping[str, Any] | None) -> DrainPass | None:
    if form is None:
        return None
    return DrainPass(
        int(form["number"]),
        form["blocker"],
        recorded=frozenset(int(number) for number in form["recorded"]),
        checked={int(number) for number in form["checked"]},
        attempted={int(number): int(attempt) for number, attempt in form["attempted"]},
        attempts=int(form["attempts"]),
        dismissed=int(form["dismissed"]),
        failures=int(form["failures"]),
    )


def _form(memory: ScanMemory, *, fingerprints: bool, view: bool) -> dict[str, Any]:
    digests: list[str] = []
    rows: list[list[Any]] = []
    for number, entry in sorted(memory._fingerprints.items()) if fingerprints else ():
        key = entry.key
        if key.approvers_digest not in digests:
            digests.append(key.approvers_digest)
        rows.append(
            [
                number,
                time_form(key.updated_at),
                key.head_sha,
                digests.index(key.approvers_digest),
                _result_form(entry.result),
                None if key.marker is None else marker_form(key.marker),
                time_form(entry.stored_at),
            ]
        )
    return {
        "version": MEMORY_VERSION,
        "last_full_tick_started": time_form(memory._last_full_tick_started),
        "last_wide_tick_started": time_form(memory._last_wide_tick_started),
        "full_tick_interval": memory.full_tick_interval.total_seconds(),
        "digests": digests,
        "fingerprints": rows,
        "view": memory.view.to_form() if view else None,
        "off_since": time_form(memory._off_since),
        "drain_passes": memory._drain_passes,
        "drain_pass": _drain_form(memory._drain_pass),
        "drain_completed_by": memory._drain_completed_by,
    }


def _compress(form: dict[str, Any]) -> bytes:
    return zlib.compress(json.dumps(form, separators=(",", ":")).encode())


def encode_memory(memory: ScanMemory, repo: str) -> bytes:
    """``memory``'s stored form; without its fingerprint results, then also without its view, while over
    ``MEMORY_MAX_BYTES``. A form still over the cap without both is returned as it is."""
    blob = _compress(_form(memory, fingerprints=True, view=True))
    if len(blob) <= MEMORY_MAX_BYTES:
        return blob
    logger.error(
        "%s: its scan memory is %d bytes, over %d; saved without its %d fingerprint result(s)",
        repo,
        len(blob),
        MEMORY_MAX_BYTES,
        len(memory._fingerprints),
    )
    blob = _compress(_form(memory, fingerprints=False, view=True))
    if len(blob) <= MEMORY_MAX_BYTES:
        return blob
    smaller = _compress(_form(memory, fingerprints=False, view=False))
    logger.error(
        "%s: its scan memory is still %d bytes without its fingerprint results, over %d; saved without its "
        "view of %d PR(s) too, in %d bytes",
        repo,
        len(blob),
        MEMORY_MAX_BYTES,
        len(memory.view.records),
        len(smaller),
    )
    return smaller


def save_memory(
    store: StateStore, repo: str, memory: ScanMemory, *, owner: str | None, now: float, tick: str | None
) -> None:
    """Save ``memory`` as ``repo``'s, with whether its drain is complete (``StateStore.save_memory``, which
    raises ``StoreError``)."""
    completed = memory.drain_completed_by() is not None
    store.save_memory(repo, encode_memory(memory, repo), owner=owner, now=now, tick=tick, drain_complete=completed)


def _fingerprint(row: Sequence[Any], digests: Sequence[str], version: int) -> tuple[int, _Entry]:
    """A stored fingerprint row's PR and entry. A row of the previous version holds no marker and no time
    it was stored at: its marker is None, and it dates from the epoch, so a LAND revalidation counts it as
    old."""
    if version == MEMORY_VERSION:
        number, updated_at, head_sha, digest, result, marker, stored_at = row
        key_marker = None if marker is None else marker_from_form(marker)
        stored = required_time(stored_at)
    else:
        number, updated_at, head_sha, digest, result = row
        key_marker, stored = None, _FORWARD_STORED_AT
    key = _Key(required_time(updated_at), str(head_sha), digests[int(digest)], key_marker)
    return int(number), _Entry(key, _result(result), stored)


def _restore(form: Mapping[str, Any], repo: str, version: int) -> ScanMemory:
    memory = ScanMemory()
    memory._last_full_tick_started = time_from_form(form["last_full_tick_started"])
    digests = [str(digest) for digest in form["digests"]]
    for row in form["fingerprints"]:
        number, entry = _fingerprint(row, digests, version)
        memory._fingerprints[number] = entry
    memory._off_since = time_from_form(form["off_since"])
    memory._drain_passes = int(form["drain_passes"])
    memory._drain_pass = _drain(form["drain_pass"])
    completed_by = form["drain_completed_by"]
    memory._drain_completed_by = None if completed_by is None else int(completed_by)
    if version == MEMORY_VERSION:
        memory._last_wide_tick_started = time_from_form(form["last_wide_tick_started"])
        memory.full_tick_interval = timedelta(seconds=float(form["full_tick_interval"]))
        view = form["view"]
        if view is not None:
            memory.view = PRView.from_form(view, repo)
    return memory


def decode_memory(blob: bytes | None, repo: str) -> ScanMemory:
    """The memory ``encode_memory`` stored as ``blob``, a previous version's read forward without a view;
    a cold one for None, another version or a bad blob."""
    if blob is None:
        return ScanMemory()
    try:
        form = json.loads(zlib.decompress(blob))
        version = form.get("version") if isinstance(form, dict) else None
        if version not in (MEMORY_VERSION, _FORWARD_VERSION):
            logger.warning(
                "%s: stored scan memory has version %r, not %d; starting cold", repo, version, MEMORY_VERSION
            )
            return ScanMemory()
        return _restore(form, repo, version)
    except Exception:
        logger.error("%s: cannot decode its stored scan memory; starting cold", repo, exc_info=True)
        return ScanMemory()
