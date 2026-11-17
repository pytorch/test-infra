"""Tests for reading a reviewer run's output and deciding what happened.

``classify`` is called directly here rather than through ``run_review``: these are the
checks that stand between a failed run and a verdict row that looks real, and each is
exercised against the envelope shape that actually produces it. The reviewer is never
launched -- one real run costs roughly $1.33 and ten minutes.

The detector and the record path's checks are handed in by the caller; here they are
stand-ins that record whether they were asked, since which outcome consults them is the
subject. Both run as the policy's real code in ``test_runner`` and ``test_arm_code``.
"""

import json
import unittest

from replay_runner_fixtures import (
    ABSENT,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MODEL,
    envelope,
    GOOD_VERDICT,
    model_usage,
    result_element,
    ScratchTestCase,
)
from torchci.greenlight_replay import runner, transcript, verdict
from torchci.greenlight_replay.detector import DetectorFailure


SCRUBBED = {**GOOD_VERDICT, "message": "- Change\n  - [REDACTED]"}
LOADED = DetectorFailure("loaded pytorch/CLAUDE.md", hooks_ran=True)
NO_SENTINEL = DetectorFailure("sentinel missing; the hooks did not run", False)


class ClassifyTestCase(ScratchTestCase):
    def setUp(self):
        self.run_dir = self.scratch("greenlight-transcript-")
        self.detected = 0
        self.accepted = []
        self.violation = None
        self.rejection = None

    def detect(self):
        self.detected += 1
        if isinstance(self.violation, Exception):
            raise self.violation
        return self.violation

    def accept(self, verdict_file):
        self.accepted.append(verdict_file)
        if isinstance(self.rejection, Exception):
            raise self.rejection
        if self.rejection is not None:
            return None, self.rejection
        return dict(SCRUBBED), None

    def classify(self, exit_code, stdout, verdict=None, *, model=None):
        if verdict is not None:
            transcript.verdict_path(self.run_dir).write_text(json.dumps(verdict))
        return transcript.classify(
            exit_code,
            stdout,
            "",
            run_dir=self.run_dir,
            model=model or DEFAULT_MODEL,
            context_window=DEFAULT_CONTEXT_WINDOW,
            duration_s=612.0,
            detect=self.detect,
            accept=self.accept,
        )


class TestOutcomes(ClassifyTestCase):
    """Every outcome the caller can be handed is produced by a realistic envelope.

    An outcome that no envelope can reach is an outcome the caller will never see, and a
    replay that silently drops those pull requests reports a cleaner run than it had.
    (``TOO_LARGE`` is the one exception: it is the runner's pre-model short circuit and is
    covered in ``test_runner``.)
    """

    def test_an_accepted_verdict_is_a_success_carrying_what_the_record_path_keeps(self):
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)
        self.assertEqual(result.status, "NO_LAND")
        self.assertEqual(result.reason, "insufficient_tests")
        # The scrubbed message, not the file's: it is what the record path writes.
        self.assertEqual(result.message, SCRUBBED["message"])
        self.assertEqual(self.accepted, [transcript.verdict_path(self.run_dir)])
        self.assertAlmostEqual(result.cost_usd, 1.3312)
        self.assertEqual(result.model, DEFAULT_MODEL)
        self.assertEqual(result.context_window, DEFAULT_CONTEXT_WINDOW)

    def test_a_verdict_the_record_path_refuses_is_rejected(self):
        self.rejection = "reason 'vibes' is not an allowed verdict reason"
        result = self.classify(
            0, envelope(result_element()), {**GOOD_VERDICT, "reason": "vibes"}
        )
        self.assertEqual(result.outcome, transcript.Outcome.REJECTED)
        self.assertIn("vibes", result.error)
        # The file's fields stay as diagnostics, so the failure can be read.
        self.assertEqual(result.reason, "vibes")
        self.assertEqual(result.message, GOOD_VERDICT["message"])

    def test_a_finished_run_that_wrote_nothing_is_no_verdict(self):
        result = self.classify(0, envelope(result_element()))
        self.assertEqual(result.outcome, transcript.Outcome.NO_VERDICT)
        self.assertIsNone(result.status)
        self.assertEqual(self.accepted, [])

    def test_a_verdict_only_in_the_turn_record_is_no_verdict(self):
        # The live job uploads the file; a Write the record names is not one.
        write = (
            "Write",
            {
                "file_path": "/tmp/greenlight-verdict.json",
                "content": json.dumps(GOOD_VERDICT),
            },
        )
        result = self.classify(0, envelope(result_element(), tool_uses=[write]))
        self.assertEqual(result.outcome, transcript.Outcome.NO_VERDICT)
        self.assertEqual(result.status, "NO_LAND")
        self.assertEqual(self.accepted, [])

    def test_a_session_ending_in_anything_but_success_is_an_api_error(self):
        # claude-code-action fails the step unless the subtype is "success".
        ended = result_element(subtype="error_max_turns")
        result = self.classify(1, envelope(ended), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)
        self.assertIn("error_max_turns", result.error)
        self.assertEqual(self.accepted, [])
        # What the failed session left is kept to read, not recorded.
        self.assertEqual(result.status, "NO_LAND")

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

    def test_a_success_subtype_flagged_is_error_is_an_api_error_even_with_a_verdict(
        self,
    ):
        flagged = result_element(is_error=True)
        result = self.classify(0, envelope(flagged), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.API_ERROR)
        self.assertEqual(self.accepted, [])

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
    """A trip bills in full, and its verdict is dug out of the turn record to be read.

    It stays a diagnostic: CI fails a tripped session, so what it said is never recorded.
    """

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
        self.assertEqual(self.accepted, [])

    def test_a_verdict_file_a_tripped_session_left_is_never_accepted(self):
        tripped = result_element(result=ABSENT)
        result = self.classify(1, envelope(tripped), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.BUDGET_TRIP)
        self.assertEqual(self.accepted, [])

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
        # trip, a timeout, a detector failure and a rejected verdict all produced an
        # answer of some kind, and re-rolling any of them is a biased draw against 18.3%
        # self-disagreement.
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


