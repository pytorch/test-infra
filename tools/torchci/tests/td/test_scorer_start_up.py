from datetime import date, timedelta
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm.events_sql import TD_SCOPE
from torchci.td.scorer import model_json, rows_sql, shards, start_up


def shard_rows(
    env="linux-a",
    config="default",
    runs=40,
    per_run=10,
    c=500.0,
    a=0.3,
    b=3.0,
    noise=20.0,
    n=None,
    n_max=200,
    seed=1,
):
    rng = np.random.default_rng(seed)
    out = []
    for r in range(runs):
        for _ in range(per_run):
            files = float(rng.integers(5, n_max)) if n is None else float(n)
            s = float(rng.uniform(100, 5000))
            y = c + a * s + b * files + float(rng.normal(0, noise))
            out.append(
                {
                    "build_env": env,
                    "test_config": config,
                    "run_id": str(1000 + r),
                    "y": y,
                    "s": s,
                    "n": files,
                }
            )
    return out


def fit(rows):
    (data,) = start_up.group(rows).values()
    return start_up.fit_config("e", "c", data)


class TestFit(TestCase):
    def test_recovers_k(self) -> None:
        f = fit(shard_rows())
        self.assertTrue(f.accepted, f.reason)
        self.assertAlmostEqual(f.k, 10.0, delta=0.5)
        self.assertLessEqual(f.lo, f.k)
        self.assertLessEqual(f.k, f.hi)
        self.assertEqual((f.shards, f.runs, f.finite), (400, 40, 1.0))
        self.assertAlmostEqual(f.a, 0.3, delta=0.01)
        self.assertAlmostEqual(f.c, 500.0, delta=20.0)
        self.assertEqual(f.reason, "")

    def test_same_fit_every_time(self) -> None:
        self.assertEqual(fit(shard_rows()), fit(shard_rows()))

    def test_rejects_a_constant_file_count(self) -> None:
        f = fit(shard_rows(n=1))
        self.assertFalse(f.accepted)
        self.assertTrue(np.isnan(f.k))
        self.assertIn("no fit", f.reason)

    def test_rejects_two_file_counts(self) -> None:
        data = start_up.group(shard_rows())[("linux-a", "default")]
        data[:, 3] = np.where(np.arange(len(data)) % 2, 10.0, 20.0)
        f = start_up.fit_config("e", "c", data)
        self.assertFalse(f.accepted)
        self.assertIn("no fit", f.reason)

    def test_degenerate_inputs_do_not_raise(self) -> None:
        constant_y = shard_rows(a=0.0, b=0.0, noise=0.0)
        f = fit(constant_y)
        self.assertFalse(f.accepted)
        self.assertIsNone(start_up.ols(np.zeros((2, 4))))
        collinear = start_up.group(shard_rows())[("linux-a", "default")]
        collinear[:, 2] = 7 * collinear[:, 3]
        self.assertIsNone(start_up.ols(collinear))
        self.assertTrue(np.isnan(start_up.k_of(None)))
        self.assertTrue(np.isnan(start_up.k_of(np.array([1.0, -0.5, 3.0]))))

    def test_rejects_a_below_min(self) -> None:
        f = fit(shard_rows(a=0.05, b=0.5, noise=2.0))
        self.assertAlmostEqual(f.k, 10.0, delta=1.0)
        self.assertFalse(f.accepted)
        self.assertEqual(f.reason, f"a not >= {start_up.MIN_A}")

    def test_rejects_k_out_of_bounds(self) -> None:
        for b, k in ((0.15, 0.5), (210.0, 700.0)):
            f = fit(shard_rows(b=b, noise=2.0, n_max=60))
            self.assertAlmostEqual(f.k, k, delta=0.1 * k)
            self.assertFalse(f.accepted)
            self.assertIn("k not in [1, 600]", f.reason)

    def test_rejects_too_few_shards_or_runs(self) -> None:
        few_shards = shard_rows(runs=start_up.MIN_RUNS + 10)[: start_up.MIN_SHARDS - 1]
        few_runs = shard_rows(runs=start_up.MIN_RUNS - 1, per_run=20)
        for rows in (few_shards, few_runs):
            f = fit(rows)
            self.assertFalse(f.accepted)
            self.assertEqual(f.reason, "too few shards or runs")
            self.assertTrue(np.isnan(f.k))
        self.assertTrue(fit(shard_rows(runs=start_up.MIN_RUNS, per_run=10)).accepted)

    def test_rejects_a_wide_interval(self) -> None:
        f = fit(shard_rows(noise=1500.0))
        self.assertTrue(np.isfinite(f.k))
        self.assertGreater(f.hi - f.lo, max(0.5 * f.k, 4.0))
        self.assertFalse(f.accepted)
        self.assertEqual(f.reason, "90% interval too wide")

    def test_trims_an_outlier_run(self) -> None:
        rows = shard_rows()
        for r in rows:
            if r["run_id"] == "1000":
                r["y"] += 60 * r["n"]
        (data,) = start_up.group(rows).values()
        untrimmed = start_up.k_of(start_up.ols(data))
        self.assertGreater(abs(untrimmed - 10.0), 2.0)
        f = start_up.fit_config("e", "c", data)
        self.assertTrue(f.accepted, f.reason)
        self.assertAlmostEqual(f.k, 10.0, delta=0.5)


