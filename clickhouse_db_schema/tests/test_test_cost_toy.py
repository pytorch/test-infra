"""Toy scenarios for test_cost_mv (ci/000005-test-cost-view.sql).

Each test is a timeline small enough to check with pencil and paper; its
docstring shows the timeline and the arithmetic, and the test asserts the
numbers the view writes. Times are seconds after the harness's BASE. A report
(one test process) spans its runs' first start to last end on each file,
skipped runs included, clipped to the job; at every instant the job's time is
split evenly among the spans running then (held_seconds), and each job's wall
time is split by held time (occupancy) and by test time, executed and skipped
runs both (test ratio).

Run (read-only; each query reads no real table):
    cd clickhouse_db_schema/tests && python3 -m unittest test_test_cost_toy -v
with CLICKHOUSE_ENDPOINT, CLICKHOUSE_USERNAME and CLICKHOUSE_PASSWORD set.
"""

import re
import unittest

from test_cost_harness import (
    by_file,
    ClickHouseTestCase,
    Job,
    Run,
    run_view,
    TABLE_SQL,
    VIEW_SQL,
    workflow_path,
)


BUILD = "linux-jammy-py3.10 / build"
LINT = "lint / lintrunner"


class ToyCase(ClickHouseTestCase):
    def assertRow(self, row, **expected):
        """Times are given in seconds, as the timelines are drawn, and compared
        with the stored milliseconds to within the 0.5 ms a row rounds by."""
        for key, value in expected.items():
            if key.endswith("_seconds"):
                column = key[: -len("seconds")] + "milliseconds"
                self.assertAlmostEqual(
                    row[column], value * 1000, delta=0.5 + 1e-6, msg=column
                )
            elif isinstance(value, float):
                self.assertAlmostEqual(row[key], value, places=6, msg=key)
            else:
                self.assertEqual(row[key], value, msg=key)

    def assertInvariants(self, rows, wall, busy):
        """Both attributions add up to the included jobs' wall time; held time
        adds up to the busy time (union of spans); no row holds more than it
        is charged. Each row rounds by at most 0.5 ms."""
        slack = 0.5 * len(rows) + 1e-6
        for column, seconds in (
            ("occupancy_runner_milliseconds", wall),
            ("test_ratio_runner_milliseconds", wall),
            ("held_milliseconds", busy),
        ):
            self.assertAlmostEqual(
                sum(r[column] for r in rows), seconds * 1000, delta=slack, msg=column
            )
        self.assertLessEqual(busy, wall)
        for r in rows:
            self.assertGreaterEqual(
                r["occupancy_runner_milliseconds"], r["held_milliseconds"]
            )


