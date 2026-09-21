"""Shared stand-ins for the emit layer's tests.

``RunResult`` is not imported. The code under test reads it by attribute, so the
stand-in below carries the same names, and the outcome vocabulary is restated
rather than borrowed -- a test that imports the enum it is checking against
cannot notice the enum changing.

The three test modules that split along the emit layer's own seam all drive it
with the same run and the same row, so a divergence between them is a real
disagreement rather than two fixtures drifting apart.
"""

import tempfile
from enum import Enum
from pathlib import Path
from types import SimpleNamespace

from torchci.greenlight_decisions.rows import COLUMNS
from torchci.greenlight_replay.checkpoint import append_checkpoint, load_checkpoint
from torchci.greenlight_replay.emit import build_replay_row


EXPECTED_NEW_COLUMNS = [
    "new_decision",
    "new_decision_reason",
    "new_decision_summary",
    "new_decision_message",
]

FORMULA_PREFIXES = ("=", "+", "-", "@")

# Spelled as a code point because it is invisible in source, and the point of
# the test that uses it is that str.splitlines() treats it as a line break.
LINE_SEPARATOR = chr(0x2028)
LEADING_NOISE = " \t\r\n\x00"

# A real verdict message: markdown, bullet-led, multi-line, with the quotes,
# commas and backticks that make a CSV cell interesting.
VERDICT_MESSAGE = (
    "- Only `torch/_dynamo/variables/dicts.py` changed, and the swap to a "
    "weakref mirrors the existing pattern. No behaviour change.\r\n"
    '- The test, "test_side_effects_weakref", covers the new path.\n'
    "- Nothing else in the diff touches autograd, dispatch, or the C API."
)

HEAD_SHA = "a" * 40
OTHER_HEAD_SHA = "b" * 40

CANNED_TOO_LARGE_MESSAGE = (
    "This pull request is larger than the reviewer's diff cap, so no review ran."
)


class Outcome(Enum):
    SUCCESS = "success"
    SCHEMA_INVALID = "schema_invalid"
    NO_VERDICT = "no_verdict"
    TIMEOUT = "timeout"
    BUDGET_TRIP = "budget_trip"
    API_ERROR = "api_error"
    EMPTY_RUN = "empty_run"
    TOO_LARGE = "too_large"


FAILED_OUTCOMES = tuple(
    outcome for outcome in Outcome if outcome is not Outcome.SUCCESS
)


def result(**overrides):
    """A ``RunResult`` stand-in, successful unless overridden."""
    fields = {
        "outcome": Outcome.SUCCESS,
        "status": "LAND",
        "reason": "clean",
        "message": VERDICT_MESSAGE,
        "cost_usd": 0.4231,
        "duration_s": 512.7,
        "num_turns": 11,
        "model": "claude-opus-5[1m]",
        "context_window": 1000000,
        "error": None,
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


def failed(outcome, **overrides):
    """A run that produced no verdict, the shape the runner reports on failure."""
    fields = {"outcome": outcome, "status": "", "reason": "", "message": ""}
    fields.update(overrides)
    return result(**fields)


def exported_row(**overrides):
    """One row as the decision export wrote it: every column, all strings."""
    row = dict.fromkeys(COLUMNS, "")
    row.update(
        {
            "repo": "pytorch/pytorch",
            "pr_number": "192258",
            "base_ref": "main",
            "decision_head_sha": HEAD_SHA,
            "landed": "true",
            "decision": "LAND",
            "decision_reason": "clean",
            "decision_summary": "Only tests changed.",
            "decision_message": "Only tests changed. Details follow.",
            "lifecycle_status": "decided",
        }
    )
    row.update(overrides)
    return row


def record_run(path, pr_number, result, **row_overrides):
    """Check one run in against a row, defaulting the row to the shared fixture."""
    row = exported_row(pr_number=str(pr_number), **row_overrides)
    append_checkpoint(path, row, result)


def cells_for(result):
    """One run's four cells, read back the way the CLI reads them.

    Through the checkpoint, because that is the only path there is: nothing
    renders a RunResult into a row without writing it down first, so a test that
    shortcut the file would be testing a path production does not have.
    """
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "checkpoint.jsonl"
        record_run(path, 1, result)
        return load_checkpoint(path)[1]


def replayed(row, result):
    """The replay row one run produces, over the pipeline the CLI runs."""
    return build_replay_row(row, cells_for(result))


def unguard(cell):
    """The inverse of the export's formula guard, stated rather than imported.

    Only the raw-cell test uses this. Everything else reads through
    ``frame.load_rows``; this is here so that test can say what it expects the
    loader to do without the assertion and the loader being the same code.
    """
    if cell.startswith("'") and cell[1:].lstrip(LEADING_NOISE).startswith(
        FORMULA_PREFIXES
    ):
        return cell[1:]
    return cell
