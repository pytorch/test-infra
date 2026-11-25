"""A ``gate`` repo's approval-backing check from one run to the next (``approval_backing``), and its stored form.

``backing_form`` and ``backing_from_form`` are the ``backing`` part of the stored scan memory (``scan_memory``):
its own version (``BACKING_VERSION``), plain lists, times in ``pr_view``'s encoding and the sweep in
``drain_pass``'s. ``backing_from_form`` raises ``ValueError`` (or ``KeyError``, ``TypeError``) on a form that
does not decode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from greenlight.approvals import payload_is
from greenlight.drain_pass import DrainPass, drain_pass_form, drain_pass_from_form
from greenlight.pr_view import required_time, time_form, time_from_form

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from datetime import datetime

BACKING_VERSION = 1


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
    ``sweep`` is the sweep of every open PR under way, or None, and ``sweep_started_at`` opens its window;
    ``sweeps`` is the last sweep number given. ``decode_error`` says why the stored form did not decode, so
    this memory started cold, until the next backing report carries it.
    """

    keys: dict[int, BackingKey] = field(default_factory=dict)
    checked_at: datetime | None = None
    waiting: frozenset[int] = frozenset()
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


def _typed[T](value: object, kind: type[T]) -> T:
    if not payload_is(value, kind):
        raise ValueError(f"a stored approval-backing value is not a {kind.__name__}: {value!r}")
    return value


def _optional[T](value: object, kind: type[T]) -> T | None:
    return None if value is None else _typed(value, kind)


def _key_form(number: int, key: BackingKey) -> list[Any]:
    row = None if key.gate_row is None else [key.gate_row[0], key.gate_row[1], time_form(key.gate_row[2])]
    return [number, time_form(key.updated_at), key.head_sha, key.base_ref, row, key.rules_state]


def _key(form: Sequence[Any]) -> tuple[int, BackingKey]:
    number, updated_at, head_sha, base_ref, row, rules_state = form
    gate_row = None
    if row is not None:
        status, run_id, version = row
        gate_row = (_typed(status, str), _typed(run_id, int), required_time(version))
    key = BackingKey(
        updated_at=time_from_form(updated_at),
        head_sha=_typed(head_sha, str),
        base_ref=_typed(base_ref, str),
        gate_row=gate_row,
        rules_state=_optional(rules_state, bool),
    )
    return _typed(number, int), key


def backing_form(backing: BackingMemory) -> dict[str, Any]:
    return {
        "version": BACKING_VERSION,
        "keys": [_key_form(number, key) for number, key in sorted(backing.keys.items())],
        "checked_at": time_form(backing.checked_at),
        "waiting": sorted(backing.waiting),
        "sweep": drain_pass_form(backing.sweep),
        "sweep_started_at": time_form(backing.sweep_started_at),
        "sweeps": backing.sweeps,
        "decode_error": backing.decode_error,
    }


def backing_from_form(form: Mapping[str, Any]) -> BackingMemory:
    """The memory ``backing_form`` stored as ``form``, of ``BACKING_VERSION``."""
    sweep = drain_pass_from_form(form["sweep"])
    started_at = time_from_form(form["sweep_started_at"])
    if (sweep is None) != (started_at is None):
        raise ValueError("a stored sweep and its start must be stored together")
    return BackingMemory(
        keys=dict(_key(row) for row in form["keys"]),
        checked_at=time_from_form(form["checked_at"]),
        waiting=frozenset(_typed(number, int) for number in form["waiting"]),
        sweep=sweep,
        sweep_started_at=started_at,
        sweeps=_typed(form["sweeps"], int),
        decode_error=_optional(form["decode_error"], str),
    )
