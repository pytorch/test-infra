"""Tests for running the arm's own code: its target and its record checks.

Everything here runs for real: this repository's ``greenlight target`` and ``greenlight
verdict --dry-run`` out of ``greenlight/src``, and the record job's validation step out
of the workflow. Trees that differ from this one -- an edited resolver, no target step --
are built in temporary directories from this tree's files, never from git history: CI
checks out one commit.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from replay_runner_fixtures import (
    build_arm_tree,
    HEAD_RECORD_STEP,
    HEAD_WORKFLOW,
    REPO_ROOT,
    WORKFLOW_PATH,
)
from torchci.greenlight_replay import arm_code, workflow_steps
from torchci.greenlight_replay.arm_code import Target


HEAD_SHA = "b" * 40


class TreeTestCase(unittest.TestCase):
    def tree(self, **layout):
        made = tempfile.TemporaryDirectory(prefix="greenlight-arm-tree-")
        self.addCleanup(made.cleanup)
        return build_arm_tree(Path(made.name), **layout)

    def scratch(self):
        made = tempfile.TemporaryDirectory(prefix="greenlight-arm-test-")
        self.addCleanup(made.cleanup)
        return Path(made.name)


class TestTarget(TreeTestCase):
    """The target is whatever the arm's own resolver names, refused where it refuses."""

    def resolve_recording(self, root, repo):
        """Resolve ``repo`` and return the target with the arguments the resolver got."""
        calls = []
        python = arm_code._python

        def recording(root, driver, *args):
            calls.append(args)
            return python(root, driver, *args)

        with mock.patch.object(arm_code, "_python", recording):
            target = arm_code.resolve_target(root, repo)
        (args,) = calls
        return target, args

    def test_pytorch_is_resolved_strictly_with_an_empty_repo_as_the_review_job_does(
        self,
    ):
        target, args = self.resolve_recording(REPO_ROOT, "pytorch/pytorch")
        self.assertEqual(target, Target("pytorch/pytorch", "pytorch"))
        self.assertEqual(args[:4], ("target", "--strict", "--repo", ""))

    def test_another_repo_is_checked_offline_as_the_record_job_checks_the_review(self):
        target, args = self.resolve_recording(REPO_ROOT, "pytorch/test-infra")
        self.assertEqual(target, Target("pytorch/test-infra", "target"))
        self.assertEqual(
            args[:8],
            (
                "target",
                "--from-review",
                "--input-repo",
                "pytorch/test-infra",
                "--repo",
                "pytorch/test-infra",
                "--drci-poke",
                "false",
            ),
        )

    def test_another_spelling_of_pytorch_is_refused_before_the_resolver_runs(self):
        with mock.patch.object(arm_code, "_python") as python:
            with self.assertRaises(ValueError):
                arm_code.resolve_target(REPO_ROOT, "PyTorch/PyTorch")
        python.assert_not_called()

    def test_a_tree_without_a_target_step_reviews_pytorch_alone(self):
        root = self.tree(target_step=False)
        self.assertEqual(
            arm_code.resolve_target(root, "pytorch/pytorch"),
            Target("pytorch/pytorch", "pytorch"),
        )
        with self.assertRaises(ValueError) as caught:
            arm_code.resolve_target(root, "pytorch/vision")
        self.assertIn(arm_code.WORKFLOW_TARGET_RELPATH, str(caught.exception))

    def edit_resolver(self, root, old, new):
        resolver = root / arm_code.WORKFLOW_TARGET_RELPATH
        text = resolver.read_text()
        self.assertIn(old, text)
        resolver.write_text(text.replace(old, new))

    def test_the_arms_resolver_runs_rather_than_a_copy_of_it(self):
        root = self.tree()
        self.edit_resolver(
            root,
            'REPO_NAME_RE = re.compile(r"pytorch/[A-Za-z0-9._-]+")',
            'REPO_NAME_RE = re.compile(r"pytorch/[a-z]+")',
        )
        self.assertEqual(
            arm_code.resolve_target(root, "pytorch/vision"),
            Target("pytorch/vision", "target"),
        )
        with self.assertRaises(ValueError) as caught:
            arm_code.resolve_target(root, "pytorch/test-infra")
        self.assertIn("refuses pytorch/test-infra", str(caught.exception))

    def test_a_checkout_outside_the_two_known_directories_is_refused(self):
        root = self.tree()
        self.edit_resolver(
            root, 'PRIMARY_CHECKOUT = "pytorch"', 'PRIMARY_CHECKOUT = "src"'
        )
        with self.assertRaises(ValueError) as caught:
            arm_code.resolve_target(root, "pytorch/pytorch")
        self.assertIn("'src'", str(caught.exception))

    def test_nothing_is_written_into_the_arms_tree(self):
        root = self.tree()
        arm_code.resolve_target(root, "pytorch/pytorch")
        self.assertEqual(list(root.rglob("__pycache__")), [])

    def test_malformed_resolver_output_is_refused(self):
        good = "repo=pytorch/pytorch\nname=pytorch\ncheckout=pytorch\n"
        self.assertEqual(
            arm_code._target(good, "pytorch/pytorch"),
            Target("pytorch/pytorch", "pytorch"),
        )
        for bad in (
            good.replace("repo=pytorch/pytorch", "repo=pytorch/vision"),
            good.replace("checkout=pytorch\n", ""),
            good.replace("checkout=pytorch", "checkout=../pytorch"),
            good + "not a pair\n",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    arm_code._target(bad, "pytorch/pytorch")


class TestIsolation(TreeTestCase):
    """The arm's code sees nothing of the operator's environment, and cannot hang a sweep."""

    def test_the_environment_is_built_from_nothing(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "not-for-the-arm"}):
            completed = arm_code._run(
                [
                    sys.executable,
                    "-c",
                    "import json, os; print(json.dumps(sorted(os.environ)))",
                ],
                self.scratch(),
            )
        names = set(json.loads(completed.stdout))
        self.assertEqual(names - {"LC_CTYPE"}, {"PATH", "HOME", "LC_ALL"})

    def test_a_call_past_its_timeout_raises(self):
        with mock.patch.object(arm_code, "ARM_TIMEOUT_S", 0.2):
            with self.assertRaises(RuntimeError):
                arm_code._run(["sleep", "5"], self.scratch())

    def test_a_script_of_the_tree_runs_isolated_with_nothing_inherited(self):
        script = self.scratch() / "probe.py"
        script.write_text(
            "import json, os, sys\n"
            "print(json.dumps([sorted(os.environ), sys.flags.isolated, os.getcwd()]))\n"
        )
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "not-for-the-arm"}):
            completed = arm_code.run_script(script)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        names, isolated, cwd = json.loads(completed.stdout)
        self.assertEqual(set(names) - {"LC_CTYPE"}, {"PATH", "HOME", "LC_ALL"})
        self.assertEqual(isolated, 1)
        self.assertNotEqual(Path(cwd), Path.cwd())


