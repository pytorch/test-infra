import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import main, TestCase


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from datetime import datetime, timezone

from analytics.github_analyze import (  # noqa: E402
    GitRepo,
    release_in_preparation,
    releases_in_flight,
    revert_step_rows,
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
        self.assertIn("2 other revert(s)", row["evidence_text"])
        self.assertEqual(len(json.loads(row["details"])["reverts"]), 2)

    def test_the_details_list_every_revert_with_those_to_act_on_first(self):
        (row,) = self.rows(
            [
                _revert("in_release_candidate", 11, ["v2.15.0-rc3"]),
                _revert("not_needed"),
            ]
        )
        details = json.loads(row["details"])
        self.assertEqual(details["reverts_on_main_not_on_branch"], 2)
        self.assertEqual(
            details["by_status"], {"in_release_candidate": 1, "not_needed": 1}
        )
        self.assertEqual(
            [r["status"] for r in details["reverts"]],
            ["in_release_candidate", "not_needed"],
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


if __name__ == "__main__":
    main()
