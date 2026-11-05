"""test_cost_mv on CI-sized jobs, checked row for row against reference.py.

Each scenario is generated from a fixed seed to look like real test shards: a
setup gap, a serial phase (one file at a time), a pool of 3 processes over ~30
files ending with a straggler, skipped runs (some 0 ms, some long), and, for
some jobs, a C++ phase where each binary's report runs ~3 tests at once
(pytest-xdist) across several gtest suites. Around them sit the jobs the view
must leave out or treat specially: builds, test jobs without reports, reruns,
older versions, clock skew. One more test runs a real job exported from
ci.runs (fixtures/test_cost_job_125496836738.json).

The view runs on literal inputs (test_cost_harness), so the ClickHouse service
in CLICKHOUSE_ENDPOINT only evaluates the query; a read-only user is enough.

    cd clickhouse_db_schema/tests && python3 -m unittest test_test_cost_realistic -v
"""

import json
import random
import sys
import unittest
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple


# This directory: the harness (which finds migrate.py) and the reference.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_cost_harness as harness  # noqa: E402
from reference import counted_jobs, expected_rows  # noqa: E402
from test_cost_harness import BASE, Job, Run, Scenario, workflow_path  # noqa: E402


# Milliseconds: the view and the reference each round a row once.
TOLERANCE = 1
MAX_SQL_BYTES = 2_000_000
MEASURES = (
    "executed_test_milliseconds",
    "skipped_test_milliseconds",
    "held_milliseconds",
    "occupancy_runner_milliseconds",
    "test_ratio_runner_milliseconds",
)
FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "test_cost_job_125496836738.json"
)
DAY = 86400


def view_rows(scenario: Scenario) -> Tuple[List[dict], int]:
    """The view's rows for the scenario, and the size of the query sent."""
    return harness.run_scenario(scenario), len(harness.view_query(scenario).encode())


# --------------------------------------------------------------------------- generators


class Shard:
    """Builds one test job's runs on a timeline, in whole milliseconds."""

    def __init__(self, job_id: int, rng: random.Random, start_s: int, env: int):
        self.job_id, self.rng, self.env = job_id, rng, env
        self.start_s = start_s
        self.now = start_s * 1000 + rng.randint(60_000, 240_000)  # setup
        self.runs: List[Run] = []
        self.reports = 0

    def report(self) -> str:
        self.reports += 1
        return f"r{self.reports}"

    def run(
        self,
        report: str,
        file: str,
        start_ms: int,
        dur_ms: int,
        outcome: str = "passed",
        suite: str = "",
        language: str = "python",
    ) -> int:
        self.runs.append(
            Run(
                self.job_id,
                report,
                file,
                start_ms / 1000,
                (start_ms + dur_ms) / 1000,
                outcome=outcome,
                suite=suite,
                language=language,
                env=self.env,
            )
        )
        return start_ms + dur_ms

    def python_file(
        self,
        report: str,
        file: str,
        start_ms: int,
        tests: int,
        long_skip: bool = False,
        slow: bool = False,
    ) -> int:
        """One process running a file's tests one after another, with small
        gaps; ~12% skipped (some 0 ms), one long skip if asked."""
        t = start_ms
        for i in range(tests):
            t += self.rng.randint(0, 30)
            if long_skip and i == tests // 2:
                t = self.run(report, file, t, 30_000, "skipped")
            elif self.rng.random() < 0.12:
                t = self.run(
                    report, file, t, self.rng.choice([0, 0, 3, 11, 40]), "skipped"
                )
            else:
                dur = (
                    self.rng.randint(5_000, 20_000)
                    if slow
                    else self.rng.randint(50, 5_000)
                )
                t = self.run(
                    report, file, t, dur, self.rng.choice(["passed"] * 9 + ["failed"])
                )
        return t

    def serial_phase(self, files: List[str]) -> None:
        for n, file in enumerate(files):
            self.now = self.python_file(
                self.report(),
                file,
                self.now + 1_500,
                self.rng.randint(20, 60),
                long_skip=(n == 0),
            )

    def pool_phase(self, files: List[str], straggler: str, lanes: int = 3) -> None:
        """Files handed to the first free of 3 processes, each a report; a slow
        file goes last and runs alone at the end."""
        free = [self.now + 800 * k for k in range(lanes)]
        for file in files:
            lane = min(range(lanes), key=lambda k: free[k])
            free[lane] = self.python_file(
                self.report(), file, free[lane] + 1_200, self.rng.randint(5, 40)
            )
        lane = min(range(lanes), key=lambda k: free[k])
        free[lane] = self.python_file(
            self.report(), straggler, free[lane] + 1_200, 15, slow=True
        )
        self.now = max(free)

    def cpp_phase(self, binaries: Dict[str, List[str]], workers: int = 3) -> None:
        """C++ binaries 3 at a time; each binary's report runs ~3 tests at once
        over its gtest suites."""
        free = [self.now + 2_000 * k for k in range(3)]
        for binary, suites in binaries.items():
            lane = min(range(3), key=lambda k: free[k])
            report = self.report()
            worker_free = [free[lane] + 500 + 37 * w for w in range(workers)]
            for i in range(self.rng.randint(30, 80)):
                w = min(range(workers), key=lambda k: worker_free[k])
                outcome = "skipped" if self.rng.random() < 0.05 else "passed"
                dur = 0 if outcome == "skipped" else self.rng.randint(5, 3_000)
                worker_free[w] = self.run(
                    report,
                    f"cpp/{binary}",
                    worker_free[w] + self.rng.randint(0, 5),
                    dur,
                    outcome,
                    suite=suites[i % len(suites)],
                    language="cpp",
                )
            free[lane] = max(worker_free)
        self.now = max(free)

    def job(self, name: str, workflow: str, **kwargs) -> Job:
        end_s = -(
            -(self.now + self.rng.randint(30_000, 120_000)) // 1000
        )  # teardown, whole seconds
        # Runner pools share a test environment, so rows also split by label.
        kwargs.setdefault("labels", [self.rng.choice(RUNNER_LABELS)])
        return Job(
            self.job_id, self.start_s, end_s, name=name, workflow=workflow, **kwargs
        )