# (name, file bytes, the record step accepts, greenlight verdict --dry-run accepts)
TOKEN = "ghp_" + "A1b2C3d4E5" * 4
CORPUS = (
    (
        "land clean",
        {"status": "LAND", "reason": "clean", "message": "- ok"},
        True,
        True,
    ),
    (
        "no_land other reason",
        {"status": "NO_LAND", "reason": "security_risk", "message": "- risky"},
        True,
        True,
    ),
    (
        "land with a non-clean reason",
        {"status": "LAND", "reason": "insufficient_tests", "message": "- x"},
        True,
        False,
    ),
    (
        "non-string status",
        {"status": 1, "reason": "clean", "message": "- x"},
        False,
        False,
    ),
    (
        "non-string reason",
        {"status": "NO_LAND", "reason": 5, "message": "- x"},
        False,
        False,
    ),
    (
        "non-string message",
        {"status": "NO_LAND", "reason": "clean", "message": ["- x"]},
        False,
        False,
    ),
    (
        "empty message",
        {"status": "NO_LAND", "reason": "clean", "message": ""},
        False,
        False,
    ),
    (
        "whitespace-only message",
        {"status": "NO_LAND", "reason": "clean", "message": "  \n "},
        True,
        False,
    ),
    (
        "message that scrubs to blank",
        {"status": "NO_LAND", "reason": "clean", "message": " " * 20000 + "word"},
        True,
        False,
    ),
    (
        "extra keys",
        {"status": "LAND", "reason": "clean", "message": "- ok", "confidence": "high"},
        True,
        True,
    ),
    (
        "wrong-case status",
        {"status": "land", "reason": "clean", "message": "- ok"},
        False,
        True,
    ),
    (
        "status with a trailing newline",
        {"status": "LAND\n", "reason": "clean", "message": "- ok"},
        True,
        True,
    ),
    (
        "a marker status",
        {"status": "FAILED", "reason": "", "message": ""},
        False,
        False,
    ),
    (
        "two JSON values",
        b'{"status": "LAND", "reason": "clean", "message": "- ok"}\n'
        b'{"status": "LAND", "reason": "clean", "message": "- ok"}\n',
        False,
        False,
    ),
    ("invalid JSON", b'{"status": "LAND",', False, False),
    ("missing file", None, False, False),
    ("non-object", [1, 2], False, False),
)


