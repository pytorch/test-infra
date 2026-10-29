"""Tests for the base-versus-PR replay comparison and the comment it writes.

Every run directory is built on disk with the harness's own CSV writer, so the
BOM and the spreadsheet guard are exercised exactly as the workflow will feed
them. A run is spelled as one letter per pull request: ``L`` a LAND, ``N`` a
NO_LAND, ``F`` a harness failure, ``-`` no row at all.

Nothing here touches the network; the CLI cases run ``main`` in process except
one, which runs the module the way the workflow does.
"""

import contextlib
import io
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

import torchci.greenlight_replay.__main__ as harness
from torchci.greenlight_replay import (
    compare,
    compare_render,
    compare_stats,
    compare_tables,
)
from torchci.greenlight_replay.compare_stats import FAILED, LAND, NO_LAND, Proportion
from torchci.greenlight_replay.emit import write_replay_csv
from torchci.greenlight_replay.verdict_cells import (
    DECISION_VALUES,
    HARNESS_REASON_PREFIX,
)


REPO = "pytorch/pytorch"
HEAD = "a" * 40
OTHER_HEAD = "b" * 40
BASE_SHA = "1234567890ab" + "c" * 28
HEAD_SHA = "fedcba098765" + "d" * 28
RUN_URL = "https://github.com/pytorch/test-infra/actions/runs/123"
CANARY = "CANARY-model-prose-7f3a"
SUBPROCESS_TIMEOUT_SECONDS = 60

LETTERS = {
    "L": ("LAND", "clean"),
    "N": ("NO_LAND", "needs_human_review"),
    "F": ("", "harness:timeout"),
}


def replay_row(pr, letter="L", **cells):
    decision, reason = LETTERS[letter]
    row = {
        "repo": REPO,
        "pr_number": str(pr),
        "decision_head_sha": HEAD,
        "decision": "LAND",
        "decision_message": CANARY,
        "decision_summary": CANARY,
        "new_decision": decision,
        "new_decision_reason": reason,
        "new_decision_summary": CANARY,
        "new_decision_message": CANARY,
    }
    row.update(cells)
    return row


def write_run(root, name, rows, exit_code="0"):
    """A run directory; ``None`` leaves the CSV or the exit-code file out."""
    directory = Path(root) / name
    directory.mkdir()
    if rows is not None:
        write_replay_csv(str(directory / compare.CSV_FILE), rows)
    if exit_code is not None:
        (directory / compare.EXIT_CODE_FILE).write_text(exit_code, encoding="utf-8")
    return str(directory)


def arm_dirs(root, arm, spec, runs=None):
    """One run directory per letter position of ``spec``'s PR -> letters map."""
    count = runs if runs is not None else len(next(iter(spec.values())))
    return [
        write_run(
            root,
            f"greenlight-replay-{arm}-{index + 1}",
            [
                replay_row(pr, letters[index])
                for pr, letters in spec.items()
                if letters[index] != "-"
            ],
        )
        for index in range(count)
    ]


def numbers(prs):
    return [pr.number for pr in prs]


def section(markdown, title):
    """The text from a heading or details summary up to the next one."""
    start = markdown.index(title)
    following = [
        markdown.find(marker, start + len(title))
        for marker in ("\n### ", "\n<details>")
    ]
    ends = [index for index in following if index != -1]
    return markdown[start : min(ends) if ends else len(markdown)]


