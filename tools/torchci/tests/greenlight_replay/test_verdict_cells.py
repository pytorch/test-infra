"""Tests for what one replayed run means in the four columns the replay adds.

Nothing here touches a file. The subject is the rule -- which runs count as the
policy speaking and which as the harness failing -- and every case reads it off
the cells a run produces.
"""

import unittest
from types import SimpleNamespace

from emit_fixtures import (  # noqa: E402
    CANNED_TOO_LARGE_MESSAGE,
    exported_row,
    failed,
    FAILED_OUTCOMES,
    Outcome,
    replayed,
    result,
    VERDICT_MESSAGE,
)
from torchci.greenlight_decisions.rows import COLUMNS, first_sentence
from torchci.greenlight_replay.emit import REPLAY_COLUMNS
from torchci.greenlight_replay.verdict_cells import (
    HARNESS_REASON_PREFIX,
    NEW_COLUMNS,
    OUTCOME_UNREADABLE,
)


class TestSuccessfulReplay(unittest.TestCase):
    """A verdict reaches the row whole: the status, the reason code, the full
    prose, and a summary computed by the export's own helper rather than a
    second one that could drift from it."""

    def test_all_four_columns_are_filled(self):
        row = replayed(exported_row(), result(status="NO_LAND"))
        for column in NEW_COLUMNS:
            with self.subTest(column=column):
                self.assertTrue(row[column])

    def test_the_verdict_status_and_reason_are_carried_through(self):
        row = replayed(
            exported_row(), result(status="NO_LAND", reason="build_or_ci_risk")
        )
        self.assertEqual(row["new_decision"], "NO_LAND")
        self.assertEqual(row["new_decision_reason"], "build_or_ci_risk")

    def test_the_message_is_carried_through_verbatim(self):
        row = replayed(exported_row(), result())
        self.assertEqual(row["new_decision_message"], VERDICT_MESSAGE)

    def test_the_summary_is_the_export_helper_applied_to_the_message(self):
        row = replayed(exported_row(), result())
        self.assertEqual(
            row["new_decision_summary"], first_sentence(row["new_decision_message"])
        )

    def test_the_summary_is_the_leading_clause(self):
        row = replayed(
            exported_row(),
            result(message="Two files changed. The rest is generated."),
        )
        self.assertEqual(row["new_decision_summary"], "Two files changed.")

    def test_the_exported_columns_are_left_alone(self):
        original = exported_row()
        row = replayed(original, result(status="NO_LAND"))
        for column in COLUMNS:
            with self.subTest(column=column):
                self.assertEqual(row[column], original[column])

    def test_the_callers_row_is_not_modified(self):
        original = exported_row()
        replayed(original, result())
        self.assertEqual(set(original), set(COLUMNS))

    def test_the_row_carries_every_replay_column_and_nothing_else(self):
        row = replayed(exported_row(), result())
        self.assertEqual(set(row), set(REPLAY_COLUMNS))


