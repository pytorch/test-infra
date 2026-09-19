"""Tests for the replay output's shape, its writer, and the emit facade.

``emit`` is the last step of the pipeline and the front door to the two modules
behind it, so the re-export check below is part of the subject rather than
housekeeping: callers import these names from here, and a facade whose names
drift from what they forward leaves two modules disagreeing about one behaviour.
"""

import csv
import tempfile
import unittest
from pathlib import Path

from emit_fixtures import (  # noqa: E402
    cells_for,
    EXPECTED_NEW_COLUMNS,
    exported_row,
    failed,
    FORMULA_PREFIXES,
    LEADING_NOISE,
    Outcome,
    record_run,
    replayed,
    result,
    unguard,
    VERDICT_MESSAGE,
)
from torchci.greenlight_decisions.rows import COLUMNS
from torchci.greenlight_replay import (
    checkpoint as checkpoint_module,
    emit,
    verdict_cells,
)
from torchci.greenlight_replay.emit import (
    build_replay_row,
    HARNESS_REASON_PREFIX,
    load_checkpoint,
    NEW_COLUMNS,
    REPLAY_COLUMNS,
    write_replay_csv,
)
from torchci.greenlight_replay.frame import load_rows


class TestReplayColumns(unittest.TestCase):
    """The replay file is the export plus four columns. It must track the export
    rather than a copy of it: a column added, renamed or reordered upstream has
    to move this file with it, or the two stop lining up and every side-by-side
    reading of decision against new_decision is off by a column."""

    def test_the_export_columns_come_first_unchanged(self):
        self.assertEqual(REPLAY_COLUMNS[: len(COLUMNS)], COLUMNS)

    def test_the_four_new_columns_come_last(self):
        self.assertEqual(REPLAY_COLUMNS[len(COLUMNS) :], NEW_COLUMNS)

    def test_the_new_columns_are_the_published_four_in_order(self):
        # The one literal here, for the same reason test_rows.py spells COLUMNS
        # out: this is the published shape of the new half, so changing it
        # should require editing a test.
        self.assertEqual(NEW_COLUMNS, EXPECTED_NEW_COLUMNS)

    def test_nothing_is_duplicated(self):
        self.assertEqual(len(REPLAY_COLUMNS), len(set(REPLAY_COLUMNS)))

    def test_no_new_column_shadows_an_export_column(self):
        self.assertEqual(set(NEW_COLUMNS) & set(COLUMNS), set())


