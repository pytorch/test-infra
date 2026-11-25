"""A gate repo's approval-backing memory (``backing_memory``): its sweeps and its stored form."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any

import pytest

from greenlight.backing_memory import (
    BACKING_VERSION,
    BackingKey,
    BackingMemory,
    BackingVersionError,
    backing_form,
    backing_from_form,
)

_STARTED = datetime(2026, 11, 17, 12, 0, 0)
_ROW_TIME = datetime(2026, 11, 17, 11, 58, 30, 123456)


def test_backing_sweeps_are_numbered_and_carry_their_start_and_recorded_prs():
    backing = BackingMemory()

    first = backing.start_sweep(_STARTED, recorded=frozenset({4}))
    assert backing.sweep is first
    assert (first.number, backing.sweep_started_at, first.blocker, first.recorded) == (
        1,
        _STARTED,
        None,
        frozenset({4}),
    )
    later = _STARTED + timedelta(minutes=16)
    second = backing.start_sweep(later, recorded=frozenset())
    assert (second.number, backing.sweep_started_at, backing.sweep) == (2, later, second)


def test_ending_a_sweep_forgets_it_and_its_start_but_keeps_the_count():
    backing = BackingMemory()
    backing.start_sweep(_STARTED, recorded=frozenset())

    backing.end_sweep()

    assert (backing.sweep, backing.sweep_started_at, backing.sweeps) == (None, None, 1)


def test_the_reading_order_puts_prs_never_attempted_first_then_the_oldest_attempt_first():
    backing = BackingMemory()
    for number in (4, 9, 2, 4):
        backing.attempt(number)

    assert (backing.attempted, backing.attempts) == ({4: 4, 9: 2, 2: 3}, 4)
    assert backing.reading_order([4, 9, 7, 2, 1]) == [7, 1, 9, 2, 4]


def _full() -> BackingMemory:
    backing = BackingMemory(
        keys={
            3: BackingKey(_STARTED - timedelta(minutes=9), "a" * 40, "main", ("LAND", 12, _ROW_TIME), True),
            5: BackingKey(None, "b" * 40, "release/2.9", None, None),
            8: BackingKey(_STARTED, "c" * 40, "main", ("AI_REVIEW_STARTED", 3, _ROW_TIME), False),
        },
        checked_at=_STARTED,
        waiting=frozenset({8, 5}),
        sweeps=6,
        decode_error="its stored approval-backing memory did not decode (KeyError('sweep')); it started cold",
    )
    for number in (8, 3, 8):
        backing.attempt(number)
    sweep = backing.start_sweep(_STARTED - timedelta(minutes=6), recorded=frozenset({3, 8}))
    sweep.attempt(3)
    sweep.attempt(9)
    sweep.checked.add(3)
    return backing


def test_the_codec_round_trips_every_field_of_every_key_none_values_included():
    backing = _full()

    restored = backing_from_form(json.loads(json.dumps(backing_form(backing))))

    assert restored == backing
    assert restored.keys[3].gate_row == ("LAND", 12, _ROW_TIME)
    assert (restored.keys[5].updated_at, restored.keys[5].gate_row, restored.keys[5].rules_state) == (None, None, None)
    assert restored.keys[8].rules_state is False
    assert (restored.attempted, restored.attempts) == ({3: 2, 8: 3}, 3)
    assert restored.sweep is not None
    assert (restored.sweep.number, restored.sweep.attempted, restored.sweep.checked) == (7, {3: 1, 9: 2}, {3})


def test_a_cold_memory_round_trips_cold():
    assert backing_from_form(json.loads(json.dumps(backing_form(BackingMemory())))) == BackingMemory()


def test_the_stored_form_is_versioned_plain_lists_and_iso_times():
    form = backing_form(_full())

    assert form["version"] == BACKING_VERSION == 1
    assert form["keys"] == [
        [3, (_STARTED - timedelta(minutes=9)).isoformat(), "a" * 40, "main", ["LAND", 12, _ROW_TIME.isoformat()], True],
        [5, None, "b" * 40, "release/2.9", None, None],
        [8, _STARTED.isoformat(), "c" * 40, "main", ["AI_REVIEW_STARTED", 3, _ROW_TIME.isoformat()], False],
    ]
    assert (form["checked_at"], form["waiting"], form["sweeps"]) == (_STARTED.isoformat(), [5, 8], 7)
    assert (form["attempted"], form["attempts"]) == ([(3, 2), (8, 3)], 3)
    assert form["sweep_started_at"] == (_STARTED - timedelta(minutes=6)).isoformat()
    assert form["sweep"]["number"] == 7
    assert form["decode_error"].startswith("its stored approval-backing memory did not decode")


def _changed(**changes: Any) -> dict[str, Any]:
    form: dict[str, Any] = json.loads(json.dumps(backing_form(_full())))
    form.update(changes)
    return form


@pytest.mark.parametrize(
    "form",
    [
        _changed(keys=[["3", None, "a", "main", None, None]]),
        _changed(keys=[[3, None, "a", 7, None, None]]),
        _changed(keys=[[3, None, "a", "main", ["LAND", "12", _ROW_TIME.isoformat()], None]]),
        _changed(keys=[[3, None, "a", "main", None, 1]]),
        _changed(keys=[[3, "yesterday", "a", "main", None, None]]),
        _changed(sweep=None),
        _changed(sweeps=True),
        _changed(decode_error=["not", "text"]),
        _changed(attempted=[["3", 1]]),
        _changed(attempted=[[3, None]]),
        _changed(attempts=None),
        ["not", "an", "object"],
    ],
    ids=[
        "a-pr-number-not-a-number",
        "a-base-not-text",
        "a-run-id-not-a-number",
        "a-rules-state-not-a-bool",
        "an-update-time-not-a-time",
        "a-sweep-start-without-its-sweep",
        "a-sweep-count-not-a-number",
        "a-note-not-text",
        "an-attempted-pr-not-a-number",
        "an-attempt-not-a-number",
        "an-attempt-count-not-a-number",
        "not-an-object",
    ],
)
def test_a_form_that_does_not_decode_raises(form):
    with pytest.raises((ValueError, TypeError)):
        backing_from_form(form)


@pytest.mark.parametrize("version", [0, 2, True, "1", None])
def test_a_form_of_another_version_is_refused_with_an_error_of_its_own(version):
    form = _changed(version=version)

    with pytest.raises(BackingVersionError, match=rf"has version {re.escape(repr(version))}, not 1$") as caught:
        backing_from_form(form)
    assert not isinstance(caught.value, (ValueError, TypeError, KeyError))


def test_a_form_without_a_version_is_of_another_version():
    form = _changed()
    del form["version"]

    with pytest.raises(BackingVersionError, match=r"has version None, not 1$"):
        backing_from_form(form)
