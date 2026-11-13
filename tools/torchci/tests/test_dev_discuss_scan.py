import sys
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import main, TestCase


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analytics"))

from analytics.dev_discuss_scan import (  # noqa: E402
    date_drift,
    dates_block,
    find_topic,
    parse_date,
    parse_key_dates,
    post_step_rows,
    title_pattern,
)
from torchci import release_portal_config as cfg  # noqa: E402


def table(*rows):
    cells = "".join(
        "<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows
    )
    return (
        "<p>intro</p><table><thead><tr><th>Milestone</th><th>Description</th>"
        f"<th>Date</th></tr></thead><tbody>{cells}</tbody></table>"
    )


# The key dates table of "Release 2.16.0 | Key Dates", as dev-discuss serves it.
MINOR_POST = table(
    ("M1", "Release Announcement", "3/11/26"),
    ("M2", "All PRs landed / Feature Submission Closed", "27/11/26"),
    ("M3", "Release branch cut, create RC1", "week of 30/11/26"),
    ("M4", "Release branch finalized; final RC produced", "week of 7/12/26"),
    ("M4.1", "Tutorial drafts submission deadline", "10/12/26"),
    ("M5", "External-Facing Content Finalized", "15/12/26"),
    ("M6", "Release Day", "17/12/26"),
)
# The one of "PyTorch Release 2.14.1": bold cells, month names and no year.
PATCH_POST = table(
    (
        "<strong>M1</strong>",
        "Patch Release Announcement",
        "<strong>September 22</strong>",
    ),
    (
        "<strong>M2</strong>",
        "Cherry-pick post deadline",
        "<strong>September 25</strong>",
    ),
    (
        "<strong>M3</strong>",
        "All RC binaries ready for testing",
        "<strong>September 28</strong>",
    ),
    ("<strong>M4</strong>", "General Availability", "<strong>September 30</strong>"),
)


def topic(id, title):
    return {
        "id": id,
        "slug": "slug",
        "title": title,
        "created_at": "2026-11-03T20:16:37.243Z",
    }


class KeyDates(TestCase):
    def test_a_minor_release_takes_the_branch_cut_final_rc_and_release_day(self):
        self.assertEqual(
            parse_key_dates(MINOR_POST, "minor", date(2026, 11, 3)),
            {"branch_cut": "2026-11-30", "final_rc": "2026-12-07", "ga": "2026-12-17"},
        )

    def test_a_patch_release_has_no_branch_cut_and_dates_without_a_year(self):
        self.assertEqual(
            parse_key_dates(PATCH_POST, "patch", date(2026, 9, 22)),
            {"branch_cut": None, "final_rc": "2026-09-28", "ga": "2026-09-30"},
        )

    def test_an_unreadable_table_gives_no_dates(self):
        self.assertEqual(
            parse_key_dates("<p>no table</p>", "minor", date(2026, 11, 3)),
            {"branch_cut": None, "final_rc": None, "ga": None},
        )

    def test_dates(self):
        posted = date(2026, 11, 3)
        self.assertEqual(parse_date("3/11/26", posted), date(2026, 11, 3))
        self.assertEqual(parse_date("week of 30/11/2026", posted), date(2026, 11, 30))
        self.assertEqual(parse_date("December 17", posted), date(2026, 12, 17))
        self.assertEqual(parse_date("Dec 17", posted), None)
        self.assertEqual(parse_date("31/02/26", posted), None)
        # a post of late December about a January date is in the next year
        self.assertEqual(parse_date("January 8", date(2026, 12, 20)), date(2027, 1, 8))

    def test_the_difference_with_the_release_file_and_the_block_to_put_in_it(self):
        post = {
            "branch_cut": "2026-11-30",
            "final_rc": "2026-12-07",
            "ga": "2026-12-17",
        }
        self.assertEqual(date_drift(post, post), {})
        self.assertEqual(
            date_drift(
                {"branch_cut": None, "final_rc": "2026-12-07", "ga": "2026-12-22"}, post
            ),
            {
                "branch_cut": {"file": None, "post": "2026-11-30"},
                "ga": {"file": "2026-12-22", "post": "2026-12-17"},
            },
        )
        self.assertEqual(
            dates_block(post),
            "dates:\n  branch_cut: 2026-11-30\n  final_rc: 2026-12-07\n  ga: 2026-12-17",
        )


