"""The encoding of a ``greenlight_decisions`` CSV cell, and its inverse.

The export is not plain text. ``greenlight_decisions.rows.write_csv`` writes a UTF-8 BOM so
Excel renders the em-dashes in ``decision_message``, and prefixes an apostrophe onto any
cell a spreadsheet would evaluate as a formula. That guard fires on most
``decision_message`` values -- the reviewer writes Markdown bullets, and a leading ``-`` is
a formula to Excel -- so a reader that leaves it in place corrupts the majority of the
column while every row still parses.

The guard is undone by asking ``csv_safe`` itself whether a cell is what it would have
produced from the text behind the apostrophe, rather than by restating its rule here. That
matters in both directions. ``csv_safe`` looks *past* leading whitespace and NUL before
deciding, because spreadsheets strip those first, so ``"'\\t=1+1"`` is a guarded cell and an
inverse anchored on the character after the apostrophe would leave it mangled. And a value
that genuinely opens with an apostrophe is not guarded at all and has to come back whole,
where an unconditional strip would eat one character per round trip -- silently, on a cell
that still parses.

The transform is not injective for a value of the literal form apostrophe-then-formula-
character: the writer emits it unguarded and any reader must read it as a guarded formula.
No such value survives the export in the first place, so the ambiguity belongs to the CSV
rather than to this module.

``to_cell`` is that same rule run forwards and straight back out, which is what lets a row
assembled in memory -- a re-derived verdict, a replayed one -- carry cells formatted exactly
like the ones beside it: millisecond datetimes, lowercase booleans, blank for ``None``.
"""

from __future__ import annotations

import csv
from typing import Any

from torchci.greenlight_decisions.rows import csv_safe


__all__ = [
    "from_cell",
    "load_rows",
    "to_cell",
]

_GUARD = "'"


def load_rows(path: str) -> list[dict[str, str]]:
    """Read a ``greenlight_decisions`` CSV back into the values it was written from.

    ``newline=""`` is required rather than tidy: ``decision_message`` is multi-line prose,
    and universal-newline translation rewrites a CRLF embedded in a quoted cell before the
    csv module sees it. ``utf-8-sig`` drops the BOM, which would otherwise ride on the
    first column's name and make every lookup of it miss.

    Column-agnostic, so it reads the replay's own augmented output as well as the export.
    """
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    return [{name: from_cell(value) for name, value in row.items()} for row in rows]


def from_cell(value: Any) -> str:
    """Undo ``csv_safe``'s spreadsheet guard, and nothing else."""
    text = value if isinstance(value, str) else ""
    if text.startswith(_GUARD) and csv_safe(text[1:]) == text:
        return text[1:]
    return text


def to_cell(value: Any) -> str:
    """Render a value the way the export writes it, read back the way ``load_rows`` reads."""
    return from_cell(csv_safe(value))
