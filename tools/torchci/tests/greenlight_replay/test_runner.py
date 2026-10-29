"""Tests for launching the greenlight reviewer: command line, environment, settings, retry.

The reviewer itself is never launched: one real run costs roughly $1.33 and ten minutes.
``runner._invoke_cli`` is the single seam every launch goes through and is replaced here.
What comes BACK from a launch is classified by ``transcript`` and tested in
``test_transcript``; this file covers getting the launch right and looping over it.
"""

import dataclasses
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from replay_runner_fixtures import (
    ABSENT,
    envelope,
    GOOD_VERDICT,
    replay_policy,
    result_element,
    ScratchTestCase,
)
from torchci.greenlight_replay import (
    reviewer_env,
    runner,
    stack as stack_mod,
    transcript,
)
from torchci.greenlight_replay.hooks import remap
from torchci.greenlight_replay.inputs import ReplayInputs


THIS_PR = {"number": 167890, "title": "The PR under review", "this": True}


def sibling(number):
    """A stack entry for a PR above the reviewed one, in the workflow's jq shape."""
    return {
        "number": number,
        "title": f"PR {number}",
        "this": False,
        "diff": f"/tmp/greenlight-stack/{number}.diff",
    }


class _PolicyWithoutBudget:
    """A policy-shaped object predating ``review_budget_minutes``."""

    def __init__(self, policy):
        for field in dataclasses.fields(policy):
            if field.name != "review_budget_minutes":
                setattr(self, field.name, getattr(policy, field.name))


def _forbidden_invoke(command, prompt, env, cwd):
    """The default seam for every runner test: launching the reviewer is a test failure.

    ``TestInputPlacement`` calls ``run_review`` unpatched on purpose, to prove the guards
    refuse before anything is spent. When one of those guards regressed -- a stale whole-file
    restore once left ``_assert_paths_agree`` defined but never called -- those tests ran
    straight through into real ``claude -p --effort high`` launches with 2220-second
    timeouts, at roughly $1.33 each. A guard that stops costing money the moment it breaks
    is not a guard, so the seam refuses by default and each test opts in to a fake.
    """
    raise AssertionError(
        "a test tried to launch the real reviewer: " + " ".join(list(command)[:8])
    )


class FakeCli:
    """Stands in for ``runner._invoke_cli``, one scripted reply per attempt."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, command, prompt, env, cwd):
        self.calls.append(
            {"command": list(command), "prompt": prompt, "env": dict(env), "cwd": cwd}
        )
        exit_code, stdout, verdict = self.replies[
            min(len(self.calls) - 1, len(self.replies) - 1)
        ]
        if verdict is not None:
            run_dir = Path(env[remap.RUN_DIR_ENV])
            runner.verdict_path(run_dir).write_text(
                json.dumps(verdict), encoding="utf-8"
            )
        return exit_code, stdout, ""


class RunnerTestCase(ScratchTestCase):
    def setUp(self):
        # The run directory has to sit under restrict-read.py's scratch prefix; runner
        # refuses one that does not, which is itself asserted below.
        self.run_dir = self.scratch("greenlight-runner-")
        self.workspace = self.scratch("greenlight-runner-ws-")
        self.policy = replay_policy(self.workspace)
        diff_path = self.run_dir / remap.DIFF_BASENAME
        diff_path.write_text("diff --git a/torch/x.py b/torch/x.py\n")
        self.inputs = ReplayInputs(
            diff_path=diff_path,
            metadata_path=None,
            diff_lines=1,
            diff_bytes=diff_path.stat().st_size,
            too_large=False,
        )
        self.forbid_real_reviewer()

    def forbid_real_reviewer(self):
        patched = mock.patch.object(runner, "_invoke_cli", _forbidden_invoke)
        patched.start()
        self.addCleanup(patched.stop)

    def review(self, *replies):
        fake = FakeCli(*replies)
        with mock.patch.object(runner, "_invoke_cli", fake):
            result = runner.run_review(
                self.policy,
                self.workspace,
                self.inputs,
                self.run_dir,
                pr_number=167890,
                head_sha="a" * 40,
            )
        self.last_cli = fake
        return result


class TestEndToEnd(RunnerTestCase):
    """run_review wires the launch to the classifier and to the policy's canned decline."""

    def test_a_written_valid_verdict_comes_back_as_a_success(self):
        result = self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(result.outcome, runner.Outcome.SUCCESS)
        self.assertEqual(result.status, "NO_LAND")
        self.assertAlmostEqual(result.cost_usd, 1.3312)

    def test_an_oversized_diff_returns_the_policys_canned_verdict_without_a_run(self):
        self.inputs = dataclasses.replace(
            self.inputs, diff_lines=9001, diff_bytes=1_000_000, too_large=True
        )
        result = self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(result.outcome, runner.Outcome.TOO_LARGE)
        self.assertEqual(result.reason, "scope_too_large")
        self.assertEqual(
            self.last_cli.calls, [], "the model must not run on the decline path"
        )

    def test_outcome_and_run_result_are_re_exported_for_callers(self):
        # Callers meet these through runner; the split must not move them out from under it.
        self.assertIs(runner.Outcome, transcript.Outcome)
        self.assertIs(runner.RunResult, transcript.RunResult)