class Occupancy(ToyCase):
    def test_three_reports(self):
        """One 100 s job, three reports.

            time   0    10        40        60   70        100
            A nn   [=========================)              0-60  (two runs, 60 s executed)
            B ops       [=========)                         10-40 (30 s executed)
            C fx                  [===================)     40-70 (30 s executed)

            stretch   running   each gets   A    B    C
            0-10      A         10          10
            10-40     A, B      15          15   15
            40-60     A, C      10          10        10
            60-70     C         10                    10
            held                            35   15   20   busy 70

        Occupancy: 100 x held / 70 = 50, 21.428571, 28.571429.
        Test ratio: 100 x executed / 120 = 50, 25, 25.
        """
        rows = run_view(
            [Job(1, 0, 100)],
            [
                Run(1, "A", "test_nn.py", 0, 55),
                Run(1, "A", "test_nn.py", 55, 60),
                Run(1, "B", "test_ops.py", 10, 40),
                Run(1, "C", "test_fx.py", 40, 70),
            ],
            owners={"test_nn.py": ["nn"], "test_ops.py": ["ops"], "test_fx.py": ["fx"]},
        )
        r = by_file(rows)
        self.assertRow(
            r["test_nn.py"],
            held_seconds=35.0,
            executed_test_seconds=60.0,
            occupancy_runner_seconds=50.0,
            test_ratio_runner_seconds=50.0,
            owners=["nn"],
        )
        self.assertRow(
            r["test_ops.py"],
            held_seconds=15.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=100 * 15 / 70,
            test_ratio_runner_seconds=25.0,
        )
        self.assertRow(
            r["test_fx.py"],
            held_seconds=20.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=100 * 20 / 70,
            test_ratio_runner_seconds=25.0,
        )
        self.assertInvariants(rows, wall=100, busy=70)

    def test_report_with_many_tests_is_one_span(self):
        """A report holds any number of tests; nothing requires one test per
        report. Its tests run one at a time, so the report is one span, first
        test start to last test end, sharing the runner with other reports.

            time   0         20        40   50   60
            A      [a1)[ a2 )[  a3   )                 three tests: 0-10, 10-25, 25-40
            B                [=============)           one test: 20-50

            stretch   running   each gets   A    B
            0-20      A         20          20
            20-40     A, B      10          10   10
            40-50     B         10               10
            50-60     (none)    overhead
            held                            30   20   busy 50

        Occupancy: 60 x held / 50 = 36, 24.
        Test ratio: 60 x executed / 70 = 34.285714 (A: 40 s), 25.714286 (B: 30 s).
        """
        rows = run_view(
            [Job(1, 0, 60)],
            [
                Run(1, "A", "a.py", 0, 10),
                Run(1, "A", "a.py", 10, 25),
                Run(1, "A", "a.py", 25, 40),
                Run(1, "B", "b.py", 20, 50),
            ],
        )
        r = by_file(rows)
        self.assertEqual(set(r), {"a.py", "b.py"})
        self.assertRow(
            r["a.py"],
            held_seconds=30.0,
            executed_test_seconds=40.0,
            occupancy_runner_seconds=36.0,
            test_ratio_runner_seconds=60 * 40 / 70,
        )
        self.assertRow(
            r["b.py"],
            held_seconds=20.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=24.0,
            test_ratio_runner_seconds=60 * 30 / 70,
        )
        self.assertInvariants(rows, wall=60, busy=50)

    def test_serial_no_gaps(self):
        """Files one after another filling the whole job: both methods agree.

            time   0       20      40      60
            A      [=======)                     a.py 0-20
            B              [=======)             b.py 20-40
            C                      [=======)     c.py 40-60

        Each holds its 20 s alone; busy 60 = wall, so occupancy = held = 20,
        and test ratio = 60 x 20 / 60 = 20.
        """
        rows = run_view(
            [Job(1, 0, 60)],
            [
                Run(1, "A", "a.py", 0, 20),
                Run(1, "B", "b.py", 20, 40),
                Run(1, "C", "c.py", 40, 60),
            ],
        )
        for row in by_file(rows).values():
            self.assertRow(
                row,
                held_seconds=20.0,
                occupancy_runner_seconds=20.0,
                test_ratio_runner_seconds=20.0,
            )
        self.assertInvariants(rows, wall=60, busy=60)

    def test_serial_with_setup_and_teardown(self):
        """Serial files inside a job with 10 s of setup and teardown each.

            time   0    10       30       50              90   100
            setup  ....
            A           [========)                                a.py 10-30
            B                    [========)                       b.py 30-50
            C                             [===============)       c.py 50-90
            tear                                               ....

        held 20, 20, 40 (busy 80); the 20 s of overhead goes to each file by
        held time: occupancy 100 x 20/80 = 25, 25, 50. Executed time equals
        held time when nothing overlaps, so the test ratio agrees: 25, 25, 50.
        """
        rows = run_view(
            [Job(1, 0, 100)],
            [
                Run(1, "A", "a.py", 10, 30),
                Run(1, "B", "b.py", 30, 50),
                Run(1, "C", "c.py", 50, 90),
            ],
        )
        r = by_file(rows)
        for name, held, charged in (
            ("a.py", 20.0, 25.0),
            ("b.py", 20.0, 25.0),
            ("c.py", 40.0, 50.0),
        ):
            self.assertRow(
                r[name],
                held_seconds=held,
                occupancy_runner_seconds=charged,
                test_ratio_runner_seconds=charged,
            )
        self.assertInvariants(rows, wall=100, busy=80)

    def test_touching_spans_do_not_overlap(self):
        """Spans are half-open: A ends at 10 exactly when B starts.

            time   0         10        20
            A      [=========)                a.py 0-10
            B                [=========)      b.py 10-20
            C      [===================)      c.py 0-20

            0-10: A, C share (5 each); 10-20: B, C share (5 each).
            Never three at once: held A 5, B 5, C 10.

        busy 20 = wall, so occupancy = held. Test ratio: 20 x executed / 40 =
        5, 5, 10.
        """
        rows = run_view(
            [Job(1, 0, 20)],
            [
                Run(1, "A", "a.py", 0, 10),
                Run(1, "B", "b.py", 10, 20),
                Run(1, "C", "c.py", 0, 20),
            ],
        )
        r = by_file(rows)
        for name, held in (("a.py", 5.0), ("b.py", 5.0), ("c.py", 10.0)):
            self.assertRow(
                r[name],
                held_seconds=held,
                occupancy_runner_seconds=held,
                test_ratio_runner_seconds=held,
            )
        self.assertInvariants(rows, wall=20, busy=20)

    def test_identical_spans_split_evenly(self):
        """Two reports over exactly the same 30 s: 15 s each, both ways.

        time   0                  30
        A      [==================)       a.py
        B      [==================)       b.py
        """
        rows = run_view(
            [Job(1, 0, 30)], [Run(1, "A", "a.py", 0, 30), Run(1, "B", "b.py", 0, 30)]
        )
        for row in by_file(rows).values():
            self.assertRow(
                row,
                held_seconds=15.0,
                occupancy_runner_seconds=15.0,
                test_ratio_runner_seconds=15.0,
            )
        self.assertInvariants(rows, wall=30, busy=30)

    def test_gap_inside_report_is_held_gap_between_reports_is_overhead(self):
        """A gap between two tests of one report belongs to that report; a gap
        with no report running is overhead, shared by held time.

            time   0    10        30   40        60   70             100
            A      [====)  gap    [====)                                 a.py runs 0-10, 30-40
            A span [===================)                                 one span 0-40
            B                                  [====)                    b.py 60-70
                                       no span       no span

        held A 40 (its 20 s gap included), B 10; busy 50, overhead 50.
        Occupancy: 100 x 40/50 = 80, 100 x 10/50 = 20.
        Test ratio: executed 20 and 10 of 30: 66.666667, 33.333333.
        """
        rows = run_view(
            [Job(1, 0, 100)],
            [
                Run(1, "A", "a.py", 0, 10),
                Run(1, "A", "a.py", 30, 40),
                Run(1, "B", "b.py", 60, 70),
            ],
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=40.0,
            executed_test_seconds=20.0,
            occupancy_runner_seconds=80.0,
            test_ratio_runner_seconds=100 * 20 / 30,
        )
        self.assertRow(
            r["b.py"],
            held_seconds=10.0,
            executed_test_seconds=10.0,
            occupancy_runner_seconds=20.0,
            test_ratio_runner_seconds=100 * 10 / 30,
        )
        self.assertInvariants(rows, wall=100, busy=50)

    def test_multi_file_report_is_one_span_per_file(self):
        """One report running two files in turn makes two spans.

            time   0         20         40
            A a    [=========)                  report A, a.py 0-20
            A b              [==========)       report A, b.py 20-40
            B c    [=========)                  report B, c.py 0-20

            0-20: (A, a.py) and (B, c.py) share: 10 each; 20-40: (A, b.py) alone.
            held a 10, b 20, c 10; busy 40 = wall, occupancy = held.

        Test ratio: each executed 20 of 60: 40 x 20/60 = 13.333333.
        """
        rows = run_view(
            [Job(1, 0, 40)],
            [
                Run(1, "A", "a.py", 0, 20),
                Run(1, "A", "b.py", 20, 40),
                Run(1, "B", "c.py", 0, 20),
            ],
        )
        r = by_file(rows)
        for name, held in (("a.py", 10.0), ("b.py", 20.0), ("c.py", 10.0)):
            self.assertRow(
                r[name],
                held_seconds=held,
                occupancy_runner_seconds=held,
                test_ratio_runner_seconds=40 * 20 / 60,
            )
        self.assertInvariants(rows, wall=40, busy=40)


