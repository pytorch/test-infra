"""Tests for the settings layer the reviewer runs under.

Every assertion here is about what the reviewer's sandbox is made of, so they are checked
against the policy tree's REAL hook scripts rather than stubs: two of them read those files
to confirm the reason the harness treats them the way it does still holds.
"""

import dataclasses
import json
import os
import shlex
import subprocess
import unittest
from pathlib import Path

from replay_runner_fixtures import replay_policy, ScratchTestCase
from torchci.greenlight_replay import runner, settings
from torchci.greenlight_replay.hooks import remap


def script_of(command: str) -> str:
    """The script a hook command line runs, past its interpreter and before its args."""
    words = shlex.split(command)
    return words[1] if words[0] == "python3" else words[0]


class SettingsTestCase(ScratchTestCase):
    def setUp(self):
        self.run_dir = self.scratch("greenlight-settings-")
        self.policy = replay_policy(self.run_dir)

    def settings(self, *repo):
        return json.loads(
            settings.write_settings(self.policy, self.run_dir, *repo).read_text()
        )

    def commands(self, event):
        return [
            hook["command"]
            for entry in self.settings()["hooks"][event]
            for hook in entry["hooks"]
        ]


class TestRegisteredHooks(SettingsTestCase):
    """The production sandboxes come from the policy tree, so a policy PR changing them is
    what gets exercised rather than a copy kept in the harness."""

    def test_the_write_sandbox_is_the_policy_trees_own_script(self):
        self.assertIn(
            str(self.policy.hooks_dir / "restrict-write.sh"),
            self.commands("PreToolUse"),
        )

    def test_the_read_sandbox_is_the_policy_trees_own_script(self):
        self.assertTrue(
            any(
                str(self.policy.hooks_dir / "restrict-read.py") in command
                for command in self.commands("PreToolUse")
            )
        )

    def test_the_remap_hook_covers_every_tool_the_read_sandbox_covers(self):
        # Glob and Grep are included because restrict-read.py admits any /tmp/greenlight-*
        # search path: left un-remapped, a search reaches the SHARED /tmp.
        entries = self.settings()["hooks"]["PreToolUse"]
        remapper = [
            e for e in entries if Path(remap.__file__).name in e["hooks"][0]["command"]
        ]
        self.assertEqual(len(remapper), 1)
        self.assertEqual(remapper[0]["matcher"], settings.REMAP_MATCHER)
        for tool in ("Read", "Write", "Glob", "Grep"):
            self.assertIn(tool, settings.REMAP_MATCHER)

    def test_the_remap_is_registered_alongside_the_sandboxes_not_instead_of_them(self):
        # Every PreToolUse hook is handed the ORIGINAL input, so the production hooks go on
        # judging the un-remapped paths; replacing them would remove the sandbox outright.
        self.assertEqual(len(self.settings()["hooks"]["PreToolUse"]), 3)

    def test_the_pacing_hook_is_registered_with_a_pinned_timeout(self):
        post = self.settings()["hooks"]["PostToolUse"][0]["hooks"][0]
        self.assertEqual(post["timeout"], settings.BUDGET_HOOK_TIMEOUT_S)

    def test_the_output_style_matches_the_workflows(self):
        self.assertEqual(self.settings()["outputStyle"], "Concise")


class TestDeliberateOmissions(SettingsTestCase):
    """Two hooks the workflow registers are left out, and the reason still holds.

    Both assertions read the real scripts. An omission justified by a property of a file is
    only safe while the file still has that property, so the justification is checked rather
    than trusted.
    """

    def test_the_stop_hook_is_absent_because_it_watches_the_unremapped_path(self):
        self.assertNotIn("Stop", self.settings()["hooks"])
        self.assertIn(
            'VERDICT_FILE="/tmp/greenlight-verdict.json"',
            (self.policy.hooks_dir / "validate-on-stop.sh").read_text(),
        )

    def test_the_stop_hook_still_takes_no_override_that_would_let_it_be_registered(
        self,
    ):
        # If validate-on-stop.sh ever honours GREENLIGHT_REVIEW_VERDICT_FILE the way
        # budget-reminder.sh does, it can and should be registered again.
        stop_hook = (self.policy.hooks_dir / "validate-on-stop.sh").read_text()
        self.assertNotIn("GREENLIGHT_REVIEW_VERDICT_FILE", stop_hook)
        self.assertIn(
            "GREENLIGHT_REVIEW_VERDICT_FILE",
            (self.policy.hooks_dir / "budget-reminder.sh").read_text(),
        )

    def test_the_instruction_detector_hooks_are_absent(self):
        # They leave a manifest and a sentinel for a CI step that does not exist here.
        hooks = self.settings()["hooks"]
        self.assertNotIn("SessionStart", hooks)
        self.assertNotIn("InstructionsLoaded", hooks)


class TestHookCommandQuoting(SettingsTestCase):
    """A workdir containing a space must not silently disarm the sandbox.

    The CLI runs hook commands through a shell. Unquoted, one path becomes two words, the
    hook fails to exec -- and a hook that cannot run does not deny. All three PreToolUse
    hooks would drop out together: the read sandbox, the write sandbox, and the per-run
    remap, the last of which turns a parallel sweep into every reviewer sharing one diff
    and one verdict file. Nothing reports it, so nothing but this catches it.
    """

    def spaced_hooks(self) -> Path:
        spaced = self.scratch("greenlight-settings- with space-")
        hooks = spaced / ".claude/hooks/greenlight"
        hooks.mkdir(parents=True)
        for name in (
            "restrict-write.sh",
            "restrict-read.py",
            "budget-reminder.sh",
        ):
            (hooks / name).write_text("#!/bin/sh\nexit 0\n")
        return hooks

    def test_a_space_in_the_hooks_path_is_quoted_not_split(self):
        self.policy = dataclasses.replace(self.policy, hooks_dir=self.spaced_hooks())
        for command in self.commands("PreToolUse") + self.commands("PostToolUse"):
            self.assertTrue(
                Path(script_of(command)).is_file(),
                f"{command!r} does not resolve to a script",
            )

    def test_a_workdir_with_a_space_still_passes_the_run_dir_guard(self):
        # It is not rejected upstream, which is exactly why the quoting has to hold.
        spaced = self.scratch("greenlight-settings- with space-")
        self.assertIsNone(remap.run_dir_violation(str(spaced)))


