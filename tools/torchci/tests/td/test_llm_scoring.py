import math
from unittest import main, TestCase

import numpy as np
from torchci.td.llm import scoring


def unit(*values: float) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float32)
    return vector / np.linalg.norm(vector)


class TestFileScores(TestCase):
    def setUp(self) -> None:
        self.units = np.stack([unit(1, 0), unit(0, 1), unit(1, 1), unit(-1, 0)])
        self.tests = ["b", "a", "b", "c"]
        self.query = np.stack([unit(1, 0), unit(0, 1)])

    def test_max_over_units_then_max_over_chunks(self) -> None:
        scores = scoring.file_scores(self.query, self.units, self.tests, "max")
        self.assertEqual(sorted(scores), ["a", "b", "c"])
        self.assertAlmostEqual(scores["b"], 1.0, places=6)
        self.assertAlmostEqual(scores["a"], 1.0, places=6)
        self.assertAlmostEqual(scores["c"], 0.0, places=6)

    def test_mean_over_chunks(self) -> None:
        scores = scoring.file_scores(self.query, self.units, self.tests, "mean")
        # b: chunk 1 best is 1.0 (unit 0), chunk 2 best is 0.7071 (unit 2).
        self.assertAlmostEqual(scores["b"], (1.0 + math.sqrt(0.5)) / 2, places=6)
        self.assertAlmostEqual(scores["a"], 0.5, places=6)
        self.assertAlmostEqual(scores["c"], (-1.0 + 0.0) / 2, places=6)

    def test_matches_brute_force(self) -> None:
        rng = np.random.default_rng(0)
        units = rng.normal(size=(50, 8)).astype(np.float32)
        units /= np.linalg.norm(units, axis=1, keepdims=True)
        query = rng.normal(size=(5, 8)).astype(np.float32)
        tests = [f"t{i % 7}" for i in rng.permutation(50)]
        sims = query @ units.T
        for agg in scoring.AGGREGATIONS:
            scores = scoring.file_scores(query, units, tests, agg)
            self.assertEqual(sorted(scores), sorted(set(tests)))
            for name, value in scores.items():
                columns = [i for i, t in enumerate(tests) if t == name]
                per_chunk = sims[:, columns].max(axis=1)
                expected = per_chunk.max() if agg == "max" else per_chunk.mean()
                self.assertAlmostEqual(value, float(expected), places=6)

    def test_no_query_rows_or_no_units(self) -> None:
        self.assertEqual(
            scoring.file_scores(np.zeros((0, 2)), self.units, self.tests, "max"), {}
        )
        self.assertEqual(
            scoring.file_scores(self.query, np.zeros((0, 2)), [], "max"), {}
        )

    def test_scores_are_python_floats(self) -> None:
        scores = scoring.file_scores(self.query, self.units, self.tests, "max")
        self.assertTrue(all(type(v) is float for v in scores.values()))

    def test_rejects_bad_arguments(self) -> None:
        with self.assertRaises(ValueError):
            scoring.file_scores(self.query, self.units, self.tests, "median")
        with self.assertRaises(ValueError):
            scoring.file_scores(self.query, self.units, self.tests[:3], "max")


class TestTransform(TestCase):
    def test_cut_is_tds_top_quarter(self) -> None:
        self.assertEqual(scoring.TD_CUT_FRACTION, 0.25)

    def test_raw_keeps_positive(self) -> None:
        self.assertEqual(
            scoring.transform({"a": 0.5, "b": 0.0, "c": -0.1}, "raw"), {"a": 0.5}
        )

    def test_top_quarter(self) -> None:
        scores = {"a": 1.0, "b": 2.0, "c": 3.0, "d": 4.0, "e": 5.0}
        # np.quantile([1..5], 0.75) == 4.0
        self.assertEqual(scoring.transform(scores, "top_quarter"), {"e": 1.0})

    def test_rank_top_quarter_linear_with_name_ties(self) -> None:
        scores = {f"t{i}": i / 10 for i in range(10)}
        scores["a"] = 0.9
        result = scoring.transform(scores, "rank")
        # 11 files -> K = ceil(2.75) = 3; "a" ties "t9" and wins by name.
        self.assertEqual(result, {"a": 1.0, "t9": 1 - 1 / 3, "t8": 1 - 2 / 3})

    def test_rank_single_file(self) -> None:
        self.assertEqual(scoring.transform({"x": -0.5}, "rank"), {"x": 1.0})

    def test_non_finite_scores_are_ignored(self) -> None:
        scores = {"a": float("nan"), "b": float("inf"), "c": 0.2, "d": 0.1}
        self.assertEqual(scoring.transform(scores, "rank"), {"c": 1.0})
        self.assertEqual(scoring.transform(scores, "raw"), {"c": 0.2, "d": 0.1})

    def test_empty(self) -> None:
        for kind in scoring.TRANSFORMS:
            self.assertEqual(scoring.transform({}, kind), {})

    def test_unknown(self) -> None:
        with self.assertRaises(ValueError):
            scoring.transform({"a": 1.0}, "softmax")


class TestToMapping(TestCase):
    def test_keeps_finite_positive_only(self) -> None:
        mapping = scoring.to_mapping(
            {
                "z/test_b": 0.25,
                "test_a": 0.123456789123,
                "zero": 0.0,
                "neg": -1.0,
                "nan": float("nan"),
                "inf": float("inf"),
                "ninf": float("-inf"),
            }
        )
        self.assertEqual(list(mapping), ["test_a.py", "z/test_b.py"])
        self.assertEqual(mapping["test_a.py"], 0.123456789123)

    def test_python_floats(self) -> None:
        mapping = scoring.to_mapping({"t": np.float32(0.5)})
        self.assertIs(type(mapping["t.py"]), float)

    def test_empty(self) -> None:
        self.assertEqual(scoring.to_mapping({}), {})


if __name__ == "__main__":
    main()
