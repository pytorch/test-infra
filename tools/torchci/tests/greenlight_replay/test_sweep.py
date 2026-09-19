"""Tests for what one pull request goes through on its way to a verdict.

The layout the reviewer is handed, the sanitize pass over the checkout it is
about to read, the model it is asked for, and what happens when a sweep is
interrupted. Which pull requests are selected and what the run reports
afterwards are tested in ``test_main``.

Every seam that reaches outside the process is patched by ``replay_fixtures``;
nothing here invokes a model or opens a connection.
"""

import logging
import os
import signal
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import torchci.greenlight_replay.__main__ as cli
from replay_fixtures import Fakes, POLICY_MODEL, replay_row, run_replay, SCRATCH_PREFIX
from torchci.greenlight_replay import (
    preflight as preflight_module,
    sweep as sweep_module,
    workspace as workspace_module,
)
from torchci.greenlight_replay.runner import DEFAULT_MODEL, Outcome


def setUpModule():
    logging.disable(logging.CRITICAL)


def tearDownModule():
    logging.disable(logging.NOTSET)


class TestScratchRoot(unittest.TestCase):
    """The reviewer's read sandbox admits scratch paths by string prefix --
    realpath('/tmp') + '/greenlight-'. A workdir outside it does not crash the
    reviewer: every remapped read of the diff and the metadata is denied and it
    answers about a pull request it never saw, so it is refused up front."""

    def test_a_workdir_outside_the_prefix_is_refused(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            with self.assertRaises(ValueError) as caught:
                preflight_module.check_workdir(Path(elsewhere))
            self.assertIn("scratch prefix", str(caught.exception))

    def test_a_workdir_inside_the_prefix_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix=SCRATCH_PREFIX, dir="/tmp") as inside:
            preflight_module.check_workdir(Path(inside))

    def test_the_run_directories_are_siblings_of_the_policy_tree(self):
        # Nested under it they would be inside the reviewer's workspace root,
        # and one pull request could read another's diff and verdict.
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            run_dir = fakes.run_dirs[0]
            workspace = fakes.workspaces[0]
            self.assertFalse(run_dir.is_relative_to(workspace))
            self.assertEqual(run_dir.parent.name, preflight_module.RUNS_DIRNAME)
            self.assertIsNone(
                preflight_module.remap.run_dir_violation(str(run_dir.resolve()))
            )


