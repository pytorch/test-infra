import math
from unittest import main, TestCase

from torchci.td.llm.metrics import (
    best_rank_pct,
    caught,
    macro,
    mcnemar_exact,
    paired_bootstrap,
    per_pr_rank,
    per_pr_recall,
    rank_pct,
    rank_pcts,
)


CANDIDATES = ["a", "b", "c", "d"]


class TestRankPct(TestCase):
    def test_strictly_higher_share(self) -> None:
        scores = {"a": 0.9, "b": 0.5, "c": 0.3, "d": 0.1}
        self.assertEqual(rank_pct(scores, "a", CANDIDATES), 0.0)
        self.assertEqual(rank_pct(scores, "c", CANDIDATES), 0.5)
        self.assertEqual(rank_pct(scores, "d", CANDIDATES), 0.75)

    def test_ties_count_half(self) -> None:
        scores = {"a": 0.9, "b": 0.5, "c": 0.5, "d": 0.5}
        self.assertEqual(rank_pct(scores, "b", CANDIDATES), (1 + 0.5 * 2) / 4)

    def test_unscored_candidates_rank_below_scored_target(self) -> None:
        self.assertEqual(rank_pct({"c": 0.1}, "c", CANDIDATES), 0.0)

    def test_target_without_score_ranks_last(self) -> None:
        scores = {"a": 0.9, "b": 0.5}
        self.assertEqual(rank_pct(scores, "c", CANDIDATES), 0.75)
        self.assertEqual(rank_pct({**scores, "c": math.nan}, "c", CANDIDATES), 0.75)

    def test_target_outside_candidates_ranks_last(self) -> None:
        self.assertEqual(rank_pct({"z": 5.0, "a": 1.0}, "z", CANDIDATES), 1.0)

    def test_scores_outside_candidates_are_ignored(self) -> None:
        scores = {"z": 5.0, "a": 1.0, "b": 0.5}
        self.assertEqual(rank_pct(scores, "a", CANDIDATES), 0.0)

    def test_many_targets_and_best(self) -> None:
        scores = {"a": 0.9, "b": 0.5, "c": 0.3, "d": 0.1}
        self.assertEqual(rank_pcts(scores, ["d", "b"], CANDIDATES), [0.75, 0.25])
        self.assertEqual(best_rank_pct(scores, ["d", "b"], CANDIDATES), 0.25)
        self.assertIsNone(best_rank_pct(scores, [], CANDIDATES))

    def test_no_candidates_raises(self) -> None:
        with self.assertRaises(ValueError):
            rank_pct({"a": 1.0}, "a", [])


class TestRecall(TestCase):
    def test_caught_cut_is_strict(self) -> None:
        self.assertEqual(
            [caught(p) for p in (0.0, 0.2, 0.25, 0.9)], [True, True, False, False]
        )

    def test_per_pr_macro(self) -> None:
        pcts = {(1, "x"): 0.1, (1, "y"): 0.5, (2, "z"): 0.0}
        self.assertEqual(per_pr_recall(pcts), {1: 0.5, 2: 1.0})
        self.assertEqual(per_pr_rank(pcts), {1: 0.3, 2: 0.0})
        self.assertEqual(macro(per_pr_recall(pcts)), 0.75)
        self.assertTrue(math.isnan(macro({})))


class TestPairedBootstrap(TestCase):
    def test_deterministic_for_a_seed(self) -> None:
        a = {i: (i % 3) / 2 for i in range(50)}
        b = {i: (i % 5) / 4 for i in range(40)}
        first = paired_bootstrap(a, b, iters=2000, seed=3)
        second = paired_bootstrap(a, b, iters=2000, seed=3)
        self.assertEqual(first, second)
        self.assertEqual(first.n, 40)
        self.assertLessEqual(first.lo, first.diff)
        self.assertLessEqual(first.diff, first.hi)
        self.assertAlmostEqual(first.width, first.hi - first.lo)

    def test_constant_difference_has_zero_width(self) -> None:
        a = {i: 1.0 for i in range(10)}
        b = {i: 0.25 for i in range(10)}
        result = paired_bootstrap(a, b, iters=500)
        self.assertEqual((result.diff, result.lo, result.hi), (0.75, 0.75, 0.75))

    def test_no_shared_keys(self) -> None:
        result = paired_bootstrap({1: 1.0}, {2: 1.0})
        self.assertEqual(result.n, 0)
        self.assertTrue(math.isnan(result.lo))


class TestMcNemar(TestCase):
    def test_known_values(self) -> None:
        self.assertEqual(mcnemar_exact(0, 0), 1.0)
        self.assertEqual(mcnemar_exact(0, 5), 0.0625)
        self.assertEqual(mcnemar_exact(5, 0), 0.0625)
        self.assertEqual(mcnemar_exact(1, 9), 0.021484375)
        self.assertEqual(mcnemar_exact(3, 3), 1.0)
        self.assertAlmostEqual(mcnemar_exact(2, 10), 0.0385742188, places=9)


if __name__ == "__main__":
    main()
