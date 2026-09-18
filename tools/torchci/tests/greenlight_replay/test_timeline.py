"""Tests for the three timestamps that place a pull request in time.

Both reads drive the real function through a fake client, so the query text and the
parameter binding are exercised rather than stubbed out. Nothing here touches ClickHouse.
"""

import unittest
from datetime import datetime, timedelta, timezone

from torchci.greenlight_decisions.query import SYNTHETIC_PR_NUMBER
from torchci.greenlight_decisions.sql import _LANDED_PATTERN, _REVERT_PATTERN
from torchci.greenlight_replay import timeline


REPO = "pytorch/pytorch"

FIRST_LANDING = datetime(2026, 8, 26, 22, 21, 4)
SECOND_LANDING = datetime(2026, 8, 31, 23, 48, 4)
REVERTED_AT = datetime(2026, 8, 28, 0, 16, 13)


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def named_results(self):
        return iter(self._rows)


class FakeClient:
    """Stands in for a clickhouse_connect client; records the bound parameters."""

    def __init__(self, rows):
        self.rows = rows
        self.sql = None
        self.parameters = None

    def query(self, sql, parameters=None):
        self.sql = sql
        self.parameters = parameters
        return FakeResult(self.rows)


def landing(pr, kind=timeline.LAND, sha="e" * 40, ts=None):
    return {"pr_number": pr, "kind": kind, "sha": sha, "ts": ts or FIRST_LANDING}


class TestFetchLandings(unittest.TestCase):
    """The landing scan decides how each row is framed, so the pattern it matches and the
    ref it reads have to be the export's, and its output has to be chronological."""

    def fetch(self, rows, repo=REPO):
        client = FakeClient(rows)
        return timeline.fetch_landings(client, repo), client

    def test_events_are_grouped_by_pr_and_ordered_oldest_first(self):
        landings, _ = self.fetch(
            [
                landing(2, sha="b" * 40, ts=SECOND_LANDING),
                landing(1, ts=FIRST_LANDING),
                landing(2, kind=timeline.REVERT, sha="c" * 40, ts=REVERTED_AT),
                landing(2, sha="a" * 40, ts=FIRST_LANDING),
            ]
        )
        self.assertEqual(sorted(landings), [1, 2])
        self.assertEqual(
            [(event.kind, event.sha[0]) for event in landings[2]],
            [(timeline.LAND, "a"), (timeline.REVERT, "c"), (timeline.LAND, "b")],
        )

    def test_the_query_reuses_the_exports_trailer_patterns(self):
        # Two definitions of "landed" would let the export and the replay disagree about
        # which pull requests exist, silently and in opposite directions.
        _, client = self.fetch([landing(1)])
        self.assertEqual(
            client.parameters["landed_pattern"],
            _LANDED_PATTERN.format(repo=r"pytorch/pytorch"),
        )
        self.assertEqual(
            client.parameters["revert_pattern"],
            _REVERT_PATTERN.format(repo=r"pytorch/pytorch"),
        )

    def test_the_repo_is_regex_escaped_in_both_patterns(self):
        # Unescaped, a dot in the repo name matches any character, so a neighbouring
        # repository's trailers would be read as this one's.
        _, client = self.fetch([landing(1)], repo="pytorch/audio.js")
        for name in ("landed_pattern", "revert_pattern"):
            with self.subTest(parameter=name):
                self.assertIn(r"audio\.js", client.parameters[name])

    def test_the_scan_is_pinned_to_the_repository_and_to_main(self):
        # pytorch/pytorch-canary pushes commits carrying pytorch/pytorch trailers, and a
        # landing on any other ref is not a landing.
        _, client = self.fetch([landing(1)])
        self.assertEqual(client.parameters["main_ref"], "refs/heads/main")
        self.assertEqual(client.parameters["repo"], REPO)
        self.assertIn("repository.full_name = {repo:String}", timeline.SQL_LANDINGS)
        self.assertIn("ref = {main_ref:String}", timeline.SQL_LANDINGS)

    def test_duplicate_push_rows_collapse_to_one_event(self):
        # default.push is a SharedReplacingMergeTree, so the collapse happens in SQL; this
        # locks the clause that does it, which a reader cannot see from the result shape.
        self.assertIn("GROUP BY kind, pr_number, sha", timeline.SQL_LANDINGS)
        self.assertIn("min(ts) AS ts", timeline.SQL_LANDINGS)

    def test_an_unmatched_pr_number_is_excluded_in_sql(self):
        self.assertIn("WHERE pr_number > 0", timeline.SQL_LANDINGS)

    def test_an_aware_timestamp_is_converted_rather_than_relabelled(self):
        berlin = timezone(timedelta(hours=2))
        landings, _ = self.fetch(
            [landing(1, ts=datetime(2026, 8, 26, 14, 0, tzinfo=berlin))]
        )
        self.assertEqual(landings[1][0].ts, datetime(2026, 8, 26, 12, 0))
        self.assertIsNone(landings[1][0].ts.tzinfo)