class TestWorkspaceLayout(unittest.TestCase):
    """The reviewer's workspace root holds the checkout at ./pytorch and the
    policy tree's .claude beside it -- restrict-read.py's whole allowlist.

    A pool slot supplies only the first. Handed the checkout itself, or a
    workspace short of the policy half, the reviewer's reads are denied one by
    one and it still returns a verdict, formed from no code. So the layout is
    assembled here and checked before the model is paid for."""

    def test_the_runner_is_handed_the_policy_tree_beside_the_checkout(self):
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            workspace = fakes.workspaces[0]
            worktree = fakes.pools[0].acquired[0][0]
            self.assertNotEqual(workspace, worktree)
            self.assertEqual(workspace / workspace_module.PYTORCH_SUBDIR, worktree)
            for root in workspace_module.WORKSPACE_ROOTS:
                with self.subTest(root=root):
                    self.assertTrue((workspace / root).is_dir())

    def test_concurrent_slots_get_separate_workspaces(self):
        fakes = Fakes([replay_row(194000 + n) for n in range(4)])
        with run_replay(fakes, ["--parallelism", "2"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            worktrees = {slot for slot, _, _ in fakes.pools[0].acquired}
            self.assertGreater(len(worktrees), 1)
            self.assertEqual(len(set(fakes.workspaces)), len(worktrees))

    def test_the_pull_request_number_reaches_the_checkout(self):
        # A head that exists only on a fork branch is unfetchable by SHA alone.
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        _, head_sha, pr_number = fakes.pools[0].acquired[0]
        self.assertEqual(pr_number, 194379)
        self.assertEqual(head_sha, f"{194379:040d}")

    def test_a_policy_without_its_skills_never_reaches_the_model(self):
        fakes = Fakes(
            [replay_row(n) for n in (194379, 194772)], policy_claude=("hooks",)
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(fakes.reviewed, [])

    def test_check_workspace_names_every_missing_root(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            with self.assertRaises(workspace_module.WorkspaceLayoutError) as caught:
                workspace_module.check_workspace(workspace)
            for root in workspace_module.WORKSPACE_ROOTS:
                self.assertIn(root, str(caught.exception))
            for root in workspace_module.WORKSPACE_ROOTS:
                (workspace / root).mkdir(parents=True)
            workspace_module.check_workspace(workspace)


class TestModelMapping(unittest.TestCase):
    """The policy names a Bedrock inference profile, read verbatim out of the CI
    workflow. Passed through it turns every run into an API error, because the
    runner asserts modelUsage names the model it asked for; quietly replaced by
    a default it reviews the new policy on the model the new policy replaced,
    and reads as a clean sweep. Neither may happen silently."""

    def test_the_profile_is_mapped_to_the_local_name(self):
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, [DEFAULT_MODEL])
        self.assertNotEqual(DEFAULT_MODEL, POLICY_MODEL)

    def test_an_unmapped_profile_stops_the_sweep_before_it_spends(self):
        fakes = Fakes(
            [replay_row(n) for n in (194379, 194772)],
            policy_model="global.anthropic.claude-something-else",
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_FAILED)
            self.assertFalse(output.exists())
        self.assertEqual(fakes.reviewed, [])

    def test_the_model_flag_overrides_an_unmapped_profile(self):
        fakes = Fakes(
            [replay_row(194379)], policy_model="global.anthropic.claude-something-else"
        )
        with run_replay(
            fakes, ["--parallelism", "1", "--model", "claude-sonnet-5"]
        ) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, ["claude-sonnet-5"])

    def test_local_model_names_what_it_knows(self):
        with self.assertRaises(ValueError) as caught:
            sweep_module.local_model("nope")
        self.assertIn(POLICY_MODEL, str(caught.exception))
        self.assertIn("--model", str(caught.exception))


class TestCircuitBreaker(unittest.TestCase):
    """A fault the warm-up hits is a fault every run hits: the model the gateway
    resolved, the schema the policy ships, the prompt the CLI parsed. None varies
    by pull request, so the sweep must stop on the first rather than bill the
    rest -- reporting it in the exit status after the fact is thirty runs late."""

    def _sweep(self, outcome, total=4):
        numbers = [194000 + n for n in range(total)]
        fakes = Fakes(
            [replay_row(n) for n in numbers],
            outcomes={numbers[0]: outcome},
            statuses={numbers[0]: ""},
        )
        with run_replay(fakes, ["--parallelism", "2"]) as (code, output):
            # Read inside the block: leaving it deletes the scratch tree.
            lines = (
                output.read_text(encoding="utf-8").splitlines()
                if output.exists()
                else []
            )
        return code, fakes, lines

    def test_a_deterministic_fault_stops_after_the_warm_up(self):
        for outcome in sorted(sweep_module.FATAL_OUTCOMES, key=lambda o: o.value):
            with self.subTest(outcome=outcome.value):
                code, fakes, _ = self._sweep(outcome)
                self.assertEqual(fakes.reviewed, [194000])
                self.assertEqual(code, cli.EXIT_FAILED)

    def test_a_per_pull_request_fault_does_not_stop_the_sweep(self):
        # A timeout is the one pull request being slow, not the harness being
        # broken; stopping on it would throw away a usable sweep.
        _, fakes, _ = self._sweep(Outcome.TIMEOUT)
        self.assertEqual(sorted(fakes.reviewed), [194000, 194001, 194002, 194003])

    def test_the_warm_up_row_still_reaches_the_file(self):
        # The run was paid for; its diagnostic row is what names the fault.
        _, _, lines = self._sweep(Outcome.API_ERROR)
        self.assertEqual(len(lines), 2)  # header plus the one row


class TestAbortStopsSpending(unittest.TestCase):
    """An escape from the fan-out loop must not leave the queue billing.

    ThreadPoolExecutor.__exit__ shuts down with wait=True and cancels nothing, so
    on the way out it would run every review already submitted -- hundreds of
    dollars after the reason to stop was known."""

    def test_the_queue_is_stopped_when_the_loop_gives_up(self):
        sweep = SimpleNamespace(interrupted=threading.Event())
        seen = []

        def exploding_run_one(_sweep, row):
            seen.append(row["pr_number"])
            if len(seen) == 2:
                # BaseException: the one shape run_one's own guard cannot catch.
                raise KeyboardInterrupt("out of disk")
            time.sleep(0.02)
            return None

        rows = [replay_row(194000 + n) for n in range(12)]
        with mock.patch.object(sweep_module, "run_one", exploding_run_one):
            with self.assertRaises(KeyboardInterrupt):
                sweep_module.run_sweep(sweep, rows, 2)
        self.assertTrue(sweep.interrupted.is_set())
        self.assertLess(len(seen), len(rows))

    def test_a_failing_checkpoint_append_is_recorded_not_raised(self):
        # The append is inside run_one's guard. Outside it, a full disk on run 5
        # of 200 would propagate through future.result() and the executor would
        # bill the remaining 195 on its way out.
        numbers = [194000 + n for n in range(4)]
        fakes = Fakes([replay_row(n) for n in numbers], append_fails=set(numbers))
        with run_replay(fakes, ["--parallelism", "2"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(sorted(fakes.reviewed), numbers)


class TestSizeGate(unittest.TestCase):
    """A pull request the policy's cap declines needs no reviewer, so it must not
    pay for a slot, a blob fetch and a clean walk to reach a canned verdict.
    Tightening that cap is exactly the policy change this tool gets run for."""

    def test_a_declined_pull_request_never_takes_a_worktree(self):
        fakes = Fakes([replay_row(194379)], too_large=True)
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.pools[0].acquired, [])
        self.assertFalse(fakes.sanitize_log.exists())


class TestGuardedDelete(unittest.TestCase):
    """The policy half is replaced rather than overlaid, so a file the policy
    under test deleted cannot survive into the review. That means an rmtree, and
    it takes only a directory this module would have made."""

    def test_a_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "real").mkdir()
            link = root / ".claude"
            link.symlink_to(root / "real", target_is_directory=True)
            with self.assertRaises(ValueError) as caught:
                workspace_module._clear_policy_half(link)
            self.assertIn("symlink", str(caught.exception))
            self.assertTrue((root / "real").is_dir())

    def test_a_checkout_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            claude = Path(directory) / ".claude"
            (claude / ".git").mkdir(parents=True)
            with self.assertRaises(ValueError) as caught:
                workspace_module._clear_policy_half(claude)
            self.assertIn(".git", str(caught.exception))
            self.assertTrue(claude.is_dir())

    def test_a_directory_by_another_name_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory) / "src"
            other.mkdir()
            with self.assertRaises(ValueError):
                workspace_module._clear_policy_half(other)
            self.assertTrue(other.is_dir())

    def test_the_tree_it_made_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            claude = Path(directory) / ".claude"
            (claude / "skills").mkdir(parents=True)
            workspace_module._clear_policy_half(claude)
            self.assertFalse(claude.exists())


class TestStartupChecks(unittest.TestCase):
    """Faults that are free to find before the network is touched, found there."""

    def test_a_policy_ref_the_remote_does_not_have_is_named(self):
        # The likeliest way to start a sweep wrong, and the one thing a dry run
        # could not catch before: it prices a plan that cannot run.
        completed = SimpleNamespace(returncode=2, stdout=b"", stderr=b"")
        with mock.patch.object(
            preflight_module.subprocess, "run", return_value=completed
        ):
            with self.assertRaises(ValueError) as caught:
                preflight_module.check_policy_ref("8830")
        self.assertIn("refs/pull/8830/head", str(caught.exception))
        self.assertIn("pytorch/test-infra", str(caught.exception))

    def test_a_bare_number_resolves_the_way_materialize_fetches_it(self):
        # If these two disagree the check validates a ref the sweep never asks for.
        self.assertEqual(
            preflight_module.resolve_refspec("8830"), "refs/pull/8830/head"
        )
        self.assertEqual(preflight_module.resolve_refspec("main"), "main")
        with self.assertRaises(ValueError):
            preflight_module.resolve_refspec("../etc/passwd")

    def test_a_missing_reviewer_binary_is_named(self):
        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaises(FileNotFoundError) as caught:
                preflight_module.check_binaries(path=empty)
            self.assertIn("claude", str(caught.exception))

    def test_a_schema_keyword_the_validator_cannot_read_is_refused(self):
        # A property of the policy, identical for every pull request, and retried
        # once apiece -- so it bills the whole corpus twice for nothing.
        fakes = Fakes(
            [replay_row(n) for n in (194379, 194772)],
            policy_schema='{"type": "object", "maxLength": 3}',
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(fakes.reviewed, [])

    def test_an_unrunnable_hook_stops_the_sweep(self):
        # A hook that cannot exec does not deny; it silently does not run, so the
        # sandbox is off and every review still returns a verdict.
        fakes = Fakes([replay_row(194379)], hooks_missing=True)
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(fakes.reviewed, [])

    def test_an_unparseable_verdict_schema_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            schema = Path(directory) / "verdict-schema.json"
            schema.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ValueError) as caught:
                sweep_module.check_schema(SimpleNamespace(schema_path=schema))
            self.assertIn("not readable JSON", str(caught.exception))

    def test_a_dry_run_refuses_a_scratch_root_it_could_not_use(self):
        fakes = Fakes([replay_row(194379)])
        with tempfile.TemporaryDirectory() as elsewhere:
            with mock.patch.object(
                preflight_module, "check_workdir", side_effect=ValueError("bad root")
            ):
                with run_replay(fakes, ["--dry-run"]) as (code, _):
                    self.assertEqual(code, cli.EXIT_FAILED)
            self.assertTrue(Path(elsewhere).is_dir())


class TestSanitize(unittest.TestCase):
    """The reviewed checkout is attacker-controlled: a pull request can ship its
    own CLAUDE.md or .claude tree, which the reviewer would read as instructions
    about its own review. The sanitize script exits 1 when given one argument,
    so passing only the checkout fails open-looking rather than loudly."""

    def test_the_checkout_and_the_trusted_skills_are_both_passed(self):
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            logged = fakes.sanitize_log.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(logged), 1)
            argc, checkout, trusted = logged[0].split("|")
            self.assertEqual(argc, "2")
            self.assertEqual(Path(checkout), fakes.pools[0].acquired[0][0])
            self.assertTrue(Path(trusted).is_dir())
            self.assertNotEqual(Path(trusted), Path(checkout))

    def test_a_failing_sanitize_stops_the_pull_request(self):
        fakes = Fakes([replay_row(194379)])
        failure = RuntimeError("sanitize exited 1")
        with mock.patch.object(sweep_module, "sanitize_checkout", side_effect=failure):
            with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
                self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(fakes.reviewed, [])


