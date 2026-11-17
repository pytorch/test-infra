"""Tests for the settings layer the reviewer runs under.

Every assertion here is about what the reviewer's sandbox is made of, so the settings are
derived from this repository's real workflow and checked against the policy tree's REAL
hook scripts rather than stubs; the refusals are each shown on a mutated copy of the real
heredoc.
"""

import dataclasses
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from replay_runner_fixtures import (
    head_hook_settings,
    HEAD_WORKFLOW,
    replay_policy,
    REPO_ROOT,
    ScratchTestCase,
    WORKFLOW_PATH,
)
from torchci.greenlight_replay import runner, settings, workflow_steps
from torchci.greenlight_replay.hooks import remap


HOOKS_RELPATH = ".claude/hooks/greenlight"
HEAD_TEXT = workflow_steps.hook_settings_text(HEAD_WORKFLOW, WORKFLOW_PATH)


def script_of(command: str) -> str:
    """The script a hook command line runs, past its interpreter and before its args."""
    words = shlex.split(command)
    return words[1] if words[0] == "python3" else words[0]


class SettingsTestCase(ScratchTestCase):
    def setUp(self):
        self.run_dir = self.scratch("greenlight-settings-")
        self.policy = replay_policy()

    def settings(self):
        return json.loads(
            settings.write_settings(self.policy, self.run_dir).read_text()
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
            shlex.quote(str(REPO_ROOT / HOOKS_RELPATH / "restrict-write.sh")),
            self.commands("PreToolUse"),
        )

    def test_the_read_sandbox_is_the_policy_trees_own_script(self):
        self.assertTrue(
            any(
                str(REPO_ROOT / HOOKS_RELPATH / "restrict-read.py") in command
                for command in self.commands("PreToolUse")
            )
        )

    def test_the_remap_hook_is_last_and_covers_every_tool_the_read_sandbox_covers(self):
        # Glob and Grep are included because restrict-read.py admits any /tmp/greenlight-*
        # search path: left un-remapped, a search reaches the SHARED /tmp.
        entries = self.settings()["hooks"]["PreToolUse"]
        self.assertIn(Path(remap.__file__).name, entries[-1]["hooks"][0]["command"])
        self.assertEqual(entries[-1]["matcher"], settings.REMAP_MATCHER)
        for tool in ("Read", "Write", "Glob", "Grep"):
            self.assertIn(tool, settings.REMAP_MATCHER.split("|"))

    def test_the_remap_is_registered_alongside_the_sandboxes_not_instead_of_them(self):
        # Every PreToolUse hook is handed the ORIGINAL input, so the production hooks go on
        # judging the un-remapped paths; replacing them would remove the sandbox outright.
        self.assertEqual(len(self.settings()["hooks"]["PreToolUse"]), 3)

    def test_the_matchers_and_the_pacing_timeout_are_the_workflows(self):
        derived = json.loads(
            HEAD_TEXT.replace(settings.CHECKOUT_PLACEHOLDER, "pytorch")
        )["hooks"]
        written = self.settings()["hooks"]
        for event in ("PreToolUse", "PostToolUse"):
            self.assertEqual(
                [
                    entry.get("matcher")
                    for entry in written[event][: len(derived[event])]
                ],
                [entry.get("matcher") for entry in derived[event]],
            )
        self.assertEqual(
            written["PostToolUse"][0]["hooks"][0]["timeout"],
            derived["PostToolUse"][0]["hooks"][0]["timeout"],
        )

    def test_the_output_style_is_the_policys_and_absent_without_one(self):
        self.assertEqual(self.settings()["outputStyle"], "Concise")
        self.policy = dataclasses.replace(self.policy, output_style=None)
        self.assertNotIn("outputStyle", self.settings())

    def test_claude_md_excludes_name_the_targets_checkout(self):
        for checkout in ("pytorch", "target"):
            with self.subTest(checkout=checkout):
                self.policy = dataclasses.replace(
                    self.policy, hook_settings=head_hook_settings(checkout)
                )
                excludes = self.settings()["claudeMdExcludes"]
                self.assertIn(f"**/{checkout}/CLAUDE.md", excludes)
                self.assertNotIn(settings.CHECKOUT_PLACEHOLDER, json.dumps(excludes))


