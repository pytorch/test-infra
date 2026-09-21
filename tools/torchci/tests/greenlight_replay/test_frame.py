"""Tests for the replay frame: narrowing the export, re-deriving it, and sampling it.

Reading the file back is :mod:`torchci.greenlight_replay.cells` and placing a pull request
in time is :mod:`torchci.greenlight_replay.timeline`; both are tested in their own modules.
The one case here that goes through a real CSV is the size-gate match, which is where frame
and cells have to agree.

``rederive_first_landing`` drives the real ``fetch_decisions`` through a fake client, so
the query text and the parameter binding are exercised rather than stubbed out. The one
reach that is patched is the GitHub compare call behind ``compute_loc``; nothing here
touches either service.
"""

import json
import random
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from torchci.greenlight_decisions.query import FIELDS
from torchci.greenlight_decisions.rows import COLUMNS, write_csv
from torchci.greenlight_replay import cells, frame, timeline


CANNED_OLD, CANNED_NEW = sorted(frame.CANNED_TOO_LARGE_MESSAGES, key=len)

REPO = "pytorch/pytorch"

FIRST_LANDING = datetime(2026, 8, 26, 22, 21, 4)
SECOND_LANDING = datetime(2026, 8, 31, 23, 48, 4)
REVERTED_AT = datetime(2026, 8, 28, 0, 16, 13)

# <repo>/tools/torchci/tests/greenlight_replay/test_frame.py
TOO_LARGE_VERDICT = (
    Path(__file__).resolve().parents[4]
    / ".claude"
    / "hooks"
    / "greenlight"
    / "too-large-verdict.json"
)


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def named_results(self):
        return iter(self._rows)


class FakeClient:
    """Stands in for a clickhouse_connect client; records the bound parameters."""

    def __init__(self, rows):
        self.rows = rows
        self.sql = None
        self.parameters = None

    def query(self, sql, parameters=None):
        self.sql = sql
        self.parameters = parameters
        return FakeResult(self.rows)


def csv_row(**overrides):
    """A loaded row: every published column, filled in as a landed, decided PR."""
    row = dict.fromkeys(COLUMNS, "")
    row.update(
        {
            "repo": REPO,
            "pr_number": "194379",
            "landed": "true",
            "lifecycle_status": "decided",
            "decision": "LAND",
            "decision_reason": "clean",
            "decision_message": "Test-only change. Nothing else moved.",
            "decision_summary": "Test-only change.",
            "decision_version": "2026-08-26T12:00:00.000Z",
            "decision_head_sha": "a" * 40,
            "final_head_sha": "b" * 40,
            "base_sha": "c" * 40,
            "verdict_staleness": "exact",
        }
    )
    row.update(overrides)
    return row


def decision_record(**overrides):
    """A raw ClickHouse row of the shape fetch_decisions reads."""
    row = dict.fromkeys(FIELDS, "")
    row.update(
        {
            "repo": REPO,
            "pr_number": "194379",
            "pr_status": "closed-merged",
            "landed": 1,
            "reverted": 1,
            "is_shadow": 0,
            "verdict_flipped": 1,
            "n_terminal_decisions": "3",
            "human_approvals": "1",
            "human_changes_requested": "0",
            "additions": "16",
            "deletions": "4",
            "changed_files": "2",
            "decision": "LAND",
            "decision_reason": "clean",
            "decision_message": "Judged at the first landing. Details follow.",
            "decision_head_sha": "d" * 40,
            "decision_run_id": "17654321",
            "decision_version": datetime(2026, 8, 26, 9, 12, 33, 289000),
            "lifecycle_status": "decided",
            "landed_via_trailer": 1,
        }
    )
    row.update(overrides)
    return row


def landed_once(pr=194379):
    return {pr: [frame.Landing(frame.LAND, "e" * 40, FIRST_LANDING)]}


def landed_twice(pr=194379):
    return {
        pr: [
            frame.Landing(frame.LAND, "e" * 40, FIRST_LANDING),
            frame.Landing(frame.REVERT, "f" * 40, REVERTED_AT),
            frame.Landing(frame.LAND, "0" * 40, SECOND_LANDING),
        ]
    }


