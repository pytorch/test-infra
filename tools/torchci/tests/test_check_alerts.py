import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest import main, TestCase
from unittest.mock import MagicMock, patch

from torchci.check_alerts import (
    check_for_no_flaky_tests_alert,
    fetch_alerts_filter,
    filter_job_names,
    gen_update_comment,
    generate_no_flaky_tests_issue,
    handle_flaky_tests_alert,
    JobData,
    JobGroup,
    JobStatus,
    PYTORCH_ALERT_LABEL,
    SOFT_COMMENT_THRESHOLD,
)
from torchci.queue_alert import QueueInfo, queuing_alert


JOB_NAME = "periodic / linux-xenial-cuda10.2-py3-gcc7-slow-gradcheck / test (default, 2, 2, linux.4xlarge.nvidia.gpu)"


def get_pending_job_data():
    """
    Returns a JobData object representing a pending job.
    This is used to simulate a job that is still in progress.
    """
    return JobData(
        "dummy name",
        {
            "conclusion": "pending",
        },
    )


def get_success_job_group():
    """
    Returns a JobGroup object representing a successful job.
    This is used to simulate a job that has completed successfully.
    """
    return JobGroup([get_success_job_data()])


def get_success_job_data():
    """
    Returns a JobData object representing a successful job.
    This is used to simulate a job that has completed successfully.
    """
    return JobData(
        "dummy name",
        {
            "conclusion": "success",
        },
    )


def get_pending_job_group():
    """
    Returns a JobGroup object representing a pending job.
    This is used to simulate a job that is still in progress.
    """
    return JobGroup([get_pending_job_data()])


MOCK_TEST_DATA = [
    JobGroup([JobData("dummy name", x)])
    for x in [
        {
            "sha": "f02f3046571d21b48af3067e308a1e0f29b43af9",
            "id": 7819529276,
            "conclusion": "failure",
            "htmlUrl": "https://github.com/pytorch/pytorch/runs/7819529276?check_suite_focus=true",
            "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/7819529276",
            "durationS": 14876,
            "failureLines": ["##[error]The action has timed out."],
            "failureContext": "",
            "failureCaptures": ["##[error]The action has timed out."],
            "failureLineNumbers": [83818],
            "repo": "pytorch/pytorch",
        },
        {
            "sha": "d0d6b1f2222bf90f478796d84a525869898f55b6",
            "id": 7818399623,
            "conclusion": "failure",
            "htmlUrl": "https://github.com/pytorch/pytorch/runs/7818399623?check_suite_focus=true",
            "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/7818399623",
            "durationS": 14882,
            "failureLines": ["##[error]The action has timed out."],
            "failureContext": "",
            "failureCaptures": ["##[error]The action has timed out."],
            "failureLineNumbers": [72821],
            "repo": "pytorch/pytorch",
        },
    ]
]
ANOTHER_MOCK_TEST_DATA = [
    JobGroup([JobData("dummy name", x)])
    for x in [
        {
            "sha": "2936c8b9ce4ef4d81cc3fe6e43531cb440209c61",
            "id": 4364234624,
            "conclusion": "failure",
            "htmlUrl": "https://github.com/pytorch/pytorch/runs/4364234624?check_suite_focus=true",
            "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/4364234624",
            "durationS": 14342,
            "failureLines": ["##[error]An unique error here."],
            "failureContext": "",
            "failureCaptures": ["##[error]An unique error here."],
            "failureLineNumbers": [12345],
            "repo": "pytorch/pytorch",
        },
    ]
]


def mock_fetch_alerts(*args, **kwargs):
    """
    Return the mock JSON response when trying to fetch all existing alerts
    """

    class MockResponse:
        def __init__(self, json_data, status_code):
            self.text = json_data
            self.status_code = status_code

        def raise_for_status(self):
            pass

    response = {
        "data": {
            "repository": {
                "issues": {
                    "nodes": [
                        {
                            "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch main",
                            "closed": False,
                            "number": 3763,
                            "body": "",
                            "comments": {"nodes": []},
                        },
                        {
                            "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch nightly",
                            "closed": False,
                            "number": 3764,
                            "body": "",
                            "comments": {"nodes": []},
                        },
                    ]
                }
            }
        }
    }
    return MockResponse(json.dumps(response), 200)


