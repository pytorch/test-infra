"""Tests for the decision export's command-line entry point.

Every case drives ``main()`` or one of its helpers with the ClickHouse and
GitHub reaches patched out, so nothing here touches either service.
"""

import contextlib
import csv
import io
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import torchci.greenlight_decisions.__main__ as cli
from decision_fixtures import DECIDED, MEASURED, UNDECIDED
from torchci.greenlight_decisions.loc import LOC_STATUS_OK
from torchci.greenlight_decisions.rows import SNAPSHOT_COLUMN, STALENESS_NO_VERDICT
from torchci.greenlight_decisions.sample import sample_decisions


class TestParseAsOf(unittest.TestCase):
    def test_z_suffix(self):
        self.assertEqual(
            cli.parse_as_of("2026-09-03T12:00:00Z"), datetime(2026, 9, 3, 12, 0)
        )

    def test_offset_is_converted_to_utc(self):
        self.assertEqual(
            cli.parse_as_of("2026-09-03T05:00:00-07:00"), datetime(2026, 9, 3, 12, 0)
        )

    def test_naive_is_kept(self):
        self.assertEqual(
            cli.parse_as_of("2026-09-03 12:00:00"), datetime(2026, 9, 3, 12, 0)
        )

    def test_garbage_is_rejected(self):
        with self.assertRaises(Exception):
            cli.parse_as_of("last tuesday")


class TestSampleFlags(unittest.TestCase):
    """A bad sampling flag stops the export at argparse, naming the flag and the rule;
    --help says when --seed applies."""

    def parse(self, *argv):
        return cli.build_parser().parse_args(list(argv))

    def rejection(self, *argv):
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as caught:
            with contextlib.redirect_stderr(stderr):
                self.parse(*argv)
        self.assertEqual(caught.exception.code, 2)
        return stderr.getvalue()

    def test_the_flags_parse(self):
        args = self.parse("--sample-frac", "0.2", "--sample-cap", "1000", "--seed", "7")
        self.assertEqual((args.sample_frac, args.sample_cap, args.seed), (0.2, 1000, 7))

    def test_the_bounds_are_accepted(self):
        args = self.parse("--sample-frac", "1", "--sample-cap", "1", "--seed", "-3")
        self.assertEqual((args.sample_frac, args.sample_cap, args.seed), (1.0, 1, -3))

    def test_a_frac_outside_the_unit_interval_is_rejected(self):
        for bad in ("0", "-0.1", "1.5", "nan", "inf"):
            with self.subTest(frac=bad):
                message = self.rejection("--sample-frac", bad)
                self.assertIn("argument --sample-frac: must be in (0, 1]", message)

    def test_a_frac_that_is_not_a_number_is_rejected(self):
        for bad in ("abc", "", "20%"):
            with self.subTest(frac=bad):
                message = self.rejection("--sample-frac", bad)
                self.assertIn(
                    f"argument --sample-frac: invalid fraction value: {bad!r}", message
                )

    def test_a_cap_below_one_is_rejected(self):
        for bad in ("0", "-1"):
            with self.subTest(cap=bad):
                message = self.rejection("--sample-cap", bad)
                self.assertIn("argument --sample-cap: must be at least 1", message)

    def test_a_cap_that_is_not_an_integer_is_rejected(self):
        for bad in ("1.5", "abc", "1e3"):
            with self.subTest(cap=bad):
                message = self.rejection("--sample-cap", bad)
                self.assertIn(
                    f"argument --sample-cap: invalid positive_int value: {bad!r}",
                    message,
                )

    def test_a_seed_that_is_not_an_integer_is_rejected(self):
        self.assertIn("argument --seed", self.rejection("--seed", "x"))

    def test_the_seed_help_says_it_needs_a_sampling_flag(self):
        # argparse wraps at the terminal's width and may break a flag at its hyphen.
        with mock.patch.dict("os.environ", {"COLUMNS": "1000"}):
            text = cli.build_parser().format_help()
        self.assertIn("used only with --sample-frac or --sample-cap", text)


SUBPROCESS_TIMEOUT_SECONDS = 60

