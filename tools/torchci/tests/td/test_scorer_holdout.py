import tempfile
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.scorer import gate, holdout, logs, rows, rows_sql, shards, store
from torchci.td.scorer.gate import Gate, HoldoutReport, WindowReport


TIMES = {"linux-a": {"default": {"a": 10.0, "b": 10.0, "c": 10.0, "d": 100.0}}}


def model():
    scorer = {
        "intercept": -5.0,
        "cost_weight": 0.0,
        "heuristics": {"Filepath": {"weight": 1.0, "x": [0.0, 1.0], "y": [0.01, 0.9]}},
        "build_env": {},
        "test_config": {},
    }
    return {"overhead_seconds": rows.OVERHEAD_SECONDS, "scorer": scorer}


def run(run_id, pr, created, scores, aggregated):
    return shards.Run(
        run_id,
        pr,
        f"{run_id:040d}",
        created,
        ["Filepath"],
        [],
        {"Filepath": scores},
        None,
        aggregated,
    )


def unit(run_id, failed, main_broken=()):
    return shards.Unit(
        run_id,
        "linux-a",
        "default",
        ["a", "b", "c", "d"],
        [],
        list(failed),
        [],
        list(main_broken),
    )


# Run 1: TD's include list is a and b (no aggregated scores), the scorer's cut takes c
# (scored) then a. Run 2 repeats run 1's failure. Run 3: TD includes d and a (T = 158 s),
# the scorer fills a, b and c and misses d. Run 4's failure is broken on main.
RUNS = {
    1: run(1, 7, "2026-09-01 01:00:00", {"c": 1.0}, {}),
    2: run(2, 7, "2026-09-02 01:00:00", {"c": 1.0}, {}),
    3: run(3, 8, "2026-09-03 01:00:00", {}, {"d": 1.0}),
    4: run(4, 9, "2026-09-04 01:00:00", {}, {}),
}
UNITS = {
    1: unit(1, ["c"]),
    2: unit(2, ["c"]),
    3: unit(3, ["d"]),
    4: unit(4, ["a"], ["a"]),
}


def holdout_set(run_ids, errors=0):
    return shards.DayShard(
        "holdout-v1",
        runs=[RUNS[i] for i in run_ids],
        units=[UNITS[i] for i in run_ids],
        meta={
            "errors": errors,
            "heads_with_td_job": len(run_ids),
            "heads_with_log": len(run_ids),
        },
    )


@mock.patch.object(holdout, "MIN_HOLDOUT_EVENTS", 1)
class TestEvaluateHoldout(TestCase):
    def evaluate(self, run_ids, errors=0):
        return holdout.evaluate_holdout(
            model(), holdout_set(run_ids, errors), rows.JobTimes(TIMES)
        )

    def test_scorer_catches_more(self) -> None:
        r = self.evaluate([1, 2, 4])
        self.assertEqual((r.events, r.prs, r.td_caught, r.scorer_caught), (1, 1, 0, 1))
        self.assertEqual((r.jobs, r.td_files, r.scorer_files), (1, 2, 2))
        self.assertTrue(r.scorer_ok)
        self.assertIn("1 events in 1 PRs", r.text())

    def test_scorer_catches_fewer(self) -> None:
        r = self.evaluate([3])
        self.assertEqual((r.events, r.td_caught, r.scorer_caught), (1, 1, 0))
        self.assertFalse(r.scorer_ok)

    def test_tie_passes(self) -> None:
        r = self.evaluate([1, 3])
        self.assertEqual((r.events, r.prs, r.td_caught, r.scorer_caught), (2, 2, 1, 1))
        self.assertTrue(r.scorer_ok)

    def test_must_run_failures_left_out(self) -> None:
        # Run 1's failing file c, scored by EditedByPR: the scorer's cut always runs it
        # and TD's include list (a and b) does not, so it is no event for either side.
        edited = shards.Run(
            1,
            7,
            f"{1:040d}",
            "2026-09-01 01:00:00",
            ["Filepath", "EditedByPR"],
            [],
            {"Filepath": {"c": 1.0}, "EditedByPR": {"c": 1.0}},
            None,
            {},
        )
        shard = holdout_set([1, 3])
        shard.runs[0] = edited
        r = holdout.evaluate_holdout(model(), shard, rows.JobTimes(TIMES))
        self.assertEqual((r.events, r.prs, r.td_caught, r.scorer_caught), (1, 1, 1, 0))
        self.assertEqual((r.must_run_events, r.jobs), (1, 1))
        self.assertIn("1 must-run events left out", r.text())

    def test_unsound_or_empty_set_fails(self) -> None:
        self.assertFalse(self.evaluate([1], errors=1).scorer_ok)
        self.assertFalse(self.evaluate([4]).scorer_ok)
        self.assertFalse(holdout.holdout_ok(holdout_set([], 0)))

    def test_holdout_ok_bounds(self) -> None:
        held = holdout_set([1, 3])
        self.assertTrue(holdout.holdout_ok(held))
        held.meta.update(heads_with_td_job=100, heads_with_log=84)
        self.assertFalse(holdout.holdout_ok(held))
        held.meta.update(heads_with_log=85)
        self.assertTrue(holdout.holdout_ok(held))
        with mock.patch.object(holdout, "MIN_HOLDOUT_EVENTS", 3):
            self.assertFalse(holdout.holdout_ok(held))
        for key in ("heads_with_td_job", "heads_with_log"):
            partial = holdout_set([1, 3])
            del partial.meta[key]
            self.assertFalse(holdout.holdout_ok(partial))


