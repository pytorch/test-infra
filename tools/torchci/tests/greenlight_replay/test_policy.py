"""Tests for reading the greenlight policy out of a materialized test-infra tree.

Nothing here touches the network: ``_checkout`` is the module's only reach out, and
every test either patches it over a tree written to a temp directory or asserts on the
refspec it was handed. The trees are built from this repository's own files --
greenlight's code, the hooks, the record job -- so the target and the record checks run
as the arm's real code, with the workflow's review job written per test.

One case deliberately reads the repository's own workflow rather than a fixture. The
fixtures pin how this module behaves; that case pins that it still fits the file it
exists to parse, which a hand-written fixture can never tell you.
"""

import copy
import dataclasses
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from replay_runner_fixtures import (
    build_arm_tree,
    HEAD_WORKFLOW,
    REPO_POLICIES_RELPATH,
    REPO_ROOT,
)
from torchci.greenlight_replay import (
    checkout as checkout_mod,
    policy as policy_mod,
    workflow as workflow_mod,
    workflow_steps,
)
from torchci.greenlight_replay.arm_code import Target
from torchci.greenlight_replay.checkout import SCRUBBED_GIT_VARS
from torchci.greenlight_replay.policy import materialize
from torchci.greenlight_replay.prompt import render_prompt


CHECKOUT_SEAM = "_checkout"
GIT_SEAM = "_git"
# The trees written here are not registered shapes; test_ledger covers that check.
LEDGER_SEAM = "require_registered"

ACTION_USES = "anthropics/claude-code-action@593d7a5c4e0073569f74772c2b7b64c30ec14707"
CLAUDE_ARGS = (
    "--model global.anthropic.claude-opus-5 --effort high "
    '--allowedTools "Read,Glob,Grep,Write"'
)
PROMPT = (
    "You are reviewing pytorch/pytorch PR #${{ github.event.inputs.pr_number }}\n"
    "at commit ${{ github.event.inputs.head_sha }}.\n"
)
DEFAULT_CAPS = {
    "MAX_DIFF_LINES": "2000",
    "MAX_DIFF_BYTES": "500000",
    "MAX_DIFF_FILES": "200",
}
DEFAULT_BUDGETS = {
    "GREENLIGHT_REVIEW_TARGET_BUDGET_MIN": "20",
    "GREENLIGHT_REVIEW_SOFT_BUDGET_MIN": "25",
    "GREENLIGHT_REVIEW_HARD_BUDGET_MIN": "33",
}
OUTPUT_STYLE = '{"outputStyle": "Concise"}'

TOO_LARGE_VERDICT = {
    "status": "NO_LAND",
    "reason": "scope_too_large",
    "message": "- Scope\n  - too big",
}


def head_step(needle):
    """The one step of this repository's workflow whose ``run:`` holds ``needle``."""
    (step,) = [
        step
        for job in HEAD_WORKFLOW["jobs"].values()
        for step in job.get("steps") or []
        if needle in str(step.get("run") or "")
    ]
    return step


HOOKS_STEP = head_step(workflow_steps.SETTINGS_LOCAL_RELPATH)
DETECTOR_STEP = head_step(workflow_steps.DETECTOR_RELPATH)
KEEP_POLICY_STEP = head_step("jq -n")
(RECORD_JOB,) = [
    job
    for job in HEAD_WORKFLOW["jobs"].values()
    if any(
        workflow_steps.RECORD_VERDICT_ASSIGNMENT in str(step.get("run") or "")
        for step in job.get("steps") or []
    )
]


def action_step(
    claude_args=CLAUDE_ARGS,
    prompt=PROMPT,
    name="Run Green Light review",
    timeout=37,
    settings=OUTPUT_STYLE,
):
    step = {
        "name": name,
        "timeout-minutes": timeout,
        "uses": ACTION_USES,
        "with": {
            "settings": settings,
            "claude_args": claude_args,
            "prompt": prompt,
        },
    }
    if timeout is None:
        del step["timeout-minutes"]
    if settings is None:
        del step["with"]["settings"]
    return step


def sizecheck_step(env=None, name="Decline oversized diffs"):
    return {
        "name": name,
        "id": "sizecheck",
        "env": dict(DEFAULT_CAPS if env is None else env),
    }