class TestGroup(TestCase):
    def test_bounds_and_platforms(self) -> None:
        good = {"build_env": "linux-a", "test_config": "default", "run_id": "1"}
        rows = [
            {**good, "y": 100.0, "s": 50.0, "n": 3.0},
            {**good, "y": 4 * 3600.0, "s": 16 * 4 * 3600.0, "n": 2000.0},
            {**good, "build_env": "macos-py3-arm64", "y": 100.0, "s": 50.0, "n": 3.0},
            {**good, "y": 0.0, "s": 0.0, "n": 3.0},
            {**good, "y": 4 * 3600.0 + 1, "s": 50.0, "n": 3.0},
            {**good, "y": 100.0, "s": 50.0, "n": 0.0},
            {**good, "y": 100.0, "s": 50.0, "n": 2001.0},
            {**good, "y": 100.0, "s": 1601.0, "n": 3.0},
            {**good, "y": 100.0, "s": -1.0, "n": 3.0},
        ]
        grouped = start_up.group(rows)
        self.assertEqual(list(grouped), [("linux-a", "default")])
        self.assertEqual(
            grouped[("linux-a", "default")][:, 1].tolist(), [100.0, 14400.0]
        )


def accepted(env, config, shards_, k=10.0):
    return start_up.ConfigFit(
        env, config, shards_, 40, c=500.0, a=0.3, k=k, lo=k - 1, hi=k + 1, finite=1.0
    )


class TestTable(TestCase):
    def test_accepted_valid_names_only(self) -> None:
        fits = [
            accepted("linux-a", "default", 400, k=10.123456789123),
            accepted("linux-a", "distributed", 300, k=3.9),
            accepted("x" * (model_json.MAX_NAME + 1), "default", 900),
            accepted("linux-b", "", 900),
            start_up.ConfigFit("linux-c", "default", 100, 5),
        ]
        self.assertEqual(
            start_up.table(fits),
            {"linux-a": {"default": 10.1234568, "distributed": 3.9}},
        )

    def test_caps_keep_the_most_shards(self) -> None:
        fits = [
            accepted("linux-a", "default", 400),
            accepted("linux-a", "distributed", 900),
            accepted("linux-b", "default", 1000),
            accepted("linux-b", "crossref", 1000),
        ]
        with mock.patch.object(start_up, "MAX_BUILD_ENVS", 1), mock.patch.object(
            start_up, "MAX_TEST_CONFIGS", 1
        ):
            self.assertEqual(start_up.table(fits), {"linux-b": {"crossref": 10.0}})
        self.assertEqual(start_up.table([]), {})


class TestText(TestCase):
    def test_names_are_quoted(self) -> None:
        fits = [
            accepted("evil\nresult: PASS", "default", 400),
            start_up.ConfigFit("linux-b", "x\ny", 500, 40),
            start_up.ConfigFit("linux-c", "default", 10, 2),
        ]
        out = start_up.text(fits)
        self.assertIn("'evil\\nresult: PASS' 'default': shards 400, runs 40", out)
        self.assertIn("k 10.0 (90% 9.0..11.0)", out)
        self.assertIn("2 configs rejected, 1 of them with fewer than 300", out)
        self.assertIn("'linux-b' 'x\\ny': shards 500", out)
        self.assertNotIn("linux-c", out)
        lines = out.splitlines()
        self.assertEqual(len(lines), 4)
        for line in lines[1:]:
            if line.startswith("  "):
                self.assertTrue(line.startswith("  '"), line)


class TestFetch(TestCase):
    def test_one_query_per_day(self) -> None:
        with mock.patch.object(shards, "query", return_value=[{"x": 1}]) as query:
            out = start_up.fetch(date(2026, 11, 10))
        self.assertEqual(out, [{"x": 1}] * start_up.DAYS)
        days = [date(2026, 11, 10) - timedelta(days=i) for i in range(7, 0, -1)]
        self.assertEqual(
            [c.args for c in query.call_args_list],
            [("td_scorer_start_up", start_up.SQL, shards.ch_day(d)) for d in days],
        )

    def test_sql(self) -> None:
        sql = start_up.SQL
        self.assertIsInstance(sql, str)
        for part in (
            "{start: DateTime64(3)}",
            "{stop: DateTime64(3)}",
            "materialized_views.workflow_job_by_created_at",
            "ORDER BY _inserted_at DESC",
            "LIMIT 1 BY id",
            "startsWith(dynamoKey, 'pytorch/pytorch/')",
            "workflow_name AS workflow",
            TD_SCOPE,
            rows_sql.JOB_COLUMNS,
            rows_sql.IS_FILE,
            "j.run_id = t.workflow_id",
            "toFloat64(uniqExact(t.invoking_file)) AS n",
        ):
            self.assertIn(part, sql)
        self.assertTrue(sql.rstrip().endswith(rows_sql.SETTINGS))
        self.assertNotIn("{{", sql)


if __name__ == "__main__":
    main()