class Skips(ToyCase):
    def test_skips_at_report_edges_set_span_bounds(self):
        """Skipped runs widen the span and count as test time, not executed time.

            time   0    5         10        20   25   30            100
            A      [ss)[===================)[ss)                         a.py: skip 0-5, pass 5-25, skip 25-30
            A span [=============================)                       0-30
            B                     [=========)                            b.py 10-20

            0-10: A alone 10; 10-20: A, B 5 each; 20-30: A alone 10.
            held A 25, B 5; busy 30.

        Occupancy: 100 x 25/30 = 83.333333, 100 x 5/30 = 16.666667.
        Test time, executed and skipped: A 20 + 10 = 30, B 10, job 40.
        Test ratio: 100 x 30/40 = 75, 100 x 10/40 = 25.
        """
        rows = run_view(
            [Job(1, 0, 100)],
            [
                Run(1, "A", "a.py", 0, 5, outcome="skipped"),
                Run(1, "A", "a.py", 5, 25),
                Run(1, "A", "a.py", 25, 30, outcome="skipped"),
                Run(1, "B", "b.py", 10, 20),
            ],
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=25.0,
            executed_test_seconds=20.0,
            skipped_test_seconds=10.0,
            occupancy_runner_seconds=100 * 25 / 30,
            test_ratio_runner_seconds=75.0,
        )
        self.assertRow(
            r["b.py"],
            held_seconds=5.0,
            executed_test_seconds=10.0,
            skipped_test_seconds=0.0,
            occupancy_runner_seconds=100 * 5 / 30,
            test_ratio_runner_seconds=25.0,
        )
        self.assertInvariants(rows, wall=100, busy=30)

    def test_skip_only_report_holds_time_but_has_no_executed_time(self):
        """A report whose only run was skipped still holds the runner.

            time   0         20   30   40        60
            A      [===================)              a.py pass 0-40
            B                [ss)                     b.py skip 20-30

            0-20: A 20; 20-30: A, B 5 each; 30-40: A 10. held A 35, B 5; busy 40.

        Occupancy: 60 x 35/40 = 52.5, 60 x 5/40 = 7.5.
        Test ratio, by test time executed and skipped (A 40, B 10, job 50):
        60 x 40/50 = 48, 60 x 10/50 = 12.
        """
        rows = run_view(
            [Job(1, 0, 60)],
            [
                Run(1, "A", "a.py", 0, 40),
                Run(1, "B", "b.py", 20, 30, outcome="skipped"),
            ],
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=35.0,
            occupancy_runner_seconds=52.5,
            test_ratio_runner_seconds=48.0,
        )
        self.assertRow(
            r["b.py"],
            held_seconds=5.0,
            executed_test_seconds=0.0,
            skipped_test_seconds=10.0,
            occupancy_runner_seconds=7.5,
            test_ratio_runner_seconds=12.0,
        )
        self.assertInvariants(rows, wall=60, busy=40)

    def test_all_skipped_job_splits_by_skipped_time(self):
        """No executed time anywhere in the job: the test ratio splits by
        skipped time, which is test time too. (It falls back to occupancy only
        when the runs took no time at all; see
        test_zero_duration_runs_far_apart_still_make_a_span.)

            time   0         10        20                     50
            A      [ss======)                                     a.py skip 0-10
            B      [ss=================)                          b.py skip 0-20

            0-10: A, B 5 each; 10-20: B 10. held A 5, B 15; busy 20.

        Occupancy: 50 x 5/20 = 12.5, 50 x 15/20 = 37.5.
        Test ratio (skipped A 10, B 20, job 30): 50 x 10/30, 50 x 20/30.
        """
        rows = run_view(
            [Job(1, 0, 50)],
            [
                Run(1, "A", "a.py", 0, 10, outcome="skipped"),
                Run(1, "B", "b.py", 0, 20, outcome="skipped"),
            ],
        )
        r = by_file(rows)
        for name, held, occupancy, skipped in (
            ("a.py", 5.0, 12.5, 10.0),
            ("b.py", 15.0, 37.5, 20.0),
        ):
            self.assertRow(
                r[name],
                held_seconds=held,
                executed_test_seconds=0.0,
                skipped_test_seconds=skipped,
                occupancy_runner_seconds=occupancy,
                test_ratio_runner_seconds=50 * skipped / 30,
            )
        self.assertInvariants(rows, wall=50, busy=20)


