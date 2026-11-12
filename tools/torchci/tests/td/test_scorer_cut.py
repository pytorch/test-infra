import random
from unittest import main, mock, TestCase

import numpy as np
from test_scorer_gate import model, run, START_UP, TIMES, unit
from torchci.td.scorer import cut, model_json, rows, sample as sample_module, shards


def old_scorer_cut(files, p, costs, budget_ms, must_run):
    """The cut before the budget rule (a = 1, no top-file rule), as the reference."""
    ms = [cut.cost_ms(c) for c in costs]
    selected = {f for f in files if f in must_run}
    used = sum(m for f, m in zip(files, ms) if f in selected)
    rest = [i for i, f in enumerate(files) if f not in must_run]
    for i in sorted(rest, key=lambda i: (-p[i] / costs[i], files[i])):
        if used + ms[i] <= budget_ms:
            selected.add(files[i])
            used += ms[i]
    return selected


def random_job(rng):
    n = rng.randint(1, 40)
    files = sorted(f"test_{i}" for i in rng.sample(range(500), n))
    p = np.array([rng.choice([rng.random(), 0.5, 1e-6]) for _ in files])
    costs = np.array([rng.choice([24.0, 24.0 + rng.random() * 300]) for _ in files])
    must = {f for f in files if rng.random() < 0.1}
    return files, p, costs, must


class TestCut(TestCase):
    def test_scorer_cut(self) -> None:
        files = ["a", "b", "c", "d"]
        p = np.array([0.1, 0.1, 0.5, 0.9])
        costs = np.array([10.0, 10.0, 10.0, 100.0])
        self.assertEqual(cut.scorer_cut(files, p, costs, 20000, set()), {"a", "c"})
        self.assertEqual(
            cut.scorer_cut(files, p, costs, 100000, set()), {"a", "b", "c"}
        )
        # Nothing fits: the first-ranked file.
        self.assertEqual(cut.scorer_cut(files, p, costs, 0, set()), {"c"})
        self.assertEqual(cut.scorer_cut([], p[:0], costs[:0], 0, set()), set())
        self.assertEqual(cut.scorer_cut(files, p, costs, 130000, set()), set(files))
        self.assertEqual(cut.scorer_cut(files, p, costs, 20000, {"d"}), {"d"})
        self.assertEqual(
            cut.scorer_cut(files, p, costs, 120000, {"d", "b"}), {"b", "c", "d"}
        )

    def test_int_ms(self) -> None:
        self.assertEqual(cut.cost_ms(0.0015), 2)
        self.assertEqual(cut.cost_ms(24.0004), 24000)
        files = ["a", "b", "c"]
        costs = np.array([0.1, 0.2, 0.3])
        # 0.1 + 0.2 > 0.3 in floats; in integer ms both fit exactly.
        self.assertEqual(
            cut.scorer_cut(files, np.array([0.9, 0.9, 0.0]), costs, 300, set()),
            {"a", "b"},
        )

    def test_td_include(self) -> None:
        files = list("abcdefgh")
        self.assertEqual(cut.td_include(files, {"g": 2.0, "c": 1.0}), ["g", "c", "a"])
        self.assertEqual(cut.td_include(["b", "a", "c"], {}), ["a"])
        self.assertEqual(cut.td_include([], {}), [])

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
        self.assertEqual(cut.must_run_files(r), {"a"})

    def test_rank_fill_equals_the_old_cut_at_a_1(self) -> None:
        rng = random.Random(0)
        for _ in range(500):
            files, p, costs, must = random_job(rng)
            total = sum(cut.cost_ms(c) for c in costs)
            budget = rng.randint(cut.cost_ms(min(costs)), total)
            self.assertEqual(
                cut.scorer_cut(files, p, costs, budget, must),
                old_scorer_cut(files, p, costs, budget, must),
            )

    def test_scalar_power(self) -> None:
        files, p, costs = ["a", "b"], [0.3, 0.2], [100.0, 50.0]
        for a in (0.25, 0.5, 0.75, 1.0):
            order = cut.rank(files, np.array(p), np.array(costs), set(), a)
            keys = sorted((-(pi / c**a), f) for f, pi, c in zip(files, p, costs))
            self.assertEqual(order.rest, [f for _, f in keys])
        self.assertEqual(cut.rank(files, p, costs, set(), 0.0).rest, ["a", "b"])
        self.assertEqual(cut.rank(files, p, costs, set(), 1.0).rest, ["b", "a"])

    def test_budget_never_exceeded_but_by_must_run_or_the_top_file(self) -> None:
        rng = random.Random(1)
        for _ in range(500):
            files, p, costs, must = random_job(rng)
            ms = {f: cut.cost_ms(c) for f, c in zip(files, costs)}
            a = rng.choice([0.25, 0.5, 0.75, 1.0])
            order = cut.rank(files, p, costs, must, a)
            budget = rng.randint(0, sum(ms.values()))
            selected = cut.fill(order, ms, budget)
            in_job = must & set(files)
            self.assertTrue(in_job <= selected)
            self.assertTrue(selected)
            if sum(ms[f] for f in selected) > budget:
                self.assertIn(selected, (in_job, set(order.rest[:1])))
                if selected == in_job:
                    self.assertGreater(sum(ms[f] for f in in_job), budget)

    def test_top_takes_the_first_ranked_file_past_the_budget(self) -> None:
        rng = random.Random(2)
        for _ in range(500):
            files, p, costs, must = random_job(rng)
            ms = {f: cut.cost_ms(c) for f, c in zip(files, costs)}
            order = cut.rank(files, p, costs, must, rng.choice([0.0, 0.5, 1.0]))
            budget = rng.randint(0, sum(ms.values()))
            plain, top = cut.fill(order, ms, budget), cut.fill(order, ms, budget, True)
            if not order.rest:
                self.assertEqual(top, plain)
                continue
            first = order.rest[0]
            self.assertIn(first, top)
            rest = cut.Ranking(order.must_run + [first], order.rest[1:])
            self.assertEqual(top, cut.fill(rest, ms, budget))
            if first in plain:
                self.assertEqual(top, plain)
        # The first-ranked file costs more than the whole budget, even past must-run.
        order = cut.Ranking(["m"], ["big", "s"])
        ms = {"m": 5, "big": 100, "s": 1}
        self.assertEqual(cut.fill(order, ms, 10), {"m", "s"})
        self.assertEqual(cut.fill(order, ms, 10, True), {"m", "big"})

    def test_rank_by(self) -> None:
        order = cut.rank_by(["a", "b", "c", "d"], {"c": 2.0, "b": 1.0}, {"d"})
        self.assertEqual(order, cut.Ranking(["d"], ["c", "b", "a"]))