class ReplayCase(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = scratch.name

    def load(self, paths):
        with self.assertNoLogs(compare.logger, "ERROR"):
            return [compare.load_run(path) for path in paths]

    def compare(self, base, change, runs=None):
        return compare.compare(
            self.load(arm_dirs(self.root, "base", base, runs)),
            self.load(arm_dirs(self.root, "change", change, runs)),
        )

    def render(self, comparison):
        return compare_render.render(
            comparison, base_sha=BASE_SHA, head_sha=HEAD_SHA, run_url=RUN_URL
        )


class TestFlips(ReplayCase):
    def test_true_flips_in_both_directions(self):
        comparison = self.compare({1: "LLL", 2: "NNN"}, {1: "NNN", 2: "LLL"})
        self.assertEqual(numbers(comparison.true_flips), [1, 2])
        self.assertEqual(comparison.non_true_flips, [])
        self.assertEqual(
            comparison.directions(comparison.true_flips),
            {("LAND", "NO_LAND"): 1, ("NO_LAND", "LAND"): 1},
        )
        flips = section(self.render(comparison), "### Flips")
        self.assertIn(
            "True flips: 2 of 2 (100.0%, 95% CI 34.2–100.0%); LAND → NO_LAND 1, "
            "NO_LAND → LAND 1",
            flips,
        )

    def test_a_split_arm_against_a_unanimous_one_is_a_non_true_flip(self):
        comparison = self.compare({1: "LLN"}, {1: "NNN"})
        self.assertEqual(comparison.true_flips, [])
        self.assertEqual(numbers(comparison.non_true_flips), [1])

    def test_opposite_two_to_one_majorities_are_a_non_true_flip(self):
        comparison = self.compare({1: "LLN"}, {1: "LNN"})
        self.assertEqual(numbers(comparison.non_true_flips), [1])
        self.assertEqual(
            comparison.directions(comparison.non_true_flips),
            {("LAND", "NO_LAND"): 1, ("NO_LAND", "LAND"): 0},
        )

    def test_unanimous_agreement_is_stable(self):
        comparison = self.compare({1: "LLL", 2: "NNN"}, {1: "LLL", 2: "NNN"})
        self.assertEqual(numbers(comparison.stable), [1, 2])
        self.assertEqual(comparison.true_flips + comparison.non_true_flips, [])
        flips = section(self.render(comparison), "### Flips")
        self.assertIn("True flips: 0 of 2 (0.0%, 95% CI 0.0–65.8%);", flips)
        self.assertIn("Non-true flips: 0 of 2 (0.0%, 95% CI 0.0–65.8%);", flips)

    def test_splits_with_one_majority_are_unstable_without_a_flip(self):
        comparison = self.compare({1: "LLN"}, {1: "LNL"})
        self.assertEqual(numbers(comparison.unstable_unflipped), [1])
        self.assertEqual(comparison.stable + comparison.non_true_flips, [])

    def test_newly_unstable_and_newly_stable(self):
        comparison = self.compare({1: "LLL", 2: "LLN"}, {1: "LLN", 2: "LLL"})
        self.assertEqual(numbers(comparison.newly_unstable), [1])
        self.assertEqual(numbers(comparison.newly_stable), [2])
        self.assertEqual(comparison.true_flips + comparison.non_true_flips, [])

    def test_a_tie_has_no_majority_and_cannot_flip(self):
        comparison = self.compare({1: "LN-"}, {1: "NNN"})
        [pr] = comparison.prs
        self.assertIsNone(pr.base.majority)
        self.assertTrue(pr.comparable)
        self.assertEqual(comparison.true_flips + comparison.non_true_flips, [])
        self.assertEqual(numbers(comparison.unstable_unflipped), [1])
        self.assertEqual(numbers(comparison.newly_stable), [1])
        # A tie has no majority, so it is left out of the majority LAND rate.
        self.assertEqual(comparison.base.majority_land, Proportion(0, 0))
        self.assertEqual(comparison.change.majority_land, Proportion(0, 1))


class TestExclusions(ReplayCase):
    def test_fewer_than_two_verdicts(self):
        comparison = self.compare(
            {1: "LFF", 2: "LLL", 3: "F--", 4: "LLL"},
            {1: "LLL", 2: "L--", 3: "-F-", 4: "LLL"},
        )
        self.assertEqual(
            {pr.number: pr.exclusion for pr in comparison.excluded},
            {
                1: "fewer than 2 verdicts under base",
                2: "fewer than 2 verdicts under this PR",
                3: "fewer than 2 verdicts under both",
            },
        )
        self.assertEqual(numbers(comparison.comparable), [4])
        self.assertEqual(comparison.base.total(FAILED), 3)
        self.assertEqual(comparison.base.missing, 2)
        self.assertEqual(comparison.change.missing, 4)
        self.assertEqual(comparison.base.insufficient, 2)

    def test_inconsistent_heads_leave_the_pr_statistics_but_not_the_run_counts(self):
        base = arm_dirs(self.root, "base", {1: "LLL", 2: "LLL"})
        change = [
            write_run(self.root, "change-1", [replay_row(1), replay_row(2)]),
            write_run(
                self.root,
                "change-2",
                [replay_row(1, decision_head_sha=OTHER_HEAD), replay_row(2)],
            ),
        ]
        comparison = compare.compare(self.load(base), self.load(change))
        self.assertEqual(
            {pr.number: pr.exclusion for pr in comparison.excluded},
            {1: "inconsistent input heads"},
        )
        self.assertEqual(comparison.base.unanimous(LAND), 1)
        self.assertEqual(comparison.base.total(LAND), 6)
        self.assertIn("inconsistent input heads", self.render(comparison))

    def test_a_blank_or_malformed_head_is_not_a_second_head(self):
        base = arm_dirs(self.root, "base", {1: "LL"})
        change = [
            write_run(self.root, "change-1", [replay_row(1, decision_head_sha="")]),
            write_run(
                self.root, "change-2", [replay_row(1, decision_head_sha="A" * 40)]
            ),
        ]
        [pr] = compare.compare(self.load(base), self.load(change)).prs
        self.assertTrue(pr.consistent)


class TestArithmetic(ReplayCase):
    BASE = dict(zip(range(101, 110), "LLL NNN LLN LLN LLL LLN LF- LLL NNN".split()))
    CHANGE = dict(zip(range(101, 110), "NNN LLL NNN LNN LLN LLL LLL LLL NNF".split()))

    def test_a_hand_computed_example(self):
        comparison = self.compare(self.BASE, self.CHANGE)
        base, change = comparison.base, comparison.change
        # Base: 8 PRs with 3 verdicts give 24 pairs; 103, 104 and 106 split 2-1,
        # 2 disagreeing pairs each; 107's single verdict makes no pair. This PR:
        # 109 has 2 verdicts, so 25 pairs from all 9 PRs; 104 and 105 split.
        self.assertEqual(base.disagreement, Proportion(6, 24, 8))
        self.assertEqual(change.disagreement, Proportion(4, 25, 9))
        self.assertEqual(base.land_rate, Proportion(16, 25, 9))
        self.assertEqual(change.land_rate, Proportion(15, 26, 9))
        self.assertEqual(
            [base.total(LAND), base.total(NO_LAND), base.total(FAILED), base.missing],
            [16, 9, 1, 1],
        )
        self.assertEqual(
            [change.total(LAND), change.total(NO_LAND), change.total(FAILED)],
            [15, 11, 1],
        )
        self.assertEqual(
            (base.unstable_rate, change.unstable_rate),
            (Proportion(3, 8), Proportion(2, 9)),
        )
        self.assertEqual(
            (base.majority_land, change.majority_land),
            (Proportion(6, 8), Proportion(4, 8)),
        )
        self.assertEqual(numbers(comparison.true_flips), [101, 102])
        self.assertEqual(numbers(comparison.non_true_flips), [103, 104])
        self.assertEqual(numbers(comparison.stable), [108, 109])
        self.assertEqual(numbers(comparison.unstable_unflipped), [105, 106])
        self.assertEqual(numbers(comparison.excluded), [107])

        # The intervals below were computed apart from compare_stats, with the
        # textbook count form of the Wilson interval at the n of each rate.
        markdown = self.render(comparison)
        summary = section(markdown, "### Summary")
        self.assertIn(
            "| 16 / 9 (LAND rate 64.0%, 95% CI 33.2–86.4% over 9 PRs) | 15 / 11 (LAND "
            "rate 57.7%, 95% CI 28.3–82.5% over 9 PRs) |",
            summary,
        )
        self.assertIn(
            "| 3 of 8 assessable (37.5%, 95% CI 13.7–69.4%) | 2 of 9 assessable (22.2%, "
            "95% CI 6.3–54.7%) |",
            summary,
        )
        self.assertIn(
            "| Flip rate (run to run) | 6 of 24 pairs of runs (25.0%, 95% CI 7.1–59.1% "
            "over 8 PRs) | 4 of 25 pairs of runs (16.0%, 95% CI 3.7–48.7% over 9 PRs) |",
            summary,
        )
        self.assertIn(
            "| 6 of 8 (75.0%, 95% CI 40.9–92.9%) | 4 of 8 (50.0%, 95% CI 21.5–78.5%) |",
            summary,
        )
        flips = section(markdown, "### Flips")
        self.assertIn("Comparable PRs", flips)
        self.assertIn("8, of which 2 stable and 2 unstable without a flip", flips)
        self.assertIn(
            "Flip rate, base → this PR: 4 of 8 (50.0%, 95% CI 21.5–78.5%)", flips
        )
        self.assertIn(
            "True flips: 2 of 8 (25.0%, 95% CI 7.1–59.1%); LAND → NO_LAND 1, "
            "NO_LAND → LAND 1",
            flips,
        )
        self.assertIn(
            "Non-true flips: 2 of 8 (25.0%, 95% CI 7.1–59.1%); LAND → NO_LAND 2, "
            "NO_LAND → LAND 0",
            flips,
        )
        self.assertIn(
            "Newly unstable (split under this PR, unanimous under base): 1", flips
        )
        self.assertIn(
            "Newly stable (split under base, unanimous under this PR): 2", flips
        )

    def test_flip_tables_show_outcomes_in_run_order_and_distinct_reasons(self):
        markdown = self.render(self.compare(self.BASE, self.CHANGE))
        true_flips = section(markdown, "### True flips")
        self.assertIn(
            "| [#101](https://redirect.github.com/pytorch/pytorch/pull/101) | LAND · LAND · LAND"
            " | NO_LAND · NO_LAND · NO_LAND | `clean` | `needs_human_review` |",
            true_flips,
        )
        unstable = section(markdown, "PRs unstable under this PR's policy (2)")
        self.assertIn(
            "| [#105](https://redirect.github.com/pytorch/pytorch/pull/105) | LAND · LAND · NO_LAND | LAND · LAND · LAND | `clean`, `needs_human_review` |",
            unstable,
        )
        excluded = section(markdown, "Excluded PRs (1)")
        self.assertIn(
            "| [#107](https://redirect.github.com/pytorch/pytorch/pull/107) | fewer than 2 verdicts under base |",
            excluded,
        )
        health = section(markdown, "Run health")
        self.assertIn(
            "| greenlight-replay-base-3 | Base | 0 complete | 8 | 3 | 5 | 0 | 1 |",
            health,
        )

    def test_the_reason_table_is_sorted_by_total_then_name_with_signed_change(self):
        comparison = self.compare({1: "LLL", 2: "NNN"}, {1: "NNN", 2: "NNN"})
        reasons = section(self.render(comparison), "### Reason codes")
        self.assertIn(
            "| `needs_human_review` | 3 | 6 | +3 |\n| `clean` | 3 | 0 | -3 |", reasons
        )

    def test_the_land_rate_is_na_without_verdicts(self):
        comparison = self.compare({1: "FFF"}, {1: "LLL"})
        summary = section(self.render(comparison), "### Summary")
        self.assertIn(
            "| 0 / 0 (LAND rate n/a) | 3 / 0 (LAND rate 100.0%, 95% CI 20.7–100.0% "
            "over 1 PR) |",
            summary,
        )
        self.assertIn("| 0 of 0 assessable (n/a) |", summary)


class TestIntervals(ReplayCase):
    # Computed apart from compare_stats, two ways that agree to 1e-9: the textbook
    # count form (k + z²/2) / (n + z²) ± z / (n + z²) · sqrt(k(n - k) / n + z²/4)
    # and bisection on the score test (k/n - p)² = z² p(1 - p) / n, z = 1.959964.
    # 1 of 30 is also R's binom::binom.confint(1, 30) "wilson": 0.00590859 to
    # 0.16670391.
    REFERENCES = {
        (0, 10): (0.0, 0.27753279986288915),
        (10, 10): (0.7224672001371107, 1.0),
        (5, 10): (0.23659309051256405, 0.763406909487436),
        (1, 30): (0.005908590381612441, 0.16670390991409167),
    }

    def test_wilson_matches_independent_references(self):
        for (k, n), (low, high) in self.REFERENCES.items():
            with self.subTest(k=k, n=n):
                got_low, got_high = compare_stats.wilson(k / n, n)
                self.assertAlmostEqual(got_low, low, places=12)
                self.assertAlmostEqual(got_high, high, places=12)

    def test_bounds_never_leave_zero_and_one(self):
        # Unclamped, rounding takes the lower bound at a rate of 0 below zero for
        # n = 61, which renders as "-0.0", and the upper bound at a rate of 1 above
        # one for n = 9.
        for n in range(1, 200):
            low, _ = compare_stats.wilson(0.0, n)
            _, high = compare_stats.wilson(1.0, n)
            self.assertGreaterEqual(low, 0.0, f"n = {n}")
            self.assertLessEqual(high, 1.0, f"n = {n}")

    def test_no_pull_request_means_no_interval(self):
        for share in (Proportion(0, 0), Proportion(0, 0, 0), Proportion(1, 2, 0)):
            with self.subTest(share=share):
                self.assertIsNone(share.interval)

    def test_a_pooled_rate_is_sized_by_its_prs(self):
        wilson = compare_stats.wilson
        self.assertEqual(Proportion(16, 25, 9).interval, wilson(16 / 25, 9))
        self.assertEqual(Proportion(3, 8).interval, wilson(3 / 8, 8))

    def test_the_land_rate_counts_every_pr_with_a_verdict(self):
        # PR 2 never reaches a verdict. PR 3's heads differ: that keeps it out of
        # the PR-level numbers, the run-to-run flip rate among them, but not out of
        # the run-level LAND rate.
        base = [
            write_run(
                self.root,
                f"base-{index}",
                [
                    replay_row(1, "L"),
                    replay_row(2, "F"),
                    replay_row(3, "N", decision_head_sha=head),
                ],
            )
            for index, head in ((1, HEAD), (2, OTHER_HEAD))
        ]
        change = arm_dirs(self.root, "change", {1: "LL", 2: "LL", 3: "LL"})
        comparison = compare.compare(self.load(base), self.load(change))
        self.assertEqual(comparison.base.land_rate, Proportion(2, 4, 2))
        self.assertEqual(comparison.base.disagreement, Proportion(0, 1, 1))
        self.assertIn(
            "| 2 / 2 (LAND rate 50.0%, 95% CI 9.5–90.5% over 2 PRs) |",
            section(self.render(comparison), "### Summary"),
        )

    def test_the_run_to_run_flip_rate_counts_the_prs_with_a_pair(self):
        comparison = self.compare(
            {1: "LLN", 2: "L--", 3: "NN-", 4: "FFF"},
            {1: "LLL", 2: "LLL", 3: "LLL", 4: "LLL"},
        )
        self.assertEqual(comparison.base.disagreement, Proportion(2, 4, 2))
        self.assertEqual(comparison.base.land_rate, Proportion(3, 6, 3))
        self.assertIn(
            "| Flip rate (run to run) | 2 of 4 pairs of runs (50.0%, 95% CI 9.5–90.5% "
            "over 2 PRs) |",
            section(self.render(comparison), "### Summary"),
        )


class TestUntrustedCells(ReplayCase):
    def run_with(self, base_cells, change_cells=None, letters="LL"):
        """PR 1 twice per arm: a LAND with ``base_cells`` under base, ``letters`` under
        this PR with ``change_cells``."""
        base = [
            write_run(self.root, f"base-{index}", [replay_row(1, **base_cells)])
            for index in (1, 2)
        ]
        change = [
            write_run(
                self.root,
                f"change-{index}",
                [replay_row(1, letter, **(change_cells or {}))],
            )
            for index, letter in enumerate(letters, 1)
        ]
        return compare.compare(self.load(base), self.load(change))

    def test_an_injected_reason_renders_as_invalid(self):
        comparison = self.run_with({"new_decision_reason": "x](http://evil) @someone"})
        markdown = self.render(comparison)
        self.assertIn("| `invalid` | 2 | 0 | -2 |", markdown)
        self.assertNotIn("evil", markdown)
        self.assertNotIn("@someone", markdown)

    def test_the_prose_columns_never_reach_the_comment(self):
        markdown = self.render(self.compare({1: "LLN", 2: "FNN"}, {1: "NNN", 2: "LLF"}))
        self.assertNotIn(CANARY, markdown)

    def test_a_malformed_repo_gets_no_link(self):
        bad = {"repo": "evil.com/x](javascript:alert(1))"}
        markdown = self.render(self.run_with(bad, bad, letters="NN"))
        self.assertNotIn("javascript", markdown)
        self.assertIn("| `#1` | LAND · LAND | NO_LAND · NO_LAND |", markdown)
        self.assertIn("Re-reviewed 1 historical PR 2 times", markdown)

    def test_pr_links_go_through_redirect_github_com(self):
        markdown = self.render(self.run_with({}, letters="NN"))
        self.assertIn(
            "| [#1](https://redirect.github.com/pytorch/pytorch/pull/1) |", markdown
        )
        self.assertNotIn("https://github.com/pytorch/pytorch", markdown)
        self.assertIn(f"[Workflow run]({RUN_URL})", markdown)

    def test_two_repos_for_one_pr_get_no_link(self):
        comparison = self.run_with({}, {"repo": "someone/else"}, letters="NN")
        self.assertEqual(comparison.prs[0].repo, "")
        self.assertIn("| `#1` |", self.render(comparison))

    def test_a_harness_reason_makes_a_failure_even_with_a_status(self):
        # A payload the policy's schema rejected keeps its status in new_decision.
        # Counted as verdicts, these two rows would make base a 2-1 NO_LAND split.
        rejected = {
            "new_decision": "NO_LAND",
            "new_decision_reason": "harness:schema_invalid",
        }
        base = [
            write_run(self.root, "base-1", [replay_row(1)]),
            write_run(self.root, "base-2", [replay_row(1, **rejected)]),
            write_run(self.root, "base-3", [replay_row(1, **rejected)]),
        ]
        change = arm_dirs(self.root, "change", {1: "LLL"})
        comparison = compare.compare(self.load(base), self.load(change))
        [pr] = comparison.prs
        self.assertEqual(
            [comparison.base.total(NO_LAND), comparison.base.total(FAILED)], [0, 2]
        )
        self.assertEqual(
            comparison.base.reasons(failed=True), {"harness:schema_invalid": 2}
        )
        self.assertEqual(comparison.base.reasons(failed=False), {"clean": 1})
        self.assertEqual((pr.base.verdicts, pr.base.majority), (1, LAND))
        self.assertEqual(pr.exclusion, "fewer than 2 verdicts under base")
        self.assertEqual(comparison.non_true_flips, [])
        markdown = self.render(comparison)
        self.assertIn(
            "| `harness:schema_invalid` | 2 | 0 |", section(markdown, "Run health")
        )
        self.assertNotIn("harness:", section(markdown, "### Reason codes"))

    def test_a_status_outside_the_vocabulary_is_a_failure(self):
        comparison = self.run_with(
            {"new_decision": "MAYBE", "new_decision_reason": "clean"}
        )
        self.assertEqual(
            [comparison.base.total(LAND), comparison.base.total(FAILED)], [0, 2]
        )

    def test_unreadable_pr_numbers_are_skipped_with_a_warning(self):
        rows = [
            replay_row(number) for number in ("12abc", "-5", "0", "", "007", "9" * 20)
        ]
        path = write_run(self.root, "base-1", [*rows, replay_row(3)])
        with self.assertLogs(compare.logger, "WARNING") as logs:
            run = compare.load_run(path)
        self.assertEqual(list(run.rows), [3])
        self.assertEqual(run.skipped, 6)
        self.assertEqual(
            sum("no readable pr_number" in line for line in logs.output), 6
        )

    def test_a_repeated_pr_keeps_its_first_row(self):
        path = write_run(self.root, "base-1", [replay_row(1, "L"), replay_row(1, "N")])
        with self.assertLogs(compare.logger, "WARNING") as logs:
            run = compare.load_run(path)
        self.assertEqual(run.rows[1].verdict, "LAND")
        self.assertEqual(run.skipped, 1)
        self.assertIn("repeats PR 1", logs.output[0])
        health = self.render(compare.compare([run], [run]))
        self.assertIn("| 1 (1 skipped) |", health)

    def test_the_bom_does_not_hide_the_first_column(self):
        # repo is the export's first column, the one a UTF-8 BOM would rename.
        [run] = self.load([write_run(self.root, "base-1", [replay_row(1)])])
        self.assertEqual(run.rows[1].repo, REPO)


class TestRunHealth(ReplayCase):
    def health(self, base_paths):
        change = arm_dirs(self.root, "change", {1: "LL"})
        comparison = compare.compare(
            [compare.load_run(path) for path in base_paths], self.load(change)
        )
        return comparison, section(self.render(comparison), "Run health")

    def test_missing_artifacts_and_exit_codes(self):
        rows = [replay_row(1)]
        paths = [
            str(Path(self.root) / "greenlight-replay-base-1"),
            write_run(self.root, "greenlight-replay-base-2", None, exit_code="1\n"),
            write_run(self.root, "greenlight-replay-base-3", rows, exit_code=None),
            write_run(self.root, "greenlight-replay-base-4", rows, exit_code="banana"),
            write_run(self.root, "greenlight-replay-base-5", rows, exit_code=" 3 "),
            write_run(self.root, "greenlight-replay-base-6", rows, exit_code="7"),
        ]
        with self.assertLogs(compare.logger, "WARNING"):
            comparison, health = self.health(paths)
        for line in (
            "| greenlight-replay-base-1 | Base | no artifact | no CSV | 0 | 0 | 0 | 1 |",
            "| greenlight-replay-base-2 | Base | 1 failed | no CSV | 0 | 0 | 0 | 1 |",
            "| greenlight-replay-base-3 | Base | no exit code | 1 | 1 | 0 | 0 | 0 |",
            "| greenlight-replay-base-4 | Base | unreadable exit code | 1 |",
            "| greenlight-replay-base-5 | Base | 3 degraded | 1 |",
            "| greenlight-replay-base-6 | Base | 7 other | 1 |",
            "| greenlight-replay-change-1 | This PR | 0 complete | 1 |",
        ):
            self.assertIn(line, health)
        self.assertEqual(comparison.base.runs_with_rows, 4)
        self.assertIn(
            "| Runs with results / runs | 4 / 6 | 2 / 2 |", self.render(comparison)
        )

    def test_an_unreadable_csv(self):
        path = write_run(self.root, "greenlight-replay-base-1", None)
        (Path(path) / compare.CSV_FILE).write_bytes(b"repo,pr_number\n\xff\xfe,1\n")
        with self.assertLogs(compare.logger, "ERROR"):
            comparison, health = self.health([path])
        self.assertIn(
            "| greenlight-replay-base-1 | Base | 0 complete | unreadable CSV |", health
        )
        self.assertEqual(comparison.base.runs[0].rows, {})

    def test_an_exit_code_file_that_cannot_be_read(self):
        unreadable = write_run(self.root, "base-1", [replay_row(1)], exit_code=None)
        # A directory in its place raises IsADirectoryError, an OSError other than
        # FileNotFoundError.
        (Path(unreadable) / compare.EXIT_CODE_FILE).mkdir()
        undecodable = write_run(self.root, "base-2", [replay_row(1)], exit_code=None)
        (Path(undecodable) / compare.EXIT_CODE_FILE).write_bytes(b"\xff\xfe0\n")
        for path in (unreadable, undecodable):
            with self.subTest(path):
                with self.assertLogs(compare.logger, "WARNING") as logs:
                    run = compare.load_run(path)
                self.assertEqual(
                    (run.exit_code, run.exit_note), (None, compare.UNREADABLE_EXIT_CODE)
                )
                self.assertIn("could not read", logs.output[0])

    def test_a_label_with_no_safe_character_falls_back(self):
        self.assertEqual(compare.run_label("/tmp/runs/@@ @@/"), "run")
        self.assertEqual(compare.run_label("/tmp/runs/base 1|x"), "base-1-x")

    def test_exit_meanings_follow_the_harness_exit_codes(self):
        self.assertEqual(
            compare_tables.EXIT_MEANINGS,
            {
                harness.EXIT_OK: "complete",
                harness.EXIT_FAILED: "failed",
                harness.EXIT_DEGRADED: "degraded",
            },
        )

    def test_failures_are_listed_by_reason_per_arm(self):
        comparison = self.compare({1: "FFL"}, {1: "LLF"})
        health = section(self.render(comparison), "Run health")
        self.assertIn("| `harness:timeout` | 2 | 1 |", health)


class TestDegenerateRuns(ReplayCase):
    def test_a_single_run_per_arm_assesses_nothing(self):
        comparison = self.compare({1: "L", 2: "N"}, {1: "N", 2: "N"})
        self.assertEqual(comparison.comparable, [])
        markdown = self.render(comparison)
        self.assertIn("Base and This PR had fewer than 2 runs", markdown)
        self.assertIn("| Flip rate (run to run) | n/a | n/a |", markdown)
        self.assertIn(
            "| Majority LAND rate, comparable PRs with a majority | n/a | n/a |",
            markdown,
        )
        self.assertIn("### True flips\n\nNone.", markdown)

    def test_no_rows_at_all(self):
        base = [str(Path(self.root) / "gone")]
        change = [write_run(self.root, "change-1", [], exit_code="1")]
        with self.assertLogs(compare.logger, "WARNING"):
            comparison = compare.compare(
                [compare.load_run(base[0])], [compare.load_run(change[0])]
            )
        markdown = self.render(comparison)
        self.assertIn("## GreenLight policy replay: base vs this PR", markdown)
        header = markdown.split("\n\n")[1]
        self.assertEqual(
            header,
            f"None of the 1 run under the base policy (`{BASE_SHA[:12]}`, the merge "
            f"base) or the 1 run under this PR's policy (`{HEAD_SHA[:12]}`) produced "
            f"results. [Workflow run]({RUN_URL}).",
        )
        self.assertNotIn("Replayed", header)
        self.assertNotIn("Re-reviewed", header)
        self.assertIn("No replay run produced results", markdown)
        self.assertIn("| gone | Base | no artifact | no CSV |", markdown)
        self.assertIn("| change-1 | This PR | 1 failed | 0 |", markdown)
        self.assertNotIn("### Summary", markdown)

    def test_sections_come_in_order_and_details_render(self):
        markdown = self.render(self.compare(TestArithmetic.BASE, TestArithmetic.CHANGE))
        titles = [
            "## GreenLight policy replay: base vs this PR",
            "### Summary",
            "### Flips",
            "### True flips",
            "### Non-true flips",
            "<summary>PRs unstable under this PR's policy",
            "<summary>PRs unstable under the base policy",
            "<summary>Excluded PRs",
            "### Reason codes",
            "<summary>Run health",
            "<summary>How to read this",
        ]
        positions = [markdown.index(title) for title in titles]
        self.assertEqual(positions, sorted(positions))
        summaries = re.findall(r"</summary>(.{0,2})", markdown, flags=re.DOTALL)
        self.assertEqual(summaries, ["\n\n"] * 5)
        self.assertEqual(markdown.count("<details>"), markdown.count("</details>"))
        self.assertIn(f"`{BASE_SHA[:12]}`, the merge base", markdown)
        self.assertIn(
            f"(`{HEAD_SHA[:12]}`), on Bedrock. [Workflow run]({RUN_URL})", markdown
        )

    def test_the_definitions_match_the_code(self):
        self.assertEqual({LAND, NO_LAND}, DECISION_VALUES)
        how_to_read = section(
            self.render(self.compare({1: "LL"}, {1: "LL"})), "How to read this"
        )
        self.assertIn(f"at least {compare_stats.MIN_VERDICTS} verdicts", how_to_read)
        self.assertIn(f"`{FAILED}`", how_to_read)
        self.assertIn(f"`{compare_stats.INVALID_REASON}`", how_to_read)
        self.assertIn(
            f"`{HARNESS_REASON_PREFIX}` is one even when it carries LAND or NO_LAND",
            how_to_read,
        )
        self.assertIn("- **Flip rate (run to run)** is the share of pairs", how_to_read)
        self.assertIn("**Flip rate, base → this PR** = (true + non-true", how_to_read)
        intervals = how_to_read[how_to_read.index("- **Intervals.**") :]
        self.assertIn(
            f"{compare_stats.CONFIDENCE:.0%} Wilson score interval (CI)", intervals
        )
        self.assertIn("whose sample size counts PRs, never runs", intervals)
        self.assertIn(
            'the PRs that contribute to them, shown as "over k PRs"', intervals
        )
        self.assertIn(
            "Overlapping intervals do not show that the arms are the same", intervals
        )
        attribution = how_to_read[how_to_read.index("- **Attribution.**") :]
        self.assertIn(
            "the CLI version and context window are the replay workflow's", attribution
        )
        self.assertIn(
            "The two flip rates have different bases and are not comparable with each "
            "other.",
            attribution,
        )
        self.assertNotIn("estimates", attribution)
        self.assertNotIn("everything in its own policy commit", attribution)
        self.assertNotIn("model and backend", how_to_read)

    def test_one_arm_short_of_runs_is_the_one_named(self):
        base = arm_dirs(self.root, "base", {1: "L"})
        change = arm_dirs(self.root, "change", {1: "LLL"})
        comparison = compare.compare(self.load(base), self.load(change))
        flips = section(self.render(comparison), "### Flips")
        self.assertIn(
            "Nothing is comparable: Base had fewer than 2 runs, so no PR can reach 2 "
            "verdicts there.",
            flips,
        )
        self.assertNotIn("This PR had", flips)


class TestSizeGuard(ReplayCase):
    def test_a_long_comment_caps_every_pr_table(self):
        prs = range(1, 801)
        comparison = self.compare(dict.fromkeys(prs, "LLN"), dict.fromkeys(prs, "NNL"))
        markdown = self.render(comparison)
        self.assertLessEqual(len(markdown), compare_render.MAX_CHARS)
        flips = section(markdown, "### Non-true flips")
        self.assertEqual(flips.count("\n| [#"), compare_render.CAPPED_ROWS)
        self.assertIn(
            "...and 775 more (see the replay CSV artifacts of the "
            f"[workflow run]({RUN_URL}))",
            flips,
        )
        self.assertIn("<summary>How to read this", markdown)

    def test_what_capping_cannot_shrink_is_cut_with_a_note(self):
        reasons = [f"reason_{index:05d}_{'x' * 40}" for index in range(2000)]
        base = [
            write_run(
                self.root,
                f"base-{run}",
                [
                    replay_row(i, new_decision_reason=r)
                    for i, r in enumerate(reasons, 1)
                ],
            )
            for run in (1, 2)
        ]
        comparison = compare.compare(self.load(base), self.load(base))
        markdown = self.render(comparison)
        self.assertLessEqual(len(markdown), compare_render.MAX_CHARS)
        self.assertTrue(markdown.endswith(compare_render.TRUNCATION_NOTE))
        self.assertEqual(markdown.count("<details>"), markdown.count("</details>"))


def cli_argv(base, change, output, **overrides):
    options = {
        "base-sha": BASE_SHA,
        "head-sha": HEAD_SHA,
        "run-url": RUN_URL,
        "output": output,
        **overrides,
    }
    argv = ["--base", *base, "--change", *change]
    for name, value in options.items():
        argv += [f"--{name}", value]
    return argv


class TestCli(ReplayCase):
    def setUp(self):
        super().setUp()
        self.base = arm_dirs(self.root, "base", {1: "LLL", 2: "LLN"})
        self.change = arm_dirs(self.root, "change", {1: "NNN", 2: "LLL"})

    def argv(self, output, **overrides):
        return cli_argv(self.base, self.change, output, **overrides)

    def main(self, argv):
        with mock.patch.object(compare.logging, "basicConfig"):
            return compare.main(argv)

    def rejected(self, **overrides):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(
            SystemExit
        ) as raised:
            self.main(self.argv(str(Path(self.root) / "out.md"), **overrides))
        self.assertEqual(raised.exception.code, 2)
        return stderr.getvalue()

    def test_the_comment_is_written_and_the_exit_status_is_0(self):
        output = Path(self.root) / "comment.md"
        with self.assertLogs(compare.logger, "INFO") as logs:
            status = self.main(self.argv(str(output)))
        self.assertEqual(status, compare.EXIT_OK)
        text = output.read_text(encoding="utf-8")
        self.assertTrue(
            text.startswith("## GreenLight policy replay: base vs this PR\n")
        )
        self.assertIn("wrote", logs.output[-1])
        self.assertIn("1 true and 0 non-true flips", logs.output[-1])

    def test_a_malformed_sha_is_refused(self):
        for sha in ("abc", "A" * 40, "a" * 41, "g" * 40):
            with self.subTest(sha):
                self.assertIn("--base-sha", self.rejected(**{"base-sha": sha}))
                self.assertIn("--head-sha", self.rejected(**{"head-sha": sha}))

    def test_a_run_url_must_name_a_workflow_run(self):
        for url in (
            "https://evil.example/pytorch/test-infra/actions/runs/1",
            "https://github.com/pytorch/test-infra/actions/runs/1/jobs/2",
            "https://github.com/pytorch/test-infra/actions/runs/x",
            "javascript:alert(1)",
        ):
            with self.subTest(url):
                self.assertIn("--run-url", self.rejected(**{"run-url": url}))
        output = Path(self.root) / "attempt.md"
        attempt = f"{RUN_URL}/attempts/2"
        with self.assertLogs(compare.logger, "INFO"):
            self.assertEqual(
                self.main(self.argv(str(output), **{"run-url": attempt})), 0
            )

    def test_an_unwritable_output_exits_1(self):
        output = str(Path(self.root) / "no-such-dir" / "comment.md")
        with self.assertLogs(compare.logger, "ERROR") as logs:
            status = self.main(self.argv(output))
        self.assertEqual(status, compare.EXIT_FAILED)
        self.assertIn("could not write", logs.output[-1])


BLOCK_AND_RUN = textwrap.dedent(
    """
    import runpy
    import sys


    class Block:
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in ("clickhouse_connect", "yaml"):
                raise ModuleNotFoundError(f"blocked: {name}")
            return None


    sys.meta_path.insert(0, Block())
    sys.argv = ["compare", *sys.argv[1:]]
    runpy.run_module("torchci.greenlight_replay.compare", run_name="__main__")
    """
)


class TestModuleEntryPoint(ReplayCase):
    def test_runs_as_a_module_without_clickhouse_or_yaml(self):
        output = Path(self.root) / "comment.md"
        argv = cli_argv(
            arm_dirs(self.root, "base", {1: "LL"}),
            arm_dirs(self.root, "change", {1: "NN"}),
            str(output),
        )
        result = subprocess.run(
            [sys.executable, "-c", BLOCK_AND_RUN, *argv],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("### True flips", output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
