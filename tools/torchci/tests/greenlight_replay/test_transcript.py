"""Tests for reading a reviewer run's output and deciding what happened.

``classify`` is called directly here rather than through ``run_review``: these are the
checks that stand between a failed run and a verdict row that looks real, and each is
exercised against the envelope shape that actually produces it. The reviewer is never
launched -- one real run costs roughly $1.33 and ten minutes.
"""

import json
import tempfile
import unittest
from pathlib import Path

from replay_runner_fixtures import (
    ABSENT,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MODEL,
    envelope,
    GOOD_VERDICT,
    model_usage,
    REAL_SCHEMA,
    result_element,
    ScratchTestCase,
)
from torchci.greenlight_replay import runner, transcript, verdict


class ClassifyTestCase(ScratchTestCase):
    def setUp(self):
        self.run_dir = self.scratch("greenlight-transcript-")
        self.schema = json.loads(REAL_SCHEMA.read_text())

    def classify(self, exit_code, stdout, verdict=None, *, schema=None, model=None):
        if verdict is not None:
            transcript.verdict_path(self.run_dir).write_text(json.dumps(verdict))
        return transcript.classify(
            exit_code,
            stdout,
            "",
            run_dir=self.run_dir,
            schema=schema if schema is not None else self.schema,
            model=model or DEFAULT_MODEL,
            context_window=DEFAULT_CONTEXT_WINDOW,
            duration_s=612.0,
        )


class TestOutcomes(ClassifyTestCase):
    """Every outcome the caller can be handed is produced by a realistic envelope.

    An outcome that no envelope can reach is an outcome the caller will never see, and a
    replay that silently drops those pull requests reports a cleaner run than it had.
    (``TOO_LARGE`` is the one exception: it is the runner's pre-model short circuit and is
    covered in ``test_runner``.)
    """

    def test_a_written_valid_verdict_is_a_success(self):
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)
        self.assertEqual(result.status, "NO_LAND")
        self.assertEqual(result.reason, "insufficient_tests")
        self.assertAlmostEqual(result.cost_usd, 1.3312)
        self.assertEqual(result.model, DEFAULT_MODEL)
        self.assertEqual(result.context_window, DEFAULT_CONTEXT_WINDOW)

    def test_a_verdict_the_policys_schema_rejects_is_schema_invalid(self):
        result = self.classify(
            0, envelope(result_element()), {**GOOD_VERDICT, "reason": "vibes"}
        )
        self.assertEqual(result.outcome, transcript.Outcome.SCHEMA_INVALID)
        self.assertIn("vibes", result.error)
        # The verdict is still reported, so the failure can be read rather than guessed at.
        self.assertEqual(result.status, "NO_LAND")

    def test_a_finished_run_that_wrote_nothing_is_no_verdict(self):
        result = self.classify(0, envelope(result_element()))
        self.assertEqual(result.outcome, transcript.Outcome.NO_VERDICT)
        self.assertIsNone(result.status)

    def test_a_killed_run_is_a_timeout(self):
        for exit_code in (124, 137):
            result = self.classify(exit_code, "")
            self.assertEqual(result.outcome, transcript.Outcome.TIMEOUT)
            self.assertIn(str(exit_code), result.error)

    def test_a_result_element_without_result_or_structured_output_is_a_budget_trip(
        self,
    ):
        tripped = result_element(result=ABSENT, num_turns=19, total_cost_usd=2.13)
        result = self.classify(1, envelope(tripped))
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertAlmostEqual(result.cost_usd, 2.13)

    def test_an_errored_run_is_an_api_error(self):
        errored = result_element(
            is_error=True, subtype="error_during_execution", result="upstream 529"
        )
        self.assertEqual(
            self.classify(1, envelope(errored)).outcome, transcript.Outcome.API_ERROR
        )

    def test_an_api_error_status_is_an_api_error_even_when_is_error_is_false(self):
        flagged = result_element(api_error_status=529)
        self.assertEqual(
            self.classify(0, envelope(flagged)).outcome, transcript.Outcome.API_ERROR
        )

    def test_output_that_carries_no_result_element_is_an_api_error(self):
        result = self.classify(1, json.dumps([{"type": "system", "subtype": "init"}]))
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)
        self.assertIn("no result element", result.error)

    def test_unparseable_output_is_an_api_error_rather_than_a_crash(self):
        result = self.classify(1, "Killed: 9\n")
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)

    def test_a_prompt_eaten_as_a_slash_command_is_an_empty_run(self):
        eaten = result_element(
            result="Unknown command: /greenlight-review",
            num_turns=0,
            total_cost_usd=0,
            modelUsage={},
        )
        self.assertEqual(
            self.classify(0, envelope(eaten)).outcome, transcript.Outcome.EMPTY_RUN
        )