class Cpp(ToyCase):
    def test_modules_split_a_span_by_run_time(self):
        """A C++ binary's report covers two gtest suites (test_module); its one
        span splits between them by run time, and both fall back to the
        binary's owners.

            time   0         10        20
            Module [=========)                 two ModuleTest cases at once, 0-10 each (20 s run time)
                   [=========)
            Optim  [===================)       one OptimTest case 0-20 (20 s run time)
            span   [===================)       one span 0-20, alone: held 20

        Held 20 splits 20:20 by run time: 10 each. busy 20 = wall: occupancy 10
        each. Test ratio: executed 20 and 20 of 40: 10 each.
        """
        rows = run_view(
            [Job(1, 0, 20)],
            [
                Run(
                    1,
                    "X",
                    "cpp/test_api",
                    0,
                    10,
                    suite="ModuleTest",
                    language="cpp",
                    case="m1",
                ),
                Run(
                    1,
                    "X",
                    "cpp/test_api",
                    0,
                    10,
                    suite="ModuleTest",
                    language="cpp",
                    case="m2",
                ),
                Run(
                    1,
                    "X",
                    "cpp/test_api",
                    0,
                    20,
                    suite="OptimTest",
                    language="cpp",
                    case="o1",
                ),
            ],
            owners={"cpp/test_api": ["cpp"]},
        )
        r = by_file(rows)
        for name in ("cpp/test_api::ModuleTest", "cpp/test_api::OptimTest"):
            self.assertRow(
                r[name],
                held_seconds=10.0,
                executed_test_seconds=20.0,
                occupancy_runner_seconds=10.0,
                test_ratio_runner_seconds=10.0,
                owners=["cpp"],
            )
        self.assertInvariants(rows, wall=20, busy=20)

    def test_xdist_report_counts_as_one_span(self):
        """Three overlapping runs inside one report still make one span, so an
        xdist report shares the runner with a serial report 50/50. The test
        ratio charges it by its 3x executed time instead.

            time   0                  30
            X      [==================)       cpp/x: 3 runs 0-30 at once (90 s executed)
                   [==================)
                   [==================)
            P      [==================)       a.py 0-30 (30 s executed)

        held 15 each, occupancy 15 each (busy 30 = wall).
        Test ratio: 30 x 90/120 = 22.5, 30 x 30/120 = 7.5.
        """
        rows = run_view(
            [Job(1, 0, 30)],
            [
                Run(1, "X", "cpp/x", 0, 30, suite="S", language="cpp", case=f"c{i}")
                for i in range(3)
            ]
            + [Run(1, "P", "a.py", 0, 30)],
        )
        r = by_file(rows)
        self.assertRow(
            r["cpp/x::S"],
            held_seconds=15.0,
            executed_test_seconds=90.0,
            occupancy_runner_seconds=15.0,
            test_ratio_runner_seconds=22.5,
        )
        self.assertRow(
            r["a.py"],
            held_seconds=15.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=15.0,
            test_ratio_runner_seconds=7.5,
        )
        self.assertInvariants(rows, wall=30, busy=30)


