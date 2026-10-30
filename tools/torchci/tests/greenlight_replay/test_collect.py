"""Tests for collect, which draws the sample and records GitHub's answers once for CI.

``collect.main`` runs over ``replay_fixtures``' framing stand-ins and a recording
``build_inputs``: no ClickHouse connection is opened, no policy fetched, no gh run.
``TestPresampledSweep`` is the other half of the handshake: the harness replays the
sample collect wrote, as written.
"""

import contextlib
import io
import logging
import tempfile
import threading
import unittest
from operator import attrgetter
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import torchci.greenlight_replay.__main__ as cli
from replay_fixtures import Fakes, read_csv, replay_row, run_replay
from torchci.greenlight_decisions.__main__ import parse_as_of
from torchci.greenlight_decisions.rows import COLUMNS
from torchci.greenlight_replay import collect, gh_answers, sweep as sweep_module
from torchci.greenlight_replay.cells import load_rows


POLICY_SHA = "c" * 40

FRAMING_SEAMS = (
    "connect",
    "fetch_landings",
    "fetch_first_verdicts",
    "apply_frame",
    "rederive_first_landing",
    "sample_rows",
)


def setUpModule():
    # Both mains call logging.basicConfig, and the failure cases log tracebacks.
    logging.disable(logging.CRITICAL)


def tearDownModule():
    logging.disable(logging.NOTSET)


def full_row(pr_number, **extra):
    """A sampled row holding every export column, as collect's --output writes it."""
    return {**dict.fromkeys(COLUMNS, ""), **replay_row(pr_number, **extra)}


class FakeInputs:
    """Collect's policy and inputs seams, recording what each call was handed."""

    def __init__(self, failing=()):
        self.failing = set(failing)
        self.policies = []
        self.calls = []
        self.lock = threading.Lock()

    def materialize_policy(self, ref, workdir):
        policy = SimpleNamespace(ref=ref, root=Path(workdir))
        self.policies.append(policy)
        return policy

    def build_inputs(self, repo, pr, base_ref, head_sha, comments_before, run_dir, pol):
        with self.lock:
            self.calls.append(
                SimpleNamespace(
                    repo=repo,
                    pr=pr,
                    base_ref=base_ref,
                    head_sha=head_sha,
                    comments_before=comments_before,
                    run_dir=run_dir,
                    policy=pol,
                    recording=gh_answers._recording,
                )
            )
        if pr in self.failing:
            raise RuntimeError("gh api compare exited 1: HTTP 502")


def built(inputs):
    return sorted(call.pr for call in inputs.calls)