class TestReExports(unittest.TestCase):
    """Callers meet the whole frame surface through this module -- __main__ imports
    load_rows, fetch_landings and LAND from it -- so splitting cells and timeline out of it
    must not move any of them out from under those callers."""

    def test_the_names_taken_from_cells_are_the_same_objects(self):
        self.assertIs(frame.load_rows, cells.load_rows)

    def test_the_names_taken_from_timeline_are_the_same_objects(self):
        for name in ("fetch_first_verdicts", "fetch_landings", "LAND", "Landing"):
            with self.subTest(name=name):
                self.assertIs(getattr(frame, name), getattr(timeline, name))

    def test_the_published_names_all_resolve_on_frame(self):
        # Broader than the two above on purpose: this also catches a name dropped from the
        # module outright, not only one that moved.
        for name in frame.__all__:
            with self.subTest(name=name):
                self.assertTrue(hasattr(frame, name))


class TestApplyFrame(unittest.TestCase):
    """The frame admits only rows a replay can be read against an outcome, and charges
    every rejected row to exactly one stage so the counters partition the input."""

    def frame_one(self, row, landings=None, first_verdicts=None):
        kept, stats = frame.apply_frame(
            [row],
            landed_once() if landings is None else landings,
            {} if first_verdicts is None else first_verdicts,
        )
        return bool(kept), stats

    def test_an_unlanded_row_is_dropped(self):
        kept, stats = self.frame_one(csv_row(landed="false"))
        self.assertFalse(kept)
        self.assertEqual(stats["not_landed"], 1)

    def test_a_row_that_never_reached_a_verdict_is_dropped(self):
        for status in ("never-reviewed", "in-flight", "failed", ""):
            with self.subTest(lifecycle_status=status):
                kept, stats = self.frame_one(csv_row(lifecycle_status=status))
                self.assertFalse(kept)
                self.assertEqual(stats["not_decided"], 1)

    def test_a_single_landing_row_is_kept_only_when_its_verdict_is_not_stale(self):
        for staleness in ("exact", "rebase-only"):
            with self.subTest(verdict_staleness=staleness):
                kept, _ = self.frame_one(csv_row(verdict_staleness=staleness))
                self.assertTrue(kept)
        for staleness in ("content-changed", "not-measured", "none", ""):
            with self.subTest(verdict_staleness=staleness):
                kept, stats = self.frame_one(csv_row(verdict_staleness=staleness))
                self.assertFalse(kept)
                self.assertEqual(stats["stale"], 1)

    def test_a_multi_landing_row_is_kept_whatever_its_staleness_says(self):
        # verdict_staleness compares the judged head against the PR's final head, which
        # for these rows belongs to the last landing rather than the one being replayed.
        # 194379, 193632 and 193149 all read content-changed and all carry a verdict that
        # covered their first landing (measured 2026-09-18). csv_row's decision_version
        # predates FIRST_LANDING, so these pass the admission gate on the fallback alone.
        for staleness in ("content-changed", "not-measured", ""):
            with self.subTest(verdict_staleness=staleness):
                kept, stats = self.frame_one(
                    csv_row(verdict_staleness=staleness), landed_twice()
                )
                self.assertTrue(kept)
                self.assertEqual(stats["stale"], 0)
                self.assertEqual(stats["multi_landing"], 1)

    def test_a_multi_landing_row_greenlight_only_saw_afterwards_is_dropped(self):
        # The real shape: a PR that first landed before greenlight covered it, was
        # reverted, reopened, reviewed and re-landed. Its verdict postdates the first
        # landing, so fetch_decisions at that cutoff finds nothing to re-derive -- which
        # without this gate is a LookupError that kills the whole sweep, --dry-run
        # included, rather than one dropped row.
        after = {194379: SECOND_LANDING}
        kept, stats = self.frame_one(
            csv_row(decision_version="2026-08-31T23:48:04.000Z"),
            landed_twice(),
            first_verdicts=after,
        )
        self.assertFalse(kept)
        self.assertEqual(stats["no_verdict_at_first_landing"], 1)
        self.assertEqual(stats["multi_landing"], 0)

    def test_the_gate_reads_the_earliest_verdict_not_the_selected_one(self):
        # 194772 and 194773 are exactly this: the selected verdict postdates the first
        # landing while an earlier verdict covers it. Held to decision_version alone they
        # would be dropped, which is a third of the multi-landing population thrown away
        # for no reason (measured 2026-09-18).
        late_selection = csv_row(decision_version="2026-08-28T15:30:11.837Z")
        dropped, _ = self.frame_one(late_selection, landed_twice())
        self.assertFalse(dropped, "the fallback alone cannot admit this row")

        kept, stats = self.frame_one(
            late_selection,
            landed_twice(),
            first_verdicts={194379: datetime(2026, 8, 25, 19, 14, 21)},
        )
        self.assertTrue(kept)
        self.assertEqual(stats["multi_landing"], 1)

    def test_the_fallback_can_only_drop_rows_never_admit_a_hopeless_one(self):
        # decision_version is a real verdict instant, so a row it admits provably has a
        # verdict at the cutoff and re-derivation cannot come back empty. Supplying the
        # mapping buys back rows; it does not buy correctness.
        early = csv_row(decision_version="2026-08-01T00:00:00.000Z")
        self.assertTrue(self.frame_one(early, landed_twice())[0])
        self.assertTrue(
            self.frame_one(
                early, landed_twice(), first_verdicts={194379: FIRST_LANDING}
            )[0]
        )

    def test_a_multi_landing_row_with_a_blank_verdict_time_is_dropped(self):
        kept, stats = self.frame_one(csv_row(decision_version=""), landed_twice())
        self.assertFalse(kept)
        self.assertEqual(stats["no_verdict_at_first_landing"], 1)

    def test_an_unreadable_verdict_time_is_dropped_and_logged(self):
        # Not silently read as "no verdict": a malformed cell is a corrupt file, and the
        # operator needs to see which row rather than a funnel count that looks ordinary.
        with self.assertLogs(frame.logger, level="WARNING"):
            kept, stats = self.frame_one(
                csv_row(decision_version="last tuesday"), landed_twice()
            )
        self.assertFalse(kept)
        self.assertEqual(stats["no_verdict_at_first_landing"], 1)

    def test_a_revert_does_not_count_as_a_landing(self):
        # A PR that landed once and was reverted has two events and one landing, so it
        # stays on the staleness test rather than being waved through as multi-landing.
        one_land_one_revert = {
            194379: [
                frame.Landing(frame.LAND, "e" * 40, FIRST_LANDING),
                frame.Landing(frame.REVERT, "f" * 40, REVERTED_AT),
            ]
        }
        kept, stats = self.frame_one(
            csv_row(verdict_staleness="content-changed"), one_land_one_revert
        )
        self.assertFalse(kept)
        self.assertEqual(stats["stale"], 1)

    def test_a_pr_with_no_recorded_landing_stays_on_the_staleness_test(self):
        # landed can be true off GitHub's merged flag alone -- release-branch PRs land by
        # merge button and leave no trailer on main -- so an empty landing list is a real
        # case, and the conservative branch is the right one for it.
        kept, _ = self.frame_one(csv_row(verdict_staleness="exact"), {})
        self.assertTrue(kept)
        kept, stats = self.frame_one(csv_row(verdict_staleness="content-changed"), {})
        self.assertFalse(kept)
        self.assertEqual(stats["stale"], 1)

    def test_the_counters_partition_the_input(self):
        rows = [
            csv_row(pr_number="1", landed="false"),
            csv_row(pr_number="2", lifecycle_status="failed"),
            csv_row(pr_number="3", decision_message=CANNED_NEW),
            csv_row(pr_number="4", verdict_staleness="content-changed"),
            csv_row(pr_number="5"),
            csv_row(pr_number="not a number"),
        ]
        with self.assertLogs(frame.logger, level="WARNING"):
            kept, stats = frame.apply_frame(rows, {})
        dropped = sum(
            stats[stage]
            for stage in frame.FUNNEL_STAGES
            if stage not in ("input", "kept", "multi_landing")
        )
        self.assertEqual(stats["input"], len(rows))
        self.assertEqual(stats["kept"], len(kept))
        self.assertEqual(dropped + stats["kept"], stats["input"])

    def test_every_funnel_stage_is_reported_even_at_zero(self):
        _, stats = frame.apply_frame([], {})
        self.assertEqual(set(stats), set(frame.FUNNEL_STAGES))

    def test_kept_rows_hold_their_input_order_and_identity(self):
        rows = [csv_row(pr_number=str(number)) for number in (3, 1, 2)]
        kept, _ = frame.apply_frame(rows, {})
        self.assertEqual([row["pr_number"] for row in kept], ["3", "1", "2"])
        self.assertIs(kept[0], rows[0])

    def test_an_unreadable_pr_number_is_dropped_and_counted(self):
        # Nothing downstream can name the row: the landings lookup, the re-derivation and
        # the sweep all key on this cell, and the sweep's own reader is a bare int() that
        # would raise mid-run. Charging it to a later stage would hide a corrupt file as an
        # ordinary drop, so it is rejected first and gets its own counter.
        with self.assertLogs(frame.logger, level="WARNING"):
            kept, stats = self.frame_one(csv_row(pr_number="not a number"))
        self.assertFalse(kept)
        self.assertEqual(stats["unreadable_pr_number"], 1)
        self.assertEqual(stats["not_landed"], 0)

    def test_an_unreadable_pr_number_outranks_every_other_defect(self):
        # It is charged first precisely so a corrupt cell cannot hide behind a row that
        # also happens to be unlanded.
        with self.assertLogs(frame.logger, level="WARNING"):
            _, stats = self.frame_one(csv_row(pr_number="", landed="false"))
        self.assertEqual(stats["unreadable_pr_number"], 1)
        self.assertEqual(stats["not_landed"], 0)


