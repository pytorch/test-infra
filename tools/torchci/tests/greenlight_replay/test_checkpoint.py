"""Tests for the durable record of what a sweep has already paid for.

Every case goes through a real file. The properties defended are that a crash
loses only the run in flight, that a resumed entry can prove it belongs to the
row it is about to be merged into, and that what rides beside the cells never
reaches the CSV.
"""

import csv
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from emit_fixtures import (  # noqa: E402
    exported_row,
    failed,
    FAILED_OUTCOMES,
    HEAD_SHA,
    LINE_SEPARATOR,
    OTHER_HEAD_SHA,
    Outcome,
    record_run,
    replayed,
    result,
    VERDICT_MESSAGE,
)
from torchci.greenlight_replay.checkpoint import (
    append_checkpoint,
    CHECKPOINT_IDENTITY_FIELDS,
    CHECKPOINT_PR_KEY,
    load_checkpoint,
    matching_entries,
    RUN_METRIC_FIELDS,
)
from torchci.greenlight_replay.emit import (
    build_replay_row,
    HARNESS_REASON_PREFIX,
    NEW_COLUMNS,
    REPLAY_COLUMNS,
    write_replay_csv,
)


class TestCheckpoint(unittest.TestCase):
    """A replay is hours of paid model time, so a crash must cost the run in
    flight and nothing already bought. Every finished pull request is on disk
    before the next one starts, and --resume rebuilds its cells from there
    rather than paying for them again."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "checkpoint.jsonl"

    def test_a_missing_file_is_an_empty_checkpoint(self):
        self.assertEqual(load_checkpoint(self.path), {})

    def test_a_finished_pull_request_round_trips(self):
        record_run(self.path, 192258, result(status="NO_LAND"))
        loaded = load_checkpoint(self.path)
        self.assertEqual(list(loaded), [192258])
        self.assertEqual(loaded[192258]["new_decision"], "NO_LAND")
        self.assertEqual(loaded[192258]["new_decision_message"], VERDICT_MESSAGE)

    def test_an_entry_holds_the_columns_the_identity_and_the_metrics(self):
        record_run(self.path, 1, result())
        [entry] = load_checkpoint(self.path).values()
        self.assertEqual(
            set(entry),
            set(NEW_COLUMNS) | set(CHECKPOINT_IDENTITY_FIELDS) | set(RUN_METRIC_FIELDS),
        )

    def test_the_loaded_entry_reconstructs_the_row(self):
        record_run(self.path, 192258, result(status="NO_LAND"))
        resumed = build_replay_row(exported_row(), load_checkpoint(self.path)[192258])
        self.assertEqual(resumed, replayed(exported_row(), result(status="NO_LAND")))

    def test_each_pull_request_is_durable_before_the_next_one_starts(self):
        record_run(self.path, 1, result())
        after_first = load_checkpoint(self.path)
        record_run(self.path, 2, failed(Outcome.TIMEOUT))
        after_second = load_checkpoint(self.path)
        self.assertEqual(list(after_first), [1])
        self.assertEqual(list(after_second), [1, 2])
        self.assertEqual(after_second[1], after_first[1])

    def test_resume_skips_what_is_already_recorded(self):
        for pr_number in (101, 102):
            record_run(self.path, pr_number, result())
        done = load_checkpoint(self.path)
        remaining = [pr for pr in (101, 102, 103) if pr not in done]
        self.assertEqual(remaining, [103])

    def test_a_rerun_pull_request_keeps_its_later_result(self):
        record_run(self.path, 7, failed(Outcome.TIMEOUT))
        record_run(self.path, 7, result(status="LAND"))
        self.assertEqual(load_checkpoint(self.path)[7]["new_decision"], "LAND")

    def test_a_multiline_message_stays_on_one_line(self):
        record_run(self.path, 1, result())
        self.assertEqual(len(self.path.read_text(encoding="utf-8").splitlines()), 1)

    def test_a_line_separator_in_the_prose_does_not_split_the_record(self):
        # str.splitlines() breaks on U+2028; reading the file line by line does
        # not, which is why the loader does the latter.
        prose = f"one{LINE_SEPARATOR}two"
        self.assertEqual(len(prose.splitlines()), 2)
        record_run(self.path, 1, result(message=prose))
        self.assertEqual(load_checkpoint(self.path)[1]["new_decision_message"], prose)

    def test_a_truncated_final_line_does_not_block_the_resume(self):
        record_run(self.path, 1, result())
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write('{"pr_number": 2, "new_dec')
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            loaded = load_checkpoint(self.path)
        self.assertEqual(list(loaded), [1])

    def test_a_line_without_a_pull_request_number_is_reported_not_guessed(self):
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"new_decision": "LAND"}) + "\n")
        with self.assertLogs(
            "torchci.greenlight_replay.checkpoint", level="WARNING"
        ) as logs:
            self.assertEqual(load_checkpoint(self.path), {})
        self.assertIn("line 1", logs.output[0])

    def test_a_blank_line_is_not_an_error(self):
        record_run(self.path, 1, result())
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write("\n")
        self.assertEqual(list(load_checkpoint(self.path)), [1])

    def test_the_key_the_records_are_written_under_is_the_one_read_back(self):
        record_run(self.path, 5, result())
        [raw] = [
            json.loads(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(raw[CHECKPOINT_PR_KEY], 5)
        self.assertEqual(list(load_checkpoint(self.path)), [5])


class TestRunMetrics(unittest.TestCase):
    """A successful run spends nothing on diagnostics in its message, so the
    checkpoint is the only place its cost survives. A resumed sweep re-reads the
    runs it skipped rather than re-running them, so without these it could not
    say what the sweep cost -- and the skipped runs are exactly the paid ones.
    They ride beside the cells and must never reach the file, whose shape is
    fixed at the export's columns plus four."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "checkpoint.jsonl"

    def test_the_metrics_survive_as_numbers_not_strings(self):
        record_run(
            self.path, 1, result(cost_usd=0.4231, duration_s=512.7, num_turns=11)
        )
        entry = load_checkpoint(self.path)[1]
        self.assertEqual(entry["cost_usd"], 0.4231)
        self.assertEqual(entry["duration_s"], 512.7)
        self.assertEqual(entry["num_turns"], 11)

    def test_a_resumed_sweep_can_total_what_it_spent(self):
        record_run(self.path, 1, result(cost_usd=0.40))
        record_run(self.path, 2, failed(Outcome.BUDGET_TRIP, cost_usd=8.0))
        entries = load_checkpoint(self.path).values()
        self.assertAlmostEqual(sum(e["cost_usd"] for e in entries), 8.40)

    def test_a_failed_run_still_records_what_it_burned(self):
        record_run(self.path, 1, failed(Outcome.TIMEOUT, cost_usd=1.25))
        self.assertEqual(load_checkpoint(self.path)[1]["cost_usd"], 1.25)

    def test_a_metric_that_is_not_a_number_is_dropped_not_coerced(self):
        # A total short an entry it can name beats one wrong by an entry it
        # guessed at.
        record_run(self.path, 1, result(cost_usd=None, num_turns="eleven"))
        entry = load_checkpoint(self.path)[1]
        self.assertNotIn("cost_usd", entry)
        self.assertNotIn("num_turns", entry)
        self.assertIn("duration_s", entry)

    def test_a_boolean_is_not_mistaken_for_a_number(self):
        # bool passes isinstance(x, int); a True summed into a cost is a dollar.
        record_run(self.path, 1, result(cost_usd=True))
        self.assertNotIn("cost_usd", load_checkpoint(self.path)[1])

    def test_a_result_with_no_metrics_at_all_still_checkpoints(self):
        record_run(self.path, 1, SimpleNamespace())
        entry = load_checkpoint(self.path)[1]
        self.assertEqual(set(entry) & set(RUN_METRIC_FIELDS), set())
        self.assertTrue(entry["new_decision_reason"])

    def test_the_metrics_never_reach_the_row(self):
        record_run(self.path, 1, result())
        row = build_replay_row(exported_row(), load_checkpoint(self.path)[1])
        self.assertEqual(set(row) & set(RUN_METRIC_FIELDS), set())

    def test_the_metrics_never_reach_the_file(self):
        record_run(self.path, 1, result())
        row = build_replay_row(exported_row(), load_checkpoint(self.path)[1])
        output = self.path.parent / "replay.csv"
        write_replay_csv(str(output), [row])
        with open(output, newline="", encoding="utf-8-sig") as handle:
            self.assertEqual(next(csv.reader(handle)), REPLAY_COLUMNS)
        self.assertNotIn("cost_usd", output.read_text(encoding="utf-8-sig"))


