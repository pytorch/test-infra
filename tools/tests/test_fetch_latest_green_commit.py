from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List
from unittest import main, mock, TestCase

from tools.scripts import fetch_latest_green_commit as updater
from tools.scripts.fetch_latest_green_commit import is_green, WorkflowCheck


workflow_names = [
    "pull",
    "trunk",
    "Lint",
    "linux-binary-libtorch-pre-cxx11",
    "android-tests",
    "windows-binary-wheel",
    "periodic",
    "docker-release-builds",
    "nightly",
    "pr-labels",
    "Close stale pull requests",
    "Update S3 HTML indices for download.pytorch.org",
    "Create Release",
    "Apple",
    "pull-test-sandbox",
]

# Matched with re.fullmatch: exact name ("lint" matches "Lint" via IGNORECASE)
# or explicit regex ("^Apple$"). "pull" must NOT match "pull-test-sandbox".
requires = ["pull", "trunk", "lint", "linux-binary-libtorch-pre-cxx11", "^Apple$"]


def set_workflow_job_status(
    workflow: List[Dict[str, Any]], name: str, status: str
) -> List[Dict[str, Any]]:
    for check in workflow:
        if check["workflowName"] == name:
            check["conclusion"] = status
    return workflow


class TestChecks:
    def make_test_checks(self) -> List[Dict[str, Any]]:
        workflow_checks = []
        for i in range(len(workflow_names)):
            workflow_checks.append(
                WorkflowCheck(
                    workflowName=workflow_names[i],
                    name="test/job",
                    jobName="job",
                    conclusion="success",
                )._asdict()
            )
        return workflow_checks