class TestFailedRunsAreVisible(unittest.TestCase):
    """A harness failure must never read as a policy that fell silent. The
    export already writes a blank decision for a pull request greenlight never
    judged, so four blank cells here would turn every timeout into a LAND the
    candidate policy declined to repeat -- the file's headline finding,
    manufactured. Each outcome therefore names itself in a column, and none of
    them reaches new_decision, where it would widen the comparison instead."""

    def test_every_failed_outcome_names_itself_in_the_reason(self):
        for outcome in FAILED_OUTCOMES:
            with self.subTest(outcome=outcome.name):
                row = replayed(exported_row(), failed(outcome))
                self.assertEqual(
                    row["new_decision_reason"],
                    HARNESS_REASON_PREFIX + outcome.name.lower(),
                )

    def test_no_failure_leaves_a_blank_cell_behind(self):
        for outcome in FAILED_OUTCOMES:
            row = replayed(exported_row(), failed(outcome))
            for column in (
                "new_decision_reason",
                "new_decision_summary",
                "new_decision_message",
            ):
                with self.subTest(outcome=outcome.name, column=column):
                    self.assertTrue(row[column])

    def test_the_outcomes_are_distinguishable_from_the_summary_alone(self):
        summaries = {
            outcome.name: replayed(exported_row(), failed(outcome))[
                "new_decision_summary"
            ]
            for outcome in FAILED_OUTCOMES
        }
        self.assertEqual(len(set(summaries.values())), len(FAILED_OUTCOMES))
        for name, summary in summaries.items():
            with self.subTest(outcome=name):
                self.assertIn(name.lower(), summary)

    def test_the_summary_stays_scannable_rather_than_holding_the_diagnostics(self):
        row = replayed(
            exported_row(), failed(Outcome.TIMEOUT, error="killed after 2220s")
        )
        self.assertEqual(row["new_decision_summary"], "harness timeout.")

    def test_a_failure_never_reaches_the_decision_column(self):
        for outcome in FAILED_OUTCOMES:
            with self.subTest(outcome=outcome.name):
                row = replayed(exported_row(), failed(outcome))
                self.assertEqual(row["new_decision"], "")

    def test_the_error_reaches_the_message(self):
        row = replayed(
            exported_row(),
            failed(Outcome.API_ERROR, error="HTTP 529 overloaded_error"),
        )
        self.assertIn("HTTP 529 overloaded_error", row["new_decision_message"])

    def test_the_run_diagnostics_reach_the_message(self):
        # What separates a budget trip from a crash three turns in, without
        # going back to the run log for it.
        row = replayed(
            exported_row(),
            failed(Outcome.BUDGET_TRIP, cost_usd=8.0, duration_s=91.2, num_turns=4),
        )
        message = row["new_decision_message"]
        for fragment in (
            "cost_usd=8.0",
            "duration_s=91.2",
            "num_turns=4",
            "outcome=budget_trip",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, message)

    def test_a_policy_reason_never_looks_like_a_harness_code(self):
        row = replayed(exported_row(), result(reason="scope_too_large"))
        self.assertNotIn(":", row["new_decision_reason"])
        self.assertFalse(row["new_decision_reason"].startswith(HARNESS_REASON_PREFIX))

    def test_the_failures_are_selectable_by_one_prefix_match(self):
        results = [result()] + [failed(outcome) for outcome in FAILED_OUTCOMES]
        flagged = [
            replayed(exported_row(), each)["new_decision_reason"].startswith(
                HARNESS_REASON_PREFIX
            )
            for each in results
        ]
        self.assertEqual(flagged, [False] + [True] * len(FAILED_OUTCOMES))


class TestResultsThatContradictThemselves(unittest.TestCase):
    """The runner is a separate process reporting on a third one, so a result
    can claim success and carry nothing usable. That is a harness fault, and the
    only alternative to naming it is the blank this module exists to avoid."""

    def test_a_success_with_no_status_is_reported_as_unreadable(self):
        row = replayed(exported_row(), result(status="", message=""))
        self.assertEqual(
            row["new_decision_reason"], HARNESS_REASON_PREFIX + OUTCOME_UNREADABLE
        )
        self.assertEqual(row["new_decision"], "")
        self.assertTrue(row["new_decision_message"])

    def test_an_unrecognised_status_never_reaches_the_decision_column(self):
        row = replayed(exported_row(), result(status="MAYBE"))
        self.assertEqual(row["new_decision"], "")
        self.assertEqual(
            row["new_decision_reason"], HARNESS_REASON_PREFIX + OUTCOME_UNREADABLE
        )
        self.assertIn("status=MAYBE", row["new_decision_message"])

    def test_a_result_with_no_outcome_at_all_is_reported_not_dropped(self):
        row = replayed(exported_row(), SimpleNamespace())
        self.assertEqual(
            row["new_decision_reason"], HARNESS_REASON_PREFIX + OUTCOME_UNREADABLE
        )
        self.assertTrue(row["new_decision_summary"])

    def test_a_plain_string_outcome_reads_the_same_as_the_enum(self):
        row = replayed(exported_row(), failed("TIMEOUT"))
        self.assertEqual(row["new_decision_reason"], HARNESS_REASON_PREFIX + "timeout")


