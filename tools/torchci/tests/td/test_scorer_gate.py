import dataclasses
import json
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.scorer import (
    __main__ as cli,
    gate,
    holdout,
    logs,
    model_json,
    risk,
    rows,
    shards,
    start_up,
    store,
    train,
    trunk,
    walkforward,
)


# Run 0 of 2026-10-06, a training day of the main refit below, is also a holdout PR.
HELD_PR = date(2026, 10, 6).toordinal() * 100
TIMES = {"linux-a": {"default": {"a": 10.0, "b": 10.0, "c": 10.0, "d": 100.0}}}
START_UP = {"linux-a": {"default": 24.0}}


def model(weight=1.0):
    scorer = {
        "intercept": -5.0,
        "cost_weight": 0.0,
        "heuristics": {
            "Filepath": {"weight": weight, "x": [0.0, 1.0], "y": [0.01, 0.9]}
        },
        "build_env": {},
        "test_config": {},
    }
    risk = {
        "intercept": 0.0,
        "features": {"n_files": {"weight": 1.0, "mean": 0.0, "scale": 1.0}},
        "quantiles": [i / 100 for i in range(101)],
    }
    return model_json.build_model("2026-11-10", scorer, risk, START_UP)


def run(run_id, pr, sha, created, scores, aggregated=None, heuristic="Filepath"):
    return shards.Run(
        run_id,
        pr,
        sha,
        created,
        [heuristic],
        [],
        {heuristic: scores},
        ["torch/a.py"],
        aggregated or {},
    )


def unit(run_id, failed=(), ran=("a", "b"), excluded=("c", "d")):
    return shards.Unit(
        run_id, "linux-a", "default", list(ran), list(excluded), list(failed), [], []
    )


def p_file(model, scores, raised, build_env, test_config, test_file, cost):
    p = model_json.p_files(
        model, scores, raised, build_env, test_config, [test_file], np.array([cost])
    )
    return float(p[0])


class TestCut(TestCase):
    def test_scorer_cut(self) -> None:
        files = ["a", "b", "c", "d"]
        p = np.array([0.1, 0.1, 0.5, 0.9])
        costs = np.array([10.0, 10.0, 10.0, 100.0])
        self.assertEqual(gate.scorer_cut(files, p, costs, 20000, set()), {"a", "c"})
        self.assertEqual(
            gate.scorer_cut(files, p, costs, 100000, set()), {"a", "b", "c"}
        )
        self.assertEqual(gate.scorer_cut(files, p, costs, 0, set()), set())
        self.assertEqual(gate.scorer_cut(files, p, costs, 130000, set()), set(files))
        self.assertEqual(gate.scorer_cut(files, p, costs, 20000, {"d"}), {"d"})
        self.assertEqual(
            gate.scorer_cut(files, p, costs, 120000, {"d", "b"}), {"b", "c", "d"}
        )

    def test_int_ms(self) -> None:
        self.assertEqual(gate.cost_ms(0.0015), 2)
        self.assertEqual(gate.cost_ms(24.0004), 24000)
        files = ["a", "b", "c"]
        costs = np.array([0.1, 0.2, 0.3])
        # 0.1 + 0.2 > 0.3 in floats; in integer ms both fit exactly.
        self.assertEqual(
            gate.scorer_cut(files, np.array([0.9, 0.9, 0.0]), costs, 300, set()),
            {"a", "b"},
        )

    def test_td_include(self) -> None:
        files = list("abcdefgh")
        self.assertEqual(gate.td_include(files, {"g": 2.0, "c": 1.0}), ["g", "c", "a"])
        self.assertEqual(gate.td_include(["b", "a", "c"], {}), ["a"])
        self.assertEqual(gate.td_include([], {}), [])

    def test_must_run_files(self) -> None:
        r = run(1, 7, "a" * 40, "t", {})
        r = shards.Run(
            **{
                **r.__dict__,
                "scores": {
                    "EditedByPR": {"a": 1.0, "z": 0.0},
                    "PreviouslyFailedInPR": {"b": 1.0},
                    "Filepath": {"c": 1.0},
                },
                "raised": ["PreviouslyFailedInPR"],
            }
        )
        self.assertEqual(gate.must_run_files(r), {"a"})