class PostPatterns(TestCase):
    def pattern(self, step_id, version):
        config = cfg.load_resolved(version)
        step = next(s for s in config["steps"] if s["id"] == step_id)
        return title_pattern(step["check"], version, config["type"])

    def test_each_announcement_step_matches_the_titles_of_the_real_posts(self):
        cases = [
            ("1.13", "2.16.0", "Release 2.16.0 | Key Dates", True),
            ("1.13", "2.16.0", "PyTorch Release 2.16 | Key Dates", True),
            ("1.13", "2.16.0", "PyTorch Release 2.10 | Key Dates [UPDATED]", False),
            ("1.13", "2.15.1", "PyTorch Release 2.15.1", True),
            # the key dates of the minor release are not the patch release's
            ("1.13", "2.15.1", "PyTorch Release 2.15 | Key Dates", False),
            ("1.14", "2.16.0", "PyTorch Release 2.16 Branch Cut is Complete", True),
            ("1.14", "2.16.0", "PyTorch Release 2.15 Branch Cut is Complete", False),
            (
                "2.14",
                "2.16.0",
                "PyTorch 2.16 RC1 produced for pytorch, torchvision & torchaudio",
                True,
            ),
            ("3.10", "2.16.0", "PyTorch 2.16 Final RC Available", True),
            (
                "3.10",
                "2.16.0",
                "PyTorch 2.16 Final RC produced for pytorch & torchvision",
                True,
            ),
            ("4.7", "2.16.0", "PyTorch 2.16.0 General Availability", True),
            ("4.7", "2.15.1", "PyTorch 2.15.1 General Availability", True),
            ("4.7", "2.15.1", "PyTorch 2.15.0 General Availability", False),
        ]
        for step_id, version, title, expected in cases:
            self.assertEqual(
                bool(self.pattern(step_id, version).search(title)),
                expected,
                (step_id, version, title),
            )

    def test_the_newest_matching_topic_wins(self):
        pattern = self.pattern("1.13", "2.16.0")
        topics = [
            topic(1, "Release 2.16.0 | Key Dates"),
            topic(3, "Release 2.16.0 | Key Dates [UPDATED]"),
            topic(2, "Something else"),
        ]
        self.assertEqual(find_topic(topics, pattern)["id"], 3)
        self.assertIsNone(find_topic([topic(2, "Something else")], pattern))


class StepRows(TestCase):
    def rows(
        self,
        release,
        topics,
        post=MINOR_POST,
        dates=None,
        created_at="2026-11-03T20:16:37.243Z",
    ):
        config = cfg.load_resolved(release)
        if dates is not None:
            config["dates"] = dates
        rows, problems, proposed = post_step_rows(
            release,
            config,
            topics,
            lambda topic_id: (post, created_at),
            "0" * 40,
            "1-1",
            "https://example.com/run",
            datetime(2026, 11, 13, 14, 0, tzinfo=timezone.utc),
        )
        return {row["step_id"]: row for row in rows}, problems, proposed

    def test_a_step_without_its_post_is_todo_and_one_with_it_is_done(self):
        rows, problems, _ = self.rows(
            "2.16.0",
            [
                topic(10, "Release 2.16.0 | Key Dates"),
                topic(11, "PyTorch Release 2.16 Branch Cut is Complete"),
            ],
        )
        self.assertEqual(set(rows), {"1.13", "1.14", "2.14", "3.10", "4.7"})
        self.assertEqual(
            {k: r["status"] for k, r in rows.items()},
            {
                "1.13": "done",
                "1.14": "done",
                "2.14": "todo",
                "3.10": "todo",
                "4.7": "todo",
            },
        )
        self.assertEqual(problems, [])
        self.assertEqual(
            rows["1.14"]["evidence_url"], "https://dev-discuss.pytorch.org/t/slug/11"
        )
        self.assertEqual(rows["1.14"]["check_type"], "dev_discuss_post")
        self.assertEqual(rows["1.14"]["observed_at"], "2026-11-13 14:00:00.000")

    def test_key_dates_that_differ_from_the_release_file_are_in_progress_with_the_block(
        self,
    ):
        rows, problems, proposed = self.rows(
            "2.16.0",
            [topic(10, "Release 2.16.0 | Key Dates")],
            dates={
                "branch_cut": "2026-11-30",
                "final_rc": "2026-12-07",
                "ga": "2026-12-22",
            },
        )
        self.assertEqual(rows["1.13"]["status"], "in_progress")
        self.assertIn("ga 2026-12-22 (post: 2026-12-17)", rows["1.13"]["evidence_text"])
        self.assertEqual(len(problems), 1)
        self.assertEqual(
            proposed,
            "dates:\n  branch_cut: 2026-11-30\n  final_rc: 2026-12-07\n  ga: 2026-12-17",
        )

    def test_a_release_file_without_dates_is_behind_the_post(self):
        rows, problems, _ = self.rows(
            "2.15.1",
            [topic(10, "PyTorch Release 2.15.1")],
            post=PATCH_POST,
            created_at="2026-09-22T17:00:00.000Z",
            dates={"branch_cut": None, "final_rc": None, "ga": None},
        )
        self.assertEqual(rows["1.13"]["status"], "in_progress")
        self.assertIn(
            "final_rc not set (post: 2026-09-28)", rows["1.13"]["evidence_text"]
        )
        self.assertEqual(len(problems), 1)

    def test_no_key_dates_post_yet_is_not_a_problem(self):
        rows, problems, proposed = self.rows("2.15.1", [])
        self.assertEqual(rows["1.13"]["status"], "todo")
        self.assertEqual((problems, proposed), ([], None))

    def test_a_table_that_cannot_be_read_is_a_problem(self):
        rows, problems, _ = self.rows(
            "2.16.0", [topic(10, "Release 2.16.0 | Key Dates")], post="<p>no table</p>"
        )
        self.assertEqual(rows["1.13"]["status"], "in_progress")
        self.assertEqual(len(problems), 1)


if __name__ == "__main__":
    main()
