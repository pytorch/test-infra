import json
import math
from datetime import date, timedelta
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.scorer import model_json, train
from torchci.td.scorer.rows import Rows
from torchci.td.scorer.shards import FIRST_DATA_DAY


RISK = {"intercept": 0.0, "features": {}, "quantiles": [float(i) for i in range(101)]}


def sig_digits_ok(value: float) -> bool:
    return value == float(f"{value:.9g}")


def make_rows(n=4000, seed=0, envs=("linux-a", "linux-b"), raise_every=0):
    rng = np.random.default_rng(seed)
    good = rng.random(n) * (rng.random(n) < 0.3)
    noise = rng.random(n) * (rng.random(n) < 0.3)
    env = rng.integers(0, len(envs), n)
    cost = rng.uniform(20, 200, n)
    z = -4 + 5 * good + 0.3 * (env == 0)
    label = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(np.int8)
    active = np.ones((n, 2), dtype=bool)
    if raise_every:
        active[::raise_every, 0] = False
    return Rows(
        heuristics=["Filepath", "Profiling"],
        scores=np.column_stack([good, noise]),
        active=active,
        build_envs=list(envs),
        env=env.astype(np.int64),
        test_configs=["default"],
        config=np.zeros(n, dtype=np.int64),
        cost=cost,
        label=label,
        weight=np.ones(n),
        pr=np.arange(n, dtype=np.int64),
        trunk=np.zeros(n, dtype=bool),
        day=np.full(n, date(2026, 11, 1).toordinal(), dtype=np.int64),
        base_weight=np.ones(n),
    )


class TestWindows(TestCase):
    def test_days(self) -> None:
        days = train.training_days(date(2026, 11, 20))
        self.assertEqual(days[0], date(2025, 11, 20))
        self.assertEqual(days[-1], date(2026, 11, 5))
        gate = train.gate_days(date(2026, 11, 20))
        self.assertEqual(len(days) + len(gate), train.WINDOW_DAYS)
        days = train.training_days(date(2026, 1, 20))
        self.assertEqual(days[0], FIRST_DATA_DAY)
        self.assertEqual(
            train.training_days(date(2026, 11, 20), 3),
            [date(2026, 11, 3), date(2026, 11, 4), date(2026, 11, 5)],
        )
        early = FIRST_DATA_DAY + timedelta(days=15)
        self.assertEqual(train.training_days(early, 100), [FIRST_DATA_DAY])
        self.assertEqual(train.training_days(FIRST_DATA_DAY), [])
        gate = train.gate_days(date(2026, 11, 20))
        self.assertEqual((gate[0], gate[-1]), (date(2026, 11, 6), date(2026, 11, 19)))


class TestIsotonic(TestCase):
    def test_pav(self) -> None:
        out = train.pav(np.array([1.0, 3.0, 2.0, 4.0]), np.array([1.0, 1.0, 3.0, 1.0]))
        self.assertEqual(out.tolist(), [1.0, 2.25, 2.25, 4.0])
        self.assertEqual(
            train.pav(np.array([2.0, 1.0]), np.ones(2)).tolist(), [1.5, 1.5]
        )

    def assert_table(self, x, y) -> None:
        self.assertEqual(x[0], 0.0)
        self.assertTrue(all(a < b for a, b in zip(x, x[1:])))
        self.assertTrue(all(a <= b for a, b in zip(y, y[1:])))
        self.assertTrue(all(model_json.Y_MIN <= v <= model_json.Y_MAX for v in y))
        self.assertLessEqual(len(x), model_json.MAX_POINTS)
        self.assertTrue(all(sig_digits_ok(v) for v in x + y))

    def test_table(self) -> None:
        scores = np.array([0, 0, 0, 0.5, 0.5, 1.0, -0.3])
        labels = np.array([0, 0, 1, 0, 1, 1, 1])
        x, y = train.isotonic_table(scores, labels, np.ones(7))
        self.assert_table(x, y)
        self.assertEqual(x, [0.0, 0.5, 1.0])
        self.assertAlmostEqual(y[0], 0.5)
        self.assertEqual(y[-1], model_json.Y_MAX)

    def test_table_without_zero_and_empty(self) -> None:
        x, y = train.isotonic_table(np.array([0.2, 0.4]), np.array([0, 1]), np.ones(2))
        self.assertEqual(x, [0.0, 0.2, 0.4])
        self.assertEqual(y[0], model_json.Y_MIN)
        self.assertEqual(
            train.isotonic_table(np.array([]), np.array([]), np.array([])),
            ([0.0], [model_json.Y_MIN]),
        )

    def test_table_merges_to_fit(self) -> None:
        rng = np.random.default_rng(1)
        scores = np.concatenate([np.zeros(500), rng.random(5000)])
        labels = (rng.random(5500) < scores.clip(0.01)).astype(int)
        x, y = train.isotonic_table(scores, labels, rng.uniform(0.5, 2, 5500))
        self.assert_table(x, y)
        self.assertGreater(len(x), 10)

    def test_round_table(self) -> None:
        x, y = model_json.round_table(
            [0.0, 0.20833333333333331, 0.20833333333333334, 0.5],
            [0.1, 0.2, 0.3, 1.0],
        )
        self.assertEqual(x, [0.0, 0.208333333, 0.5])
        self.assertEqual(y, [0.1, 0.3, model_json.Y_MAX])


