from unittest import TestCase, main
from check_alerts import JobStatus

job_name = "periodic / linux-xenial-cuda10.2-py3-gcc7-slow-gradcheck / test (default, 2, 2, linux.4xlarge.nvidia.gpu)"
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
        "failureCaptures": "##[error]The action has timed out.",
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
        "failureCaptures": "##[error]The action has timed out.",
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


if __name__ == "__main__":
    main()