class TestTheDegradedCheckReadsTheCheckpoint(unittest.TestCase):
    """The CLI decides whether a sweep is trustworthy by counting entries with
    an empty new_decision, and it counts them off the checkpoint rather than off
    anything held in memory -- an interrupted sweep still has to be judged. So
    "this run reached no verdict" has to be answerable from a loaded entry
    alone, with no RunResult and no CSV in hand."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "checkpoint.jsonl"

    def test_a_failed_run_is_countable_as_empty_from_the_entry(self):
        for index, outcome in enumerate(FAILED_OUTCOMES):
            record_run(self.path, index, failed(outcome))
        entries = load_checkpoint(self.path).values()
        self.assertEqual(
            sum(1 for entry in entries if not entry["new_decision"]),
            len(FAILED_OUTCOMES),
        )

    def test_a_successful_run_is_not_counted(self):
        record_run(self.path, 1, result(status="LAND"))
        record_run(self.path, 2, result(status="NO_LAND"))
        entries = load_checkpoint(self.path).values()
        self.assertEqual(sum(1 for entry in entries if not entry["new_decision"]), 0)

    def test_a_recovered_verdict_counts_as_a_verdict(self):
        # A budget trip whose verdict was recovered from the turn record is work
        # that was paid for and kept. It counts as a verdict for the ratio, and
        # it carries the policy's reason rather than the harness prefix.
        record_run(
            self.path,
            1,
            result(outcome=Outcome.BUDGET_TRIP, status="NO_LAND", reason="clean"),
        )
        entry = load_checkpoint(self.path)[1]
        self.assertEqual(entry["new_decision"], "NO_LAND")
        self.assertEqual(entry["new_decision_reason"], "clean")

    def test_a_trip_that_recovered_nothing_still_counts_as_a_failure(self):
        record_run(self.path, 1, failed(Outcome.BUDGET_TRIP))
        entry = load_checkpoint(self.path)[1]
        self.assertEqual(entry["new_decision"], "")
        self.assertTrue(entry["new_decision_reason"].startswith(HARNESS_REASON_PREFIX))


class TestAnEntryMustProveItBelongsToItsRow(unittest.TestCase):
    """A pull request number is not an identity. Re-export the corpus between a
    crash and a resume -- the obvious thing to do -- and the same number can name
    a newer verdict against a different head. Reusing the stored cells there
    prints a verdict the reviewer produced for one head beside a decision
    belonging to another: a policy flip that never happened, in the column pair
    the tool exists to produce, and nothing else in the file could contradict it.

    So an entry carries the input it was computed from, and is reused only when
    that input is the row's input."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "checkpoint.jsonl"

    def recorded(self, **row_overrides):
        record_run(self.path, 900, result(status="LAND"), **row_overrides)
        return load_checkpoint(self.path)

    def test_the_entry_records_what_the_verdict_was_computed_from(self):
        entry = self.recorded()[900]
        self.assertEqual(entry["repo"], "pytorch/pytorch")
        self.assertEqual(entry["base_ref"], "main")
        self.assertEqual(entry["decision_head_sha"], HEAD_SHA)

    def test_an_entry_for_the_same_input_is_reused(self):
        row = exported_row(pr_number="900")
        self.assertEqual(list(matching_entries([row], self.recorded())), [900])

    def test_an_entry_for_a_different_head_is_not_reused(self):
        # The demonstrated failure: the corpus was re-exported between the crash
        # and the resume, and PR 900 now carries a newer verdict against a head
        # the reviewer never saw. Reusing here is the fabricated flip.
        moved = exported_row(pr_number="900", decision_head_sha=OTHER_HEAD_SHA)
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            self.assertEqual(matching_entries([moved], self.recorded()), {})

    def test_an_entry_for_a_different_base_is_not_reused(self):
        # Same head, different base: base_ref...head is a different diff.
        retargeted = exported_row(pr_number="900", base_ref="release/2.14")
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            self.assertEqual(matching_entries([retargeted], self.recorded()), {})

    def test_an_entry_for_a_different_repository_is_not_reused(self):
        elsewhere = exported_row(pr_number="900", repo="pytorch/vision")
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            self.assertEqual(matching_entries([elsewhere], self.recorded()), {})

    def test_the_mismatch_names_the_field_that_moved(self):
        moved = exported_row(pr_number="900", decision_head_sha=OTHER_HEAD_SHA)
        with self.assertLogs(
            "torchci.greenlight_replay.checkpoint", level="WARNING"
        ) as logs:
            matching_entries([moved], self.recorded())
        [message] = logs.output
        self.assertIn(HEAD_SHA, message)
        self.assertIn(OTHER_HEAD_SHA, message)

    def test_a_mismatched_pull_request_is_left_pending(self):
        # What the CLI does with the result: absent from the match means it is
        # re-run, which is the whole point of refusing to reuse it.
        moved = exported_row(pr_number="900", decision_head_sha=OTHER_HEAD_SHA)
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            reusable = matching_entries([moved], self.recorded())
        pending = [row for row in [moved] if int(row["pr_number"]) not in reusable]
        self.assertEqual(pending, [moved])

    def test_an_entry_that_recorded_no_identity_is_not_reused(self):
        # Written before the identity existed: it cannot prove anything either
        # way, and the wrong answer costs more than paying for the run again.
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"pr_number": 900, "new_decision": "LAND"}) + "\n")
        row = exported_row(pr_number="900")
        with self.assertLogs(
            "torchci.greenlight_replay.checkpoint", level="WARNING"
        ) as logs:
            self.assertEqual(matching_entries([row], load_checkpoint(self.path)), {})
        self.assertIn("did not record", logs.output[0])

    def test_an_entry_outside_the_sample_is_kept_on_disk_not_discarded(self):
        recorded = self.recorded()
        other = exported_row(pr_number="901")
        self.assertEqual(matching_entries([other], recorded), {})
        self.assertIn(900, load_checkpoint(self.path))

    def test_a_duplicated_pull_request_number_is_reported(self):
        # Two exports concatenated. The checkpoint holds one entry per number, so
        # these rows cannot both be reused; the run directory they share is the
        # CLI's problem, but the collision must not be silent.
        row = exported_row(pr_number="900")
        with self.assertLogs(
            "torchci.greenlight_replay.checkpoint", level="WARNING"
        ) as logs:
            matching_entries([row, row], self.recorded())
        self.assertTrue(any("more than once" in line for line in logs.output))

    def test_a_matching_entry_still_builds_the_row_it_always_did(self):
        row = exported_row(pr_number="900")
        entry = matching_entries([row], self.recorded())[900]
        self.assertEqual(build_replay_row(row, entry)["new_decision"], "LAND")

    def test_the_identity_never_reaches_the_row(self):
        row = exported_row(pr_number="900")
        entry = matching_entries([row], self.recorded())[900]
        built = build_replay_row(row, entry)
        self.assertEqual(set(built), set(REPLAY_COLUMNS))
        # repo and base_ref are export columns in their own right, and must keep
        # the row's values rather than the ones the entry carries for matching.
        self.assertEqual(built["repo"], row["repo"])
        self.assertEqual(built["decision_head_sha"], row["decision_head_sha"])

    def test_the_fabricated_flip_cannot_reach_the_file(self):
        # End to end: run 1 reviews aaaa and stores LAND; the corpus is
        # re-exported and PR 900 is now NO_LAND at bbbb; a resume must not pair
        # the stored LAND with the new row.
        self.recorded()
        reexported = exported_row(
            pr_number="900",
            decision="NO_LAND",
            decision_head_sha=OTHER_HEAD_SHA,
        )
        with self.assertLogs("torchci.greenlight_replay.checkpoint", level="WARNING"):
            results = matching_entries([reexported], load_checkpoint(self.path))
        rows = [
            build_replay_row(row, results[int(row["pr_number"])])
            for row in [reexported]
            if int(row["pr_number"]) in results
        ]
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