class TestRecordChecks(TreeTestCase):
    """A verdict counts only when both of the record path's checks pass, each run for real."""

    def write(self, content):
        path = self.scratch() / "greenlight-verdict.json"
        if content is None:
            return path
        path.write_bytes(
            content if isinstance(content, bytes) else json.dumps(content).encode()
        )
        return path

    def accept(self, path):
        return arm_code.accept_verdict(
            REPO_ROOT,
            HEAD_RECORD_STEP,
            path,
            repo="pytorch/pytorch",
            pr_number=167890,
            head_sha=HEAD_SHA,
        )

    def test_the_record_step_decides_each_case_as_expected(self):
        for name, content, record_ok, _ in CORPUS:
            with self.subTest(name):
                rejection = arm_code._record_step_rejection(
                    REPO_ROOT, HEAD_RECORD_STEP, self.write(content)
                )
                self.assertEqual(rejection is None, record_ok, rejection)

    def test_the_verdict_command_decides_each_case_as_expected(self):
        for name, content, _, cli_ok in CORPUS:
            with self.subTest(name):
                verdict, rejection = arm_code._dry_run(
                    REPO_ROOT, self.write(content), "pytorch/pytorch", 1, HEAD_SHA
                )
                self.assertEqual(verdict is not None, cli_ok, rejection)

    def test_a_verdict_is_accepted_only_when_both_accept(self):
        for name, content, record_ok, cli_ok in CORPUS:
            with self.subTest(name):
                verdict, rejection = self.accept(self.write(content))
                self.assertEqual(verdict is not None, record_ok and cli_ok, rejection)
                self.assertEqual(rejection is None, verdict is not None)

    def test_the_status_is_recorded_as_the_command_normalizes_it(self):
        verdict, _ = self.accept(
            self.write({"status": "LAND\n", "reason": "clean", "message": "- ok"})
        )
        self.assertEqual(
            verdict, {"status": "LAND", "reason": "clean", "message": "- ok"}
        )

    def test_the_message_is_recorded_as_the_record_path_scrubs_it(self):
        verdict, _ = self.accept(
            self.write(
                {"status": "NO_LAND", "reason": "clean", "message": f"- leaks {TOKEN}"}
            )
        )
        self.assertNotIn(TOKEN, verdict["message"])
        self.assertIn("[REDACTED]", verdict["message"])

    def test_a_rejection_says_which_check_refused(self):
        _, rejection = self.accept(
            self.write({"status": "land", "reason": "clean", "message": "- ok"})
        )
        self.assertIn("record job's validation step", rejection)
        _, rejection = self.accept(
            self.write({"status": "LAND", "reason": "security_risk", "message": "- x"})
        )
        self.assertIn("greenlight verdict --dry-run", rejection)

    def test_the_arms_own_reasons_are_the_ones_accepted(self):
        root = self.tree()
        constants = root / "greenlight/src/greenlight/constants.py"
        constants.write_text(
            constants.read_text().replace(
                '"needs_socialization",\n',
                '"needs_socialization",\n        "diff_unreadable",\n',
            )
        )
        path = self.write(
            {"status": "NO_LAND", "reason": "diff_unreadable", "message": "- x"}
        )
        accepted, _ = arm_code.accept_verdict(
            root,
            HEAD_RECORD_STEP,
            path,
            repo="pytorch/pytorch",
            pr_number=1,
            head_sha=HEAD_SHA,
        )
        self.assertEqual(accepted["reason"], "diff_unreadable")
        refused, _ = self.accept(path)
        self.assertIsNone(refused)

    def test_the_verdict_is_what_the_arms_own_resolution_hands_on(self):
        # A synthetic arm whose resolution appends a bullet: the replay records the
        # message its _run_full received, not one the harness re-derives.
        root = self.tree()
        resolution = root / "greenlight/src/greenlight/verdict_input.py"
        text = resolution.read_text()
        old = "        return status, doc.reason, doc.message\n"
        self.assertIn(old, text)
        resolution.write_text(
            text.replace(
                old,
                '        return status, doc.reason, doc.message + "\\n- appended"\n',
            )
        )
        path = self.write({"status": "LAND", "reason": "clean", "message": "- ok"})
        verdict, rejection = arm_code.accept_verdict(
            root,
            HEAD_RECORD_STEP,
            path,
            repo="pytorch/pytorch",
            pr_number=1,
            head_sha=HEAD_SHA,
        )
        self.assertIsNotNone(verdict, rejection)
        self.assertEqual(verdict["message"], "- ok\n- appended")

    def test_a_verdict_the_command_never_records_is_refused(self):
        # A marker status passes the dry run without reaching _run_full.
        path = self.write({"status": "CANCELLED"})
        verdict, rejection = arm_code._dry_run(
            REPO_ROOT, path, "pytorch/pytorch", 1, HEAD_SHA
        )
        self.assertIsNone(verdict)
        self.assertIn("did not record it", rejection)

    def test_a_relative_verdict_path_is_resolved_before_the_checks(self):
        path = self.write({"status": "LAND", "reason": "clean", "message": "- ok"})
        cwd = os.getcwd()
        os.chdir(path.parent)
        try:
            verdict, rejection = self.accept(Path(path.name))
        finally:
            os.chdir(cwd)
        self.assertIsNotNone(verdict, rejection)