class TestVerdictTimeParsing(unittest.TestCase):
    """decision_version is written with a trailing Z, and a bare Z only parses natively on
    Python 3.11+. The repo's ruff target is py38, so the suffix is rewritten to +00:00
    before parsing rather than relying on the interpreter. Dropping that rewrite would not
    fail here on a modern host -- it would fail on an older one, by misreading the frame."""

    def test_a_z_suffixed_cell_parses_to_the_instant_it_names(self):
        self.assertEqual(
            frame._verdict_time({"decision_version": "2026-08-26T12:00:00.289Z"}),
            datetime(2026, 8, 26, 12, 0, 0, 289000),
        )

    def test_the_rewrite_is_explicit_rather_than_left_to_the_interpreter(self):
        # The one assertion that still holds on a host where the bare Z would have parsed
        # anyway: the module names the substitution it performs.
        self.assertEqual(frame._CELL_UTC_SUFFIX, "Z")
        self.assertEqual(frame._CELL_UTC_OFFSET, "+00:00")

    def test_an_offset_cell_is_converted_rather_than_relabelled(self):
        self.assertEqual(
            frame._verdict_time({"decision_version": "2026-08-26T14:00:00.289+02:00"}),
            datetime(2026, 8, 26, 12, 0, 0, 289000),
        )

    def test_the_result_is_naive_so_it_compares_against_a_landing(self):
        # Landings come back naive UTC; one aware operand here raises TypeError mid-frame.
        parsed = frame._verdict_time({"decision_version": "2026-08-26T12:00:00.000Z"})
        self.assertIsNone(parsed.tzinfo)
        self.assertLess(parsed, FIRST_LANDING)

    def test_what_the_export_writes_is_what_this_reads(self):
        # Pinned against the writer rather than a hand-typed literal, so a change to the
        # cell format shows up here instead of silently defeating the admission gate.
        written = cells.to_cell(datetime(2026, 8, 26, 12, 0, 0, 289000))
        self.assertEqual(
            frame._verdict_time({"decision_version": written}),
            datetime(2026, 8, 26, 12, 0, 0, 289000),
        )


