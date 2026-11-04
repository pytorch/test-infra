import math
from unittest import main, TestCase

from torchci.td.llm.events import RankRow
from torchci.td.llm.replay import (
    cut_position,
    EventReplay,
    FileTimes,
    llm_part,
    position_of,
    ranked,
    replay_event,
    replay_row,
    RowReplay,
    summarize,
)


TIMES = FileTimes(
    {
        "env": {"default": {"t0": 10.0, "t1": 20.0, "t2": 30.0, "t3": 40.0}},
        "other": {"default": {"t4": 100.0}, "slow": {"t4": 300.0, "t5": 7.0}},
    }
)


def row(all_scores, test_file, position, max_score=1.0, job_id=1) -> RankRow:
    return RankRow(
        run_id=10,
        job_id=job_id,
        workflow="pull",
        build_environment="env",
        test_config="default",
        test_file=test_file,
        position=position,
        max_score=max_score,
        all_scores=all_scores,
    )


def eight_tests() -> dict[str, float]:
    return {f"t{i}": float(8 - i) for i in range(8)}


class TestLlmPart(TestCase):
    def test_scaled_to_max_and_restricted_to_tests(self) -> None:
        mapping = {"a.py": 2.0, "b.py": 1.0, "dir/c.py": 4.0, "notes.txt": 9.0}
        self.assertEqual(llm_part(mapping, {"a", "b"}), {"a": 0.25, "b": 0.125})

    def test_non_positive_score_drops_the_heuristic(self) -> None:
        self.assertEqual(llm_part({"a.py": 1.0, "b.py": 0.0}, {"a", "b"}), {})
        self.assertEqual(llm_part({}, {"a"}), {})


class TestRanking(TestCase):
    def test_ties_broken_by_key(self) -> None:
        self.assertEqual(ranked({"b": 1.0, "a": 1.0, "c": 2.0}, {}), ["c", "a", "b"])

    def test_class_keys_take_their_file_part(self) -> None:
        scores = {"t0": 1.0, "t1, TestA": 0.5, "t1::TestB": 0.5}
        order = ranked(scores, {"t1": 0.75})
        self.assertEqual(order, ["t1, TestA", "t1::TestB", "t0"])

    def test_first_overlapping_key(self) -> None:
        order = ["t0", "t2, TestA", "t2, not (TestA)"]
        self.assertEqual(position_of(order, "t2"), 1)
        self.assertIsNone(position_of(order, "t9"))

    def test_cut_position(self) -> None:
        self.assertEqual(cut_position(8), 2)
        self.assertEqual(cut_position(3), 0)
        self.assertEqual(cut_position(400), 100)


class TestReplayRow(TestCase):
    def test_empty_part_reproduces_logged_position(self) -> None:
        scores = eight_tests()
        self.assertEqual(position_of(ranked(scores, {}), "t5"), 5)

    def test_cut_boundary_is_inclusive(self) -> None:
        scores = eight_tests()
        # n = 8 keeps positions 0..2 (25 * 8 // 100 = 2).
        r = replay_row(row(scores, "t3", 3), {"t3": 1.5}, TIMES)
        assert r is not None
        self.assertFalse(r.logged_caught)
        self.assertTrue(r.replayed_caught)
        r = replay_row(row(scores, "t4", 4), {"t4": 0.9}, TIMES)
        assert r is not None
        self.assertFalse(r.replayed_caught)

    def test_tie_after_part_broken_by_key(self) -> None:
        # n = 3 keeps position 0 only; the part makes the failing file tie the leader.
        r = replay_row(
            row({"t0": 2.0, "t1": 1.0, "t2": 0.5}, "t1", 1), {"t1": 1.0}, TIMES
        )
        assert r is not None
        self.assertFalse(r.replayed_caught)
        r = replay_row(row({"b": 2.0, "a": 1.0, "c": 0.5}, "a", 1), {"a": 1.0}, TIMES)
        assert r is not None
        self.assertTrue(r.replayed_caught)
        r = replay_row(row(eight_tests(), "t3", 3), {"t3": 1.0}, TIMES)
        assert r is not None
        self.assertFalse(r.replayed_caught)

    def test_dropped_when_td_did_not_rank(self) -> None:
        self.assertIsNone(
            replay_row(row({"t0": 0.0}, "t0", 0, max_score=0.0), {}, TIMES)
        )

    def test_part_outside_tests_does_nothing(self) -> None:
        mapping = {"t7.py": 1.0, "blocklisted.py": 2.0}
        part = llm_part(mapping, {"t7"})
        r = replay_row(row(eight_tests(), "t7", 7), part, TIMES)
        assert r is not None
        self.assertEqual(part, {"t7": 0.25})
        self.assertFalse(r.replayed_caught)


class TestTestTimes(TestCase):
    def test_own_key_then_median_fallback(self) -> None:
        self.assertEqual(TIMES.seconds("env", "default", "t1"), 20.0)
        self.assertEqual(TIMES.seconds("env", "default", "t4"), 200.0)
        self.assertEqual(TIMES.seconds("env", "default", "t5"), 7.0)
        self.assertEqual(TIMES.seconds("env", "default", "unknown"), 0.0)

    def test_cut_seconds_logged_and_replayed(self) -> None:
        scores = eight_tests()
        r = replay_row(row(scores, "t4", 4), {"t4": 3.0}, TIMES)
        assert r is not None
        self.assertEqual(r.logged_seconds, 10.0 + 20.0 + 30.0)
        self.assertEqual(r.replayed_seconds, 200.0 + 10.0 + 20.0)


class TestSummary(TestCase):
    def test_event_aggregation(self) -> None:
        scores = eight_tests()
        rows = [
            row(scores, "t5", 5, job_id=1),
            row(scores, "t1", 1, job_id=2),
            row({"t0": 0.0}, "t0", 0, max_score=0.0, job_id=3),
        ]
        event = replay_event("e", rows, {}, TIMES)
        self.assertEqual(event.dropped, 1)
        self.assertTrue(event.logged_caught)
        self.assertEqual(event.seconds(), (120.0, 120.0))

    def test_summary_counts(self) -> None:
        def ev(key, logged, replayed, old=10.0, new=10.0, dropped=0):
            rows = [RowReplay(1, logged, replayed, old, new)] if old else []
            return EventReplay(key, rows, dropped)

        summary = summarize(
            [
                ev("a", True, True, 10.0, 11.0),
                ev("b", True, False, 10.0, 10.0),
                ev("c", False, True, 10.0, 9.0),
                ev("d", False, True, 10.0, 10.5),
                ev("e", False, False, 0.0, dropped=2),
            ]
        )
        self.assertEqual(summary.events, 4)
        self.assertEqual(summary.dropped_rows, 2)
        self.assertEqual((summary.logged_caught, summary.replayed_caught), (2, 3))
        self.assertEqual((summary.gained, summary.lost), (2, 1))
        self.assertEqual(summary.mcnemar_p, 1.0)
        self.assertEqual(summary.kept_rate, 0.5)
        self.assertAlmostEqual(summary.median_time_change, 0.025)
        self.assertTrue(math.isnan(summarize([]).kept_rate))


if __name__ == "__main__":
    main()