class TestThePrefixMeansTheHarnessNeverThePolicy(unittest.TestCase):
    """``harness:`` marks a run that failed, never a verdict a reader might
    disagree with. The distinction is load-bearing rather than tidy: readers are
    told to drop prefixed rows before counting anything, so labelling a policy
    decision this way deletes it from the analysis -- and a size-gate decline is
    exactly what a policy PR retuning the diff cap is meant to produce.

    The test is whether the row carries a verdict the policy produced, not
    whether the run ended tidily."""

    def gate_decline(self):
        return result(
            outcome=Outcome.TOO_LARGE,
            status="NO_LAND",
            reason="scope_too_large",
            message=CANNED_TOO_LARGE_MESSAGE,
        )

    def recovered_trip(self):
        return result(
            outcome=Outcome.BUDGET_TRIP,
            status="LAND",
            reason="clean",
            message="Only the pin moved. Nothing to flag.",
        )

    def test_a_policy_verdict_keeps_its_own_reason_code_unprefixed(self):
        for label, run, expected in (
            ("size gate", self.gate_decline(), "scope_too_large"),
            ("recovered trip", self.recovered_trip(), "clean"),
            ("clean run", result(reason="build_or_ci_risk"), "build_or_ci_risk"),
        ):
            with self.subTest(label):
                reason = replayed(exported_row(), run)["new_decision_reason"]
                self.assertEqual(reason, expected)
                self.assertFalse(reason.startswith(HARNESS_REASON_PREFIX))

    def test_a_run_that_reached_no_verdict_keeps_the_prefix(self):
        for label, run in (
            ("timeout", failed(Outcome.TIMEOUT)),
            ("schema failure", failed(Outcome.SCHEMA_INVALID)),
            ("api error", failed(Outcome.API_ERROR)),
            ("empty run", failed(Outcome.EMPTY_RUN)),
            ("gate with no canned verdict", failed(Outcome.TOO_LARGE)),
            ("trip with nothing recovered", failed(Outcome.BUDGET_TRIP)),
        ):
            with self.subTest(label):
                reason = replayed(exported_row(), run)["new_decision_reason"]
                self.assertTrue(reason.startswith(HARNESS_REASON_PREFIX))

    def test_a_rejected_payload_keeps_the_prefix_even_carrying_a_status(self):
        # SCHEMA_INVALID carries the verdict fields, and the field the schema
        # usually rejects is the reason, against an enum the policy PR owns.
        # Publishing that code unprefixed would put a value that failed
        # validation into the column readers aggregate.
        row = replayed(
            exported_row(),
            result(
                outcome=Outcome.SCHEMA_INVALID,
                status="NO_LAND",
                reason="not_in_the_enum",
                message="Looks risky.",
            ),
        )
        self.assertEqual(
            row["new_decision_reason"], HARNESS_REASON_PREFIX + "schema_invalid"
        )
        self.assertNotIn("not_in_the_enum", row["new_decision_reason"])
        self.assertIn("not_in_the_enum", row["new_decision_message"])

    def test_the_summary_of_a_policy_verdict_is_prose_not_an_outcome(self):
        row = replayed(exported_row(), self.gate_decline())
        self.assertEqual(
            row["new_decision_summary"], first_sentence(CANNED_TOO_LARGE_MESSAGE)
        )
        self.assertNotIn("harness", row["new_decision_summary"])

    def test_a_policy_verdict_still_records_how_its_run_ended(self):
        # Unprefixing the reason must not cost the diagnostics: a decline that
        # came through the size gate stays distinguishable from a reviewed one.
        message = replayed(exported_row(), self.gate_decline())["new_decision_message"]
        self.assertIn(CANNED_TOO_LARGE_MESSAGE, message)
        self.assertIn("outcome=too_large", message)

    def test_a_clean_run_carries_no_diagnostics_at_all(self):
        row = replayed(exported_row(), result())
        self.assertEqual(row["new_decision_message"], VERDICT_MESSAGE)
        self.assertNotIn("outcome=", row["new_decision_message"])

    def test_the_verdict_survives_either_way(self):
        for label, run in (
            ("size gate", self.gate_decline()),
            ("recovered trip", self.recovered_trip()),
        ):
            with self.subTest(label):
                row = replayed(exported_row(), run)
                self.assertIn(row["new_decision"], ("LAND", "NO_LAND"))


if __name__ == "__main__":
    unittest.main()