class TestOutputShapes(ClassifyTestCase):
    """Both CLI output shapes are read. Only the array carries a recoverable turn record."""

    def test_the_bare_result_object_emitted_without_verbose_is_accepted(self):
        # --output-format json alone returns a top-level object; the array is the --verbose
        # shape. A parser that assumed the array would see every plain run as an API error.
        result = self.classify(0, json.dumps(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)

    def test_a_trip_in_the_bare_object_shape_has_nothing_to_recover(self):
        tripped = result_element(result=ABSENT)
        result = self.classify(1, json.dumps(tripped))
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertIsNone(result.status)


class TestEmptyRunDiscriminator(ClassifyTestCase):
    """An empty run is recognised by its accounting, not by the text it returned.

    The CLI answers a prompt that opens like a slash command with ``Unknown command:`` and
    exits 0, and the reviewer's skill is called greenlight-review. Matching that sentence
    would both miss a reworded one and misfire on a review that happens to quote it.
    """

    def test_zero_turns_and_zero_cost_is_an_empty_run_whatever_the_text_says(self):
        silent = result_element(
            result="All good, the change looks fine.",
            num_turns=0,
            total_cost_usd=0,
            modelUsage={},
        )
        self.assertEqual(
            self.classify(0, envelope(silent)).outcome, transcript.Outcome.EMPTY_RUN
        )

    def test_a_real_run_quoting_the_unknown_command_text_is_not_an_empty_run(self):
        quoting = result_element(
            result="The diff adds a CLI that prints 'Unknown command: /x' on a typo."
        )
        result = self.classify(0, envelope(quoting), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)

    def test_a_billed_run_with_no_turns_recorded_is_not_an_empty_run(self):
        # Turns alone would misclassify a run that did work and was billed for it.
        billed = result_element(num_turns=0, total_cost_usd=0.44)
        result = self.classify(0, envelope(billed), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)


class TestBudgetTripRecovery(ClassifyTestCase):
    """A trip bills in full, so the verdict is dug out of the turn record before giving up."""

    def test_a_verdict_written_in_the_turn_record_is_recovered(self):
        write = (
            "Write",
            {
                "file_path": "/tmp/greenlight-verdict.json",
                "content": json.dumps(GOOD_VERDICT),
            },
        )
        tripped = result_element(result=ABSENT, total_cost_usd=2.13)
        result = self.classify(1, envelope(tripped, tool_uses=[write]))
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertEqual(result.status, "NO_LAND")
        self.assertEqual(result.message, GOOD_VERDICT["message"])

    def test_a_verdict_written_to_the_remapped_path_is_recovered(self):
        remapped = str(transcript.verdict_path(self.run_dir))
        write = ("Write", {"file_path": remapped, "content": json.dumps(GOOD_VERDICT)})
        tripped = result_element(result=ABSENT)
        result = self.classify(1, envelope(tripped, tool_uses=[write]))
        self.assertEqual(result.status, "NO_LAND")

    def test_a_structured_output_call_is_not_looked_for(self):
        # The harness grants Read,Glob,Grep,Write and passes no --json-schema, so
        # StructuredOutput is never offered -- a probe's system/init listed exactly the
        # named tools. Recovering from it would be dead code pretending to be live.
        tripped = result_element(result=ABSENT)
        result = self.classify(
            1, envelope(tripped, tool_uses=[("StructuredOutput", GOOD_VERDICT)])
        )
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertIsNone(result.status)

    def test_a_write_to_an_unrelated_path_is_not_mistaken_for_the_verdict(self):
        write = ("Write", {"file_path": "/tmp/notes.md", "content": "{}"})
        tripped = result_element(result=ABSENT)
        result = self.classify(1, envelope(tripped, tool_uses=[write]))
        self.assertIsNone(result.status)

    def test_a_trip_with_nothing_to_recover_still_reports_what_it_cost(self):
        tripped = result_element(result=ABSENT, total_cost_usd=2.13)
        result = self.classify(1, envelope(tripped))
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertIsNone(result.status)
        self.assertAlmostEqual(result.cost_usd, 2.13)

    def test_only_a_run_with_no_answer_at_all_is_retried(self):
        # Retrying is an estimator decision, not error handling: CI draws one verdict per
        # pull request, so a second draw is taken only where there is nothing to keep. A
        # trip, a timeout and a rejected verdict all produced an answer of some kind, and
        # re-rolling any of them is a biased draw against 18.3% self-disagreement.
        self.assertEqual(
            transcript.RETRYABLE, frozenset({transcript.Outcome.NO_VERDICT})
        )


class TestModelAssertion(ClassifyTestCase):
    """A silent downgrade is visible only in modelUsage, so it is checked after every run.

    A bare alias resolves to a 200k window at no warning and full price; the answer is just
    quietly worse, which is indistinguishable from the policy being worse.
    """

    def test_a_different_model_fails_the_run(self):
        downgraded = result_element(modelUsage=model_usage(model="claude-sonnet-5"))
        result = self.classify(0, envelope(downgraded), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)
        self.assertIn("claude-sonnet-5", result.error)

    def test_a_smaller_context_window_fails_the_run(self):
        shrunk = result_element(modelUsage=model_usage(context_window=200_000))
        result = self.classify(0, envelope(shrunk), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)
        self.assertIn("200000", result.error)

    def test_a_second_model_in_the_usage_map_fails_the_run(self):
        mixed = result_element(modelUsage={**model_usage(), "claude-haiku-4-5": {}})
        result = self.classify(0, envelope(mixed), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)

    def test_the_asked_for_model_and_window_pass(self):
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)

    def test_an_empty_run_is_recognised_before_the_model_assertion(self):
        # An empty run has no modelUsage, so the assertion would otherwise report it as a
        # downgrade and hide the real failure.
        eaten = result_element(num_turns=0, total_cost_usd=0, modelUsage={})
        self.assertEqual(
            self.classify(0, envelope(eaten)).outcome, transcript.Outcome.EMPTY_RUN
        )