class TestEvaluateGate(TestCase):
    def shards(self):
        day1 = shards.DayShard(
            "2026-11-08",
            runs=[
                run(1, 7, "a" * 40, "2026-11-08 01:00:00", {"c": 1.0}),
                run(2, 8, "b" * 40, "2026-11-08 02:00:00", {}),
                run(3, 9, "c" * 40, "2026-11-08 03:00:00", {"c": 1.0}),
            ],
            units=[unit(1, failed=["a"]), unit(2, failed=["b"]), unit(3, failed=["a"])],
        )
        day2 = shards.DayShard(
            "2026-11-09",
            runs=[run(4, 7, "d" * 40, "2026-11-09 01:00:00", {"c": 1.0})],
            units=[unit(4, failed=["a", "b"])],
        )
        return [day1, day2]

    def test_events_and_trunk(self) -> None:
        landings = [
            trunk.TrunkLanding(
                "l1",
                "2026-11-09",
                (trunk.TrunkPair(7, "a" * 40, "linux-a", "default", "c"),),
            ),
            trunk.TrunkLanding(
                "l2",
                "2026-11-09",
                (trunk.TrunkPair(7, "a" * 40, "linux-a", "default", "d"),),
            ),
            trunk.TrunkLanding(
                "l3",
                "2026-11-09",
                (trunk.TrunkPair(5, "z" * 40, "linux-a", "default", "c"),),
            ),
        ]
        report = gate.evaluate_window(
            model(), self.shards(), {7, 8}, landings, rows.JobTimes(TIMES, START_UP)
        )
        self.assertEqual(report.days, ["2026-11-08", "2026-11-09"])
        # TD's include list is a and b (no aggregated scores: name order), so T = 68 s;
        # run 1's cut takes c (scored) then a.
        self.assertEqual(report.pr_events, 3)
        self.assertEqual(report.pr_caught, 2)
        self.assertEqual(report.td_include_caught, 3)
        self.assertEqual(report.prs_with_events, 2)
        self.assertEqual(report.pr_recall_sum, 1.5)
        self.assertEqual(report.trunk_landings, 3)
        self.assertEqual(report.trunk_caught, 1)
        self.assertEqual(report.trunk_pairs_without_job, 1)
        self.assertEqual(report.td_recall_sum, 2.0)
        self.assertEqual((report.units, report.prs), (4, 2))
        self.assertEqual(report.risk["heads"], 3)
        self.assertEqual(len(report.risk_r), 3)
        self.assertEqual(sum(report.risk_label), 3)

    def test_sample(self) -> None:
        sample = gate.sample_model(
            model(), self.shards(), rows.JobTimes(TIMES, START_UP)
        )
        self.assertEqual(len(sample.jobs), 4)
        self.assertTrue(sample.r)
        json.dumps(dataclasses.asdict(sample))
        m = model()
        for row in sample.p:
            self.assertAlmostEqual(
                row["p"],
                p_file(
                    m,
                    {h: {"x": s} for h, s in row["scores"].items()},
                    set(row["raised"]),
                    row["build_env"],
                    row["test_config"],
                    "x",
                    row["cost"],
                ),
            )

    @mock.patch.object(gate, "MIN_FLOOR_PRS", 2)
    def test_floor(self) -> None:
        times = rows.JobTimes(TIMES, START_UP)
        window = gate.evaluate_window(model(), self.shards(), {7, 8}, [], times)
        held = gate.HoldoutReport(healthy=True, events=1, scorer_caught=1)
        result = gate.Gate.pooled(held, [window], 0.8)
        self.assertEqual((result.scorer_score, result.td_score), (1.5, 2.0))
        self.assertFalse(result.floor_ok)
        self.assertFalse(result.passed)
        result.floor_ratio = 0.7
        self.assertTrue(result.passed)
        self.assertIn("result: PASS", result.text())
        held.scorer_caught = -1
        self.assertTrue(result.passed)
        self.assertIn("(report only; scorer >= TD: no)", result.text())

    def test_td_include_sets_the_budget(self) -> None:
        shard = shards.DayShard(
            "2026-11-08",
            runs=[
                run(1, 7, "a" * 40, "t", {"c": 1.0}, aggregated={"d": 2.0, "c": 1.0})
            ],
            units=[unit(1, failed=["b"])],
        )
        times = rows.JobTimes(TIMES, START_UP)
        report = gate.evaluate_window(model(), [shard], {7}, [], times)
        # T = cost(d) + cost(c) = 158 s: c, a and b fit, d does not.
        self.assertEqual((report.pr_events, report.pr_caught), (1, 1))
        self.assertEqual(report.td_include_caught, 0)
        self.assertEqual((report.pr_recall_sum, report.td_recall_sum), (1.0, 0.0))
        sample = gate.sample_model(model(), [shard], times)
        self.assertEqual(sample.jobs[0]["include"], ["c", "d"])
        self.assertEqual(sample.jobs[0]["selected"], ["a", "b", "c"])

    def test_a_config_without_start_up_keeps_td_cut(self) -> None:
        shard = shards.DayShard(
            "2026-11-08",
            runs=[
                run(1, 7, "a" * 40, "t", {"c": 1.0}, aggregated={"d": 2.0, "c": 1.0})
            ],
            units=[unit(1, failed=["b"])],
        )
        times = rows.JobTimes(TIMES, {"linux-a": {"other": 24.0}})
        sample = gate.Sample()
        ev = gate.Evaluator(model(), times)
        selected, include = ev.cut(shard.runs[0], shard.units[0], sample)
        self.assertEqual((selected, include), ({"c", "d"}, {"c", "d"}))
        self.assertEqual(sample.p, [])
        self.assertEqual(sample.jobs[0]["selected"], ["c", "d"])
        report = gate.evaluate_window(model(), [shard], {7}, [], times)
        self.assertEqual((report.pr_events, report.pr_caught), (1, 0))
        self.assertEqual(report.pr_recall_sum, report.td_recall_sum)

    def test_must_run_events_left_out(self) -> None:
        edited = run(1, 7, "a" * 40, "t", {"a": 1.0}, heuristic="EditedByPR")
        later = run(2, 7, "b" * 40, "u", {})
        shard = shards.DayShard(
            "2026-11-08",
            runs=[edited, later],
            units=[unit(1, failed=["a"]), unit(2, failed=["a", "b"])],
        )
        report = gate.evaluate_window(
            model(), [shard], {7}, [], rows.JobTimes(TIMES, START_UP)
        )
        self.assertEqual(report.must_run_events, 1)
        self.assertEqual((report.pr_events, report.prs_with_events), (1, 1))