class TestSizeGateDeclines(unittest.TestCase):
    """A canned scope_too_large verdict means the diff-size gate declined the PR and no
    model ran, so replaying it measures the gate's arithmetic rather than the policy. The
    reason code does not separate those from the model's own judgement: over the full
    export on 2026-09-18, 18 rows carry the reason and only 12 carry canned text."""

    def kept(self, row):
        admitted, _ = frame.apply_frame([row], {})
        return bool(admitted)

    def test_both_canned_variants_are_excluded(self):
        for message in frame.CANNED_TOO_LARGE_MESSAGES:
            with self.subTest(message=message[:40]):
                row = csv_row(
                    decision="NO_LAND",
                    decision_reason="scope_too_large",
                    decision_message=message,
                )
                self.assertFalse(self.kept(row))

    def test_the_constant_carries_exactly_two_variants(self):
        # 51c10bcf0 rewrote the wording; rows exist on both sides of it.
        self.assertEqual(len(frame.CANNED_TOO_LARGE_MESSAGES), 2)

    def test_both_variants_survive_a_real_csv_into_the_match(self):
        # The one place frame and cells have to agree: the membership test runs against
        # loaded text. Only the newer variant opens with "-", so only it reaches the file
        # apostrophe-guarded -- a reader that left the guard on would miss every row
        # written since 51c10bcf0 and pass on every row written before it, which is what
        # would make the bug survivable in a spot check.
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "decisions.csv")
            write_csv(
                path, [csv_row(decision_message=m) for m in (CANNED_OLD, CANNED_NEW)]
            )
            loaded = frame.load_rows(path)
        self.assertEqual(
            [row["decision_message"] for row in loaded], [CANNED_OLD, CANNED_NEW]
        )
        kept, stats = frame.apply_frame(loaded, {})
        self.assertEqual(kept, [])
        self.assertEqual(stats["size_gate"], 2)

    def test_a_model_authored_scope_too_large_verdict_is_kept(self):
        # Six of the eighteen are the reviewer's own prose under the same reason code, and
        # those are real verdicts the replay exists to re-run.
        row = csv_row(
            decision="NO_LAND",
            decision_reason="scope_too_large",
            decision_message=(
                "- Scope\n  - Adds ~450 lines of new machinery to "
                "`torch/utils/_config_module.py`"
            ),
        )
        self.assertTrue(self.kept(row))

    def test_the_reason_code_alone_does_not_exclude(self):
        self.assertTrue(self.kept(csv_row(decision_reason="scope_too_large")))

    def test_a_multi_landing_rows_stored_verdict_is_not_the_one_tested(self):
        # Its verdict is about to be replaced by rederive_first_landing, and the two can
        # disagree about whether a model ran at all. Settling the gate on the stored
        # verdict corrupts the frame in both directions: a PR declined by the gate at its
        # last landing but genuinely reviewed at its first would be charged to size_gate,
        # and one reviewed at its last but declined at its first would be admitted and
        # replayed -- which is the exact thing this exclusion exists to prevent.
        canned_now = csv_row(decision_message=CANNED_NEW, verdict_staleness="exact")
        admitted, stats = frame.apply_frame([canned_now], landed_twice())
        self.assertEqual(len(admitted), 1, "the stored verdict must not settle it")
        self.assertEqual(stats["size_gate"], 0)
        self.assertEqual(stats["multi_landing"], 1)

    def test_the_predicate_is_public_so_the_caller_can_settle_it_after_re_deriving(
        self,
    ):
        # apply_frame hands the multi-landing case on rather than guessing; whoever
        # finalises the row applies the same test to the verdict that will be replayed.
        self.assertTrue(
            frame.is_size_gate_decline(csv_row(decision_message=CANNED_NEW))
        )
        self.assertTrue(
            frame.is_size_gate_decline(csv_row(decision_message=CANNED_OLD))
        )
        self.assertFalse(frame.is_size_gate_decline(csv_row()))

    def test_the_predicate_tolerates_surrounding_whitespace(self):
        padded = csv_row(decision_message=f"  {CANNED_OLD}\n")
        self.assertTrue(frame.is_size_gate_decline(padded))

    def test_the_current_canned_text_still_matches_the_file_on_disk(self):
        # The gate copies this file verbatim. Rewriting it again adds a third variant, and
        # nothing else in the pipeline would notice.
        if not TOO_LARGE_VERDICT.exists():
            self.skipTest(f"{TOO_LARGE_VERDICT} is not present in this checkout")
        message = json.loads(TOO_LARGE_VERDICT.read_text())["message"]
        self.assertIn(message, frame.CANNED_TOO_LARGE_MESSAGES)


