"""Tests for staging the reviewed repo's policy and the gates it puts before the model.

``workspace.stage_policy_half`` and ``workspace.touches_verdict`` run the policy tree's
``repo-policy.py`` as the workflow does and map what it prints onto the tree's canned
verdicts. Stand-in scripts pin the mapping, the shipped script pins that the
harness still fits it.
"""

import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from torchci.greenlight_replay import workspace as workspace_mod


REPO_ROOT = Path(__file__).resolve().parents[4]
SHIPPED_SCRIPT = REPO_ROOT / ".claude/hooks/greenlight/repo-policy.py"
SLOT = Path("skills/greenlight-review/repo-policy.md")
FILES_VERDICT = {"status": "NO_LAND", "reason": "not_trivial", "message": "touched"}


def git(args, cwd):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


class GateTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.log = self.root / "calls.log"
        self.policy_root = self.root / "policy"
        (self.policy_root / ".claude" / SLOT.parent).mkdir(parents=True)
        (self.policy_root / ".claude" / SLOT).write_text("built-in\n")
        (self.policy_root / ".claude/hooks").mkdir()

    def policy(self, stage_out="staged=true", touches_out="touches=false", code=0):
        """A tree whose repo-policy.py prints the given lines and logs each call."""
        script = self.policy_root / ".claude/hooks/repo-policy.py"
        script.write_text(
            "import sys\n"
            f"open({str(self.log)!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
            "print('problem', file=sys.stderr)\n"
            f"print({stage_out!r} if sys.argv[1] == 'stage' else {touches_out!r})\n"
            f"sys.exit({code})\n"
        )
        return SimpleNamespace(
            root=self.policy_root,
            repo_policy_script=script,
            greenlight_files_verdict=FILES_VERDICT,
        )

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def diff(self, text="diff --git a/x b/x\n"):
        path = self.root / "pr.diff"
        path.write_text(text)
        return path


class StageTest(GateTestCase):
    def test_a_tree_without_the_script_is_its_own_source_and_staged(self):
        policy = SimpleNamespace(root=self.policy_root, repo_policy_script=None)
        source, staged = workspace_mod.stage_policy_half(
            policy, "pytorch/vision", self.root / "trusted", self.root / "staged"
        )
        self.assertEqual((source, staged), (self.policy_root, True))
        self.assertFalse((self.root / "staged").exists())

    def test_the_script_runs_on_a_copy_with_the_workflows_arguments(self):
        source, staged = workspace_mod.stage_policy_half(
            self.policy(), "pytorch/vision", self.root / "trusted", self.root / "staged"
        )
        self.assertTrue(staged)
        self.assertEqual(source, self.root / "staged")
        self.assertEqual(
            self.calls(),
            [f"stage pytorch/vision {self.root / 'trusted'} {source / '.claude'}"],
        )
        self.assertEqual((source / ".claude" / SLOT).read_text(), "built-in\n")

    def test_only_exactly_staged_true_counts_as_staged(self):
        for out in ("staged=false", "staged=true extra", "Staged=true", "", "yes"):
            with self.subTest(out=out):
                _, staged = workspace_mod.stage_policy_half(
                    self.policy(stage_out=out),
                    "pytorch/vision",
                    self.root / "trusted",
                    self.root / "staged",
                )
                self.assertFalse(staged)

    def test_a_failing_script_raises_as_it_fails_the_job(self):
        with self.assertRaises(RuntimeError) as caught:
            workspace_mod.stage_policy_half(
                self.policy(code=2),
                "pytorch/vision",
                self.root / "trusted",
                self.root / "staged",
            )
        self.assertIn("exited 2", str(caught.exception))

    def test_a_symlink_at_the_staged_tree_is_refused(self):
        staged_root = self.root / "staged"
        staged_root.mkdir()
        (staged_root / ".claude").symlink_to(self.policy_root / ".claude")
        with self.assertRaises(ValueError):
            workspace_mod.stage_policy_half(
                self.policy(), "pytorch/vision", self.root / "trusted", staged_root
            )
        self.assertTrue((self.policy_root / ".claude" / SLOT).is_file())


class TouchesVerdictTest(GateTestCase):
    def test_a_touching_diff_gets_the_trees_verdict(self):
        verdict = workspace_mod.touches_verdict(
            self.policy(touches_out="touches=true"), self.diff()
        )
        self.assertEqual(verdict, FILES_VERDICT)
        self.assertEqual(self.calls(), [f"touches {self.root / 'pr.diff'}"])

    def test_anything_but_exactly_touches_false_counts_as_touching(self):
        for out in ("touches=true", "touches=false ", "", "false"):
            with self.subTest(out=out):
                verdict = workspace_mod.touches_verdict(
                    self.policy(touches_out=out), self.diff()
                )
                self.assertEqual(verdict, FILES_VERDICT)

    def test_an_untouched_diff_reaches_the_review(self):
        self.assertIsNone(workspace_mod.touches_verdict(self.policy(), self.diff()))

    def test_a_tree_without_the_script_never_gates(self):
        policy = SimpleNamespace(root=self.policy_root, repo_policy_script=None)
        self.assertIsNone(workspace_mod.touches_verdict(policy, self.diff()))

    def test_a_touching_diff_without_the_trees_verdict_raises(self):
        policy = self.policy(touches_out="touches=true")
        policy.greenlight_files_verdict = None
        with self.assertRaises(ValueError) as caught:
            workspace_mod.touches_verdict(policy, self.diff())
        self.assertIn("no canned verdict", str(caught.exception))

    def test_a_failing_touches_raises(self):
        with self.assertRaises(RuntimeError):
            workspace_mod.touches_verdict(self.policy(code=1), self.diff())


@unittest.skipUnless(SHIPPED_SCRIPT.is_file(), "the policy tree has no repo-policy.py")
class ShippedScriptTest(GateTestCase):
    """The harness still fits the script the workflow runs."""

    def shipped(self):
        return SimpleNamespace(
            root=self.policy_root,
            repo_policy_script=SHIPPED_SCRIPT,
            greenlight_files_verdict=FILES_VERDICT,
        )

    def trusted_without_policy(self):
        trusted = self.root / "trusted"
        (trusted / ".claude/skills").mkdir(parents=True)
        (trusted / ".claude/skills/x").write_text("x\n")
        git(["init", "-q"], trusted)
        git(["add", "-A"], trusted)
        git(["commit", "-qm", "main"], trusted)
        return trusted

    def test_another_repo_without_its_policy_stages_nothing(self):
        source, staged = workspace_mod.stage_policy_half(
            self.shipped(),
            "pytorch/vision",
            self.trusted_without_policy(),
            self.root / "staged",
        )
        self.assertFalse(staged)
        self.assertFalse((source / ".claude" / SLOT).exists())

    def test_a_diff_under_greenlight_is_touching_and_another_is_not(self):
        touching = self.diff(
            "diff --git a/.github/greenlight/review.md b/.github/greenlight/review.md\n"
            "--- a/.github/greenlight/review.md\n"
            "+++ b/.github/greenlight/review.md\n"
            "@@ -1 +1 @@\n-a\n+b\n"
        )
        verdict = workspace_mod.touches_verdict(self.shipped(), touching)
        self.assertEqual(verdict, FILES_VERDICT)
        other = self.diff(
            "diff --git a/torch/x.py b/torch/x.py\n"
            "--- a/torch/x.py\n+++ b/torch/x.py\n@@ -1 +1 @@\n-a\n+b\n"
        )
        self.assertIsNone(workspace_mod.touches_verdict(self.shipped(), other))


if __name__ == "__main__":
    unittest.main()