class TestMissingHook(SettingsTestCase):
    """A hook script that is not there fails loudly instead of registering a no-op.

    Checked once at sweep startup rather than inside ``write_settings``: the condition is a
    property of the policy tree, identical for every pull request, and a per-run raise would
    also make the writer untestable without a full tree on disk.
    """

    def test_a_policy_tree_missing_its_hooks_is_named_not_silently_accepted(self):
        empty = self.scratch("greenlight-settings-empty-")
        stripped = dataclasses.replace(self.policy, hooks_dir=empty)
        missing = settings.missing_hooks(stripped)
        self.assertTrue(any(p.name == "restrict-write.sh" for p in missing))
        with self.assertRaises(settings.MissingHookError) as caught:
            settings.assert_hooks_present(stripped)
        self.assertIn("restrict-write.sh", str(caught.exception))

    def test_the_real_policy_tree_passes(self):
        self.assertEqual(settings.missing_hooks(self.policy), [])
        settings.assert_hooks_present(self.policy)

    def test_the_remap_hook_is_checked_too_not_just_the_policy_trees(self):
        # It is the one hook the harness supplies rather than the policy, and losing it
        # silently is what turns a parallel sweep into shared scratch files.
        names = {p.name for p in settings._hook_scripts(self.policy)}
        self.assertIn(Path(remap.__file__).name, names)

    def test_every_registered_hook_resolves_to_a_real_script(self):
        for command in self.commands("PreToolUse") + self.commands("PostToolUse"):
            self.assertTrue(Path(script_of(command)).is_file(), command)


class TestReadSandboxCheckout(SettingsTestCase):
    """``restrict-read.py`` serves the checkout the reviewed repo's workflow lays out.

    The workflow hands it the checkout directory as its one argument. Handed the wrong
    one, every read of the code under review is denied and the reviewer answers anyway,
    so the command line is checked, and then run, against the policy tree's real script.
    """

    def read_sandbox(self, *repo):
        entries = self.settings(*repo)["hooks"]["PreToolUse"]
        (command,) = [
            entry["hooks"][0]["command"]
            for entry in entries
            if "restrict-read.py" in entry["hooks"][0]["command"]
        ]
        return command

    def test_the_checkout_directory_is_the_scripts_one_argument(self):
        for repo, checkout in (
            ((), "pytorch"),
            (("pytorch/pytorch",), "pytorch"),
            (("pytorch/vision",), "target"),
        ):
            with self.subTest(repo=repo):
                words = shlex.split(self.read_sandbox(*repo))
                self.assertEqual(
                    words,
                    [
                        "python3",
                        str(self.policy.hooks_dir / "restrict-read.py"),
                        checkout,
                    ],
                )

    def test_a_repo_the_harness_cannot_replay_writes_no_settings(self):
        with self.assertRaises(ValueError):
            settings.write_settings(self.policy, self.run_dir, "facebook/vision")
        self.assertFalse((self.run_dir / settings.SETTINGS_FILENAME).exists())

    def run_read_sandbox(self, command, workspace, target):
        event = {"tool_name": "Read", "tool_input": {"file_path": str(target)}}
        return subprocess.run(
            command,
            shell=True,
            input=json.dumps(event),
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": os.environ["PATH"], "GITHUB_WORKSPACE": str(workspace)},
        )

    def test_the_policy_trees_script_serves_that_checkout_and_no_other(self):
        # Outside /tmp/greenlight-*, which the script admits wholesale as scratch.
        workspace = self.scratch("replay-settings-workspace-")
        for checkout in ("pytorch", "target"):
            (workspace / checkout).mkdir()
            (workspace / checkout / "setup.py").write_text("")
        for repo, served, other in (
            ("pytorch/pytorch", "pytorch", "target"),
            ("pytorch/vision", "target", "pytorch"),
        ):
            with self.subTest(repo=repo):
                command = self.read_sandbox(repo)
                allowed = self.run_read_sandbox(
                    command, workspace, workspace / served / "setup.py"
                )
                self.assertEqual(allowed.returncode, 0, allowed.stderr)
                denied = self.run_read_sandbox(
                    command, workspace, workspace / other / "setup.py"
                )
                self.assertEqual(denied.returncode, 2, denied.stderr)


class TestReExport(SettingsTestCase):
    """``write_settings`` stays reachable through ``runner``, where callers meet it."""

    def test_runner_re_exports_the_same_function(self):
        self.assertIs(runner.write_settings, settings.write_settings)

    def test_runner_names_the_settings_file_the_writer_writes(self):
        written = settings.write_settings(self.policy, self.run_dir)
        self.assertEqual(written.name, settings.SETTINGS_FILENAME)
        argv = runner.build_command(
            self.policy, self.run_dir, self.run_dir, timeout_s=60, model="m"
        )
        self.assertEqual(argv[argv.index("--settings") + 1], str(written))


if __name__ == "__main__":
    unittest.main()