class TestRederiveFirstLanding(unittest.TestCase):
    """For a PR that landed more than once the stored verdict may describe a later
    landing, so the decision columns are re-read as of the first one. The landed commit is
    a rebase whose SHA appears nowhere in the state table, so the selection is by time."""

    MEASURED = {
        "loc": 71,
        "sig_loc": 64,
        "verdict_staleness": "exact",
        "files_changed_after_verdict": 0,
        "loc_status": "ok",
    }

    def rederive(self, row=None, records=None, measured=None):
        client = FakeClient([decision_record()] if records is None else records)
        with mock.patch.object(
            frame,
            "compute_loc",
            return_value=self.MEASURED if measured is None else measured,
        ) as compute:
            result = frame.rederive_first_landing(
                client, REPO, csv_row() if row is None else row, FIRST_LANDING
            )
        return result, client, compute

    def test_the_verdict_columns_come_from_the_earlier_snapshot(self):
        result, _, _ = self.rederive()
        self.assertEqual(
            result["decision_message"], "Judged at the first landing. Details follow."
        )
        self.assertEqual(result["decision_head_sha"], "d" * 40)
        self.assertEqual(result["decision_run_id"], "17654321")
        self.assertEqual(result["decision_version"], "2026-08-26T09:12:33.289Z")

    def test_the_summary_is_recomputed_from_the_new_message(self):
        # A derived column: left alone it would still summarise the discarded verdict.
        result, _, _ = self.rederive()
        self.assertEqual(result["decision_summary"], "Judged at the first landing.")

    def test_booleans_and_counts_render_like_the_cells_beside_them(self):
        result, _, _ = self.rederive()
        self.assertEqual(result["is_shadow"], "false")
        self.assertEqual(result["verdict_flipped"], "true")
        self.assertEqual(result["n_terminal_decisions"], "3")

    def test_an_absent_run_id_renders_blank_rather_than_none(self):
        result, _, _ = self.rederive(records=[decision_record(decision_run_id=None)])
        self.assertEqual(result["decision_run_id"], "")

    def test_the_cutoff_reaches_the_query_as_the_first_landing(self):
        # Selection is by time because the landed commit is a rebase: across the eight
        # multi-landing PRs measured 2026-09-18, none of their landed SHAs appears in
        # misc.greenlight_pr_state.head_sha, so no join on SHA can find the verdict.
        _, client, _ = self.rederive()
        self.assertEqual(client.parameters["as_of"], "2026-08-26 22:21:04.000")

    def test_the_loc_columns_describe_the_new_head(self):
        result, _, compute = self.rederive()
        compute.assert_called_once_with(REPO, "c" * 40, "d" * 40, "b" * 40)
        self.assertEqual(result["loc"], "71")
        self.assertEqual(result["sig_loc"], "64")
        self.assertEqual(result["verdict_staleness"], "exact")
        self.assertEqual(result["files_changed_after_verdict"], "0")
        self.assertEqual(result["loc_status"], "ok")

    def test_an_unmeasurable_diff_renders_blank_rather_than_zero(self):
        unmeasured = {**self.MEASURED, "loc": None, "sig_loc": None}
        result, _, _ = self.rederive(measured=unmeasured)
        self.assertEqual(result["loc"], "")
        self.assertEqual(result["sig_loc"], "")

    def test_a_missing_sha_skips_the_github_call(self):
        result, _, compute = self.rederive(
            records=[decision_record(decision_head_sha="")]
        )
        compute.assert_not_called()
        self.assertEqual(result["loc_status"], "missing_sha")
        self.assertEqual(result["loc"], "")

    def test_the_pr_metadata_columns_are_left_alone(self):
        # as_of bounds the greenlight state table and nothing else, so re-reading the PR's
        # own columns would swap the export's snapshot for a later one on these rows only.
        row = csv_row(pr_status="open", additions="999", final_head_sha="b" * 40)
        result, _, _ = self.rederive(row=row)
        for column in (
            "pr_status",
            "additions",
            "final_head_sha",
            "base_sha",
            "landed",
        ):
            with self.subTest(column=column):
                self.assertEqual(result[column], row[column])

    def test_the_input_row_is_not_mutated(self):
        row = csv_row()
        before = dict(row)
        result, _, _ = self.rederive(row=row)
        self.assertEqual(row, before)
        self.assertIsNot(result, row)

    def test_the_result_still_carries_every_published_column(self):
        result, _, _ = self.rederive()
        self.assertEqual(set(result), set(COLUMNS))

    def test_a_row_naming_no_readable_pull_request_raises(self):
        # apply_frame drops these, so reaching here means the caller skipped the frame.
        # Guessing a number would re-derive some other pull request's verdict into the row.
        with self.assertLogs(frame.logger, level="WARNING"):
            with self.assertRaises(ValueError) as caught:
                self.rederive(row=csv_row(pr_number="not a number"))
        self.assertIn("not a number", str(caught.exception))

    def test_a_pr_absent_from_the_snapshot_raises(self):
        # Silently keeping the later verdict would leave the row claiming to describe the
        # first landing while describing the last.
        with self.assertRaises(LookupError) as caught:
            self.rederive(records=[decision_record(pr_number="999")])
        self.assertIn("194379", str(caught.exception))


