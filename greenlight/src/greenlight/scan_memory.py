"""What the scan carries for one repo from one tick to the next, and its stored form.

It is read and written from the main thread only. ``encode_memory`` and ``decode_memory`` are the form
the state store keeps between invocations (``state_store``): versioned JSON, zlib-compressed, the
approvers digest of the fingerprint results stored once, times and markers in ``pr_view``'s encodings.
A form over ``MEMORY_MAX_BYTES`` is saved without its fingerprint results, and, still over, without its
view of the open PRs too, each logged as an error; a ``gate`` repo's approval-backing memory
(``backing_memory``), the check's progress, is never dropped. A blob of the previous version is read forward
without a view; one of another version, or one that does not decode, starts the repo cold. The backing
memory is an optional part with its own version: missing or of another version, it starts cold alone; one
that does not decode starts cold alone too, logged, and noted for the next backing report.
``save_memory`` saves it with whether its drain is complete, for the CLI's scan and the scan Lambda's
(``leased_run``) alike. ``fingerprint_cache.FingerprintCache`` is a tick's view of the fingerprint
results.
"""

from __future__ import annotations

import json
import logging
import zlib
from datetime import datetime, timedelta
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal

from greenlight.backing_memory import BackingMemory, BackingVersionError, backing_form, backing_from_form
from greenlight.constants import FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE, MEMORY_MAX_BYTES
from greenlight.drain_pass import DrainPass, drain_pass_form, drain_pass_from_form
from greenlight.fingerprint_cache import Entry, Key
from greenlight.pr_view import PRView, marker_form, marker_from_form, required_time, time_form, time_from_form
from greenlight.review_gate import ReviewSkip

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from greenlight.scan_runner import FingerprintResult
    from greenlight.state_store import StateStore

logger = logging.getLogger(__name__)

# A clickhouse repo's event tick is a fast one.
TickKind = Literal["full", "wide", "fast"]


class ScanMemory:
    """When the last full and wide listing ticks that completed started, the fingerprint results to reuse,
    a ``clickhouse`` repo's view of its open PRs (``view``), the drain: when the process first saw the
    repo off, and the pass under way (``DrainPass``: the PRs it checked and its read attempts), which
    ends when no open PR is pending, and a ``gate`` repo's approval-backing check (``backing``), which
    ``clear_drain`` never touches and ``clear_backing`` starts cold.

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
        self._fingerprints: dict[int, Entry] = {}
        self._off_since: datetime | None = None
        self._drain_passes = 0
        self._drain_pass: DrainPass | None = None
        self._drain_completed_by: int | None = None
        self.backing = BackingMemory()

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

    @property
    def fingerprints(self) -> Mapping[int, Entry]:
        """The fingerprint results kept, by PR, read-only; ``replace_fingerprints`` sets them."""
        return MappingProxyType(self._fingerprints)

    def replace_fingerprints(self, entries: Mapping[int, Entry]) -> None:
        self._fingerprints = dict(entries)

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

    def clear_backing(self) -> None:
        """Forget the approval-backing check: the repo does not back approvals, so a later switch on starts cold."""
        self.backing = BackingMemory()

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
        "drain_pass": drain_pass_form(memory._drain_pass),
        "drain_completed_by": memory._drain_completed_by,
        **({} if memory.backing == BackingMemory() else {"backing": backing_form(memory.backing)}),
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


def _fingerprint(row: Sequence[Any], digests: Sequence[str], version: int) -> tuple[int, Entry]:
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
    key = Key(required_time(updated_at), str(head_sha), digests[int(digest)], key_marker)
    return int(number), Entry(key, _result(result), stored)


def _restore(form: Mapping[str, Any], repo: str, version: int) -> ScanMemory:
    memory = ScanMemory()
    memory._last_full_tick_started = time_from_form(form["last_full_tick_started"])
    digests = [str(digest) for digest in form["digests"]]
    for row in form["fingerprints"]:
        number, entry = _fingerprint(row, digests, version)
        memory._fingerprints[number] = entry
    memory._off_since = time_from_form(form["off_since"])
    memory._drain_passes = int(form["drain_passes"])
    memory._drain_pass = drain_pass_from_form(form["drain_pass"])
    completed_by = form["drain_completed_by"]
    memory._drain_completed_by = None if completed_by is None else int(completed_by)
    if version == MEMORY_VERSION:
        memory._last_wide_tick_started = time_from_form(form["last_wide_tick_started"])
        memory.full_tick_interval = timedelta(seconds=float(form["full_tick_interval"]))
        view = form["view"]
        if view is not None:
            memory.view = PRView.from_form(view, repo)
    memory.backing = _backing(form.get("backing"), repo)
    return memory


def _backing(form: object, repo: str) -> BackingMemory:
    """The stored approval-backing memory; a cold one for none or another version, or, noted in it, for a form
    that does not decode."""
    if form is None:
        return BackingMemory()
    try:
        return backing_from_form(form)
    except BackingVersionError as exc:
        logger.warning("%s: %s; starting it cold", repo, exc)
        return BackingMemory()
    except Exception as exc:
        logger.error("%s: cannot decode its stored approval-backing memory; starting it cold", repo, exc_info=True)
        return BackingMemory(
            decode_error=f"its stored approval-backing memory did not decode ({exc!r}); it started cold"
        )


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