class TestCommentCutoff(unittest.TestCase):
    """The reviewer must see the pull request as it stood when the replayed
    verdict was written, so the comment cutoff is that verdict's own timestamp
    parsed to an instant, not the CSV's text."""

    def test_the_decision_version_reaches_build_inputs_as_an_instant(self):
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.comment_cutoffs, [datetime(2026, 8, 14, 9, 30)])


class TestTrustworthiness(unittest.TestCase):
    """Whether enough runs reached a verdict for the new columns to describe the
    policy. Keyed on an empty new_decision rather than on a run outcome, so a
    budget trip that recovered a usable verdict counts as a verdict."""

    def test_the_ratio_counts_runs_that_never_reached_the_reviewer(self):
        verdict = {"new_decision": "LAND"}
        trustworthy = sweep_module.runs_are_trustworthy
        self.assertTrue(trustworthy({}, []))
        self.assertTrue(trustworthy({1: verdict}, []))
        self.assertTrue(trustworthy({1: verdict}, [("2", "GitError")]))
        self.assertFalse(
            trustworthy({1: verdict}, [("2", "GitError"), ("3", "GitError")])
        )
        self.assertFalse(
            trustworthy({1: verdict, 2: {"new_decision": ""}}, [("3", "GitError")])
        )

    def test_a_recovered_verdict_counts_as_one(self):
        recovered = {"new_decision": "NO_LAND", "new_decision_reason": "risky"}
        self.assertTrue(sweep_module.runs_are_trustworthy({1: recovered}, []))