class TestLogistic(TestCase):
    def test_design_products(self) -> None:
        rng = np.random.default_rng(2)
        n = 50
        dense = rng.normal(size=(n, 3))
        env, cfg = rng.integers(0, 3, n), rng.integers(0, 2, n)
        d = train.Design(dense, env, 2, cfg, 1)
        full = np.column_stack([dense, np.eye(3)[env], np.eye(2)[cfg]])
        v = rng.random(n)
        beta = rng.normal(size=d.size)
        np.testing.assert_allclose(d.z(beta), full @ beta)
        np.testing.assert_allclose(d.xtv(v), full.T @ v)
        np.testing.assert_allclose(d.xtvx(v), full.T @ (full * v[:, None]))

    def test_nonneg_and_kkt(self) -> None:
        rng = np.random.default_rng(3)
        n = 3000
        x = rng.normal(size=(n, 2))
        z = -1 + 1.5 * x[:, 0] - 1.0 * x[:, 1]
        y = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(float)
        dense = np.column_stack([np.ones(n), x])
        d = train.Design(
            dense, np.zeros(n, dtype=np.int64), 0, np.zeros(n, dtype=np.int64), 0
        )
        w = np.ones(n)
        nonneg = np.array([False, True, True, False, False])
        fixed = np.array([False, False, False, True, True])
        beta = train.fit_logistic(d, y, w, nonneg, np.zeros(5), fixed, np.zeros(5))
        self.assertGreater(beta[1], 1.0)
        self.assertEqual(beta[2], 0.0)
        self.assertEqual(beta[3:].tolist(), [0.0, 0.0])
        p = 1 / (1 + np.exp(-d.z(beta)))
        grad = d.xtv(w * (p - y))
        self.assertLess(abs(grad[0]), 1e-5)
        self.assertLess(abs(grad[1]), 1e-5)
        self.assertGreater(grad[2], 0)
        free = train.fit_logistic(
            d, y, w, np.zeros(5, dtype=bool), np.zeros(5), fixed, np.zeros(5)
        )
        self.assertLess(free[2], -0.5)


class TestFitScorer(TestCase):
    def test_fit(self) -> None:
        rows = make_rows(raise_every=7)
        scorer = train.fit_scorer(rows)
        self.assertEqual(set(scorer["heuristics"]), {"Filepath", "Profiling"})
        self.assertGreater(scorer["heuristics"]["Filepath"]["weight"], 0.5)
        for h in scorer["heuristics"].values():
            self.assertGreaterEqual(h["weight"], 0.0)
        self.assertGreater(
            scorer["build_env"]["linux-a"], scorer["build_env"]["linux-b"]
        )
        model = model_json.build_model("2026-11-20", scorer, RISK, {})
        json.loads(model_json.dumps(model))
        p = model_json.p_files(
            model,
            {"Filepath": {"a": 0.9}},
            set(),
            "linux-a",
            "default",
            ["a", "b"],
            np.array([50.0, 50.0]),
        )
        self.assertGreater(p[0], p[1])

    def test_limits_and_names(self) -> None:
        rows = make_rows(envs=("linux-a", "x" * 201, "linux-c"))
        with mock.patch.object(train, "MAX_BUILD_ENVS", 1):
            scorer = train.fit_scorer(rows)
        self.assertEqual(len(scorer["build_env"]), 1)
        self.assertNotIn("x" * 201, scorer["build_env"])

    def test_only_td_heuristics(self) -> None:
        rows = make_rows()
        rows.heuristics = ["Filepath", "Forged"]
        scorer = train.fit_scorer(rows)
        self.assertEqual(set(scorer["heuristics"]), {"Filepath"})

    def test_no_positives(self) -> None:
        rows = make_rows()
        rows.label[:] = 0
        with self.assertRaises(ValueError):
            train.fit_scorer(rows)


