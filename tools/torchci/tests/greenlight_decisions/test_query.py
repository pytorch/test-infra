"""Tests for the ClickHouse half of the decision export.

``SQL_DECISIONS`` cannot be executed here, so the clauses that were each a
measured defect are asserted against the CTE that must carry them. Everything
else drives ``fetch_decisions`` through a fake client, so nothing touches
ClickHouse.
"""

import unittest
from datetime import datetime, timedelta, timezone

from torchci.greenlight_decisions.query import (
    fetch_decisions,
    FIELDS,
    SYNTHETIC_PR_NUMBER,
)

# Imported from its own module rather than through query's re-export, so a
# reader chasing one of the guards below finds the text in the file named here.
from torchci.greenlight_decisions.sql import SQL_DECISIONS


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


def cte(name: str) -> str:
    """The body of one named common table expression of SQL_DECISIONS.

    Guards are asserted against the CTE that must carry them rather than the
    whole query, because the same clause appears in more than one CTE and a
    whole-query search would pass while the one that matters had lost it.
    """
    opening = f"{name} AS ("
    if opening not in SQL_DECISIONS:
        raise AssertionError(f"SQL_DECISIONS has no {name!r} CTE")
    start = SQL_DECISIONS.index(opening) + len(opening)
    return SQL_DECISIONS[start : SQL_DECISIONS.index("\n),", start)]


class TestSqlGuards(unittest.TestCase):
    """Regression locks on query clauses that were each a measured defect."""

    def test_synthetic_pr_is_excluded(self) -> None:
        self.assertIn("pr_number != {synthetic_pr:Int64}", cte("gl_rows"))
        self.assertEqual(SYNTHETIC_PR_NUMBER, 999999)

    def test_run_id_zero_is_not_excluded(self) -> None:
        # Four real NO_LAND verdicts exist only as a hand-emitted run_id 0 row.
        self.assertNotIn("run_id != 0", SQL_DECISIONS)
        self.assertNotIn("run_id > 0", SQL_DECISIONS)

    def test_reviews_are_not_filtered_to_submitted(self) -> None:
        # `action = 'submitted'` counts dismissed approvals as live, over-reporting
        # approval on 1.05% of PRs -- the worst direction for a land gate.
        reviews = cte("resolved_reviews")
        self.assertNotIn("action = 'submitted'", reviews)
        self.assertIn("dismissed", reviews)

    def test_bot_reviews_are_excluded(self) -> None:
        self.assertIn("review.user.type != 'Bot'", cte("resolved_reviews"))

    def test_commented_reviews_are_excluded(self) -> None:
        # COMMENTED wraps inline code comments, not an opinion on the PR.
        self.assertIn("state != 'commented'", cte("latest_review_per_login"))

    def test_the_commit_scan_pins_the_repository(self) -> None:
        # pytorch/pytorch-canary emits 1,440 pushes carrying pytorch/pytorch
        # trailers. Both the landed and the reverted derivations read this one
        # CTE, so the filter here guards two columns rather than one.
        commits = cte("main_commit_messages")
        self.assertIn("default.push", commits)
        self.assertIn("repository.full_name = {repo:String}", commits)
        self.assertIn("ref = {main_ref:String}", commits)

    def test_landed_and_reverted_both_read_the_filtered_commits(self) -> None:
        for name in ("landed_prs", "reverted_prs"):
            with self.subTest(cte=name):
                self.assertIn("main_commit_messages", cte(name))
                self.assertNotIn("default.push", cte(name))

    def test_every_pr_metadata_column_is_deduped(self) -> None:
        # default.pull_request is a SharedReplacingMergeTree with no version
        # column and up to three un-collapsed snapshot rows per PR. One column
        # left un-deduped reads a stale snapshot for that field alone, which is
        # far harder to notice than a wholly stale row.
        selected = [
            line.strip()
            for line in cte("pr_meta").splitlines()
            if " AS " in line and not line.strip().startswith("number AS ")
        ]
        self.assertTrue(selected, "pr_meta selects nothing")
        for line in selected:
            with self.subTest(column=line):
                self.assertIn("argMax(", line)
                self.assertIn("updated_at)", line)

    def test_reverted_does_not_come_from_the_greenlight_state_table(self) -> None:
        # Sourcing it there missed 3 of 10 real reverts, every one of them a
        # NO_LAND: greenlight writes a REVERTED row only when it has an approval
        # to revoke, and it never approves a NO_LAND PR. So the state table
        # under-reports exactly the population the export exists to measure.
        reverted = cte("reverted_prs")
        self.assertIn("{revert_pattern:String}", reverted)
        self.assertNotIn("status = 'REVERTED'", reverted)

    def test_reverted_is_independent_of_the_selected_verdict(self) -> None:
        # A later AI_REVIEW_STARTED outranks a PR's REVERTED row, so folding the
        # two together would report greenlight's false approvals as clean LANDs.
        self.assertNotIn("reverted", cte("decision_row"))
        self.assertIn("reverted_prs", SQL_DECISIONS)

    def test_shadow_is_independent_of_the_selected_verdict(self) -> None:
        # A PR greenlight never reached a verdict on still carries the flag, so
        # reading it off decision_row reports the whole verdict-less shadow
        # population as enforcing. The aggregate has to be the OR: min() reads
        # identically until one PR holds rows of both kinds, and then answers
        # the wrong way on exactly the PR the distinction exists for.
        self.assertIn("max(shadow)", cte("corpus"))
        self.assertNotIn("shadow", cte("decision_row"))
        self.assertIn("c.is_shadow AS is_shadow", SQL_DECISIONS)

    def test_terminal_selection_keeps_land_and_no_land_only(self) -> None:
        self.assertIn("g.status IN ('LAND', 'NO_LAND')", cte("terminal_rows"))

    def test_landed_is_merged_or_trailer_never_trailer_alone(self) -> None:
        # Trailer-only reported false for the five release/2.14 PRs, which land
        # by merge button and leave no trailer on main -- while pr_status said
        # closed-merged for the same rows. Merge-only misses every normal and
        # ghstack landing, where mergebot rebases and pushes. Neither branch
        # alone is complete.
        self.assertIn("p.merged OR landed_via_trailer AS landed", SQL_DECISIONS)

    def test_pr_status_is_derived_from_landed_so_the_two_cannot_disagree(self) -> None:
        # closed-merged is defined as "not open and landed", which is what makes
        # `closed-merged` <=> `landed and not open` hold by construction rather
        # than by luck. The three reopened-after-revert PRs are the reason the
        # open branch has to come first: they are landed and open at once.
        status = SQL_DECISIONS[
            SQL_DECISIONS.index("multiIf(") : SQL_DECISIONS.index(") AS pr_status")
        ]
        self.assertIn("p.state = 'open', 'open'", status)
        self.assertIn("landed, 'closed-merged'", status)
        self.assertIn("'closed-abandoned'", status)
        self.assertLess(status.index("'open'"), status.index("'closed-merged'"))