class TestDetector(ClassifyTestCase):
    """After a session that started, the policy's detector decides before anything else.

    The live job fails the review on an instruction file loaded from the checkout, or on
    a missing sentinel, whatever the model wrote; the two are told apart because a
    missing sentinel means the hooks never loaded, which no pull request causes. A
    session that never started runs no hooks, so the detector is not consulted and the
    session's own outcome stands.
    """

    def test_a_violation_overrides_a_verdict_and_is_never_accepted(self):
        self.violation = LOADED
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.UNTRUSTED_INSTRUCTIONS)
        self.assertIn("CLAUDE.md", result.error)
        self.assertEqual(self.accepted, [])
        self.assertAlmostEqual(result.cost_usd, 1.3312)

    def test_a_missing_sentinel_is_hooks_not_loaded(self):
        self.violation = NO_SENTINEL
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.HOOKS_NOT_LOADED)
        self.assertIn("sentinel", result.error)
        self.assertEqual(self.accepted, [])

    def test_either_failure_overrides_a_failed_or_empty_session(self):
        eaten = result_element(num_turns=0, total_cost_usd=0, modelUsage={})
        errored = result_element(is_error=True)
        for failure, expected in (
            (LOADED, transcript.Outcome.UNTRUSTED_INSTRUCTIONS),
            (NO_SENTINEL, transcript.Outcome.HOOKS_NOT_LOADED),
        ):
            for element in (eaten, errored, result_element()):
                with self.subTest(failure=failure, element=element.get("is_error")):
                    self.violation = failure
                    result = self.classify(0, envelope(element))
                    self.assertEqual(result.outcome, expected)

    def test_a_passing_detector_leaves_the_verdict_to_the_record_path(self):
        result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(self.detected, 1)
        self.assertEqual(result.outcome, transcript.Outcome.SUCCESS)

    def test_a_would_be_success_with_no_init_element_still_runs_the_detector(self):
        # The live job runs the detector whenever the model ran, not only when the
        # output proves a session started.
        for failure, expected in (
            (None, transcript.Outcome.SUCCESS),
            (NO_SENTINEL, transcript.Outcome.HOOKS_NOT_LOADED),
            (LOADED, transcript.Outcome.UNTRUSTED_INSTRUCTIONS),
        ):
            with self.subTest(failure=failure):
                self.violation = failure
                result = self.classify(0, json.dumps(result_element()), GOOD_VERDICT)
                self.assertEqual(result.outcome, expected)
        self.assertEqual(self.detected, 3)

    def test_a_non_success_with_no_init_element_keeps_its_outcome_unasked(self):
        self.violation = NO_SENTINEL
        result = self.classify(0, json.dumps(result_element()))
        self.assertEqual(result.outcome, transcript.Outcome.NO_VERDICT)
        self.assertEqual(self.detected, 0)

    def test_a_session_that_never_started_keeps_its_own_outcome(self):
        self.violation = NO_SENTINEL
        for stdout, exit_code, expected in (
            ("", 124, transcript.Outcome.TIMEOUT),
            ("Killed: 9\n", 1, transcript.Outcome.API_ERROR),
            (
                json.dumps(result_element(result=ABSENT)),
                1,
                transcript.Outcome.BUDGET_TRIP,
            ),
        ):
            with self.subTest(expected=expected):
                result = self.classify(exit_code, stdout)
                self.assertEqual(result.outcome, expected)
        self.assertEqual(self.detected, 0)

    def test_a_detector_failure_is_not_retried(self):
        self.assertNotIn(
            transcript.Outcome.UNTRUSTED_INSTRUCTIONS, transcript.RETRYABLE
        )

    def test_a_rejected_verdict_is_reported_rather_than_re_rolled(self):
        # The model answered; the record path merely would not accept it. Drawing again
        # is a second sample, not error handling, so the row is recorded as it stands.
        self.assertNotIn(transcript.Outcome.REJECTED, transcript.RETRYABLE)

    def test_session_started_reads_the_init_element(self):
        self.assertTrue(
            transcript.session_started([{"type": "system", "subtype": "init"}])
        )
        self.assertFalse(
            transcript.session_started([{"type": "system", "subtype": "other"}])
        )
        self.assertFalse(transcript.session_started([result_element()]))


