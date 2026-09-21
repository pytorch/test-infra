"""Tests for the decision export's command-line entry point.

Every case drives ``main()`` or one of its helpers with the ClickHouse and
GitHub reaches patched out, so nothing here touches either service.
"""

import csv
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import torchci.greenlight_decisions.__main__ as cli
from decision_fixtures import DECIDED, UNDECIDED
from torchci.greenlight_decisions.loc import LOC_STATUS_OK
from torchci.greenlight_decisions.rows import SNAPSHOT_COLUMN, STALENESS_NO_VERDICT


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
