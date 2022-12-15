from datetime import datetime
from unittest import main, TestCase
from unittest.mock import patch

from check_alerts import (
    generate_no_flaky_tests_issue,
    handle_flaky_tests_alert,
    JobStatus,
)


job_name = "periodic / linux-xenial-cuda10.2-py3-gcc7-slow-gradcheck / test (default, 2, 2, linux.4xlarge.nvidia.gpu)"
disabled_job_name = "linux-focal-rocm5.3-py3.8-slow / test (slow, 1, 1, linux.rocm.gpu, rerun_disabled_tests)"
test_data = [
    {
        "sha": "f02f3046571d21b48af3067e308a1e0f29b43af9",
        "id": 7819529276,
        "conclusion": "failure",
        "htmlUrl": "https://github.com/pytorch/pytorch/runs/7819529276?check_suite_focus=true",
        "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/7819529276",
        "durationS": 14876,
        "failureLine": "##[error]The action has timed out.",
        "failureContext": "",
        "failureCaptures": ["##[error]The action has timed out."],
        "failureLineNumber": 83818,
        "repo": "pytorch/pytorch",
    },
    {
        "sha": "d0d6b1f2222bf90f478796d84a525869898f55b6",
        "id": 7818399623,
        "conclusion": "failure",
        "htmlUrl": "https://github.com/pytorch/pytorch/runs/7818399623?check_suite_focus=true",
        "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/7818399623",
        "durationS": 14882,
        "failureLine": "##[error]The action has timed out.",
        "failureContext": "",
        "failureCaptures": ["##[error]The action has timed out."],
        "failureLineNumber": 72821,
        "repo": "pytorch/pytorch",
    },
]


class TestGitHubPR(TestCase):
    # Should fail when jobs are ? ? Fail Fail
    def test_alert(self) -> None:
        status = JobStatus(job_name, [{}] + [{}] + test_data)
        self.assertTrue(status.should_alert())

    # Shouldn't alert when jobs are Success ? Fail Fail
    def test_no_alert_when_cleared(self) -> None:
        status = JobStatus(job_name, [{"conclusion": "success"}] + [{}] + test_data)
        self.assertFalse(status.should_alert())

    # Shouldn't alert when jobs are Fail Success Fail
    def test_no_alert_when_not_consecutive(self) -> None:
        status = JobStatus(
            job_name, [test_data[0]] + [{"conclusion": "success"}] + [test_data[1]]
        )
        self.assertFalse(status.should_alert())

    # No need to send alerts for some jobs
    def test_disabled_alert(self) -> None:
        status = JobStatus(disabled_job_name, [{}] + [{}] + test_data)
        self.assertFalse(status.should_alert())

    def test_generate_no_flaky_tests_issue(self):
        issue = generate_no_flaky_tests_issue()
        self.assertListEqual(issue["labels"], ["no-flaky-tests-alert"])

    @patch("check_alerts.create_issue")
    @patch("check_alerts.datetime")
    @patch("check_alerts.get_num_issues_with_label")
    def test_handle_flaky_tests_alert(
        self, mock_get_num_issues_with_label, mock_date, mock_create_issue
    ):
        mock_issue = {
            "title": "dummy-title",
            "labels": ["dummy-label"],
        }
        mock_create_issue.return_value = mock_issue
        mock_date.today.return_value = datetime(2022, 10, 10)
        mock_get_num_issues_with_label.return_value = 5

        res = handle_flaky_tests_alert([])
        self.assertIsNone(res)

        existing_alerts = [
            {"createdAt": "2022-10-10T13:41:09Z"},
            {"createdAt": "2022-10-08T14:41:09Z"},
        ]
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertIsNone(res)

        existing_alerts = [
            {"createdAt": "2022-10-09T13:41:09Z"},
            {"createdAt": "2022-10-08T14:41:09Z"},
        ]
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertIsNone(res)

        mock_get_num_issues_with_label.return_value = 0
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertDictEqual(res, mock_issue)


if __name__ == "__main__":
    main()
