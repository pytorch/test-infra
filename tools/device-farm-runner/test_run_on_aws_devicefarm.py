import copy
import json
import unittest
from re import M
from typing import Any, Dict
from unittest import mock
from unittest.mock import MagicMock

from run_on_aws_devicefarm import download_artifact, ReportProcessor


class MockS3Client:
    def __init__(self):
        self.mock_aws_client = MagicMock()
        self.mock_aws_client.upload_file.return_value = None

    def getMockClient(self) -> MagicMock:
        return self.mock_aws_client


class MockDeviceFarmClient:
    def __init__(self):
        self.mock_aws_client = MagicMock()
        self.mock_aws_client.list_jobs.return_value = self.mockJobs()
        self.mock_aws_client.list_suites.return_value = self.mockSuites()
        self.mock_aws_client.list_tests.return_value = self.mockTests()
        self.mock_aws_client.list_artifacts.side_effect = (
            lambda arn, type: self.getArtifacts(arn, type)
        )

    def getMockClient(self) -> MagicMock:
        return self.mock_aws_client

    def getArtifacts(self, arn: str, type: str):
        if type == "FILE":
            return {
                "artifacts": [
                    {
                        "type": "TESTSPEC_OUTPUT",
                        "name": "test spec output",
                        "extension": "output",
                        "arn": "arn-artifact1",
                        "url": "url-artifact1",
                    },
                ]
            }
        elif type == "LOG":
            return {
                "artifacts": [
                    {
                        "type": "LOG",
                        "name": "test log",
                        "extension": "output",
                        "arn": "arn-artifact2",
                        "url": "url-artifact2",
                    },
                ]
            }
        else:
            return {
                "artifacts": [
                    {
                        "type": "VIDEO",
                        "name": "test video",
                        "extension": "output",
                        "arn": "arn-artifac3",
                        "url": "url-artifact3",
                    },
                ]
            }

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
                    "result": "FAILED",
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
            ],
            "ResponseMetadata": {},
        }

    def mockJobs(self):
        return {
            "jobs": [
                {
                    "arn": "arn-job-1",
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
                    "arn": "arn-job-2",
                    "name": "Apple iPhone 17 Pro",
                    "status": "FAILED",
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
                        "os": "11.0",
                    },
                },
            ]
        }


class Test(unittest.TestCase):
    @mock.patch("run_on_aws_devicefarm.download_artifact")
    def test_reportProcessor_when_happyFlow_then_returnArtifacts(
        self, download_artifact_mock
    ):
        # setup
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

        # execute
        artifacts = processor.start(fakeReport)

        # assert aws client calls
        expectedNumArtifacts = 12
        m_df.getMockClient().list_jobs.assert_called_once()
        self.assertGreaterEqual(m_df.getMockClient().list_suites.call_count, 2)
        self.assertGreaterEqual(
            m_s3.getMockClient().upload_file.call_count, expectedNumArtifacts
        )

        # assert artifacts
        self.assertGreaterEqual(len(artifacts), expectedNumArtifacts)

        job1_artifacts = [
            artifact for artifact in artifacts if artifact.get("job_arn") == "arn-job-1"
        ]
        a1 = job1_artifacts[0]
        self.assertEqual(a1["app_type"], "IOS")
        self.assertEqual(a1["job_arn"], "arn-job-1")
        self.assertEqual(a1["job_conclusion"], "PASSED")
        self.assertEqual(a1["job_name"], "Apple iPhone 15")
        self.assertEqual(a1["os"], "18.0")
        self.assertEqual(a1["name"], "test spec output")

        job2_artifacts = [
            artifact for artifact in artifacts if artifact["job_arn"] == "arn-job-2"
        ]
        a2 = job2_artifacts[0]
        self.assertEqual(a2["app_type"], "IOS")
        self.assertEqual(a2["job_arn"], "arn-job-2")
        self.assertEqual(a2["job_conclusion"], "PASSED")
        self.assertEqual(a2["job_name"], "Apple iPhone 17 Pro")
        self.assertEqual(a2["os"], "11.0")
        self.assertEqual(a2["name"], "test spec output")

    @mock.patch("run_on_aws_devicefarm.download_artifact")
    def test_reportProcessor_when_enableDebugMode_then_noArtifactsAreUploaded(
        self, download_artifact_mock
    ):
        # setup
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

        # execute
        artifacts = processor.start(fakeReport)

        # assert aws client calls
        expectedNumArtifacts = 12
        m_df.getMockClient().list_jobs.assert_called_once()
        self.assertGreaterEqual(download_artifact_mock.call_count, expectedNumArtifacts)
        self.assertGreaterEqual(len(artifacts), expectedNumArtifacts)

        self.assertEqual(m_s3.getMockClient().upload_file.call_count, 0)

    def test_reportProcessor_when_hasEmptyReportInput_then_returnEmptyList(self):
        # setup
        m_df = MockDeviceFarmClient()
        m_s3 = MockS3Client()
        fakeReport = {}
        processor = ReportProcessor(
            m_df.getMockClient(), m_s3.getMockClient(), "IOS", "wf1", 1, True
        )

        # execute
        artifacts = processor.start(fakeReport)

        # assert
        self.assertEqual(m_df.getMockClient().list_jobs.call_count, 0)
        self.assertEqual(len(artifacts), 0)

    def test_reportProcessor_when_missingArnInReportInput_then_returnEmptyList(self):
        # setup
        m_df = MockDeviceFarmClient()
        m_s3 = MockS3Client()
        fakeReport = {
            "status": "COMPLETED",
            "result": "PASSED",
        }
        processor = ReportProcessor(
            m_df.getMockClient(), m_s3.getMockClient(), "IOS", "wf1", 1
        )

        # execute
        artifacts = processor.start(fakeReport)

        # assert
        self.assertEqual(m_df.getMockClient().list_jobs.call_count, 0)
        self.assertEqual(len(artifacts), 0)


if __name__ == "__main__":
    unittest.main()