BLOCK_DRIVER_AND_IMPORT = """
import sys


class BlockClickHouseDriver:
    def find_spec(self, name, path=None, target=None):
        if name == "clickhouse_connect" or name.startswith("clickhouse_connect."):
            raise ModuleNotFoundError(f"blocked: {name}")
        return None


sys.meta_path.insert(0, BlockClickHouseDriver())

import torchci.greenlight_decisions.__main__ as cli

assert cli.build_parser().parse_args([]).repo == "pytorch/pytorch"
print("imported without the driver")
"""


class TestDriverImportIsDeferred(unittest.TestCase):
    """connect() imports the ClickHouse driver lazily so that importing this
    module -- to inspect the parser or exercise row assembly -- does not need
    clickhouse_connect installed. A module-level import would undo that
    silently, since CI always has the driver."""

    def test_importing_the_cli_does_not_need_clickhouse_connect(self):
        result = subprocess.run(
            [sys.executable, "-c", BLOCK_DRIVER_AND_IMPORT],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("imported without the driver", result.stdout)


class TestCliWiring(unittest.TestCase):
    def test_defaults(self):
        args = cli.build_parser().parse_args([])
        self.assertEqual(args.repo, "pytorch/pytorch")
        self.assertIsNone(args.as_of)
        self.assertIsNone(args.output)
        self.assertFalse(args.skip_loc)
        self.assertIsNone(args.sample_frac)
        self.assertIsNone(args.sample_cap)
        self.assertEqual(args.seed, 0)

    def test_default_output_path_carries_the_as_of(self):
        self.assertEqual(
            cli.default_output_path(datetime(2026, 9, 3, 12, 0)),
            "greenlight_decisions_20260903T120000Z.csv",
        )

    def test_missing_shas_skip_the_github_call(self):
        with mock.patch.object(cli, "compute_loc", side_effect=_unreachable) as patched:
            cells = cli.measure_loc("pytorch/pytorch", {**DECIDED, "base_sha": ""})
        self.assertEqual(cells["loc_status"], cli.LOC_STATUS_MISSING_SHA)
        patched.assert_not_called()

    def test_a_failing_lookup_becomes_a_cell_not_an_exception(self):
        failure = RuntimeError("gh api 502\nBad Gateway")
        with mock.patch.object(cli, "compute_loc", side_effect=failure):
            cells = cli.measure_loc("pytorch/pytorch", DECIDED)
        self.assertTrue(cells["loc_status"].startswith("error: RuntimeError:"))
        self.assertNotIn("\n", cells["loc_status"])
        self.assertEqual(cells["loc"], "")

    def test_an_endless_error_message_is_capped(self):
        failure = RuntimeError("x" * 5000)
        with mock.patch.object(cli, "compute_loc", side_effect=failure):
            cells = cli.measure_loc("pytorch/pytorch", DECIDED)
        self.assertEqual(len(cells["loc_status"]), cli.MAX_LOC_STATUS_CHARS)

    def test_skip_loc_makes_no_github_calls(self):
        with mock.patch.object(cli, "compute_loc", side_effect=_unreachable):
            rows = cli.collect_rows(
                "pytorch/pytorch", [DECIDED, UNDECIDED], "s", skip_loc=True
            )
        self.assertEqual(rows[0]["verdict_staleness"], "")
        self.assertEqual(rows[1]["verdict_staleness"], STALENESS_NO_VERDICT)

    def test_undecided_prs_are_never_measured(self):
        with mock.patch.object(cli, "compute_loc", side_effect=_unreachable):
            rows = cli.collect_rows("pytorch/pytorch", [UNDECIDED], "s", skip_loc=False)
        self.assertEqual(rows[0]["verdict_staleness"], STALENESS_NO_VERDICT)


class TestMainExitCodes(unittest.TestCase):
    """A bad PR must not abort the export, but a bad run must not look like a good one."""

    def _run(self, argv, decisions=None, error=None):
        with mock.patch.object(cli, "connect"), mock.patch.object(
            cli, "fetch_decisions", side_effect=error, return_value=decisions
        ), mock.patch.object(cli, "compute_loc", side_effect=_unreachable):
            return cli.main(argv)

    def test_a_successful_export_returns_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            code = self._run(
                ["--skip-loc", "--output", str(path)], decisions=[DECIDED, UNDECIDED]
            )
            self.assertEqual(code, 0)
            self.assertTrue(path.exists())

    def test_a_clickhouse_failure_returns_one(self):
        code = self._run(["--skip-loc"], error=RuntimeError("connection refused"))
        self.assertEqual(code, 1)

    def test_an_empty_result_returns_one(self):
        self.assertEqual(self._run(["--skip-loc"], decisions=[]), 1)

    def test_an_unwritable_output_returns_one(self):
        code = self._run(
            ["--skip-loc", "--output", "/nonexistent-directory/out.csv"],
            decisions=[DECIDED],
        )
        self.assertEqual(code, 1)


class TestMainWritesTheFile(unittest.TestCase):
    """End-to-end through main(): the bytes on disk, not just the return code."""

    def _export(self, decisions, argv=()):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            with mock.patch.object(cli, "connect"), mock.patch.object(
                cli, "fetch_decisions", return_value=decisions
            ), mock.patch.object(cli, "compute_loc", side_effect=_unreachable):
                code = cli.main(["--skip-loc", "--output", str(path), *argv])
            text = path.read_bytes().decode("utf-8-sig")
        self.assertEqual(code, 0)
        return list(csv.DictReader(text.splitlines()))

    def test_a_bullet_message_reaches_the_file_escaped(self):
        # decision_message is LLM prose that really does open with a "-", so the
        # injection guard has to survive the whole write path, not just csv_safe.
        rows = self._export([{**DECIDED, "decision_message": "- Only tests changed."}])
        self.assertEqual(rows[0]["decision_message"], "'- Only tests changed.")

    def test_rows_keep_the_order_fetch_decisions_returned(self):
        decisions = [{**DECIDED, "pr_number": n} for n in (194379, 194772, 194773)]
        rows = self._export(decisions)
        self.assertEqual(
            [row["pr_number"] for row in rows], ["194379", "194772", "194773"]
        )

    def test_reverted_reads_as_a_boolean_beside_its_land(self):
        rows = self._export(
            [
                {**DECIDED, "pr_number": 194379, "decision": "LAND", "reverted": True},
                {**DECIDED, "pr_number": 195000, "decision": "LAND", "reverted": False},
            ]
        )
        self.assertEqual(rows[0]["reverted"], "true")
        self.assertEqual(rows[0]["decision"], "LAND")
        self.assertEqual(rows[1]["reverted"], "false")

    def test_as_of_reaches_the_snapshot_column(self):
        rows = self._export([DECIDED], argv=["--as-of", "2026-08-20T11:30:00Z"])
        self.assertEqual(rows[0][SNAPSHOT_COLUMN], "2026-08-20T11:30:00Z")

    def test_a_bad_as_of_exits_rather_than_returning_a_code(self):
        # argparse turns the ArgumentTypeError into exit 2, so a caller checking
        # only the return value never sees it.
        with self.assertRaises(SystemExit):
            cli.main(["--as-of", "last tuesday"])


class TestMainSamples(unittest.TestCase):
    """The sample is drawn before the GitHub reads, so a pull request it leaves out
    costs no compare call, and without a sampling flag nothing changes."""

    DECISIONS = [
        {**DECIDED, "pr_number": n, "decision_head_sha": f"{n:040d}"}
        for n in range(20, 0, -1)
    ]

    def _export(self, argv):
        measured = []

        def record(repo, base_sha, head_sha, final_head_sha):
            measured.append(head_sha)
            return MEASURED

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            with mock.patch.object(cli, "connect"), mock.patch.object(
                cli, "fetch_decisions", return_value=self.DECISIONS
            ), mock.patch.object(cli, "compute_loc", side_effect=record):
                with self.assertLogs(cli.logger, level="INFO") as logs:
                    code = cli.main(["--output", str(path), *argv])
            text = path.read_bytes().decode("utf-8-sig")
        self.assertEqual(code, cli.EXIT_OK)
        return list(csv.DictReader(text.splitlines())), measured, logs.output

    def test_only_the_sampled_pull_requests_are_measured_and_written(self):
        cases = (
            (["--sample-cap", "5"], dict(frac=None, cap=5, seed=0), 5),
            (
                ["--sample-frac", "0.3", "--seed", "9"],
                dict(frac=0.3, cap=None, seed=9),
                6,
            ),
            (
                ["--sample-frac", "0.5", "--sample-cap", "4", "--seed", "2"],
                dict(frac=0.5, cap=4, seed=2),
                4,
            ),
        )
        for argv, sample, size in cases:
            with self.subTest(argv=argv):
                rows, measured, _ = self._export(argv)
                expected = sample_decisions(self.DECISIONS, **sample)
                self.assertEqual(len(rows), size)
                self.assertEqual(
                    [row["pr_number"] for row in rows],
                    [str(d["pr_number"]) for d in expected],
                )
                self.assertEqual(measured, [d["decision_head_sha"] for d in expected])

    def test_the_sample_is_logged_with_its_parameters(self):
        _, _, logs = self._export(["--sample-frac", "0.3", "--sample-cap", "4"])
        self.assertIn(
            "sampled 4 of 20 decisions (frac=0.3, cap=4, seed=0)", "".join(logs)
        )

    def test_without_a_sampling_flag_every_decision_is_measured(self):
        rows, measured, logs = self._export(["--seed", "9"])
        self.assertEqual(len(rows), len(self.DECISIONS))
        self.assertEqual(measured, [d["decision_head_sha"] for d in self.DECISIONS])
        self.assertNotIn("sampled", "".join(logs))


class TestTotalGitHubFailure(unittest.TestCase):
    """GitHub being unreachable degrades every row at once. The file still gets
    written -- the ClickHouse half is real -- but a run where no LOC measurement
    succeeded must not look like a clean export, and must not assert that every
    PR drifted from its verdict."""

    def _export_with_github_down(self, decisions):
        failure = RuntimeError("gh api: could not resolve host")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            with mock.patch.object(cli, "connect"), mock.patch.object(
                cli, "fetch_decisions", return_value=decisions
            ), mock.patch.object(cli, "compute_loc", side_effect=failure):
                code = cli.main(["--output", str(path)])
            text = path.read_bytes().decode("utf-8-sig")
        return code, list(csv.DictReader(text.splitlines()))

    def test_exit_status_is_degraded_not_ok(self):
        code, _ = self._export_with_github_down([DECIDED, {**DECIDED, "pr_number": 2}])
        self.assertEqual(code, cli.EXIT_DEGRADED)
        self.assertNotEqual(code, cli.EXIT_OK)

    def test_no_row_claims_the_verdict_drifted(self):
        # "content-changed" is a finding. Emitting it for every row because the
        # comparison never ran would manufacture an audit list out of an outage.
        _, rows = self._export_with_github_down([DECIDED, {**DECIDED, "pr_number": 2}])
        self.assertEqual(len(rows), 2)
        for row in rows:
            with self.subTest(pr=row["pr_number"]):
                self.assertNotEqual(row["verdict_staleness"], "content-changed")
                self.assertNotEqual(row["verdict_staleness"], "exact")
                self.assertEqual(row["loc"], "")

    def test_every_row_carries_the_reason(self):
        _, rows = self._export_with_github_down([DECIDED])
        self.assertIn("could not resolve host", rows[0]["loc_status"])

    def test_one_bad_pr_among_many_is_still_a_clean_run(self):
        # The ratio guard exists so a single unmeasurable PR does not fail the
        # export; only a wholesale failure does.
        decisions = [{**DECIDED, "pr_number": n} for n in range(1, 5)]
        calls = {"n": 0}

        def one_failure(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("gh api 502")
            return {
                "loc": 10,
                "sig_loc": 8,
                "verdict_staleness": "exact",
                "files_changed_after_verdict": 0,
                "loc_status": LOC_STATUS_OK,
            }

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.csv"
            with mock.patch.object(cli, "connect"), mock.patch.object(
                cli, "fetch_decisions", return_value=decisions
            ), mock.patch.object(cli, "compute_loc", side_effect=one_failure):
                code = cli.main(["--output", str(path)])
        self.assertEqual(code, cli.EXIT_OK)


def _unreachable(*args, **kwargs):
    raise AssertionError("compute_loc should not have been called")


if __name__ == "__main__":
    unittest.main()