class TestPublishRule(TestCase):
    def report(self, recall_sum, prs, scorer_caught, td_caught=1):
        held = HoldoutReport(
            healthy=True, events=2, td_caught=td_caught, scorer_caught=scorer_caught
        )
        return Gate(
            held, prs_with_events=prs, scorer_score=recall_sum, td_score=float(prs)
        )

    def test_pooled(self) -> None:
        held = HoldoutReport(healthy=True, events=1, scorer_caught=1)
        windows = [
            WindowReport(["a"], prs_with_events=20, pr_recall_sum=10, td_recall_sum=19),
            WindowReport(["b"], prs_with_events=15, pr_recall_sum=12, td_recall_sum=15),
        ]
        pooled = Gate.pooled(held, windows)
        self.assertEqual(
            (pooled.prs_with_events, pooled.scorer_score, pooled.td_score),
            (35, 22, 34),
        )
        self.assertTrue(pooled.passed)
        self.assertFalse(Gate.pooled(held, windows[:1]).passed)
        self.assertFalse(Gate.pooled(held, []).passed)
        self.assertIn("floor (pooled walk-forward)", pooled.text())
        self.assertTrue(pooled.summary()["passed"])

    def test_too_few_prs(self) -> None:
        self.assertFalse(
            self.report(gate.MIN_FLOOR_PRS - 1, gate.MIN_FLOOR_PRS - 1, 1).passed
        )
        self.assertTrue(self.report(gate.MIN_FLOOR_PRS, gate.MIN_FLOOR_PRS, 1).passed)

    @mock.patch.object(gate, "MIN_FLOOR_PRS", 1)
    def test_both_needed(self) -> None:
        self.assertTrue(self.report(0.6, 1, 1).passed)
        self.assertFalse(self.report(0.59, 1, 1).passed)
        self.assertFalse(self.report(0.6, 1, 0).passed)
        self.assertFalse(self.report(0.0, 0, 1).passed)
        low = self.report(0.5, 1, 1)
        low.floor_ratio = 0.5
        self.assertTrue(low.passed)
        self.assertEqual(gate.FLOOR_RATIO, 0.60)
        self.assertIn("result: PASS", self.report(0.6, 1, 1).text())


