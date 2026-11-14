import contextlib
import dataclasses
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.scorer import (
    __main__ as cli,
    check_pytorch,
    cut,
    gate,
    holdout,
    logs,
    main_failures,
    model_json,
    risk,
    rows,
    sample,
    shards,
    start_up,
    store,
    train,
    trunk,
    walkforward,
)


GOLDEN_LANDINGS = (("2026-10-01", 5), ("2026-11-03", 6), ("2026-11-08", 7))
GOLDEN = (
    (
        "0.6",
        0,
        "f24991bd588c668136b4fde51c326a0e4b9fe22dfb623a877b5ca4cce7ad8076",
        "06d5fc6518f626fbd90bdb8a5ce087aa4f618f378278e1b642eccd6772a5c6e2",
    ),
    (
        "2",
        1,
        "f24991bd588c668136b4fde51c326a0e4b9fe22dfb623a877b5ca4cce7ad8076",
        "74511877b45c4003326e44c8efebdeef2a04b0f371460f14e553937bab9c3083",
    ),
)


def canon(obj):
    if isinstance(obj, float):
        return float(f"{obj:.6g}") if obj == obj else "nan"
    if isinstance(obj, dict):
        return {k: canon(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [canon(v) for v in obj]
    return obj


def digest(obj):
    text = json.dumps(canon(obj), sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()


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
        sampled = sample.sample_model(
            model(), self.shards(), rows.JobTimes(TIMES, START_UP)
        )
        self.assertEqual(len(sampled.jobs), 4)
        self.assertTrue(sampled.r)
        json.dumps(sampled.dump())
        m = model()
        for row in sampled.p:
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
        sampled = sample.sample_model(model(), [shard], times)
        self.assertEqual(sampled.jobs[0]["include"], ["c", "d"])
        self.assertEqual(sampled.jobs[0]["selected"], ["a", "b", "c"])

    def test_a_config_without_start_up_keeps_td_cut(self) -> None:
        shard = shards.DayShard(
            "2026-11-08",
            runs=[
                run(1, 7, "a" * 40, "t", {"c": 1.0}, aggregated={"d": 2.0, "c": 1.0})
            ],
            units=[unit(1, failed=["b"])],
        )
        times = rows.JobTimes(TIMES, {"linux-a": {"other": 24.0}})
        sampled = sample.Sample()
        ev = cut.Evaluator(model(), times)
        selected, include = ev.cut(shard.runs[0], shard.units[0])
        self.assertEqual((selected, include), ({"c", "d"}, {"c", "d"}))
        sampled.add(ev, ev.prepare(shard.runs[0], shard.units[0]))
        self.assertEqual(sampled.p, [])
        self.assertEqual(sampled.jobs[0]["selected"], ["c", "d"])
        self.assertIsNone(sampled.jobs[0]["budget_ms"])
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

def change_features(paths):
    return risk.change_features(paths)

budget_share = model_json.budget_share
for _name in model_json.BUDGET_CONSTANTS:
    globals()[_name] = getattr(model_json, _name)

OFFSET = __OFFSET__
"""


FAKE_SCORER_PATHS = """
from torchci.td.scorer import risk

for _name in risk.BUILD_PATH_CONSTANTS:
    globals()[_name] = getattr(risk, _name)
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
from torchci.td.scorer import cut, model_json

SELECT_NOTHING = __SELECT_NOTHING__
BUDGET_OFFSET = 0


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
    share, _ = model_json.budget_share(model, block["build_files"], block["risk"])
    a = 1.0 if share is None else model["budget"]["cost_exponent"]
    budget = sum(cut.cost_ms(c) for f, c in zip(files, costs) if f in inc)
    if share is not None:
        budget = round(share * sum(cut.cost_ms(c) for c in costs))
    must = {
        f
        for name in cut.MUST_RUN_HEURISTICS
        if name not in raised
        for f, s in scores.get(name, {}).items()
        if s
    }
    order = cut.rank(files, p, costs, must, a)
    selected = cut.fill(order, {f: cut.cost_ms(c) for f, c in zip(files, costs)}, budget)
    return [TestRun(f) for f in selected], [], {"budget_ms": budget + BUDGET_OFFSET}
"""


def write_pytorch(root, offset, scorer=None, extra="", paths=""):
    """A fake pytorch checkout; `paths` is appended to scorer_paths.py, None for none."""
    target = root / "tools" / "testing" / "target_determination"
    target.mkdir(parents=True, exist_ok=True)
    for pkg in (root / "tools", root / "tools" / "testing", target):
        (pkg / "__init__.py").write_text("")
    (root / "tools" / "testing" / "test_run.py").write_text(FAKE_TEST_RUN)
    (target / "scorer_model.py").write_text(
        FAKE_SCORER_MODEL.replace("__OFFSET__", offset) + extra
    )
    if paths is None:
        (target / "scorer_paths.py").unlink(missing_ok=True)
    else:
        (target / "scorer_paths.py").write_text(FAKE_SCORER_PATHS + paths)
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
        jobs = sample.sample_model(m, [shard], rows.JobTimes(TIMES, START_UP)).jobs
        self.assertEqual([j["test_config"] for j in jobs], ["default", "other"])
        self.assertNotEqual(jobs[0]["selected"], jobs[0]["include"])
        self.assertEqual(jobs[1]["selected"], jobs[1]["include"])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write_pytorch(root, "0.0", scorer="False")
            self.assertEqual(check_pytorch._replay_cuts(root, m, jobs), 0)
            # A gate that ran the scorer's cut where pytorch keeps TD's.
            wrong = [{**jobs[1], "selected": jobs[0]["selected"]}]
            self.assertEqual(check_pytorch._replay_cuts(root, m, wrong), 1)
            # A pytorch that keeps TD's cut where the gate ran the scorer's.
            no_table = {**m, "start_up_seconds": {}}
            self.assertEqual(check_pytorch._replay_cuts(root, no_table, jobs[:1]), 1)
            write_pytorch(root, "0.0")


class TestBudgetGate(TestCase):
    def test_window_budget_stats(self) -> None:
        m = model()
        m["budget"] = {"share": 0.1, "spread": 0.0, "cost_exponent": 1.0}
        # TD includes c and d (aggregated); 10% of 226 s fits c alone (p 0.9).
        r1 = run(1, 7, "a" * 40, "t1", {"c": 1.0}, aggregated={"c": 1.0, "d": 2.0})
        r2 = run(2, 8, "b" * 40, "t2", {"c": 1.0}, aggregated={"c": 1.0, "d": 2.0})
        r3 = run(3, 9, "c" * 40, "t3", {"c": 1.0})
        shard = shards.DayShard(
            "2026-11-08",
            runs=[r1, r2, r3],
            units=[
                unit(1, failed=["c", "d"]),
                unit(2, failed=["d"]),
                unit(3),
                # Not served (no start-up): neither sampled nor in the retention.
                shards.Unit(
                    2, "linux-a", "other", ["a", "b"], ["c", "d"], ["d"], [], []
                ),
            ],
        )
        times = rows.JobTimes(TIMES, START_UP)
        with mock.patch.object(gate, "share_sampled", return_value=True):
            w = gate.evaluate_window(m, [shard], {7, 8, 9}, [], times)
        self.assertEqual((w.retention_prs, w.retention_kept), (2, 1))
        # The unserved job's "d" is an event, caught in its TD include list.
        self.assertEqual((w.pr_events, w.budget_caught), (4, 2))
        self.assertEqual(w.share_jobs, 3)
        self.assertEqual(w.share_total_ms, 3 * (34000 * 3 + 124000))
        self.assertEqual(w.share_cost_ms, 3 * 34000)
        self.assertAlmostEqual(w.share_seconds / w.share_total_seconds, 10 / 130)
        # Without a budget block no job has a share, so no PR enters retention.
        with mock.patch.object(gate, "share_sampled", return_value=True):
            plain = gate.evaluate_window(model(), [shard], {7, 8, 9}, [], times)
        self.assertEqual((plain.retention_prs, plain.retention_kept), (0, 0))
        held = gate.HoldoutReport()
        with mock.patch.object(gate, "MIN_FLOOR_PRS", 2):
            result = gate.Gate.pooled(held, [w], budget=m["budget"])
            self.assertFalse(result.budget_ok)
            self.assertIn(
                "per-PR retention of TD's catches 1 / 2 = 0.500", result.text()
            )
            with mock.patch.object(gate, "RETENTION_FLOOR", 0.5):
                self.assertTrue(
                    gate.Gate.pooled(held, [w], budget=m["budget"]).budget_ok
                )
            self.assertNotIn("budget", gate.Gate.pooled(held, [w]).summary())
            summary = result.summary()
            self.assertEqual(summary["budget"]["retention"], 0.5)
            self.assertFalse(summary["budget_ok"])
        empty = gate.BudgetCheck.pooled(m["budget"], [])
        with mock.patch.object(gate, "MIN_FLOOR_PRS", 0):
            self.assertFalse(empty.ok)
        self.assertIn("0 / 0 = nan", empty.text())
        # Without a block, no job is sampled for the share.
        plain = gate.evaluate_window(model(), [shard], {7, 8, 9}, [], times)
        self.assertEqual(plain.share_jobs, 0)
        self.assertEqual(plain.budget_caught, plain.pr_caught)

    def test_monitor_timeout(self) -> None:
        release = threading.Event()

        def slow(*args):
            release.wait(10)
            raise RuntimeError("late")

        with mock.patch.object(
            gate.main_failures, "fetch_main_landings", side_effect=slow
        ), mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            gate.monitor(
                model(), rows.JobTimes(TIMES, START_UP), date(2026, 11, 10), 0.05
            )
        release.set()
        self.assertEqual(out.getvalue(), "main-failure monitor: unavailable: timeout\n")

    def test_settle_budget(self) -> None:
        m = model()
        m["budget"] = dict(model_json.BUDGET)
        ok = mock.Mock(budget_ok=True)
        self.assertIs(gate.settle_budget(m, ok), m)
        self.assertNotIn("budget", gate.settle_budget(m, mock.Mock(budget_ok=False)))
        m["budget"] = {**model_json.BUDGET, "share": 1.01}
        self.assertNotIn("budget", gate.settle_budget(m, ok))


class TestCheckPytorchBudget(TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        m = model()
        m["budget"] = {"share": 0.3, "spread": 0.5, "cost_exponent": 0.5}
        self.model = m
        r1 = run(1, 7, "a" * 40, "t1", {"c": 1.0}, aggregated={"c": 1.0, "d": 2.0})
        r2 = dataclasses.replace(r1, run_id=2, head_sha="b" * 40, changed_files=None)
        r3 = dataclasses.replace(
            r1, run_id=3, head_sha="c" * 40, changed_files=["setup.py"]
        )
        shard = shards.DayShard(
            "d", runs=[r1, r2, r3], units=[unit(1), unit(2), unit(3)]
        )
        self.shard = shard
        self.paths = d / "m.json", d / "s.json"
        self.write(m)
        self.root = d / "pytorch"

    def write(self, m) -> None:
        sampled = sample.sample_model(m, [self.shard], rows.JobTimes(TIMES, START_UP))
        self.paths[0].write_text(model_json.dumps(m))
        self.paths[1].write_text(json.dumps(sampled.dump()))

    def tearDown(self) -> None:
        self.dir.cleanup()
        for name in [m for m in sys.modules if m == "tools" or m.startswith("tools.")]:
            del sys.modules[name]

    def check(self, extra="", scorer="False", model=None, paths="") -> int:
        if model is not None:
            self.write(model)
        write_pytorch(self.root, "0.0", scorer=scorer, extra=extra, paths=paths)
        m, s = self.paths
        return cli.main(
            ["check-pytorch", "--model", str(m), "--sample", str(s)]
            + ["--pytorch-root", str(self.root)]
        )

    def test_comparisons(self) -> None:
        jobs = json.loads(self.paths[1].read_text())["jobs"]
        self.assertEqual([j["build_files"] for j in jobs], [0, None, 1])
        self.assertEqual(self.check(), 0)
        drifts: list[dict[str, Optional[str]]] = [
            {"extra": "MIN_SHARE = 0.05\n"},
            {"paths": "BUILD_DIRS = ('cmake/',)\n"},
            {"paths": "del BUILD_SUFFIXES\n"},
            {"paths": None},
            {"extra": "change_features = lambda paths: {'n_files': 0}\n"},
        ]
        plain = {k: v for k, v in self.model.items() if k != "budget"}
        for drift in drifts:
            with self.subTest(drift=drift):
                self.assertEqual(self.check(model=self.model, **drift), 1)
                # Without a budget block the drift is only a warning.
                with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
                    self.assertEqual(self.check(model=plain, **drift), 0)
                self.assertIn("WARNING (no budget block", out.getvalue())
        target = self.root / check_pytorch.SCORER_DIR / "scorer.py"
        write_pytorch(self.root, "0.0", scorer="False")
        target.write_text(
            target.read_text().replace("BUDGET_OFFSET = 0", "BUDGET_OFFSET = 1000")
        )
        m, s = self.paths
        args = ["check-pytorch", "--model", str(m), "--sample", str(s)]
        self.assertEqual(cli.main(args + ["--pytorch-root", str(self.root)]), 1)
        # A pytorch without the budget rule: nothing to compare for a model without a
        # block, a failure for a model with one.
        old = "del budget_share\nfor _n in BUDGET_CONSTANTS:\n    del globals()[_n]\n"
        old = old.replace("BUDGET_CONSTANTS", "model_json.BUDGET_CONSTANTS")
        self.assertEqual(self.check(old, model=self.model), 1)
        self.assertEqual(self.check(old, model=plain, paths=None), 0)

    def test_sample_without_changed_files(self) -> None:
        plain = {k: v for k, v in self.model.items() if k != "budget"}
        for m, code in ((self.model, 1), (plain, 0)):
            with self.subTest(budget="budget" in m):
                self.write(m)
                data = json.loads(self.paths[1].read_text())
                for row in data["r"]:
                    del row["files"]
                self.paths[1].write_text(json.dumps(data))
                write_pytorch(self.root, "0.0", scorer="False")
                args = ["check-pytorch", "--model", str(self.paths[0])]
                args += [
                    "--sample",
                    str(self.paths[1]),
                    "--pytorch-root",
                    str(self.root),
                ]
                with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
                    self.assertEqual(cli.main(args), code)
                self.assertIn("no sampled change has its files", out.getvalue())


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
            self.assertEqual(cli.main(args), check_pytorch.SKIPPED)
            self.assertTrue(json.loads(sample.read_text())["jobs"])
            write_pytorch(root, "0.0")
            self.assertEqual(cli.main(args), check_pytorch.SKIPPED)
            write_pytorch(root, "1e-3")
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "float('nan')", scorer="False")
            self.assertEqual(cli.main(args), 1)
            write_pytorch(root, "0.0", scorer="False")
            self.assertEqual(cli.main(args), 0)
            target = root / check_pytorch.SCORER_DIR
            (target / "scorer.py").write_text("TD_RESULTS_PATH = None\n")
            for name in [
                m for m in sys.modules if m == "tools" or m.startswith("tools.")
            ]:
                del sys.modules[name]
            self.assertEqual(cli.main(args), check_pytorch.SKIPPED)
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
        self.assertEqual(check_pytorch.SKIPPED, 3)

    def run_refit(self, d, *extra, landings_main=None):
        """refit of 2026-11-10 on 45 training days, today 2026-11-11: (exit code, model,
        report, stdout)."""

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 11, 11, 12, tzinfo=tz)

        self.broken, self.gap = set(), set()
        landings = [self.landing(x, pr) for x, pr in GOLDEN_LANDINGS]
        head_log = logs.TDLog({"Filepath": {"b": 0.5}}, ("Filepath",), (), ("x",), {})
        head_logs = {p.head_sha: head_log for x in landings for p in x.pairs}
        main = landings_main or mock.Mock(side_effect=RuntimeError("no ClickHouse"))
        report = Path(d) / "r.json"
        with mock.patch.object(
            store, "build_day_shard", side_effect=self.build
        ), mock.patch.object(cli, "datetime", Clock), mock.patch.object(
            cli, "fetch_test_times", return_value=TIMES
        ), mock.patch.object(
            trunk, "fetch_landings", return_value=landings
        ), mock.patch.object(
            trunk, "fetch_head_logs", return_value=head_logs
        ), mock.patch.object(
            holdout, "build_holdout", return_value=self.holdout_set()
        ), mock.patch.object(gate, "MIN_FLOOR_PRS", 1), mock.patch.object(
            holdout, "MIN_HOLDOUT_EVENTS", 1
        ), mock.patch.object(
            gate.main_failures, "fetch_main_landings", main
        ), mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            args = self.refit_args(
                d, "2026-11-10", "--report", str(report), *extra, train_days=45
            )
            code = cli.main(args)
        model = json.loads((Path(d) / "m.json").read_text())
        return code, model, json.loads(report.read_text()), out.getvalue()

    def test_refit_without_budget_is_unchanged(self) -> None:
        # Digests of the model and the report a refit without --budget writes, floats at
        # 6 significant digits.
        for ratio, code, model_digest, report_digest in GOLDEN:
            with tempfile.TemporaryDirectory() as d:
                got = self.run_refit(d, "--floor-ratio", ratio)
            self.assertEqual(got[0], code)
            self.assertNotIn("budget", got[1])
            self.assertEqual(digest(got[1]), model_digest)
            self.assertEqual(digest(got[2]), report_digest)
            self.assertNotIn("budget", got[3])
            self.assertNotIn("main-failure monitor", got[3])

    def test_refit_budget(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            budget_out = ["--budget-out", str(Path(d) / "b.json")]
            code, model, report, out = self.run_refit(d, "--budget", *budget_out)
            shipped = json.loads((Path(d) / "b.json").read_text())
        self.assertEqual(code, 0)
        self.assertNotIn("budget", model)
        self.assertEqual(shipped, {**model, "budget": model_json.BUDGET})
        self.assertTrue(report["budget_ok"] and report["budget_kept"])
        # One PR's failing file is displaced by a first-ranked file over the budget.
        self.assertAlmostEqual(report["budget"]["retention"], 15 / 17)
        self.assertGreater(report["budget"]["share_jobs"], 0)
        self.assertIn("budget mode: on, block kept", out)
        # The monitor's fetch raised: reported as unavailable, the run still passes.
        self.assertIn("main-failure monitor: unavailable (RuntimeError", out)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            gate, "RETENTION_FLOOR", 1.01
        ):
            budget_out = ["--budget-out", str(Path(d) / "b.json")]
            code, model, report, out = self.run_refit(d, "--budget", *budget_out)
            shipped = json.loads((Path(d) / "b.json").read_text())
        self.assertEqual(code, 0)
        self.assertNotIn("budget", model)
        self.assertEqual(shipped, model)
        self.assertFalse(report["budget_ok"] or report["budget_kept"])
        self.assertIn("block dropped (the retention check failed)", out)
        # The monitor runs last, after the model, the report and the sample exist.
        with tempfile.TemporaryDirectory() as d:
            sample_path = Path(d) / "s.json"

            outputs = ["--sample", str(sample_path), *self.budget_outputs(d)]

            def written(*args):
                for name in ("m.json", "r.json", "s.json", "b.json", "bs.json"):
                    self.assertTrue((Path(d) / name).exists(), name)

            with mock.patch.object(gate, "monitor", side_effect=written) as called:
                self.run_refit(d, "--budget", *outputs)
            self.assertEqual(called.call_count, 1)
        landing = main_failures.MainLanding(
            "f" * 40,
            9,
            "2026-11-02",
            logs.TDLog({"Filepath": {"a": 1.0}}, ("Filepath",), (), ("x",), {"a": 1.0}),
            (main_failures.MainUnit("linux-a", "default", ("a", "b", "c"), ("a",)),),
        )
        found = mock.Mock(return_value=([landing], {"landings_found": 1}))
        with tempfile.TemporaryDirectory() as d:
            out = self.run_refit(d, "--budget", landings_main=found)[3]
        self.assertIn(
            "main-failure monitor (report only, 2026-09-10..2026-11-10):", out
        )
        self.assertIn("budgeted cut caught 1 landings, 1 of 1 failures", out)
        self.assertIn("TD's 25% cut caught 1 landings", out)

    def budget_outputs(self, d):
        return ["--budget-out", str(Path(d) / "b.json")] + [
            "--budget-sample",
            str(Path(d) / "bs.json"),
        ]

    def refit_files(self, *extra, walk_forward=None):
        """The bytes of m.json, s.json, b.json and bs.json a refit wrote, None for a
        file it did not write."""
        names = ("m.json", "s.json", "b.json", "bs.json")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            cli.walkforward, "walk_forward", side_effect=walk_forward
        ) if walk_forward else contextlib.nullcontext():
            args = ["--sample", str(Path(d) / "s.json"), *self.budget_outputs(d)]
            try:
                self.run_refit(d, *args, *extra)
            except RuntimeError:
                pass
            paths = [Path(d) / name for name in names]
            return [p.read_bytes() if p.exists() else None for p in paths]

    def test_refit_writes_both_models_and_samples(self) -> None:
        plain = self.refit_files()
        self.assertEqual(plain[2:], plain[:2])
        self.assertNotIn("budget", json.loads(plain[0]))
        budget = self.refit_files("--budget")
        self.assertEqual(budget[:2], plain[:2])
        self.assertEqual(json.loads(budget[2])["budget"], model_json.BUDGET)
        self.assertNotEqual(budget[3], budget[1])
        budget_ms = [j["budget_ms"] for j in json.loads(budget[3])["jobs"]]
        self.assertNotEqual(
            budget_ms, [j["budget_ms"] for j in json.loads(budget[1])["jobs"]]
        )
        with mock.patch.object(gate, "RETENTION_FLOOR", 1.01):
            dropped = self.refit_files("--budget")
        self.assertEqual(dropped[2:], dropped[:2])
        self.assertEqual(dropped[:2], plain[:2])
        # Without --budget both models are written before the walk-forward; with it,
        # neither is.
        fold = RuntimeError("fold")
        self.assertEqual(self.refit_files(walk_forward=fold), [plain[0], None] * 2)
        failed = self.refit_files("--budget", walk_forward=fold)
        self.assertEqual(failed, [None] * 4)

    def test_refit_reports_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            plain = self.run_refit(d)
        self.assertNotIn("candidates", plain[2])
        self.assertNotIn("candidates", plain[3])
        build = self.build

        # A candidate ran for every other PR.
        def logged(day):
            shard = build(day)
            for i in range(0, len(shard.runs), 2):
                names = ["Filepath", "Trial"]
                shard.runs[i] = dataclasses.replace(shard.runs[i], heuristics=names)
            return shard

        def refit(d, side_effect=None):
            with mock.patch.object(self, "build", logged), mock.patch.object(
                train, "CANDIDATES", ("Trial",)
            ), mock.patch.object(
                cli.walkforward, "candidates", side_effect=side_effect
            ) if side_effect else contextlib.nullcontext():
                got = self.run_refit(d, "--sample", str(Path(d) / "s.json"))
            return got, (Path(d) / "s.json").read_bytes()

        with tempfile.TemporaryDirectory() as d:
            (code, model, report, out), sample_bytes = refit(d)
        # The shipped model and the gate are those of the same days without it.
        self.assertEqual((code, model), plain[:2])
        table = report.pop("candidates")
        self.assertEqual(report, plain[2])
        self.assertEqual((table["heuristics"], table["prs"]), (["Trial"], 135))
        total, with_total = table["scorer"][-1], table["with_candidates"][-1]
        self.assertEqual((total["month"], total["prs_with_events"]), ("total", 53))
        self.assertEqual(with_total["prs_with_events"], 53)
        self.assertEqual((total["trunk_landings"], total["td"]), (0, with_total["td"]))
        self.assertIn(
            "candidates (report only): Trial, on the 135 PRs where a candidate ran", out
        )
        self.assertLess(out.index("result: PASS"), out.index("candidates (report"))

        # It runs once the model, the report and the sample exist, and never fails the
        # run or changes them.
        with tempfile.TemporaryDirectory() as d:

            def written(*args):
                for name in ("m.json", "r.json", "s.json"):
                    self.assertTrue((Path(d) / name).exists(), name)
                raise RuntimeError("no candidates")

            failed, failed_sample = refit(d, written)
        self.assertEqual(failed[:3], (code, model, report))
        self.assertEqual(failed_sample, sample_bytes)
        self.assertIn(
            "candidates (report only): unavailable (RuntimeError: no candidates)",
            failed[3],
        )

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

    def test_workflow_budget_switch(self) -> None:
        jobs = workflow_jobs()
        variable = "${{ vars.TD_SCORER_BUDGET }}"
        refit = next(s for s in jobs["refit"]["steps"] if s.get("id") == "refit")
        self.assertEqual(refit["env"]["TD_SCORER_BUDGET"], variable)
        self.assertIn("budget_on", refit["run"])
        self.assertIn("outputs+=(--budget)", refit["run"])
        for job in jobs.values():
            for step in job["steps"]:
                self.assertNotIn("vars.", step.get("run", ""))
        names = [step.get("name", "") for step in jobs["publish"]["steps"]]
        self.assertLess(names.index(CHOOSE), names.index(PUSH))
        self.assertLess(names.index(PUSH), names.index(REFUSED))
        step = workflow_step(jobs["publish"], CHOOSE)
        self.assertEqual(step["env"]["TD_SCORER_BUDGET"], variable)
        values = [" On\n", "ON", "on", "\ton \r", "\non", "off", "", "true", "1", "o n"]
        plain = model()
        for has_budget in (True, False):
            budgeted = {**plain, "budget": model_json.BUDGET} if has_budget else plain
            for value in values:
                with self.subTest(has_budget=has_budget, value=value):
                    code, published, outputs = run_choose(step, plain, budgeted, value)
                    self.assertEqual(code, 0)
                    allowed = not has_budget or model_json.budget_on(value)
                    self.assertEqual(published, budgeted if allowed else plain)
                    self.assertEqual("refused" not in outputs, allowed)

    def test_fetch_test_times(self) -> None:
        with mock.patch.object(logs, "http_get", return_value=b'{"a": {}}') as get:
            self.assertEqual(cli.fetch_test_times(), {"a": {}})
            get.assert_called_once_with(cli.TEST_TIMES_URL)
        for body in (None, b"[1]"):
            with mock.patch.object(logs, "http_get", return_value=body):
                with self.assertRaises(RuntimeError):
                    cli.fetch_test_times()


WORKFLOW = Path(__file__).parents[4] / ".github" / "workflows" / "td-scorer.yml"
CHECK = "Validate with pytorch, compare p and r, replay the cut"
CHOOSE = "Choose the models to publish"
PUSH = "Push the models to generated-stats"
REFUSED = "Fail when td-scorer-budget.json was refused"
STUB_PYTHON = """#!/bin/bash
echo "$*" >> "${CALLS}"
case "$*" in
  *td-scorer-budget.json*) exit "${BUDGET_CODE}" ;;
  *) exit "${PLAIN_CODE}" ;;
esac
"""


def workflow_jobs():
    import yaml

    return yaml.safe_load(WORKFLOW.read_text())["jobs"]


def workflow_step(job, name):
    return next(s for s in job["steps"] if s.get("name") == name)


def run_step(step, cwd, env):
    """A step's shell run as GitHub's default bash shell runs it, in its
    working-directory under `cwd`: (exit code, stdout, its GITHUB_OUTPUT lines)."""
    out = Path(cwd) / "github_output"
    out.write_text("")
    env = {
        **step.get("env", {}),
        "GITHUB_OUTPUT": str(out),
        "GITHUB_STEP_SUMMARY": str(Path(cwd) / "summary"),
        "PATH": "/usr/bin:/bin",
        "HOME": str(cwd),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        **env,
    }
    done = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]],
        cwd=Path(cwd) / step.get("working-directory", ""),
        env=env,
        capture_output=True,
        text=True,
    )
    outputs = dict(line.split("=", 1) for line in out.read_text().splitlines())
    return done.returncode, done.stdout, outputs


def write_models(d, plain, budgeted):
    models = Path(d) / "td-scorer"
    models.mkdir(exist_ok=True)
    (models / "td-scorer.json").write_text(model_json.dumps(plain))
    text = budgeted if isinstance(budgeted, str) else model_json.dumps(budgeted)
    (models / "td-scorer-budget.json").write_text(text)


def run_choose(step, plain, budgeted, value="on", validated="true"):
    """(exit code, the td-scorer-budget.json it leaves, its outputs)."""
    with tempfile.TemporaryDirectory() as d:
        write_models(d, plain, budgeted)
        env = {"TD_SCORER_BUDGET": value, "BUDGET_VALIDATED": validated}
        code, _, outputs = run_step(step, d, env)
        published = (Path(d) / "td-scorer" / "td-scorer-budget.json").read_text()
    return code, json.loads(published), outputs


class TestWorkflowPublish(TestCase):
    def setUp(self) -> None:
        self.jobs = workflow_jobs()
        self.plain = model()
        self.budgeted = {**self.plain, "budget": model_json.BUDGET}

    def test_check_exit_codes(self) -> None:
        check = self.jobs["check"]
        self.assertEqual(
            check["outputs"]["budget_validated"],
            "${{ steps.check.outputs.budget_validated }}",
        )
        choose = workflow_step(self.jobs["publish"], CHOOSE)
        self.assertEqual(
            choose["env"]["BUDGET_VALIDATED"],
            "${{ needs.check.outputs.budget_validated }}",
        )
        step = workflow_step(check, CHECK)
        expected_calls = [
            f"-m torchci.td.scorer check-pytorch --model ../td-scorer/{m}"
            f" --sample ../td-scorer/{s} --pytorch-root ../pytorch"
            for m, s in (
                ("td-scorer.json", "sample.json"),
                ("td-scorer-budget.json", "budget-sample.json"),
            )
        ]
        for plain, budget in [(p, b) for p in (0, 3, 1) for b in (0, 1, 3)]:
            with self.subTest(
                plain=plain, budget=budget
            ), tempfile.TemporaryDirectory() as d:
                (Path(d) / "tools").mkdir()
                stub = Path(d) / "bin" / "python"
                stub.parent.mkdir()
                stub.write_text(STUB_PYTHON)
                stub.chmod(0o755)
                calls = Path(d) / "calls"
                env = {
                    "PATH": f"{stub.parent}:/usr/bin:/bin",
                    "CALLS": str(calls),
                    "PLAIN_CODE": str(plain),
                    "BUDGET_CODE": str(budget),
                }
                code, out, outputs = run_step(step, d, env)
                self.assertEqual(calls.read_text().splitlines(), expected_calls)
                self.assertEqual(code, 0 if plain in (0, 3) else plain)
                budget_ok = "true" if budget == 0 else "false"
                self.assertEqual(outputs.pop("budget_validated"), budget_ok)
                if plain in (0, 3):
                    validated = "true" if plain == 0 else "false"
                    self.assertEqual(outputs, {"validated": validated})
                self.assertEqual("::warning::" in out, budget != 0)
                summary = Path(d) / "summary"
                self.assertEqual(summary.exists(), budget != 0)

    def test_choose(self) -> None:
        step = workflow_step(self.jobs["publish"], CHOOSE)
        # A budget model without a block publishes whatever the variable says.
        for value in ("on", "off"):
            got = run_choose(step, self.plain, self.plain, value)
            self.assertEqual(got, (0, self.plain, {}))
        self.assertEqual(
            run_choose(step, self.plain, self.budgeted), (0, self.budgeted, {})
        )
        code, published, outputs = run_choose(step, self.plain, self.budgeted, "off")
        self.assertEqual((code, published), (0, self.plain))
        self.assertIn("TD_SCORER_BUDGET is not on", outputs["refused"])
        for validated in ("false", ""):
            for budgeted in (self.budgeted, self.plain):
                with self.subTest(validated=validated, block="budget" in budgeted):
                    got = run_choose(step, self.plain, budgeted, "on", validated)
                    self.assertEqual(got[:2], (0, self.plain))
                    self.assertIn("did not validate", got[2]["refused"])
        code, published, outputs = run_choose(step, self.plain, "[1", "on")
        self.assertEqual((code, published), (0, self.plain))
        self.assertIn("not valid JSON", outputs["refused"])
        # td-scorer.json never carries a budget block.
        with tempfile.TemporaryDirectory() as d:
            write_models(d, self.budgeted, self.budgeted)
            env = {"TD_SCORER_BUDGET": "on", "BUDGET_VALIDATED": "true"}
            code, out, outputs = run_step(step, d, env)
        self.assertEqual((code, outputs), (1, {}))
        self.assertIn("::error::td-scorer.json has a budget block", out)

    def test_refused_fails_the_job(self) -> None:
        step = workflow_step(self.jobs["publish"], REFUSED)
        self.assertEqual(step["if"], "steps.choose.outputs.refused != ''")
        with tempfile.TemporaryDirectory() as d:
            code, out, _ = run_step(step, d, {"REFUSED": "why"})
        self.assertEqual(code, 1)
        self.assertIn("::error::why", out)

    def git(self, cwd, *args) -> str:
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(cwd),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        }
        done = subprocess.run(
            ["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True
        )
        return done.stdout

    def push(self, live, plain, budgeted, choose=None):
        """Runs the push step on a generated-stats branch holding `live` (stats file
        name to model), after the choose step when `choose` is its BUDGET_VALIDATED:
        (stdout, the branch's new commits as lists of changed paths, its stats files)."""
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name)
        origin = root / "origin.git"
        self.git(root, "init", "-q", "--bare", str(origin))
        seed = root / "seed"
        (seed / "stats").mkdir(parents=True)
        (seed / "stats" / "other.json").write_text("{}")
        for name, m in live.items():
            (seed / "stats" / name).write_text(model_json.dumps(m))
        self.git(seed, "init", "-q")
        self.git(seed, "add", ".")
        self.git(seed, "commit", "-q", "-m", "seed")
        self.git(seed, "push", "-q", str(origin), "HEAD:generated-stats")
        url = f"file://{origin}"
        self.git(
            root,
            "clone",
            "-q",
            "--depth=1",
            "-b",
            "generated-stats",
            url,
            "generated-stats",
        )
        write_models(root, plain, budgeted)
        if choose is not None:
            env = {"TD_SCORER_BUDGET": "on", "BUDGET_VALIDATED": choose}
            self.assertEqual(
                run_step(workflow_step(self.jobs["publish"], CHOOSE), root, env)[0], 0
            )
        code, out, _ = run_step(workflow_step(self.jobs["publish"], PUSH), root, {})
        self.assertEqual(code, 0, out)
        log = self.git(origin, "log", "--format=%x00", "--name-only", "generated-stats")
        commits = [sorted(c.split()) for c in log.split("\x00")[1:]][:-1]
        listed = self.git(origin, "ls-tree", "--name-only", "generated-stats", "stats/")
        files = {
            name: json.loads(self.git(origin, "show", f"generated-stats:stats/{name}"))
            for name in ("td-scorer.json", "td-scorer-budget.json")
            if f"stats/{name}" in listed.split()
        }
        return out, commits, files

    def test_push(self) -> None:
        both = ["stats/td-scorer-budget.json", "stats/td-scorer.json"]
        old = model(0.5)
        off = {**old, "enabled": False}
        out, commits, files = self.push({}, self.plain, self.budgeted)
        self.assertEqual(commits, [both])
        self.assertEqual(
            files,
            {"td-scorer.json": self.plain, "td-scorer-budget.json": self.budgeted},
        )
        out, commits, files = self.push(
            {"td-scorer.json": old, "td-scorer-budget.json": old},
            self.plain,
            self.budgeted,
        )
        self.assertEqual(commits, [both])
        # A disabled td-scorer.json stops both files.
        live = {"td-scorer.json": off, "td-scorer-budget.json": old}
        out, commits, files = self.push(live, self.plain, self.budgeted)
        self.assertEqual((commits, files), ([], live))
        self.assertIn("No changes to push", out)
        # ... and keeps td-scorer-budget.json from being created.
        out, commits, files = self.push(
            {"td-scorer.json": off}, self.plain, self.budgeted
        )
        self.assertEqual((commits, files), ([], {"td-scorer.json": off}))
        # A disabled td-scorer-budget.json stays while td-scorer.json updates.
        live = {"td-scorer.json": old, "td-scorer-budget.json": off}
        out, commits, files = self.push(live, self.plain, self.budgeted)
        self.assertEqual(commits, [["stats/td-scorer.json"]])
        self.assertEqual(
            files, {"td-scorer.json": self.plain, "td-scorer-budget.json": off}
        )
        # A live td-scorer.json from a later refit (a re-run of an older run) stays,
        # and so does td-scorer-budget.json.
        newer = {**old, "version": "2026-11-11"}
        live = {"td-scorer.json": newer, "td-scorer-budget.json": old}
        out, commits, files = self.push(live, self.plain, self.budgeted)
        self.assertEqual((commits, files), ([], live))
        self.assertIn("stats/td-scorer.json is newer", out)
        # ... a later td-scorer-budget.json alone stays while td-scorer.json updates.
        live = {"td-scorer.json": old, "td-scorer-budget.json": newer}
        out, commits, files = self.push(live, self.plain, self.budgeted)
        self.assertEqual(commits, [["stats/td-scorer.json"]])
        self.assertEqual(files["td-scorer-budget.json"], newer)
        # A version in the future or that is no date never freezes a file.
        for version in ("2062-11-12", "latest", None, 20261111):
            with self.subTest(version=version):
                odd = {**old, "version": version}
                live = {"td-scorer.json": odd, "td-scorer-budget.json": odd}
                out, commits, files = self.push(live, self.plain, self.budgeted)
                self.assertEqual(commits, [both])
        # A refused budget model: td-scorer.json's model lands under both names.
        out, commits, files = self.push({}, self.plain, self.budgeted, choose="false")
        self.assertEqual(commits, [both])
        self.assertEqual(
            files, {"td-scorer.json": self.plain, "td-scorer-budget.json": self.plain}
        )


if __name__ == "__main__":
    main()
