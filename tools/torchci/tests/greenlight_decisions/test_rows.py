"""Tests for the greenlight decision export's row assembly and CSV writing.

COLUMNS is this file's main subject: it is the published shape of the CSV, so
the ordered list is asserted as a literal rather than derived from the same
constants it is built out of.
"""

import csv
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from decision_fixtures import DECIDED, EM_DASH_MESSAGE, MEASURED, UNDECIDED
from torchci.greenlight_decisions.query import FIELDS
from torchci.greenlight_decisions.rows import (
    blank_loc,
    build_row,
    COLUMNS,
    csv_safe,
    DECISION_COLUMNS,
    format_timestamp,
    LOC_COLUMNS,
    SNAPSHOT_COLUMN,
    STALENESS_NO_VERDICT,
    SUMMARY_MAX_CHARS,
    to_utc_naive,
    write_csv,
)

# From sql.py, its single definition site: the point of the test below is
# that csv_safe joins on the very separator the SQL joins login lists with.
from torchci.greenlight_decisions.sql import MULTI_VALUE_SEPARATOR


EXPECTED_COLUMNS = [
    "repo",
    "pr_number",
    "pr_url",
    "pr_status",
    "landed",
    "base_ref",
    "reverted",
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


class TestColumns(unittest.TestCase):
    def test_the_full_ordered_column_list(self):
        # Spelled out rather than derived from FIELDS and LOC_COLUMNS: those are
        # the same source COLUMNS is built from, so a derived assertion passes
        # green through a rename or a reorder that breaks every consumer of the
        # file. This is the published interface -- changing it should require
        # editing this literal.
        self.assertEqual(COLUMNS, EXPECTED_COLUMNS)

    def test_no_duplicate_columns(self):
        self.assertEqual(len(COLUMNS), len(set(COLUMNS)))

    def test_every_upstream_field_reaches_a_column(self):
        # The direction that silently loses data: a field the query computes and
        # pays for, that build_row never copies, vanishes without any error.
        self.assertEqual(set(FIELDS) - set(COLUMNS), set())
        self.assertEqual(set(LOC_COLUMNS) - set(COLUMNS), set())

    def test_decision_columns_match_the_query_contract(self):
        self.assertEqual(set(DECISION_COLUMNS), set(FIELDS))

    def test_snapshot_column_comes_last(self):
        self.assertEqual(COLUMNS[-1], SNAPSHOT_COLUMN)


class TestBuildRow(unittest.TestCase):
    def test_every_column_is_populated(self):
        row = build_row(DECIDED, MEASURED, "2026-09-03T12:00:00Z")
        self.assertEqual(set(row), set(COLUMNS))

    def test_decision_and_loc_values_are_carried_through(self):
        row = build_row(DECIDED, MEASURED, "2026-09-03T12:00:00Z")
        self.assertEqual(row["pr_number"], 192258)
        self.assertEqual(row["decision"], "LAND")
        self.assertEqual(row["decision_message"], EM_DASH_MESSAGE)
        self.assertEqual(row["loc"], 71)
        self.assertEqual(row["sig_loc"], 64)
        self.assertEqual(row["verdict_staleness"], "content-changed")
        self.assertEqual(row[SNAPSHOT_COLUMN], "2026-09-03T12:00:00Z")

    def test_undecided_pr_reports_staleness_none_and_blank_loc(self):
        row = build_row(UNDECIDED, None)
        self.assertEqual(row["verdict_staleness"], STALENESS_NO_VERDICT)
        for column in ("loc", "sig_loc", "files_changed_after_verdict", "loc_status"):
            self.assertEqual(row[column], "")

    def test_decided_pr_without_measurement_leaves_staleness_blank(self):
        row = build_row(DECIDED, None)
        self.assertEqual(row["verdict_staleness"], "")

    def test_reverted_is_normalized_to_a_bool(self):
        for raw, expected in ((1, True), (0, False), ("0", False), (None, False)):
            row = build_row({**DECIDED, "reverted": raw}, MEASURED)
            self.assertIs(row["reverted"], expected)

    def test_missing_keys_render_blank_rather_than_raising(self):
        row = build_row({"pr_number": 1}, None)
        self.assertEqual(row["repo"], "")
        self.assertEqual(row["decision"], "")

    def test_snapshot_defaults_to_blank(self):
        self.assertEqual(build_row(DECIDED, MEASURED)[SNAPSHOT_COLUMN], "")


class TestCsvSafe(unittest.TestCase):
    def test_none_becomes_empty(self):
        self.assertEqual(csv_safe(None), "")

    def test_bools_render_lowercase(self):
        self.assertEqual(csv_safe(True), "true")
        self.assertEqual(csv_safe(False), "false")

    def test_a_defensive_sequence_joins_on_the_shared_separator(self):
        # Unreachable on real data: ClickHouse returns human_approvers already
        # joined, so nothing in the export hands csv_safe a list. This covers the
        # defensive branch only, and pins it to the separator the SQL already
        # uses -- two multi-value conventions in one file would be worse than
        # either, and a comma inside a CSV cell is the worse of the two.
        self.assertEqual(csv_safe(["alice", "bob"]), f"alice{MULTI_VALUE_SEPARATOR}bob")
        self.assertEqual(MULTI_VALUE_SEPARATOR, ";")

    def test_leading_whitespace_does_not_smuggle_a_formula(self):
        # Spreadsheets strip leading whitespace and NUL before deciding whether
        # a cell is a formula, so a guard anchored at position zero lets
        # "\t=1+1" through and Excel evaluates it (OWASP CSV injection).
        for prefix in (" ", "\t", "\r", "\n", "\x00", " \t "):
            with self.subTest(prefix=repr(prefix)):
                self.assertEqual(csv_safe(f"{prefix}=1+1"), f"'{prefix}=1+1")

    def test_leading_whitespace_guard_covers_every_formula_prefix(self):
        for token in ("=", "+", "-", "@"):
            with self.subTest(token=token):
                self.assertEqual(csv_safe(f"\t{token}1"), f"'\t{token}1")

    def test_whitespace_alone_is_not_escaped(self):
        self.assertEqual(csv_safe("  indented prose"), "  indented prose")

    def test_datetimes_render_as_utc_with_milliseconds(self):
        # decision_version comes from a DateTime64(3) where almost every row has
        # a nonzero millisecond, so truncating to seconds would collapse
        # verdicts that are distinct and ordered.
        aware = datetime(2026, 9, 3, 12, 0, 0, 123000, tzinfo=timezone.utc)
        self.assertEqual(csv_safe(aware), "2026-09-03T12:00:00.123Z")
        self.assertEqual(
            csv_safe(datetime(2026, 9, 3, 12, 0, 0)), "2026-09-03T12:00:00.000Z"
        )

    def test_an_offset_datetime_cell_is_converted_not_relabelled(self):
        berlin = timezone(timedelta(hours=2))
        self.assertEqual(
            csv_safe(datetime(2026, 9, 3, 14, 0, 0, tzinfo=berlin)),
            "2026-09-03T12:00:00.000Z",
        )

    def test_formula_prefixes_are_neutralized(self):
        for text in ("=SUM(A1)", "+1+1", "-- dropped the pin bump", "@here"):
            self.assertEqual(csv_safe(text), "'" + text)

    def test_the_guard_also_quotes_negative_numbers(self):
        # No column in this schema is ever negative, so the guard is applied
        # uniformly rather than carved out for numeric-looking text.
        self.assertEqual(csv_safe(-5), "'-5")

    def test_ordinary_text_is_untouched(self):
        self.assertEqual(csv_safe(EM_DASH_MESSAGE), EM_DASH_MESSAGE)
        self.assertEqual(csv_safe(0), "0")
        self.assertEqual(csv_safe(""), "")


class TestDerivedColumns(unittest.TestCase):
    """pr_loc and decision_summary are computed here, not by the query."""

    def test_pr_loc_is_the_whole_pr_churn(self):
        # Distinct from `loc`, which measures only what greenlight judged. For
        # 192258 those are 71 and 18, and conflating them is the difference
        # between "the PR was big" and "the verdict covered a lot".
        self.assertEqual(build_row(DECIDED, MEASURED)["pr_loc"], 71)

    def test_pr_loc_coerces_string_counts(self):
        row = build_row({**DECIDED, "additions": "3", "deletions": "4"}, None)
        self.assertEqual(row["pr_loc"], 7)

    def test_pr_loc_is_blank_when_a_count_is_missing(self):
        # Blank, not zero: an absent count is unknown size, not an empty diff.
        for broken in ({"additions": None}, {"deletions": "n/a"}):
            with self.subTest(broken=broken):
                row = build_row({**DECIDED, **broken}, None)
                self.assertEqual(row["pr_loc"], "")

    def test_decision_summary_is_the_first_sentence(self):
        row = build_row(
            {**DECIDED, "decision_message": "Only tests changed. Details follow."},
            MEASURED,
        )
        self.assertEqual(row["decision_summary"], "Only tests changed.")

    def test_decision_summary_handles_every_terminator(self):
        for message, expected in (
            ("Is this safe? Probably.", "Is this safe?"),
            ("No! Really.", "No!"),
            ("No terminator at all", "No terminator at all"),
        ):
            with self.subTest(message=message):
                row = build_row({**DECIDED, "decision_message": message}, MEASURED)
                self.assertEqual(row["decision_summary"], expected)

    def test_decision_summary_is_blank_without_a_message(self):
        for message in ("", None, "   "):
            with self.subTest(message=repr(message)):
                row = build_row({**DECIDED, "decision_message": message}, MEASURED)
                self.assertEqual(row["decision_summary"], "")

    def test_a_runaway_sentence_is_truncated(self):
        # One unpunctuated paragraph must not push the readable column past the
        # width that makes it readable.
        row = build_row({**DECIDED, "decision_message": "x" * 400}, MEASURED)
        self.assertEqual(len(row["decision_summary"]), SUMMARY_MAX_CHARS)
        self.assertTrue(row["decision_summary"].endswith("..."))

    def test_the_full_message_survives_alongside_the_summary(self):
        # The summary is a convenience column, never a replacement.
        long_message = "First. " + "y" * 400
        row = build_row({**DECIDED, "decision_message": long_message}, MEASURED)
        self.assertEqual(row["decision_summary"], "First.")
        self.assertEqual(row["decision_message"], long_message)


class TestBlankLoc(unittest.TestCase):
    def test_blank_loc_covers_every_loc_column(self):
        self.assertEqual(set(blank_loc()), set(LOC_COLUMNS))

    def test_status_is_the_only_non_blank_cell(self):
        cells = blank_loc("missing_sha")
        self.assertEqual(cells["loc_status"], "missing_sha")
        self.assertEqual([cells[c] for c in LOC_COLUMNS if c != "loc_status"], [""] * 4)


class TestWriteCsv(unittest.TestCase):
    def _round_trip(self, rows):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            written = write_csv(str(path), rows)
            raw = path.read_bytes()
            with open(path, newline="", encoding="utf-8-sig") as handle:
                parsed = list(csv.DictReader(handle))
        return written, raw, parsed

    def test_header_and_row_count(self):
        rows = [build_row(DECIDED, MEASURED, "s"), build_row(UNDECIDED, None, "s")]
        written, _, parsed = self._round_trip(rows)
        self.assertEqual(written, 2)
        self.assertEqual(list(parsed[0]), COLUMNS)

    def test_file_starts_with_a_bom(self):
        _, raw, _ = self._round_trip([build_row(DECIDED, MEASURED, "s")])
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))

    def test_em_dash_survives_the_round_trip(self):
        _, _, parsed = self._round_trip([build_row(DECIDED, MEASURED, "s")])
        self.assertEqual(parsed[0]["decision_message"], EM_DASH_MESSAGE)

    def test_embedded_delimiters_and_quotes_survive_the_round_trip(self):
        nasty = 'reason: "a, b" and\ta tab'
        rows = [build_row({**DECIDED, "decision_message": nasty}, MEASURED, "s")]
        _, _, parsed = self._round_trip(rows)
        self.assertEqual(parsed[0]["decision_message"], nasty)

    def test_undecided_row_writes_none_staleness(self):
        _, _, parsed = self._round_trip([build_row(UNDECIDED, None, "s")])
        self.assertEqual(parsed[0]["verdict_staleness"], STALENESS_NO_VERDICT)
        self.assertEqual(parsed[0]["loc"], "")


