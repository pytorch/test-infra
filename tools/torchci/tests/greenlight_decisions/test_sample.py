"""Tests for the sample the decision export keeps.

The export ranks pull requests by the key the replay harness samples by, so the
cross-module cases write the export's rows through the real ``write_csv``, read
them back with the harness's own reader, and hold its draw against the export's.
Nothing here touches ClickHouse or GitHub.
"""

import hashlib
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from decision_fixtures import DECIDED, MEASURED, UNDECIDED
from torchci.greenlight_decisions.rows import build_row, write_csv
from torchci.greenlight_decisions.sample import (
    lowest_ranked,
    sample_decisions,
    sample_key,
    sample_size,
)
from torchci.greenlight_replay import frame


FIRST_LANDING = datetime(2026, 8, 26, 22, 21, 4)

EXACT = {**MEASURED, "verdict_staleness": "exact"}

REPLAY_SAMPLE_SIZE = 30


def corpus(count, **overrides):
    """Decided pull requests, newest first as fetch_decisions orders them."""
    return [
        {**DECIDED, "pr_number": 190000 + n, **overrides}
        for n in reversed(range(count))
    ]


def numbers(records):
    return [str(record["pr_number"]) for record in records]


def by_value(item):
    return bytes([item])


class TestSampleSize(unittest.TestCase):
    """k = min(cap, ceil(frac * n)), with either bound optional."""

    def test_frac_alone_rounds_up(self):
        self.assertEqual(sample_size(10, 0.25, None), 3)
        self.assertEqual(sample_size(10, 0.05, None), 1)
        self.assertEqual(sample_size(1995, 0.2, None), 399)

    def test_frac_of_one_keeps_everything(self):
        self.assertEqual(sample_size(9, 1.0, None), 9)

    def test_cap_alone_never_exceeds_the_total(self):
        self.assertEqual(sample_size(10, None, 3), 3)
        self.assertEqual(sample_size(2, None, 3), 2)

    def test_both_keep_the_smaller(self):
        self.assertEqual(sample_size(10000, 0.2, 1000), 1000)
        self.assertEqual(sample_size(1995, 0.2, 1000), 399)

    def test_neither_keeps_everything(self):
        self.assertEqual(sample_size(7, None, None), 7)

    def test_a_tiny_export_keeps_at_least_one(self):
        self.assertEqual(sample_size(1, 0.2, None), 1)
        self.assertEqual(sample_size(1, 0.2, 1000), 1)
        self.assertEqual(sample_size(1, None, 1), 1)
        self.assertEqual(sample_size(0, 0.2, 5), 0)


class TestSampleKey(unittest.TestCase):
    def test_the_key_is_the_sha256_of_the_nul_joined_cells(self):
        # Changing the key reassigns every sample, so a resumed replay would find its
        # completed pull requests no longer selected.
        self.assertEqual(
            sample_key(7, "pytorch/pytorch", "194379"),
            hashlib.sha256(b"7\x00pytorch/pytorch\x00194379").digest(),
        )


class TestLowestRanked(unittest.TestCase):
    def test_the_lowest_ranks_are_kept_in_input_order(self):
        self.assertEqual(lowest_ranked([3, 1, 2, 0], 2, by_value), [1, 0])

    def test_a_size_beyond_the_items_keeps_them_all(self):
        self.assertEqual(lowest_ranked([3, 1], 5, by_value), [3, 1])

    def test_a_size_of_zero_keeps_nothing(self):
        self.assertEqual(lowest_ranked([3, 1], 0, by_value), [])