class TestInterrupt(unittest.TestCase):
    """Ctrl-C part way through a sweep must not throw away the verdicts already
    paid for: the checkpoint is what the CSV is built from, so the file still
    gets written for however far the sweep got."""

    def test_a_sigint_still_writes_what_was_judged(self):
        numbers = [194379, 194772, 194773, 194774]

        def interrupt(pr_number):
            os.kill(os.getpid(), signal.SIGINT)
            # Give the interpreter a check point at which to run the handler.
            time.sleep(0.05)

        fakes = Fakes([replay_row(n) for n in numbers], on_review=interrupt)
        original = signal.getsignal(signal.SIGINT)
        try:
            with run_replay(fakes, ["--parallelism", "2"]) as (code, output):
                self.assertTrue(output.exists())
                rows = output.read_text(encoding="utf-8").splitlines()
        finally:
            signal.signal(signal.SIGINT, original)
        self.assertEqual(len(fakes.reviewed), 1)
        self.assertEqual(len(rows), 2)  # header plus the one judged
        self.assertEqual(code, cli.EXIT_FAILED)

    def test_the_guard_restores_the_previous_handler(self):
        before = signal.getsignal(signal.SIGINT)
        with sweep_module.interrupt_guard() as interrupted:
            self.assertFalse(interrupted.is_set())
            self.assertIsNot(signal.getsignal(signal.SIGINT), before)
        self.assertIs(signal.getsignal(signal.SIGINT), before)


if __name__ == "__main__":
    unittest.main()