def p_file(model, scores, raised, build_env, test_config, test_file, cost):
    p = model_json.p_files(
        model, scores, raised, build_env, test_config, [test_file], np.array([cost])
    )
    return float(p[0])


class TestModelJson(TestCase):
    def model(self):
        scorer = {
            "intercept": -7.123456789123,
            "cost_weight": 0.31,
            "heuristics": {
                "A": {"weight": 0.8, "x": [0.0, 0.5, 1.0], "y": [1e-4, 3e-3, 0.02]},
                "B": {"weight": 1e-20, "x": [0.0], "y": [0.5]},
            },
            "build_env": {"linux-a": 0.12},
            "test_config": {"default": 0.0, "distributed": -0.2},
        }
        return model_json.build_model(
            "2026-11-11", scorer, RISK, {"linux-a": {"default": 13.8, "crossref": 26.1}}
        )

    def test_shape(self) -> None:
        m = self.model()
        self.assertEqual(
            set(m),
            {"schema", "version", "enabled", "start_up_seconds", "scorer", "risk"},
        )
        self.assertEqual(m["schema"], 2)
        self.assertIs(m["enabled"], True)
        self.assertEqual(
            m["start_up_seconds"], {"linux-a": {"default": 13.8, "crossref": 26.1}}
        )
        self.assertEqual(m["scorer"]["intercept"], -7.12345679)
        self.assertEqual(len(m["risk"]["quantiles"]), 101)
        with self.assertRaises(ValueError):
            model_json.dumps({"x": float("nan")})

    def test_p(self) -> None:
        m = self.model()
        cost = 40.0
        c = 3e-3 + (0.02 - 3e-3) * (0.75 - 0.5) / 0.5
        z = -7.12345679 + 0.31 * math.log(cost) + 0.12 + -0.2
        z += 0.8 * math.log(c / (1 - c)) + 1e-20 * math.log(1.0)
        expected = 1 / (1 + math.exp(-z))
        scores = {"A": {"t": 0.75}, "Unknown": {"t": 1.0}}
        self.assertAlmostEqual(
            p_file(m, scores, set(), "linux-a", "distributed", "t", cost),
            expected,
            places=15,
        )
        arr = model_json.p_files(
            m,
            scores,
            set(),
            "linux-a",
            "distributed",
            ["t", "u"],
            np.array([cost, cost]),
        )
        self.assertAlmostEqual(arr[0], expected, places=15)
        c0 = 1e-4
        z0 = (
            -7.12345679
            + 0.31 * math.log(cost)
            + 0.12
            - 0.2
            + 0.8 * math.log(c0 / (1 - c0))
        )
        self.assertAlmostEqual(arr[1], 1 / (1 + math.exp(-z0)), places=15)
        raised = p_file(m, scores, {"A"}, "linux-a", "distributed", "t", cost)
        z_r = -7.12345679 + 0.31 * math.log(cost) + 0.12 - 0.2
        self.assertAlmostEqual(raised, 1 / (1 + math.exp(-z_r)), places=15)
        unseen = p_file(m, {"A": {"t": 5.0}}, None, "new", "new", "t", cost)
        z_u = -7.12345679 + 0.31 * math.log(cost) + 0.8 * math.log(0.02 / 0.98)
        self.assertAlmostEqual(unseen, 1 / (1 + math.exp(-z_u)), places=15)
        neg = p_file(m, {"A": {"t": -1.0}}, None, "new", "new", "t", cost)
        self.assertAlmostEqual(
            neg, p_file(m, {}, None, "new", "new", "t", cost), places=15
        )


if __name__ == "__main__":
    main()