class TestReExports(unittest.TestCase):
    """``reviewer_env``'s names stay reachable through ``runner``, where callers meet them.

    Identity, not equality: preflight checks the binaries on ``runner.SUBPROCESS_PATH`` and
    sweep picks the model with ``runner.bedrock_enabled``, while the reviewer is launched
    with what ``reviewer_env`` composes, so a copy that drifted would let the harness and
    the CLI disagree about the PATH or the provider.
    """

    RE_EXPORTED = ("SUBPROCESS_PATH", "BEDROCK_SWITCH", "bedrock_enabled", "build_env")

    def test_runner_re_exports_the_reviewer_env_objects_themselves(self):
        for name in self.RE_EXPORTED:
            with self.subTest(name=name):
                self.assertIs(getattr(runner, name), getattr(reviewer_env, name))

    def test_each_re_exported_name_is_published_by_runner(self):
        for name in self.RE_EXPORTED:
            with self.subTest(name=name):
                self.assertIn(name, runner.__all__)


class TestRetry(RunnerTestCase):
    """A missing or invalid verdict is retried once, then recorded rather than dropped."""

    def test_a_missing_verdict_is_retried_and_the_second_attempt_can_succeed(self):
        result = self.review(
            (0, envelope(result_element()), None),
            (0, envelope(result_element()), GOOD_VERDICT),
        )
        self.assertEqual(result.outcome, runner.Outcome.SUCCESS)
        self.assertEqual(len(self.last_cli.calls), 2)

    def test_both_attempts_are_billed_to_the_pull_request(self):
        result = self.review((0, envelope(result_element()), None))
        self.assertEqual(result.outcome, runner.Outcome.NO_VERDICT)
        self.assertEqual(len(self.last_cli.calls), 2)
        self.assertAlmostEqual(result.cost_usd, 2 * 1.3312)
        self.assertEqual(result.num_turns, 54)

    def test_a_stale_verdict_from_the_first_attempt_is_not_read_as_the_seconds(self):
        # The first attempt writes nothing and is retried; the second must not pick up a
        # verdict left behind by anything earlier in the run directory.
        runner.verdict_path(self.run_dir).write_text(json.dumps(GOOD_VERDICT))
        result = self.review((0, envelope(result_element()), None))
        self.assertEqual(result.outcome, runner.Outcome.NO_VERDICT)

    def test_a_rejected_verdict_is_recorded_rather_than_re_rolled(self):
        # Re-running a review whose answer the harness disliked makes this last-of-two
        # rather than CI's single draw.
        bad = {**GOOD_VERDICT, "reason": "vibes"}
        result = self.review((0, envelope(result_element()), bad))
        self.assertEqual(result.outcome, runner.Outcome.SCHEMA_INVALID)
        self.assertEqual(len(self.last_cli.calls), 1)
        self.assertFalse(result.retried)

    def test_a_retried_row_says_so(self):
        # A reader comparing against CI's single draw has to be able to exclude these.
        result = self.review(
            (0, envelope(result_element()), None),
            (0, envelope(result_element()), GOOD_VERDICT),
        )
        self.assertTrue(result.retried)

    def test_a_single_draw_is_not_marked_retried(self):
        self.assertFalse(
            self.review((0, envelope(result_element()), GOOD_VERDICT)).retried
        )

    def test_a_timeout_is_not_retried(self):
        self.review((124, "", None))
        self.assertEqual(len(self.last_cli.calls), 1)

    def test_a_budget_trip_is_not_retried(self):
        self.review((1, envelope(result_element(result=ABSENT)), None))
        self.assertEqual(len(self.last_cli.calls), 1)