class TestTimestamps(unittest.TestCase):
    def test_aware_input_is_converted_to_utc(self):
        self.assertEqual(
            to_utc_naive(datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)),
            datetime(2026, 9, 3, 12, 0),
        )

    def test_naive_input_is_read_as_utc(self):
        naive = datetime(2026, 9, 3, 12, 0)
        self.assertIs(to_utc_naive(naive), naive)

    def test_format_is_iso_with_a_z(self):
        self.assertEqual(
            format_timestamp(datetime(2026, 9, 3, 12, 0)), "2026-09-03T12:00:00Z"
        )


class TestRevertedIsIndependentOfDecision(unittest.TestCase):
    """194379, 194772 and 194773 were approved, landed, broke, and had the
    approval revoked. Collapsing REVERTED into the decision column would score
    greenlight's worst false approvals as successes, so the two travel
    separately all the way to the row."""

    def test_land_and_reverted_both_survive(self):
        row = build_row({**DECIDED, "decision": "LAND", "reverted": True}, MEASURED)
        self.assertEqual(row["decision"], "LAND")
        self.assertIs(row["reverted"], True)

    def test_land_not_reverted(self):
        row = build_row({**DECIDED, "decision": "LAND", "reverted": False}, MEASURED)
        self.assertEqual(row["decision"], "LAND")
        self.assertIs(row["reverted"], False)

    def test_no_land_and_reverted(self):
        row = build_row({**DECIDED, "decision": "NO_LAND", "reverted": True}, MEASURED)
        self.assertEqual(row["decision"], "NO_LAND")
        self.assertIs(row["reverted"], True)

    def test_reverted_survives_without_a_decision(self):
        # Four of the six verdict-less PRs are reverted; dropping the flag with
        # the verdict would hide them entirely.
        row = build_row({**UNDECIDED, "reverted": True}, None)
        self.assertIs(row["reverted"], True)
        self.assertEqual(row["verdict_staleness"], STALENESS_NO_VERDICT)


