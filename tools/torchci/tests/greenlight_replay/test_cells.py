"""Tests for the export's cell encoding and its inverse.

Every case writes through the export's own ``write_csv`` and reads back through
``load_rows``, so what is under test is the round trip rather than either half's idea of
it. Nothing here touches ClickHouse or GitHub.
"""

import csv
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from torchci.greenlight_decisions.rows import COLUMNS, csv_safe, write_csv
from torchci.greenlight_replay import cells


def round_trip(message, column="decision_message"):
    """Write one value through the export's writer and read the cell back."""
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "decisions.csv")
        write_csv(path, [{column: message}])
        [loaded] = cells.load_rows(path)
    return loaded


class TestLoadRows(unittest.TestCase):
    """load_rows returns the values write_csv was handed, not the cells it wrote."""

    def test_the_bom_does_not_ride_on_the_first_column_name(self):
        # Left in place it becomes part of the first header, and every lookup of that
        # column misses while the file still parses as valid CSV.
        loaded = round_trip("pytorch/pytorch", column="repo")
        self.assertEqual(list(loaded)[0], COLUMNS[0])
        self.assertEqual(loaded["repo"], "pytorch/pytorch")

    def test_every_written_column_comes_back(self):
        self.assertEqual(set(round_trip("anything")), set(COLUMNS))

    def test_an_absent_value_comes_back_blank(self):
        self.assertEqual(round_trip("anything")["decision"], "")

    def test_an_embedded_crlf_survives(self):
        # Without newline="" on the read, universal-newline translation rewrites the CRLF
        # to a bare LF before the csv module sees it and the message comes back shorter.
        message = "- first\r\nsecond line"
        self.assertEqual(round_trip(message)["decision_message"], message)

    def test_embedded_quotes_commas_and_tabs_survive(self):
        message = 'reason: "a, b" and\ta tab'
        self.assertEqual(round_trip(message)["decision_message"], message)

    def test_a_multi_line_message_does_not_become_several_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "decisions.csv")
            write_csv(path, [{"decision_message": "- one\n- two\n- three"}])
            loaded = cells.load_rows(path)
        self.assertEqual(len(loaded), 1)

    def test_an_em_dash_survives_the_bom_encoding(self):
        message = "Touches the ROCm CI script — rebase before landing."
        self.assertEqual(round_trip(message)["decision_message"], message)

    def test_a_file_with_only_a_header_loads_to_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "decisions.csv")
            write_csv(path, [])
            self.assertEqual(cells.load_rows(path), [])

    def test_a_longer_column_list_is_read_back_whole(self):
        # The replay appends four columns of its own and writes through the same writer,
        # so the reader has to be column-agnostic rather than pinned to COLUMNS.
        columns = [*COLUMNS, "new_decision"]
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "replay.csv")
            write_csv(path, [{"new_decision": "- NO_LAND"}], columns=columns)
            [loaded] = cells.load_rows(path)
        self.assertEqual(set(loaded), set(columns))
        self.assertEqual(loaded["new_decision"], "- NO_LAND")


class TestFormulaGuardInverse(unittest.TestCase):
    """The apostrophe guard fires on most decision_message values -- the reviewer writes
    Markdown bullets -- so leaving it on corrupts the majority of the column, and
    stripping it unconditionally eats a genuine apostrophe. Both are silent."""

    def test_a_bullet_message_round_trips_losslessly(self):
        message = "- Scope\n  - one file\n- Risk\n  - none"
        self.assertEqual(round_trip(message)["decision_message"], message)

    def test_every_formula_prefix_round_trips(self):
        for token in ("=", "+", "-", "@"):
            with self.subTest(token=token):
                message = f"{token} leading"
                self.assertEqual(round_trip(message)["decision_message"], message)

    def test_a_genuine_leading_apostrophe_is_not_eaten(self):
        # An unconditional strip loses one character per round trip, and the loss is
        # silent: the cell still parses, it is just one character shorter every pass.
        message = "'tis a narrow change"
        self.assertEqual(round_trip(message)["decision_message"], message)

    def test_a_whitespace_led_formula_cell_round_trips(self):
        # csv_safe looks past leading whitespace and NUL before deciding, because
        # spreadsheets strip those first; an inverse anchored on the character right after
        # the apostrophe would leave the guard in place on exactly these cells.
        for prefix in (" ", "\t", "\r", "\n", "\x00", " \t "):
            with self.subTest(prefix=repr(prefix)):
                message = f"{prefix}=1+1"
                self.assertEqual(round_trip(message)["decision_message"], message)

    def test_the_guard_is_really_present_in_the_written_file(self):
        # Otherwise the round-trip cases above would pass just as well against a writer
        # that had quietly stopped guarding anything.
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "decisions.csv")
            write_csv(path, [{"decision_message": "- Scope"}])
            with open(path, newline="", encoding="utf-8-sig") as handle:
                [raw] = list(csv.DictReader(handle))
        self.assertEqual(raw["decision_message"], "'- Scope")

    def test_ordinary_prose_is_returned_unchanged(self):
        for text in ("torch-2.14", "a = b", "rebase-only", "  indented", ""):
            with self.subTest(text=text):
                self.assertEqual(cells.from_cell(text), text)

    def test_a_non_string_cell_reads_as_blank(self):
        # csv.DictReader yields None for a short row's missing trailing fields.
        self.assertEqual(cells.from_cell(None), "")


class TestToCell(unittest.TestCase):
    """to_cell formats a value the way the export would, so a row assembled in memory
    carries cells indistinguishable from the ones it sits beside."""

    def test_it_is_csv_safe_with_the_guard_taken_back_off(self):
        for value in ("- Scope", "plain", 0, -5, True, None):
            with self.subTest(value=value):
                self.assertEqual(cells.to_cell(value), cells.from_cell(csv_safe(value)))

    def test_bools_render_lowercase_like_the_other_flag_columns(self):
        self.assertEqual(cells.to_cell(True), "true")
        self.assertEqual(cells.to_cell(False), "false")

    def test_none_renders_blank_rather_than_the_text_none(self):
        self.assertEqual(cells.to_cell(None), "")

    def test_datetimes_keep_the_milliseconds_that_make_as_of_replayable(self):
        aware = datetime(2026, 8, 26, 9, 12, 33, 289000, tzinfo=timezone.utc)
        self.assertEqual(cells.to_cell(aware), "2026-08-26T09:12:33.289Z")

    def test_an_offset_datetime_is_converted_not_relabelled(self):
        berlin = timezone(timedelta(hours=2))
        self.assertEqual(
            cells.to_cell(datetime(2026, 8, 26, 11, 12, 33, tzinfo=berlin)),
            "2026-08-26T09:12:33.000Z",
        )

    def test_a_bullet_message_carries_no_guard(self):
        # The guard belongs to the file, not to the in-memory row; leaving it on here
        # would double it the next time the row goes through write_csv.
        self.assertEqual(cells.to_cell("- Scope"), "- Scope")

    def test_what_it_produces_survives_a_write_and_a_read(self):
        for value in ("- Scope", "'tis", "\t=1+1", "plain"):
            with self.subTest(value=value):
                rendered = cells.to_cell(value)
                self.assertEqual(round_trip(rendered)["decision_message"], rendered)


if __name__ == "__main__":
    unittest.main()
