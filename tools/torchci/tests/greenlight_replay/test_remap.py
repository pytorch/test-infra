"""Tests for the per-run scratch-path remap hook.

The hook is what keeps concurrent replays from reading each other's diffs and overwriting
each other's verdicts, and it has to agree with three things it cannot import: the hook
output contract Claude Code implements, the allowlist prefix ``restrict-read.py`` enforces,
and the scratch paths the skill and the policy prompt name. All three agreements are
asserted here against the production files rather than against a copy.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from replay_runner_fixtures import ScratchTestCase
from torchci.greenlight_replay import workflow
from torchci.greenlight_replay.hooks import remap


REPO_ROOT = Path(__file__).resolve().parents[4]
RESTRICT_READ = REPO_ROOT / ".claude/hooks/greenlight/restrict-read.py"
SKILL_MD = REPO_ROOT / ".claude/skills/greenlight-review/SKILL.md"
REMAP_SCRIPT = Path(remap.__file__).resolve()

# Runs to the first space, markup or punctuation character; a sentence's closing period is
# stripped separately, because a path may contain a period but never ends in one.
NAMED_SCRATCH_PATH = re.compile(r"/tmp/greenlight-[^\s`'\"()\[\],;:]*")
PLACEHOLDER = re.compile(r"<[^<>]+>")
SAMPLE_PR_NUMBER = "195366"

# Stack-directory paths whose '..' climbs out of the directory.
ESCAPES = (
    "/tmp/greenlight-stack/..",
    "/tmp/greenlight-stack/../greenlight-pr.diff",
    "/tmp/greenlight-stack/../../../etc/passwd",
    "/tmp/greenlight-stack/a/../../greenlight-verdict.json",
)


def run_hook(event, run_dir):
    """Drive the hook exactly as Claude Code does: event on stdin, decision on stdout."""
    env = dict(os.environ)
    env[remap.RUN_DIR_ENV] = str(run_dir)
    completed = subprocess.run(
        [sys.executable, str(REMAP_SCRIPT)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return completed


def rewritten(event, run_dir, field):
    """What the hook rewrote ``field`` to, or None when it let the call through as is."""
    completed = run_hook(event, run_dir)
    if completed.returncode != 0:
        raise AssertionError(f"remap exited {completed.returncode}: {completed.stderr}")
    if not completed.stdout:
        return None
    return json.loads(completed.stdout)["hookSpecificOutput"]["updatedInput"][field]


def run_restrict_read(event, workspace):
    """The production read sandbox's decision on ``event``."""
    return subprocess.run(
        [sys.executable, str(RESTRICT_READ)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env={**os.environ, "GITHUB_WORKSPACE": str(workspace)},
        check=False,
    )


def named_scratch_paths(text):
    """Every ``/tmp/greenlight-*`` path ``text`` names, each placeholder given a value."""
    return {
        PLACEHOLDER.sub(SAMPLE_PR_NUMBER, found.rstrip("."))
        for found in NAMED_SCRATCH_PATH.findall(text)
    }


class TestOutputContract(ScratchTestCase):
    """The hook speaks the same PreToolUse dialect as the production read sandbox.

    A decision the CLI cannot parse is not an error it reports: the tool call proceeds with
    the original input, which is the un-isolated global path.
    """

    def setUp(self):
        self.run_dir = self.scratch("greenlight-remap-")

    def test_an_allow_decision_carries_the_same_keys_restrict_read_emits(self):
        event = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/greenlight-pr.diff"},
        }
        decision = json.loads(run_hook(event, self.run_dir).stdout)
        self.assertEqual(list(decision), ["hookSpecificOutput"])
        specific = decision["hookSpecificOutput"]
        self.assertEqual(
            sorted(specific),
            [
                "hookEventName",
                "permissionDecision",
                "permissionDecisionReason",
                "updatedInput",
            ],
        )
        self.assertEqual(specific["hookEventName"], "PreToolUse")
        self.assertEqual(specific["permissionDecision"], "allow")

    def test_a_rewritten_call_exits_zero(self):
        event = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/greenlight-pr.diff"},
        }
        self.assertEqual(run_hook(event, self.run_dir).returncode, 0)

    def test_every_field_of_the_original_input_survives_the_rewrite(self):
        # updatedInput replaces the whole input, so a dropped field silently discards the
        # content of a Write.
        event = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": "/tmp/greenlight-verdict.json",
                "content": '{"status": "LAND"}',
            },
        }
        updated = json.loads(run_hook(event, self.run_dir).stdout)[
            "hookSpecificOutput"
        ]["updatedInput"]
        self.assertEqual(updated["content"], '{"status": "LAND"}')

    def test_an_unparseable_event_blocks_rather_than_passing_the_call_through(self):
        completed = subprocess.run(
            [sys.executable, str(REMAP_SCRIPT)],
            input="not json",
            capture_output=True,
            text=True,
            env={**os.environ, remap.RUN_DIR_ENV: str(self.run_dir)},
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("remap blocked", completed.stderr)


class TestRewrittenPaths(ScratchTestCase):
    """Every scratch path the skill hardcodes moves into the per-run directory."""

    def setUp(self):
        self.run_dir = self.scratch("greenlight-remap-")

    def test_every_skill_file_is_rewritten(self):
        for basename in remap.REMAPPED_BASENAMES:
            tool = "Write" if basename == remap.VERDICT_BASENAME else "Read"
            event = {"tool_name": tool, "tool_input": {"file_path": f"/tmp/{basename}"}}
            updated = json.loads(run_hook(event, self.run_dir).stdout)[
                "hookSpecificOutput"
            ]["updatedInput"]
            self.assertEqual(
                updated["file_path"], str(self.run_dir.resolve() / basename), basename
            )

    def test_every_remapped_path_is_one_the_skill_names(self):
        skill = SKILL_MD.read_text()
        for basename in remap.REMAPPED_BASENAMES:
            self.assertIn(f"/tmp/{basename}", skill)
        self.assertIn(f"/tmp/{remap.STACK_DIRNAME}/", skill)

    def test_every_scratch_path_the_skill_and_the_prompt_name_is_remapped(self):
        # The converse of the test above: that one proves each rule here is one the skill
        # needs, this one that each path the reviewer is told to use has a rule.
        workflow_path = REPO_ROOT / workflow.WORKFLOW_RELPATH
        sources = {
            "SKILL.md": SKILL_MD.read_text(),
            "the policy prompt": workflow.prompt(
                workflow.load(workflow_path), workflow_path
            ),
        }
        inside = str(self.run_dir.resolve()) + os.sep
        for source, text in sources.items():
            named = named_scratch_paths(text)
            self.assertTrue(named, f"{source} names no /tmp/greenlight-* path")
            for path in sorted(named):
                with self.subTest(source=source, path=path):
                    target = remap.remapped_path(str(self.run_dir), path)
                    self.assertIsNotNone(target)
                    self.assertTrue(target.startswith(inside), target)

    def test_a_path_outside_the_remap_is_left_for_the_other_hooks_to_judge(self):
        event = {"tool_name": "Read", "tool_input": {"file_path": "/etc/passwd"}}
        completed = run_hook(event, self.run_dir)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")

    def test_a_tool_the_remap_does_not_cover_is_left_alone(self):
        event = {"tool_name": "Grep", "tool_input": {"pattern": "x", "path": "/tmp"}}
        completed = run_hook(event, self.run_dir)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")


class TestStackDirectory(ScratchTestCase):
    """The stack directory, and every path beneath it, moves into the run's own copy."""

    def setUp(self):
        self.run_dir = self.scratch("greenlight-remap-")
        self.stack_dir = self.run_dir.resolve() / remap.STACK_DIRNAME

    def test_a_read_beneath_the_directory_keeps_its_relative_path(self):
        for relative in ("195366.diff", "nested/195366.diff"):
            event = {
                "tool_name": "Read",
                "tool_input": {"file_path": f"/tmp/greenlight-stack/{relative}"},
            }
            self.assertEqual(
                rewritten(event, self.run_dir, "file_path"),
                str(self.stack_dir / relative),
            )

    def test_a_search_of_the_directory_is_rewritten_with_or_without_a_slash(self):
        expected = {
            "/tmp/greenlight-stack": str(self.stack_dir),
            "/tmp/greenlight-stack/": f"{self.stack_dir}/",
            "/tmp/greenlight-stack/195366.diff": str(self.stack_dir / "195366.diff"),
        }
        for tool in ("Glob", "Grep"):
            for original, target in expected.items():
                with self.subTest(tool=tool, path=original):
                    event = {
                        "tool_name": tool,
                        "tool_input": {"pattern": "x", "path": original},
                    }
                    self.assertEqual(rewritten(event, self.run_dir, "path"), target)

    def test_a_name_that_only_shares_the_prefix_is_left_alone(self):
        for original in (
            "/tmp/greenlight-stackX",
            "/tmp/greenlight-stackX/195366.diff",
            "/tmp/greenlight-stacks/195366.diff",
            "/tmp/greenlight-stack-old/195366.diff",
            "/tmp/greenlight-stack.json.bak",
            # Normalizes back into the directory, so only the boundary match refuses it.
            "/tmp/greenlight-stackX/../greenlight-stack/195366.diff",
        ):
            with self.subTest(path=original):
                read = {"tool_name": "Read", "tool_input": {"file_path": original}}
                glob = {
                    "tool_name": "Glob",
                    "tool_input": {"pattern": "x", "path": original},
                }
                self.assertIsNone(rewritten(read, self.run_dir, "file_path"))
                self.assertIsNone(rewritten(glob, self.run_dir, "path"))

    def test_a_dotdot_that_leaves_the_stack_directory_is_not_rewritten(self):
        for original in ESCAPES:
            with self.subTest(path=original):
                for tool, field in (("Read", "file_path"), ("Grep", "path")):
                    event = {"tool_name": tool, "tool_input": {field: original}}
                    self.assertIsNone(rewritten(event, self.run_dir, field))

    def test_a_dotdot_that_stays_inside_is_rewritten_as_written(self):
        # Normalizing it away would hand a CLI that chains updatedInput a path with no
        # '..' left for the read sandbox to deny.
        target = remap.remapped_path(
            str(self.run_dir), "/tmp/greenlight-stack/nested/../195366.diff"
        )
        self.assertEqual(target, f"{self.stack_dir}/nested/../195366.diff")


class TestAllowlistAgreement(ScratchTestCase):
    """A remapped path must still satisfy the production read sandbox.

    Every PreToolUse hook sees the ORIGINAL input and a deny from any of them wins, so the
    two hooks normally judge different paths. Keeping the run directory inside
    restrict-read.py's scratch prefix removes that dependence on evaluation order; this is
    the assertion that stops the two drifting apart.
    """

    def setUp(self):
        self.run_dir = self.scratch("greenlight-remap-")

    def test_the_remap_prefix_is_the_one_restrict_read_computes(self):
        source = RESTRICT_READ.read_text()
        self.assertIn('_SCRATCH_BASENAME_PREFIX = "greenlight-"', source)
        self.assertEqual(
            remap.scratch_prefix(), os.path.realpath("/tmp") + "/greenlight-"
        )

    def test_restrict_read_allows_every_remapped_path(self):
        workspace = self.scratch("greenlight-remap-ws-")
        for basename in remap.REMAPPED_BASENAMES:
            target = remap.remapped_path(str(self.run_dir), f"/tmp/{basename}")
            completed = run_restrict_read(
                {"tool_name": "Read", "tool_input": {"file_path": target}}, workspace
            )
            self.assertEqual(completed.returncode, 0, f"{basename}: {completed.stderr}")

    def test_restrict_read_allows_the_remapped_stack_directory_and_its_diffs(self):
        workspace = self.scratch("greenlight-remap-ws-")
        for tool, field, original in (
            ("Read", "file_path", "/tmp/greenlight-stack/195366.diff"),
            ("Glob", "path", "/tmp/greenlight-stack"),
            ("Grep", "path", "/tmp/greenlight-stack/"),
        ):
            target = remap.remapped_path(str(self.run_dir), original)
            completed = run_restrict_read(
                {"tool_name": tool, "tool_input": {field: target}}, workspace
            )
            self.assertEqual(completed.returncode, 0, f"{original}: {completed.stderr}")

    def test_restrict_read_denies_every_escape_the_remap_leaves_alone(self):
        # An escape is left un-rewritten, so the read sandbox is what stops it.
        workspace = self.scratch("greenlight-remap-ws-")
        for original in ESCAPES:
            completed = run_restrict_read(
                {"tool_name": "Read", "tool_input": {"file_path": original}}, workspace
            )
            self.assertEqual(completed.returncode, 2, original)

    def test_a_run_directory_the_read_sandbox_would_reject_is_refused_loudly(self):
        outside = self.scratch("replay-")
        violation = remap.run_dir_violation(str(outside))
        self.assertIsNotNone(violation)
        self.assertIn(remap.scratch_prefix(), violation)
        event = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/greenlight-pr.diff"},
        }
        completed = run_hook(event, outside)
        self.assertEqual(completed.returncode, 2)

    def test_an_unset_run_directory_blocks_rather_than_sharing_the_global_path(self):
        env = {k: v for k, v in os.environ.items() if k != remap.RUN_DIR_ENV}
        completed = subprocess.run(
            [sys.executable, str(REMAP_SCRIPT)],
            input=json.dumps(
                {
                    "tool_name": "Read",
                    "tool_input": {"file_path": "/tmp/greenlight-pr.diff"},
                }
            ),
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn(remap.RUN_DIR_ENV, completed.stderr)

    def test_the_workdir_name_decides_whether_the_prefix_matches(self):
        # A plain string prefix, not a path-boundary test: "/tmp/greenlight-replay/..."
        # passes at any nesting depth while "/tmp/glreplay/..." never does, which makes the
        # harness workdir's NAME a load-bearing choice rather than a cosmetic one.
        layout = "pr-8829/runs/193118"
        self.assertIsNone(remap.run_dir_violation(f"/tmp/greenlight-replay/{layout}"))
        self.assertIsNotNone(remap.run_dir_violation(f"/tmp/glreplay/{layout}"))

    def test_a_relative_run_directory_is_refused(self):
        self.assertIsNotNone(remap.run_dir_violation("greenlight-replay/runs/1"))


if __name__ == "__main__":
    unittest.main()
