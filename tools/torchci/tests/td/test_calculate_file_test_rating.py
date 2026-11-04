from unittest import main, TestCase

from torchci.td.historical_class_failure_correlation import extract_test_class_name
from torchci.td.historical_file_failure_correlation import filter_tests
from torchci.td.td_heuristic_historical_edited_files import positive_pmi
from torchci.td.utils import (
    calculate_generic_test_ratings,
    decay_weight,
    positive_rounded,
)


DAY = 24 * 60 * 60


class TestCalculateFileTestRating(TestCase):
    def gen_test(
        self,
        invoking_file="invoking_file",
        name="test_name",
        classname="classname",
        file="file",
        head_sha="head_sha",
        ts=None,
    ):
        test = {
            "invoking_file": invoking_file,
            "name": name,
            "classname": classname,
            "file": file,
            "head_sha": head_sha,
            "failure": invoking_file,
        }
        if ts is not None:
            test["ts"] = ts
        return test

    def gen_merge_base(self, sha, changed_files, merge_base):
        return (
            sha,
            {
                "changed_files": changed_files,
                "sha": sha,
                "merge_base": merge_base,
            },
        )

    def test_calculate_test_file_ratings(self):
        # Extrememly simple sanity checks
        tests = [
            self.gen_test(head_sha="head_sha_1"),
            self.gen_test(head_sha="head_sha_2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha_1", ["a.txt", "b.txt"], "merge_base_1"),
                self.gen_merge_base("head_sha_2", ["a.txt"], "merge_base_2"),
            ]
        )
        expected = {"a.txt": {"invoking_file": 1.5}, "b.txt": {"invoking_file": 0.5}}
        scores = calculate_generic_test_ratings(
            tests, merge_bases, lambda x: x["failure"]
        )
        self.assertDictEqual(scores, expected)

        tests = [
            self.gen_test(invoking_file="invoking_file_1"),
            self.gen_test(invoking_file="invoking_file_2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha", ["a.txt", "b.txt"], "merge_base_1"),
            ]
        )
        expected = {
            "a.txt": {"invoking_file_1": 0.5, "invoking_file_2": 0.5},
            "b.txt": {"invoking_file_1": 0.5, "invoking_file_2": 0.5},
        }
        scores = calculate_generic_test_ratings(
            tests, merge_bases, lambda x: x["failure"]
        )
        self.assertDictEqual(scores, expected)

    def test_calculate_test_class_ratings(self):
        self.maxDiff = None
        # Extrememly simple sanity checks
        tests = [
            self.gen_test(head_sha="head_sha_1"),
            self.gen_test(head_sha="head_sha_2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha_1", ["a.txt", "b.txt"], "merge_base_1"),
                self.gen_merge_base("head_sha_2", ["a.txt"], "merge_base_2"),
            ]
        )
        expected = {
            "a.txt": {"invoking_file::classname": 1.5},
            "b.txt": {"invoking_file::classname": 0.5},
        }
        scores = calculate_generic_test_ratings(
            tests, merge_bases, get_test_name_fn=extract_test_class_name
        )
        self.assertDictEqual(scores, expected)

        tests = [
            self.gen_test(invoking_file="invoking_file_1", classname="classname1"),
            self.gen_test(invoking_file="invoking_file_2", classname="classname2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha", ["a.txt", "b.txt"], "merge_base_1"),
            ]
        )
        expected = {
            "a.txt": {
                "invoking_file_1::classname1": 0.5,
                "invoking_file_2::classname2": 0.5,
            },
            "b.txt": {
                "invoking_file_1::classname1": 0.5,
                "invoking_file_2::classname2": 0.5,
            },
        }
        scores = calculate_generic_test_ratings(
            tests, merge_bases, get_test_name_fn=extract_test_class_name
        )
        self.assertDictEqual(scores, expected)

    def test_filter_tests(self):
        tests = [
            self.gen_test(head_sha="head_sha"),
            self.gen_test(head_sha="merge_base"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha", [], "merge_base"),
                self.gen_merge_base("merge_base", [], "merge_base_2"),
            ]
        )
        filtered = filter_tests(tests, merge_bases)
        self.assertTrue(len(filtered), 1)
        self.assertDictEqual(filtered[0], tests[1])

    def test_decay_weight(self):
        now = 100 * DAY
        self.assertEqual(decay_weight(now, now, 14), 1.0)
        self.assertAlmostEqual(decay_weight(now - 14 * DAY, now, 14), 0.5)
        self.assertAlmostEqual(decay_weight(now - 28 * DAY, now, 14), 0.25)
        self.assertEqual(decay_weight(now + DAY, now, 14), 1.0)
        self.assertEqual(decay_weight(0, now, None), 1.0)

    def test_calculate_test_file_ratings_with_decay(self):
        now = 100 * DAY
        tests = [
            self.gen_test(head_sha="head_sha_1", ts=now),
            self.gen_test(head_sha="head_sha_2", ts=now - 14 * DAY),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha_1", ["a.txt", "b.txt"], "merge_base_1"),
                self.gen_merge_base("head_sha_2", ["a.txt"], "merge_base_2"),
            ]
        )
        scores = calculate_generic_test_ratings(
            tests, merge_bases, lambda x: x["failure"], half_life_days=14, now=now
        )
        self.assertAlmostEqual(scores["a.txt"]["invoking_file"], 0.5 + 0.5)
        self.assertAlmostEqual(scores["b.txt"]["invoking_file"], 0.5)

    def test_decay_uses_earliest_failure_of_a_sha(self):
        # A re-run of an old sha fails again later; the sha's age stays that
        # of its first failure.
        now = 100 * DAY
        tests = [
            self.gen_test(head_sha="head_sha", ts=now),
            self.gen_test(head_sha="head_sha", ts=now - 14 * DAY),
        ]
        merge_bases = dict([self.gen_merge_base("head_sha", ["a.txt"], "mb")])
        scores = calculate_generic_test_ratings(
            tests, merge_bases, lambda x: x["failure"], half_life_days=14, now=now
        )
        self.assertDictEqual(scores, {"a.txt": {"invoking_file": 0.5}})

    def test_decay_requires_failure_time(self):
        tests = [self.gen_test(head_sha="head_sha")]
        merge_bases = dict([self.gen_merge_base("head_sha", ["a.txt"], "mb")])
        with self.assertRaises(KeyError):
            calculate_generic_test_ratings(
                tests, merge_bases, lambda x: x["failure"], half_life_days=14
            )

    def test_positive_rounded(self):
        ratings = {
            "a.txt": {"t1": 0.12345678912, "t2": 0.0000012345678, "t3": 0.0},
            "b.txt": {"t1": 0.0000000004},
        }
        self.assertDictEqual(
            positive_rounded(ratings),
            {"a.txt": {"t1": 0.123456789, "t2": 0.000001235}},
        )

    def test_positive_pmi(self):
        # hub.h is edited in every commit, so it is linked to no test more
        # than chance; a.cpp is always edited with test_a.
        commits = [(["hub.h", "a.cpp"], ["test_a"]) for _ in range(10)]
        commits += [(["hub.h", f"b{i}.cpp"], ["test_b"]) for i in range(30)]
        commits += [(["hub.h", "c.cpp"], ["test_c"])]
        commits += [(["hub.h", "docs.md"], [])]
        scores = positive_pmi(commits)
        self.assertNotIn("hub.h", scores)
        self.assertNotIn("docs.md", scores)
        self.assertGreater(scores["a.cpp"]["test_a"], 0)
        self.assertEqual(set(scores["a.cpp"]), {"test_a"})
        # c.cpp and test_c met once: shrinkage keeps that coincidence below
        # the ten-times-repeated a.cpp link.
        self.assertLess(scores["c.cpp"]["test_c"], scores["a.cpp"]["test_a"])

    def test_positive_pmi_empty(self):
        self.assertDictEqual(positive_pmi([]), {})
        self.assertDictEqual(positive_pmi([(["a.cpp"], [])]), {})


if __name__ == "__main__":
    main()