class CollectTestCase(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.sample = self.root / "sample.csv"
        self.answers = self.root / "answers"
        self.workdir = self.root / "work"

    def collect(self, fakes, inputs, *argv, **seams):
        """Run ``collect.main``; ``seams`` replace more of collect after the fakes.

        ``argv`` comes last, so an ``--input`` there wins over the placeholder.
        """
        with contextlib.ExitStack() as stack:
            fakes.install(stack, self.root)
            stack.enter_context(mock.patch.object(gh_answers, "_recording", None))
            stack.enter_context(
                mock.patch.object(sweep_module, "build_inputs", inputs.build_inputs)
            )
            seams = {"materialize_policy": inputs.materialize_policy, **seams}
            for name, replacement in seams.items():
                stack.enter_context(mock.patch.object(collect, name, replacement))
            return collect.main(
                [
                    "--input",
                    str(self.root / "in.csv"),
                    "--policy-ref",
                    POLICY_SHA,
                    "--workdir",
                    str(self.workdir),
                    "--answers",
                    str(self.answers),
                    *argv,
                ]
            )


class TestCollect(CollectTestCase):
    """The base arm's run: frame, sample, write the sample, build every row's inputs."""

    def test_the_sample_is_written_as_load_rows_reads_it_back(self):
        rows = [
            full_row(
                194379, decision_message="- risky\r\n- long", decision_summary="=1"
            ),
            full_row(194772, decision_message="'quoted' and plain"),
        ]
        code = self.collect(
            Fakes(rows), FakeInputs(), "--sample-n", "5", "--output", str(self.sample)
        )
        self.assertEqual(code, collect.EXIT_OK)
        self.assertEqual(load_rows(str(self.sample)), rows)

    def test_each_row_is_built_once_under_the_materialized_policy(self):
        numbers = [194379, 194772, 194773]
        inputs = FakeInputs()
        code = self.collect(
            Fakes([replay_row(n) for n in numbers]),
            inputs,
            "--sample-n",
            "5",
            "--parallelism",
            "2",
        )
        self.assertEqual(code, collect.EXIT_OK)
        [policy] = inputs.policies
        self.assertEqual(policy.ref, POLICY_SHA)
        self.assertEqual(policy.root, self.workdir / "collect" / "policy")
        self.assertEqual(built(inputs), numbers)
        cutoff = parse_as_of(replay_row(0)["decision_version"])
        runs = self.workdir / "collect" / "runs"
        for call in sorted(inputs.calls, key=attrgetter("pr")):
            with self.subTest(pr=call.pr):
                self.assertIs(call.policy, policy)
                self.assertEqual(
                    (call.repo, call.base_ref, call.head_sha, call.comments_before),
                    ("pytorch/pytorch", "main", f"{call.pr:040d}", cutoff),
                )
                self.assertEqual(call.run_dir, runs / str(call.pr))
                self.assertEqual(call.recording, self.answers)

    def test_a_framing_failure_fails_the_run_before_anything_is_written(self):
        fakes = Fakes([replay_row(194379)])
        fakes.fetch_landings = mock.Mock(side_effect=RuntimeError("ClickHouse is down"))
        inputs = FakeInputs()
        code = self.collect(
            fakes, inputs, "--sample-n", "5", "--output", str(self.sample)
        )
        self.assertEqual(code, collect.EXIT_FAILED)
        self.assertFalse(self.sample.exists())
        self.assertEqual((inputs.policies, inputs.calls), ([], []))

    def test_an_empty_sample_fails_the_run(self):
        inputs = FakeInputs()
        code = self.collect(Fakes([]), inputs, "--sample-n", "5")
        self.assertEqual(code, collect.EXIT_FAILED)
        self.assertEqual((inputs.policies, inputs.calls), ([], []))

    def test_a_sample_that_cannot_be_written_fails_the_run(self):
        unwritable = self.root / "missing" / "sample.csv"
        inputs = FakeInputs()
        code = self.collect(
            Fakes([replay_row(194379)]),
            inputs,
            "--sample-n",
            "5",
            "--output",
            str(unwritable),
        )
        self.assertEqual(code, collect.EXIT_FAILED)
        self.assertEqual((inputs.policies, inputs.calls), ([], []))

    def test_a_policy_that_cannot_be_materialized_fails_the_run(self):
        inputs = FakeInputs()
        inputs.materialize_policy = mock.Mock(side_effect=RuntimeError("no such ref"))
        code = self.collect(Fakes([replay_row(194379)]), inputs, "--sample-n", "5")
        self.assertEqual(code, collect.EXIT_FAILED)
        self.assertEqual(inputs.calls, [])

    def test_answers_must_be_named(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            collect.main(
                ["--input", "s.csv", "--policy-ref", POLICY_SHA, "--presampled"]
            )
        self.assertIn("--answers", stderr.getvalue())


class TestCollectionFailures(CollectTestCase):
    """A few awkward pull requests are logged and the job goes on; a collection that
    mostly failed, a rate limit or an outage, fails it before any replay starts."""

    def run_failing(self, total, failing):
        """Collect ``total`` rows, the first ``failing`` of them failing; return the
        exit status, the log lines and the failed numbers."""
        numbers = [194000 + n for n in range(total)]
        inputs = FakeInputs(failing=numbers[:failing])
        logging.disable(logging.NOTSET)
        try:
            with self.assertLogs(collect.logger, logging.INFO) as logs:
                code = self.collect(
                    Fakes([replay_row(n) for n in numbers]), inputs, "--sample-n", "9"
                )
        finally:
            logging.disable(logging.CRITICAL)
        self.assertEqual(built(inputs), numbers)
        return code, logs.output, numbers[:failing]

    def test_a_complete_collection_exits_0_and_warns_of_nothing(self):
        code, output, _ = self.run_failing(total=3, failing=0)
        self.assertEqual(code, collect.EXIT_OK)
        self.assertEqual([line for line in output if line.startswith("WARNING")], [])

    def test_exactly_half_failing_exits_0_naming_them(self):
        code, output, failed = self.run_failing(total=4, failing=2)
        self.assertEqual(code, collect.EXIT_OK)
        (warning,) = [line for line in output if line.startswith("WARNING")]
        self.assertIn("2 of 4", warning)
        for number in failed:
            self.assertIn(str(number), warning)
        self.assertFalse([line for line in output if "more than half" in line])

    def test_more_than_half_failing_exits_3(self):
        code, output, _ = self.run_failing(total=3, failing=2)
        self.assertEqual(code, collect.EXIT_DEGRADED)
        self.assertTrue([line for line in output if "more than half" in line])


class TestPresampledCollect(CollectTestCase):
    """The change arm's run builds the base arm's sample as written."""

    def test_no_clickhouse_seam_is_touched(self):
        numbers = [194379, 194772]
        clickhouse = mock.MagicMock()
        inputs = FakeInputs()
        code = self.collect(
            Fakes([replay_row(n) for n in numbers]),
            inputs,
            "--presampled",
            **{name: getattr(clickhouse, name) for name in FRAMING_SEAMS},
        )
        self.assertEqual(code, collect.EXIT_OK)
        self.assertEqual(clickhouse.mock_calls, [])
        self.assertEqual(built(inputs), numbers)

    def test_it_builds_what_the_base_arm_built_from_the_sample_it_wrote(self):
        rows = [full_row(n) for n in (194379, 194772)]
        base, change = FakeInputs(), FakeInputs()
        code = self.collect(
            Fakes(rows), base, "--sample-n", "5", "--output", str(self.sample)
        )
        self.assertEqual(code, collect.EXIT_OK)
        code = self.collect(
            Fakes([]),
            change,
            "--presampled",
            "--input",
            str(self.sample),
            load_rows=load_rows,
        )
        self.assertEqual(code, collect.EXIT_OK)

        def request(call):
            return call.pr, call.base_ref, call.head_sha, call.comments_before

        self.assertEqual(
            sorted(map(request, change.calls)), sorted(map(request, base.calls))
        )


class TestPresampledSweep(unittest.TestCase):
    """CI's replay jobs replay the sample collect drew, so a --presampled sweep
    replays every row as written: no ClickHouse read, no frame, no sampling."""

    def test_every_row_is_replayed_without_framing_or_sampling(self):
        numbers = [194379, 194772, 194773]
        fakes = Fakes([replay_row(n) for n in numbers])
        framing = mock.MagicMock()
        # Fakes.install builds connect and fetch_first_verdicts itself; the frame
        # calls fetch_landings right after connect, so these show whether it ran.
        for name in (
            "fetch_landings",
            "apply_frame",
            "rederive_first_landing",
            "sample_rows",
        ):
            setattr(fakes, name, getattr(framing, name))
        with run_replay(fakes, ["--presampled", "--parallelism", "1"]) as (code, out):
            self.assertEqual(code, cli.EXIT_OK)
            rows = read_csv(out)
        self.assertEqual(framing.mock_calls, [])
        self.assertEqual(fakes.reviewed, numbers)
        self.assertEqual([row["pr_number"] for row in rows], [str(n) for n in numbers])


if __name__ == "__main__":
    unittest.main()