class TestSampleStability(unittest.TestCase):
    """The corpus grows every day, so re-exporting between runs is ordinary. A draw made by
    position in the frame reassigns almost the whole sample when one row arrives ahead of
    the others, which silently voids every verdict already paid for: a resumed run finds
    its completed pull requests are no longer selected. Ranking by a hash of the seed and
    the pull request fixes each row's rank independently of the frame it sits in."""

    def rows(self, numbers):
        return [csv_row(pr_number=str(number)) for number in numbers]

    def numbers(self, rows):
        return [row["pr_number"] for row in rows]

    def test_prepending_a_row_leaves_the_existing_selection_alone(self):
        # The measured failure: at seed 0, a positional draw of 10 from 100 shared 1 row
        # with the same draw from 101. Under a stable key the only rows that can change
        # are the newcomer and whichever row it displaces.
        before = self.rows(range(100))
        after = self.rows([1000]) + before
        drawn_before = set(self.numbers(frame.sample_rows(before, n=10, seed=0)))
        drawn_after = set(self.numbers(frame.sample_rows(after, n=10, seed=0)))
        self.assertGreaterEqual(len(drawn_before & drawn_after), 9)

    def test_growing_the_corpus_at_either_end_is_the_same(self):
        # Position must not matter at all, so the same new row appended rather than
        # prepended has to give the identical selection.
        base = self.rows(range(60))
        newcomer = csv_row(pr_number="9999")
        self.assertEqual(
            self.numbers(frame.sample_rows([newcomer] + base, n=8, seed=3)),
            self.numbers(frame.sample_rows(base + [newcomer], n=8, seed=3)),
        )

    def test_a_row_dropped_from_the_corpus_does_not_move_the_others(self):
        # The other direction: an unsampled row disappearing must not reshuffle the draw.
        rows = self.rows(range(80))
        drawn = set(self.numbers(frame.sample_rows(rows, n=12, seed=5)))
        survivors = [row for row in rows if row["pr_number"] not in drawn]
        thinned = survivors[:1] + [r for r in rows if r["pr_number"] in drawn]
        self.assertEqual(
            drawn & set(self.numbers(frame.sample_rows(thinned, n=12, seed=5))), drawn
        )

    def test_a_larger_n_is_a_superset_of_a_smaller_one(self):
        # Ranking rather than drawing: raising the budget adds pull requests, it does not
        # swap them, so a half-finished sweep can be widened without wasting what it paid.
        rows = self.rows(range(60))
        ten = set(self.numbers(frame.sample_rows(rows, n=10, seed=11)))
        twenty = set(self.numbers(frame.sample_rows(rows, n=20, seed=11)))
        self.assertTrue(ten < twenty)

    def test_the_repo_is_part_of_the_key(self):
        # Two repositories can carry the same pull request number, and a key that ignored
        # the repo would select the same numbers in both.
        here = [csv_row(pr_number=str(i)) for i in range(40)]
        there = [
            csv_row(pr_number=str(i), repo="pytorch/executorch") for i in range(40)
        ]
        self.assertNotEqual(
            self.numbers(frame.sample_rows(here, n=8, seed=2)),
            self.numbers(frame.sample_rows(there, n=8, seed=2)),
        )