class Clipping(ToyCase):
    def test_spans_clip_to_the_job_but_executed_time_does_not(self):
        """Runs that start before the job or end after it are clipped for
        occupancy; their executed time is counted whole.

            time   0    10        30        40   50   60
            job         [=============================)         10-50 (wall 40)
            A      [===================)                         a.py run 0-30 -> span 10-30
            B                               [=========)          b.py run 40-60 -> span 40-50

        held A 20, B 10; busy 30. Occupancy: 40 x 20/30 = 26.666667,
        40 x 10/30 = 13.333333. Executed A 30, B 20 (unclipped): test ratio
        40 x 30/50 = 24, 40 x 20/50 = 16.
        """
        rows = run_view(
            [Job(1, 10, 50)], [Run(1, "A", "a.py", 0, 30), Run(1, "B", "b.py", 40, 60)]
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=20.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=40 * 20 / 30,
            test_ratio_runner_seconds=24.0,
        )
        self.assertRow(
            r["b.py"],
            held_seconds=10.0,
            executed_test_seconds=20.0,
            occupancy_runner_seconds=40 * 10 / 30,
            test_ratio_runner_seconds=16.0,
        )
        self.assertInvariants(rows, wall=40, busy=30)

    def test_empty_spans_are_dropped(self):
        """A span of zero length after clipping is dropped with its runs: a
        zero-duration run (b.py at 5-5), and a run wholly after the job
        (c.py 30-40 in a 0-20 job: clipped to 30-20). a.py holds the job.

            time   0    5              20   30   40
            A      [===================)              a.py 0-20
            B           |                             b.py 5-5
            C                               [====)    c.py 30-40, after the job ends
        """
        rows = run_view(
            [Job(1, 0, 20)],
            [
                Run(1, "A", "a.py", 0, 20),
                Run(1, "B", "b.py", 5, 5),
                Run(1, "C", "c.py", 30, 40),
            ],
        )
        r = by_file(rows)
        self.assertEqual(sorted(r), ["a.py"])
        self.assertRow(
            r["a.py"],
            held_seconds=20.0,
            executed_test_seconds=20.0,
            occupancy_runner_seconds=20.0,
            test_ratio_runner_seconds=20.0,
        )
        self.assertInvariants(rows, wall=20, busy=20)

    def test_zero_duration_runs_far_apart_still_make_a_span(self):
        """Two zero-duration runs at 0 and 10 make a 0-10 span with no run time
        and no executed time: the span still holds the runner (its module gets
        all of it), and the test ratio falls back to occupancy.

            time   0         10
            A      |         |        a.py runs 0-0 and 10-10 -> span 0-10
        """
        rows = run_view(
            [Job(1, 0, 10)], [Run(1, "A", "a.py", 0, 0), Run(1, "A", "a.py", 10, 10)]
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=10.0,
            executed_test_seconds=0.0,
            occupancy_runner_seconds=10.0,
            test_ratio_runner_seconds=10.0,
        )
        self.assertInvariants(rows, wall=10, busy=10)