class TestSchemaValidation(ClassifyTestCase):
    """The verdict is judged by the policy tree's schema, not by a copy kept here."""

    def test_a_reason_the_policys_schema_adds_is_accepted(self):
        schema = json.loads(REAL_SCHEMA.read_text())
        schema["properties"]["reason"]["enum"].append("policy_specific_new_reason")
        result = self.classify(
            0,
            envelope(result_element()),
            {**GOOD_VERDICT, "reason": "policy_specific_new_reason"},
            schema=schema,
        )
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)

    def test_a_rejected_verdict_is_reported_rather_than_re_rolled(self):
        # The model answered; the harness merely would not accept it. Drawing again is a
        # second sample, not error handling, so the row is recorded as it stands.
        self.assertNotIn(transcript.Outcome.SCHEMA_INVALID, transcript.RETRYABLE)

    def test_an_extra_top_level_key_is_rejected(self):
        result = self.classify(
            0, envelope(result_element()), {**GOOD_VERDICT, "confidence": "high"}
        )
        self.assertEqual(result.outcome, transcript.Outcome.SCHEMA_INVALID)
        self.assertIn("confidence", result.error)

    def test_an_empty_message_is_rejected(self):
        result = self.classify(
            0, envelope(result_element()), {**GOOD_VERDICT, "message": ""}
        )
        self.assertEqual(result.outcome, transcript.Outcome.SCHEMA_INVALID)

    def test_a_missing_required_field_is_rejected(self):
        result = self.classify(0, envelope(result_element()), {"status": "LAND"})
        self.assertEqual(result.outcome, transcript.Outcome.SCHEMA_INVALID)

    def test_a_status_outside_the_enum_is_rejected(self):
        result = self.classify(
            0, envelope(result_element()), {**GOOD_VERDICT, "status": "MAYBE"}
        )
        self.assertEqual(result.outcome, transcript.Outcome.SCHEMA_INVALID)