class TestBuild(TestCase):
    def test_units_sql_shape(self) -> None:
        sql = holdout.UNITS_SQL
        self.assertIn(rows_sql.OUTCOMES, sql)
        self.assertIn("ON j.id = o.job_id AND j.run_id = o.workflow_id", sql)
        self.assertIn("true AS job_failed", sql)

    def queries(self, name, sql, params):
        if name == "td_holdout_runs":
            self.assertEqual(params["workflow"], holdout.HOLDOUT_WORKFLOW)
            return [
                {
                    "run_id": "1",
                    "created_at": "2026-09-01 01:00:00",
                    "head_sha": "h1",
                    "pr": "7",
                },
                {
                    "run_id": "2",
                    "created_at": "2026-09-02 01:00:00",
                    "head_sha": "h2",
                    "pr": "8",
                },
            ]
        if name == "td_holdout_td_jobs":
            return [
                {"head_sha": "h1", "td_job_id": "11"},
                {"head_sha": "h2", "td_job_id": "12"},
            ]
        if name == "td_holdout_units":
            self.assertEqual(params["runs"], [1, 2])
            row = {
                "build_env": "linux-a",
                "test_config": "default",
                "ran": ["b", "a"],
                "failed": ["a", "b"],
                "neither": [],
            }
            return [
                {"run_id": "1", **row},
                {"run_id": "1", **row, "build_env": "macos-a"},
                {"run_id": "2", **row},
            ]
        if name == "td_holdout_main":
            if params["start"].startswith("2026-09-01"):
                return [
                    {"build_env": "linux-a", "test_config": "default", "test_file": "b"}
                ]
            return []
        raise AssertionError(name)

    def build(self, log_for):
        with mock.patch.object(
            holdout, "query", side_effect=self.queries
        ), mock.patch.object(holdout, "fetch_td_log", side_effect=log_for):
            return holdout.build_holdout()

    @mock.patch.object(holdout, "MIN_HOLDOUT_EVENTS", 3)
    def test_build(self) -> None:
        log = logs.TDLog(
            {"Filepath": {"a": 0.5}}, ("Filepath",), (), ("x.py",), {"a": 1.0}
        )
        shard = self.build(lambda job_id: log)
        self.assertEqual([r.run_id for r in shard.runs], [1, 2])
        self.assertEqual(shard.runs[0].aggregated, {"a": 1.0})
        self.assertEqual(len(shard.units), 2)
        u1, u2 = shard.units
        self.assertEqual(
            (u1.run_id, u1.ran, u1.excluded, u1.failed, u1.main_broken),
            (1, ["a", "b"], [], ["a", "b"], ["b"]),
        )
        self.assertEqual((u2.run_id, u2.main_broken), (2, []))
        self.assertEqual(
            (shard.meta["heads_with_td_job"], shard.meta["heads_with_log"]), (2, 2)
        )
        self.assertTrue(holdout.holdout_ok(shard))

        half = self.build(lambda job_id: log if job_id == 11 else None)
        self.assertEqual([r.run_id for r in half.runs], [1])
        self.assertFalse(holdout.holdout_ok(half))
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            holdout, "build_holdout", return_value=half
        ):
            dirs = store.DirStore(Path(d))
            holdout.load_or_build(dirs)
            self.assertFalse(dirs.exists(holdout.HOLDOUT_KEY))

        def fail(job_id):
            raise logs.requests.HTTPError("403")

        self.assertFalse(holdout.holdout_ok(self.build(fail)))

    @mock.patch.object(holdout, "MIN_HOLDOUT_EVENTS", 1)
    def test_load_or_build(self) -> None:
        good = holdout_set([1])
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            holdout, "build_holdout", side_effect=[holdout_set([1], errors=1), good]
        ) as build:
            dirs = store.DirStore(Path(d))
            self.assertEqual(holdout.load_or_build(dirs).meta["errors"], 1)
            self.assertFalse(dirs.exists(holdout.HOLDOUT_KEY))
            holdout.load_or_build(dirs)
            self.assertTrue(dirs.exists(holdout.HOLDOUT_KEY))
            self.assertTrue(dirs.exists(store.SHARD_FORMAT))
            self.assertEqual(holdout.load_or_build(dirs).units, good.units)
            self.assertEqual(build.call_count, 2)
        with mock.patch.object(holdout, "build_holdout", return_value=good):
            self.assertEqual(holdout.load_or_build(None).units, good.units)


if __name__ == "__main__":
    main()