class TestInvocation(RunnerTestCase):
    """The command line and environment carry the parts without which a run is wrong."""

    def command(self):
        self.review((0, envelope(result_element()), GOOD_VERDICT))
        return self.last_cli.calls[0]

    def test_the_turn_record_is_requested(self):
        # Without --verbose the output is a lone result object and a budget trip is
        # unrecoverable, because there is no turn record to walk.
        self.assertIn("--verbose", self.command()["command"])

    def test_both_the_workspace_and_the_run_directory_are_added_roots(self):
        # The run dir is a SIBLING of the workspace, so --restricted does not reach it via
        # the workspace root; without its own --add-dir every remapped read is denied.
        argv = self.command()["command"]
        added = [argv[i + 1] for i, token in enumerate(argv) if token == "--add-dir"]
        self.assertEqual(added, [str(self.workspace), str(self.run_dir)])

    def test_the_tool_allowlist_comes_from_the_policy(self):
        argv = self.command()["command"]
        self.assertEqual(argv[argv.index("--tools") + 1], self.policy.tools)

    def test_the_effort_level_comes_from_the_policy(self):
        # Omitting it runs the reviewer at the CLI default while the policy says otherwise,
        # and nothing in the output envelope would reveal the difference.
        argv = self.command()["command"]
        self.assertEqual(argv[argv.index("--effort") + 1], self.policy.effort)

    def test_a_policy_that_retunes_the_effort_is_honoured(self):
        self.policy = dataclasses.replace(self.policy, effort="low")
        argv = self.command()["command"]
        self.assertEqual(argv[argv.index("--effort") + 1], "low")

    def test_what_the_reviewer_ran_at_is_logged_because_it_cannot_be_read_back(self):
        # --effort is echoed nowhere in the JSON envelope, so this log line is the only
        # record that a completed run used the effort the policy asked for.
        with self.assertLogs(runner.logger, level="INFO") as captured:
            self.review((0, envelope(result_element()), GOOD_VERDICT))
        launch = "\n".join(captured.output)
        self.assertIn(f"effort={self.policy.effort}", launch)
        self.assertIn(f"model={runner.DEFAULT_MODEL}", launch)

    def test_the_process_group_is_covered_by_a_plain_timeout(self):
        argv = self.command()["command"]
        self.assertEqual(
            argv[:4], ["timeout", "-k", "10", str(runner.DEFAULT_TIMEOUT_S)]
        )
        self.assertNotIn("--foreground", argv)

    def test_the_timeout_sits_above_the_policys_hard_review_budget(self):
        # A step timeout below the hard budget would kill the reviewer before the pacing
        # hook's final tier ever fired, so it would never be told to write up and stop.
        hard_budget_s = self.policy.review_budget_minutes[2] * 60
        self.assertGreater(runner.DEFAULT_TIMEOUT_S, hard_budget_s)

    def test_the_prompt_reaches_the_reviewer_with_its_interpolations_resolved(self):
        prompt = self.command()["prompt"]
        self.assertIn("PR #167890", prompt)
        self.assertIn("a" * 40, prompt)
        self.assertNotIn("${{", prompt)

    def test_the_read_sandbox_is_given_the_workspace_it_fails_closed_without(self):
        self.assertEqual(self.command()["env"]["GITHUB_WORKSPACE"], str(self.workspace))

    def test_the_pacing_hooks_rate_limit_state_is_per_run(self):
        self.assertEqual(self.command()["env"]["RUNNER_TEMP"], str(self.run_dir))

    def test_the_pacing_hook_is_left_quoting_the_path_the_model_may_write(self):
        # Its tier-4 text quotes GREENLIGHT_REVIEW_VERDICT_FILE back to the model, and the
        # model may only ever write the literal /tmp path: restrict-write.sh compares that
        # exact string and remap.py rewrites that exact string. Overriding it would hand
        # the model a forbidden path at the hard deadline.
        self.assertNotIn("GREENLIGHT_REVIEW_VERDICT_FILE", self.command()["env"])

    def test_nothing_reaches_the_reviewer_that_was_not_put_there(self):
        allowed = {
            "HOME",
            "PATH",
            "TERM",
            "GITHUB_WORKSPACE",
            remap.RUN_DIR_ENV,
            "GREENLIGHT_REVIEW_VERDICT_FILE",
            "RUNNER_TEMP",
            "GREENLIGHT_REVIEW_START_EPOCH",
            "GREENLIGHT_REVIEW_TARGET_DEADLINE",
            "GREENLIGHT_REVIEW_SOFT_DEADLINE",
            "GREENLIGHT_REVIEW_HARD_DEADLINE",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
            "CLAUDE_CODE_USE_BEDROCK",
            "AWS_REGION",
        }
        self.assertEqual(set(self.command()["env"]) - allowed, set())