class TestArmChecksThatCannotRun(ClassifyTestCase):
    """A paid run is recorded even when the policy's own checks cannot run on it."""

    def test_a_detector_that_raises_is_an_arm_check_failure_keeping_the_cost(self):
        self.violation = RuntimeError("python3 ran past 120 s")
        with self.assertLogs(transcript.logger, "ERROR") as logs:
            result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
        self.assertEqual(result.outcome, transcript.Outcome.ARM_CHECK_FAILED)
        self.assertIn("the detector", result.error)
        self.assertIn("ran past 120 s", result.error)
        self.assertAlmostEqual(result.cost_usd, 1.3312)
        self.assertEqual(result.num_turns, 27)
        self.assertEqual(result.duration_s, 612.0)
        self.assertEqual(self.accepted, [])
        self.assertIn("Traceback", "\n".join(logs.output))

    def test_record_checks_that_raise_are_an_arm_check_failure(self):
        for exc in (
            FileNotFoundError("bash"),
            ValueError("Expecting value: line 1 column 1"),
        ):
            with self.subTest(exc=exc):
                self.rejection = exc
                with self.assertLogs(transcript.logger, "ERROR"):
                    result = self.classify(0, envelope(result_element()), GOOD_VERDICT)
                self.assertEqual(result.outcome, transcript.Outcome.ARM_CHECK_FAILED)
                self.assertIn("the record checks", result.error)
                self.assertAlmostEqual(result.cost_usd, 1.3312)

    def test_an_arm_check_failure_is_not_retried(self):
        self.assertNotIn(transcript.Outcome.ARM_CHECK_FAILED, transcript.RETRYABLE)


class TestReExports(unittest.TestCase):
    """The verdict names stay reachable where callers already meet them.

    ``runner`` imports them from ``transcript``, so a re-export that silently becomes a
    copy would leave two implementations drifting apart. Identity, not equality: this
    assertion has caught real drift twice across the earlier splits.
    """

    def test_transcript_re_exports_the_verdict_module_itself(self):
        for name in (
            "verdict_path",
            "verdict_fields",
            "read_verdict",
            "recover_verdict",
        ):
            self.assertIs(getattr(transcript, name), getattr(verdict, name), name)

    def test_runner_sees_the_same_objects(self):
        self.assertIs(runner.verdict_path, verdict.verdict_path)


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
