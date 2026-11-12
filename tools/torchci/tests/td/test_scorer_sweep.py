import argparse
import json
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Optional
from unittest import main, mock, TestCase

import numpy as np
from test_scorer_gate import model, run, START_UP, TestCli, TIMES, unit
from torchci.td.scorer import (
    __main__ as cli,
    cut,
    gate,
    holdout,
    logs,
    main_failures,
    model_json,
    rows,
    shards,
    store,
    sweep,
    sweep_inputs,
    trunk,
)


DAY = date(2026, 11, 10)


def fixture():
    t = TestCli()
    t.broken, t.gap = set(), set()
    return t


def landing(day, failed=("a",)):
    log = logs.TDLog({"Filepath": {"a": 1.0}}, ("Filepath",), (), ("x",), {"a": 1.0})
    mu = main_failures.MainUnit("linux-a", "default", ("a", "b", "c", "d"), failed)
    return main_failures.MainLanding(f"{day}-landing", 9, day, log, (mu,))


class TestGrid(TestCase):
    def test_grid_skips_invalid_points(self) -> None:
        points = sweep.grid()
        self.assertIn(sweep.Point(0.5, 0.0, 0.10), points)
        self.assertNotIn(sweep.Point(0.5, 0.25, 0.10), points)
        self.assertIn(sweep.Point("td", 0.75, 0.40), points)
        self.assertNotIn(sweep.Point("td", 0.75, 0.35), points)
        self.assertEqual(sweep.parse_orders("0.5,td"), [0.5, "td"])
        custom = sweep.grid([0.5], [0.0, 0.3], [0.14, 0.145])
        self.assertEqual(len(custom), 3)

    def test_scorer_equals_the_budgeted_cut(self) -> None:
        times = rows.JobTimes(TIMES, START_UP)
        points = sweep.grid([0.25, 1.0, "td"], [0.0, 0.5], [0.2, 0.4])
        scorer = sweep.Scorer(model(), times, points)
        cases = [
            (["torch/a.py"], {"a": 1.0, "c": 0.3}),
            (["setup.py"], {"c": 1.0}),
            (None, {"b": 0.5}),
        ]
        for i, (files, scores) in enumerate(cases):
            r = run(i, 7, f"{i:040d}", "t", scores, aggregated={"d": 2.0, "b": 1.0})
            r = shards.Run(**{**r.__dict__, "changed_files": files})
            u = unit(i, ran=("a", "b", "c", "d", "e"), excluded=("f",))
            job, cuts, mode = scorer.cuts(r, u)
            self.assertEqual(np.isnan(sweep._r(job)), files is None)
            self.assertEqual(
                mode, "share" if files == ["torch/a.py"] else "build_paths"
            )
            for point, got in zip(points, cuts):
                m = model()
                m["budget"] = point.block()
                ev = cut.Evaluator(m, times)
                want = ev.cuts(ev.prepare(r, u))
                if point.order != "td":
                    self.assertEqual(got, want.budgeted, (point, files))
                    continue
                order = cut.rank_by(job.files, r.aggregated, job.must_run)
                want_td = cut.fill(order, job.ms, want.budget["budget_ms"], True)
                self.assertEqual(got, want_td)

    def test_unserved_job_keeps_td_cut_at_every_point(self) -> None:
        times = rows.JobTimes(TIMES, {"linux-a": {"other": 24.0}})
        points = sweep.grid([0.5, "td"], [0.0], [0.1, 0.4])
        r = run(1, 7, "a" * 40, "t", {"a": 1.0}, aggregated={"d": 2.0, "b": 1.0})
        job, cuts, mode = sweep.Scorer(model(), times, points).cuts(r, unit(1))
        self.assertFalse(job.served)
        self.assertEqual(mode, cut.NO_START_UP)
        self.assertEqual(cuts, [job.include] * len(points))


class TestAgreesWithTheGate(TestCase):
    def test_retention_and_share_match_the_gate(self) -> None:
        m = model()
        m["budget"] = dict(model_json.BUDGET)
        agg = {"c": 1.0, "d": 2.0}
        runs = [
            run(1, 7, "a" * 40, "t1", {"c": 1.0}, aggregated=agg),
            run(2, 8, "b" * 40, "t2", {"c": 1.0}, aggregated=agg),
            run(3, 9, "c" * 40, "t3", {"d": 1.0}, aggregated=agg),
        ]
        units = [
            unit(1, failed=["c", "d"]),
            unit(2, failed=["d"]),
            unit(3, failed=["a"]),
            shards.Unit(2, "linux-a", "other", ["a", "b"], ["c", "d"], ["c"], [], []),
        ]
        shard = shards.DayShard("2026-11-08", runs=runs, units=units)
        times = rows.JobTimes(TIMES, START_UP)
        point = sweep.Point(0.5, m["budget"]["spread"], m["budget"]["share"])
        tally = sweep.Tally(1)
        with mock.patch.object(
            gate, "share_sampled", return_value=True
        ), mock.patch.object(sweep, "share_sampled", return_value=True):
            w = gate.evaluate_window(m, [shard], {7, 8, 9}, [], times)
            scorer = sweep.Scorer(m, times, [point])
            sweep.score_prs(scorer, [shard], {7, 8, 9}, "2026-11", tally)
        kept = sum(int(k[0]) for k in tally.pr_kept.values())
        self.assertEqual(
            (len(tally.pr_kept), kept), (w.retention_prs, w.retention_kept)
        )
        self.assertEqual(
            (tally.share_jobs, tally.total_ms, int(tally.cost_ms[0])),
            (w.share_jobs, w.share_total_ms, w.share_cost_ms),
        )
        self.assertAlmostEqual(tally.seconds[0], w.share_seconds)
        self.assertGreater(w.retention_prs, 0)