class TestBedrockMode(RunnerTestCase):
    """CLAUDE_CODE_USE_BEDROCK puts the reviewer on Claude Code's Bedrock provider.

    The reviewer's environment is built from nothing, so the switch reaches the CLI only as
    build_env passes it on: always as "1", so the harness and the CLI cannot read one value
    two ways. Credentials never follow it. A sweep can outlive the AWS session it started
    with, and a forwarded key would shadow the ~/.aws files each new reviewer rereads.
    """

    SWITCH = "CLAUDE_CODE_USE_BEDROCK"
    CREDENTIALS = {
        "AWS_ACCESS_KEY_ID": "test-access-key-id",
        "AWS_SECRET_ACCESS_KEY": "test-secret-access-key",
        "AWS_SESSION_TOKEN": "test-session-token",
        "AWS_PROFILE": "test-profile",
    }

    def env_under(self, switch, **ambient):
        """``bedrock_enabled`` and ``build_env`` with ``switch`` and ``ambient`` exported.

        None unsets a variable, so whatever the developer's own shell exports cannot leak
        into a case that is about its absence.
        """
        with mock.patch.dict(os.environ, clear=False):
            for name, value in {self.SWITCH: switch, **ambient}.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            enabled = runner.bedrock_enabled()
            env = runner.build_env(
                self.workspace, self.run_dir, budget_minutes=(20, 25, 33), now=1000
            )
        return enabled, env

    def test_one_or_true_in_any_case_hands_the_cli_the_switch_and_the_region(self):
        for switch in ("1", "true", "TRUE", " true "):
            with self.subTest(switch=switch):
                enabled, env = self.env_under(switch, AWS_REGION="us-east-1")
                self.assertTrue(enabled)
                self.assertEqual(env[self.SWITCH], "1")
                self.assertEqual(env["AWS_REGION"], "us-east-1")

    def test_any_other_value_leaves_the_switch_and_the_region_out(self):
        for switch in (None, "", "0", "false", "yes"):
            with self.subTest(switch=switch):
                enabled, env = self.env_under(switch, AWS_REGION="us-east-1")
                self.assertFalse(enabled)
                self.assertNotIn(self.SWITCH, env)
                self.assertNotIn("AWS_REGION", env)

    def test_credential_variables_never_reach_the_reviewer(self):
        for switch in ("1", None):
            with self.subTest(switch=switch):
                _, env = self.env_under(
                    switch, AWS_REGION="us-east-1", **self.CREDENTIALS
                )
                self.assertEqual(set(env) & set(self.CREDENTIALS), set())

    def test_an_unset_region_is_not_invented(self):
        _, env = self.env_under("1", AWS_REGION=None)
        self.assertEqual(env[self.SWITCH], "1")
        self.assertNotIn("AWS_REGION", env)

    def test_the_rest_of_the_environment_is_the_same_in_both_modes(self):
        _, baseline = self.env_under(
            None, AWS_REGION=None, **dict.fromkeys(self.CREDENTIALS)
        )
        for switch in (None, "", "0", "false", "yes"):
            with self.subTest(switch=switch):
                _, env = self.env_under(
                    switch, AWS_REGION="us-east-1", **self.CREDENTIALS
                )
                self.assertEqual(env, baseline)
        _, env = self.env_under("1", AWS_REGION="us-east-1", **self.CREDENTIALS)
        added = {name: env.pop(name) for name in (self.SWITCH, "AWS_REGION")}
        self.assertEqual(added, {self.SWITCH: "1", "AWS_REGION": "us-east-1"})
        self.assertEqual(env, baseline)

    def test_the_launched_reviewer_is_given_the_switch(self):
        with mock.patch.dict(os.environ, {self.SWITCH: "true"}, clear=False):
            self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(self.last_cli.calls[0]["env"][self.SWITCH], "1")


