from unittest import TestCase, main, mock
from typing import Any, List, Dict
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
    "Create Release"
]

required_workflows = ["pull", "trunk", "lint", "linux-binary", "windows-binary"]


def set_workflow_job_status(workflow: List[Dict[str, Any]], name: str, status: str) -> List[Dict[str, Any]]:
    for check in workflow:
        if check['workflowName'] == name:
            check['conclusion'] = status
    return workflow


class TestChecks:
    def make_test_checks(self) -> List[Dict[str, Any]]:
        workflow_checks = []
        for i in range(len(workflow_names)):
            workflow_checks.append(WorkflowCheck(
                workflowName=workflow_names[i],
                name="test/job",
                jobName="job",
                conclusion="success",
            )._asdict())
        return workflow_checks


class TestPrintCommits(TestCase):
    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_all_successful(self, mock_get_commit_results: Any) -> None:
        """Test with workflows are successful"""
        workflow_checks = mock_get_commit_results()
        self.assertTrue(is_green("sha", workflow_checks, required_workflows)[0])

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_necessary_successful(self, mock_get_commit_results: Any) -> None:
        """Test with necessary workflows are successful"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, workflow_names[8], "failed")
        workflow_checks = set_workflow_job_status(workflow_checks, workflow_names[9], "failed")
        workflow_checks = set_workflow_job_status(workflow_checks, workflow_names[10], "failed")
        workflow_checks = set_workflow_job_status(workflow_checks, workflow_names[11], "failed")
        workflow_checks = set_workflow_job_status(workflow_checks, workflow_names[12], "failed")
        self.assertTrue(is_green("sha", workflow_checks, required_workflows)[0])

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_necessary_skipped(self, mock_get_commit_results: Any) -> None:
        """Test with necessary job (ex: pull) skipped"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "pull", "skipped")
        result = is_green("sha", workflow_checks, required_workflows)
        self.assertTrue(result[0])

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_skippable_skipped(self, mock_get_commit_results: Any) -> None:
        """Test with skippable jobs (periodic and docker-release-builds skipped"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "periodic", "skipped")
        workflow_checks = set_workflow_job_status(workflow_checks, "docker-release-builds", "skipped")
        self.assertTrue(is_green("sha", workflow_checks, required_workflows))

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_necessary_failed(self, mock_get_commit_results: Any) -> None:
        """Test with necessary job (ex: Lint) failed"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "Lint", "failed")
        result = is_green("sha", workflow_checks, required_workflows)
        self.assertFalse(result[0])
        self.assertEqual(result[1], "Lint checks were not successful")

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value=TestChecks().make_test_checks())
    def test_skippable_failed(self, mock_get_commit_results: Any) -> None:
        """Test with failing skippable jobs (ex: docker-release-builds) should pass"""
        workflow_checks = mock_get_commit_results()
        workflow_checks = set_workflow_job_status(workflow_checks, "periodic", "skipped")
        workflow_checks = set_workflow_job_status(workflow_checks, "docker-release-builds", "failed")
        result = is_green("sha", workflow_checks, required_workflows)
        self.assertTrue(result[0])

    @mock.patch('tools.scripts.fetch_latest_green_commit.get_commit_results', return_value={})
    def test_no_workflows(self, mock_get_commit_results: Any) -> None:
        """Test with missing workflows"""
        workflow_checks = mock_get_commit_results()
        result = is_green("sha", workflow_checks, required_workflows)
        self.assertFalse(result[0])
        self.assertEqual(result[1], "missing required workflows: pull, trunk, lint, linux-binary, windows-binary")


if __name__ == "__main__":
    """
    The tests were migrated from the pytorch/pytorch repo -
    https://github.com/pytorch/pytorch/blob/master/.github/scripts/test_fetch_latest_green_commit.py
    """
    main()