class TestRecordStepRun(TreeTestCase):
    """The record step runs as GitHub runs it: its shell, in the job's checkout."""

    def run_step(self, run, shell=None, root=REPO_ROOT):
        verdict = self.scratch() / "greenlight-verdict.json"
        verdict.write_text("{}")
        record = workflow_steps.RecordStep(
            run=f"{workflow_steps.RECORD_VERDICT_ASSIGNMENT}\n{run}\n", shell=shell
        )
        return arm_code._record_step_rejection(root, record, verdict)

    def test_no_shell_is_bash_e_without_pipefail(self):
        # GitHub runs an unset shell as `bash -e {0}`: a failing pipe head is ignored.
        self.assertIsNone(self.run_step('false | true\ntest -f "$verdict"'))

    def test_shell_bash_is_bash_with_pipefail(self):
        rejection = self.run_step('false | true\ntest -f "$verdict"', shell="bash")
        self.assertIsNotNone(rejection)

    def test_both_shells_stop_at_a_failing_command(self):
        for shell in (None, "bash"):
            with self.subTest(shell=shell):
                self.assertIsNotNone(self.run_step("false\ntrue", shell=shell))

    def test_the_step_runs_in_the_arms_tree(self):
        root = self.tree()
        (root / "marker-for-the-record-step").write_text("here\n")
        step = "test -f marker-for-the-record-step\ntest -f greenlight/src/greenlight/cli.py"
        self.assertIsNone(self.run_step(step, root=root))
        self.assertIsNotNone(self.run_step(step, root=REPO_ROOT))

    def test_the_trace_names_the_check_that_failed_silently(self):
        rejection = self.run_step("jq -e '.absent' \"$verdict\" >/dev/null")
        self.assertIn("jq -e .absent", rejection)


class TestCannedVerdicts(TreeTestCase):
    """The verdicts the workflow emits with no model are held to the same checks."""

    def test_each_shipped_canned_verdict_passes(self):
        for name, reason in (
            ("too-large-verdict.json", "scope_too_large"),
            ("no-policy-verdict.json", "review_error"),
            ("greenlight-files-verdict.json", "not_trivial"),
        ):
            for target in (
                Target("pytorch/pytorch", "pytorch"),
                Target("pytorch/test-infra", "target"),
            ):
                with self.subTest(name=name, repo=target.repo):
                    verdict = arm_code.canned_verdict(
                        REPO_ROOT,
                        HEAD_RECORD_STEP,
                        REPO_ROOT / ".claude/hooks/greenlight" / name,
                        target,
                    )
                    self.assertEqual(
                        (verdict["status"], verdict["reason"]), ("NO_LAND", reason)
                    )

    def test_a_canned_verdict_the_checks_refuse_raises(self):
        path = self.scratch() / "too-large-verdict.json"
        path.write_text(
            json.dumps({"status": "NO_LAND", "reason": "too_chunky", "message": "-"})
        )
        with self.assertRaises(ValueError) as caught:
            arm_code.canned_verdict(
                REPO_ROOT,
                HEAD_RECORD_STEP,
                path,
                Target("pytorch/pytorch", "pytorch"),
            )
        self.assertIn("too_chunky", str(caught.exception))


class TestDryRunMakesNoWrite(TreeTestCase):
    """``--dry-run`` stays offline: the record path's row file is never written."""

    def test_no_row_or_key_file_appears(self):
        row = Path("/tmp/greenlight-verdict-row.json.gz")
        before = row.stat().st_mtime_ns if row.exists() else None
        path = self.scratch() / "greenlight-verdict.json"
        path.write_text(
            json.dumps({"status": "LAND", "reason": "clean", "message": "- ok"})
        )
        verdict, _ = arm_code._dry_run(REPO_ROOT, path, "pytorch/pytorch", 1, HEAD_SHA)
        self.assertIsNotNone(verdict)
        after = row.stat().st_mtime_ns if row.exists() else None
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