class TestReviewBudget(RunnerTestCase):
    """The policy's budget reaches the pacing hook as absolute deadlines.

    budget-reminder.sh is the reviewer's only signal of elapsed time -- it has no Bash and
    so no clock -- the skill's Time budget section tells it so, and the hook's final tier
    restates the decision rule. A silent hook makes those parts of the policy false to the
    model and it paces differently, so this is verdict-shaping rather than cosmetic.
    """

    def deadlines(self):
        self.review((0, envelope(result_element()), GOOD_VERDICT))
        return self.last_cli.calls[0]["env"]

    def test_the_policys_budget_reaches_the_hook_environment(self):
        env = self.deadlines()
        start = int(env["GREENLIGHT_REVIEW_START_EPOCH"])
        target, soft, hard = self.policy.review_budget_minutes
        self.assertEqual(
            int(env["GREENLIGHT_REVIEW_TARGET_DEADLINE"]), start + target * 60
        )
        self.assertEqual(int(env["GREENLIGHT_REVIEW_SOFT_DEADLINE"]), start + soft * 60)
        self.assertEqual(int(env["GREENLIGHT_REVIEW_HARD_DEADLINE"]), start + hard * 60)

    def test_a_retuned_policy_budget_is_honoured_rather_than_a_pinned_one(self):
        self.policy = dataclasses.replace(self.policy, review_budget_minutes=(5, 7, 9))
        env = self.deadlines()
        start = int(env["GREENLIGHT_REVIEW_START_EPOCH"])
        self.assertEqual(int(env["GREENLIGHT_REVIEW_HARD_DEADLINE"]), start + 9 * 60)

    def test_the_four_epochs_come_from_one_clock_reading(self):
        env = self.deadlines()
        start = int(env["GREENLIGHT_REVIEW_START_EPOCH"])
        target, soft, hard = self.policy.review_budget_minutes
        offsets = {
            int(env[f"GREENLIGHT_REVIEW_{tier}_DEADLINE"]) - start
            for tier in ("TARGET", "SOFT", "HARD")
        }
        self.assertEqual(offsets, {target * 60, soft * 60, hard * 60})

    def test_the_deadlines_are_absolute_epochs_the_hook_can_compare_against_date(self):
        env = runner.build_env(
            self.workspace, self.run_dir, budget_minutes=(20, 25, 33), now=1000
        )
        self.assertEqual(env["GREENLIGHT_REVIEW_START_EPOCH"], "1000")
        self.assertEqual(env["GREENLIGHT_REVIEW_TARGET_DEADLINE"], str(1000 + 20 * 60))

    def test_no_budget_leaves_the_pacing_hook_silent_rather_than_pacing_against_garbage(
        self,
    ):
        env = runner.build_env(self.workspace, self.run_dir)
        self.assertNotIn("GREENLIGHT_REVIEW_HARD_DEADLINE", env)

    def test_a_policy_without_the_field_degrades_to_silence_rather_than_aborting(self):
        # Read with getattr on purpose: an older Policy should cost the sweep a quieter
        # review, not an AttributeError per pull request.
        stripped = _PolicyWithoutBudget(self.policy)
        with mock.patch.object(
            runner,
            "_invoke_cli",
            FakeCli((0, envelope(result_element()), GOOD_VERDICT)),
        ) as fake:
            runner.run_review(
                stripped,
                self.workspace,
                self.inputs,
                self.run_dir,
                pr_number=1,
                head_sha="a" * 40,
            )
        self.assertNotIn("GREENLIGHT_REVIEW_HARD_DEADLINE", fake.calls[0]["env"])