FAKE_SCORER_MODEL = """
import json

import numpy as np
from torchci.td.scorer import model_json, risk

def parse_model(raw):
    return json.loads(raw)

def file_probability(model, scores, cost, build_env_key, test_config, raised=()):
    p = model_json.p_files(model, {h: {"f": s} for h, s in scores.items()}, set(raised),
                           build_env_key, test_config, ["f"], np.array([cost]))
    return float(p[0]) + OFFSET

def risk_score(model, features):
    return risk.risk_r(model, features)

OFFSET = __OFFSET__
"""


FAKE_TEST_RUN = """
class TestRun:
    def __init__(self, test_file):
        self.test_file = test_file
"""

FAKE_SCORER = """
import statistics

import numpy as np
from tools.testing.test_run import TestRun
from torchci.td.scorer import gate, model_json

SELECT_NOTHING = __SELECT_NOTHING__


class NoModel(Exception):
    pass


def select_tests(block, include, exclude, times, build_env_key, test_config):
    if SELECT_NOTHING:
        return [], include + exclude, {}
    model, scores, raised = block["model"], block["heuristics"], set(block["raised"])
    start_up = model["start_up_seconds"].get(build_env_key, {}).get(test_config)
    if start_up is None:
        raise NoModel(f"no start-up for {build_env_key}/{test_config}")
    files = sorted({t.test_file for t in include + exclude})
    median = statistics.median(times.values()) if times else 0.0
    costs = np.array([times.get(f, median) + start_up for f in files])
    p = model_json.p_files(model, scores, raised, build_env_key, test_config, files, costs)
    inc = {t.test_file for t in include}
    budget = sum(gate.cost_ms(c) for f, c in zip(files, costs) if f in inc)
    must = {
        f
        for name in gate.MUST_RUN_HEURISTICS
        if name not in raised
        for f, s in scores.get(name, {}).items()
        if s
    }
    return [TestRun(f) for f in gate.scorer_cut(files, p, costs, budget, must)], [], {}
"""