class TestDetectorHooks(SettingsTestCase):
    """SessionStart and InstructionsLoaded are kept as the workflow writes them.

    ``RUNNER_TEMP`` stays literal in the command, so each hook's shell expands it to the
    run directory ``reviewer_env`` sets, and the detector reads what they left there.
    """

    def run_hook(self, command, stdin=""):
        return subprocess.run(
            command,
            shell=True,
            input=stdin,
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": os.environ["PATH"], "RUNNER_TEMP": str(self.run_dir)},
        )

    def test_the_session_start_hook_writes_the_sentinel_into_runner_temp(self):
        (command,) = self.commands("SessionStart")
        self.assertEqual(command, workflow_steps.SENTINEL_COMMAND)
        self.assertEqual(self.run_hook(command).returncode, 0)
        self.assertTrue((self.run_dir / workflow_steps.SENTINEL_BASENAME).is_file())

    def test_the_instructions_loaded_hook_appends_to_the_manifest(self):
        (command,) = self.commands("InstructionsLoaded")
        event = json.dumps({"file_path": "/x/CLAUDE.md"})
        for _ in range(2):
            self.assertEqual(self.run_hook(command, event).returncode, 0)
        lines = (
            (self.run_dir / workflow_steps.MANIFEST_BASENAME).read_text().splitlines()
        )
        self.assertEqual([line for line in lines if line], [event, event])


class TestDeliberateOmissions(SettingsTestCase):
    """The Stop hook is left out, and the reason still holds.

    Both assertions read the real scripts. An omission justified by a property of a file is
    only safe while the file still has that property, so the justification is checked rather
    than trusted.
    """

    def test_the_workflow_registers_a_stop_hook_the_replay_drops(self):
        self.assertIn("Stop", self.policy.hook_settings["hooks"])
        self.assertNotIn("Stop", self.settings()["hooks"])

    def test_the_stop_hook_watches_the_unremapped_path(self):
        self.assertIn(
            'VERDICT_FILE="/tmp/greenlight-verdict.json"',
            (REPO_ROOT / HOOKS_RELPATH / "validate-on-stop.sh").read_text(),
        )

    def test_the_stop_hook_still_takes_no_override_that_would_let_it_be_registered(
        self,
    ):
        # If validate-on-stop.sh ever honours GREENLIGHT_REVIEW_VERDICT_FILE the way
        # budget-reminder.sh does, it can and should be registered again.
        hooks = REPO_ROOT / HOOKS_RELPATH
        self.assertNotIn(
            "GREENLIGHT_REVIEW_VERDICT_FILE",
            (hooks / "validate-on-stop.sh").read_text(),
        )
        self.assertIn(
            "GREENLIGHT_REVIEW_VERDICT_FILE", (hooks / "budget-reminder.sh").read_text()
        )


