"""A ``gate`` repo's approval-backing check from one run to the next (``approval_backing``), and its stored form.

``backing_form`` and ``backing_from_form`` are the ``backing`` part of the stored scan memory (``scan_memory``):
its own version (``BACKING_VERSION``), plain lists, times in ``pr_view``'s encoding and the sweep in
``drain_pass``'s. ``backing_from_form`` raises ``BackingVersionError`` on a form of another version, and
``ValueError`` (or ``KeyError``, ``TypeError``) on one that does not decode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from greenlight.approvals import payload_is, payload_mapping, payload_value
from greenlight.drain_pass import DrainPass, drain_pass_form, drain_pass_from_form
from greenlight.pr_view import required_time, time_form, time_from_form

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from datetime import datetime

BACKING_VERSION = 1
_WHAT = "a stored approval-backing"


class BackingVersionError(Exception):
    """A stored approval-backing memory of another version than ``BACKING_VERSION``."""


@dataclass(frozen=True, slots=True)
class BackingKey:
    """What an approval-backing read of a PR judged: its listed ``updated_at`` (naive UTC) and head and base, its
    latest non-shadow row's ``(status, run_id, version)`` (None: no row), and the gate rules' ``enforced`` (None:
    unknown)."""

    updated_at: datetime | None
    head_sha: str
    base_ref: str
    gate_row: tuple[str, int, datetime] | None
    rules_state: bool | None


@dataclass(slots=True)
class BackingMemory:
    """A ``gate`` repo's approval-backing check, kept in its stored scan memory.

    ``keys`` holds each open PR's key as of its last settled read; ``checked_at`` is when the check last ran, or
    None. ``waiting`` holds the PRs read again next run: their approval may yet be backed by a LAND row not
    ingested, the ledger or the rules could not be read to judge it, or the run's deadline left them unread.
    ``attempted`` maps each open PR a run tried to read, successfully or not, to the sequence number of its last
    attempt (``attempts`` is the last one given), which ``reading_order`` orders the changed and waiting PRs by.
    ``sweep`` is the sweep of every open PR under way, or None, and ``sweep_started_at`` opens its window;
    ``sweeps`` is the last sweep number given. ``decode_error`` says why the stored form did not decode, so
    this memory started cold, until the next backing report carries it.
    """

    keys: dict[int, BackingKey] = field(default_factory=dict)
    checked_at: datetime | None = None
    waiting: frozenset[int] = frozenset()
    attempted: dict[int, int] = field(default_factory=dict)
    attempts: int = 0
    sweep: DrainPass | None = None
    sweep_started_at: datetime | None = None
    sweeps: int = 0
    decode_error: str | None = None

    def start_sweep(self, started_at: datetime, *, recorded: frozenset[int]) -> DrainPass:
        self.sweeps += 1
        self.sweep = DrainPass(self.sweeps, recorded=recorded)
        self.sweep_started_at = started_at
        return self.sweep

    def end_sweep(self) -> None:
        self.sweep = None
        self.sweep_started_at = None

    def attempt(self, number: int) -> None:
        """Record a read attempt on ``number``, successful or not, as the latest."""
        self.attempts += 1
        self.attempted[number] = self.attempts

    def reading_order(self, numbers: Iterable[int]) -> list[int]:
        """``numbers`` never attempted first, in their order; then the attempted ones, the oldest attempt first, so
        a PR whose read keeps failing goes behind every PR not tried yet."""
        return sorted(numbers, key=lambda number: (number in self.attempted, self.attempted.get(number, 0)))


def _key_form(number: int, key: BackingKey) -> list[Any]:
    row = None if key.gate_row is None else [key.gate_row[0], key.gate_row[1], time_form(key.gate_row[2])]
    return [number, time_form(key.updated_at), key.head_sha, key.base_ref, row, key.rules_state]


def _key(form: Sequence[Any]) -> tuple[int, BackingKey]:
    number, updated_at, head_sha, base_ref, row, rules_state = form
    gate_row = None
    if row is not None:
        status, run_id, version = row
        gate_row = (
            payload_value(status, str, f"{_WHAT} row status"),
            payload_value(run_id, int, f"{_WHAT} row run id"),
            required_time(version),
        )
    key = BackingKey(
        updated_at=time_from_form(updated_at),
        head_sha=payload_value(head_sha, str, f"{_WHAT} head"),
        base_ref=payload_value(base_ref, str, f"{_WHAT} base"),
        gate_row=gate_row,
        rules_state=None if rules_state is None else payload_value(rules_state, bool, f"{_WHAT} rules answer"),
    )
    return payload_value(number, int, f"{_WHAT} PR number"), key


def backing_form(backing: BackingMemory) -> dict[str, Any]:
    return {
        "version": BACKING_VERSION,
        "keys": [_key_form(number, key) for number, key in sorted(backing.keys.items())],
        "checked_at": time_form(backing.checked_at),
        "waiting": sorted(backing.waiting),
        "attempted": sorted(backing.attempted.items()),
        "attempts": backing.attempts,
        "sweep": drain_pass_form(backing.sweep),
        "sweep_started_at": time_form(backing.sweep_started_at),
        "sweeps": backing.sweeps,
        "decode_error": backing.decode_error,
    }


def backing_from_form(form: object) -> BackingMemory:
    """The memory ``backing_form`` stored as ``form``; ``BackingVersionError`` when its version is not
    ``BACKING_VERSION``."""
    stored = payload_mapping(form, "the stored approval-backing memory")
    version = stored.get("version")
    if not payload_is(version, int) or version != BACKING_VERSION:
        raise BackingVersionError(f"stored approval-backing memory has version {version!r}, not {BACKING_VERSION}")
    sweep = drain_pass_from_form(stored["sweep"])
    started_at = time_from_form(stored["sweep_started_at"])
    if (sweep is None) != (started_at is None):
        raise ValueError("a stored sweep and its start must be stored together")
    note = stored["decode_error"]
    return BackingMemory(
        keys=dict(_key(row) for row in stored["keys"]),
        checked_at=time_from_form(stored["checked_at"]),
        waiting=frozenset(payload_value(number, int, f"{_WHAT} waiting PR") for number in stored["waiting"]),
        attempted={
            payload_value(number, int, f"{_WHAT} attempted PR"): payload_value(attempt, int, f"{_WHAT} attempt")
            for number, attempt in stored["attempted"]
        },
        attempts=payload_value(stored["attempts"], int, f"{_WHAT} attempt count"),
        sweep=sweep,
        sweep_started_at=started_at,
        sweeps=payload_value(stored["sweeps"], int, f"{_WHAT} sweep count"),
        decode_error=None if note is None else payload_value(note, str, f"{_WHAT} decode note"),
    )
