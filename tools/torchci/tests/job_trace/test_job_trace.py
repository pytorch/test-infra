"""job_trace on dummy ci.runs and workflow_job rows.

The toy and multi-lane traces are checked in under fixtures/ so they can be
opened in https://ui.perfetto.dev. After an intended change, regenerate them
with JOB_TRACE_UPDATE_FIXTURES=1 pytest tests/job_trace.
"""

import json
import os
import random
import unittest
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

from torchci.job_trace.trace import build_trace, OUTCOMES


FIXTURES = Path(__file__).parent / "fixtures"
T0 = 1_800_000_000_000  # epoch ms


def run(
    job: int,
    report: str,
    file: str,
    case: str,
    start_s: float,
    end_s: float,
    suite: str = "",
    outcome: str = "passed",
    rerun: int = 0,
    owners: str = "",
    summary: str = "",
) -> Dict[str, Any]:
    """A row as query.RUNS_QUERY returns it."""
    return {
        "job": job,
        "report": report,
        "file": file,
        "suite": suite,
        "case_name": case,
        "owners": owners,
        "rerun_number": rerun,
        "outcome": outcome,
        "summary": summary,
        "start_ms": T0 + round(start_s * 1000),
        "end_ms": T0 + round(end_s * 1000),
    }


def job(
    job_id: int,
    name: str,
    start_s: float,
    end_s: float,
    steps: Sequence[Tuple[str, float, float]] = (),
) -> List[Dict[str, Any]]:
    """Rows as query.JOBS_QUERY returns them: one per step."""
    base = {
        "job": job_id,
        "name": name,
        "url": f"https://github.com/pytorch/pytorch/actions/runs/1/job/{job_id}",
        "conclusion": "success",
        "runner": "runner-1",
        "labels": "linux.2xlarge",
        "start_ms": T0 + round(start_s * 1000),
        "end_ms": T0 + round(end_s * 1000),
    }
    if not steps:
        return [
            {
                **base,
                "step": "",
                "step_conclusion": "",
                "step_start_ms": 0,
                "step_end_ms": 0,
            }
        ]
    return [
        {
            **base,
            "step": step,
            "step_conclusion": "success",
            "step_start_ms": T0 + round(s * 1000),
            "step_end_ms": T0 + round(e * 1000),
        }
        for step, s, e in steps
    ]


# One shard running two files one after another: a suite with a failure, its
# pytest rerun and a zero-length skip at the very end of the file, then a test
# outside any class.
TOY_JOBS = job(
    1,
    "linux-jammy-py3.10-gcc11 / test (default, 1, 1, linux.2xlarge)",
    0,
    120,
    [("Set up job", 0, 10), ("Test", 10, 110), ("Upload test artifacts", 110, 120)],
)
TOY_RUNS = [
    run(1, "r-a", "test/test_a.py", "test_one", 20, 25, suite="TestA", owners="core"),
    run(
        1,
        "r-a",
        "test/test_a.py",
        "test_two",
        25,
        35,
        suite="TestA",
        outcome="failed",
        owners="core",
        summary="AssertionError: 1 != 2",
    ),
    run(
        1,
        "r-a",
        "test/test_a.py",
        "test_two",
        35,
        40,
        suite="TestA",
        rerun=1,
        owners="core",
    ),
    run(
        1,
        "r-a",
        "test/test_a.py",
        "test_skip",
        40,
        40,
        suite="TestB",
        outcome="skipped",
        owners="core",
        summary="requires CUDA",
    ),
    run(1, "r-b", "test/test_b.py", "test_four", 50, 60, owners="inductor"),
]

# A shard with three parallel test processes, two of them pieces of the same
# file, then two C++ binaries running three tests at a time each (-n 3).
MULTI_JOBS = job(
    2, "linux-jammy-cuda12.8 / test (default, 2, 5, linux.g5.4xlarge)", 0, 140
)
MULTI_RUNS = [
    run(2, "ops-1", "test/test_ops.py", "test_add", 0, 50, suite="TestCommon"),
    run(2, "ops-1", "test/test_ops.py", "test_mul", 50, 100, suite="TestCommon"),
    run(2, "ops-2", "test/test_ops.py", "test_sub", 10, 90, suite="TestCommon"),
    run(2, "nn", "test/test_nn.py", "test_linear", 20, 60, suite="TestNN"),
    run(2, "torch", "test/test_torch.py", "test_empty", 61, 80, suite="TestTorch"),
    run(2, "api", "cpp/test_api", "A1", 100, 110, suite="Api"),
    run(2, "api", "cpp/test_api", "A2", 100, 115, suite="Api"),
    run(2, "api", "cpp/test_api", "A3", 101, 120, suite="Api"),
    run(2, "api", "cpp/test_api", "A4", 110, 125, suite="Api"),
    run(2, "jit", "cpp/test_jit", "B1", 105, 112, suite="Jit"),
    run(2, "jit", "cpp/test_jit", "B2", 105, 118, suite="Jit"),
    run(2, "jit", "cpp/test_jit", "B3", 106, 125, suite="Jit"),
]