class TestHookCommandQuoting(SettingsTestCase):
    """A policy tree whose path holds a space must not silently disarm the sandbox.

    The CLI runs hook commands through a shell. Unquoted, one path becomes two words, the
    hook fails to exec -- and a hook that cannot run does not deny. All three PreToolUse
    hooks would drop out together: the read sandbox, the write sandbox, and the per-run
    remap, the last of which turns a parallel sweep into every reviewer sharing one diff
    and one verdict file. Nothing reports it, so nothing but this catches it.
    """

    def spaced_root(self) -> Path:
        spaced = self.scratch("greenlight-settings- with space-")
        shutil.copytree(REPO_ROOT / HOOKS_RELPATH, spaced / HOOKS_RELPATH)
        return spaced

    def test_a_space_in_the_tree_path_is_quoted_not_split(self):
        self.policy = dataclasses.replace(self.policy, root=self.spaced_root())
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
    """A hook script that cannot run fails loudly instead of registering a no-op.

    This is the one gate on the scripts: derivation only parses the commands.
    """

    def tree_with(self, mode, script="budget-reminder.sh"):
        root = self.scratch("greenlight-settings-tree-")
        shutil.copytree(REPO_ROOT / HOOKS_RELPATH, root / HOOKS_RELPATH)
        os.chmod(root / HOOKS_RELPATH / script, mode)
        return dataclasses.replace(self.policy, root=root)

    def test_a_script_run_directly_that_cannot_execute_is_named(self):
        policy = self.tree_with(0o644)
        missing = settings.missing_hooks(policy)
        self.assertEqual([path.name for path in missing], ["budget-reminder.sh"])
        with self.assertRaises(settings.MissingHookError) as caught:
            settings.assert_hooks_present(policy)
        self.assertIn("not executable", str(caught.exception))

    def test_a_script_run_through_python3_only_has_to_exist(self):
        policy = self.tree_with(0o644, script="restrict-read.py")
        self.assertEqual(settings.missing_hooks(policy), [])

    def test_a_stop_hook_script_is_not_checked_because_it_is_not_registered(self):
        policy = self.tree_with(0o755)
        (policy.root / HOOKS_RELPATH / "validate-on-stop.sh").unlink()
        self.assertEqual(settings.missing_hooks(policy), [])

    def test_a_policy_tree_missing_its_hooks_is_named_not_silently_accepted(self):
        empty = self.scratch("greenlight-settings-empty-")
        stripped = dataclasses.replace(self.policy, root=empty)
        missing = settings.missing_hooks(stripped)
        self.assertTrue(any(p.name == "restrict-write.sh" for p in missing))
        with self.assertRaises(settings.MissingHookError) as caught:
            settings.assert_hooks_present(stripped)
        self.assertIn("restrict-write.sh", str(caught.exception))

    def test_the_real_policy_tree_passes(self):
        self.assertEqual(settings.missing_hooks(self.policy), [])
        settings.assert_hooks_present(self.policy)

    def test_the_scripts_checked_are_the_derived_ones_plus_the_remap(self):
        scripts = {
            path.name: direct for path, direct in settings._hook_scripts(self.policy)
        }
        self.assertEqual(
            scripts,
            {
                "restrict-write.sh": True,
                "restrict-read.py": False,
                "budget-reminder.sh": True,
                Path(remap.__file__).name: False,
            },
        )

    def test_every_registered_hook_resolves_to_a_real_script(self):
        for command in self.commands("PreToolUse") + self.commands("PostToolUse"):
            self.assertTrue(Path(script_of(command)).is_file(), command)


class TestReadSandboxCheckout(SettingsTestCase):
    """``restrict-read.py`` serves the checkout ``greenlight target`` named.

    The workflow hands it the checkout directory as its one argument. Handed the wrong
    one, every read of the code under review is denied and the reviewer answers anyway,
    so the command line is checked, and then run, against the policy tree's real script.
    """

    def read_sandbox(self, checkout):
        self.policy = dataclasses.replace(
            self.policy, hook_settings=head_hook_settings(checkout)
        )
        (command,) = [
            entry["hooks"][0]["command"]
            for entry in self.settings()["hooks"]["PreToolUse"]
            if "restrict-read.py" in entry["hooks"][0]["command"]
        ]
        return command

    def test_the_checkout_directory_is_the_scripts_one_argument(self):
        for checkout in ("pytorch", "target"):
            with self.subTest(checkout=checkout):
                self.assertEqual(
                    shlex.split(self.read_sandbox(checkout)),
                    [
                        "python3",
                        str(REPO_ROOT / HOOKS_RELPATH / "restrict-read.py"),
                        checkout,
                    ],
                )

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
        for served, other in (("pytorch", "target"), ("target", "pytorch")):
            with self.subTest(served=served):
                command = self.read_sandbox(served)
                allowed = self.run_read_sandbox(
                    command, workspace, workspace / served / "setup.py"
                )
                self.assertEqual(allowed.returncode, 0, allowed.stderr)
                denied = self.run_read_sandbox(
                    command, workspace, workspace / other / "setup.py"
                )
                self.assertEqual(denied.returncode, 2, denied.stderr)