@mock.patch(
    "tools.scripts.fetch_latest_green_commit.fetch_unstable_issues",
    return_value=[],
)
class TestPrintCommits(TestCase):
    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_all_successful(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with workflows are successful"""
        workflow_checks = mock_get_commit_results()
        self.assertTrue(is_green("sha", requires, workflow_checks)[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_necessary_successful(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with necessary workflows are successful"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(
            workflow_checks, workflow_names[8], "failed"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, workflow_names[9], "failed"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, workflow_names[10], "failed"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, workflow_names[11], "failed"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, workflow_names[12], "failed"
        )
        self.assertTrue(is_green("sha", requires, workflow_checks)[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_necessary_skipped(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with necessary job (ex: pull) skipped"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "pull", "skipped")
        result = is_green("sha", requires, workflow_checks)
        self.assertTrue(result[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_skippable_skipped(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with skippable jobs (periodic and docker-release-builds skipped"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(
            workflow_checks, "periodic", "skipped"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, "docker-release-builds", "skipped"
        )
        self.assertTrue(is_green("sha", requires, workflow_checks)[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_necessary_failed(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with necessary job (ex: Lint) failed"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "Lint", "failed")
        result = is_green("sha", requires, workflow_checks)
        self.assertFalse(result[0])
        self.assertEqual(result[1], "Lint was not successful, test/job failed")

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_skippable_failed(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with failing skippable jobs (ex: docker-release-builds) should pass"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(
            workflow_checks, "periodic", "skipped"
        )
        workflow_checks = set_workflow_job_status(
            workflow_checks, "docker-release-builds", "failed"
        )
        result = is_green("sha", requires, workflow_checks)
        self.assertTrue(result[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results", return_value={}
    )
    def test_no_workflows(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """Test with missing workflows"""
        workflow_checks = mock_get_commit_results()
        result = is_green("sha", requires, workflow_checks)
        self.assertFalse(result[0])
        self.assertEqual(
            result[1],
            "missing required workflows: pull, trunk, lint, "
            "linux-binary-libtorch-pre-cxx11, ^Apple$",
        )

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_prefix_does_not_match(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """A required "pull" must not match "pull-test-sandbox"."""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(
            workflow_checks, "pull-test-sandbox", "failed"
        )
        result = is_green("sha", requires, workflow_checks)
        self.assertTrue(result[0])

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_regex_required_check(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """An explicit regex required check (ex: "^Apple$") still matches."""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "Apple", "failed")
        result = is_green("sha", requires, workflow_checks)
        self.assertFalse(result[0])
        self.assertEqual(result[1], "Apple was not successful, test/job failed")

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=[
            WorkflowCheck(
                workflowName="pull-test-sandbox",
                name="test/job",
                jobName="job",
                conclusion="success",
            )._asdict()
        ],
    )
    def test_prefix_success_does_not_satisfy(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """A prefix-named workflow does not satisfy an exact required check."""
        result = is_green("sha", ["pull"], mock_get_commit_results())
        self.assertFalse(result[0])
        self.assertEqual(result[1], "missing required workflows: pull")

    @mock.patch(
        "tools.scripts.fetch_latest_green_commit.get_commit_results",
        return_value=TestChecks().make_test_checks(),
    )
    def test_empty_required_check_ignored(
        self, mock_get_commit_results: Any, mock_fetch_unstable_issues: Any
    ) -> None:
        """An empty required-check entry is skipped, not left unsatisfiable."""
        workflow_checks = mock_get_commit_results()
        result = is_green("sha", requires + [""], workflow_checks)
        self.assertTrue(result[0])


@mock.patch.object(updater, "fetch_unstable_issues", return_value=[])
class TestRunSummary(TestCase):
    @staticmethod
    def check(
        sha: str, workflow: str, job: str, status: str, id_: int
    ) -> dict[str, Any]:
        return {
            "sha": sha,
            "workflowName": workflow,
            "name": f"{workflow} / {job}",
            "jobName": job,
            "conclusion": status,
            "htmlUrl": f"https://github.com/pytorch/executorch/actions/runs/{id_}/job/{id_}",
            "run_attempt": 2,
        }

    def test_all_blockers_and_conflicting_runs_in_one_summary(
        self, _unstable: Any
    ) -> None:
        rows = [
            self.check("abcd", "trunk", "VKML <linux>", "failure", 1),
            self.check("abcd", "trunk", "VKML <linux>", "success", 2),
            self.check("abcd", "pull", "unittest", "pending", 3),
            self.check("abcd", "Apple", "test", "cancelled", 4),
            self.check("abcd", "Lint", "lint", "success", 5),
            self.check("abcd", "Build documentation", "docs", "success", 6),
            self.check("abcd", "pull", "unstable job", "failure", 7),
            self.check("abcd", "periodic", "test", "failure", 8),
        ]
        required = [
            "pull",
            "lint",
            "trunk",
            "Build documentation",
            "^Apple$",
            "viable-strict-gate",
        ]
        self.assertEqual(
            is_green("abcd", required, rows),
            (False, "trunk was not successful, trunk / VKML <linux> failed"),
        )
        with TemporaryDirectory() as directory:
            path = Path(directory) / "summary.md"
            updater.write_run_summary(path, ["abcd", "ef01"], required, rows, None)
            summary = path.read_text(encoding="utf-8")
        self.assertEqual(summary.count("<details"), 2)
        head = summary.split("<details>", 1)[0]
        for expected in (
            "<code>abcd</code>",
            "<strong>failure</strong>",
            "<strong>pending</strong>",
            "<strong>cancelled</strong>",
            "missing required workflows: viable-strict-gate",
            "VKML &lt;linux&gt;",
            "/actions/runs/1/job/1",
            "/actions/runs/2/job/2",
            "(attempt 2); also passed:",
        ):
            self.assertIn(expected, head)
        self.assertNotIn("unstable job", summary)
        self.assertNotIn("periodic", summary)
        self.assertIn("<code>ef01</code>", summary)

    def test_overlapping_requirements_report_a_failed_job_once(
        self, _unstable: Any
    ) -> None:
        rows = [self.check("abcd", "trunk", "test", "failure", 1)]
        blockers = list(updater.iter_blockers(rows, ["trunk", "^trunk$", "lint"]))
        self.assertEqual(len(blockers), 2)
        self.assertEqual(blockers[0][1], rows[0])
        self.assertEqual(blockers[1], ("missing required workflows: lint", None))

    def test_unexpected_job_url_is_not_linked(self, _unstable: Any) -> None:
        row = self.check("abcd", "pull", "<unittest>", "failure", 1)
        row["htmlUrl"] = "https://example.invalid/actions/runs/1/job/1"
        self.assertEqual(
            updater.describe_check(row), "pull / &lt;unittest&gt; (attempt 2)"
        )

    def test_pytorch_selects_first_green_and_ignores_executorch_gate(
        self, _unstable: Any
    ) -> None:
        required = ["pull", "trunk", "lint", "docs-build"]
        rows = [self.check("abcd", "pull", "tests", "pending", 1)] + [
            self.check("ef01", workflow, "job", "success", i)
            for i, workflow in enumerate(required, start=2)
        ]
        commits = ["abcd", "ef01", "2345"]
        with redirect_stderr(StringIO()):
            selected = updater.get_latest_green_commit(commits, required, rows)
        self.assertEqual(selected, "ef01")
        with TemporaryDirectory() as directory:
            path = Path(directory) / "summary.md"
            updater.write_run_summary(path, commits, required, rows, selected)
            summary = path.read_text(encoding="utf-8")
        self.assertIn("Selected `ef01`", summary)
        self.assertIn("<code>abcd</code>", summary)
        self.assertNotIn("2345", summary)
        self.assertNotIn("viable-strict-gate", summary)

    def test_cli_writes_summary_without_changing_selected_sha(
        self, _unstable: Any
    ) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "summary.md"
            with (
                mock.patch.object(updater, "get_latest_commits", return_value=["abcd"]),
                mock.patch.object(
                    updater,
                    "query_commits",
                    return_value=[self.check("abcd", "pull", "test", "success", 1)],
                ) as query,
                mock.patch.object(
                    updater.sys, "argv", ["updater", "--required-checks", '["pull"]']
                ),
                mock.patch.dict(updater.os.environ, {"GITHUB_STEP_SUMMARY": str(path)}),
                redirect_stdout(StringIO()) as stdout,
                redirect_stderr(StringIO()),
            ):
                updater.main()
            self.assertEqual(stdout.getvalue(), "abcd\n")
            self.assertIn("Selected `abcd`", path.read_text(encoding="utf-8"))
            query.assert_called_once_with(["abcd"])

    def test_summary_failure_does_not_change_cli_result(self, _unstable: Any) -> None:
        with (
            mock.patch.object(updater, "get_latest_commits", return_value=["abcd"]),
            mock.patch.object(updater, "query_commits", return_value=[]),
            mock.patch.object(
                updater, "write_run_summary", side_effect=OSError
            ) as write,
            mock.patch.object(
                updater.sys, "argv", ["updater", "--required-checks", "pull"]
            ),
            mock.patch.dict(updater.os.environ, {"GITHUB_STEP_SUMMARY": "unused.md"}),
            redirect_stdout(StringIO()) as stdout,
            redirect_stderr(StringIO()) as stderr,
        ):
            updater.main()
        write.assert_called_once()
        self.assertEqual(stdout.getvalue(), "None\n")
        self.assertIn(
            "Could not write the viable/strict run summary", stderr.getvalue()
        )


if __name__ == "__main__":
    main()