def changed(files):
    r = run(1, 7, "a" * 40, "t", {"c": 1.0}, aggregated={"d": 2.0, "c": 1.0})
    return shards.Run(**{**r.__dict__, "changed_files": files})


class TestEvaluator(TestCase):
    def test_no_block_is_the_td_cost_cut(self) -> None:
        ev = cut.Evaluator(model(), rows.JobTimes(TIMES, START_UP))
        job = ev.prepare(changed(["torch/a.py"]), unit(1))
        cuts = ev.cuts(job)
        self.assertEqual(cuts.budgeted, cuts.td_cost)
        self.assertEqual(cuts.include, {"c", "d"})
        self.assertEqual(cuts.budget["mode"], "none")
        self.assertEqual(cuts.budget["budget_ms"], job.td_ms)
        self.assertEqual(job.total_ms, 34000 * 3 + 124000)
        self.assertEqual(
            ev.cut(changed(["torch/a.py"]), unit(1)), (cuts.td_cost, cuts.include)
        )

    def test_budgeted_cut(self) -> None:
        m = model()
        m["budget"] = {"share": 0.3, "spread": 0.5, "cost_exponent": 0.5}
        ev = cut.Evaluator(m, rows.JobTimes(TIMES, START_UP))
        job = ev.prepare(changed(["torch/a.py"]), unit(1))
        self.assertIsNotNone(job.r)
        self.assertEqual(job.build_files, 0)
        cuts = ev.cuts(job)
        share = 0.3 * (1 + 0.5 * job.r)
        self.assertEqual(cuts.budget["mode"], "share")
        self.assertEqual(cuts.budget["budget_ms"], round(share * job.total_ms))
        order = cut.rank(job.files, job.p, job.costs, job.must_run, 0.5)
        self.assertEqual(
            cuts.budgeted, cut.fill(order, job.ms, cuts.budget["budget_ms"], True)
        )
        # Build paths, or an unknown change: the top of the window, 0.3 * 1.5.
        for files in (["setup.py"], None):
            r = shards.Run(**{**changed(files).__dict__, "head_sha": str(files)})
            other = ev.prepare(r, unit(1))
            cuts = ev.cuts(other)
            self.assertEqual(cuts.budget["mode"], "build_paths")
            self.assertEqual(cuts.budget["share"], 0.3 * 1.5)
            top = round(0.3 * 1.5 * other.total_ms)
            self.assertEqual(cuts.budget["budget_ms"], top)
            order = cut.rank(other.files, other.p, other.costs, other.must_run, 0.5)
            self.assertEqual(cuts.budgeted, cut.fill(order, other.ms, top, True))
        self.assertEqual(ev.change(changed(None)), ev.change(changed(["x"])))

    def test_job_budget_and_td_cut(self) -> None:
        ev = cut.Evaluator(model(), rows.JobTimes(TIMES, START_UP))
        r = changed(["torch/a.py"])
        job = ev.prepare(r, unit(1))
        self.assertEqual(cut.job_files(unit(1)), ["a", "b", "c", "d"])
        self.assertEqual(job.include, {"c", "d"})
        no_block = {"share": None, "mode": "none", "cost_exponent": 1.0}
        self.assertEqual(
            cut.job_budget(model(), job), {**no_block, "budget_ms": job.td_ms}
        )
        block = {"budget": {"share": 0.2, "spread": 0.0, "cost_exponent": 0.25}}
        share = {"share": 0.2, "mode": "share", "cost_exponent": 0.25}
        self.assertEqual(
            cut.job_budget(block, job),
            {**share, "budget_ms": round(0.2 * job.total_ms)},
        )

    def test_unserved_job_keeps_td_cut(self) -> None:
        m = model()
        m["budget"] = {"share": 0.3, "spread": 0.5, "cost_exponent": 0.5}
        ev = cut.Evaluator(m, rows.JobTimes(TIMES, {"linux-a": {"other": 5.0}}))
        job = ev.prepare(changed(["torch/a.py"]), unit(1))
        self.assertFalse(job.served)
        self.assertEqual(job.p.tolist(), [0.0] * 4)
        self.assertEqual(job.total_ms, 34000 * 3 + 124000)
        self.assertAlmostEqual(job.seconds({"a", "d"}), 110.0)
        cuts = ev.cuts(job)
        self.assertEqual((cuts.td_cost, cuts.budgeted), ({"c", "d"}, {"c", "d"}))
        self.assertEqual(
            cuts.budget,
            {
                "share": None,
                "mode": cut.NO_START_UP,
                "cost_exponent": None,
                "budget_ms": job.td_ms,
            },
        )

    def test_seconds(self) -> None:
        ev = cut.Evaluator(model(), rows.JobTimes(TIMES, START_UP))
        job = ev.prepare(changed([]), unit(1))
        self.assertAlmostEqual(job.seconds({"a", "d"}), 110.0)
        self.assertEqual(job.used_ms({"a", "d"}), 34000 + 124000)

    def test_share_sampled(self) -> None:
        hits = sum(cut.share_sampled(i, "e", "c") for i in range(20000))
        self.assertTrue(800 < hits < 1200)
        self.assertEqual(cut.share_sampled(5, "e", "c"), cut.share_sampled(5, "e", "c"))


