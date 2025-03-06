import json
from re import M
import unittest
from unittest import mock
from unittest.mock import MagicMock
from typing import Any, Dict
from run_on_aws_devicefarm import ReportProcessor, download_artifact


class MockS3Client:
    def __init__(self):
        self.mock_aws_client = MagicMock()

    def getMockClient(self) -> MagicMock:
        return self.mock_aws_client


class MockDeviceFarmClient:
    def __init__(self):
        self.mock_aws_client = MagicMock()
        self.mock_aws_client.list_jobs.return_value = self.mockJobs()
        self.mock_aws_client.list_suites.return_value = self.mockSuites()
        self.mock_aws_client.list_tests.return_value = self.mockTests()
        self.mock_aws_client.list_artifacts.return_value = {
            "artifacts": [
                {
                    "type": "LOGS",
                    "name": "logs",
                    "extension": "test",
                    "arn": "arn-artifact1",
                    "url": "url-artifact1",
                },
                {
                    "type": "TESTSPEC_OUTPUT",
                    "name": "test spec output",
                    "extension": "output",
                    "arn": "arn-artifact2",
                    "url": "url-artifact2",
                },
            ]
        }

    def getMockClient(self) -> MagicMock:
        return self.mock_aws_client

    def mockTests(self) -> Any:
        return {
            "tests": [
                {
                    "arn": "arn-test1",
                    "name": "Setup Test",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 1,
                        "passed": 1,
                        "failed": 0,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                    "message": "Successful test lifecycle of Setup Test",
                }
            ],
            "ResponseMetadata": {},
        }

    def mockSuites(self):
        return {
            "suites": [
                {
                    "arn": "arn-suite1",
                    "name": "Setup Suite",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 1,
                        "passed": 1,
                        "failed": 0,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                    "message": "Successful",
                },
                {
                    "arn": "arn-suite2",
                    "name": "Tests Suite",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 1,
                        "passed": 1,
                        "failed": 0,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                    "message": "Tests passed",
                },
                {
                    "arn": "arn-suite3",
                    "name": "Teardown Suite",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 1,
                        "passed": 1,
                        "failed": 0,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                },
            ],
            "ResponseMetadata": {},
        }

    def mockJobs(self):
        return {
            "jobs": [
                {
                    "arn": "arn-job1",
                    "name": "Apple iPhone 15",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 3,
                        "passed": 3,
                        "failed": 0,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                    "message": "fake1",
                    "device": {
                        "arn": "device:00",
                        "name": "Apple iPhone 15",
                        "manufacturer": "Apple",
                        "model": "Apple iPhone 15",
                        "modelId": "A2846",
                        "formFactor": "PHONE",
                        "platform": "IOS",
                        "os": "18.0",
                    },
                },
                {
                    "arn": "arn-job2",
                    "name": "Apple iPhone 15 Pro",
                    "status": "COMPLETED",
                    "result": "PASSED",
                    "counters": {
                        "total": 3,
                        "passed": 2,
                        "failed": 1,
                        "warned": 0,
                        "errored": 0,
                        "stopped": 0,
                        "skipped": 0,
                    },
                    "message": "fake1",
                    "device": {
                        "arn": "device:00",
                        "name": "Apple iPhone 15",
                        "model": "Apple iPhone 15 Pro",
                        "modelId": "A2222",
                        "formFactor": "PHONE",
                        "platform": "IOS",
                        "os": "17.7",
                    },
                },
            ]
        }

class Test(unittest.TestCase):
    @mock.patch("run_on_aws_devicefarm.download_artifact")
    def test_reportProcessor(self, download_artifact_mock):
        m_df = MockDeviceFarmClient()
        m_s3 = MockS3Client()
        fakeReport = {
            "name": "test",
            "arn": "arn-run-report",
            "status": "COMPLETED",
            "result": "PASSED",
            "counters": {"total": 3, "passed": 3, "failed": 0, "warned": 0},
        }
        processor = ReportProcessor(
            m_df.getMockClient(), m_s3.getMockClient(), "IOS", "wf1", 1
        )
        artifacts = processor.start(fakeReport)

        m_df.getMockClient().list_jobs.assert_called_once()
        self.assertEqual(m_df.getMockClient().list_suites.call_count, 2)
        self.assertEqual(m_df.getMockClient().list_tests.call_count, 6)
        self.assertEqual(m_s3.getMockClient().upload_file.call_count, 36)
        self.assertEqual(len(artifacts), 36)

        print("yang",artifacts[0])

    @mock.patch("run_on_aws_devicefarm.download_artifact")
    def test_reportProcessor_debug(self, download_artifact_mock):

        m_df = MockDeviceFarmClient()
        m_s3 = MockS3Client()
        fakeReport = {
            "name": "test",
            "arn": "arn-run-report",
            "status": "COMPLETED",
            "result": "PASSED",
            "counters": {"total": 3, "passed": 3, "failed": 0, "warned": 0},
        }
        processor = ReportProcessor(
            m_df.getMockClient(), m_s3.getMockClient(), "IOS", "wf1", 1, True
        )
        artifacts = processor.start(fakeReport)

        m_df.getMockClient().list_jobs.assert_called_once()
        self.assertEqual(m_df.getMockClient().list_suites.call_count, 2)
        self.assertEqual(m_df.getMockClient().list_tests.call_count, 6)
        self.assertEqual(len(artifacts), 36)

        self.assertEqual(m_s3.getMockClient().upload_file.call_count, 0)


if __name__ == "__main__":
    unittest.main()