def workflow_document(steps, jobs=None, setup=None):
    """A workflow with ``steps`` as its review job, beside this repository's own hook,
    keep-policy and detector steps and its record job.

    ``setup`` replaces those three steps, so a case can mutate one of them.
    """
    jobs = dict(
        jobs
        if jobs is not None
        else {"review": {"env": dict(DEFAULT_BUDGETS), "steps": steps}}
    )
    jobs["setup"] = {
        "steps": copy.deepcopy(
            setup
            if setup is not None
            else [HOOKS_STEP, KEEP_POLICY_STEP, DETECTOR_STEP]
        )
    }
    jobs["record"] = copy.deepcopy(RECORD_JOB)
    return {"name": "Green Light PR Review", "jobs": jobs}


def write_tree(root: Path, steps, jobs=None, setup=None, **layout) -> None:
    """A test-infra tree whose review job is ``steps``, its canned verdict the fixture's."""
    build_arm_tree(
        root, workflow_document=workflow_document(steps, jobs, setup), **layout
    )
    hooks = root / policy_mod.HOOKS_RELPATH
    (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(json.dumps(TOO_LARGE_VERDICT))


class PolicyTreeTestCase(unittest.TestCase):
    """Fixture only: a temp tree plus a materialize that patches out the fetch and the
    shape check."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "policy"
        self.root.mkdir()

    def materialize(
        self, steps, ref="8829", jobs=None, repo="pytorch/pytorch", **layout
    ):
        write_tree(self.root, steps, jobs, **layout)
        return self.materialize_written(ref, repo)

    def materialize_written(self, ref="8829", repo="pytorch/pytorch"):
        with mock.patch.object(
            policy_mod, CHECKOUT_SEAM
        ) as checkout, mock.patch.object(policy_mod, LEDGER_SEAM):
            result = materialize(ref, self.root, reviewed_repo=repo)
        self.checkout = checkout
        return result

    def review_job(self, steps, env):
        return {"review": {"env": env, "steps": steps}}


class MaterializeTest(PolicyTreeTestCase):
    """The policy is whatever the materialized tree says, read by shape not position."""

    def test_a_pull_request_number_resolves_to_its_head_ref_not_its_merge_ref(self):
        self.materialize([action_step(), sizecheck_step()], ref="8829")
        _repo, refspec, _dest = self.checkout.call_args.args
        self.assertEqual(refspec, "refs/pull/8829/head")

    def test_a_branch_name_is_fetched_as_given(self):
        self.materialize([action_step(), sizecheck_step()], ref="main")
        _repo, refspec, _dest = self.checkout.call_args.args
        self.assertEqual(refspec, "main")

    def test_the_action_step_is_found_after_being_renamed_and_moved_last(self):
        steps = [
            sizecheck_step(),
            {"name": "Run Green Light review", "run": "echo decoy"},
            action_step(name="Ask the model, politely"),
        ]
        result = self.materialize(steps)
        self.assertEqual(result.prompt_template, PROMPT)

    def test_two_action_steps_abort_rather_than_picking_one(self):
        steps = [action_step(), action_step(), sizecheck_step()]
        with self.assertRaises(ValueError) as caught:
            self.materialize(steps)
        self.assertIn(workflow_mod.ACTION_USES_PREFIX, str(caught.exception))

    def test_no_action_step_aborts_naming_the_file_and_the_uses_prefix(self):
        with self.assertRaises(ValueError) as caught:
            self.materialize([sizecheck_step()])
        message = str(caught.exception)
        self.assertIn(workflow_mod.WORKFLOW_RELPATH, message)
        self.assertIn(workflow_mod.ACTION_USES_PREFIX, message)

    def test_a_missing_prompt_aborts_naming_the_key(self):
        step = action_step()
        del step["with"]["prompt"]
        with self.assertRaises(ValueError) as caught:
            self.materialize([step, sizecheck_step()])
        self.assertIn("with.prompt", str(caught.exception))

    def test_allowed_tools_becomes_the_hard_tool_allowlist(self):
        result = self.materialize([action_step(), sizecheck_step()])
        self.assertEqual(result.tools, "Read,Glob,Grep,Write")
        self.assertEqual(result.model, "global.anthropic.claude-opus-5")
        self.assertEqual(result.effort, "high")

    def test_equals_joined_claude_args_are_read_too(self):
        args = "--model=opus --effort=high --allowedTools=Read,Glob"
        result = self.materialize([action_step(claude_args=args), sizecheck_step()])
        self.assertEqual(
            (result.model, result.effort, result.tools), ("opus", "high", "Read,Glob")
        )

    def test_claude_args_without_an_allowlist_aborts(self):
        args = "--model global.anthropic.claude-opus-5 --effort high"
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(claude_args=args), sizecheck_step()])
        self.assertIn(workflow_mod.ALLOWED_TOOLS_FLAG, str(caught.exception))

    def test_claude_args_carrying_anything_the_replay_does_not_reproduce_abort(self):
        base = "--model m --effort high --allowedTools Read,Glob,Grep,Write"
        for args, needle in (
            (f"{base} --permission-mode acceptEdits", "--permission-mode"),
            (f"{base} --max-turns 9", "--max-turns"),
            ("--model m --effort high --allowedTools Read,Bash", "Read,Bash"),
            ('--model m --effort high --allowedTools "Read Bash(git:*)"', "Bash"),
            ("--model m --effort high --allowedTools Read(./x)", "Read(./x)"),
            (f"{base} --model n", "twice"),
            (f"stray {base}", "stray"),
            ("--model m --effort --allowedTools Read", "--effort"),
        ):
            with self.subTest(args=args):
                with self.assertRaises(ValueError) as caught:
                    self.materialize([action_step(claude_args=args), sizecheck_step()])
                self.assertIn(needle, str(caught.exception))

    def test_an_allowlist_split_on_commas_and_spaces_is_normalized(self):
        args = '--model m --effort high --allowedTools "Read, Glob Grep"'
        result = self.materialize([action_step(claude_args=args), sizecheck_step()])
        self.assertEqual(result.tools, "Read,Glob,Grep")

    def test_the_diff_caps_are_read_as_integers(self):
        result = self.materialize([action_step(), sizecheck_step()])
        self.assertEqual(result.max_diff_lines, 2000)
        self.assertEqual(result.max_diff_bytes, 500000)
        self.assertEqual(result.max_diff_files, 200)

    def test_a_size_gate_without_a_file_cap_has_none(self):
        env = {"MAX_DIFF_LINES": "2000", "MAX_DIFF_BYTES": "500000"}
        result = self.materialize([action_step(), sizecheck_step(env=env)])
        self.assertIsNone(result.max_diff_files)

    def test_a_file_cap_that_is_not_a_literal_integer_aborts(self):
        env = dict(DEFAULT_CAPS, MAX_DIFF_FILES="${{ vars.CAP }}")
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(), sizecheck_step(env=env)])
        self.assertIn(workflow_mod.MAX_DIFF_FILES_KEY, str(caught.exception))

    def test_a_missing_line_cap_aborts_rather_than_disabling_the_gate(self):
        step = sizecheck_step(env={"MAX_DIFF_BYTES": "500000"})
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(), step])
        self.assertIn(workflow_mod.MAX_DIFF_LINES_KEY, str(caught.exception))

    def test_a_sizecheck_step_with_no_env_at_all_aborts(self):
        step = sizecheck_step()
        del step["env"]
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(), step])
        self.assertIn(workflow_mod.MAX_DIFF_LINES_KEY, str(caught.exception))

    def test_an_unresolved_vars_lookup_in_a_cap_aborts(self):
        step = sizecheck_step(
            env={
                "MAX_DIFF_LINES": "${{ vars.PYTORCH_GREENLIGHT_MAX_DIFF_LINES }}",
                "MAX_DIFF_BYTES": "500000",
            }
        )
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(), step])
        self.assertIn(workflow_mod.MAX_DIFF_LINES_KEY, str(caught.exception))

    def test_a_cap_with_a_digit_separator_aborts_as_the_shell_check_would(self):
        step = sizecheck_step(env={"MAX_DIFF_LINES": "2_000", "MAX_DIFF_BYTES": "1"})
        with self.assertRaises(ValueError):
            self.materialize([action_step(), step])

    def test_the_canned_verdict_comes_from_the_materialized_tree(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        edited = dict(TOO_LARGE_VERDICT, reason="review_error")
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(json.dumps(edited))
        result = self.materialize_written()
        self.assertEqual(result.too_large_verdict, edited)

    def test_a_canned_verdict_missing_a_key_aborts(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(
            json.dumps({"status": "NO_LAND", "reason": "scope_too_large"})
        )
        with self.assertRaises(ValueError) as caught:
            self.materialize_written()
        self.assertIn("message", str(caught.exception))

    def test_a_missing_hook_file_aborts_naming_it(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        (self.root / policy_mod.HOOKS_RELPATH / policy_mod.SANITIZE_FILENAME).unlink()
        with self.assertRaises(FileNotFoundError) as caught:
            self.materialize_written()
        self.assertIn(policy_mod.SANITIZE_FILENAME, str(caught.exception))


class ActionStepTest(PolicyTreeTestCase):
    """The run's timeout and output style are the action step's own."""

    def test_the_timeout_is_the_steps_timeout_minutes(self):
        result = self.materialize([action_step(timeout=30), sizecheck_step()])
        self.assertEqual(result.timeout_s, 30 * 60)

    def test_a_timeout_the_replay_credentials_would_not_outlive_aborts(self):
        for timeout in (None, 0, 41, 360, "37", True):
            with self.subTest(timeout=timeout):
                with self.assertRaises(ValueError) as caught:
                    self.materialize([action_step(timeout=timeout), sizecheck_step()])
                self.assertIn("timeout-minutes", str(caught.exception))

    def test_the_output_style_comes_from_with_settings(self):
        settings = '{"outputStyle": "Explanatory"}'
        result = self.materialize([action_step(settings=settings), sizecheck_step()])
        self.assertEqual(result.output_style, "Explanatory")

    def test_a_step_without_settings_sets_no_output_style(self):
        result = self.materialize([action_step(settings=None), sizecheck_step()])
        self.assertIsNone(result.output_style)

    def test_settings_holding_anything_but_an_output_style_abort(self):
        for settings in (
            '{"outputStyle": "Concise", "model": "x"}',
            '{"permissions": {"allow": ["Bash"]}}',
            '{"outputStyle": 3}',
            "[]",
            "{",
            "{}",
        ):
            with self.subTest(settings=settings):
                with self.assertRaises(ValueError) as caught:
                    self.materialize([action_step(settings=settings), sizecheck_step()])
                self.assertIn("with.settings", str(caught.exception))


class DerivedStepsTest(PolicyTreeTestCase):
    """The hooks, the detector and the record checks come from the tree's own steps."""

    def test_the_head_steps_give_hooks_detector_and_record_step(self):
        result = self.materialize([action_step(), sizecheck_step()])
        self.assertEqual(result.target.checkout, "pytorch")
        self.assertIn("Stop", result.hook_settings["hooks"])
        self.assertEqual(result.detector_dirname, "pytorch")
        self.assertEqual(
            result.detector_script, self.root / workflow_steps.DETECTOR_RELPATH
        )
        self.assertIn(workflow_steps.RECORD_VERDICT_ASSIGNMENT, result.record_step)
        self.assertIsNone(result.no_policy_verdict)

    def setup_with(self, index, step):
        setup = [HOOKS_STEP, KEEP_POLICY_STEP, DETECTOR_STEP]
        setup[index] = step
        return setup

    def test_a_workflow_writing_no_hook_settings_aborts(self):
        setup = self.setup_with(0, {"name": "Set up review hooks", "run": "true"})
        write_tree(self.root, [action_step(), sizecheck_step()], setup=setup)
        with self.assertRaises(ValueError) as caught:
            self.materialize_written()
        self.assertIn(workflow_steps.SETTINGS_LOCAL_RELPATH, str(caught.exception))

    def test_an_unquoted_heredoc_is_not_read(self):
        # Unquoted, the shell expands $RUNNER_TEMP when the file is written.
        step = dict(HOOKS_STEP, run=HOOKS_STEP["run"].replace("<<'EOF'", "<<EOF"))
        write_tree(
            self.root, [action_step(), sizecheck_step()], setup=self.setup_with(0, step)
        )
        with self.assertRaises(ValueError):
            self.materialize_written()

    def test_a_detector_step_in_neither_known_form_aborts(self):
        for run, env in (
            (DETECTOR_STEP["run"] + " --untrusted-root /tmp", DETECTOR_STEP["env"]),
            (DETECTOR_STEP["run"], {"CHECKOUT": "pytorch"}),
            (DETECTOR_STEP["run"], None),
        ):
            with self.subTest(run=run, env=env):
                step = {**DETECTOR_STEP, "run": run, "env": env}
                write_tree(
                    self.root,
                    [action_step(), sizecheck_step()],
                    setup=self.setup_with(2, step),
                )
                with self.assertRaises(ValueError) as caught:
                    self.materialize_written()
                self.assertIn("detector", str(caught.exception))

    def test_a_detector_naming_pytorch_literally_checks_pytorch(self):
        step = {
            "name": DETECTOR_STEP["name"],
            "run": workflow_steps.DETECTOR_PYTORCH_RUN,
        }
        write_tree(
            self.root, [action_step(), sizecheck_step()], setup=self.setup_with(2, step)
        )
        self.assertEqual(self.materialize_written().detector_dirname, "pytorch")

    def edited_record_job(self, old, new):
        job = copy.deepcopy(RECORD_JOB)
        for step in job["steps"]:
            run = str(step.get("run") or "")
            if workflow_steps.RECORD_VERDICT_ASSIGNMENT in run:
                step["run"] = run.replace(old, new)
        return job

    def test_a_record_step_the_replay_cannot_run_as_written_aborts(self):
        for old, new, needle in (
            ("test -f", 'test -n "$RUN_ID" && test -f', "RUN_ID"),
            ("test -f", "test ${{ inputs.x }} && test -f", "expression"),
            (
                workflow_steps.RECORD_VERDICT_ASSIGNMENT,
                workflow_steps.RECORD_VERDICT_ASSIGNMENT
                + "\n"
                + workflow_steps.RECORD_VERDICT_ASSIGNMENT,
                "more than once",
            ),
            (
                workflow_steps.RECORD_VERDICT_ASSIGNMENT,
                "verdict=/tmp/other.json",
                "found 0",
            ),
        ):
            with self.subTest(new=new):
                jobs = {
                    "review": {
                        "env": dict(DEFAULT_BUDGETS),
                        "steps": [action_step(), sizecheck_step()],
                    },
                }
                document = workflow_document(None, jobs)
                document["jobs"]["record"] = self.edited_record_job(old, new)
                build_arm_tree(self.root, workflow_document=document)
                with self.assertRaises(ValueError) as caught:
                    self.materialize_written()
                self.assertIn(needle, str(caught.exception))

    def test_a_record_job_taking_eval_hash_elsewhere_aborts(self):
        document = workflow_document([action_step(), sizecheck_step()])
        document["jobs"]["record"]["env"]["EVAL_HASH"] = "0" * 64
        build_arm_tree(self.root, workflow_document=document)
        with self.assertRaises(ValueError) as caught:
            self.materialize_written()
        self.assertIn("EVAL_HASH", str(caught.exception))


class TargetTest(PolicyTreeTestCase):
    """The target is resolved once, by the tree's own target step."""

    def test_another_configured_repo_is_reviewed_in_target(self):
        result = self.materialize(
            [action_step(), sizecheck_step()],
            repo="pytorch/test-infra",
            extra_repos=["pytorch/test-infra"],
            policies=["pytorch.md", "test-infra.md"],
        )
        self.assertEqual(
            result.target,
            Target(
                "pytorch/test-infra",
                "target",
                f"{REPO_POLICIES_RELPATH}/test-infra.md",
                True,
            ),
        )
        self.assertEqual(result.detector_dirname, "target")
        self.assertIn("**/target/CLAUDE.md", result.hook_settings["claudeMdExcludes"])

    def test_an_unconfigured_repo_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.materialize([action_step(), sizecheck_step()], repo="pytorch/vision")
        self.assertIn("pytorch/vision", str(caught.exception))

    def test_a_repo_without_its_policy_file_gets_the_canned_no_policy_verdict(self):
        result = self.materialize(
            [action_step(), sizecheck_step()],
            repo="pytorch/test-infra",
            extra_repos=["pytorch/test-infra"],
        )
        self.assertFalse(result.target.policy_present)
        self.assertEqual(result.no_policy_verdict["status"], "NO_LAND")
        self.assertEqual(result.no_policy_verdict["reason"], "review_error")
        self.assertIn("pytorch/test-infra", result.no_policy_verdict["message"])

    def test_a_tree_without_the_target_step_materializes_for_pytorch_alone(self):
        # Its detector names pytorch literally, and its hooks carry no placeholder.
        text = HOOKS_STEP["run"]
        hooks = dict(
            HOOKS_STEP,
            run=text.replace(" __GREENLIGHT_CHECKOUT__", "").replace(
                "__GREENLIGHT_CHECKOUT__", "pytorch"
            ),
        )
        detector = {"name": "detect", "run": workflow_steps.DETECTOR_PYTORCH_RUN}
        layout = {"target_step": False, "policies": ()}
        write_tree(
            self.root,
            [action_step(), sizecheck_step()],
            setup=[hooks, detector],
            **layout,
        )
        result = self.materialize_written()
        self.assertEqual(
            result.target, Target("pytorch/pytorch", "pytorch", None, True)
        )
        self.assertIsNone(result.no_policy_verdict)
        with self.assertRaises(ValueError):
            self.materialize_written(repo="pytorch/test-infra")


class ReviewBudgetTest(PolicyTreeTestCase):
    """A silent budget hook is a policy the model is never told, so absence is fatal."""

    def test_the_three_budgets_are_read_in_target_soft_hard_order(self):
        result = self.materialize([action_step(), sizecheck_step()])
        self.assertEqual(result.review_budget_minutes, (20, 25, 33))

    def test_a_retuned_budget_is_honoured_rather_than_defaulted(self):
        env = dict(DEFAULT_BUDGETS, GREENLIGHT_REVIEW_HARD_BUDGET_MIN="45")
        steps = [action_step(), sizecheck_step()]
        result = self.materialize(steps, jobs=self.review_job(steps, env))
        self.assertEqual(result.review_budget_minutes, (20, 25, 45))

    def test_a_missing_hard_budget_aborts_naming_the_key(self):
        env = {
            key: value
            for key, value in DEFAULT_BUDGETS.items()
            if not key.endswith("HARD_BUDGET_MIN")
        }
        steps = [action_step(), sizecheck_step()]
        with self.assertRaises(ValueError) as caught:
            self.materialize(steps, jobs=self.review_job(steps, env))
        self.assertIn("GREENLIGHT_REVIEW_HARD_BUDGET_MIN", str(caught.exception))

    def test_a_non_numeric_budget_aborts_naming_the_key(self):
        env = dict(DEFAULT_BUDGETS, GREENLIGHT_REVIEW_SOFT_BUDGET_MIN="twenty-five")
        steps = [action_step(), sizecheck_step()]
        with self.assertRaises(ValueError) as caught:
            self.materialize(steps, jobs=self.review_job(steps, env))
        self.assertIn("GREENLIGHT_REVIEW_SOFT_BUDGET_MIN", str(caught.exception))

    def test_a_job_env_that_lost_the_budgets_entirely_aborts(self):
        steps = [action_step(), sizecheck_step()]
        with self.assertRaises(ValueError) as caught:
            self.materialize(steps, jobs=self.review_job(steps, {"UNRELATED": "1"}))
        self.assertIn("GREENLIGHT_REVIEW_TARGET_BUDGET_MIN", str(caught.exception))

    def test_two_jobs_carrying_the_budgets_abort_rather_than_picking_one(self):
        steps = [action_step(), sizecheck_step()]
        jobs = {
            "review": {"env": dict(DEFAULT_BUDGETS), "steps": steps},
            "review_shadow": {"env": dict(DEFAULT_BUDGETS), "steps": []},
        }
        with self.assertRaises(ValueError) as caught:
            self.materialize(steps, jobs=jobs)
        self.assertIn("found 2", str(caught.exception))

    def test_the_budgets_are_found_on_a_renamed_job(self):
        steps = [action_step(), sizecheck_step()]
        jobs = {"judge": {"env": dict(DEFAULT_BUDGETS), "steps": steps}}
        result = self.materialize(steps, jobs=jobs)
        self.assertEqual(result.review_budget_minutes, (20, 25, 33))


class CannedVerdictTest(PolicyTreeTestCase):
    """The canned decline is emitted with no model run, so the record path must take it.

    It is held to the record job's validation step and the tree's own ``greenlight
    verdict --dry-run``, the checks every verdict the workflow emits passes through.
    """

    def write_verdict(self, verdict):
        write_tree(self.root, [action_step(), sizecheck_step()])
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(json.dumps(verdict))
        return self.materialize_written()

    def test_a_status_outside_the_two_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.write_verdict(dict(TOO_LARGE_VERDICT, status="MAYBE"))
        self.assertIn("MAYBE", str(caught.exception))

    def test_a_reason_the_tree_does_not_allow_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.write_verdict(dict(TOO_LARGE_VERDICT, reason="too_chunky"))
        self.assertIn("too_chunky", str(caught.exception))

    def test_an_empty_message_aborts(self):
        with self.assertRaises(ValueError):
            self.write_verdict(dict(TOO_LARGE_VERDICT, message=""))

    def test_an_extra_field_is_accepted_as_the_record_path_accepts_it(self):
        result = self.write_verdict(dict(TOO_LARGE_VERDICT, severity="high"))
        self.assertEqual(result.too_large_verdict, TOO_LARGE_VERDICT)

    def test_a_reason_a_policy_pr_added_to_its_own_greenlight_is_accepted(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        constants = self.root / "greenlight/src/greenlight/constants.py"
        constants.write_text(
            constants.read_text().replace(
                '"needs_socialization",\n',
                '"needs_socialization",\n        "diff_unreadable",\n',
            )
        )
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(
            json.dumps(dict(TOO_LARGE_VERDICT, reason="diff_unreadable"))
        )
        result = self.materialize_written()
        self.assertEqual(result.too_large_verdict["reason"], "diff_unreadable")


class ShippedWorkflowTest(unittest.TestCase):
    """This module still fits the workflow it exists to parse."""

    @classmethod
    def setUpClass(cls):
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            cls.policy = materialize("main", REPO_ROOT, reviewed_repo="pytorch/pytorch")

    def test_the_repositorys_own_workflow_yields_a_complete_policy(self):
        result = self.policy
        self.assertTrue(result.tools)
        self.assertTrue(result.model)
        self.assertTrue(result.effort)
        self.assertGreater(result.max_diff_lines, 0)
        self.assertGreater(result.max_diff_bytes, 0)
        self.assertEqual(result.too_large_verdict["status"], "NO_LAND")
        self.assertEqual(result.target.repo, "pytorch/pytorch")
        self.assertEqual(result.output_style, "Concise")
        # Shape, not the shipped figures: retuning the budgets is a policy change the
        # harness is meant to honour, not a drift this test should block.
        self.assertEqual(len(result.review_budget_minutes), 3)
        for minutes in result.review_budget_minutes:
            self.assertGreater(minutes, 0)

    def test_the_shipped_timeout_sits_above_the_hard_review_budget(self):
        # A run timeout below the hard budget would kill the reviewer before the pacing
        # hook's final tier ever fired, so it would never be told to write up and stop.
        self.assertGreater(
            self.policy.timeout_s, self.policy.review_budget_minutes[2] * 60
        )

    def test_the_shipped_prompt_renders_with_no_interpolation_left(self):
        vision = Target(
            "pytorch/vision", "target", f"{REPO_POLICIES_RELPATH}/vision.md", True
        )
        for target, checkout in (
            (self.policy.target, "./pytorch"),
            (vision, "./target"),
        ):
            with self.subTest(repo=target.repo):
                result = dataclasses.replace(self.policy, target=target)
                rendered = render_prompt(result, 193118, "a" * 40)
                self.assertNotIn("${{", rendered)
                self.assertIn("193118", rendered)
                self.assertIn("a" * 40, rendered)
                self.assertIn(f"{target.repo} PR #193118", rendered)
                self.assertIn(checkout, rendered)


class RefspecTest(unittest.TestCase):
    """A refspec is never allowed to become a git option or a second endpoint."""

    def test_a_leading_dash_is_refused(self):
        with self.assertRaises(ValueError):
            policy_mod.refspec("--upload-pack=touch /tmp/pwned")

    def test_a_ref_with_parent_traversal_is_refused(self):
        with self.assertRaises(ValueError):
            policy_mod.refspec("refs/../../etc/passwd")

    def test_a_ghstack_base_ref_is_accepted(self):
        self.assertEqual(
            policy_mod.refspec("gh/jeanschmidt/42/base"), "gh/jeanschmidt/42/base"
        )


def fake_git(source: Path):
    """A ``_git`` stand-in: init and fetch do nothing, archive tars ``source`` for real.

    Everything downstream of the fetch is the code under test -- the clearing, the
    mkdir and the extraction -- so only the network is replaced. File modes ride along,
    as ``git archive`` keeps the executable bit the hooks need.
    """

    def run(argv, *, cwd, ceiling):
        if argv[0] != "archive":
            return
        output = next(a for a in argv if a.startswith("--output="))
        with tarfile.open(output[len("--output=") :], "w") as tar:
            for child in sorted(source.iterdir()):
                tar.add(child, arcname=child.name)

    return run


class MaterializeIsRepeatableTest(unittest.TestCase):
    """--resume and a repeated sweep both re-materialize over the previous tree."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        source = Path(self._tmp.name) / "source"
        source.mkdir()
        write_tree(source, [action_step(), sizecheck_step()])
        self.dest = Path(self._tmp.name) / "policy"
        self._patch = mock.patch.object(
            policy_mod, GIT_SEAM, side_effect=fake_git(source)
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)
        ledger = mock.patch.object(policy_mod, LEDGER_SEAM)
        ledger.start()
        self.addCleanup(ledger.stop)

    def materialize(self):
        return materialize("8829", self.dest, reviewed_repo="pytorch/pytorch")

    def test_materializing_twice_into_the_same_destination_yields_the_same_policy(self):
        first = self.materialize()
        second = self.materialize()
        self.assertEqual(first, second)

    def test_a_file_an_earlier_policy_left_behind_does_not_survive(self):
        self.materialize()
        stale = self.dest / "removed_by_the_new_policy.py"
        stale.write_text("from the previous policy")
        self.materialize()
        self.assertFalse(stale.exists())

    def test_the_second_tree_is_complete_rather_than_a_remnant(self):
        self.materialize()
        second = self.materialize()
        self.assertTrue(second.detector_script.is_file())
        self.assertTrue(second.sanitize_script.is_file())
        self.assertEqual(second.review_budget_minutes, (20, 25, 33))


class GitConfinementTest(unittest.TestCase):
    """The environment must not be able to redirect a git call at another repository."""

    def run_git(self, ceiling):
        with mock.patch.object(policy_mod, "subprocess") as sub:
            sub.run.return_value = subprocess.CompletedProcess([], 0, b"", b"")
            policy_mod._git(["init", "--bare"], cwd=ceiling, ceiling=ceiling)
        return sub.run.call_args

    def test_every_repository_naming_variable_is_scrubbed(self):
        # GIT_CEILING_DIRECTORIES is on the scrub list but is then set by _git_env, so
        # it is the one name expected to survive -- carrying our value, never theirs.
        poisoned = {name: "/somewhere/else/.git" for name in SCRUBBED_GIT_VARS}
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, poisoned):
                env = self.run_git(Path(tmp)).kwargs["env"]
        leaked = sorted(
            name
            for name in SCRUBBED_GIT_VARS
            if name in env and name != "GIT_CEILING_DIRECTORIES"
        )
        self.assertEqual(leaked, [])

    def test_a_poisoned_ceiling_is_replaced_rather_than_inherited(self):
        poisoned = {"GIT_CEILING_DIRECTORIES": "/somewhere/else"}
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, poisoned):
                env = self.run_git(Path(tmp)).kwargs["env"]
        self.assertEqual(env["GIT_CEILING_DIRECTORIES"], tmp)

    def test_the_ceiling_is_set_to_the_scratch_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.run_git(Path(tmp)).kwargs["env"]
        self.assertEqual(env["GIT_CEILING_DIRECTORIES"], tmp)

    def test_the_working_directory_is_explicit_rather_than_inherited(self):
        with tempfile.TemporaryDirectory() as tmp:
            call = self.run_git(Path(tmp))
        self.assertEqual(call.kwargs["cwd"], tmp)

    def test_the_scrub_list_is_checkouts_rather_than_a_second_copy(self):
        self.assertIs(SCRUBBED_GIT_VARS, checkout_mod.SCRUBBED_GIT_VARS)


class CheckoutSafetyTest(unittest.TestCase):
    """The one rmtree in the harness never runs on anything but a policy tree."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def test_a_symlink_destination_is_refused(self):
        target = self.tmp / "somewhere_real"
        target.mkdir()
        (target / "precious.txt").write_text("not ours to delete")
        link = self.tmp / "policy"
        link.symlink_to(target)
        with self.assertRaises(ValueError) as caught:
            policy_mod._clear_destination(link)
        self.assertIn("symlink", str(caught.exception))
        self.assertTrue((target / "precious.txt").exists())

    def test_a_destination_holding_a_git_is_refused(self):
        dest = self.tmp / "policy"
        (dest / ".git").mkdir(parents=True)
        with self.assertRaises(ValueError) as caught:
            policy_mod._clear_destination(dest)
        self.assertIn(".git", str(caught.exception))
        self.assertTrue(dest.exists())

    def test_the_home_directory_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            policy_mod._clear_destination(Path(os.path.expanduser("~")))
        self.assertIn("home directory", str(caught.exception))

    def test_a_destination_that_is_a_file_is_refused(self):
        dest = self.tmp / "policy"
        dest.write_text("not a tree")
        with self.assertRaises(ValueError):
            policy_mod._clear_destination(dest)
        self.assertTrue(dest.exists())

    def test_a_missing_destination_is_simply_nothing_to_do(self):
        policy_mod._clear_destination(self.tmp / "never_created")

    def test_an_ordinary_previous_tree_is_removed(self):
        dest = self.tmp / "policy"
        (dest / ".github").mkdir(parents=True)
        (dest / "leftover.txt").write_text("from the previous policy")
        policy_mod._clear_destination(dest)
        self.assertFalse(dest.exists())

    def test_a_repo_that_is_not_owner_slash_name_is_refused(self):
        with self.assertRaises(ValueError):
            policy_mod._checkout("https://evil.example/x", "main", self.tmp / "p")


if __name__ == "__main__":
    unittest.main()