class TestGitHubPR(TestCase):
    # Should fail when jobs are ? ? Fail Fail
    def test_alert(self) -> None:
        status = JobStatus(
            JOB_NAME,
            [get_pending_job_group()] + [get_pending_job_group()] + MOCK_TEST_DATA,
        )
        self.assertTrue(status.should_alert())

    # Shouldn't alert when a newer job has already succeeded
    def test_no_alert_when_cleared(self) -> None:
        cases = [
            JobStatus(
                JOB_NAME,
                [get_success_job_group()] + [get_pending_job_group()] + MOCK_TEST_DATA,
            ),
            JobStatus(
                JOB_NAME,
                [get_pending_job_group()] + [get_success_job_group()] + MOCK_TEST_DATA,
            ),
        ]
        for case in cases:
            self.assertFalse(case.should_alert())

    # Shouldn't alert when jobs are Fail Success Fail
    def test_no_alert_when_not_consecutive(self) -> None:
        status = JobStatus(
            JOB_NAME,
            [MOCK_TEST_DATA[0]] + [get_success_job_group()] + [MOCK_TEST_DATA[1]],
        )
        self.assertFalse(status.should_alert())

    # Should alert when the middle job is not yet done Fail ? Fail
    def test_alert_when_pending_job(self) -> None:
        status = JobStatus(
            JOB_NAME,
            [MOCK_TEST_DATA[0]] + [get_pending_job_group()] + [MOCK_TEST_DATA[1]],
        )
        self.assertTrue(status.should_alert())

    def test_update_comment_empty(self):
        jobs = [JobStatus("job1", [{}]), JobStatus("job2", [{}])]
        original_issue: Dict[str, Any] = {"closed": False}  # type: ignore[annotation-unchecked]
        original_issue["body"] = "- [job1](a)\n- [job2](a)"
        update_comment = gen_update_comment(original_issue, jobs)
        self.assertFalse(update_comment)

        jobs = [JobStatus("job1", [{}]), JobStatus("job2", [{}])]
        original_issue["body"] = "- [job1](a)"
        update_comment = gen_update_comment(original_issue, jobs)
        self.assertTrue("started failing" in update_comment)
        self.assertTrue("job2" in update_comment)

        jobs = [JobStatus("job1", [{}])]
        original_issue["body"] = "- [job1](a)\n- [job2](a)"
        update_comment = gen_update_comment(original_issue, jobs)
        self.assertTrue("stopped failing" in update_comment)
        self.assertTrue("job2" in update_comment)

    def test_generate_no_flaky_tests_issue(self):
        issue = generate_no_flaky_tests_issue()
        self.assertListEqual(issue["labels"], ["no-flaky-tests-alert"])

    @patch("torchci.check_alerts.create_issue")
    @patch("torchci.check_alerts.datetime")
    @patch("torchci.check_alerts.get_num_issues_with_label")
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

        # No open alert issues, but also there are some flaky tests
        res = handle_flaky_tests_alert([], dry_run=True)
        self.assertIsNone(res)

        existing_alerts = [
            {"createdAt": "2022-10-10T13:41:09Z"},
            {"createdAt": "2022-10-08T14:41:09Z"},
        ]

        # Open alert issue, and there are some flaky tests
        res = handle_flaky_tests_alert(existing_alerts, dry_run=True)
        self.assertIsNone(res)

        # No open alert issue, and no flaky tests
        mock_get_num_issues_with_label.return_value = 0
        res = handle_flaky_tests_alert([], dry_run=True)
        self.assertDictEqual(res, mock_issue)

        # Open alert issue, and no flaky tests
        mock_get_num_issues_with_label.return_value = 0
        res = handle_flaky_tests_alert(existing_alerts, dry_run=True)
        self.assertIsNone(res)

    @patch("torchci.check_alerts.fetch_alerts")
    @patch("torchci.check_alerts.handle_flaky_tests_alert")
    def test_check_for_no_flaky_tests_alert(
        self,
        mock_handle_flaky_tests_alert,
        mock_fetch_alerts,
    ):
        # Issue is open but created too long ago
        mock_fetch_alerts.return_value = [
            {
                "closed": False,
                "createdAt": (
                    datetime.now(timezone.utc) - timedelta(days=7.1)
                ).isoformat(),
            }
        ]
        check_for_no_flaky_tests_alert("dummy repo", "dummy branch")
        first_argument = mock_handle_flaky_tests_alert.call_args.args[0]
        self.assertListEqual(first_argument, [])

        # Issue is open and recent
        mock_fetch_alerts.return_value = [
            {
                "closed": False,
                "createdAt": (
                    datetime.now(timezone.utc) - timedelta(days=6.9)
                ).isoformat(),
            }
        ]
        check_for_no_flaky_tests_alert("dummy repo", "dummy branch")
        first_argument = mock_handle_flaky_tests_alert.call_args.args[0]
        self.assertDictEqual(first_argument[0], mock_fetch_alerts.return_value[0])

        # Issue is closed and recent
        mock_fetch_alerts.return_value = [
            {
                "closed": True,
                "createdAt": (
                    datetime.now(timezone.utc) - timedelta(days=6.9)
                ).isoformat(),
            }
        ]
        check_for_no_flaky_tests_alert("dummy repo", "dummy branch")
        first_argument = mock_handle_flaky_tests_alert.call_args.args[0]
        self.assertListEqual(first_argument, [])

    # test filter job names
    def test_job_filter(self):
        job_names = [
            "pytorch_linux_xenial_py3_6_gcc5_4_test",
            "pytorch_linux_xenial_py3_6_gcc5_4_test2",
        ]
        self.assertListEqual(
            filter_job_names(job_names, ""),
            job_names,
            "empty regex should match all jobs",
        )
        self.assertListEqual(filter_job_names(job_names, ".*"), job_names)
        self.assertListEqual(filter_job_names(job_names, ".*xenial.*"), job_names)
        self.assertListEqual(
            filter_job_names(job_names, ".*xenial.*test2"),
            ["pytorch_linux_xenial_py3_6_gcc5_4_test2"],
        )
        self.assertListEqual(filter_job_names(job_names, ".*xenial.*test3"), [])
        self.assertRaises(
            Exception,
            lambda: filter_job_names(job_names, "["),
            msg="malformed regex should throw exception",
        )

    def test_builder_job_filter(self):
        job_names = [
            "cron / nightly / win / wheel-py3_8-cuda11_8 / wheel-py3_8-cuda11_8",
            "cron / release / linux / conda-py3_10-cpu / conda-py3_10-cpu",
            "Validate Nightly PyPI Wheel Binary Size / nightly-pypi-binary-size-validation",
            "Build libtorch docker images / build-docker-cuda (11.8)"
            "Validate binaries / linux",
        ]
        self.assertListEqual(
            filter_job_names(
                job_names, ".*nightly.pypi.binary.size.validation|cron / release /"
            ),
            [
                "cron / release / linux / conda-py3_10-cpu / conda-py3_10-cpu",
                "Validate Nightly PyPI Wheel Binary Size / nightly-pypi-binary-size-validation",
            ],
        )

    @patch("requests.post", side_effect=mock_fetch_alerts)
    def test_fetch_alert(self, mocked_alerts):
        cases: List[Dict[str, Any]] = [  # type: ignore[annotation-unchecked]
            {
                "repo": "pytorch/builder",
                "branch": "main",
                "expected": [],
            },
            {
                "repo": "pytorch/pytorch",
                "branch": "main",
                "expected": [
                    {
                        "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch main",
                        "closed": False,
                        "number": 3763,
                        "body": "",
                        "comments": {"nodes": []},
                    },
                ],
            },
            {
                "repo": "pytorch/pytorch",
                "branch": "nightly",
                "expected": [
                    {
                        "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch nightly",
                        "closed": False,
                        "number": 3764,
                        "body": "",
                        "comments": {"nodes": []},
                    },
                ],
            },
        ]

        for case in cases:
            alerts = fetch_alerts_filter(
                repo=case["repo"],
                branch=case["branch"],
                labels=PYTORCH_ALERT_LABEL,
            )
            self.assertListEqual(alerts, case["expected"])


