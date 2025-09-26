import unittest

from pytorch_auto_revert.bisection_planner import Gap, GapBisectionPlanner


class TestGapBisectionPlanner(unittest.TestCase):
    def test_gap_heap_key(self):
        g = Gap(3, 7)
        self.assertEqual(g.length, 5)
        self.assertEqual(g.heap_key, (-5, 3, 7))

        g2 = Gap(0, 4)
        # Same length as g → compare by lo
        self.assertEqual(g2.length, 5)
        self.assertTrue(g2.heap_key < g.heap_key)

    def test_unlimited_covers_all_uncovered(self):
        covered = [False, False, True, False]
        res = GapBisectionPlanner.plan(covered, None)
        self.assertEqual(res, [True, True, False, True])

    def test_limit_one_even_length_mid(self):
        # indices 0..3 uncovered → pick mid=floor(1.5)=1
        covered = [False, False, False, False]
        res = GapBisectionPlanner.plan(covered, 1)
        self.assertEqual(res, [False, True, False, False])

    def test_limit_two_even_length_two_mids(self):
        covered = [False, False, False, False]
        res = GapBisectionPlanner.plan(covered, 2)
        # Expect pick 1, then split [0] and [2,3] → pick 2
        self.assertEqual(res, [False, True, True, False])

    def test_split_by_existing_pending_zero_budget(self):
        # One already covered, limit=1 → allowed=0
        covered = [False, True, False, False]
        res = GapBisectionPlanner.plan(covered, 1)
        self.assertEqual(res, [False, False, False, False])

    def test_odd_length_mid_floor(self):
        covered = [False, False, False]
        res = GapBisectionPlanner.plan(covered, 1)
        self.assertEqual(res, [False, True, False])

    def test_two_equal_gaps_picks_one(self):
        # Two gaps [0,1] and [3,4], one already covered in the middle
        covered = [False, False, True, False, False]
        res = GapBisectionPlanner.plan(covered, 2)  # allowed = 1 (current=1)
        self.assertEqual(sum(res), 1)
        self.assertTrue(res[0] or res[3])

    # ---------- Additional extensive cases ----------
    def test_single_uncovered(self):
        covered = [True, True, False, True]
        # current=3
        self.assertEqual(
            GapBisectionPlanner.plan(covered, 5), [False, False, True, False]
        )
        # limit=1 → allowed=0
        self.assertEqual(
            GapBisectionPlanner.plan(covered, 1), [False, False, False, False]
        )

    def test_limit_more_than_uncovered(self):
        covered = [True, False, False, True, False]
        # current=2, limit=10 → allowed=8, but only 3 uncovered exist
        self.assertEqual(
            GapBisectionPlanner.plan(covered, 10), [False, True, True, False, True]
        )

    def test_no_uncovered(self):
        covered = [True, True, True]
        self.assertEqual(GapBisectionPlanner.plan(covered, None), [False, False, False])
        self.assertEqual(GapBisectionPlanner.plan(covered, 0), [False, False, False])
        self.assertEqual(GapBisectionPlanner.plan(covered, 3), [False, False, False])

    def test_limit_lower_than_current(self):
        # current=4, limit=2 → allowed=0
        covered = [True, False, True, False, True, True]
        self.assertEqual(
            GapBisectionPlanner.plan(covered, 2),
            [False, False, False, False, False, False],
        )

    def test_boundaries_start_end_gaps(self):
        # gaps at both edges; largest is left [0,3] (len=4) versus right [7,8] (len=2)
        covered = [False, False, False, False, True, True, True, False, False]
        res = GapBisectionPlanner.plan(
            covered, 1
        )  # current=3, allowed= -? → max(0,1-3)=0
        # Note: limit is total allowed; with 3 covered already and limit=1, allowed=0 → nothing
        self.assertEqual(res, [False] * len(covered))
        # With bigger limit we actually pick from the left big gap
        res2 = GapBisectionPlanner.plan(covered, 10)  # unlimited effectively
        # Unlimited picks all False positions
        self.assertEqual(res2, [bool(c) for c in covered])

    def test_choose_leftmost_on_equal_gap_lengths(self):
        # Two equal gaps [0,1] and [3,4]
        covered = [False, False, True, False, False]
        res = GapBisectionPlanner.plan(covered, 2)  # current=1 → allowed=1
        # Only one pick; since gaps equal, ties by lower lo → pick from left gap mid=0
        self.assertEqual(sum(res), 1)
        self.assertTrue(res[0] or res[1])

    def test_large_scenario_mixed(self):
        # Mixed covered/uncovered across 20 positions
        covered = [
            False,
            False,
            True,
            False,
            False,
            False,
            True,
            True,
            False,
            True,
            False,
            False,
            False,
            True,
            False,
            True,
            False,
            False,
            True,
            False,
        ]
        # current = number of True =
        current = sum(1 for c in covered if c)
        self.assertEqual(current, 7)
        # limit=9 → allowed=2; we expect two picks
        res = GapBisectionPlanner.plan(covered, 9)
        self.assertEqual(sum(res), 2)
        # Ensure no picks on already covered
        for i, r in enumerate(res):
            if covered[i]:
                self.assertFalse(r)

    def test_unlimited_matches_negation(self):
        # Unlimited mode must equal logical NOT of covered
        covered = [False, True, False, True, False]
        res = GapBisectionPlanner.plan(covered, None)
        self.assertEqual(res, [True, False, True, False, True])


if __name__ == "__main__":
    unittest.main()