RUNNER_LABELS = ["linux.2xlarge", "lf.linux.2xlarge", "mt-l-x86iavx512-16-128"]

PY_FILES = [
    f"test/test_{name}.py"
    for name in (
        "nn",
        "torch",
        "fx",
        "ops",
        "autograd",
        "jit",
        "linalg",
        "sparse",
        "dataloader",
        "cuda",
        "mps",
        "quantization",
        "reductions",
        "unary_ufuncs",
        "binary_ufuncs",
        "indexing",
        "shape_ops",
        "sort_and_select",
        "tensor_creation_ops",
        "type_promotion",
        "view_ops",
        "foreach",
        "optim",
        "schema_check",
        "serialization",
        "utils",
        "spectral_ops",
        "testing",
        "transformers",
        "prims",
        "decomp",
        "meta",
        "proxy_tensor",
    )
]
OWNERS = {
    "test/test_nn.py": ["nn"],
    "test/test_torch.py": ["core_tests"],
    "test/test_fx.py": ["fx"],
    "test/test_ops.py": [
        "decompositions",
        "core_tests",
    ],  # two owners: an even split, kept in order
    "test/test_autograd.py": ["autograd"],
    "test/test_linalg.py": ["linear algebra"],
    "test/test_decomp.py": ["decompositions"],
    "cpp/test_api": [
        "cpp-frontend"
    ],  # C++ rows fall back from (file, module) to the file
}
CPP = {
    "test_api": ["ModuleTest", "OptimTest", "TensorTest", "SerializeTest"],
    "static_runtime_test": ["StaticRuntime", "ProcessedNode"],
    "Dict_test": ["DictTest"],
    "atest": ["atest"],
}


def shard(
    job_id: int,
    seed: int,
    start_s: int,
    env: int,
    workflow: str,
    config: str,
    cpp: bool = False,
    **job_kwargs,
) -> Tuple[Job, List[Run]]:
    rng = random.Random(seed)
    files = PY_FILES[:]
    rng.shuffle(files)
    s = Shard(job_id, rng, start_s, env)
    s.serial_phase(files[:3])
    s.pool_phase(files[3:28], straggler=files[28])
    if cpp:
        s.cpp_phase(CPP)
    name = f"linux-jammy-py3.11-clang21 / test ({config}, {job_id % 5 + 1}, 5, linux.4xlarge)"
    return s.job(name, workflow, **job_kwargs), s.runs