class TestQueueAlert(TestCase):
    @patch("torchci.queue_alert.update_issue")
    @patch("torchci.queue_alert.create_issue")
    @patch("torchci.queue_alert.close_if_too_many_comments")
    @patch("torchci.queue_alert.fetch_alerts")
    @patch("torchci.queue_alert.filter_long_queues")
    @patch("torchci.queue_alert.requests.get")
    def test_close_if_too_many_comments(
        self, mock_get, mock_filter, mock_fetch, mock_close, mock_create, mock_update
    ):
        # Test that we can close an issue if it has too many comments and open a
        # new one

        # Setup mock response for API calls
        mock_get_response = MagicMock()
        mock_get_response.json.return_value = [{"mock": "data"}]
        mock_get.return_value = mock_get_response

        # Setup that we have queues that need an alert
        queue_info = QueueInfo("linux.gpu.nvidia", 100, 5.0)
        mock_filter.return_value = [queue_info]

        # Setup scenario: we have an alert but it has too many comments
        existing_issue = {
            "number": 123,
            "closed": False,
            "body": "- linux.gpu.nvidia, 80 machines, 4.5 hours",
            "comments": {"totalCount": SOFT_COMMENT_THRESHOLD + 1},
        }
        mock_fetch.return_value = [existing_issue]

        # Make close_if_too_many_comments return True to simulate closing
        mock_close.return_value = True

        # Setup create_issue to return a new issue
        new_issue = {"number": 456, "closed": False, "body": ""}
        mock_create.return_value = new_issue

        # Run the function under test
        queuing_alert(dry_run=False)

        # Verify we closed the old issue and created a new one
        mock_close.assert_called_with(existing_issue, False)
        mock_create.assert_called_once()
        mock_update.assert_called_once()


if __name__ == "__main__":
    main()
