"""Tests for what one pull request goes through on its way to a verdict.

The layout the reviewer is handed, the sanitize pass over the checkout it is
about to read, the model it is asked for, and what happens when a sweep is
interrupted. Which pull requests are selected and what the run reports
afterwards are tested in ``test_main``.

Every seam that reaches outside the process is patched by ``replay_fixtures``;
nothing here invokes a model or opens a connection.
"""

import contextlib
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
from replay_fixtures import (
    Fakes,
    GREENLIGHT_FILES_MESSAGE,
    NO_POLICY_MESSAGE,
    POLICY_MODEL,
    replay_row,
    REPO_POLICY_SLOT_RELPATH,
    run_replay,
    SCRATCH_PREFIX,
    TOUCHING_DIFF,
    UNTOUCHING_DIFF,
)
from torchci.greenlight_replay import (
    preflight as preflight_module,
    sweep as sweep_module,
    sweep_setup as sweep_setup_module,
    workspace as workspace_module,
)
from torchci.greenlight_replay.runner import DEFAULT_MODEL, Outcome


BEDROCK_SWITCH = "CLAUDE_CODE_USE_BEDROCK"
UNMAPPED_PROFILE = "global.anthropic.claude-something-else"
POLICY_SHA = "be63f651c37edd81480004d96d22c4e8341456f1"
TRUSTED_SHA = "0123456789abcdef0123456789abcdef01234567"


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
            self.assertEqual(workspace / "pytorch", worktree)
            for root in workspace_module.workspace_roots():
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
        for repo, checkout in (
            ("pytorch/pytorch", "pytorch"),
            ("pytorch/vision", "target"),
        ):
            with self.subTest(repo=repo), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                roots = workspace_module.workspace_roots(repo)
                self.assertEqual(roots, (checkout, ".claude/skills", ".claude/hooks"))
                with self.assertRaises(workspace_module.WorkspaceLayoutError) as caught:
                    workspace_module.check_workspace(workspace, repo)
                for root in roots:
                    self.assertIn(root, str(caught.exception))
                for root in roots:
                    (workspace / root).mkdir(parents=True)
                workspace_module.check_workspace(workspace, repo)

    def test_another_repos_checkout_does_not_satisfy_this_repos_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            for root in workspace_module.workspace_roots("pytorch/pytorch"):
                (workspace / root).mkdir(parents=True)
            with self.assertRaises(workspace_module.WorkspaceLayoutError) as caught:
                workspace_module.check_workspace(workspace, "pytorch/vision")
            self.assertIn("target", str(caught.exception))