class Jobs(ToyCase):
    def test_which_jobs_get_rows(self):
        """A test job without reports is one row with test_file '' and its whole
        wall time both ways; a non-test job without reports gets no row; a job
        not named "test (...)" but with reports is attributed like any other.

            job 1  test job, no reports          0-100   -> '' row: 100 / 100, environment 0
            job 2  build job, no reports         0-50    -> no row
            job 3  lint job with a.py 5-15       0-20    -> a.py: held 10, charged its whole 20
        """
        rows = run_view(
            [Job(1, 0, 100), Job(2, 0, 50, name=BUILD), Job(3, 0, 20, name=LINT)],
            [Run(3, "A", "a.py", 5, 15)],
        )
        r = by_file(rows)
        self.assertEqual(sorted(r), ["", "a.py"])
        self.assertRow(
            r[""],
            test_module="",
            environments_id=0,
            owners=[],
            held_seconds=0.0,
            executed_test_seconds=0.0,
            skipped_test_seconds=0.0,
            occupancy_runner_seconds=100.0,
            test_ratio_runner_seconds=100.0,
        )
        self.assertRow(
            r["a.py"],
            environments_id=1,
            held_seconds=10.0,
            occupancy_runner_seconds=20.0,
            test_ratio_runner_seconds=20.0,
        )
        self.assertInvariants(rows, wall=120, busy=10)

    def test_runner_labels_split_rows(self):
        """Every row carries its jobs' runner labels, sorted (so their order in
        a workflow file does not matter): the same file
        on the same environment splits by label, and test jobs without reports
        get one row per label set.

            job 1  linux.2xlarge             a.py 0-30
            job 2  lf.linux.2xlarge          a.py 0-60
            job 3  linux.idc.xpu             no reports, 0-40
            job 4  self-hosted, linux.g5     no reports, 0-20 (stored [linux.g5, self-hosted])
        """
        rows = run_view(
            [
                Job(1, 0, 30, labels=["linux.2xlarge"]),
                Job(2, 0, 60, labels=["lf.linux.2xlarge"]),
                Job(3, 0, 40, labels=["linux.idc.xpu"]),
                Job(4, 0, 20, labels=["self-hosted", "linux.g5"]),
            ],
            [Run(1, "A", "a.py", 0, 30), Run(2, "A", "a.py", 0, 60)],
        )
        got = {(r["test_file"], ",".join(r["runner_labels"])): r for r in rows}
        self.assertEqual(
            sorted(got),
            [
                ("", "linux.g5,self-hosted"),
                ("", "linux.idc.xpu"),
                ("a.py", "lf.linux.2xlarge"),
                ("a.py", "linux.2xlarge"),
            ],
        )
        self.assertRow(got[("a.py", "linux.2xlarge")], occupancy_runner_seconds=30.0)
        self.assertRow(got[("a.py", "lf.linux.2xlarge")], occupancy_runner_seconds=60.0)
        self.assertRow(
            got[("", "linux.idc.xpu")], environments_id=0, occupancy_runner_seconds=40.0
        )
        self.assertRow(
            got[("", "linux.g5,self-hosted")], test_ratio_runner_seconds=20.0
        )
        self.assertInvariants(rows, wall=150, busy=90)

    def test_days_ci_runs_no_longer_holds_are_not_computed(self):
        """A day before the first day ci.runs holds in full gets no rows at all,
        not even rows for test jobs without reports: its runs are gone, so
        every job would look report-less, and that computation would replace
        the day's real one.

            retention floor 2026-11-02; window 2026-11-01 .. 11-03
            job 1  starts 11-01 00:00   a.py 0-10      excluded (before the floor)
            job 2  starts 11-02 00:00   b.py 0-10      counted
        """
        day = 86400
        rows = run_view(
            [Job(1, 0, 10), Job(2, day, day + 10)],
            [Run(1, "A", "a.py", 0, 10), Run(2, "A", "b.py", day, day + 10)],
            day_from="2026-11-01",
            day_to="2026-11-03",
            retention_floor="2026-11-02",
        )
        self.assertEqual(
            [(r["day"], r["test_file"]) for r in rows], [("2026-11-02", "b.py")]
        )
        self.assertInvariants(rows, wall=10, busy=10)

    def test_excluded_jobs(self):
        """Jobs the cost API does not count are left out with their runs:
        a rerun whose started_at predates its created_at (stale start), a
        skipped job, a job still running, and one with no runner. Only job 5
        remains.

            job 1  created 50 > started 0 (stale start)   b.py 0-10   excluded
            job 2  conclusion skipped                      c.py 0-10   excluded
            job 3  status in_progress                      d.py 0-10   excluded
            job 4  runner_name ''                          e.py 0-10   excluded
            job 5  normal 0-10                             a.py 0-10   10 / 10
        """
        rows = run_view(
            [
                Job(1, 0, 10, created=50),
                Job(2, 0, 10, conclusion="skipped"),
                Job(3, 0, 10, status="in_progress"),
                Job(4, 0, 10, runner=""),
                Job(5, 0, 10),
            ],
            [
                Run(1, "B", "b.py", 0, 10),
                Run(2, "C", "c.py", 0, 10),
                Run(3, "D", "d.py", 0, 10),
                Run(4, "E", "e.py", 0, 10),
                Run(5, "A", "a.py", 0, 10),
            ],
        )
        r = by_file(rows)
        self.assertEqual(sorted(r), ["a.py"])
        self.assertRow(
            r["a.py"], occupancy_runner_seconds=10.0, test_ratio_runner_seconds=10.0
        )
        self.assertInvariants(rows, wall=10, busy=10)

    def test_latest_job_version_wins(self):
        """workflow_job can hold a job twice before merges: the latest version
        (completed at 60) is used once, not the older one (100), not both.

            job 1  version 0: 0-100   version 1: 0-60   a.py 0-30
            a.py holds 30 of busy 30: charged the whole 60, both ways.
        """
        rows = run_view(
            [Job(1, 0, 100, version=0), Job(1, 0, 60, version=1)],
            [Run(1, "A", "a.py", 0, 30)],
        )
        r = by_file(rows)
        self.assertRow(
            r["a.py"],
            held_seconds=30.0,
            occupancy_runner_seconds=60.0,
            test_ratio_runner_seconds=60.0,
        )
        self.assertInvariants(rows, wall=60, busy=30)

    def test_rows_sum_jobs_and_split_by_workflow_and_machine(self):
        """Rows sum every job of a day with the same workflow, file, module and
        environment, and split otherwise.

            job 1  pull,  env 1, a.py 0-10 in a 0-10 job   -> pull a.py env 1: 10
            job 2  pull,  env 1, a.py 0-20 in a 0-20 job   ->   (summed)    +20 = 30
            job 3  pull,  env 2, a.py 0-5  in a 0-5 job    -> pull a.py env 2: 5
            job 4  trunk, env 1, a.py 0-7  in a 0-7 job    -> trunk a.py env 1: 7
        """
        rows = run_view(
            [
                Job(1, 0, 10),
                Job(2, 0, 20),
                Job(3, 0, 5),
                Job(4, 0, 7, workflow="trunk"),
            ],
            [
                Run(1, "A", "a.py", 0, 10),
                Run(2, "A", "a.py", 0, 20),
                Run(3, "A", "a.py", 0, 5, env=2),
                Run(4, "A", "a.py", 0, 7),
            ],
        )
        # The workflow file's name, without .github/workflows/ and .yml.
        got = {(r["workflow_path"][18:-4], r["environments_id"]): r for r in rows}
        self.assertEqual(sorted(got), [("pull", 1), ("pull", 2), ("trunk", 1)])
        self.assertRow(
            got[("pull", 1)],
            held_seconds=30.0,
            executed_test_seconds=30.0,
            occupancy_runner_seconds=30.0,
        )
        self.assertRow(got[("pull", 2)], held_seconds=5.0, occupancy_runner_seconds=5.0)
        self.assertRow(
            got[("trunk", 1)], held_seconds=7.0, occupancy_runner_seconds=7.0
        )
        self.assertInvariants(rows, wall=42, busy=42)

    def test_job_crossing_midnight_belongs_to_its_start_day(self):
        """A job that starts at 23:59 and runs past midnight is counted on its
        start day, with runs from the next day included; a job starting on the
        next day (outside the window) is not.

            job 1  23:59:00-00:11:00 (wall 720), a.py 00:00:00-00:10:00 (600)
            job 2  starts 2026-11-02 00:30 -> outside the window, no row
        """
        day = 86400
        rows = run_view(
            [Job(1, day - 60, day + 660), Job(2, day + 1800, day + 1900)],
            [
                Run(1, "A", "a.py", day, day + 600),
                Run(2, "A", "b.py", day + 1800, day + 1850),
            ],
        )
        r = by_file(rows)
        self.assertEqual(sorted(r), ["a.py"])
        self.assertRow(
            r["a.py"],
            day="2026-11-01",
            held_seconds=600.0,
            executed_test_seconds=600.0,
            occupancy_runner_seconds=720.0,
            test_ratio_runner_seconds=720.0,
        )
        self.assertInvariants(rows, wall=720, busy=600)


