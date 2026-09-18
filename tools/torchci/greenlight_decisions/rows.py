"""Row assembly and CSV emission for the greenlight decision export.

``COLUMNS`` is the single source of the output's shape: ``build_row`` fills
exactly those keys and ``write_csv`` emits exactly those keys, in that order.
"""

from __future__ import annotations

import contextlib
import csv
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional

from torchci.greenlight_decisions.sql import MULTI_VALUE_SEPARATOR


COLUMNS: List[str] = [
    "repo",
    "pr_number",
    "pr_url",
    "pr_status",
    "landed",
    "base_ref",
    "reverted",
    "is_shadow",
    "decision",
    "decision_reason",
    "decision_summary",
    "decision_message",
    "n_terminal_decisions",
    "verdict_flipped",
    "human_approvals",
    "human_approvers",
    "human_changes_requested",
    "human_change_requesters",
    "additions",
    "deletions",
    "changed_files",
    "pr_loc",
    "loc",
    "sig_loc",
    "decision_head_sha",
    "final_head_sha",
    "base_sha",
    "verdict_staleness",
    "files_changed_after_verdict",
    "decision_run_id",
    "decision_version",
    "lifecycle_status",
    "loc_status",
    "snapshot_at",
]

LOC_COLUMNS: List[str] = [
    "loc",
    "sig_loc",
    "verdict_staleness",
    "files_changed_after_verdict",
    "loc_status",
]

DERIVED_COLUMNS: List[str] = [
    "pr_loc",
    "decision_summary",
]

BOOL_COLUMNS: List[str] = [
    "landed",
    "reverted",
    "is_shadow",
    "verdict_flipped",
]

SNAPSHOT_COLUMN = "snapshot_at"

DECISION_COLUMNS: List[str] = [
    column
    for column in COLUMNS
    if column not in LOC_COLUMNS
    and column not in DERIVED_COLUMNS
    and column != SNAPSHOT_COLUMN
]

STALENESS_NO_VERDICT = "none"

# Second precision, for snapshot_at and the default filename.
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

# Millisecond precision, for datetime cells. decision_version comes from a
# DateTime64(3) and almost every row has a nonzero millisecond, so second
# precision would stop the CSV round-tripping: feeding a truncated
# decision_version back as --as-of excludes the very verdict it names.
_DATETIME_CELL_FORMAT = "%Y-%m-%dT%H:%M:%S"

SUMMARY_MAX_CHARS = 200

# Excel and Google Sheets evaluate a cell whose text begins with one of these,
# and decision_message is LLM-authored prose that can legitimately open with a
# "-" bullet.
_FORMULA_PREFIXES = ("=", "+", "-", "@")

# Spreadsheets strip leading whitespace and control bytes before deciding
# whether a cell is a formula, so the guard has to look past them rather than
# testing position zero (OWASP CSV injection; Symfony CVE-2021-41270).
_LEADING_NOISE = " \t\r\n\x00"

_FALSE_TOKENS = frozenset({"", "0", "false", "no"})

_SENTENCE_END = re.compile(r"(?<=[.!?])\s")


def to_utc_naive(value: datetime) -> datetime:
    """Normalize to naive UTC; a naive input is taken to already be UTC."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def format_timestamp(value: datetime) -> str:
    return to_utc_naive(value).strftime(TIMESTAMP_FORMAT)


def format_datetime_cell(value: datetime) -> str:
    """Render a datetime cell so that feeding it back as ``--as-of`` selects it."""
    utc = to_utc_naive(value)
    return f"{utc.strftime(_DATETIME_CELL_FORMAT)}.{utc.microsecond // 1000:03d}Z"


def blank_loc(loc_status: str = "") -> Dict[str, Any]:
    """LOC cells for a PR whose diff was not measured."""
    cells: Dict[str, Any] = dict.fromkeys(LOC_COLUMNS, "")
    cells["loc_status"] = loc_status
    return cells


def first_sentence(message: Any) -> str:
    """The leading clause of a verdict message, for a readable spreadsheet row."""
    if not isinstance(message, str):
        return ""
    text = message.strip()
    if not text:
        return ""
    sentence = _SENTENCE_END.split(text, maxsplit=1)[0].strip()
    if len(sentence) <= SUMMARY_MAX_CHARS:
        return sentence
    return sentence[: SUMMARY_MAX_CHARS - 3].rstrip() + "..."


def build_row(
    decision: Mapping[str, Any],
    loc: Optional[Mapping[str, Any]],
    snapshot_at: str = "",
) -> Dict[str, Any]:
    """Merge one ``fetch_decisions`` record and its LOC result into a CSV row."""
    row: Dict[str, Any] = {
        column: decision.get(column, "") for column in DECISION_COLUMNS
    }
    for column in BOOL_COLUMNS:
        row[column] = _as_bool(decision.get(column))
    row["pr_loc"] = _pr_loc(decision)
    row["decision_summary"] = first_sentence(decision.get("decision_message"))
    row.update(_loc_cells(decision, loc))
    row[SNAPSHOT_COLUMN] = snapshot_at
    return row


def csv_safe(value: Any) -> str:
    text = _stringify(value)
    if text.lstrip(_LEADING_NOISE).startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def write_csv(path: str, rows: Iterable[Mapping[str, Any]]) -> int:
    """Write ``rows`` to ``path`` and return the number of data rows written.

    The file is built beside its destination and moved into place, so an
    interrupted or failing run can neither destroy an existing export nor leave
    a truncated one that still parses as valid CSV.
    """
    tmp_path = f"{path}.tmp"
    written = 0
    try:
        # The BOM is what makes Excel on Windows read the file as UTF-8; without
        # it the em-dashes in decision_message render as mojibake.
        with open(tmp_path, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=COLUMNS)
            writer.writeheader()
            for row in rows:
                writer.writerow(
                    {column: csv_safe(row.get(column)) for column in COLUMNS}
                )
                written += 1
        os.replace(tmp_path, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp_path)
        raise
    return written


def _loc_cells(
    decision: Mapping[str, Any], loc: Optional[Mapping[str, Any]]
) -> Dict[str, Any]:
    if loc is not None:
        return {column: loc.get(column, "") for column in LOC_COLUMNS}
    cells = blank_loc()
    # "none" means there was no verdict to be stale against. A blank staleness
    # means a verdict exists but was not measured (--skip-loc, or a failed
    # lookup), which is a different statement.
    if not decision.get("decision"):
        cells["verdict_staleness"] = STALENESS_NO_VERDICT
    return cells


def _pr_loc(decision: Mapping[str, Any]) -> Any:
    try:
        return int(decision["additions"]) + int(decision["deletions"])
    except (KeyError, TypeError, ValueError):
        return ""


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return format_datetime_cell(value)
    if isinstance(value, (list, tuple)):
        return MULTI_VALUE_SEPARATOR.join(_stringify(item) for item in value)
    return str(value)


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in _FALSE_TOKENS
    return bool(value)