def write_pytorch(root, offset, scorer=None):
    target = root / "tools" / "testing" / "target_determination"
    target.mkdir(parents=True, exist_ok=True)
    for pkg in (root / "tools", root / "tools" / "testing", target):
        (pkg / "__init__.py").write_text("")
    (root / "tools" / "testing" / "test_run.py").write_text(FAKE_TEST_RUN)
    (target / "scorer_model.py").write_text(
        FAKE_SCORER_MODEL.replace("__OFFSET__", offset)
    )
    if scorer is None:
        (target / "scorer.py").unlink(missing_ok=True)
    else:
        (target / "scorer.py").write_text(
            FAKE_SCORER.replace("__SELECT_NOTHING__", scorer)
        )
    for name in [m for m in sys.modules if m == "tools" or m.startswith("tools.")]:
        del sys.modules[name]


class TestReplayCuts(TestCase):
    def test_no_start_up_replays_as_td_cut(self) -> None:
        shard = shards.DayShard(
            "2026-11-08",
            runs=[run(1, 7, "a" * 40, "t", {"c": 1.0}, aggregated={"d": 2.0})],
            units=[
                unit(1, failed=["b"]),
                shards.Unit(1, "linux-a", "other", ["a", "b"], ["c", "d"], [], [], []),
            ],
        )
        m = model()
        jobs = gate.sample_model(m, [shard], rows.JobTimes(TIMES, START_UP)).jobs
        self.assertEqual([j["test_config"] for j in jobs], ["default", "other"])
        self.assertNotEqual(jobs[0]["selected"], jobs[0]["include"])
        self.assertEqual(jobs[1]["selected"], jobs[1]["include"])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write_pytorch(root, "0.0", scorer="False")
            self.assertEqual(cli._replay_cuts(root, m, jobs), 0)
            # A gate that ran the scorer's cut where pytorch keeps TD's.
            wrong = [{**jobs[1], "selected": jobs[0]["selected"]}]
            self.assertEqual(cli._replay_cuts(root, m, wrong), 1)
            # A pytorch that keeps TD's cut where the gate ran the scorer's.
            no_table = {**m, "start_up_seconds": {}}
            self.assertEqual(cli._replay_cuts(root, no_table, jobs[:1]), 1)
            write_pytorch(root, "0.0")


class TestShippedCutoff(TestCase):
    def test_cutoff(self) -> None:
        today = date(2026, 11, 20)
        gate0 = date(2026, 11, 6)
        # A daily run leaves out the two days whose jobs may still run.
        self.assertEqual(cli.shipped_cutoff(today, today, gate0), date(2026, 11, 18))
        # A refit of an earlier day takes every day before it.
        past = date(2026, 11, 10)
        self.assertEqual(cli.shipped_cutoff(past, today, gate0), past)
        # Never before the gate window, e.g. a pull request's one gate day.
        self.assertEqual(
            cli.shipped_cutoff(today, today, date(2026, 11, 19)), date(2026, 11, 19)
        )


START_UP_FIT = start_up.ConfigFit(
    "linux-a",
    "default",
    300,
    30,
    30,
    c=500.0,
    a=1.0,
    k=24.0,
    lo=23.0,
    hi=25.0,
    finite=1.0,
)