# The trigger the view records for a run's (event, branch); event None is a run
# missing from workflow_run. 000005's rule, mirrored by reference.trigger: the
# one table to change with that mapping.
TRIGGERS = [
    ("push", "main", "push:main"),
    ("push", "master", "push:main"),
    # Only a push: other events on main are other.
    ("schedule", "main", "other"),
    ("workflow_dispatch", "main", "other"),
    ("pull_request", "main", "other"),  # a fork PR from its main branch
    ("pull_request", "my-feature", "other"),
    ("push", "ciflow/trunk/123", "other"),
    ("workflow_dispatch", "trunk/" + "f" * 40, "other"),
    ("push", "viable/strict", "other"),
    ("push", "release/2.15", "other"),
    (None, "", "other"),
]


class Triggers(ToyCase):
    def test_each_trigger(self):
        """Each job's row records its run's trigger, as TRIGGERS gives it: job
        i, alone in workflow w<i>, runs a.py for its whole 10 x i s and is
        charged 10 x i. A job whose run is missing from workflow_run is still
        counted, with no workflow path.
        """
        jobs = [
            Job(i, 0, 10 * i, workflow=f"w{i}", event=event, branch=branch)
            for i, (event, branch, _) in enumerate(TRIGGERS, 1)
        ]
        rows = run_view(jobs, [Run(j.id, "A", "a.py", 0, j.end) for j in jobs])
        got = {r["workflow_path"]: r for r in rows}
        self.assertEqual(len(got), len(rows))
        for job, (event, branch, trigger) in zip(jobs, TRIGGERS):
            path = workflow_path(job.workflow) if event is not None else ""
            with self.subTest(event=event, branch=branch):
                self.assertRow(
                    got[path], trigger=trigger, occupancy_runner_seconds=job.end
                )
        wall = sum(j.end for j in jobs)
        self.assertInvariants(rows, wall=wall, busy=wall)

    def test_trigger_enum_matches_the_table(self):
        """The view casts trigger to test_cost.trigger's Enum8 (000004), as
        health_mv does for ran_on, and the Enum8 holds exactly the triggers
        TRIGGERS records."""
        enum = r"Enum8\([^)]*\)"
        table = re.search(rf"`trigger` ({enum})", TABLE_SQL.read_text()).group(1)
        view = re.search(rf"CAST\(g\.trigger AS ({enum})\)", VIEW_SQL.read_text())
        self.assertEqual(view.group(1), table)
        self.assertEqual(
            set(re.findall(r"'([^']*)' = \d+", table)), {t for _, _, t in TRIGGERS}
        )

    def test_triggers_split_a_file_and_keep_its_totals(self):
        """Jobs alike but for their trigger get a row each; the rows add up to
        the one row they make with a single trigger.

            job 1  pull_request         a.py 0-20 in a 0-30 job
            job 2  push to main         a.py 0-40 in a 0-50 job
            split:  job 1's trigger 30 (held 20), job 2's 50 (held 40)
            alike:  one row, 80 (held 60)
        """
        runs = [Run(1, "A", "a.py", 0, 20), Run(2, "A", "a.py", 0, 40)]
        split = run_view(
            [Job(1, 0, 30), Job(2, 0, 50, event="push", branch="main")], runs
        )
        alike = run_view([Job(1, 0, 30), Job(2, 0, 50)], runs)
        first, second = sorted(split, key=lambda r: r["held_milliseconds"])
        self.assertNotEqual(first["trigger"], second["trigger"])
        self.assertRow(first, held_seconds=20.0, occupancy_runner_seconds=30.0)
        self.assertRow(second, held_seconds=40.0, occupancy_runner_seconds=50.0)
        self.assertEqual(len(alike), 1)
        for column in alike[0]:
            if column.endswith("_milliseconds"):
                self.assertEqual(
                    sum(r[column] for r in split), alike[0][column], msg=column
                )
        self.assertInvariants(split, wall=80, busy=60)


class Owners(ToyCase):
    def test_owner_snapshots(self):
        """owners is the file's owners when computed: both owners of a
        file with two, empty for a file with none, and a C++ module falls
        back to its binary's owners.

            a.py           owners [nn, cuda]
            b.py           no owners entry
            cpp/test_api   owners [cpp] (file level; no (file, module) entry)
        """
        rows = run_view(
            [Job(1, 0, 30)],
            [
                Run(1, "A", "a.py", 0, 10),
                Run(1, "B", "b.py", 10, 20),
                Run(1, "C", "cpp/test_api", 20, 30, suite="ModuleTest", language="cpp"),
            ],
            owners={"a.py": ["nn", "cuda"], "cpp/test_api": ["cpp"]},
        )
        r = by_file(rows)
        self.assertEqual(sorted(r["a.py"]["owners"]), ["cuda", "nn"])
        self.assertEqual(r["b.py"]["owners"], [])
        self.assertEqual(r["cpp/test_api::ModuleTest"]["owners"], ["cpp"])
        self.assertInvariants(rows, wall=30, busy=30)


if __name__ == "__main__":
    unittest.main()