class TestArgs(TestCase):
    def test_bad_args(self) -> None:
        base = {
            "start_up": "/x/start-up.json",
            "model": None,
            "out": "/x/out.json",
            "cache_dir": "/x/cache",
            "test_times": "/x/times.json",
            "main_cache": "/x/main.json",
        }
        self.assertIsNone(sweep_inputs.bad_args(argparse.Namespace(**base)))
        self.assertIsNone(
            sweep_inputs.bad_args(
                argparse.Namespace(**{**base, "start_up": None, "model": "/x/m.json"})
            )
        )
        refused: list[dict[str, Optional[str]]] = [
            {"start_up": None},
            {"model": "/x/m.json"},
            {"out": "/x/out.npz"},
            {"out": "/x/cache/2026-11-01.jsonl.gz"},
            {"out": "/x/times.json"},
            {"out": "/x/main.json"},
            {"out": "/x/start-up.json"},
            {"out": "/x/main", "main_cache": "/x/main.npz"},
        ]
        for change in refused:
            with self.subTest(change=change):
                args = argparse.Namespace(**{**base, **change})
                self.assertIsNotNone(sweep_inputs.bad_args(args))


class TestSweep(TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.d = Path(self.dir.name)
        self.cache = self.d / "cache"
        self.times = self.d / "test-times.json"
        self.times.write_text(json.dumps(TIMES))
        self.start_up = self.d / "start-up.json"
        self.start_up.write_text(model_json.dumps(model()))
        self.t = fixture()

    def tearDown(self) -> None:
        self.dir.cleanup()

    def populate(self, days, held=True) -> None:
        shard_store = store.DirStore(self.cache)
        for d in days:
            shard_store.put_if_absent(d.isoformat(), store.dump_shard(self.t.build(d)))
        if held:
            held_store = store.DirStore(self.cache / "holdout")
            data = store.dump_shard(self.t.holdout_set())
            held_store.put_if_absent(holdout.HOLDOUT_KEY, data)

    def args(self, *extra, train_days=75):
        return [
            "sweep",
            "--day",
            DAY.isoformat(),
            "--train-days",
            str(train_days),
            "--gate-days",
            "2",
            "--cache-dir",
            str(self.cache),
            "--test-times",
            str(self.times),
            "--start-up",
            str(self.start_up),
            "--main-cache",
            str(self.d / "main.json"),
            "--out",
            str(self.d / "out.json"),
            *extra,
        ]

    def test_read_only_store(self) -> None:
        ro = sweep_inputs.ReadOnlyDirStore(self.d / "nowhere")
        self.assertFalse((self.d / "nowhere").exists())
        self.assertIsNone(ro.get("2026-11-01"))
        with self.assertRaises(RuntimeError):
            ro.put_if_absent("2026-11-01", b"")
        self.assertFalse((self.d / "nowhere").exists())

    def test_missing_shard_or_holdout_writes_nothing(self) -> None:
        fetch = mock.Mock(side_effect=AssertionError("fetched"))
        with mock.patch.object(main_failures, "fetch_main_landings", fetch):
            self.assertEqual(cli.main(self.args()), 1)
            self.assertFalse(self.cache.exists())
            days = [DAY - timedelta(days=i) for i in range(1, 78)]
            self.populate(days[1:])
            self.assertEqual(cli.main(self.args()), 1)
            self.populate(days[:1], held=False)
            (self.cache / "holdout" / f"{holdout.HOLDOUT_KEY}.jsonl.gz").unlink()
            self.assertEqual(cli.main(self.args()), 1)
        self.assertEqual(
            sorted(p.name for p in self.d.iterdir()),
            ["cache", "start-up.json", "test-times.json"],
        )

    def test_sweep_rows(self) -> None:
        days = [DAY - timedelta(days=i) for i in range(1, 78)]
        self.populate(days)
        marker = store.dump_shard(shards.DayShard(day="x"))
        store.DirStore(self.cache).put_if_absent(f"{days[0]}{store.GAP_SUFFIX}", marker)
        found = [landing("2026-10-05"), landing("2026-11-03", ("e",))]
        fetch = mock.Mock(return_value=(found, {"landings_found": 2}))
        grid = ["--orders", "1.0,td", "--spreads", "0", "--bases", "0.25,1.0"]
        with mock.patch.object(
            main_failures, "fetch_main_landings", fetch
        ), mock.patch.object(
            trunk, "fetch_landings", return_value=[]
        ), mock.patch.object(trunk, "fetch_head_logs", return_value={}):
            self.assertEqual(cli.main(self.args(*grid)), 0)
            self.assertEqual(fetch.call_count, 1)
            # The main cache is read, not fetched, on the next run.
            self.assertEqual(cli.main(self.args(*grid)), 0)
            self.assertEqual(fetch.call_count, 1)
        out = json.loads((self.d / "out.json").read_text())
        meta, got = out["meta"], out["rows"]
        self.assertEqual(meta["windows"], ["2026-10", "2026-11"])
        self.assertEqual(meta["gap_days"], [days[0].isoformat()])
        self.assertEqual(len(meta["test_times"]["sha256"]), 64)
        self.assertEqual(meta["start_up"]["path"], str(self.start_up))
        self.assertEqual(meta["main_cache"]["counts"], {"landings_found": 2})
        self.assertEqual(
            [(r["order"], r["base"]) for r in got],
            [(1.0, 0.25), (1.0, 1.0), ("td", 0.25), ("td", 1.0)],
        )
        full = got[1]
        self.assertEqual(full["main_landings"], 2)
        self.assertEqual(full["main_failures"], 2)
        # 'e' never ran on main, so no cut catches it; all files at a share of 1.
        self.assertEqual(full["main_landings_caught"], 1)
        self.assertEqual(full["td_main_landings_caught"], 1)
        self.assertAlmostEqual(full["cost_share"], 1.0)
        self.assertAlmostEqual(full["seconds_share"], 1.0)
        self.assertEqual(full["retention"], 1.0)
        self.assertEqual(full["event_retention"], 1.0)
        self.assertGreater(full["retention_prs"], 0)
        self.assertGreater(full["share_jobs"], 0)
        self.assertEqual((full["holdout_events"], full["holdout_caught"]), (1, 1))
        self.assertLess(got[0]["cost_share"], 0.5)
        for row in got:
            self.assertLessEqual(row["retention_kept"], row["retention_prs"])
            self.assertLessEqual(row["main_landings_caught"], row["main_landings"])
        vectors = np.load(self.d / "out.npz")
        self.assertEqual(vectors["landing_caught"].shape, (2, 4))
        self.assertEqual(vectors["pr_kept"].shape, (full["retention_prs"], 4))
        self.assertEqual(list(vectors["landing_month"]), ["2026-10", "2026-11"])
        self.assertEqual(list(vectors["landing_td_caught"]), [1, 0])
        self.assertEqual(list(vectors["landing_mode"]), ["share", "share"])
        self.assertTrue(np.isfinite(vectors["landing_r"]).all())
        self.assertEqual(len(vectors["pr_r"]), full["retention_prs"])
        self.assertTrue(set(vectors["pr_mode"]) <= {"share", "build_paths"})
        # A cache of another window is refused, before anything is written.
        (self.d / "out.json").unlink()
        with mock.patch.object(trunk, "fetch_landings", return_value=[]):
            with self.assertRaises(ValueError):
                cli.main(self.args(*grid, train_days=60))
        self.assertFalse((self.d / "out.json").exists())

    def test_start_up_is_needed_without_a_model(self) -> None:
        self.populate([DAY - timedelta(days=i) for i in range(1, 78)])
        args = self.args()
        i = args.index("--start-up")
        del args[i : i + 2]
        with mock.patch.object(trunk, "fetch_landings", return_value=[]):
            self.assertEqual(cli.main(args), 1)
        self.assertFalse((self.d / "out.json").exists())
        self.assertFalse((self.d / "main.json").exists())

    def test_one_model(self) -> None:
        days = [DAY - timedelta(days=i) for i in range(1, 3)]
        self.populate(days)
        path = self.d / "model.json"
        m = model()
        path.write_text(model_json.dumps(m))
        found = [landing("2026-11-08"), landing("2026-10-01")]
        main_failures.save_landings(
            self.d / "main.json", found, days[-1], DAY, {"landings_found": 2}
        )
        assemble = mock.Mock(side_effect=AssertionError("fitted"))
        args = self.args("--model", str(path), "--bases", "0.5")
        i = args.index("--start-up")
        with mock.patch.object(sweep, "assemble", assemble):
            self.assertEqual(cli.main(args), 1)
            del args[i : i + 2]
            code = cli.main(args)
        self.assertEqual(code, 0)
        out = json.loads((self.d / "out.json").read_text())
        self.assertEqual(out["meta"]["model"]["path"], str(path))
        self.assertEqual(out["meta"]["windows"], ["2026-11"])
        self.assertTrue(all(r["main_landings"] == 1 for r in out["rows"]))
        self.assertTrue(all(r["holdout_events"] == 1 for r in out["rows"]))


if __name__ == "__main__":
    main()
