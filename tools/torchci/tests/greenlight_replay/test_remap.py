"""Tests for the per-run scratch-path remap hook.

The hook is what keeps concurrent replays from reading each other's diffs and overwriting
each other's verdicts, and it has to agree with two things it cannot import: the hook output
contract Claude Code implements, and the allowlist prefix ``restrict-read.py`` enforces.
Both agreements are asserted here against the production files rather than against a copy.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from replay_runner_fixtures import ScratchTestCase
from torchci.greenlight_replay.hooks import remap


REPO_ROOT = Path(__file__).resolve().parents[4]
RESTRICT_READ = REPO_ROOT / ".claude/hooks/greenlight/restrict-read.py"
REMAP_SCRIPT = Path(remap.__file__).resolve()


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
    """All three of the skill's hardcoded globals move into the per-run directory."""

    def setUp(self):
        self.run_dir = self.scratch("greenlight-remap-")

    def test_all_three_skill_paths_are_rewritten(self):
        for basename in remap.REMAPPED_BASENAMES:
            tool = "Write" if basename == remap.VERDICT_BASENAME else "Read"
            event = {"tool_name": tool, "tool_input": {"file_path": f"/tmp/{basename}"}}
            updated = json.loads(run_hook(event, self.run_dir).stdout)[
                "hookSpecificOutput"
            ]["updatedInput"]
            self.assertEqual(
                updated["file_path"], str(self.run_dir.resolve() / basename), basename
            )

    def test_the_three_basenames_are_the_ones_the_skill_names(self):
        skill = (REPO_ROOT / ".claude/skills/greenlight-review/SKILL.md").read_text()
        for basename in remap.REMAPPED_BASENAMES:
            self.assertIn(f"/tmp/{basename}", skill)

    def test_a_path_outside_the_three_is_left_for_the_other_hooks_to_judge(self):
        event = {"tool_name": "Read", "tool_input": {"file_path": "/etc/passwd"}}
        completed = run_hook(event, self.run_dir)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")

    def test_a_tool_the_remap_does_not_cover_is_left_alone(self):
        event = {"tool_name": "Grep", "tool_input": {"pattern": "x", "path": "/tmp"}}
        completed = run_hook(event, self.run_dir)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")


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
            completed = subprocess.run(
                [sys.executable, str(RESTRICT_READ)],
                input=json.dumps(
                    {"tool_name": "Read", "tool_input": {"file_path": target}}
                ),
                capture_output=True,
                text=True,
                env={**os.environ, "GITHUB_WORKSPACE": str(workspace)},
                check=False,
            )
            self.assertEqual(completed.returncode, 0, f"{basename}: {completed.stderr}")

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
