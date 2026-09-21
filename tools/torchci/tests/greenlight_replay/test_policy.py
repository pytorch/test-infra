"""Tests for reading the greenlight policy out of a materialized test-infra tree.

Nothing here touches the network: ``_checkout`` is the module's only reach out, and
every test either patches it over a tree written to a temp directory or asserts on the
refspec it was handed.

One case deliberately reads the repository's own workflow rather than a fixture. The
fixtures pin how this module behaves; that case pins that it still fits the file it
exists to parse, which a hand-written fixture can never tell you.
"""

import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml
from torchci.greenlight_replay import (
    checkout as checkout_mod,
    policy as policy_mod,
    verdict as verdict_mod,
    workflow as workflow_mod,
)
from torchci.greenlight_replay.checkout import SCRUBBED_GIT_VARS
from torchci.greenlight_replay.policy import materialize, Policy, render_prompt


CHECKOUT_SEAM = "_checkout"
GIT_SEAM = "_git"

REPO_ROOT = Path(__file__).resolve().parents[4]

ACTION_USES = "anthropics/claude-code-action@593d7a5c4e0073569f74772c2b7b64c30ec14707"
CLAUDE_ARGS = (
    "--model global.anthropic.claude-opus-5 --effort high "
    '--allowedTools "Read,Glob,Grep,Write"'
)
PROMPT = (
    "You are reviewing pytorch/pytorch PR #${{ github.event.inputs.pr_number }}\n"
    "at commit ${{ github.event.inputs.head_sha }}.\n"
)
DEFAULT_CAPS = {"MAX_DIFF_LINES": "2000", "MAX_DIFF_BYTES": "500000"}
DEFAULT_BUDGETS = {
    "GREENLIGHT_REVIEW_TARGET_BUDGET_MIN": "20",
    "GREENLIGHT_REVIEW_SOFT_BUDGET_MIN": "25",
    "GREENLIGHT_REVIEW_HARD_BUDGET_MIN": "33",
}

# The shipped schema, so the canned-verdict cases are held to the real enums.
REAL_SCHEMA = json.loads(
    (REPO_ROOT / ".claude/hooks/greenlight/verdict-schema.json").read_text(
        encoding="utf-8"
    )
)

TOO_LARGE_VERDICT = {
    "status": "NO_LAND",
    "reason": "scope_too_large",
    "message": "- Scope\n  - too big",
}


def action_step(claude_args=CLAUDE_ARGS, prompt=PROMPT, name="Run Green Light review"):
    return {
        "name": name,
        "uses": ACTION_USES,
        "with": {
            "claude_args": claude_args,
            "prompt": prompt,
        },
    }


def sizecheck_step(env=None, name="Decline oversized diffs"):
    return {
        "name": name,
        "id": "sizecheck",
        "env": dict(DEFAULT_CAPS if env is None else env),
    }