class TestSampleRows(unittest.TestCase):
    """The sample decides which pull requests get paid for, so it has to be reproducible
    from the seed alone and has to refuse an ambiguous size."""

    def rows(self, count=50):
        return [csv_row(pr_number=str(number)) for number in range(count)]

    def numbers(self, rows):
        return [row["pr_number"] for row in rows]

    def test_the_same_seed_gives_the_same_sample(self):
        rows = self.rows()
        self.assertEqual(
            self.numbers(frame.sample_rows(rows, n=10, seed=17)),
            self.numbers(frame.sample_rows(rows, n=10, seed=17)),
        )

    def test_a_different_seed_gives_a_different_sample(self):
        rows = self.rows()
        self.assertNotEqual(
            self.numbers(frame.sample_rows(rows, n=10, seed=17)),
            self.numbers(frame.sample_rows(rows, n=10, seed=18)),
        )

    def test_the_global_random_state_cannot_move_the_sample(self):
        # Drawing off the module-global generator would make the selection depend on every
        # unrelated random call the process made first, and the seed would stop
        # identifying the run.
        rows = self.rows()
        random.seed(1)
        first = self.numbers(frame.sample_rows(rows, n=10, seed=17))
        random.seed(2)
        [random.random() for _ in range(5)]
        self.assertEqual(first, self.numbers(frame.sample_rows(rows, n=10, seed=17)))

    def test_the_sample_keeps_input_order_and_row_identity(self):
        rows = self.rows()
        drawn = frame.sample_rows(rows, n=10, seed=17)
        self.assertEqual(self.numbers(drawn), sorted(self.numbers(drawn), key=int))
        for row in drawn:
            self.assertIn(row, rows)

    def test_n_selects_exactly_that_many(self):
        self.assertEqual(len(frame.sample_rows(self.rows(), n=7, seed=1)), 7)

    def test_frac_selects_that_share(self):
        self.assertEqual(len(frame.sample_rows(self.rows(50), frac=0.2, seed=1)), 10)

    def test_a_small_frac_never_sizes_a_non_empty_frame_to_nothing(self):
        # round() gave 0 here, and the caller then reported that the frame had admitted
        # nothing -- blaming the frame for a rounding choice made after it. Rounding up
        # means a nonzero share of a non-empty frame always draws at least one row.
        self.assertEqual(len(frame.sample_rows(self.rows(10), frac=0.05, seed=1)), 1)
        self.assertEqual(
            len(frame.sample_rows(self.rows(1000), frac=0.0005, seed=1)), 1
        )

    def test_frac_rounds_up_rather_than_to_even(self):
        # round() is banker's: 10 * 0.25 is 2.5 and it returns 2, so asking for a quarter
        # of the frame quietly got you less than a quarter.
        self.assertEqual(len(frame.sample_rows(self.rows(10), frac=0.25, seed=1)), 3)
        self.assertEqual(len(frame.sample_rows(self.rows(10), frac=0.15, seed=1)), 2)

    def test_frac_of_one_takes_everything(self):
        rows = self.rows(9)
        self.assertEqual(
            self.numbers(frame.sample_rows(rows, frac=1.0, seed=1)), self.numbers(rows)
        )

    def test_n_above_the_frame_size_takes_everything_and_says_so(self):
        rows = self.rows(4)
        with self.assertLogs(frame.logger, level="WARNING"):
            drawn = frame.sample_rows(rows, n=99, seed=1)
        self.assertEqual(self.numbers(drawn), self.numbers(rows))

    def test_passing_both_frac_and_n_is_rejected(self):
        with self.assertRaises(ValueError):
            frame.sample_rows(self.rows(), frac=0.5, n=10, seed=1)

    def test_passing_neither_frac_nor_n_is_rejected(self):
        with self.assertRaises(ValueError):
            frame.sample_rows(self.rows(), seed=1)

    def test_a_frac_outside_the_unit_interval_is_rejected(self):
        for bad in (0.0, -0.1, 1.5):
            with self.subTest(frac=bad), self.assertRaises(ValueError):
                frame.sample_rows(self.rows(), frac=bad, seed=1)

    def test_a_negative_n_is_rejected(self):
        with self.assertRaises(ValueError):
            frame.sample_rows(self.rows(), n=-1, seed=1)

    def test_an_empty_frame_samples_to_nothing(self):
        self.assertEqual(frame.sample_rows([], frac=0.5, seed=1), [])
        self.assertEqual(frame.sample_rows([], n=0, seed=1), [])


if __name__ == "__main__":
    unittest.main()
