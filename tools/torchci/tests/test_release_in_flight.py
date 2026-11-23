import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import main, TestCase
from unittest.mock import call, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from datetime import datetime, timezone

import analytics.github_analyze as github_analyze  # noqa: E402
from analytics.github_analyze import (  # noqa: E402
    find_release_only_changes_prs,
    github_issue_state_step_rows,
    GitRepo,
    milestone_issue_statuses,
    milestone_pr_step_rows,
    milestone_step_rows,
    recently_shipped_releases,
    record_github_issue_state_steps,
    release_in_preparation,
    release_only_changes_step_rows,
    releases_in_flight,
    releases_just_shipped,
    revert_step_rows,
    write_step_summary,
)


def git(path, *args):
    subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "HOME": str(path),
        },
    )


class ReleasesInFlight(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        subprocess.run(["git", "init", "-q", str(self.work)], check=True)
        self.branch("main", "main", "2.16.0a0")

    def tearDown(self):
        self.tmp.cleanup()

    def branch(self, name, start, version):
        """Commit version.txt on the branch (created from start if it is new) and make
        it the remote's, as origin/<name>, without a remote."""
        if name == "main" and not self.has("refs/heads/main"):
            git(self.work, "checkout", "-q", "--orphan", "main")
        elif name == "main":
            git(self.work, "checkout", "-q", "main")
        else:
            git(self.work, "checkout", "-q", "-B", name, f"refs/remotes/origin/{start}")
        (self.work / "version.txt").write_text(version + "\n")
        git(self.work, "add", "version.txt")
        git(self.work, "commit", "-q", "--allow-empty", "-m", f"{name} {version}")
        git(self.work, "update-ref", f"refs/remotes/origin/{name}", "HEAD")

    def has(self, ref):
        return (
            subprocess.run(
                ["git", "-C", str(self.work), "rev-parse", "-q", "--verify", ref],
                capture_output=True,
            ).returncode
            == 0
        )

    def tag(self, name):
        git(self.work, "tag", name)

    def repo(self):
        return GitRepo(str(self.work), "origin")

    def test_main_is_preparing_its_own_version(self):
        self.assertEqual(release_in_preparation(self.repo(), "main"), "2.16.0")

    def test_a_branch_after_its_release_prepares_the_next_patch(self):
        # release/2.15 keeps its a0 version after 2.15.0 ships
        self.branch("release/2.15", "main", "2.15.0a0")
        self.assertEqual(release_in_preparation(self.repo(), "release/2.15"), "2.15.0")
        self.tag("v2.15.0")
        self.assertEqual(release_in_preparation(self.repo(), "release/2.15"), "2.15.1")
        self.tag("v2.15.1")
        self.assertEqual(release_in_preparation(self.repo(), "release/2.15"), "2.15.2")

    def test_a_ref_that_does_not_exist_prepares_nothing(self):
        self.assertIsNone(release_in_preparation(self.repo(), "release/2.99"))

    def test_the_next_minor_and_the_patch_of_the_last_one_are_in_flight(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.assertEqual(
            releases_in_flight(self.repo(), ["2.16.0", "2.15.1", "2.10.0"]),
            ["2.16.0", "2.15.1"],
        )

    def test_a_release_without_an_open_milestone_is_not_in_flight(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.branch("release/2.14", "main", "2.14.1a0")
        self.tag("v2.14.0")
        self.tag("v2.14.1")
        # 2.14.2 has no milestone, 2.15.1's is closed
        self.assertEqual(releases_in_flight(self.repo(), ["2.16.0"]), ["2.16.0"])

    def test_a_release_being_prepared_on_its_branch_is_in_flight(self):
        # 2.16 is cut and main moved on; 2.16.0 is not tagged yet
        self.branch("release/2.16", "main", "2.16.0a0")
        self.branch("main", "main", "2.17.0a0")
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.assertEqual(
            releases_in_flight(self.repo(), ["2.16.0", "2.15.1"]),
            ["2.16.0", "2.15.1"],
        )

    def test_nothing_is_in_flight_without_a_main_version(self):
        self.assertEqual(releases_in_flight(GitRepo(self.tmp.name, "origin"), []), [])

    def test_a_shipped_release_with_an_open_milestone_is_just_shipped(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.assertEqual(
            releases_just_shipped(self.repo(), ["2.16.0", "2.15.0", "2.15.1"]),
            ["2.15.0"],
        )

    def test_every_shipped_patch_of_a_line_with_an_open_milestone_is_listed(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.tag("v2.15.1")
        self.assertEqual(
            releases_just_shipped(self.repo(), ["2.15.0", "2.15.1", "2.15.2"]),
            ["2.15.1", "2.15.0"],
        )

    def test_a_closed_milestone_or_an_old_line_is_not_just_shipped(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.branch("release/2.12", "main", "2.12.0a0")
        self.tag("v2.12.0")
        # 2.15.0's milestone is closed; 2.12 is more than three lines back
        self.assertEqual(
            releases_just_shipped(self.repo(), ["2.16.0", "2.12.0"]),
            [],
        )

    def test_nothing_is_just_shipped_without_a_main_version(self):
        self.assertEqual(
            releases_just_shipped(GitRepo(self.tmp.name, "origin"), ["2.15.0"]),
            [],
        )

    def test_a_shipped_release_is_found_after_its_milestone_closes(self):
        self.branch("release/2.15", "main", "2.15.0a0")
        self.tag("v2.15.0")
        self.assertEqual(recently_shipped_releases(self.repo()), ["2.15.0"])


class _Commit:
    def __init__(self, commit_hash, title, pr_url=""):
        self.commit_hash = commit_hash
        self.title = title
        self.pr_url = pr_url


def _revert(status, number=None, tags=()):
    return {
        "commit": _Commit(
            "a" * 40,
            "Revert something",
            f"https://github.com/pytorch/pytorch/pull/{number}" if number else "",
        ),
        "phabricator_revision": None,
        "reverted_commit": "b" * 40,
        "rc_tags": list(tags),
        "status": status,
    }


class RevertStepRows(TestCase):
    def rows(self, reverts):
        return revert_step_rows(
            "2.15.1",
            "release/2.15",
            [{"id": "2.13"}],
            {"main_only": 9, "branch_only": 1, "reverts": reverts},
            "0" * 40,
            "1-1",
            "https://github.com/pytorch/test-infra/actions/runs/1",
            datetime(2026, 11, 12, tzinfo=timezone.utc),
        )

    def test_a_revert_of_a_release_candidate_commit_keeps_the_step_open(self):
        (row,) = self.rows(
            [
                _revert("in_release_candidate", 11, ["v2.15.0-rc3"]),
                _revert("not_needed"),
                _revert("cherry_picked"),
            ]
        )
        self.assertEqual((row["step_id"], row["status"]), ("2.13", "in_progress"))
        self.assertIn("#11", row["evidence_text"])
        self.assertEqual(row["check_type"], "reverts_missing_from_branch")
        self.assertEqual(row["rc"], "")
        self.assertEqual(
            row["evidence_url"],
            "https://github.com/pytorch/test-infra/actions/runs/1",
        )

    def test_no_such_revert_is_done_whatever_else_is_on_main(self):
        (row,) = self.rows([_revert("not_needed"), _revert("cherry_picked")])
        self.assertEqual(row["status"], "done")
        self.assertEqual(
            row["evidence_text"],
            "No revert of a release candidate commit is missing from release/2.15",
        )
        # the reverts that need nothing are counted, not listed
        details = json.loads(row["details"])
        self.assertEqual(details["reverts"], [])
        self.assertEqual(details["reverts_on_main_not_on_branch"], 2)
        self.assertEqual(details["by_status"], {"not_needed": 1, "cherry_picked": 1})

    def test_the_details_list_only_the_reverts_to_cherry_pick(self):
        (row,) = self.rows(
            [
                _revert("in_release_candidate", 11, ["v2.15.0-rc3"]),
                _revert("not_needed"),
                _revert("cherry_picked"),
            ]
        )
        details = json.loads(row["details"])
        self.assertEqual(details["reverts_on_main_not_on_branch"], 3)
        self.assertEqual(
            details["by_status"],
            {"in_release_candidate": 1, "not_needed": 1, "cherry_picked": 1},
        )
        self.assertEqual(
            [r["status"] for r in details["reverts"]], ["in_release_candidate"]
        )
        self.assertEqual(details["reverts"][0]["rc_tags"], ["v2.15.0-rc3"])

    def test_a_revert_without_a_pr_is_named_by_its_commit(self):
        (row,) = self.rows([_revert("in_release_candidate", None, ["v2.15.0-rc1"])])
        self.assertIn("aaaaaaaaa", row["evidence_text"])

    def test_without_a_run_the_evidence_is_the_comparison(self):
        (row,) = revert_step_rows(
            "2.15.1",
            "release/2.15",
            [{"id": "2.13"}],
            {"main_only": 0, "branch_only": 0, "reverts": []},
            "0" * 40,
            "-1",
            "",
            datetime(2026, 11, 12, tzinfo=timezone.utc),
        )
        self.assertEqual(
            row["evidence_url"],
            "https://github.com/pytorch/pytorch/compare/release/2.15...main",
        )


def _issue(number, outstanding):
    return {
        "issue": {
            "number": number,
            "title": "An RFC",
            "html_url": f"https://github.com/pytorch/pytorch/issues/{number}",
            "state": "open",
        },
        "outstanding": outstanding,
        "reason": "open_issue" if outstanding else "closed_in_branch",
    }


class MilestoneStepRows(TestCase):
    def rows(self, statuses, released):
        return milestone_step_rows(
            "2.15.0",
            "release/2.15",
            7,
            [{"id": "1.2", "check": {"max_outstanding": 0}}],
            statuses,
            True,
            "0" * 40,
            "1-1",
            "https://github.com/pytorch/test-infra/actions/runs/1",
            datetime(2026, 11, 17, tzinfo=timezone.utc),
            released,
        )

    def test_an_outstanding_item_keeps_the_step_open_before_the_release(self):
        (row,) = self.rows([_issue(190875, True)], False)
        self.assertEqual(row["status"], "in_progress")
        self.assertEqual(
            row["evidence_text"], "1 outstanding in milestone 2.15.0: #190875"
        )
        self.assertFalse(json.loads(row["details"])["released"])

    def test_the_step_is_done_once_the_release_tag_exists(self):
        (row,) = self.rows([_issue(190875, True)], True)
        self.assertEqual(row["status"], "done")
        self.assertEqual(
            row["evidence_text"],
            "Release tag v2.15.0 exists, so the step is done; "
            "1 outstanding in milestone 2.15.0: #190875",
        )
        details = json.loads(row["details"])
        self.assertTrue(details["released"])
        self.assertEqual([i["number"] for i in details["outstanding"]], [190875])

    def test_a_clean_milestone_reads_the_same_after_the_release(self):
        (row,) = self.rows([_issue(1, False)], True)
        self.assertEqual(row["status"], "done")
        self.assertEqual(
            row["evidence_text"], "No outstanding items in milestone 2.15.0"
        )


def _milestone_item(number, state, reason, pull_request=True):
    item = {
        "number": number,
        "title": f"item {number}",
        "html_url": f"https://github.com/pytorch/pytorch/"
        f"{'pull' if pull_request else 'issues'}/{number}",
        "state": state,
    }
    if pull_request:
        item["pull_request"] = {}
    return {"issue": item, "outstanding": False, "reason": reason}


class MilestoneIgnoredIssues(TestCase):
    def reasons(self, items):
        class _Repo:
            def ref_exists(self, ref):
                return False  # before the cut: only open items are outstanding

        issues = [
            {
                "number": number,
                "title": title,
                "html_url": f"https://github.com/pytorch/pytorch/issues/{number}",
                "state": state,
                "labels": [],
                **({"pull_request": {}} if is_pr else {}),
            }
            for number, title, state, is_pr in items
        ]
        with patch(
            "analytics.github_analyze.gh_get_milestone_issues", return_value=issues
        ):
            statuses = milestone_issue_statuses(
                _Repo(), "release/2.15", "orig/release/2.15", 69
            )
        return {s["issue"]["number"]: (s["reason"], s["outstanding"]) for s in statuses}

    def test_the_rfc_the_tracker_and_the_validation_issue_are_not_counted(self):
        reasons = self.reasons(
            [
                (190875, "[RFC] Integrating FlyDSL with PyTorch DSL", "open", False),
                (
                    204614,
                    "[RFC][ONNX] Own native ONNX operator translations",
                    "open",
                    False,
                ),
                (199813, "[v.2.15.0] Release Tracker", "open", False),
                (
                    201644,
                    "Release 2.15 validations checklist and cherry-picks",
                    "open",
                    False,
                ),
            ]
        )
        self.assertEqual(set(reasons.values()), {("ignored_issue", False)}, reasons)

    def test_other_open_items_and_every_pr_are_still_counted(self):
        reasons = self.reasons(
            [
                (1, "Python 3.15 support for PyTorch", "open", False),
                (2, "[RFC] looks like an RFC but is a PR", "open", True),
                (3, "Release tracker fix", "open", True),
            ]
        )
        self.assertEqual(reasons[1], ("open", True))
        self.assertEqual(reasons[2], ("open", True))
        self.assertEqual(reasons[3], ("open", True))


def _github_issue(number, state):
    return {
        "number": number,
        "title": f"issue {number}",
        "state": state,
        "html_url": f"https://github.com/pytorch/pytorch/issues/{number}",
    }


class GithubIssueStateSteps(TestCase):
    STEPS = [
        {
            "id": "1.6",
            "check": {
                "type": "github_issue_state",
                "repo": "pytorch/pytorch",
                "issue": "{tracker_issue}",
                "expect": "open",
            },
        },
        {
            "id": "2.7",
            "depends_on": ["2.1"],
            "check": {
                "type": "github_issue_state",
                "repo": "pytorch/pytorch",
                "issue": "{validation_issue}",
                "expect": "open",
            },
        },
        {
            "id": "5.1",
            "check": {
                "type": "github_issue_state",
                "repo": "pytorch/pytorch",
                "issue": "{tracker_issue}",
                "expect": "closed",
            },
        },
    ]

    def rows(self, issues, branch_cut=True, released=False, steps=None):
        return github_issue_state_step_rows(
            "2.15.0",
            {"branch": "release/2.15", "steps": steps or self.STEPS},
            issues,
            branch_cut,
            released,
            "a" * 40,
            "123-1",
            "https://github.com/pytorch/test-infra/actions/runs/123",
            datetime(2026, 11, 23, tzinfo=timezone.utc),
        )

    def test_open_issues_satisfy_creation_steps_and_leave_closure_in_progress(self):
        rows = self.rows(
            {
                "tracker_issue": _github_issue(199813, "open"),
                "validation_issue": _github_issue(201644, "open"),
            }
        )
        by_step = {row["step_id"]: row for row in rows}
        self.assertEqual(by_step["1.6"]["status"], "done")
        self.assertEqual(by_step["2.7"]["status"], "done")
        self.assertEqual(by_step["5.1"]["status"], "in_progress")
        self.assertEqual(
            by_step["1.6"]["evidence_url"],
            "https://github.com/pytorch/pytorch/issues/199813",
        )
        self.assertEqual(json.loads(by_step["2.7"]["details"])["depends_on"], ["2.1"])

    def test_missing_issue_is_todo(self):
        rows = self.rows(
            {"tracker_issue": _github_issue(199813, "open"), "validation_issue": None}
        )
        validation = next(row for row in rows if row["step_id"] == "2.7")
        self.assertEqual(validation["status"], "todo")
        self.assertEqual(validation["evidence_text"], "validation issue not found")
        self.assertEqual(validation["evidence_url"], "")

    def test_closed_creation_issues_are_done_after_the_release(self):
        rows = self.rows(
            {
                "tracker_issue": _github_issue(199813, "closed"),
                "validation_issue": _github_issue(201644, "closed"),
            },
            released=True,
        )
        by_step = {row["step_id"]: row for row in rows}
        self.assertEqual(by_step["1.6"]["status"], "done")
        self.assertEqual(by_step["2.7"]["status"], "done")
        self.assertEqual(by_step["5.1"]["status"], "done")
        self.assertEqual(
            by_step["1.6"]["evidence_text"],
            "Release tag v2.15.0 exists; #199813 is closed",
        )

    def test_window_is_respected_without_dropping_a_discovered_link_after_ga(self):
        steps = [
            {
                **self.STEPS[0],
                "window": {"opens": "branch_cut", "closes": "ga"},
            }
        ]
        (before,) = self.rows(
            {"tracker_issue": _github_issue(199813, "open")}, False, False, steps
        )
        self.assertEqual(before["status"], "todo")
        self.assertEqual(before["evidence_url"], "")

        (after,) = self.rows(
            {"tracker_issue": _github_issue(199813, "closed")}, True, True, steps
        )
        self.assertEqual(after["status"], "done")
        self.assertEqual(
            after["evidence_url"], "https://github.com/pytorch/pytorch/issues/199813"
        )

    def test_collector_uses_discovery_and_reads_each_issue_once(self):
        class Repo:
            def ref_exists(self, ref):
                return True

            def tag_exists(self, tag):
                return False

        config = {"branch": "release/2.15", "steps": self.STEPS}
        with (
            patch(
                "torchci.release_portal_config.discover_issue_links",
                return_value={
                    "tracker_issue": {"number": 199813},
                    "validation_issue": {"number": 201644},
                },
            ),
            patch(
                "analytics.github_analyze.gh_get_issue",
                side_effect=[
                    _github_issue(199813, "open"),
                    _github_issue(201644, "open"),
                ],
            ) as get_issue,
            patch("analytics.github_analyze.insert_clickhouse_rows") as insert,
        ):
            record_github_issue_state_steps(Repo(), "2.15.0", config, True)

        self.assertEqual(
            get_issue.call_args_list,
            [call("pytorch/pytorch", 199813), call("pytorch/pytorch", 201644)],
        )
        rows = insert.call_args.args[1]
        self.assertEqual([row["step_id"] for row in rows], ["1.6", "2.7", "5.1"])


class GithubIssueStateCli(TestCase):
    def test_release_runs_the_issue_state_dry_run(self):
        args = type(
            "Args",
            (),
            {
                "remote": "origin",
                "repo_path": "/tmp/pytorch",
                "in_flight": False,
                "analyze_stacks": False,
                "analyze_missing_reverts_from_branch": False,
                "write_to_clickhouse": False,
                "release": "2.15.0",
                "release_only_changes": False,
                "github_issue_state": True,
                "missing_in_branch": False,
                "missing_in_release": False,
            },
        )()
        with (
            patch.object(github_analyze, "parse_arguments", return_value=args),
            patch.object(github_analyze, "GitRepo") as repo,
            patch.object(github_analyze, "record_github_issue_state_steps") as record,
        ):
            github_analyze.main()

        record.assert_called_once()
        called_repo, release, config, write = record.call_args.args
        self.assertIs(called_repo, repo.return_value)
        self.assertEqual(release, "2.15.0")
        self.assertEqual(config["branch"], "release/2.15")
        self.assertFalse(write)


class GithubIssueStateInFlight(TestCase):
    def test_closed_milestones_keep_post_release_issue_state_current(self):
        with (
            patch("analytics.github_analyze.gh_get_milestones", return_value=[]),
            patch("analytics.github_analyze.releases_in_flight", return_value=[]),
            patch("analytics.github_analyze.releases_just_shipped", return_value=[]),
            patch(
                "analytics.github_analyze.recently_shipped_releases",
                return_value=["2.15.0"],
            ),
            patch("analytics.github_analyze.record_github_issue_state_steps") as record,
        ):
            self.assertTrue(github_analyze.analyze_releases_in_flight(object(), False))

        _, release, config, write = record.call_args.args
        self.assertEqual(release, "2.15.0")
        self.assertEqual(config["branch"], "release/2.15")
        self.assertFalse(write)


class StepSummary(TestCase):
    def write(self, rows, written=True, extra=None, env=True):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.md"
            old = os.environ.pop("GITHUB_STEP_SUMMARY", None)
            if env:
                os.environ["GITHUB_STEP_SUMMARY"] = str(path)
            try:
                write_step_summary("Title", rows, written, extra)
            finally:
                os.environ.pop("GITHUB_STEP_SUMMARY", None)
                if old is not None:
                    os.environ["GITHUB_STEP_SUMMARY"] = old
            return path.read_text() if path.exists() else None

    ROW = {
        "release": "2.15.0",
        "step_id": "1.11",
        "status": "done",
        "evidence_text": "#1 [release 2.15] Apply | changes\nmerged",
        "evidence_url": "https://github.com/pytorch/pytorch/pull/1",
    }

    def test_a_table_of_the_steps_with_linked_evidence(self):
        text = self.write([self.ROW], True, ["- extra"])
        self.assertIn("## Title", text)
        self.assertIn("| Release | Step | Status | Evidence |", text)
        # one line, the pipe and the brackets escaped, linked to the evidence
        self.assertIn(
            "| 2.15.0 | 1.11 | ✅ done | "
            "[#1 \\[release 2.15\\] Apply \\| changes merged]"
            "(https://github.com/pytorch/pytorch/pull/1) |",
            text,
        )
        self.assertIn("Recorded in `misc.release_event`.", text)
        self.assertTrue(text.rstrip().endswith("- extra"))

    def test_a_run_that_does_not_write_says_so(self):
        text = self.write(
            [dict(self.ROW, status="in_progress", evidence_url="")], False
        )
        self.assertIn("🟡 in progress", text)
        self.assertIn("Not recorded", text)

    def test_nothing_is_written_without_rows_or_a_summary_file(self):
        self.assertIsNone(self.write([]))
        self.assertIsNone(self.write([self.ROW], env=False))


class MilestonePrStepRows(TestCase):
    def rows(self, statuses, branch_cut=True, released=False):
        return milestone_pr_step_rows(
            "2.15.0",
            "release/2.15",
            69,
            [{"id": "3.2"}],
            statuses,
            branch_cut,
            "0" * 40,
            "1-1",
            "https://github.com/pytorch/test-infra/actions/runs/1",
            datetime(2026, 10, 20, tzinfo=timezone.utc),
            released,
        )

    def test_every_closed_pr_on_the_branch_makes_the_step_done(self):
        (row,) = self.rows(
            [
                _milestone_item(1, "closed", "on_release_branch"),
                _milestone_item(2, "closed", "landed_before_cut"),
            ]
        )
        self.assertEqual((row["step_id"], row["status"]), ("3.2", "done"))
        self.assertEqual(row["check_type"], "milestone_prs_on_branch")
        self.assertEqual(row["blocking"], 0)
        self.assertEqual(
            row["evidence_text"],
            "All 2 closed PR(s) of milestone 2.15.0 are on release/2.15",
        )
        self.assertEqual(
            row["evidence_url"],
            "https://github.com/pytorch/pytorch/milestone/69?closed=1",
        )

    def test_a_closed_pr_that_is_not_on_the_branch_keeps_the_step_open(self):
        (row,) = self.rows(
            [
                _milestone_item(1, "closed", "on_release_branch"),
                _milestone_item(2, "closed", "not_on_release_branch"),
            ]
        )
        self.assertEqual(row["status"], "in_progress")
        self.assertEqual(
            row["evidence_text"],
            "1 closed PR(s) of milestone 2.15.0 not on release/2.15: #2",
        )
        details = json.loads(row["details"])
        self.assertEqual([m["number"] for m in details["missing"]], [2])
        self.assertEqual(
            details["by_reason"], {"on_release_branch": 1, "not_on_release_branch": 1}
        )

    def test_open_issues_are_not_looked_at_but_are_listed(self):
        # an [RFC], the release tracker and the validation issue stay open until the end
        (row,) = self.rows(
            [
                _milestone_item(1, "closed", "on_release_branch"),
                _milestone_item(190875, "open", "open", pull_request=False),
                _milestone_item(199813, "open", "open", pull_request=False),
            ]
        )
        self.assertEqual(row["status"], "done")
        details = json.loads(row["details"])
        self.assertEqual(
            [i["number"] for i in details["open_issues_not_checked"]], [190875, 199813]
        )
        self.assertEqual(details["pull_requests"], 1)

    def test_an_open_pr_is_not_a_closed_one(self):
        # open PRs are what the milestone check (3.1) holds the release for
        (row,) = self.rows([_milestone_item(5, "open", "open")])
        self.assertEqual(row["status"], "done")
        self.assertEqual(json.loads(row["details"])["closed_pull_requests"], 0)

    def test_before_the_branch_cut_there_is_nothing_to_check(self):
        (row,) = self.rows(
            [_milestone_item(1, "closed", "closed_before_cut")], branch_cut=False
        )
        self.assertEqual(row["status"], "todo")
        self.assertIn("is not cut yet", row["evidence_text"])

    def test_the_step_is_done_once_the_release_tag_exists(self):
        (row,) = self.rows(
            [_milestone_item(2, "closed", "not_on_release_branch")], released=True
        )
        self.assertEqual(row["status"], "done")
        self.assertEqual(
            row["evidence_text"],
            "Release tag v2.15.0 exists, so the step is done; "
            "1 closed PR(s) of milestone 2.15.0 not on release/2.15: #2",
        )


def _pr(number, title, state="closed", merged_at=None):
    return {
        "number": number,
        "title": title,
        "state": state,
        "merged_at": merged_at,
        "html_url": f"https://github.com/pytorch/pytorch/pull/{number}",
    }


class ReleaseOnlyChanges(TestCase):
    TITLE = "[release 2.15] Apply Release only changes to 2.15 branch"

    def rows(self, prs):
        return release_only_changes_step_rows(
            "2.15.0",
            "release/2.15",
            "pytorch/pytorch",
            [{"id": "1.11"}],
            prs,
            "0" * 40,
            "1-1",
            "https://github.com/pytorch/test-infra/actions/runs/1",
            datetime(2026, 10, 6, tzinfo=timezone.utc),
        )

    def test_a_merged_pr_makes_the_step_done(self):
        (row,) = self.rows([_pr(199819, self.TITLE, "closed", "2026-10-05T21:55:46Z")])
        self.assertEqual((row["step_id"], row["status"]), ("1.11", "done"))
        self.assertEqual(row["check_type"], "release_only_changes")
        self.assertEqual(row["blocking"], 0)
        self.assertEqual(row["rc"], "")
        self.assertEqual(
            row["evidence_url"], "https://github.com/pytorch/pytorch/pull/199819"
        )
        self.assertIn("#199819", row["evidence_text"])
        self.assertIn("2026-10-05", row["evidence_text"])
        details = json.loads(row["details"])
        self.assertEqual(details["branch"], "release/2.15")
        self.assertEqual(details["pull_requests"][0]["number"], 199819)

    def test_an_open_pr_keeps_the_step_in_progress(self):
        (row,) = self.rows([_pr(5, self.TITLE, "open")])
        self.assertEqual(row["status"], "in_progress")
        self.assertIn("is open", row["evidence_text"])
        self.assertEqual(
            row["evidence_url"], "https://github.com/pytorch/pytorch/pull/5"
        )

    def test_a_pr_closed_without_merging_keeps_the_step_in_progress(self):
        (row,) = self.rows([_pr(5, self.TITLE, "closed", None)])
        self.assertEqual(row["status"], "in_progress")
        self.assertIn("closed without merging", row["evidence_text"])

    def test_a_merged_pr_wins_over_an_earlier_closed_one(self):
        (row,) = self.rows(
            [
                _pr(5, self.TITLE, "closed", None),
                _pr(6, self.TITLE, "closed", "2026-10-05T21:55:46Z"),
            ]
        )
        self.assertEqual(row["status"], "done")
        self.assertIn("#6", row["evidence_text"])
        self.assertEqual(len(json.loads(row["details"])["pull_requests"]), 2)

    def test_no_pr_yet_links_to_the_pulls_of_the_branch(self):
        (row,) = self.rows([])
        self.assertEqual(row["status"], "in_progress")
        self.assertEqual(
            row["evidence_text"], "no release-only changes PR into release/2.15 yet"
        )
        self.assertEqual(
            row["evidence_url"],
            "https://github.com/pytorch/pytorch/pulls?q=is%3Apr+base%3Arelease/2.15",
        )

    def test_the_pulls_of_the_branch_are_filtered_by_title(self):
        pulls = [
            _pr(1, "[release 2.15] Cherry pick something"),
            _pr(2, "[RELEASE 2.10] Release only changes"),
            _pr(3, self.TITLE),
        ]
        with patch(
            "analytics.github_analyze.fetch_multipage_json", return_value=pulls
        ) as fetch:
            found = find_release_only_changes_prs(
                "pytorch/pytorch", "release/2.15", "(?i)release[- ]only changes"
            )
        self.assertEqual([pr["number"] for pr in found], [2, 3])
        url, params = fetch.call_args.args
        self.assertEqual(url, "https://api.github.com/repos/pytorch/pytorch/pulls")
        self.assertEqual(params["base"], "release/2.15")
        self.assertEqual(params["state"], "all")


if __name__ == "__main__":
    main()