class TestUnmeasuredLocRendersBlank(unittest.TestCase):
    """compute_loc reports an unmeasurable diff as None; the CSV must show that
    as an empty cell, never as the text "None" and never as a zero."""

    def test_none_loc_cells_render_empty(self):
        unmeasured = {
            "loc": None,
            "sig_loc": None,
            "verdict_staleness": "content-changed",
            "files_changed_after_verdict": 0,
            "loc_status": "parse_failed",
        }
        row = build_row(DECIDED, unmeasured)
        self.assertEqual(csv_safe(row["loc"]), "")
        self.assertEqual(csv_safe(row["sig_loc"]), "")
        self.assertEqual(row["loc_status"], "parse_failed")


class TestCsvSafeAnchoring(unittest.TestCase):
    def test_the_guard_only_fires_at_position_zero(self):
        # Every schema column that can hold a "-" mid-string -- version tags,
        # branch names, staleness values -- must pass through untouched.
        for text in ("torch-2.14", "a = b", "rebase-only", "release/2.14"):
            self.assertEqual(csv_safe(text), text)


class TestWriteCsvEdges(unittest.TestCase):
    def _write(self, rows):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            write_csv(str(path), rows)
            return path.read_bytes().decode("utf-8-sig")

    def test_a_zero_row_export_still_carries_the_header(self):
        self.assertEqual(self._write([]).splitlines(), [",".join(COLUMNS)])

    def test_an_unknown_key_is_dropped_rather_than_shifting_columns(self):
        row = {**build_row(DECIDED, MEASURED, "s"), "not_a_column": "junk"}
        [parsed] = list(csv.DictReader(self._write([row]).splitlines()))
        self.assertEqual(set(parsed), set(COLUMNS))


if __name__ == "__main__":
    unittest.main()
