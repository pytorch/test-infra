import csv
import sys
from dataclasses import dataclass
from typing import Iterable, List

from ..logic import COLUMNS as EXPECTED_COLUMNS


def _raise_field_size_limit() -> None:
    # Signal keys can be huge parametrized strings; lift the csv field cap so
    # they parse instead of raising _csv.Error on very long fields.
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit = int(limit // 10)


class ReportInputError(Exception):
    """Raised when the input CSV cannot be parsed into records."""


@dataclass(frozen=True)
class Record:
    commit_sha: str
    commit_url: str
    commit_time: str
    category: str
    workflow: str
    signal_key: str
    advisor_verdict: str
    advisor_confidence: str
    premerge_status: str = ""

    @property
    def day(self) -> str:
        return self.commit_time[:10]


def load_records(lines: Iterable[str]) -> List[Record]:
    _raise_field_size_limit()
    reader = csv.reader(lines)
    try:
        header = next(reader)
    except StopIteration:
        raise ReportInputError("Input CSV is empty (no header row).") from None
    except csv.Error as exc:
        raise ReportInputError(f"Malformed CSV: {exc}") from exc

    if header != EXPECTED_COLUMNS:
        raise ReportInputError(
            "Unexpected CSV header.\n"
            f"  expected: {','.join(EXPECTED_COLUMNS)}\n"
            f"  found:    {','.join(header)}"
        )

    records: List[Record] = []
    try:
        for lineno, row in enumerate(reader, start=2):
            if not row or all(cell.strip() == "" for cell in row):
                continue
            if len(row) != len(EXPECTED_COLUMNS):
                raise ReportInputError(
                    f"Row {lineno} has {len(row)} columns, "
                    f"expected {len(EXPECTED_COLUMNS)}."
                )
            records.append(Record(*row))
    except csv.Error as exc:
        raise ReportInputError(f"Malformed CSV: {exc}") from exc
    return records