class TestDerivation(ScratchTestCase):
    """The heredoc is reproduced only where the replay can reproduce it exactly."""

    def derive(self, document, checkout="pytorch"):
        text = document if isinstance(document, str) else json.dumps(document)
        return settings.derive_hook_settings(text, checkout, WORKFLOW_PATH)

    def mutated(self):
        return json.loads(HEAD_TEXT)

    def assert_refused(self, document, needle):
        with self.assertRaises(ValueError) as caught:
            self.derive(document)
        self.assertIn(needle, str(caught.exception))

    def test_the_head_heredoc_derives_with_the_checkout_substituted(self):
        derived = self.derive(HEAD_TEXT, checkout="target")
        self.assertNotIn(settings.CHECKOUT_PLACEHOLDER, json.dumps(derived))
        (read,) = [
            entry
            for entry in derived["hooks"]["PreToolUse"]
            if "restrict-read.py" in entry["hooks"][0]["command"]
        ]
        self.assertTrue(read["hooks"][0]["command"].endswith(" target"))

    def test_a_heredoc_without_the_placeholder_keeps_its_commands_as_written(self):
        # A workflow without a target step names pytorch literally and hands
        # restrict-read.py nothing.
        text = HEAD_TEXT.replace(f" {settings.CHECKOUT_PLACEHOLDER}", "").replace(
            settings.CHECKOUT_PLACEHOLDER, "pytorch"
        )
        derived = self.derive(text, checkout="target")
        commands = [
            hook["command"]
            for entry in derived["hooks"]["PreToolUse"]
            for hook in entry["hooks"]
        ]
        self.assertIn(f"python3 {HOOKS_RELPATH}/restrict-read.py", commands)
        self.assertIn("**/pytorch/CLAUDE.md", derived["claudeMdExcludes"])

    def test_a_key_other_than_hooks_and_claude_md_excludes_is_refused(self):
        document = {**self.mutated(), "permissions": {"allow": ["Bash"]}}
        self.assert_refused(document, "hooks")

    def test_an_event_the_replay_does_not_know_is_refused(self):
        document = self.mutated()
        document["hooks"]["UserPromptSubmit"] = []
        self.assert_refused(document, "UserPromptSubmit")

    def test_a_hook_that_is_not_a_command_is_refused(self):
        document = self.mutated()
        document["hooks"]["PreToolUse"][0]["hooks"][0]["type"] = "prompt"
        self.assert_refused(document, "not a command")

    def test_a_missing_script_is_left_to_the_one_gate_that_checks_scripts(self):
        document = self.mutated()
        document["hooks"]["PostToolUse"][0]["hooks"][0]["command"] = (
            f"{HOOKS_RELPATH}/no-such-hook.sh"
        )
        policy = dataclasses.replace(
            replay_policy(), hook_settings=self.derive(document)
        )
        self.assertEqual(
            [path.name for path in settings.missing_hooks(policy)], ["no-such-hook.sh"]
        )

    def test_a_write_sandbox_on_a_matcher_missing_edit_is_refused(self):
        document = self.mutated()
        document["hooks"]["PreToolUse"][0]["matcher"] = "Write"
        self.assert_refused(document, "restrict-write.sh")

    def test_a_read_sandbox_on_a_matcher_missing_grep_is_refused(self):
        document = self.mutated()
        document["hooks"]["PreToolUse"][1]["matcher"] = "Read|Glob"
        self.assert_refused(document, "restrict-read.py")

    def test_a_wildcard_matcher_does_not_count_as_covering_the_tools(self):
        document = self.mutated()
        document["hooks"]["PreToolUse"][0]["matcher"] = "*"
        self.assert_refused(document, "restrict-write.sh")

    def test_a_session_start_command_other_than_the_sentinel_is_refused(self):
        document = self.mutated()
        document["hooks"]["SessionStart"][0]["hooks"][0]["command"] = "true"
        self.assert_refused(document, "SessionStart")

    def test_an_instructions_loaded_command_other_than_the_manifest_is_refused(self):
        document = self.mutated()
        document["hooks"]["InstructionsLoaded"][0]["hooks"][0]["command"] = (
            workflow_steps.SENTINEL_COMMAND
        )
        self.assert_refused(document, "InstructionsLoaded")

    def test_a_command_with_shell_syntax_around_the_script_is_refused(self):
        document = self.mutated()
        document["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = (
            f"{HOOKS_RELPATH}/restrict-write.sh; true"
        )
        self.assert_refused(document, "plain command line")

    def test_a_command_naming_no_hooks_script_is_refused(self):
        document = self.mutated()
        document["hooks"]["PostToolUse"][0]["hooks"][0]["command"] = "echo paced"
        self.assert_refused(document, "PostToolUse")

    def test_excludes_that_are_not_a_list_of_strings_are_refused(self):
        document = {**self.mutated(), "claudeMdExcludes": "**/CLAUDE.md"}
        self.assert_refused(document, "claudeMdExcludes")

    def test_text_that_is_not_json_is_refused(self):
        self.assert_refused(HEAD_TEXT[:-2], "not JSON")


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