def slices(trace: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [e for e in trace["traceEvents"] if e["ph"] == "X"]


def thread_names(trace: Dict[str, Any]) -> Dict[Tuple[int, int], str]:
    return {
        (e["pid"], e["tid"]): e["args"]["name"]
        for e in trace["traceEvents"]
        if e["ph"] == "M" and e["name"] == "thread_name"
    }


def assert_valid(test: unittest.TestCase, trace: Dict[str, Any], runs: int) -> None:
    """Slices on a track nest the way Perfetto lays out [ts, ts + dur), lane
    units never overlap, and every run is one case slice."""
    tracks: Dict[Tuple[int, int], List[Dict[str, Any]]] = defaultdict(list)
    for e in slices(trace):
        test.assertGreaterEqual(e["dur"], 0)
        tracks[(e["pid"], e["tid"])].append(e)
    for track, events in tracks.items():
        stack: List[int] = []
        for e in sorted(events, key=lambda e: (e["ts"], -e["dur"])):
            while stack and stack[-1] <= e["ts"]:
                stack.pop()
            if stack:
                test.assertLessEqual(
                    e["ts"] + e["dur"], stack[-1], f"{e} overlaps its parent on {track}"
                )
            stack.append(e["ts"] + e["dur"])
        units = [
            e for e in events if e.get("cat") == "report" or "file" in e.get("args", {})
        ]
        units.sort(key=lambda e: e["ts"])
        for a, b in zip(units, units[1:]):
            test.assertLessEqual(
                a["ts"] + a["dur"], b["ts"], f"{a} and {b} share {track}"
            )
    test.assertEqual(sum(e.get("cat") in OUTCOMES for e in slices(trace)), runs)


def peak_overlap(intervals: List[Tuple[int, int]]) -> int:
    points = sorted([(s, 1) for s, _ in intervals] + [(e, -1) for _, e in intervals])
    cur = peak = 0
    for _, d in points:
        cur += d
        peak = max(peak, cur)
    return peak


def check_fixture(test: unittest.TestCase, name: str, trace: Dict[str, Any]) -> None:
    path = FIXTURES / name
    if os.environ.get("JOB_TRACE_UPDATE_FIXTURES"):
        # One event per line, so the fixture reads as a list of slices.
        lines = ",\n".join(json.dumps(e) for e in trace["traceEvents"])
        path.write_text(f'{{"displayTimeUnit": "ms", "traceEvents": [\n{lines}\n]}}\n')
    test.assertEqual(json.loads(path.read_text()), trace)


class TestToyTrace(unittest.TestCase):
    def setUp(self) -> None:
        self.trace, self.stats = build_trace([1], TOY_JOBS, TOY_RUNS)

    def test_matches_fixture(self) -> None:
        check_fixture(self, "toy_trace.json", self.trace)

    def test_valid(self) -> None:
        assert_valid(self, self.trace, len(TOY_RUNS))

    def test_one_lane_with_file_suite_case_nesting(self) -> None:
        lane = [e for e in slices(self.trace) if e["tid"] == 1001]
        self.assertEqual(
            [(e["name"], e.get("cat")) for e in lane],
            [
                ("test/test_a.py", "report"),
                ("TestA", "suite"),
                ("test_one", "passed"),
                ("test_two", "failed"),
                ("test_two", "passed"),
                ("TestB", "suite"),
                ("test_skip", "skipped"),
                ("test/test_b.py", "report"),
                ("test_four", "passed"),
            ],
        )
        report = lane[0]
        self.assertEqual(
            report["args"],
            {
                "report_uuid": "r-a",
                "owners": "core",
                "passed": 2,
                "failed": 1,
                "skipped": 1,
            },
        )
        self.assertEqual(lane[3]["args"]["summary"], "AssertionError: 1 != 2")
        self.assertEqual(lane[4]["args"]["rerun_number"], 1)
        self.assertEqual(self.stats[1].lanes, 1)

    def test_zero_length_test_at_file_end_nests(self) -> None:
        report, skip = (
            e
            for e in slices(self.trace)
            if e["name"] in ("test/test_a.py", "test_skip")
        )
        self.assertEqual(skip["dur"], 1)  # 1 µs
        self.assertLess(skip["ts"] + skip["dur"], report["ts"] + report["dur"])

    def test_job_track_has_job_and_steps(self) -> None:
        track = [e["name"] for e in slices(self.trace) if e["tid"] == 1000]
        self.assertEqual(track, ["job", "Set up job", "Test", "Upload test artifacts"])
        self.assertEqual(self.stats[1].test_step_minutes, 100 / 60)
        self.assertAlmostEqual(self.stats[1].test_minutes, 30 / 60, places=4)


class TestMultiLaneTrace(unittest.TestCase):
    def setUp(self) -> None:
        self.trace, self.stats = build_trace([2], MULTI_JOBS, MULTI_RUNS)

    def test_matches_fixture(self) -> None:
        check_fixture(self, "multi_lane_trace.json", self.trace)

    def test_valid(self) -> None:
        assert_valid(self, self.trace, len(MULTI_RUNS))

    def test_lanes_equal_peak_overlap(self) -> None:
        # 106-110 s: three tests of each C++ binary.
        units = [
            (e["ts"], e["ts"] + e["dur"])
            for e in slices(self.trace)
            if e.get("cat") == "report" or "file" in e.get("args", {})
        ]
        self.assertEqual(self.stats[2].lanes, peak_overlap(units))
        self.assertEqual(self.stats[2].lanes, 6)
        self.assertEqual(len(thread_names(self.trace)), 7)  # job + 6 lanes

    def test_parallel_files_and_pieces_get_their_own_lanes(self) -> None:
        reports = {
            e["args"]["report_uuid"]: e["tid"]
            for e in slices(self.trace)
            if e.get("cat") == "report"
        }
        self.assertEqual(len({reports["ops-1"], reports["ops-2"], reports["nn"]}), 3)
        # test_torch starts after test_nn ends, so it reuses that lane.
        self.assertEqual(reports["torch"], reports["nn"])

    def test_parallel_report_is_split_into_tests(self) -> None:
        cpp = [e for e in slices(self.trace) if "file" in e.get("args", {})]
        self.assertEqual(len(cpp), 7)
        self.assertEqual(
            {e["args"]["file"] for e in cpp}, {"cpp/test_api", "cpp/test_jit"}
        )
        self.assertFalse(
            any(
                e.get("cat") == "report" and e["name"].startswith("cpp/")
                for e in slices(self.trace)
            )
        )


class TestDeterminism(unittest.TestCase):
    def test_row_order_does_not_matter(self) -> None:
        # Two zero-length skips tied to the millisecond, and two parallel C++
        # binaries whose first tests share an interval, plus everything above.
        tied = [
            run(
                1,
                "r-c",
                "test/test_c.py",
                name,
                70,
                70,
                suite="TestC",
                outcome="skipped",
            )
            for name in ("test_y", "test_x")
        ] + [
            run(1, "cpp-q", "cpp/q", "T1", 200, 210, suite="Q"),
            run(1, "cpp-q", "cpp/q", "T2", 202, 204, suite="Q"),
            run(1, "cpp-p", "cpp/p", "T1", 200, 210, suite="P"),
            run(1, "cpp-p", "cpp/p", "T2", 201, 206, suite="P"),
        ]
        rows = TOY_RUNS + MULTI_RUNS + tied
        expected, _ = build_trace([1, 2], TOY_JOBS + MULTI_JOBS, rows)
        for seed in range(5):
            shuffled = rows[:]
            random.Random(seed).shuffle(shuffled)
            self.assertEqual(
                build_trace([1, 2], TOY_JOBS + MULTI_JOBS, shuffled)[0], expected
            )
        names = [
            e["name"] for e in slices(expected) if e["name"] in ("test_x", "test_y")
        ]
        self.assertEqual(names, ["test_x", "test_y"])
        t1_lane = {
            e["args"]["report_uuid"]: e["tid"]
            for e in slices(expected)
            if e["name"] == "T1"
        }
        self.assertLess(t1_lane["cpp-p"], t1_lane["cpp-q"])


class TestMultipleJobs(unittest.TestCase):
    def test_one_process_per_job_in_order(self) -> None:
        empty = job(
            3, "linux-jammy-py3.10-gcc11 / test (default, 2, 2, linux.2xlarge)", 0, 30
        )
        trace, stats = build_trace(
            [2, 1, 3], TOY_JOBS + MULTI_JOBS + empty, TOY_RUNS + MULTI_RUNS
        )
        assert_valid(self, trace, len(TOY_RUNS) + len(MULTI_RUNS))
        names = {
            e["pid"]: e["args"]["name"]
            for e in trace["traceEvents"]
            if e["name"] == "process_name"
        }
        self.assertTrue(
            names[1].endswith("(2)")
            and names[2].endswith("(1)")
            and names[3].endswith("(3)")
        )
        # Each job's tids are a block of its own: pid * 1000 for the job track, then lanes.
        self.assertEqual(
            sorted(tid for pid, tid in thread_names(trace) if pid == 2), [2000, 2001]
        )
        self.assertEqual(
            sorted(tid for pid, tid in thread_names(trace) if pid == 3), [3000]
        )
        self.assertEqual((stats[3].runs, stats[3].lanes), (0, 0))

    def test_steps_are_clipped_to_the_job(self) -> None:
        rows = job(
            4,
            "j",
            10,
            20,
            [("Set up job", 5, 12), ("Skipped", 15, 15), ("Test", 12, 25)],
        )
        trace, _ = build_trace([4], rows, [])
        self.assertEqual(
            [(e["name"], e["ts"], e["ts"] + e["dur"]) for e in slices(trace)],
            [
                ("job", (T0 + 10_000) * 1000, (T0 + 20_000) * 1000),
                ("Set up job", (T0 + 10_000) * 1000, (T0 + 12_000) * 1000),
                ("Test", (T0 + 12_000) * 1000, (T0 + 20_000) * 1000),
            ],
        )


if __name__ == "__main__":
    unittest.main()