class TestCli(TestCase):
    def setUp(self) -> None:
        fetch = mock.patch.object(start_up, "fetch", return_value=[])
        self.start_up_fetch = fetch.start()
        self.addCleanup(fetch.stop)
        fit_all = mock.patch.object(start_up, "fit_all", return_value=[START_UP_FIT])
        self.start_up_fit_all = fit_all.start()
        self.addCleanup(fit_all.stop)
        min_accepted = mock.patch.object(start_up, "MIN_ACCEPTED_CONFIGS", 1)
        min_accepted.start()
        self.addCleanup(min_accepted.stop)

    def build(self, day):
        pos = day.day % 2 == 0
        runs, units = [], []
        for i in range(30):
            run_id = day.toordinal() * 100 + i
            runs.append(
                run(
                    run_id,
                    day.toordinal() * 100 + i,
                    f"{run_id:040d}",
                    f"{day} 01:00:00",
                    {"a": 1.0} if i % 3 == 0 else {"b": 0.3},
                )
            )
            units.append(
                unit(
                    run_id,
                    failed=["a"] if (i % 3 == 0 or pos and i % 7 == 0) else [],
                )
            )
        meta = {
            "td_on_runs": len(runs),
            "errors": int(day in self.broken),
            "logs_missing": len(runs) if day in self.gap else 0,
        }
        return shards.DayShard(day.isoformat(), runs=runs, units=units, meta=meta)

    def refit_args(self, d, day="2026-11-10", *extra, out="m.json", train_days=3):
        return [
            "refit",
            "--day",
            day,
            "--train-days",
            str(train_days),
            "--gate-days",
            "2",
            "--cache-dir",
            str(Path(d) / "cache"),
            "--out",
            str(Path(d) / out),
            *extra,
        ]

    def holdout_set(self, errors=0):
        held = run(1, HELD_PR, "e" * 40, "2026-09-01 01:00:00", {"c": 1.0})
        return shards.DayShard(
            "holdout-v1",
            runs=[held],
            units=[unit(1, failed=["c"], ran=("a", "b", "c", "d"), excluded=())],
            meta={"errors": errors, "heads_with_td_job": 1, "heads_with_log": 1},
        )

    def landing(self, day, pr):
        pair = trunk.TrunkPair(pr, f"{day}-head", "linux-a", "default", "b")
        return trunk.TrunkLanding(f"{day}-landing", day, (pair,))

    def test_refit_end_to_end(self) -> None:
        # refit decides which days are final from today's date; the days below were
        # chosen for 2026-11-11.
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 11, 11, 12, tzinfo=tz)

        with mock.patch.object(cli, "datetime", Clock):
            self._refit_end_to_end()

    def _refit_end_to_end(self) -> None:
        self.broken: set[date] = set()
        self.gap: set[date] = set()
        landings = [
            self.landing("2026-10-01", 5),
            self.landing("2026-10-02", HELD_PR),
            self.landing("2026-11-03", 6),
            self.landing("2026-11-08", 7),
        ]
        head_log = logs.TDLog({"Filepath": {"b": 0.5}}, ("Filepath",), (), ("x",), {})
        head_logs = {p.head_sha: head_log for x in landings for p in x.pairs}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=self.build
        ) as build, mock.patch.object(
            cli, "fetch_test_times", return_value=TIMES
        ), mock.patch.object(
            trunk, "fetch_landings", return_value=landings
        ), mock.patch.object(
            trunk, "fetch_head_logs", return_value=head_logs
        ), mock.patch.object(
            holdout, "build_holdout", return_value=self.holdout_set()
        ), mock.patch.object(gate, "MIN_FLOOR_PRS", 1), mock.patch.object(
            holdout, "MIN_HOLDOUT_EVENTS", 1
        ):
            out = Path(d) / "m.json"
            sample = Path(d) / "s.json"
            report = Path(d) / "r.json"
            fitted, risk_calls, windows = [], [], []
            real_fit, real_risk = train.fit_scorer, risk.fit_risk
            real_window = walkforward.evaluate_window

            def fit_scorer(training):
                fitted.append(training)
                return real_fit(training)

            def fit_risk(head_list, trunk_heads):
                risk_calls.append((list(head_list), list(trunk_heads)))
                return real_risk(head_list, trunk_heads)

            def evaluate_window(model, day_shards, *rest):
                day_shards = list(day_shards)
                windows.append([x.day for x in day_shards])
                return real_window(model, day_shards, *rest)

            two_months = {"train_days": 45}
            with mock.patch.object(
                train, "fit_scorer", side_effect=fit_scorer
            ), mock.patch.object(
                risk, "fit_risk", side_effect=fit_risk
            ), mock.patch.object(
                walkforward, "evaluate_window", side_effect=evaluate_window
            ):
                code = cli.main(
                    self.refit_args(
                        d, "2026-11-10", "--report", str(report), **two_months
                    )
                    + ["--sample", str(sample)]
                )
            self.assertEqual(code, 0)
            built_prs = {
                r.pr for c in build.call_args_list for r in self.build(c.args[0]).runs
            }
            self.assertIn(HELD_PR, built_prs)
            # The shipped model, then the November month.
            self.assertEqual(len(fitted), 2)
            # Today is 2026-11-11: the shipped model ends 2 days before it.
            cuts = (date(2026, 11, 9), date(2026, 11, 1))
            for training, (heads, trunk_heads), cut in zip(fitted, risk_calls, cuts):
                self.assertNotIn(HELD_PR, set(training.pr.tolist()))
                self.assertLess(int(training.day.max()), cut.toordinal())
                trunk_days = set(training.day[training.trunk].tolist())
                self.assertTrue(trunk_days)
                self.assertTrue(all(x < cut.toordinal() for x in trunk_days))
                self.assertTrue(heads)
                self.assertTrue(all(h.pr // 100 < cut.toordinal() for h in heads))
                self.assertNotIn(HELD_PR, {h.pr for h in heads})
            self.assertEqual([len(t) for _, t in risk_calls], [3, 1])
            november = [date(2026, 11, i).isoformat() for i in range(1, 10)]
            self.assertEqual(windows, [november])
            first = date(2026, 11, 1).toordinal()
            self.assertTrue(fitted[0].trunk[fitted[0].day == first + 2].any())
            m = json.loads(out.read_text())
            self.assertEqual(m["version"], "2026-11-10")
            self.assertEqual(m["start_up_seconds"], START_UP)
            self.start_up_fetch.assert_called_with(date(2026, 11, 10))
            self.assertIn("Filepath", m["scorer"]["heuristics"])
            summary = json.loads(report.read_text())
            self.assertTrue(summary["passed"])
            self.assertEqual(summary["holdout"]["scorer_caught"], 1)
            self.assertEqual(summary["holdout"]["td_caught"], 0)
            months = [row["month"] for row in summary["walk_forward"]]
            self.assertEqual(months, ["2026-11", "total"])
            total = summary["walk_forward"][-1]
            self.assertEqual(summary["prs_with_events"], total["prs_with_events"])
            self.assertGreater(total["prs_with_events"], 0)
            self.assertEqual(total["trunk_landings"], 2)
            self.assertTrue((Path(d) / "cache" / "holdout" / "v2.jsonl.gz").exists())
            other = self.refit_args(d, out="other.json", **two_months)
            self.assertEqual(cli.main(other + ["--floor-ratio", "2"]), 1)
            self.assertEqual(
                cli.main(other + ["--floor-ratio", "2", "--report-only"]), 0
            )
            self.assertEqual(cli.main(self.refit_args(d, out="other.json")), 1)
            with mock.patch.object(
                cli.walkforward, "walk_forward", side_effect=RuntimeError("fold")
            ):
                with self.assertRaises(RuntimeError):
                    cli.main(other)
            model_bytes, sample_bytes = out.read_bytes(), sample.read_bytes()

        self.broken = set()
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=self.build
        ) as build, mock.patch.object(
            cli, "fetch_test_times", return_value=TIMES
        ), mock.patch.object(
            trunk, "fetch_landings", return_value=[]
        ), mock.patch.object(
            trunk, "fetch_head_logs", return_value={}
        ), mock.patch.object(
            holdout, "build_holdout", return_value=self.holdout_set()
        ), mock.patch.object(gate, "MIN_FLOOR_PRS", 0), mock.patch.object(
            holdout, "MIN_HOLDOUT_EVENTS", 1
        ):
            early_day = shards.FIRST_DATA_DAY + timedelta(days=4)
            early = self.refit_args(d, early_day.isoformat(), out="other.json")
            self.assertEqual(cli.main(early), 0)
            built = sorted(c.args[0] for c in build.call_args_list)
            self.assertEqual(built[0], shards.FIRST_DATA_DAY)

            self.broken = {date(2026, 11, 20)}
            with mock.patch.object(
                store, "S3Store", return_value=store.DirStore(Path(d) / "s3")
            ):
                late = self.refit_args(d, "2026-11-22", out="other.json")
                self.assertEqual(cli.main(late), 0)
                self.assertEqual(cli.main(late + ["--s3"]), 1)
                self.broken = set()
                with mock.patch.object(
                    holdout, "build_holdout", return_value=self.holdout_set(1)
                ):
                    s3_run = self.refit_args(d, "2026-11-25", out="other.json")
                    # An unsound holdout set is reported only.
                    self.assertEqual(cli.main(s3_run + ["--s3"]), 0)
                self.assertEqual(cli.main(s3_run + ["--s3"]), 0)
                self.broken = {date(2026, 11, 20)}
                later = self.refit_args(d, "2026-11-24", out="other.json")
                self.assertEqual(cli.main(later + ["--s3"]), 0)
                self.broken, self.gap = set(), {date(2026, 11, 23)}
                self.assertEqual(cli.main(later + ["--s3"]), 0)
                self.broken = {date(2026, 11, 22)}
                self.assertEqual(cli.main(later + ["--s3"]), 1)
                self.assertEqual(cli.main(later + ["--s3", "--report-only"]), 0)
            self.assertFalse((Path(d) / "s3" / "2026-11-20.jsonl.gz").exists())

        with tempfile.TemporaryDirectory() as d:
            out, sample = Path(d) / "m.json", Path(d) / "s.json"
            out.write_bytes(model_bytes)
            sample.write_bytes(sample_bytes)
            root = Path(d) / "pytorch"
            args = [
                "check-pytorch",
                "--model",
                str(out),
                "--sample",
                str(sample),
                "--pytorch-root",
                str(root),
            ]
            self.assertEqual(cli.main(args), cli.SKIPPED)
            self.assertTrue(json.loads(sample.read_text())["jobs"])
            write_pytorch(root, "0.0")
            self.assertEqual(cli.main(args), cli.SKIPPED)
            write_pytorch(root, "1e-3")
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "float('nan')", scorer="False")
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "0.0", scorer="False")
            self.assertEqual(cli.main(args), 0)
            target = root / cli.SCORER_DIR
            (target / "scorer.py").write_text("TD_RESULTS_PATH = None\n")
            for name in [
                m for m in sys.modules if m == "tools" or m.startswith("tools.")
            ]:
                del sys.modules[name]
            self.assertEqual(cli.main(args), cli.SKIPPED)
            write_pytorch(root, "0.0", scorer="True")
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "0.0", scorer="False")
            no_jobs = Path(d) / "no_jobs.json"
            no_jobs.write_text(json.dumps({**json.loads(sample_bytes), "jobs": []}))
            args[args.index(str(sample))] = str(no_jobs)
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "0.0")

    def test_skipped_exit_code(self) -> None:
        # td-scorer.yml tests the check-pytorch exit code against a literal 3.
        self.assertEqual(cli.SKIPPED, 3)

    def test_refit_marks_no_outcome_days_by_age(self) -> None:
        self.broken, self.gap = set(), set()
        today = date(2026, 11, 30)
        mark_before = today - timedelta(days=train.GATE_DAYS)
        empty = {mark_before + timedelta(days=i) for i in (-1, 0, 1)}

        def build(day):
            shard = self.build(day)
            if day in empty:
                shard.units = []
                shard.meta.update(logs_parsed=len(shard.runs), units_seen=0)
            return shard

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 11, 30, 12, tzinfo=tz)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=build
        ) as built, mock.patch.object(cli, "datetime", Clock), mock.patch.object(
            cli, "fetch_test_times", return_value=TIMES
        ), mock.patch.object(
            trunk, "fetch_landings", return_value=[]
        ), mock.patch.object(
            trunk, "fetch_head_logs", return_value={}
        ), mock.patch.object(
            holdout, "build_holdout", return_value=self.holdout_set()
        ), mock.patch.object(gate, "MIN_FLOOR_PRS", 0), mock.patch.object(
            holdout, "MIN_HOLDOUT_EVENTS", 1
        ):
            args = self.refit_args(d, today.isoformat(), train_days=20)
            cache = store.DirStore(Path(d) / "cache")
            for _ in range(2):
                built.reset_mock()
                self.assertEqual(cli.main(args), 0)
                rebuilt = {c.args[0] for c in built.call_args_list}
                marked = {x for x in empty if cache.exists(f"{x}{store.GAP_SUFFIX}")}
                self.assertEqual(marked, {mark_before - timedelta(days=1)})
                self.assertFalse(any(cache.exists(x.isoformat()) for x in empty))
            self.assertEqual(rebuilt & empty, empty - marked)

    def test_start_up_fit_comes_first_and_fails_the_refit(self) -> None:
        self.start_up_fetch.side_effect = RuntimeError("ClickHouse")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=self.build
        ) as build:
            with self.assertRaises(RuntimeError):
                cli.main(self.refit_args(d) + ["--report-only"])
            build.assert_not_called()

    def test_too_few_start_ups_fail_the_refit(self) -> None:
        self.start_up_fit_all.return_value = [START_UP_FIT] * 4
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            start_up, "MIN_ACCEPTED_CONFIGS", 5
        ), mock.patch.object(
            store.Shards, "ensure", side_effect=RuntimeError("backfill")
        ) as ensure:
            self.assertEqual(start_up.size(start_up.table([START_UP_FIT] * 4)), 1)
            self.assertEqual(cli.main(self.refit_args(d)), 1)
            ensure.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, "backfill"):
                cli.main(self.refit_args(d) + ["--report-only"])
            self.start_up_fit_all.return_value = [
                dataclasses.replace(START_UP_FIT, test_config=f"c{i}") for i in range(5)
            ]
            with self.assertRaisesRegex(RuntimeError, "backfill"):
                cli.main(self.refit_args(d))

    def test_workflow_time_budget(self) -> None:
        import yaml

        path = Path(__file__).parents[4] / ".github" / "workflows" / "td-scorer.yml"
        job = yaml.safe_load(path.read_text())["jobs"]["refit"]
        timeout = job["timeout-minutes"] * 60
        aws = next(
            s for s in job["steps"] if s.get("name") == "Configure AWS credentials"
        )
        self.assertGreaterEqual(aws["with"]["role-duration-seconds"], timeout)
        # Fitting, the walk-forward, the holdout and the upload took ~25 minutes
        # locally on one year; leave them 90 on the runner.
        self.assertLessEqual(store.BACKFILL_SECONDS + 90 * 60, timeout)

    def test_fetch_test_times(self) -> None:
        with mock.patch.object(logs, "http_get", return_value=b'{"a": {}}') as get:
            self.assertEqual(cli.fetch_test_times(), {"a": {}})
            get.assert_called_once_with(cli.TEST_TIMES_URL)
        for body in (None, b"[1]"):
            with mock.patch.object(logs, "http_get", return_value=body):
                with self.assertRaises(RuntimeError):
                    cli.fetch_test_times()


if __name__ == "__main__":
    main()