class TestFetchDecisions(unittest.TestCase):
    def raw_row(self, **overrides):
        row = dict.fromkeys(FIELDS, "")
        row.update(
            {
                "pr_number": "194379",
                "pr_status": "closed-merged",
                "n_terminal_decisions": "2",
                "human_approvals": "1",
                "human_changes_requested": "0",
                "additions": "16",
                "deletions": "4",
                "changed_files": "2",
                "reverted": 1,
                "landed": 1,
                "verdict_flipped": 0,
                "is_shadow": 0,
                "decision_run_id": "17654321",
                "decision_version": datetime(
                    2026, 8, 14, 9, 12, 33, tzinfo=timezone.utc
                ),
                # Not a FIELD: a health signal the trailer-scan guard reads and
                # the row assembly then drops.
                "landed_via_trailer": 1,
            }
        )
        row.update(overrides)
        return row

    def fetch(self, rows, **kwargs):
        client = FakeClient(rows)
        return fetch_decisions(client, **kwargs), client

    def test_row_has_exactly_the_declared_fields(self) -> None:
        [row], _ = self.fetch([self.raw_row()])
        self.assertEqual(set(row.keys()), set(FIELDS))

    def test_numeric_fields_coerce(self) -> None:
        [row], _ = self.fetch([self.raw_row()])
        self.assertEqual(row["pr_number"], 194379)
        self.assertEqual(row["additions"], 16)
        self.assertEqual(row["decision_run_id"], 17654321)

    def test_reverted_coerces_to_bool(self) -> None:
        [reverted], _ = self.fetch([self.raw_row(reverted=1)])
        [kept], _ = self.fetch([self.raw_row(reverted=0)])
        self.assertIs(reverted["reverted"], True)
        self.assertIs(kept["reverted"], False)

    def test_is_shadow_coerces_to_bool(self) -> None:
        # A per-PR max() over the state rows, so unlike the run id below it has
        # no missing case: every PR in the corpus has one and gets a real answer.
        [shadow], _ = self.fetch([self.raw_row(is_shadow=1)])
        [enforcing], _ = self.fetch([self.raw_row(is_shadow=0)])
        self.assertIs(shadow["is_shadow"], True)
        self.assertIs(enforcing["is_shadow"], False)

    def test_missing_run_id_stays_none(self) -> None:
        [row], _ = self.fetch([self.raw_row(decision_run_id=None)])
        self.assertIsNone(row["decision_run_id"])

    def test_version_is_normalized_to_naive_utc(self) -> None:
        # Mixing aware and naive datetimes in one export makes decision_version
        # uncomparable across rows.
        [row], _ = self.fetch([self.raw_row()])
        self.assertIsNone(row["decision_version"].tzinfo)
        self.assertEqual(row["decision_version"].hour, 9)

    def test_an_offset_as_of_is_converted_to_utc(self) -> None:
        # The bound text carries no offset, so the conversion has to happen
        # before it is rendered or the cutoff silently moves by the offset.
        _, client = self.fetch(
            [],
            as_of=datetime(2026, 8, 20, 13, 30, tzinfo=timezone(timedelta(hours=2))),
        )
        self.assertEqual(client.parameters["as_of"], "2026-08-20 11:30:00.000")

    def test_a_naive_as_of_is_read_as_utc_not_local(self) -> None:
        # Read as local time instead, a naive cutoff from a UTC-7 host would
        # admit seven extra hours of rows past it.
        _, client = self.fetch([], as_of=datetime(2026, 8, 20, 11, 30))
        self.assertEqual(client.parameters["as_of"], "2026-08-20 11:30:00.000")

    def test_as_of_keeps_millisecond_precision(self) -> None:
        # The state table's version column is DateTime64(3); truncating to whole
        # seconds would move the cutoff by up to a second in either direction.
        _, client = self.fetch(
            [], as_of=datetime(2026, 8, 20, 11, 30, 15, 123456, tzinfo=timezone.utc)
        )
        self.assertEqual(client.parameters["as_of"], "2026-08-20 11:30:15.123")

    def test_a_decision_version_fed_back_as_as_of_reproduces_its_verdict(self) -> None:
        # The replay property: a row's own decision_version, handed straight back
        # to --as-of, has to still include that verdict. 326 of 328 verdict rows
        # carry a nonzero millisecond, so any truncation drops the very verdict
        # being replayed -- and the row is still emitted, just without it, which
        # is why this regresses invisibly. PR 195938 is the boundary case.
        version = datetime(2026, 8, 28, 23, 17, 47, 289000)
        [row], _ = self.fetch([self.raw_row(decision_version=version)])
        _, client = self.fetch([], as_of=row["decision_version"])
        self.assertEqual(client.parameters["as_of"], "2026-08-28 23:17:47.289")

    def test_one_millisecond_earlier_excludes_that_verdict(self) -> None:
        # The other half: the boundary is exact, not approximate.
        _, client = self.fetch([], as_of=datetime(2026, 8, 28, 23, 17, 47, 288000))
        self.assertEqual(client.parameters["as_of"], "2026-08-28 23:17:47.288")
        self.assertLess(client.parameters["as_of"], "2026-08-28 23:17:47.289")

    def test_the_cutoff_is_inclusive_and_binds_as_of(self) -> None:
        # <= rather than <, or a verdict replayed at its own timestamp is
        # excluded by exactly the instant that identifies it. Matched loosely on
        # purpose: the property is the operator and the parameter, not whatever
        # cast currently sits between them.
        self.assertRegex(SQL_DECISIONS, r"version\s*<=\s*[^<>\n]*\{as_of:")
        self.assertNotRegex(SQL_DECISIONS, r"version\s*<\s[^=]")

    def test_default_as_of_is_rendered_the_same_way(self) -> None:
        _, client = self.fetch([])
        bound = client.parameters["as_of"]
        self.assertIsInstance(bound, str)
        self.assertRegex(bound, r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$")

    def test_a_dead_trailer_scan_raises_rather_than_reporting_abandoned(self) -> None:
        # The whole landed/reverted design rests on mergebot's trailer format.
        # If it changes, nothing errors: every landed PR just reads
        # closed-abandoned. This guard is the only thing that turns that silence
        # into a failure.
        closed = self.raw_row(pr_status="closed-merged", landed_via_trailer=0)
        with self.assertRaises(RuntimeError) as caught:
            self.fetch([closed])
        self.assertIn("trailer", str(caught.exception).lower())

    def test_one_trailer_match_is_enough(self) -> None:
        rows = [
            self.raw_row(
                pr_number="1", pr_status="closed-merged", landed_via_trailer=0
            ),
            self.raw_row(
                pr_number="2", pr_status="closed-merged", landed_via_trailer=1
            ),
        ]
        self.assertEqual(len(self.fetch(rows)[0]), 2)

    def test_an_all_open_corpus_is_not_a_dead_scan(self) -> None:
        # Nothing has landed yet, so no trailer match is the correct state.
        rows = [self.raw_row(pr_status="open", landed_via_trailer=0)]
        self.assertEqual(len(self.fetch(rows)[0]), 1)

    def test_repo_is_regex_escaped_in_both_trailer_patterns(self) -> None:
        # Unescaped, a dot in the repo name matches any character, so a
        # neighbouring repo's trailers would be read as this one's.
        _, client = self.fetch([], repo="pytorch/audio.js")
        for name in ("landed_pattern", "revert_pattern"):
            with self.subTest(parameter=name):
                self.assertIn(r"audio\.js", client.parameters[name])

    def test_synthetic_pr_number_is_bound(self) -> None:
        _, client = self.fetch([])
        self.assertEqual(client.parameters["synthetic_pr"], SYNTHETIC_PR_NUMBER)

    def test_main_ref_is_bound(self) -> None:
        _, client = self.fetch([])
        self.assertEqual(client.parameters["main_ref"], "refs/heads/main")


if __name__ == "__main__":
    unittest.main()
