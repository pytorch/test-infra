import math
from unittest import main, TestCase

import numpy as np
from torchci.td.scorer import logs, risk, rows, shards, trunk


def model(quantiles, intercept=0.0, features=None):
    return {
        "risk": {
            "intercept": intercept,
            "features": features or {},
            "quantiles": quantiles,
        }
    }


def unit(run_id, failed=()):
    return shards.Unit(
        run_id, "linux-a", "default", ["a", "b"], ["c"], list(failed), [], []
    )


def run(run_id, pr, sha, files=("torch/a.py",)):
    return shards.Run(
        run_id,
        pr,
        sha,
        "2026-11-05 00:00:00",
        ["A"],
        [],
        {},
        list(files) if files is not None else None,
        {},
    )


class TestFeatures(TestCase):
    def test_change_features(self) -> None:
        f = risk.change_features(
            [
                "test/test_nn.py",
                "torch/nn/a.py",
                "docs/x.rst",
                "README.md",
                "third_party/y.c",
                "torch/b.txt",
            ]
        )
        self.assertEqual(
            f,
            {
                "n_files": 6,
                "n_test_files": 1,
                "n_source_files": 1,
                "n_areas": 5,
                "docs_only": 0,
            },
        )
        self.assertEqual(risk.change_features(["docs/a.py", "x.md"])["docs_only"], 1)
        self.assertEqual(risk.change_features([])["docs_only"], 1)

    def test_risk_r(self) -> None:
        q = [float(i) for i in range(101)]
        m = model(
            q,
            intercept=0.0,
            features={"n_files": {"weight": 1.0, "mean": 0.0, "scale": 1.0}},
        )
        self.assertEqual(risk.risk_r(model(q, -1.0), {}), -1.0)
        self.assertEqual(risk.risk_r(model(q, 100.0), {}), 1.0)
        self.assertAlmostEqual(risk.risk_r(model(q, 50.5), {}), 2 * 0.505 - 1)
        self.assertAlmostEqual(risk.risk_r(m, {"n_files": 0}), -1.0)
        raw = math.log(1 + 20)
        self.assertAlmostEqual(risk.risk_r(m, {"n_files": 20}), 2 * raw / 100 - 1)
        flat = [0.0] * 50 + [1.0] * 51
        self.assertAlmostEqual(risk.risk_r(model(flat, 0.0), {}), 2 * 49 / 100 - 1)
        self.assertAlmostEqual(risk.risk_r(model(flat, 0.5), {}), 2 * 49.5 / 100 - 1)


class TestHeads(TestCase):
    def test_collect_heads(self) -> None:
        shard = shards.DayShard(
            "2026-11-05",
            runs=[
                run(1, 7, "a" * 40),
                run(2, 7, "a" * 40),
                run(3, 8, "b" * 40),
                run(4, 9, "c" * 40),
                run(5, 10, "d" * 40, files=None),
            ],
            units=[unit(1), unit(2, failed=["a"]), unit(3), unit(4, failed=["a"])],
        )
        heads = {}
        risk.collect_heads(shard, heads, exclude_prs={9})
        self.assertEqual(sorted(heads), ["a" * 40, "b" * 40])
        self.assertTrue(heads["a" * 40].positive)
        self.assertFalse(heads["b" * 40].positive)

    def test_trunk_heads(self) -> None:
        log = logs.TDLog({}, ("A",), (), ("torch/x.py",), {})
        no_files = logs.TDLog({}, ("A",), (), None, {})
        pair = lambda pr, sha: trunk.TrunkPair(pr, sha, "e", "c", "f")
        landings = [
            trunk.TrunkLanding(
                "l",
                "2026-11-01",
                (pair(1, "s"), pair(1, "s"), pair(2, "t"), pair(3, "u"), pair(4, "v")),
            ),
        ]
        out = risk.trunk_heads(
            landings, {"s": log, "t": log, "u": no_files, "v": log}, exclude_prs={4}
        )
        self.assertEqual(out, [(["torch/x.py"], rows.W_TRUNK / 2)] * 2)


class TestFit(TestCase):
    def test_fit_and_evaluate(self) -> None:
        rng = np.random.default_rng(0)
        heads = []
        for i in range(600):
            n = int(rng.integers(1, 30))
            files = [f"torch/m{j}.py" for j in range(n)]
            positive = rng.random() < 1 / (1 + math.exp(-(-3 + 0.15 * n)))
            heads.append(risk.Head(i, f"{i:040d}", files, positive))
        trunk_rows = [(["torch/a.py"] * 25, 10.0)]
        block = risk.fit_risk(heads, trunk_rows)
        self.assertEqual(list(block["features"]), list(risk.FEATURES))
        self.assertGreater(block["features"]["n_files"]["weight"], 0)
        self.assertEqual(block["features"]["docs_only"]["scale"], 1.0)
        q = block["quantiles"]
        self.assertEqual(len(q), 101)
        self.assertTrue(all(a <= b for a, b in zip(q, q[1:])))
        m = {"risk": block}
        r, label = risk.labelled(m, heads, {heads[0].head_sha})
        self.assertEqual(label[0], 1)
        self.assertEqual(label.sum(), sum(h.positive for h in heads[1:]) + 1)
        result = risk.evaluate(*risk.labelled(m, heads, set()))
        self.assertGreater(result["auc"], 0.6)
        self.assertAlmostEqual(result["mean_r"], 0.0, delta=0.1)
        with self.assertRaises(ValueError):
            risk.fit_risk([], [])
        self.assertTrue(math.isnan(risk.evaluate(*risk.labelled(m, [], set()))["auc"]))

    def test_weighted_auc(self) -> None:
        self.assertEqual(
            risk.weighted_auc(np.array([1, 2, 3, 4.0]), np.array([0, 0, 1, 1])), 1.0
        )
        self.assertEqual(risk.weighted_auc(np.array([1, 1.0]), np.array([0, 1])), 0.5)
        self.assertAlmostEqual(
            risk.weighted_auc(
                np.array([1, 2, 3.0]), np.array([1, 0, 1]), np.array([1.0, 1.0, 3.0])
            ),
            0.75,
        )
        self.assertTrue(math.isnan(risk.weighted_auc(np.array([1.0]), np.array([1]))))


if __name__ == "__main__":
    main()
