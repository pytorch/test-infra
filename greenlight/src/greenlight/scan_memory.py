"""What the scan carries for one repo from one tick to the next, and its stored form.

It is read and written from the main thread only. ``encode_memory`` and ``decode_memory`` are the form
the state store keeps between invocations (``state_store``): versioned JSON, zlib-compressed, the
approvers digest of the fingerprint results stored once. A form over ``MEMORY_MAX_BYTES`` is saved without
its fingerprint results, logged as an error; a blob of another version, or one that does not decode,
starts the repo cold. ``save_memory`` saves it with whether its drain is complete, for the CLI's scan and
the scan Lambda's (``leased_run``) alike.
"""

from __future__ import annotations

import hashlib
import json
import logging
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from greenlight.constants import FINGERPRINT_QUIET, FULL_TICK_INTERVAL, FULL_TICK_TOLERANCE, MEMORY_MAX_BYTES
from greenlight.review_gate import ReviewSkip

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from greenlight.scan_runner import FingerprintResult
    from greenlight.state_store import StateStore

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
    """When the last full listing tick that completed started, the fingerprint results to reuse, and the drain:
    when the process first saw the repo off, and the pass under way (``DrainPass``: the PRs it checked
    and its read attempts), which ends when no open PR is pending.

    Times are the scan's naive-UTC wall clock: a monotonic clock may not advance while Lambda freezes
    the execution environment between invocations. A full tick is due when none has completed, or once
    ``FULL_TICK_INTERVAL`` less ``FULL_TICK_TOLERANCE`` has passed since the last one started; a clock
    that steps back past the start of the last full tick counts as due.
    """

    def __init__(self) -> None:
        self._last_full_tick_started: datetime | None = None
        self._fingerprints: dict[int, _Entry] = {}
        self._off_since: datetime | None = None
        self._drain_passes = 0
        self._drain_pass: DrainPass | None = None
        self._drain_completed_by: int | None = None

    def full_tick_due(self, now: datetime) -> bool:
        if self._last_full_tick_started is None:
            return True
        elapsed = now - self._last_full_tick_started
        return elapsed < timedelta(0) or elapsed >= FULL_TICK_INTERVAL - FULL_TICK_TOLERANCE

    def mark_full_tick(self, started_at: datetime) -> None:
        self._last_full_tick_started = started_at

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


MEMORY_VERSION = 2


def _time(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _parse_time(value: object) -> datetime | None:
    return None if value is None else datetime.fromisoformat(str(value))


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


def _form(memory: ScanMemory, *, fingerprints: bool) -> dict[str, Any]:
    digests: list[str] = []
    rows: list[list[Any]] = []
    for number, entry in sorted(memory._fingerprints.items()) if fingerprints else ():
        key = entry.key
        if key.approvers_digest not in digests:
            digests.append(key.approvers_digest)
        digest = digests.index(key.approvers_digest)
        rows.append([number, key.updated_at.isoformat(), key.head_sha, digest, _result_form(entry.result)])
    return {
        "version": MEMORY_VERSION,
        "last_full_tick_started": _time(memory._last_full_tick_started),
        "digests": digests,
        "fingerprints": rows,
        "off_since": _time(memory._off_since),
        "drain_passes": memory._drain_passes,
        "drain_pass": _drain_form(memory._drain_pass),
        "drain_completed_by": memory._drain_completed_by,
    }


def _compress(form: dict[str, Any]) -> bytes:
    return zlib.compress(json.dumps(form, separators=(",", ":")).encode())


def encode_memory(memory: ScanMemory, repo: str) -> bytes:
    """``memory``'s stored form; without its fingerprint results when it would pass ``MEMORY_MAX_BYTES``."""
    blob = _compress(_form(memory, fingerprints=True))
    if len(blob) > MEMORY_MAX_BYTES:
        logger.error(
            "%s: its scan memory is %d bytes, over %d; saved without its %d fingerprint result(s)",
            repo,
            len(blob),
            MEMORY_MAX_BYTES,
            len(memory._fingerprints),
        )
        blob = _compress(_form(memory, fingerprints=False))
    return blob


def save_memory(
    store: StateStore, repo: str, memory: ScanMemory, *, owner: str | None, now: float, tick: str | None
) -> None:
    """Save ``memory`` as ``repo``'s, with whether its drain is complete (``StateStore.save_memory``, which
    raises ``StoreError``)."""
    completed = memory.drain_completed_by() is not None
    store.save_memory(repo, encode_memory(memory, repo), owner=owner, now=now, tick=tick, drain_complete=completed)


def _restore(form: Mapping[str, Any]) -> ScanMemory:
    memory = ScanMemory()
    memory._last_full_tick_started = _parse_time(form["last_full_tick_started"])
    digests = [str(digest) for digest in form["digests"]]
    for number, updated_at, head_sha, digest, result in form["fingerprints"]:
        key = _Key(cast("datetime", _parse_time(updated_at)), str(head_sha), digests[int(digest)])
        memory._fingerprints[int(number)] = _Entry(key, _result(result))
    memory._off_since = _parse_time(form["off_since"])
    memory._drain_passes = int(form["drain_passes"])
    memory._drain_pass = _drain(form["drain_pass"])
    completed_by = form["drain_completed_by"]
    memory._drain_completed_by = None if completed_by is None else int(completed_by)
    return memory


def decode_memory(blob: bytes | None, repo: str) -> ScanMemory:
    """The memory ``encode_memory`` stored as ``blob``; a cold one for None, another version or a bad blob."""
    if blob is None:
        return ScanMemory()
    try:
        form = json.loads(zlib.decompress(blob))
        version = form.get("version") if isinstance(form, dict) else None
        if version != MEMORY_VERSION:
            logger.warning(
                "%s: stored scan memory has version %r, not %d; starting cold", repo, version, MEMORY_VERSION
            )
            return ScanMemory()
        return _restore(form)
    except Exception:
        logger.error("%s: cannot decode its stored scan memory; starting cold", repo, exc_info=True)
        return ScanMemory()