class TestOneRendererOneMerger(unittest.TestCase):
    """There is exactly one way to turn a run into these four cells, and every
    row is built from a checkpoint entry -- the rows whose runs just finished
    included. A second path rendering a live result straight into a row is where
    the harness: convention and the recovered-verdict rule would quietly stop
    applying to half the file, so the merger takes cells and never a RunResult."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def test_a_resumed_row_is_identical_to_a_freshly_run_one(self):
        # The same run, checkpointed by two different sweeps: the second sweep
        # skipped it and rebuilt it from disk, and the rows must not differ.
        run = result(status="NO_LAND", reason="security_risk")
        first = self.directory / "first.jsonl"
        second = self.directory / "second.jsonl"
        record_run(first, 42, run)
        record_run(second, 42, run)
        self.assertEqual(
            build_replay_row(exported_row(), load_checkpoint(first)[42]),
            build_replay_row(exported_row(), load_checkpoint(second)[42]),
        )

    def test_the_merger_takes_cells_not_a_run_result(self):
        # Passing a RunResult where an entry belongs must fail loudly rather
        # than quietly producing a row with four blank columns.
        with self.assertRaises(AttributeError):
            build_replay_row(exported_row(), result())

    def test_the_merger_ignores_everything_but_the_four_columns(self):
        entry = {
            **cells_for(result(status="NO_LAND")),
            "cost_usd": 0.41,
            "pr_number": 999,
            "not_a_column": "junk",
        }
        row = build_replay_row(exported_row(), entry)
        self.assertEqual(set(row), set(REPLAY_COLUMNS))
        self.assertEqual(row["new_decision"], "NO_LAND")

    def test_an_entry_missing_a_column_renders_blank_rather_than_raising(self):
        row = build_replay_row(exported_row(), {"new_decision": "LAND"})
        self.assertEqual(row["new_decision"], "LAND")
        self.assertEqual(row["new_decision_reason"], "")

    def test_the_callers_entry_is_not_modified(self):
        entry = cells_for(result())
        before = dict(entry)
        build_replay_row(exported_row(), entry)
        self.assertEqual(entry, before)


class TestTheWrittenFile(unittest.TestCase):
    """The writing is delegated, not reimplemented, so the BOM, the atomic
    replace and the formula guard hold over the new columns too. A verdict
    message opens with a markdown bullet, which is exactly what the guard
    rewrites, so the round trip through the guard has to be exact."""

    def _write(self, rows):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "replay.csv"
        written = write_replay_csv(str(path), rows)
        return written, path

    def test_the_header_is_the_replay_shape(self):
        _, path = self._write([replayed(exported_row(), result())])
        with open(path, newline="", encoding="utf-8-sig") as handle:
            self.assertEqual(next(csv.reader(handle)), REPLAY_COLUMNS)

    def test_the_bom_survives_the_delegation(self):
        _, path = self._write([replayed(exported_row(), result())])
        self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_the_row_count_is_returned(self):
        rows = [
            replayed(exported_row(), result()),
            replayed(exported_row(), failed(Outcome.TIMEOUT)),
        ]
        written, _ = self._write(rows)
        self.assertEqual(written, 2)

    def test_a_bullet_led_multiline_message_round_trips_byte_for_byte(self):
        row = replayed(exported_row(), result())
        _, path = self._write([row])
        [parsed] = load_rows(path)
        self.assertEqual(parsed["new_decision_message"], VERDICT_MESSAGE)

    def test_the_crlf_inside_the_message_is_not_rewritten(self):
        row = replayed(exported_row(), result())
        _, path = self._write([row])
        [parsed] = load_rows(path)
        self.assertIn("\r\n", parsed["new_decision_message"])
        self.assertIn("\n- The test", parsed["new_decision_message"])

    def test_the_guard_is_on_disk_and_comes_off_on_read(self):
        row = replayed(exported_row(), result())
        _, path = self._write([row])
        with open(path, newline="", encoding="utf-8-sig") as handle:
            [raw] = list(csv.DictReader(handle))
        self.assertTrue(raw["new_decision_message"].startswith("'-"))
        self.assertEqual(unguard(raw["new_decision_message"]), VERDICT_MESSAGE)

    def test_a_failure_row_reads_back_with_its_outcome_intact(self):
        row = replayed(
            exported_row(), failed(Outcome.SCHEMA_INVALID, error="missing 'reason'")
        )
        _, path = self._write([row])
        [parsed] = load_rows(path)
        self.assertEqual(
            parsed["new_decision_reason"], HARNESS_REASON_PREFIX + "schema_invalid"
        )
        self.assertEqual(parsed["new_decision"], "")
        self.assertIn("missing 'reason'", parsed["new_decision_message"])

    def test_the_exported_cells_are_unchanged_by_the_trip(self):
        original = exported_row()
        _, path = self._write([replayed(original, result())])
        [parsed] = load_rows(path)
        for column in COLUMNS:
            with self.subTest(column=column):
                self.assertEqual(parsed[column], original[column])


class TestTheFacadeForwardsRatherThanCopies(unittest.TestCase):
    """``sweep`` and ``__main__`` import these names from ``emit``. Every one of
    them must be the object the owning module defines, not a copy: a name that
    drifts leaves two modules holding different ideas of the same behaviour, and
    the caller cannot tell which it got."""

    def test_every_exported_name_exists(self):
        missing = [name for name in emit.__all__ if not hasattr(emit, name)]
        self.assertEqual(missing, [])

    def test_every_re_export_is_the_same_object_as_its_source(self):
        forwarded = 0
        for name in emit.__all__:
            for source in (checkpoint_module, verdict_cells):
                if not hasattr(source, name):
                    continue
                with self.subTest(name=name, source=source.__name__):
                    self.assertIs(getattr(emit, name), getattr(source, name))
                forwarded += 1
        # Guards the check itself: an __all__ that stopped naming anything
        # forwarded would pass the loop above by iterating over nothing.
        self.assertGreater(forwarded, 5)

    def test_the_names_the_cli_imports_are_all_exported(self):
        # These are the names sweep.py and __main__.py reach for. Dropping one
        # from the facade breaks a module this package cannot see from here.
        for name in (
            "append_checkpoint",
            "build_replay_row",
            "HARNESS_REASON_PREFIX",
            "load_checkpoint",
            "matching_entries",
            "write_replay_csv",
        ):
            with self.subTest(name=name):
                self.assertIn(name, emit.__all__)

    def test_the_row_builder_and_the_writer_are_this_module_s_own(self):
        for name in ("build_replay_row", "write_replay_csv", "REPLAY_COLUMNS"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(checkpoint_module, name))
                self.assertFalse(hasattr(verdict_cells, name))


if __name__ == "__main__":
    unittest.main()