# --------------------------------------------------------------------------- checks


def union_length(intervals: List[Tuple[int, int]]) -> int:
    """Total length covered by intervals, by merging: a third way to get busy
    time, sharing nothing with the sweep or the brute force."""
    total, end = 0, None
    for s, e in sorted(intervals):
        if end is None or s > end:
            total, end = total + (e - s), e
        elif e > end:
            total, end = total + (e - end), e
    return total


class RealisticCase(harness.ClickHouseTestCase):
    def check(self, scenario: Scenario) -> List[dict]:
        """The view's rows equal the reference's, column for column, and the
        totals add up."""
        total_runs = len(scenario.runs)
        self.assertLess(total_runs, 10_000, "keep scenarios CI-sized")
        got, sql_bytes = view_rows(scenario)
        self.assertLess(sql_bytes, MAX_SQL_BYTES)
        want = expected_rows(
            scenario.jobs,
            scenario.runs,
            scenario.owners,
            scenario.day_from,
            scenario.day_to,
            scenario.retention_floor,
        )

        def key(row):
            return (
                row["day"],
                row["repo"],
                row["workflow_path"],
                row["test_file"],
                row["test_module"],
                row["environments_id"],
                tuple(row["runner_labels"]),
                row["trigger"],
            )

        got_by_key, want_by_key = {key(r): r for r in got}, {key(r): r for r in want}
        self.assertEqual(
            len(got_by_key), len(got), "the view wrote two rows for one key"
        )
        self.assertEqual(sorted(got_by_key), sorted(want_by_key))
        for k, w in want_by_key.items():
            g = got_by_key[k]
            for column in MEASURES:
                self.assertAlmostEqual(
                    g[column], w[column], delta=TOLERANCE, msg=f"{column} of {k}"
                )
            self.assertEqual(g["owners"], w["owners"], f"owners of {k}")

        # Both attributions hand out exactly the wall time of the jobs that
        # got rows (test jobs, and any job with test reports).
        jobs_with_rows = self.jobs_with_rows(scenario)
        wall = 1000 * sum(round(j.end) - round(j.start) for j in jobs_with_rows)
        slack = 0.5 * len(got) + 1e-6  # each row rounds by at most 0.5 ms
        self.assertAlmostEqual(
            sum(r["occupancy_runner_milliseconds"] for r in got), wall, delta=slack
        )
        self.assertAlmostEqual(
            sum(r["test_ratio_runner_milliseconds"] for r in got), wall, delta=slack
        )

        # Held time adds up to each job's busy time (the union of its spans),
        # never more than its wall time; occupancy covers held time.
        busy_by_job = self.busy_by_job(scenario)
        for job in jobs_with_rows:
            self.assertLessEqual(
                busy_by_job.get(job.id, 0) / 1000, round(job.end) - round(job.start)
            )
        self.assertAlmostEqual(
            sum(r["held_milliseconds"] for r in got),
            sum(busy_by_job.values()),
            delta=slack,
        )
        for r in got:
            self.assertLessEqual(
                r["held_milliseconds"], r["occupancy_runner_milliseconds"]
            )
        print(
            f"\n  {self.id().rsplit('.', 1)[-1]}: {len(scenario.jobs)} jobs, {total_runs} runs, "
            f"{len(got)} rows, {sql_bytes / 1e6:.2f} MB of SQL",
            end="",
        )
        return got

    @staticmethod
    def spans_by_job(scenario: Scenario) -> Dict[int, List[Tuple[int, int]]]:
        included = {
            j.id: j
            for j in counted_jobs(
                scenario.jobs,
                scenario.day_from,
                scenario.day_to,
                scenario.retention_floor,
            )
        }
        lo = (
            datetime.strptime(scenario.day_from, "%Y-%m-%d").replace(
                tzinfo=timezone.utc
            )
            - BASE
        ).total_seconds()
        hi = (
            datetime.strptime(scenario.day_to, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            - BASE
        ).total_seconds() + DAY
        bounds: Dict[tuple, List[int]] = {}
        for r in scenario.runs:
            if r.job in included and lo <= r.start < hi:
                b = bounds.setdefault(
                    (r.job, r.report, r.file),
                    [round(r.start * 1000), round(r.end * 1000)],
                )
                b[0], b[1] = (
                    min(b[0], round(r.start * 1000)),
                    max(b[1], round(r.end * 1000)),
                )
        spans = defaultdict(list)
        for (job_id, _, _), (s, e) in bounds.items():
            job = included[job_id]
            s, e = max(s, round(job.start) * 1000), min(e, round(job.end) * 1000)
            if e > s:
                spans[job_id].append((s, e))
        return spans

    def busy_by_job(self, scenario: Scenario) -> Dict[int, int]:
        return {
            job_id: union_length(spans)
            for job_id, spans in self.spans_by_job(scenario).items()
        }

    def jobs_with_rows(self, scenario: Scenario) -> List[Job]:
        spans = self.spans_by_job(scenario)
        return [
            j
            for j in counted_jobs(
                scenario.jobs,
                scenario.day_from,
                scenario.day_to,
                scenario.retention_floor,
            )
            if spans.get(j.id) or "/ test (" in j.name or j.name.startswith("test (")
        ]


class TestRealisticShards(RealisticCase):
    def test_pull_shards_with_cpp_and_jobs_without_reports(self):
        """Three test shards across two workflows and environments (one with a
        C++ phase), a test job that uploaded no reports, a build job, and a
        docs job that did upload reports."""
        jobs, runs = [], []
        for job, job_runs in (
            shard(
                101,
                seed=1,
                start_s=3_600,
                env=11,
                workflow="pull",
                config="default",
                cpp=True,
            ),
            shard(
                102, seed=2, start_s=5_400, env=11, workflow="pull", config="default"
            ),
            shard(
                103, seed=3, start_s=7_200, env=22, workflow="trunk", config="crossref"
            ),
        ):
            jobs.append(job)
            runs += job_runs
        # Test jobs without reports: one '' row per runner label set.
        jobs.append(
            Job(
                104,
                9_000,
                10_800,
                name="linux-jammy-py3.11 / test (inductor_torchbench, 1, 2, a10g)",
                labels=["linux.g5.4xlarge.nvidia.gpu"],
            )
        )
        jobs.append(
            Job(
                107,
                9_500,
                10_100,
                name="linux-jammy-py3.11 / test (inductor_torchbench, 2, 2, a10g)",
                labels=["linux.g5.4xlarge.nvidia.gpu"],
            )
        )
        jobs.append(
            Job(
                108,
                9_000,
                9_900,
                name="linux-jammy-xpu / test (default, 1, 4, linux.idc.xpu)",
                labels=["linux.idc.xpu"],
            )
        )
        jobs.append(
            Job(105, 9_000, 11_000, name="linux-jammy-py3.11 / build", workflow="pull")
        )
        docs, docs_runs = shard(
            106, seed=6, start_s=12_000, env=33, workflow="pull", config="docs"
        )
        docs.name = "linux-docs / build-docs-python"
        jobs.append(docs)
        runs += docs_runs
        rows = self.check(Scenario(jobs, runs, OWNERS))
        files = {(r["workflow_path"], r["test_file"]) for r in rows}
        self.assertIn(
            (workflow_path("pull"), ""), files
        )  # the test job without reports
        self.assertTrue(any(r["test_module"] == "ModuleTest" for r in rows))
        self.assertEqual(len(runs), sum(1 for _ in runs))

    def test_jobs_the_view_must_leave_out_or_clip(self):
        """A job whose every run was skipped (test ratio falls back to
        occupancy), a job with runs before it started and after it ended (spans
        clipped), an older version of a job id with another end (the newest
        wins), a rerun with a stale start, an in-progress job, a skipped job,
        and a job that started on the day after the window (all left out even
        though they have runs), and a job running past midnight (its runs
        after midnight still count)."""
        jobs, runs = [], []
        job, job_runs = shard(
            201, seed=21, start_s=20_000, env=1, workflow="pull", config="default"
        )
        jobs.append(job)
        runs += [
            Run(r.job, r.report, r.file, r.start, r.end, "skipped", env=r.env)
            for r in job_runs
        ]

        job, job_runs = shard(
            202, seed=22, start_s=30_000, env=2, workflow="pull", config="default"
        )
        jobs.append(job)
        runs += job_runs
        runs.append(Run(202, "early", "test/test_nn.py", 29_990.0, 30_040.5, env=2))
        runs.append(
            Run(202, "late", "test/test_torch.py", job.end - 5, job.end + 60, env=2)
        )
        runs.append(
            Run(202, "outside", "test/test_fx.py", job.end + 10, job.end + 20, env=2)
        )  # empty once clipped

        job, job_runs = shard(
            203, seed=23, start_s=40_000, env=3, workflow="trunk", config="default"
        )
        jobs += [
            Job(
                203,
                job.start,
                job.end + 900,
                name=job.name,
                workflow="trunk",
                version=1,
            ),
            Job(203, job.start, job.end, name=job.name, workflow="trunk", version=2),
        ]
        runs += job_runs

        for job_id, kwargs in (
            (204, {"created": 50_100}),
            (205, {"status": "in_progress"}),
            (206, {"conclusion": "skipped"}),
        ):
            job, job_runs = shard(
                job_id,
                seed=job_id,
                start_s=50_000,
                env=4,
                workflow="pull",
                config="default",
                **kwargs,
            )
            jobs.append(job)
            runs += job_runs
        job, job_runs = shard(
            207, seed=27, start_s=DAY + 600, env=5, workflow="pull", config="default"
        )
        jobs.append(job)
        runs += job_runs

        job, job_runs = shard(
            208, seed=28, start_s=DAY - 300, env=6, workflow="periodic", config="slow"
        )
        jobs.append(job)
        runs += job_runs
        self.assertGreater(max(r.end for r in job_runs), DAY)

        rows = self.check(Scenario(jobs, runs, OWNERS))
        self.assertNotIn(
            "",
            {
                r["test_file"]
                for r in rows
                if r["workflow_path"] == workflow_path("trunk")
            },
        )

    def test_seeded_mixtures(self):
        """Random mixes of shards, with and without C++, across workflows,
        environments and triggers, under several seeds."""
        for seed in (101, 202, 303):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                jobs, runs = [], []
                for k in range(3):
                    job, job_runs = shard(
                        seed * 10 + k,
                        seed=seed * 7 + k,
                        start_s=rng.randint(0, 70_000),
                        env=rng.choice([1, 2]),
                        workflow=rng.choice(["pull", "trunk", "inductor"]),
                        config=rng.choice(["default", "crossref"]),
                        cpp=rng.random() < 0.5,
                        event=("pull_request", "push", "push")[k],
                        branch=("my-feature", "ciflow/trunk/123", "main")[k],
                    )
                    jobs.append(job)
                    runs += job_runs
                jobs.append(
                    Job(
                        seed * 10 + 9,
                        1_000,
                        2_000,
                        name="win-vs2022 / test (default, 1, 3, windows)",
                    )
                )
                self.check(Scenario(jobs, runs, OWNERS))


class TestRealJob(RealisticCase):
    def test_real_job_125496836738(self):
        """linux-jammy-py3.11-clang21 / test (default, 3, 10, ...) from pull on
        2026-11-02: 986 runs in 5 reports over 3 files (one file split across
        reports), 282 of them skipped, exported from ci.runs."""
        fx = json.loads(FIXTURE.read_text())
        base = int(BASE.timestamp())
        j = fx["job"]
        start = j["started"] - base
        job = Job(
            int(j["id"]),
            start,
            j["completed"] - base,
            name=j["name"],
            workflow=j["workflow_name"],
            repo=j["repo"],
            status=j["status"],
            conclusion=j["conclusion"],
            runner=j["runner_name"],
            created=j["created"] - base,
        )
        runs = []
        for report, file, suite, outcome, env, s_ms, e_ms in fx["runs"]:
            suite_name, language = fx["suites"][suite]
            runs.append(
                Run(
                    job.id,
                    f"r{report}",
                    fx["files"][file],
                    start + s_ms / 1000,
                    start + e_ms / 1000,
                    outcome=fx["outcomes"][outcome],
                    suite=suite_name,
                    language=language,
                    env=int(fx["envs"][env]),
                )
            )
        rows = self.check(
            Scenario(
                [job], runs, fx["owners"], day_from="2026-11-02", day_to="2026-11-03"
            )
        )
        self.assertEqual(len(runs), 986)
        self.assertEqual({r["test_file"] for r in rows}, set(fx["files"]))


if __name__ == "__main__":
    unittest.main()