def write_tree(root: Path, steps, jobs=None) -> None:
    """A minimal test-infra tree: the workflow plus the three hook files read from it."""
    workflow = {
        "name": "Green Light PR Review",
        "jobs": jobs
        if jobs is not None
        else {"review": {"env": dict(DEFAULT_BUDGETS), "steps": steps}},
    }
    workflow_path = root / workflow_mod.WORKFLOW_RELPATH
    workflow_path.parent.mkdir(parents=True, exist_ok=True)
    workflow_path.write_text(yaml.safe_dump(workflow, sort_keys=False))

    hooks = root / policy_mod.HOOKS_RELPATH
    hooks.mkdir(parents=True, exist_ok=True)
    (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(json.dumps(TOO_LARGE_VERDICT))
    (hooks / policy_mod.SCHEMA_FILENAME).write_text(json.dumps(REAL_SCHEMA))
    (hooks / policy_mod.SANITIZE_FILENAME).write_text("#!/bin/bash\n")


class PolicyTreeTestCase(unittest.TestCase):
    """Fixture only: a temp tree plus a materialize that patches out the fetch."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "policy"
        self.root.mkdir()

    def materialize(self, steps, ref="8829", jobs=None):
        write_tree(self.root, steps, jobs)
        with mock.patch.object(policy_mod, CHECKOUT_SEAM) as checkout:
            result = materialize(ref, self.root)
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

    def test_the_diff_caps_are_read_as_integers(self):
        result = self.materialize([action_step(), sizecheck_step()])
        self.assertEqual(result.max_diff_lines, 2000)
        self.assertEqual(result.max_diff_bytes, 500000)

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
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            result = materialize("8829", self.root)
        self.assertEqual(result.too_large_verdict, edited)

    def test_a_canned_verdict_missing_a_key_aborts(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(
            json.dumps({"status": "NO_LAND", "reason": "scope_too_large"})
        )
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            with self.assertRaises(ValueError) as caught:
                materialize("8829", self.root)
        self.assertIn("message", str(caught.exception))

    def test_a_missing_hook_file_aborts_naming_it(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        (self.root / policy_mod.HOOKS_RELPATH / policy_mod.SANITIZE_FILENAME).unlink()
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            with self.assertRaises(FileNotFoundError) as caught:
                materialize("8829", self.root)
        self.assertIn(policy_mod.SANITIZE_FILENAME, str(caught.exception))


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
    """The canned decline is emitted with no model run, so the tree must vouch for it."""

    def write_verdict(self, verdict):
        write_tree(self.root, [action_step(), sizecheck_step()])
        hooks = self.root / policy_mod.HOOKS_RELPATH
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(json.dumps(verdict))
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            return materialize("8829", self.root)

    def test_a_status_outside_the_schema_enum_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.write_verdict(dict(TOO_LARGE_VERDICT, status="MAYBE"))
        self.assertIn("MAYBE", str(caught.exception))

    def test_a_reason_outside_the_schema_enum_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.write_verdict(dict(TOO_LARGE_VERDICT, reason="too_chunky"))
        self.assertIn("too_chunky", str(caught.exception))

    def test_an_empty_message_aborts(self):
        with self.assertRaises(ValueError):
            self.write_verdict(dict(TOO_LARGE_VERDICT, message=""))

    def test_a_field_the_schema_forbids_aborts(self):
        with self.assertRaises(ValueError) as caught:
            self.write_verdict(dict(TOO_LARGE_VERDICT, severity="high"))
        self.assertIn("severity", str(caught.exception))

    def test_a_reason_a_policy_pr_added_to_its_own_schema_is_accepted(self):
        write_tree(self.root, [action_step(), sizecheck_step()])
        hooks = self.root / policy_mod.HOOKS_RELPATH
        widened = json.loads(json.dumps(REAL_SCHEMA))
        widened["properties"]["reason"]["enum"].append("diff_unreadable")
        (hooks / policy_mod.SCHEMA_FILENAME).write_text(json.dumps(widened))
        (hooks / policy_mod.TOO_LARGE_FILENAME).write_text(
            json.dumps(dict(TOO_LARGE_VERDICT, reason="diff_unreadable"))
        )
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            result = materialize("8829", self.root)
        self.assertEqual(result.too_large_verdict["reason"], "diff_unreadable")

    def test_the_validator_is_the_shared_one_rather_than_a_second_copy(self):
        self.assertIs(policy_mod.verdict_violation, verdict_mod.verdict_violation)

    def test_a_schema_the_harness_cannot_interpret_aborts_before_any_spend(self):
        # Patched rather than pinned to a keyword: which ones are supported is the
        # verdict module's business and moves, while this wiring is ours and must not.
        write_tree(self.root, [action_step(), sizecheck_step()])
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            with mock.patch.object(
                policy_mod, "schema_support_violation", return_value="uses allOf"
            ):
                with self.assertRaises(ValueError) as caught:
                    materialize("8829", self.root)
        self.assertIn("uses allOf", str(caught.exception))


class UnclosedInterpolationTest(unittest.TestCase):
    """A ``${{`` that never closes must not render verbatim into the prompt."""

    def test_a_single_closing_brace_aborts(self):
        template = "review PR #${{ github.event.inputs.pr_number }"
        with self.assertRaises(ValueError) as caught:
            render_prompt(make_policy(template), 1, "a" * 40)
        self.assertIn("never closes", str(caught.exception))

    def test_an_opener_at_the_very_end_aborts(self):
        with self.assertRaises(ValueError):
            render_prompt(make_policy("review PR ${{"), 1, "a" * 40)

    def test_a_well_formed_template_is_unaffected(self):
        rendered = render_prompt(make_policy(PROMPT), 7, "e" * 40)
        self.assertNotIn("${{", rendered)

    def test_a_substituted_value_carrying_an_opener_is_still_allowed(self):
        # The guard reads the template, not the output: an odd head_sha is not the
        # policy author's malformed markup.
        rendered = render_prompt(make_policy(PROMPT), 1, "${{ unclosed")
        self.assertIn("${{ unclosed", rendered)


class ShippedWorkflowTest(unittest.TestCase):
    """This module still fits the workflow it exists to parse."""

    def test_the_repositorys_own_workflow_yields_a_complete_policy(self):
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            result = materialize("main", REPO_ROOT)
        self.assertTrue(result.tools)
        self.assertTrue(result.model)
        self.assertTrue(result.effort)
        self.assertGreater(result.max_diff_lines, 0)
        self.assertGreater(result.max_diff_bytes, 0)
        self.assertEqual(result.too_large_verdict["status"], "NO_LAND")
        # Shape, not the shipped figures: retuning the budgets is a policy change the
        # harness is meant to honour, not a drift this test should block.
        self.assertEqual(len(result.review_budget_minutes), 3)
        for minutes in result.review_budget_minutes:
            self.assertGreater(minutes, 0)
        self.assertIn(policy_mod.PR_NUMBER_EXPR, result.prompt_template)
        self.assertIn(policy_mod.HEAD_SHA_EXPR, result.prompt_template)

    def test_the_shipped_prompt_renders_with_no_interpolation_left(self):
        with mock.patch.object(policy_mod, CHECKOUT_SEAM):
            result = materialize("main", REPO_ROOT)
        rendered = render_prompt(result, 193118, "a" * 40)
        self.assertNotIn("${{", rendered)
        self.assertIn("193118", rendered)
        self.assertIn("a" * 40, rendered)


def make_policy(prompt_template: str) -> Policy:
    return Policy(
        root=Path("/nonexistent"),
        prompt_template=prompt_template,
        max_diff_lines=2000,
        max_diff_bytes=500000,
        review_budget_minutes=(20, 25, 33),
        too_large_verdict=dict(TOO_LARGE_VERDICT),
        schema_path=Path("/nonexistent/schema.json"),
        sanitize_script=Path("/nonexistent/sanitize.sh"),
        hooks_dir=Path("/nonexistent/hooks"),
        model="global.anthropic.claude-opus-5",
        effort="high",
        tools="Read,Glob,Grep,Write",
    )


class RenderPromptTest(unittest.TestCase):
    """An interpolation the harness cannot resolve never reaches the model."""

    def test_both_dispatch_inputs_are_substituted(self):
        rendered = render_prompt(make_policy(PROMPT), 193118, "b" * 40)
        self.assertEqual(
            rendered,
            f"You are reviewing pytorch/pytorch PR #193118\nat commit {'b' * 40}.\n",
        )

    def test_whitespace_inside_the_braces_does_not_defeat_substitution(self):
        template = "PR ${{github.event.inputs.pr_number}} at ${{  \n"
        template += "  github.event.inputs.head_sha  }}"
        rendered = render_prompt(make_policy(template), 7, "c" * 40)
        self.assertEqual(rendered, f"PR 7 at {'c' * 40}")

    def test_an_unknown_interpolation_aborts_naming_the_expression(self):
        template = PROMPT + "run ${{ github.run_id }}"
        with self.assertRaises(ValueError) as caught:
            render_prompt(make_policy(template), 1, "d" * 40)
        self.assertIn("github.run_id", str(caught.exception))

    def test_a_substituted_value_carrying_braces_is_not_rescanned(self):
        rendered = render_prompt(make_policy(PROMPT), 1, "${{ secrets.GITHUB_TOKEN }}")
        self.assertIn("${{ secrets.GITHUB_TOKEN }}", rendered)


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


POLICY_TREE = {
    workflow_mod.WORKFLOW_RELPATH: yaml.safe_dump(
        {
            "name": "Green Light PR Review",
            "jobs": {
                "review": {
                    "env": dict(DEFAULT_BUDGETS),
                    "steps": [action_step(), sizecheck_step()],
                }
            },
        },
        sort_keys=False,
    ),
    f"{policy_mod.HOOKS_RELPATH}/{policy_mod.TOO_LARGE_FILENAME}": json.dumps(
        TOO_LARGE_VERDICT
    ),
    f"{policy_mod.HOOKS_RELPATH}/{policy_mod.SCHEMA_FILENAME}": json.dumps(REAL_SCHEMA),
    f"{policy_mod.HOOKS_RELPATH}/{policy_mod.SANITIZE_FILENAME}": "#!/bin/bash\n",
}


def fake_git(members):
    """A ``_git`` stand-in: init and fetch do nothing, archive writes a real tar.

    Everything downstream of the fetch is the code under test -- the clearing, the
    mkdir and the extraction -- so only the network is replaced.
    """

    def run(argv, *, cwd, ceiling):
        if argv[0] != "archive":
            return
        output = next(a for a in argv if a.startswith("--output="))
        with tarfile.open(output[len("--output=") :], "w") as tar:
            for name, text in members.items():
                data = text.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    return run


class MaterializeIsRepeatableTest(unittest.TestCase):
    """--resume and a repeated sweep both re-materialize over the previous tree."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dest = Path(self._tmp.name) / "policy"
        self._patch = mock.patch.object(
            policy_mod, GIT_SEAM, side_effect=fake_git(POLICY_TREE)
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_materializing_twice_into_the_same_destination_yields_the_same_policy(self):
        first = materialize("8829", self.dest)
        second = materialize("8829", self.dest)
        self.assertEqual(first, second)

    def test_a_file_an_earlier_policy_left_behind_does_not_survive(self):
        materialize("8829", self.dest)
        stale = self.dest / "removed_by_the_new_policy.py"
        stale.write_text("from the previous policy")
        materialize("8829", self.dest)
        self.assertFalse(stale.exists())

    def test_the_second_tree_is_complete_rather_than_a_remnant(self):
        materialize("8829", self.dest)
        second = materialize("8829", self.dest)
        self.assertTrue(second.schema_path.is_file())
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