class TestInputPlacement(RunnerTestCase):
    """Inputs that are not where the remap points are refused before any money is spent."""

    def run_review_expecting_failure(self, inputs, run_dir):
        with self.assertRaises(ValueError) as caught:
            runner.run_review(
                self.policy,
                self.workspace,
                inputs,
                run_dir,
                pr_number=1,
                head_sha="a" * 40,
            )
        return str(caught.exception)

    def test_a_run_directory_outside_the_read_sandboxs_prefix_is_refused(self):
        outside = self.scratch("replay-")
        message = self.run_review_expecting_failure(self.inputs, outside)
        self.assertIn(remap.scratch_prefix(), message)

    def test_a_diff_written_somewhere_other_than_the_run_directory_is_refused(self):
        elsewhere = self.scratch("greenlight-elsewhere-")
        stray = elsewhere / remap.DIFF_BASENAME
        stray.write_text("diff\n")
        message = self.run_review_expecting_failure(
            dataclasses.replace(self.inputs, diff_path=stray), self.run_dir
        )
        self.assertIn(remap.DIFF_BASENAME, message)

    def test_metadata_written_somewhere_other_than_the_run_directory_is_refused(self):
        elsewhere = self.scratch("greenlight-elsewhere-")
        message = self.run_review_expecting_failure(
            dataclasses.replace(
                self.inputs, metadata_path=elsewhere / remap.METADATA_BASENAME
            ),
            self.run_dir,
        )
        self.assertIn(remap.METADATA_BASENAME, message)

    def test_absent_metadata_is_allowed_because_ci_tolerates_it(self):
        # The workflow's metadata step is continue-on-error, so a PR whose metadata could
        # not be fetched is reviewed without it rather than skipped.
        result = self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(result.outcome, runner.Outcome.SUCCESS)

    def with_stack(self, *entries, diffs=()):
        """The inputs plus a stack laid out under ``stack``'s names, not the remap's.

        That way the cases below also fail if the writer and the remap stop agreeing on
        where the stack lives.
        """
        directory = self.run_dir / stack_mod.STACK_DIRNAME
        directory.mkdir()
        for number in diffs:
            (directory / f"{number}.diff").write_text("diff --git a/x b/x\n")
        stack_path = self.run_dir / stack_mod.STACK_FILENAME
        stack_path.write_text(json.dumps({"stack": list(entries)}), encoding="utf-8")
        return dataclasses.replace(self.inputs, stack_path=stack_path)

    def test_a_stack_whose_diffs_the_remap_reaches_is_reviewed(self):
        self.inputs = self.with_stack(sibling(167891), THIS_PR, diffs=[167891])
        result = self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(result.outcome, runner.Outcome.SUCCESS)

    def test_a_stack_with_nothing_open_above_the_pr_is_reviewed(self):
        self.inputs = self.with_stack(THIS_PR)
        result = self.review((0, envelope(result_element()), GOOD_VERDICT))
        self.assertEqual(result.outcome, runner.Outcome.SUCCESS)

    def test_a_stack_written_somewhere_other_than_the_run_directory_is_refused(self):
        elsewhere = self.scratch("greenlight-elsewhere-")
        message = self.run_review_expecting_failure(
            dataclasses.replace(
                self.inputs, stack_path=elsewhere / stack_mod.STACK_FILENAME
            ),
            self.run_dir,
        )
        self.assertIn(remap.STACK_BASENAME, message)

    def test_a_stack_naming_a_diff_that_was_never_written_is_refused(self):
        inputs = self.with_stack(sibling(167891), THIS_PR)
        message = self.run_review_expecting_failure(inputs, self.run_dir)
        self.assertIn("/tmp/greenlight-stack/167891.diff", message)

    def test_a_stack_naming_a_diff_the_remap_does_not_rewrite_is_refused(self):
        stray = {**sibling(167891), "diff": "/tmp/greenlight-stacks/167891.diff"}
        inputs = self.with_stack(stray, THIS_PR, diffs=[167891])
        message = self.run_review_expecting_failure(inputs, self.run_dir)
        self.assertIn("/tmp/greenlight-stacks/167891.diff", message)

    def test_a_leftover_stack_file_is_refused_when_no_stack_was_built(self):
        leftover = self.run_dir / stack_mod.STACK_FILENAME
        leftover.write_text(json.dumps({"stack": [THIS_PR]}), encoding="utf-8")
        message = self.run_review_expecting_failure(self.inputs, self.run_dir)
        self.assertIn(str(leftover), message)

    def test_a_leftover_stack_directory_is_refused_when_no_stack_was_built(self):
        leftover = self.run_dir / stack_mod.STACK_DIRNAME
        leftover.mkdir()
        message = self.run_review_expecting_failure(self.inputs, self.run_dir)
        self.assertIn(str(leftover), message)


if __name__ == "__main__":
    unittest.main()