class TestSampleDecisions(unittest.TestCase):
    def test_the_same_seed_gives_the_same_sample(self):
        decisions = corpus(50)
        self.assertEqual(
            numbers(sample_decisions(decisions, frac=0.2, cap=None, seed=4)),
            numbers(sample_decisions(decisions, frac=0.2, cap=None, seed=4)),
        )

    def test_a_different_seed_gives_a_different_sample(self):
        decisions = corpus(50)
        self.assertNotEqual(
            numbers(sample_decisions(decisions, frac=0.2, cap=None, seed=4)),
            numbers(sample_decisions(decisions, frac=0.2, cap=None, seed=5)),
        )

    def test_the_sample_keeps_input_order_and_identity(self):
        decisions = corpus(50)
        drawn = sample_decisions(decisions, frac=None, cap=10, seed=4)
        kept = {id(d) for d in drawn}
        self.assertEqual(len(kept), 10)
        self.assertEqual(
            [id(d) for d in drawn], [id(d) for d in decisions if id(d) in kept]
        )

    def test_the_sizes_follow_sample_size(self):
        decisions = corpus(50)
        for frac, cap, size in ((0.25, None, 13), (None, 7, 7), (0.25, 7, 7)):
            with self.subTest(frac=frac, cap=cap):
                drawn = sample_decisions(decisions, frac=frac, cap=cap, seed=4)
                self.assertEqual(len(drawn), size)

    def test_a_larger_cap_adds_to_a_smaller_one(self):
        decisions = corpus(50)
        five = set(numbers(sample_decisions(decisions, frac=None, cap=5, seed=4)))
        ten = set(numbers(sample_decisions(decisions, frac=None, cap=10, seed=4)))
        self.assertTrue(five < ten)

    def test_the_rank_depends_on_the_pull_request_alone(self):
        # The verdict columns differ between the two corpora; only repo and pr_number
        # may move a pull request's rank.
        decided = corpus(50)
        undecided = [{**UNDECIDED, "pr_number": d["pr_number"]} for d in decided]
        self.assertEqual(
            numbers(sample_decisions(decided, frac=None, cap=10, seed=4)),
            numbers(sample_decisions(undecided, frac=None, cap=10, seed=4)),
        )


class TestReplayDrawsTheSameRows(unittest.TestCase):
    """The export ranks the cells it is about to write; the replay ranks the cells it reads
    back. Both sides go through the real file here, so a change to how either renders or
    reads ``repo`` or ``pr_number`` breaks these cases rather than the sample."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def exported(self, decisions, name):
        path = self.directory / name
        write_csv(str(path), [build_row(d, EXACT, "s") for d in decisions])
        return frame.load_rows(str(path))

    def frame_and_draw(self, decisions, name, seed):
        landings = {
            d["pr_number"]: [frame.Landing(frame.LAND, "e" * 40, FIRST_LANDING)]
            for d in decisions
            if d["landed"]
        }
        framed, _ = frame.apply_frame(self.exported(decisions, name), landings)
        return framed, frame.sample_rows(framed, n=REPLAY_SAMPLE_SIZE, seed=seed)

    def test_the_export_ranks_pull_requests_exactly_as_the_replay_does(self):
        # Equal draws at every size means equal rankings.
        for repo in ("pytorch/pytorch", "pytorch/executorch"):
            decisions = corpus(40, repo=repo)
            rows = self.exported(decisions, "full.csv")
            sizes = range(1, len(decisions) + 1)
            for seed in (0, 1, 12345):
                with self.subTest(repo=repo, seed=seed):
                    self.assertEqual(
                        [
                            numbers(
                                sample_decisions(decisions, frac=None, cap=k, seed=seed)
                            )
                            for k in sizes
                        ],
                        [
                            numbers(frame.sample_rows(rows, n=k, seed=seed))
                            for k in sizes
                        ],
                    )

    def test_a_sampled_export_gives_the_replay_the_full_exports_draw(self):
        decisions = corpus(300)
        decisions = [{**d, "landed": d["pr_number"] % 3 == 0} for d in decisions]
        for seed in (0, 7):
            with self.subTest(seed=seed):
                _, expected = self.frame_and_draw(decisions, "full.csv", seed)
                sampled = sample_decisions(decisions, frac=0.5, cap=None, seed=seed)
                framed, drawn = self.frame_and_draw(sampled, "sampled.csv", seed)
                self.assertGreaterEqual(len(framed), REPLAY_SAMPLE_SIZE)
                self.assertEqual(numbers(drawn), numbers(expected))

    def test_too_small_a_sample_gives_the_replay_a_subset_of_that_draw(self):
        decisions = corpus(300)
        decisions = [{**d, "landed": d["pr_number"] % 3 == 0} for d in decisions]
        _, expected = self.frame_and_draw(decisions, "full.csv", seed=0)
        sampled = sample_decisions(decisions, frac=None, cap=20, seed=0)
        with self.assertLogs(frame.logger, level="WARNING"):
            framed, drawn = self.frame_and_draw(sampled, "sampled.csv", seed=0)
        self.assertTrue(0 < len(framed) < REPLAY_SAMPLE_SIZE)
        self.assertTrue(set(numbers(drawn)) < set(numbers(expected)))


if __name__ == "__main__":
    unittest.main()
