import unittest
import os
import gzip

from typing import Any, List, Tuple, Dict
from unittest.mock import patch, MagicMock
from oss_ci_job_queue_time.lambda_function import lambda_handler, main


def get_default_result_rows(test_sample: str = "0"):
    """
    generate result rows for testing, this corrresponds to the following columns:
       'queue_s', 'repo', 'workflow_name', 'job_name', 'html_url', 'machine_type', 'time'
    """
    if test_sample == "0":
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
            ),
        ]

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
    return (
        "queue_s",
        "repo",
        "workflow_name",
        "job_name",
        "html_url",
        "machine_type",
        "time",
    )


def mock_query_result(
    query: str, parameters: str, rows_in_queue: List[Tuple], rows_picked: List[Tuple]
) -> Any:
    result = MagicMock()
    if "LENGTH(job.steps) = 0" in query:
        result.column_names = get_default_result_columns()
        result.result_rows = rows_in_queue
    if "LENGTH(job.steps) != 0'" in query:
        result.column_names = get_default_result_columns()
        result.result_rows = rows_picked
    return result


def mock_s3_resource_put(mock_s3_resource: Any) -> None:
    mock_s3 = mock_s3_resource.return_value
    mock_object = mock_s3.Object.return_value
    mock_object.put.return_value = {"ResponseMetadata": {"HTTPStatusCode": 200}}


def get_mock_s3_resource_object(mock_s3_resource: Any):
    return mock_s3_resource.return_value.Object


def mock_db_client(
    mock: Any,
    rows_in_queue: List[Tuple] = get_default_result_rows(),
    rows_picked: List[Tuple] = [],
) -> None:
    mock_client = mock.return_value
    mock_client.query.side_effect = lambda query, parameters: mock_query_result(
        query, parameters, rows_in_queue, rows_picked
    )


def get_default_environment_variables():
    return {
        "CLICKHOUSE_ENDPOINT": "test",
        "CLICKHOUSE_USERNAME": "test",
        "CLICKHOUSE_PASSWORD": "test",
        "GITHUB_ACCESS_TOKEN": "test",
    }


class Test(unittest.TestCase):
    def setUp(self):
        patcher1 = patch("oss_ci_job_queue_time.lambda_function.get_aws_s3_resource")
        patcher2 = patch("oss_ci_job_queue_time.lambda_function.get_clickhouse_client")
        patcher3 = patch("oss_ci_job_queue_time.lambda_function.get_runner_config")
        patcher4 = patch("oss_ci_job_queue_time.lambda_function.get_config_retrievers")
        envs_patcher = patch(
            "oss_ci_job_queue_time.lambda_function.ENVS",
            new=get_default_environment_variables(),
        )

        self.mock_s3_resource = patcher1.start()
        self.mock_get_client = patcher2.start()
        self.mock_get_runner_config = patcher3.start()
        self.mock_get_config_retrievers = patcher4.start()
        self.mock_envs = envs_patcher.start()

        self.mock_get_runner_config.return_value = {"runner_types": {}}
        self.mock_get_config_retrievers.return_value = {
            "meta": MagicMock(),
            "lf": MagicMock(),
            "old_lf": MagicMock(),
        }

        self.addCleanup(patcher1.stop)  # Ensure patchers stop after each test
        self.addCleanup(patcher2.stop)
        self.addCleanup(patcher3.stop)
        self.addCleanup(patcher4.stop)
        self.addCleanup(envs_patcher.stop)

    def test_lambda_handler_when_row_result_is_empty(self):
        print("test_lambda_handler_when_row_result_is_empty ")
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        mock_db_client(self.mock_get_client, [], [])

        # execute
        lambda_handler(None, None)

        # assert
        self.mock_get_client.assert_called_once()
        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()

    def test_lambda_handler_when_lambda_happy_flow_then_success(self):
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        mock_db_client(self.mock_get_client)

        expected_r1 = b'{"queue_s": 60000, "repo": "pytorch/pytorch", "workflow_name": "workflow-name-1", "job_name": "job-name-1", "html_url": "runs/1/job/1", "machine_type": "linux.aws.h100", "time": 1742262372, "runner_labels": ["pet", "linux", "linux-meta", "all", "meta", "multi-tenant", "other", "linux.aws.h100"]}\n'
        expected_r2 = b'{"queue_s": 1400, "repo": "pytorch/pytorch", "workflow_name": "workflow-name-2", "job_name": "job-name-2", "html_url": "runs/2/job/2", "machine_type": "linux.rocm.gpu.2", "time": 1742262372, "runner_labels": ["linux", "linux-amd", "all", "other", "linux.rocm.gpu.2"]}\n'
        expected_s3_body = expected_r1 + expected_r2
        expect = gzip.compress(expected_s3_body)

        # execute
        lambda_handler(None, None)

        # assert

        # assert clickhouse client
        self.mock_get_client.assert_called_once()
        self.assertEqual(self.mock_get_client.return_value.query.call_count, 2)

        # assert s3 resource
        self.mock_s3_resource.assert_called_once()
        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()

    def test_lambda_handler_when_missing_required_env_vars_then_throws_error(self):
        test_cases = [
            ("CLICKHOUSE_ENDPOINT"),
            ("CLICKHOUSE_USERNAME"),
            ("CLICKHOUSE_PASSWORD"),
            ("GITHUB_ACCESS_TOKEN"),
        ]
        for x in test_cases:
            with self.subTest(f"Test Environment {x}", x=x):
                # prepare
                self.mock_get_client.reset_mock(return_value=True)
                self.mock_s3_resource.reset_mock(return_value=True)
                self.mock_envs[x] = ""

                # execute
                with self.assertRaises(ValueError) as context:
                    _ = lambda_handler(None, None)

                # assert
                self.assertTrue(x in str(context.exception))
                self.mock_get_client.return_value.query.assert_not_called()
                get_mock_s3_resource_object(
                    self.mock_s3_resource
                ).return_value.put.assert_not_called()

                # reset
                # manually reset the envs, todo: find a better way to do this,maybe use parameterized
                self.mock_envs[x] = get_default_environment_variables()[x]

    def test_local_run_with_dry_run_when_lambda_happy_flow_then_success_without_s3_write(
        self,
    ):
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        mock_db_client(self.mock_get_client)

        # execute
        main()

        # assert

        # assert clickhouse client
        self.mock_get_client.assert_called_once()
        self.assertEqual(self.mock_get_client.return_value.query.call_count, 2)

        # assert s3 resource
        self.mock_s3_resource.assert_called_once()
        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()


if __name__ == "__main__":
    unittest.main()