class TestTrailerScanGuard(unittest.TestCase):
    """A change to mergebot's trailer format degrades to silence, not to an error. The
    export refuses that result in fetch_decisions; refusing it here too is what stops the
    same change from quietly emptying the frame instead of mislabelling it -- every row
    would drop as not_landed and the funnel would read like a finding about the corpus."""

    def test_a_scan_that_matched_nothing_raises(self):
        with self.assertRaises(RuntimeError) as caught:
            timeline.fetch_landings(FakeClient([]), REPO)
        self.assertIn("trailer", str(caught.exception).lower())

    def test_the_message_names_the_pattern_to_check_and_the_ref(self):
        # The operator's next move is to compare the pattern against a recent commit, so
        # the error has to carry both rather than just saying the frame was empty.
        with self.assertRaises(RuntimeError) as caught:
            timeline.fetch_landings(FakeClient([]), REPO)
        message = str(caught.exception)
        self.assertIn("Pull Request resolved", message)
        self.assertIn(timeline.MAIN_REF, message)
        self.assertIn(REPO, message)

    def test_one_match_is_enough(self):
        landings = timeline.fetch_landings(FakeClient([landing(1)]), REPO)
        self.assertEqual(list(landings), [1])


class TestFetchFirstVerdicts(unittest.TestCase):
    """The export cannot answer this: decision_version timestamps the verdict it selected,
    which for a pull request that landed more than once is usually a later one. Measured
    2026-09-18, the selected verdict postdates the first landing on two of the six
    multi-landing rows that reach re-derivation, while an earlier verdict exists on both."""

    def fetch(self, rows, repo=REPO):
        client = FakeClient(rows)
        return timeline.fetch_first_verdicts(client, repo), client

    def test_each_pr_maps_to_its_earliest_verdict(self):
        verdicts, _ = self.fetch(
            [
                {"pr_number": "194772", "first_verdict": datetime(2026, 8, 25, 19, 14)},
                {"pr_number": 193149, "first_verdict": datetime(2026, 8, 12, 12, 58)},
            ]
        )
        self.assertEqual(
            verdicts,
            {
                194772: datetime(2026, 8, 25, 19, 14),
                193149: datetime(2026, 8, 12, 12, 58),
            },
        )

    def test_only_terminal_statuses_count(self):
        # A dispatch that never produced a verdict is not a verdict, so the marker rows
        # greenlight writes around a review must not set the earliest-verdict instant.
        _, client = self.fetch([])
        self.assertEqual(client.parameters["terminal_statuses"], ["LAND", "NO_LAND"])
        self.assertIn(
            "status IN {terminal_statuses:Array(String)}", timeline.SQL_FIRST_VERDICTS
        )

    def test_the_synthetic_pr_is_excluded(self):
        _, client = self.fetch([])
        self.assertEqual(client.parameters["synthetic_pr"], SYNTHETIC_PR_NUMBER)
        self.assertIn("pr_number != {synthetic_pr:Int64}", timeline.SQL_FIRST_VERDICTS)

    def test_the_repository_is_bound(self):
        _, client = self.fetch([], repo="pytorch/executorch")
        self.assertEqual(client.parameters["repo"], "pytorch/executorch")
        self.assertIn("repo = {repo:String}", timeline.SQL_FIRST_VERDICTS)

    def test_it_takes_the_minimum_rather_than_any_verdict(self):
        self.assertIn("min(version) AS first_verdict", timeline.SQL_FIRST_VERDICTS)

    def test_an_aware_timestamp_is_converted_rather_than_relabelled(self):
        berlin = timezone(timedelta(hours=2))
        verdicts, _ = self.fetch(
            [
                {
                    "pr_number": 1,
                    "first_verdict": datetime(2026, 8, 26, 14, tzinfo=berlin),
                }
            ]
        )
        self.assertEqual(verdicts[1], datetime(2026, 8, 26, 12, 0))
        self.assertIsNone(verdicts[1].tzinfo)

    def test_an_empty_ledger_is_not_an_error(self):
        # Unlike the trailer scan, nothing is inferred from emptiness here: a repository
        # greenlight has never reviewed legitimately has no verdicts.
        verdicts, _ = self.fetch([])
        self.assertEqual(verdicts, {})


if __name__ == "__main__":
    unittest.main()
