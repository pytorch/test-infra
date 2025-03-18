import unittest
import os
import gzip

from typing import Any, List, Tuple
from unittest.mock import patch
from oss_ci_job_queue_time.lambda_function import (
    lambda_handler,
    get_aws_s3_resource,
    get_clickhouse_client,
)


def get_default_result_rows(test_sample: str = "0"):
    """
    generate result rows for testing, this corrresponds to the following columns:
       'queue_s', 'repo', 'workflow_name', 'job_name', 'html_url', 'machine_type', 'time'
    """
    if (test_sample == "0"):
        return [
            (
                60000,
                "pytorch/pytorch",
                "workflow-name-1",
                "job-name-1",
                "runs/1/job/1",
                "linux.aws.h100",
                1742262372,
            ),
            (
                1400,
                "pytorch/pytorch",
                "workflow-name-2",
                "job-name-2",
                "runs/2/job/2",
                "linux.rocm.gpu.2",
                1742262372,
            )]

    return [
        (
            60000,
            "pytorch/pytorch",
            "inductor-h100",
            "test1 (h100, 5, 5, linux.aws.h100)",
            "runs/1/job/1",
            "linux.aws.h100",
            1742262372,
        ),
        (
            50000,
            "pytorch/pytorch",
            "inductor-h100",
            "test1 (h100, 5, 5, linux.aws.h100)",
            "runs/1/job/2",
            "linux.aws.h100",
            1742262372,
        ),
        (
            55000,
            "pytorch/pytorch",
            "inductor-h100",
            "test1 (h100, 2, 6, linux.aws.h100)",
            "runs/1/job/3",
            "linux.aws.h100",
            1742262372,
        ),
        (
            1729,
            "pytorch/pytorch",
            "inductor-h100",
            "test2 (h100, 1, 1, linux.aws.h100)",
            "runs/2/job/1",
            "linux.aws.h100",
            1742262372,
        ),
        (
            1352,
            "pytorch/pytorch",
            "inductor-rocm",
            "rocm-test1(1, 1, linux.rocm.gpu.2)",
            "runs/3/job/1",
            "linux.rocm.gpu.2",
            1742262372,
        ),
        (
            1400,
            "pytorch/pytorch",
            "inductor-rocm",
            "rocm-test1 (1, 1, linux.rocm.gpu.2)",
            "runs/4/job/2",
            "linux.rocm.gpu.2",
            1742262372,
        ),
    ]


def get_default_result_columns() -> Tuple:
    return ("queue_s", "repo", "workflow_name", "job_name", "html_url", "machine_type","time")


def mock_s3_resource_put(mock_s3_resource: Any) -> None:
    mock_s3 = mock_s3_resource.return_value
    mock_object = mock_s3.Object.return_value
    mock_object.put.return_value = {"ResponseMetadata": {"HTTPStatusCode": 200}}


def get_mock_s3_resource_object(mock_s3_resource: Any):
    return mock_s3_resource.return_value.Object


def mock_db_client(
    mock: Any,
    result_rows: List[Tuple] = get_default_result_rows(),
    result_columns: Tuple = get_default_result_columns(),
) -> None:
    mock_client = mock.return_value
    mock_client.query.return_value.result_rows = result_rows
    mock_client.query.return_value.column_names = result_columns


def set_default_env_variables():
    os.environ["CLICKHOUSE_ENDPOINT"] = "https://clickhouse.test1"
    os.environ["CLICKHOUSE_USERNAME"] = "user1"
    os.environ["CLICKHOUSE_PASSWORD"] = "pwd1"


class Test(unittest.TestCase):
    @patch("oss_ci_job_queue_time.lambda_function.get_aws_s3_resource")
    @patch("oss_ci_job_queue_time.lambda_function.get_clickhouse_client")
    def test_lambda_handler_when_row_result_is_empty(
        self, mock_get_client, mock_s3_resource
    ):
        print("test_lambda_handler_when_row_result_is_empty ")
        # prepare
        set_default_env_variables()
        mock_s3_resource_put(mock_s3_resource)
        mock_db_client(mock_get_client, result_rows=[])

        # execute
        lambda_handler(None, None)

        # assert
        mock_get_client.assert_called_once()
        get_mock_s3_resource_object(
            mock_s3_resource
        ).return_value.put.assert_not_called()

    @patch("oss_ci_job_queue_time.lambda_function.get_aws_s3_resource")
    @patch("oss_ci_job_queue_time.lambda_function.get_clickhouse_client")
    def test_lambda_handler_when_lambda_happy_flow_then_success(
        self, mock_get_client, mock_s3_resource
    ):
        # prepare
        set_default_env_variables()
        mock_s3_resource_put(mock_s3_resource)
        mock_db_client(mock_get_client)

        expected_r1 = b'{"queue_s": 60000, "repo": "pytorch/pytorch", "workflow_name": "workflow-name-1", "job_name": "job-name-1", "html_url": "runs/1/job/1", "machine_type": "linux.aws.h100", "time": 1742262372}\n'
        expected_r2 = b'{"queue_s": 1400, "repo": "pytorch/pytorch", "workflow_name": "workflow-name-2", "job_name": "job-name-2", "html_url": "runs/2/job/2", "machine_type": "linux.rocm.gpu.2", "time": 1742262372}\n'
        expected_s3_body = expected_r1 + expected_r2
        expect = gzip.compress(expected_s3_body)

        # execute
        lambda_handler(None, None)

        # assert

        # assert clickhouse client
        mock_get_client.assert_called_once()
        mock_get_client.return_value.query.assert_called_once()

        # assert s3 resource
        mock_s3_resource.assert_called_once()
        get_mock_s3_resource_object(
            mock_s3_resource
        ).return_value.put.assert_called_once()
        get_mock_s3_resource_object(
            mock_s3_resource
        ).return_value.put.assert_called_once_with(
            Body=expect, ContentEncoding="gzip", ContentType="text/plain"
        )

    @patch("boto3.resource")
    @patch("clickhouse_connect.get_client")
    def test_lambda_handler_when_missing_required_env_vars_then_throws_error(
        self, mock_get_client, mock_s3_resource
    ):
        test_cases = [
            ("CLICKHOUSE_ENDPOINT"),
            ("CLICKHOUSE_USERNAME"),
            ("CLICKHOUSE_PASSWORD"),
        ]

        for x in test_cases:
            with self.subTest(x=x):
                # prepare
                mock_get_client.reset_mock(return_value=True)
                mock_s3_resource.reset_mock(return_value=True)

                set_default_env_variables()
                os.environ[x] = ""

                # execute
                with self.assertRaises(ValueError) as context:
                    _ = lambda_handler(None, None)

                # assert
                self.assertTrue(x in str(context.exception))
                mock_get_client.return_value.query.assert_not_called()
                get_mock_s3_resource_object(
                    mock_s3_resource
                ).return_value.put.assert_not_called()


if __name__ == "__main__":
    unittest.main()