class TestSchemaSupport(ClassifyTestCase):
    """A schema the harness cannot interpret is a fault in the POLICY, not in an answer.

    It fails every pull request identically, so returning it as a retryable outcome would
    re-run and re-bill an entire sweep to reach the same refusal twice -- against a 30-PR
    corpus roughly $77 and 2.7 hours for zero usable rows. It raises instead, and callers
    check it once before spending anything.
    """

    def test_the_repositorys_real_schema_is_supported(self):
        self.assertIsNone(transcript.schema_support_violation(self.schema))

    def test_an_unreadable_top_level_keyword_is_named(self):
        violation = transcript.schema_support_violation(
            {**self.schema, "allOf": [{"required": ["status"]}]}
        )
        self.assertIn("allOf", violation)

    def test_an_unreadable_property_keyword_is_named(self):
        schema = json.loads(REAL_SCHEMA.read_text())
        schema["properties"]["message"]["pattern"] = "^-"
        violation = transcript.schema_support_violation(schema)
        self.assertIn("pattern", violation)
        self.assertIn("message", violation)

    def test_classify_raises_rather_than_returning_a_retryable_outcome(self):
        with self.assertRaises(ValueError) as caught:
            self.classify(
                0,
                envelope(result_element()),
                GOOD_VERDICT,
                schema={**self.schema, "allOf": []},
            )
        self.assertIn("allOf", str(caught.exception))

    def test_a_widened_enum_stays_supported_because_only_keywords_are_checked(self):
        # Widening a value the harness already reads must stay a policy change, not a fault.
        schema = json.loads(REAL_SCHEMA.read_text())
        schema["properties"]["reason"]["enum"].append("policy_specific_new_reason")
        self.assertIsNone(transcript.schema_support_violation(schema))


class TestReExports(unittest.TestCase):
    """The verdict names stay reachable where callers already meet them.

    ``runner`` imports them from ``transcript`` and ``policy`` imports the pre-split private
    name, so a re-export that silently becomes a copy would leave two implementations of the
    same validation drifting apart. Identity, not equality: this assertion has caught real
    drift twice across the earlier splits.
    """

    def test_transcript_re_exports_the_verdict_module_itself(self):
        for name in (
            "verdict_path",
            "verdict_fields",
            "verdict_violation",
            "schema_support_violation",
            "read_verdict",
            "recover_verdict",
        ):
            self.assertIs(getattr(transcript, name), getattr(verdict, name), name)

    def test_the_pre_split_private_name_still_resolves_for_policy(self):
        self.assertIs(transcript._schema_violation, verdict.verdict_violation)

    def test_runner_sees_the_same_objects(self):
        self.assertIs(runner.verdict_path, verdict.verdict_path)
        self.assertIs(runner.schema_support_violation, verdict.schema_support_violation)


class TestMergeAttempts(ScratchTestCase):
    """A retried pull request is billed twice, and the row must say so."""

    def result(self, outcome, cost, turns):
        return transcript.RunResult(
            outcome=outcome, cost_usd=cost, duration_s=cost * 10, num_turns=turns
        )

    def test_a_single_attempt_is_returned_unchanged(self):
        only = self.result(transcript.Outcome.SUCCESS, 1.33, 27)
        self.assertIs(transcript.merge_attempts([only]), only)

    def test_the_last_attempts_verdict_wins_and_every_attempts_cost_is_kept(self):
        first = self.result(transcript.Outcome.NO_VERDICT, 1.33, 27)
        second = self.result(transcript.Outcome.SUCCESS, 1.20, 30)
        merged = transcript.merge_attempts([first, second])
        self.assertEqual(merged.outcome, transcript.Outcome.SUCCESS)
        self.assertAlmostEqual(merged.cost_usd, 2.53)
        self.assertEqual(merged.num_turns, 57)


if __name__ == "__main__":
    unittest.main()
