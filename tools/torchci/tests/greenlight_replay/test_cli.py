"""Tests for the replay sweep's command-line entry point.

What a run is asked to do and what it reports afterwards: the flags, which pull
requests are selected, what the exit status says, and what reaches the file.
The machinery each pull request goes through is tested in ``test_sweep``.

Every seam that reaches outside the process is patched by ``replay_fixtures``;
nothing here invokes a model or opens a connection.
"""

import argparse
import contextlib
import io
import logging
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import torchci.greenlight_replay.__main__ as cli
from replay_fixtures import Fakes, read_csv, replay_row, run_replay
from torchci.greenlight_replay import (
    options,
    preflight as preflight_module,
    sweep as sweep_module,
)


SUBPROCESS_TIMEOUT_SECONDS = 60


def setUpModule():
    # main() calls logging.basicConfig, which attaches a root handler for the
    # rest of the session; one sweep logs a dozen lines per case.
    logging.disable(logging.CRITICAL)


def tearDownModule():
    logging.disable(logging.NOTSET)


class TestArgumentParsing(unittest.TestCase):
    """The flags a sweep is steered by, and the two either-or rules on them."""

    def parse(self, argv):
        return options.build_parser().parse_args(argv)

    def rejected(self, argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            self.parse(argv)
        return stderr.getvalue()

    def test_defaults(self):
        args = self.parse(
            ["--input", "c.csv", "--policy-pr", "8830", "--sample-n", "5"]
        )
        self.assertEqual(args.policy_pr, 8830)
        self.assertIsNone(args.policy_ref)
        self.assertEqual(args.sample_n, 5)
        self.assertIsNone(args.sample_frac)
        self.assertEqual(args.seed, options.DEFAULT_SEED)
        self.assertEqual(args.parallelism, options.DEFAULT_PARALLELISM)
        self.assertEqual(args.timeout_minutes, options.DEFAULT_TIMEOUT_MINUTES)
        self.assertEqual(args.workdir, options.DEFAULT_WORKDIR)
        self.assertEqual(args.repo, "pytorch/pytorch")
        self.assertIsNone(args.model)
        self.assertIsNone(args.output)
        self.assertFalse(args.resume)
        self.assertFalse(args.dry_run)

    def test_input_is_required(self):
        self.assertIn("--input", self.rejected(["--policy-pr", "1", "--sample-n", "1"]))

    def test_a_policy_must_be_named(self):
        message = self.rejected(["--input", "c.csv", "--sample-n", "1"])
        self.assertIn(
            "one of the arguments --policy-pr --policy-ref is required", message
        )

    def test_two_policies_are_refused(self):
        message = self.rejected(
            [
                "--input",
                "c.csv",
                "--sample-n",
                "1",
                "--policy-pr",
                "1",
                "--policy-ref",
                "main",
            ]
        )
        self.assertIn("not allowed with argument", message)
        self.assertIn("--policy-pr", message)

    def test_a_sample_size_must_be_named(self):
        message = self.rejected(["--input", "c.csv", "--policy-pr", "1"])
        self.assertIn(
            "one of the arguments --sample-frac --sample-n is required", message
        )

    def test_two_sample_sizes_are_refused(self):
        message = self.rejected(
            [
                "--input",
                "c.csv",
                "--policy-pr",
                "1",
                "--sample-frac",
                "0.1",
                "--sample-n",
                "5",
            ]
        )
        self.assertIn("not allowed with argument", message)
        self.assertIn("--sample-frac", message)

    def test_a_fraction_outside_the_unit_interval_is_refused(self):
        message = self.rejected(
            ["--input", "c.csv", "--policy-pr", "1", "--sample-frac", "1.5"]
        )
        self.assertIn("--sample-frac", message)

    def test_fraction_bounds(self):
        self.assertEqual(options.fraction("1.0"), 1.0)
        for bad in ("0", "-0.2", "1.01", "banana"):
            with self.subTest(value=bad), self.assertRaises(
                (argparse.ArgumentTypeError, ValueError)
            ):
                options.fraction(bad)

    def test_parallelism_must_be_at_least_one(self):
        self.assertEqual(options.positive_int("1"), 1)
        with self.assertRaises(argparse.ArgumentTypeError):
            options.positive_int("0")

    def test_the_default_output_names_the_run(self):
        self.assertEqual(
            cli.default_output_path(datetime(2026, 9, 18, 12, 0)),
            "greenlight_replay_20260918T120000Z.csv",
        )

    def test_the_default_workdir_is_inside_the_read_sandboxs_scratch_prefix(self):
        # The sandbox admits scratch paths by string prefix -- realpath('/tmp') +
        # '/greenlight-'. A default outside it denies every read of the diff and
        # the metadata, and the reviewer answers about a pull request it never saw.
        runs = Path(options.DEFAULT_WORKDIR) / "pr-1" / sweep_module.RUNS_DIRNAME
        self.assertIsNone(
            preflight_module.remap.run_dir_violation(str(runs.resolve())),
            f"{options.DEFAULT_WORKDIR} is outside the read sandbox's scratch prefix",
        )


class TestDryRun(unittest.TestCase):
    """A sweep costs about $1.33 a pull request, so --dry-run has to be free.

    It resolves the frame and the sample -- that is the point of it -- but must
    not materialize a policy, clone anything, or invoke a model."""

    def test_no_model_is_invoked_and_no_output_is_written(self):
        fakes = Fakes([replay_row(n) for n in (194379, 194772, 194773)])
        with run_replay(fakes, ["--dry-run"]) as (code, output):
            self.assertEqual(code, cli.EXIT_OK)
            self.assertFalse(output.exists())
        self.assertEqual(fakes.reviewed, [])
        self.assertEqual(fakes.written, [])
        # The policy is cheap and is fetched; the pytorch clone is not.
        self.assertEqual(len(fakes.materialized), 1)
        self.assertEqual(fakes.pools, [])

    def test_a_schema_the_validator_cannot_read_fails_the_dry_run(self):
        # The shape that priced a clean plan and then aborted the real run: a
        # policy PR whose verdict-schema.json uses a keyword the harness has not
        # implemented. The cheapest check has to catch the likeliest fault.
        fakes = Fakes(
            [replay_row(194379)], policy_schema='{"type": "object", "maxLength": 3}'
        )
        with run_replay(fakes, ["--dry-run"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)

    def test_an_unrunnable_hook_fails_the_dry_run(self):
        fakes = Fakes([replay_row(194379)], hooks_missing=True)
        with run_replay(fakes, ["--dry-run"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)

    def test_an_unmapped_model_profile_fails_the_dry_run(self):
        fakes = Fakes([replay_row(194379)], policy_model="global.anthropic.nope")
        with run_replay(fakes, ["--dry-run"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)

    def test_an_empty_frame_is_a_failure_not_an_empty_sweep(self):
        with run_replay(Fakes([]), ["--dry-run"]) as (code, _):
            self.assertEqual(code, cli.EXIT_FAILED)


class TestSizeGateAfterRederivation(unittest.TestCase):
    """apply_frame settles the size gate only for rows whose verdict is final.
    A multi-landing row reaches its canned decline only once re-derived, and
    replaying one would spend a review measuring the diff cap rather than the
    policy -- which is the whole reason declines are excluded."""

    def test_a_decline_found_after_rederivation_is_dropped(self):
        fakes = Fakes([replay_row(n) for n in (194379, 194772)], decline_after=194379)
        with run_replay(fakes, ["--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_OK)
            rows = read_csv(output)
        self.assertEqual(fakes.reviewed, [194772])
        self.assertEqual([row["pr_number"] for row in rows], ["194772"])


class TestDegradedExit(unittest.TestCase):
    """One awkward pull request degrades one row; the gateway being down degrades
    every row while the file still looks like a replay. Only the second case may
    look different from a clean sweep in the exit status."""

    def _sweep(self, failures, total=4):
        numbers = [194000 + n for n in range(total)]
        fakes = Fakes(
            [replay_row(n) for n in numbers],
            statuses=dict.fromkeys(numbers[:failures], ""),
        )
        with run_replay(fakes, ["--parallelism", "2"]) as (code, output):
            return code, read_csv(output)

    def test_one_failure_in_four_is_still_a_clean_sweep(self):
        self.assertEqual(self._sweep(failures=1)[0], cli.EXIT_OK)

    def test_exactly_half_failing_is_not_degraded(self):
        self.assertEqual(self._sweep(failures=2)[0], cli.EXIT_OK)

    def test_more_than_half_failing_is_degraded(self):
        code, rows = self._sweep(failures=3)
        self.assertEqual(code, cli.EXIT_DEGRADED)
        self.assertNotEqual(code, cli.EXIT_OK)
        self.assertEqual(len(rows), 4)

    def test_a_spoiled_row_still_reaches_the_file(self):
        # The row is evidence of what the harness did; dropping it would hide a
        # sampled pull request that was paid for and produced nothing.
        _, rows = self._sweep(failures=1)
        blank = [row for row in rows if not row["new_decision"]]
        self.assertEqual(len(blank), 1)
        self.assertTrue(
            blank[0]["new_decision_reason"].startswith(cli.HARNESS_REASON_PREFIX)
        )

    def test_the_run_metrics_do_not_reach_the_file(self):
        # The checkpoint carries cost_usd beside the cells so a resumed sweep can
        # total what it spent. Only the four new columns belong in the export.
        _, rows = self._sweep(failures=0)
        self.assertNotIn("cost_usd", rows[0])
        self.assertIn("new_decision", rows[0])


class TestResume(unittest.TestCase):
    """A sweep is hours long and costs real money, so a second attempt must not
    pay again for the pull requests the first one already judged."""

    def test_checkpointed_pull_requests_are_not_re_reviewed(self):
        numbers = [194379, 194772, 194773]
        fakes = Fakes([replay_row(n) for n in numbers])
        fakes.checkpoint[194379] = {
            "new_decision": "NO_LAND",
            "new_decision_reason": "risky",
            "new_decision_summary": "",
            "new_decision_message": "",
            "cost_usd": 0.9,
            "repo": "pytorch/pytorch",
            "base_ref": "main",
            "decision_head_sha": f"{194379:040d}",
        }
        with run_replay(fakes, ["--resume", "--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_OK)
            rows = read_csv(output)
        self.assertEqual(fakes.reviewed, [194772, 194773])
        self.assertEqual([row["pr_number"] for row in rows], [str(n) for n in numbers])
        self.assertEqual(rows[0]["new_decision"], "NO_LAND")

    def test_an_entry_recorded_against_another_head_is_re_reviewed(self):
        # Re-export the corpus between a crash and a resume and the same number
        # can carry a newer verdict against a different head. Reusing those cells
        # would print a verdict beside a decision it was never computed against.
        fakes = Fakes([replay_row(194379)])
        fakes.checkpoint[194379] = {
            "new_decision": "NO_LAND",
            "new_decision_reason": "risky",
            "new_decision_summary": "",
            "new_decision_message": "",
            "repo": "pytorch/pytorch",
            "base_ref": "main",
            "decision_head_sha": "b" * 40,
        }
        with run_replay(fakes, ["--resume", "--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_OK)
            rows = read_csv(output)
        self.assertEqual(fakes.reviewed, [194379])
        self.assertEqual(rows[0]["new_decision"], "LAND")

    def test_a_spoiled_row_is_retried_rather_than_skipped(self):
        # An outage is the usual reason to resume. Skipping by number alone would
        # re-emit the same degraded CSV and re-run nothing.
        fakes = Fakes([replay_row(194379)])
        fakes.checkpoint[194379] = {
            "new_decision": "",
            "new_decision_reason": "harness:timeout",
            "new_decision_summary": "",
            "new_decision_message": "",
            "repo": "pytorch/pytorch",
            "base_ref": "main",
            "decision_head_sha": f"{194379:040d}",
        }
        with run_replay(fakes, ["--resume", "--parallelism", "1"]) as (code, output):
            self.assertEqual(code, cli.EXIT_OK)
            rows = read_csv(output)
        self.assertEqual(fakes.reviewed, [194379])
        self.assertEqual(rows[0]["new_decision"], "LAND")

    def test_without_resume_every_sampled_pull_request_runs(self):
        numbers = [194379, 194772]
        fakes = Fakes([replay_row(n) for n in numbers])
        with run_replay(fakes, ["--parallelism", "1"]) as (code, _):
            self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(sorted(fakes.reviewed), numbers)

    def test_a_previous_checkpoint_is_moved_aside_rather_than_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / cli.CHECKPOINT_FILENAME
            path.write_text('{"pr_number": 1}\n', encoding="utf-8")
            cli._rotate_checkpoint(path)
            self.assertFalse(path.exists())
            rotated = list(Path(directory).glob(f"{cli.CHECKPOINT_FILENAME}.*"))
            self.assertEqual(len(rotated), 1)
            self.assertIn("pr_number", rotated[0].read_text(encoding="utf-8"))


BLOCK_DRIVER_AND_IMPORT = """
import sys


class BlockClickHouseDriver:
    def find_spec(self, name, path=None, target=None):
        if name == "clickhouse_connect" or name.startswith("clickhouse_connect."):
            raise ModuleNotFoundError(f"blocked: {name}")
        return None


sys.meta_path.insert(0, BlockClickHouseDriver())

import torchci.greenlight_replay.__main__ as cli

assert cli.build_parser().prog == "greenlight_replay"
print("imported without the driver")
"""


class TestDriverImportIsDeferred(unittest.TestCase):
    """connect() imports the ClickHouse driver lazily so that importing this
    module -- to inspect the parser or exercise the orchestration -- does not
    need clickhouse_connect installed. A module-level import anywhere in the
    package would undo that silently, since CI always has the driver."""

    def test_importing_the_cli_does_not_need_clickhouse_connect(self):
        result = subprocess.run(
            [sys.executable, "-c", BLOCK_DRIVER_AND_IMPORT],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("imported without the driver", result.stdout)


if __name__ == "__main__":
    unittest.main()