class TestReviewedRepo(unittest.TestCase):
    """``--repo`` decides what is cloned, where the checkout sits and which
    trusted tree the sanitize step restores from and the policy is staged from --
    each as the workflow derives it for that repo. Get one wrong and the reviewer
    reads the wrong tree, or the wrong repo's rules, and still answers."""

    @contextlib.contextmanager
    def replay(self, repo=None, argv=(), **options):
        """Yield the fakes and the workspace while the scratch root still exists."""
        fakes = Fakes([replay_row(194379, repo=repo or "pytorch/pytorch")], **options)
        argv = ["--parallelism", "1", *argv] + (["--repo", repo] if repo else [])
        with run_replay(fakes, argv) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            yield fakes, fakes.workspaces[0]

    def test_pytorch_is_replayed_as_it_always_was(self):
        with self.replay() as (fakes, workspace):
            pool = fakes.pools[0]
            self.assertEqual(pool.repo_url, "https://github.com/pytorch/pytorch.git")
            self.assertEqual(pool.dirname, "pytorch")
            self.assertEqual(pool.bare_clone.name, "pytorch.git")
            ((skills, skills_url, sha),) = fakes.trusted_skills
            self.assertEqual(skills.name, "pytorch-main-trusted")
            self.assertEqual(skills_url, "https://github.com/pytorch/pytorch.git")
            self.assertIsNone(sha)
            self.assertEqual(fakes.repos, ["pytorch/pytorch"])
            self.assertTrue((workspace / REPO_POLICY_SLOT_RELPATH).is_file())
            self.assertTrue((workspace / "pytorch").is_dir())

    def test_another_repo_is_cloned_checked_out_and_reviewed_as_itself(self):
        with self.replay("pytorch/vision") as (fakes, workspace):
            pool = fakes.pools[0]
            self.assertEqual(pool.repo_url, "https://github.com/pytorch/vision.git")
            self.assertEqual(pool.dirname, "target")
            self.assertEqual(pool.bare_clone.name, "vision.git")
            ((skills, skills_url, _),) = fakes.trusted_skills
            self.assertEqual(skills.name, "vision-main-trusted")
            self.assertEqual(skills_url, "https://github.com/pytorch/vision.git")
            self.assertEqual(fakes.repos, ["pytorch/vision"])
            self.assertEqual(pool.acquired[0][0], workspace / "target")
            self.assertTrue((workspace / "target").is_dir())
            self.assertFalse((workspace / "pytorch").exists())

    def test_the_trusted_ref_pins_the_trusted_tree_and_names_its_directory(self):
        argv = ["--trusted-ref", TRUSTED_SHA]
        with self.replay("pytorch/vision", argv) as (fakes, _):
            ((skills, _, sha),) = fakes.trusted_skills
            self.assertEqual(sha, TRUSTED_SHA)
            self.assertEqual(skills.name, f"vision-trusted-{TRUSTED_SHA}")

    def test_a_policy_without_the_staging_script_is_copied_as_it_is(self):
        # A base arm from before the script: its slot keeps whatever the tree holds.
        with self.replay("pytorch/vision") as (fakes, workspace):
            self.assertEqual(fakes.repo_policy_calls(), [])
            slot = workspace / REPO_POLICY_SLOT_RELPATH
            self.assertEqual(slot.read_text(), "policy of pytorch/pytorch\n")
            self.assertEqual(fakes.reviewed, [194379])

    def test_the_staging_script_stages_once_into_what_every_slot_copies(self):
        fakes = Fakes(
            [replay_row(194000 + n, repo="pytorch/vision") for n in range(4)],
            repo_policy_stage="true",
        )
        argv = ["--parallelism", "2", "--repo", "pytorch/vision"]
        with run_replay(fakes, argv) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            calls = fakes.repo_policy_calls()
            stages = [call for call in calls if call.startswith("stage ")]
            self.assertEqual(len(stages), 1)
            _, repo, trusted, claude = stages[0].split(" ")
            self.assertEqual(repo, "pytorch/vision")
            self.assertEqual(Path(trusted), fakes.trusted_skills[0][0])
            self.assertEqual(Path(claude).name, ".claude")
            self.assertFalse(Path(claude).is_relative_to(fakes.materialized[0]))
            self.assertEqual(len([c for c in calls if c.startswith("touches ")]), 4)
            for workspace in set(fakes.workspaces):
                slot = workspace / REPO_POLICY_SLOT_RELPATH
                self.assertEqual(slot.read_text(), "policy of pytorch/vision\n")
            source = fakes.materialized[0] / REPO_POLICY_SLOT_RELPATH
            self.assertEqual(source.read_text(), "policy of pytorch/pytorch\n")
        self.assertEqual(sorted(fakes.reviewed), [194000 + n for n in range(4)])

    def test_no_staged_policy_records_review_error_without_a_model(self):
        fakes = Fakes(
            [replay_row(n, repo="pytorch/vision") for n in (194379, 194772)],
            repo_policy_stage="false",
            touching={194379},
            too_large=True,
        )
        with run_replay(fakes, ["--repo", "pytorch/vision"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
            # staged=false wins over the diff gate, which never runs, and the size gate.
            self.assertEqual(
                [c.split(" ")[0] for c in fakes.repo_policy_calls()], ["stage"]
            )
        self.assertEqual(fakes.reviewed, [])
        self.assertEqual(fakes.pools[0].acquired, [])
        for number in (194379, 194772):
            entry = fakes.checkpoint[number]
            self.assertEqual(entry["new_decision"], "NO_LAND")
            self.assertEqual(entry["new_decision_reason"], "review_error")
            self.assertEqual(entry["new_decision_message"], NO_POLICY_MESSAGE)
        # Not even the diff is fetched for a verdict that needs none of it.
        self.assertEqual(fakes.diffs_fetched, [])
        self.assertEqual(fakes.comment_cutoffs, [])

    def test_a_diff_touching_greenlight_records_not_trivial_without_a_model(self):
        fakes = Fakes(
            [replay_row(n) for n in (194379, 194772)],
            repo_policy_stage="true",
            touching={194379},
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.reviewed, [194772])
        entry = fakes.checkpoint[194379]
        self.assertEqual(entry["new_decision"], "NO_LAND")
        self.assertEqual(entry["new_decision_reason"], "not_trivial")
        self.assertEqual(entry["new_decision_message"], GREENLIGHT_FILES_MESSAGE)
        self.assertEqual(fakes.checkpoint[194772]["new_decision"], "LAND")
        # The touching row's metadata and stack context were never read.
        self.assertEqual(len(fakes.comment_cutoffs), 1)

    def test_the_diff_gate_runs_ahead_of_the_size_gate(self):
        fakes = Fakes(
            [replay_row(194379)],
            repo_policy_stage="true",
            touching={194379},
            too_large=True,
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.reviewed, [])
        self.assertEqual(fakes.checkpoint[194379]["new_decision_reason"], "not_trivial")

    def test_a_context_fault_never_costs_a_canned_verdict(self):
        for stage, touching, reason in (
            ("false", set(), "review_error"),
            ("true", {194379}, "not_trivial"),
        ):
            with self.subTest(reason=reason):
                fakes = Fakes(
                    [replay_row(194379)],
                    repo_policy_stage=stage,
                    touching=touching,
                    context_fails=True,
                )
                with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
                    self.assertEqual(code, cli.EXIT_OK)
                entry = fakes.checkpoint[194379]
                self.assertEqual(entry["new_decision_reason"], reason)

    def test_a_context_fault_still_fails_a_row_the_gates_pass(self):
        fakes = Fakes(
            [replay_row(194379)], repo_policy_stage="true", context_fails=True
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)
        self.assertEqual(fakes.checkpoint, {})

    def test_the_gate_and_the_reviewer_judge_one_diff_snapshot(self):
        # A compare whose answer changes between fetches: the first passes the gate,
        # the second touches .github/greenlight and must never reach the model.
        answers = {194379: [UNTOUCHING_DIFF, TOUCHING_DIFF]}
        fakes = Fakes(
            [replay_row(194379)], repo_policy_stage="true", diff_answers=answers
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.diffs_fetched, [194379])
        self.assertEqual(fakes.reviewed, [194379])
        self.assertEqual(fakes.reviewed_diffs[194379], UNTOUCHING_DIFF)

    def test_each_policy_tree_replays_with_its_own_canned_verdicts(self):
        for messages in (
            (NO_POLICY_MESSAGE, GREENLIGHT_FILES_MESSAGE),
            ("- Review policy\n  - reworded", "- Merge authorization\n  - reworded"),
        ):
            with self.subTest(messages=messages[0]):
                fakes = Fakes(
                    [replay_row(n) for n in (194379, 194772)],
                    repo_policy_stage="true",
                    touching={194379},
                    canned_messages=messages,
                )
                with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
                    self.assertEqual(code, cli.EXIT_OK)
                entry = fakes.checkpoint[194379]
                self.assertEqual(entry["new_decision_message"], messages[1])

    def test_a_repo_the_harness_cannot_replay_stops_before_anything_is_fetched(self):
        for repo in ("facebook/vision", "PyTorch/PyTorch", "pytorch/.."):
            with self.subTest(repo=repo):
                fakes = Fakes([replay_row(194379, repo=repo)])
                with run_replay(fakes, ["--repo", repo]) as (code, _):
                    self.assertEqual(code, cli.EXIT_FAILED)
                self.assertEqual(fakes.materialized, [])
                self.assertEqual(fakes.pools, [])
                self.assertEqual(fakes.reviewed, [])


class TestModelMapping(unittest.TestCase):
    """The policy names a Bedrock inference profile, read verbatim out of the CI
    workflow. Off Bedrock, passed through it turns every run into an API error,
    because the runner asserts modelUsage names the model it asked for; quietly
    replaced by a default it reviews the new policy on the model the new policy
    replaced, and reads as a clean sweep. Neither may happen silently."""

    def setUp(self):
        # A developer whose own shell exports the switch must not flip these cases.
        environ = mock.patch.dict(os.environ, clear=False)
        environ.start()
        self.addCleanup(environ.stop)
        os.environ.pop(BEDROCK_SWITCH, None)

    def test_the_profile_is_mapped_to_the_local_name(self):
        fakes = Fakes([replay_row(194379)])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, [DEFAULT_MODEL])
        self.assertNotEqual(DEFAULT_MODEL, POLICY_MODEL)

    def test_an_unmapped_profile_stops_the_sweep_before_it_spends(self):
        fakes = Fakes(
            [replay_row(n) for n in (194379, 194772)],
            policy_model=UNMAPPED_PROFILE,
        )
        with run_replay(fakes, ["--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_FAILED)
            self.assertFalse(output.exists())
        self.assertEqual(fakes.reviewed, [])

    def test_the_model_flag_overrides_an_unmapped_profile(self):
        fakes = Fakes([replay_row(194379)], policy_model=UNMAPPED_PROFILE)
        with run_replay(
            fakes, ["--parallelism", "1", "--model", "claude-sonnet-5"]
        ) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, ["claude-sonnet-5"])

    def test_local_model_names_what_it_knows(self):
        with self.assertRaises(ValueError) as caught:
            sweep_setup_module.local_model("nope")
        self.assertIn(POLICY_MODEL, str(caught.exception))
        self.assertIn("--model", str(caught.exception))

    def test_a_switch_value_that_is_not_on_still_maps_and_refuses(self):
        for switch in ("", "0", "false", "yes"):
            with self.subTest(switch=switch):
                with mock.patch.dict(os.environ, {BEDROCK_SWITCH: switch}, clear=False):
                    self.assertEqual(
                        sweep_setup_module.local_model(POLICY_MODEL), DEFAULT_MODEL
                    )
                    with self.assertRaises(ValueError):
                        sweep_setup_module.local_model(UNMAPPED_PROFILE)


class TestBedrockModel(unittest.TestCase):
    """On Claude Code's Bedrock provider the policy's inference profile is itself
    the model id the CLI takes, so it passes through unmapped, an unknown one
    included. --model still overrides it, as it does off Bedrock.

    run_replay hides the switch from the environment, so the cases that go
    through it turn Bedrock on at the predicate sweep reads instead."""

    def test_the_profile_passes_through_verbatim(self):
        with mock.patch.dict(os.environ, {BEDROCK_SWITCH: "1"}, clear=False):
            for profile in (POLICY_MODEL, UNMAPPED_PROFILE):
                with self.subTest(profile=profile):
                    self.assertEqual(sweep_setup_module.local_model(profile), profile)

    def test_the_reviewer_is_asked_for_the_profile(self):
        fakes = Fakes([replay_row(194379)], policy_model=UNMAPPED_PROFILE)
        with mock.patch.object(
            sweep_setup_module, "bedrock_enabled", return_value=True
        ):
            with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
                self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, [UNMAPPED_PROFILE])

    def test_the_model_flag_still_overrides_the_profile(self):
        fakes = Fakes([replay_row(194379)])
        argv = ["--parallelism", "1", "--model", "claude-sonnet-5"]
        with mock.patch.object(
            sweep_setup_module, "bedrock_enabled", return_value=True
        ):
            with run_replay(fakes, argv) as (code, _):
                self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(fakes.models, ["claude-sonnet-5"])


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
        # Names the refspec policy.refspec resolved, which is what proves the
        # check asked the remote about the ref the real fetch will use.
        self.assertIn("refs/pull/8830/head", str(caught.exception))
        self.assertIn("pytorch/test-infra", str(caught.exception))

    def test_a_full_commit_sha_is_left_to_the_policy_fetch(self):
        # ls-remote matches ref names only and exits 2 on any SHA, so asking it
        # would refuse every policy pinned by commit.
        with mock.patch.object(preflight_module.subprocess, "run") as run:
            preflight_module.check_policy_ref(POLICY_SHA)
        run.assert_not_called()

    def test_anything_short_of_a_full_lowercase_sha_still_asks_ls_remote(self):
        cases = {
            POLICY_SHA.upper(): POLICY_SHA.upper(),
            POLICY_SHA[:39]: POLICY_SHA[:39],
            "8830": "refs/pull/8830/head",
            "main": "main",
        }
        url = "https://github.com/pytorch/test-infra.git"
        for ref, wanted in cases.items():
            with self.subTest(ref=ref):
                found = SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
                with mock.patch.object(
                    preflight_module.subprocess, "run", return_value=found
                ) as run:
                    preflight_module.check_policy_ref(ref)
                run.assert_called_once()
                self.assertEqual(
                    run.call_args.args[0],
                    ["git", "ls-remote", "--exit-code", url, wanted],
                )
                missing = SimpleNamespace(returncode=2, stdout=b"", stderr=b"")
                with mock.patch.object(
                    preflight_module.subprocess, "run", return_value=missing
                ):
                    with self.assertRaises(ValueError) as caught:
                        preflight_module.check_policy_ref(ref)
                self.assertIn(wanted, str(caught.exception))

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
                sweep_setup_module.check_schema(SimpleNamespace(schema_path=schema))
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