class TestWindowJobs(TestCase):
    def test_first_failing_head(self) -> None:
        shard = shards.DayShard(
            "2026-11-08",
            runs=[
                run(1, 7, "a" * 40, "2026-11-08 01:00:00", {}),
                run(
                    2,
                    7,
                    "b" * 40,
                    "2026-11-08 02:00:00",
                    {"a": 1.0},
                    heuristic="EditedByPR",
                ),
                run(3, 8, "c" * 40, "2026-11-08 03:00:00", {}),
            ],
            units=[
                unit(2, failed=["a", "b"]),
                unit(1, failed=["a"]),
                unit(3, failed=["a"]),
            ],
        )
        jobs = list(cut.window_jobs([shard], {7}))
        self.assertEqual([j.run.run_id for j in jobs], [1, 2, 3])
        self.assertEqual([j.new for j in jobs], [["a"], ["b"], []])
        self.assertEqual([j.must_run_events for j in jobs], [0, 0, 0])
        seen = []
        list(cut.window_jobs([shard], set(), seen.append))
        self.assertEqual(seen, [shard])


class TestSample(TestCase):
    def test_flags_count_served_jobs_only(self) -> None:
        m = model()
        m["budget"] = model_json.BUDGET
        times = rows.JobTimes(TIMES, {"linux-a": {"default": 24.0, "x": 24.0}})
        null = shards.Run(
            **{**changed(None).__dict__, "run_id": 2, "head_sha": "n" * 40}
        )
        other = shards.Unit(2, "linux-a", "other", ["a", "b"], ["c", "d"], [], [], [])
        served = shards.Unit(2, "linux-a", "x", ["a", "b"], ["c", "d"], [], [], [])
        ev = cut.Evaluator(m, times)
        sampled = sample_module.Sample()
        with mock.patch.object(sample_module, "SAMPLE_JOBS", 0):
            sampled.add(ev, ev.prepare(null, other))
            self.assertEqual((sampled.flags, sampled.jobs), (set(), []))
            sampled.add(ev, ev.prepare(null, served))
        self.assertEqual(sampled.flags, {"null_r"})
        self.assertEqual([j["test_config"] for j in sampled.jobs], ["x"])

    def test_flags(self) -> None:
        m = model()
        m["budget"] = model_json.BUDGET
        runs = [
            changed(["torch/a.py"]),
            shards.Run(**{**changed(None).__dict__, "run_id": 2, "head_sha": "n" * 40}),
        ]
        runs.append(
            shards.Run(
                **{**changed(["setup.py"]).__dict__, "run_id": 3, "head_sha": "s" * 40}
            )
        )
        shard = shards.DayShard(
            "2026-11-08", runs=runs, units=[unit(1), unit(2), unit(3)]
        )
        with mock.patch.object(sample_module, "SAMPLE_JOBS", 1):
            sample = sample_module.sample_model(
                m, [shard], rows.JobTimes(TIMES, START_UP)
            )
        self.assertEqual(len(sample.jobs), 3)
        self.assertEqual([j["r"] is None for j in sample.jobs], [False, True, False])
        self.assertEqual([j["build_files"] for j in sample.jobs], [0, None, 1])
        self.assertTrue(all("files" in r for r in sample.r))
        self.assertEqual(set(sample.dump()), {"p", "r", "jobs"})


if __name__ == "__main__":
    main()
