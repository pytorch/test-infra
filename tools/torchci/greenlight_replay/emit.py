"""Merging a replayed verdict into its exported row, and writing the result.

The replay output is the decision export's own columns with four appended: the
verdict a candidate policy produced for the same pull request. Leaving the
original columns untouched is the point -- the file is read by putting
``decision`` beside ``new_decision`` -- so the write goes through
``rows.write_csv`` with a longer column list rather than through a second CSV
writer. The BOM, the write-then-replace and the formula guard are defined once,
over there, and cover the new columns unchanged.

What a run *means* in those four columns is ``verdict_cells``, and what a sweep
has already paid for is ``checkpoint``. This module is the last step of the
pipeline and the front door to all three: the names below are re-exported so a
caller says ``emit`` and does not have to track which half a function lives in.
The re-exports are the same objects, not copies, and a test asserts that -- a
facade whose names drift from what they forward is worse than no facade, because
two modules then disagree about the same behaviour.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from torchci.greenlight_decisions.rows import COLUMNS, write_csv
from torchci.greenlight_replay.checkpoint import (
    append_checkpoint,
    CHECKPOINT_IDENTITY_FIELDS,
    CHECKPOINT_PR_KEY,
    load_checkpoint,
    matching_entries,
    RUN_METRIC_FIELDS,
)
from torchci.greenlight_replay.verdict_cells import (
    as_text,
    DECISION_VALUES,
    HARNESS_REASON_PREFIX,
    NEW_COLUMNS,
    OUTCOME_BUDGET_TRIP,
    OUTCOME_SUCCESS,
    OUTCOME_TOO_LARGE,
    OUTCOME_UNREADABLE,
    POLICY_VERDICT_OUTCOMES,
    replay_cells,
)


__all__ = [
    "append_checkpoint",
    "as_text",
    "build_replay_row",
    "CHECKPOINT_IDENTITY_FIELDS",
    "CHECKPOINT_PR_KEY",
    "DECISION_VALUES",
    "HARNESS_REASON_PREFIX",
    "load_checkpoint",
    "matching_entries",
    "NEW_COLUMNS",
    "OUTCOME_BUDGET_TRIP",
    "OUTCOME_SUCCESS",
    "OUTCOME_TOO_LARGE",
    "OUTCOME_UNREADABLE",
    "POLICY_VERDICT_OUTCOMES",
    "replay_cells",
    "REPLAY_COLUMNS",
    "RUN_METRIC_FIELDS",
    "write_replay_csv",
]

REPLAY_COLUMNS: list[str] = [*COLUMNS, *NEW_COLUMNS]


def build_replay_row(
    row: Mapping[str, str], entry: Mapping[str, Any]
) -> dict[str, str]:
    """Merge one checkpoint entry into the exported row it was replayed from.

    ``entry`` is what ``load_checkpoint`` returns for a pull request, and the
    only place cells become a row. Only the four new columns are taken from it,
    so neither the run metrics nor the input identity riding alongside them can
    reach the file -- in particular ``repo`` and ``decision_head_sha`` keep the
    row's own values, not the copies the entry carries for matching. The original
    cells are copied through untouched, and the caller's mapping is not modified.
    """
    merged = dict(row)
    merged.update({column: as_text(entry.get(column)) for column in NEW_COLUMNS})
    return merged


def write_replay_csv(path: str, rows: Sequence[Mapping[str, str]]) -> int:
    """Write the augmented export to ``path``, returning the rows written."""
    return write_csv(path, rows, columns=REPLAY_COLUMNS)
