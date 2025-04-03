import unittest
import os
import gzip

from typing import Any, List, Tuple, Dict
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime
from oss_ci_job_queue_time.lambda_function import (
    QueueTimeProcessor,
    WorkerPoolHandler,
    lambda_handler,
    local_run,
    TimeIntervalGenerator,
)

# ------------------------ MOCKS START ----------------------------------
_TEST_DATETIME_1M1D0030 = datetime(2025, 1, 1, 0, 30, 0)
_TEST_DATETIME_1M1D0100 = datetime(2025, 1, 1, 1, 0, 0)
_TEST_DATETIME_1M1D0130 = datetime(2025, 1, 1, 1, 30, 0)
_TEST_DATETIME_1M1D0200 = datetime(2025, 1, 1, 2, 0, 0)
_TEST_DATETIME_2023 = datetime(2023, 1, 1, 0, 30, 0)
_TEST_DATETIME_2024_1 = datetime(2024, 12, 31, 23, 55, 0)


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


def get_mock_queue_time_processor_process(start_time: datetime):
    if start_time == _TEST_DATETIME_1M1D0030:
        return {
            "end_time": _TEST_DATETIME_1M1D0100,
            "start_time": _TEST_DATETIME_1M1D0030,
            "queued_jobs": [
                {
                    "queue_s": 10,
                    "repo": "pytorch/pytorch",
                }
            ],
        }
    elif start_time == _TEST_DATETIME_1M1D0130:
        raise Exception("test exception")

    return {
        "end_time": _TEST_DATETIME_1M1D0130,
        "start_time": _TEST_DATETIME_1M1D0100,
        "queued_jobs": [
            {
                "queue_s": 20,
                "repo": "pytorch/pytorch",
            }
        ],
    }


class MockQuery:
    def __init__(
        self,
        rows_in_queue: List[Tuple] = get_default_result_rows(),
        rows_picked: List[Tuple] = [],
        rows_max_historagram: List[Tuple] = [(_TEST_DATETIME_1M1D0030.isoformat(),)],
        rows_max_workflow_job: List[Tuple] = [(_TEST_DATETIME_1M1D0100.isoformat(),)],
    ) -> None:
        self.rows_in_queue = rows_in_queue
        self.rows_picked = rows_picked
        self.rows_max_historagram = rows_max_historagram
        self.rows_max_workflow_job = rows_max_workflow_job

    def mock_query_result(self, query: str, parameters: str) -> Any:
        result = MagicMock()
        column_names = ()
        rows = []
        if "latest FROM fortesting.oss_ci_queue_time_histogram" in query:
            column_names = ("latest",)
            rows = self.rows_max_historagram
        elif "latest from default.workflow_job" in query:
            column_names = ("latest",)
            rows = self.rows_max_workflow_job
        elif "LENGTH(job.steps) = 0" in query:
            column_names = get_default_result_columns()
            rows = self.rows_in_queue
        elif "LENGTH(job.steps) != 0'" in query:
            column_names = get_default_result_columns()
            rows = self.rows_picked
        print(f"yang  test {column_names}, {rows}, {len(rows)}")

        result.column_names = column_names
        result.result_rows = rows
        result.row_count = len(rows)
        return result


def mock_s3_resource_put(mock_s3_resource: Any) -> None:
    mock_s3 = mock_s3_resource.return_value
    mock_object = mock_s3.Object.return_value
    mock_object.put.return_value = {"ResponseMetadata": {"HTTPStatusCode": 200}}


def get_mock_s3_resource_object(mock_s3_resource: Any):
    return mock_s3_resource.return_value.Object


def get_mock_db_query(mock: Any):
    return mock.return_value.query


def setup_mock_db_client(
    mock: Any,
    mock_query: MockQuery = MockQuery(),
    is_patch: bool = True,  # wether the mock is setup as patch method
) -> None:
    if is_patch:
        mock_client = mock.return_value
    else:
        mock_client = mock
    mock_client.query.side_effect = (
        lambda query, parameters: mock_query.mock_query_result(query, parameters)
    )


def get_default_environment_variables():
    return {
        "CLICKHOUSE_ENDPOINT": "test",
        "CLICKHOUSE_USERNAME": "test",
        "CLICKHOUSE_PASSWORD": "test",
        "GITHUB_ACCESS_TOKEN": "test",
    }


class EnvironmentBaseTest(unittest.TestCase):
    def setUp(self) -> None:
        # set up patchers since we are not passing in the s3 instance and clickhouse client instance in lambda_run()
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


# ------------------------ MOCKS ENDS ----------------------------------

# ------------------------ UTILIZATION UNIT TESTS START ----------------------------------


class TestTimeIntervalGenerator(unittest.TestCase):
    def test_time_interval_generator_happy_flow_then_success(self):
        mock = MagicMock()
        setup_mock_db_client(mock, is_patch=False)
        time_interval_generator = TimeIntervalGenerator()
        time_interval_generator.generate(mock)
        self.assertEqual(mock.query.call_count, 2)

    def test_time_interval_generator_when_empty_result_from_histogram_then_throws_error(
        self,
    ):
        mock = MagicMock()
        mq = MockQuery(
            rows_max_historagram=[],
        )
        setup_mock_db_client(mock, mq, is_patch=False)
        time_interval_generator = TimeIntervalGenerator()
        with self.assertRaises(ValueError) as context:
            time_interval_generator.generate(mock)
        self.assertTrue("Expected 1 row, got 0" in str(context.exception))

    def test_time_interval_generator_when_empty_result_from_workflow_job_then_throws_error(
        self,
    ):
        mock = MagicMock()
        mq = MockQuery(
            rows_max_workflow_job=[],
        )
        setup_mock_db_client(mock, mq, is_patch=False)

        time_interval_generator = TimeIntervalGenerator()
        with self.assertRaises(ValueError) as context:
            time_interval_generator.generate(mock)
        self.assertTrue("Expected 1 row, got 0" in str(context.exception))

    def test_time_interval_generator_with_different_format(self):
        # [ test description, start_time, end_time, expected_intervals]
        test_cases = [
            (
                "datetime string",
                "2025-01-01 00:30:00+00:00",
                "2025-01-01T01:00:00",
                1,
            ),
            (
                "unix timestamp integer",
                1735691400,
                1735693200,
                1,
            ),
            (
                "unix timestamp string",
                "1735691400",
                "1735693200",
                1,
            ),
            (
                "mixed format (int, datetime string)",
                "2025-03-26 14:10:00+00:00",
                1743001800,
                2,
            ),
            (
                "unix timestmap float",
                _TEST_DATETIME_1M1D0030.timestamp(),
                _TEST_DATETIME_1M1D0100.timestamp(),
                1,
                False,
            ),
        ]
        for x in test_cases:
            with self.subTest(f"Test Environment {x[0]}", x=x):
                print(f"[subTest] Running subtest for {x[0]}")
                # prepare
                mock = MagicMock()
                start_time = x[1]
                end_time = x[2]
                mq = MockQuery(
                    rows_max_historagram=[
                        (start_time,),
                    ],
                    rows_max_workflow_job=[
                        (end_time,),
                    ],
                )
                setup_mock_db_client(mock, mq, is_patch=False)
                time_interval_generator = TimeIntervalGenerator()
                res = time_interval_generator.generate(mock)
                self.assertEqual(
                    len(res),
                    x[3],
                    f"[{x[0]}] expected {x[3]} intervals, got {len(res)}",
                )

    def test_time_interval_generator_with_time_gap(self):
        # [ test description, start_time, end_time, expected_intervals, expected_error]
        test_cases = [
            (
                "single gap happy flow 1",
                _TEST_DATETIME_1M1D0030.timestamp(),
                _TEST_DATETIME_1M1D0100.timestamp(),
                1,
                False,
            ),
            (
                "single gap happy flow 2",
                "2025-01-01 00:30:00+00:00",
                "2025-01-01T01:00:00",
                1,
                False,
            ),
            (
                "multiple intervals 1",
                int(_TEST_DATETIME_1M1D0030.timestamp()),
                int(_TEST_DATETIME_1M1D0200.timestamp()),
                3,
                False,
            ),
            (
                "multiple intervals 2",
                _TEST_DATETIME_1M1D0030.timestamp() + 10,
                _TEST_DATETIME_1M1D0030.timestamp() + 5500,
                3,
                False,
            ),
            (
                "start_time unix timestamp 0",
                0,
                "2025-04-03 00:55:27",
                1,
                False,
            ),
            (
                "day diff between time range",
                "2025-04-03 23:30:00+00:00",
                "2025-04-04 00:55:27",
                2,
                False,
            ),
            (
                "year gap between time range",
                int(_TEST_DATETIME_2024_1.timestamp()),
                int(_TEST_DATETIME_1M1D0030.timestamp()),
                2,
                False,
            ),
            (
                "time range is above maximum intervals",
                int(_TEST_DATETIME_2023.timestamp()),
                int(_TEST_DATETIME_1M1D0030.timestamp()),
                None,
                True,
            ),
        ]
        for x in test_cases:
            with self.subTest(f"Test Environment {x[0]}", x=x):
                print(f"[subTest] Running subtest for {x[0]}")
                # prepare
                mock = MagicMock()
                start_time = x[1]
                end_time = x[2]
                mq = MockQuery(
                    rows_max_historagram=[
                        (start_time,),
                    ],
                    rows_max_workflow_job=[
                        (end_time,),
                    ],
                )
                setup_mock_db_client(mock, mq, is_patch=False)
                error_expected = x[4]
                if error_expected:
                    with self.assertRaises(ValueError) as __init__:
                        time_interval_generator = TimeIntervalGenerator()
                        time_interval_generator.generate(mock)
                else:
                    time_interval_generator = TimeIntervalGenerator()
                    res = time_interval_generator.generate(mock)
                    self.assertEqual(
                        len(res),
                        x[3],
                        f"[{x[0]}] expected {x[3]} intervals, got {len(res)}",
                    )


class TestQueueTimeProcessor(unittest.TestCase):
    def setUp(self):
        envs_patcher = patch(
            "oss_ci_job_queue_time.lambda_function.ENVS",
            new=get_default_environment_variables(),
        )

        # mock runner config method to return empty dict
        runner_config_patch = patch(
            "oss_ci_job_queue_time.lambda_function.get_runner_config"
        )
        self.mock_get_runner_config = runner_config_patch.start()
        self.mock_get_runner_config.return_value = {"runner_types": {}}

        # mock method get_config_retrievers
        self.mock_get_config_retrievers = MagicMock()
        self.mock_get_config_retrievers.return_value = {
            "meta": MagicMock(),
            "lf": MagicMock(),
            "old_lf": MagicMock(),
        }

        self.mock_s3_resource = MagicMock()
        self.mock_db_client = MagicMock()
        self.mock_envs = envs_patcher.start()

        # clean up for each test
        self.addCleanup(runner_config_patch.stop)

    def test_queue_time_processor_when_happy_flow_then_success(self):
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        setup_mock_db_client(self.mock_db_client)

        # execute
        processor = QueueTimeProcessor(
            clickhouse_client=self.mock_db_client,
            s3_client=self.mock_s3_resource,
        )
        processor.process(
            MagicMock(),
            MagicMock(),
            MagicMock(),
            _TEST_DATETIME_1M1D0030,
            _TEST_DATETIME_1M1D0100,
        )

        # assert
        # assert clickhouse client
        self.mock_db_client.query.assert_called()  # Generic check
        self.assertEqual(self.mock_db_client.query.call_count, 3)

        # assert s3 resource
        # TODO(elainewy): add called check when introduce histogram logic
        self.mock_s3_resource.Object.put.assert_not_called()

    def test_queue_time_processor_when_row_result_is_empty_then_success(self):
        print("test_queue_time_processor_when_row_result_is_empty ")
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)

        mq = MockQuery(rows_in_queue=[], rows_picked=[])
        setup_mock_db_client(self.mock_db_client, mq)

        # execute
        processor = QueueTimeProcessor(
            clickhouse_client=self.mock_db_client,
            s3_client=self.mock_s3_resource,
        )
        processor.process(
            MagicMock(),
            MagicMock(),
            MagicMock(),
            _TEST_DATETIME_1M1D0030,
            _TEST_DATETIME_1M1D0100,
        )

        # assert
        self.mock_db_client.query.assert_called()  # Generic check
        self.assertEqual(self.mock_db_client.query.call_count, 3)

        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()


class TestWorkerPoolHandler(unittest.TestCase):
    def test_worker_pool_handler_when_empty_input(self):
        mock_qtp_instance = MagicMock(spec=QueueTimeProcessor)
        mock_qtp_instance.process.side_effect = (
            lambda param1, *_: get_mock_queue_time_processor_process(param1)
        )
        handler = WorkerPoolHandler(
            {
                "meta": MagicMock(),
                "lf": MagicMock(),
                "old_lf": MagicMock(),
            },
            mock_qtp_instance,
        )
        handler.start([])
        mock_qtp_instance.process.assert_not_called()

    def test_worker_pool_handler_when_single_input_then_success(self):
        mock_qtp_instance = MagicMock(spec=QueueTimeProcessor)
        mock_qtp_instance.process.side_effect = (
            lambda param1, *_: get_mock_queue_time_processor_process(param1)
        )
        handler = WorkerPoolHandler(
            {
                "meta": MagicMock(),
                "lf": MagicMock(),
                "old_lf": MagicMock(),
            },
            mock_qtp_instance,
        )
        handler.start([[_TEST_DATETIME_1M1D0030, _TEST_DATETIME_1M1D0100]])

        # execute
        mock_qtp_instance.process.assert_called()

    def test_worker_pool_handler_when_multi_threads_then_success(self):
        # prepare
        mock_qtp_instance = MagicMock(spec=QueueTimeProcessor)
        mock_qtp_instance.process.side_effect = (
            lambda param1, *_: get_mock_queue_time_processor_process(param1)
        )

        # execute
        handler = WorkerPoolHandler(
            {
                "meta": MagicMock(),
                "lf": MagicMock(),
                "old_lf": MagicMock(),
            },
            mock_qtp_instance,
        )
        handler.start(
            [
                [_TEST_DATETIME_1M1D0030, _TEST_DATETIME_1M1D0100],
                [_TEST_DATETIME_1M1D0100, _TEST_DATETIME_1M1D0130],
            ]
        )

        # assert
        mock_qtp_instance.process.assert_called()

    def test_worker_pool_handler_when_single_result_failed_then_rest_of_success(self):
        # prepare
        mock_qtp_instance = MagicMock(spec=QueueTimeProcessor)
        mock_qtp_instance.process.side_effect = (
            lambda param1, *_: get_mock_queue_time_processor_process(param1)
        )
        # execute
        handler = WorkerPoolHandler(
            {
                "meta": MagicMock(),
                "lf": MagicMock(),
                "old_lf": MagicMock(),
            },
            mock_qtp_instance,
        )

        handler.start(
            [
                [_TEST_DATETIME_1M1D0030, _TEST_DATETIME_1M1D0100],
                [_TEST_DATETIME_1M1D0100, _TEST_DATETIME_1M1D0130],
                [_TEST_DATETIME_1M1D0130, _TEST_DATETIME_1M1D0200],
            ]
        )

        # assert
        mock_qtp_instance.process.assert_called()


# ------------------------ UTILIZATION UNIT TESTS END ----------------------------------


# ------------------------ ENVIRONMENT UNIT TESTS START ----------------------------------
class TestLambdaHanlder(EnvironmentBaseTest):
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

    def test_lambda_handler_run_happy_flow_success(
        self,
    ):
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        setup_mock_db_client(self.mock_get_client)

        # execute
        lambda_handler(None, None)

        # assert
        # assert clickhouse client
        self.mock_get_client.assert_called_once()
        self.assertEqual(self.mock_get_client.return_value.query.call_count, 5)

        # assert s3 resource
        self.mock_s3_resource.assert_called_once()
        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()


class TestLocalRun(EnvironmentBaseTest):
    def test_local_run_happy_flow_with_dry_run_success(
        self,
    ):
        # prepare
        mock_s3_resource_put(self.mock_s3_resource)
        setup_mock_db_client(self.mock_get_client)

        # execute
        local_run()

        # assert
        # assert clickhouse client
        self.mock_get_client.assert_called_once()
        self.assertEqual(self.mock_get_client.return_value.query.call_count, 5)

        # assert s3 resource
        self.mock_s3_resource.assert_called_once()
        get_mock_s3_resource_object(
            self.mock_s3_resource
        ).return_value.put.assert_not_called()


# ------------------------ ENVIRONMENT UNIT TESTS END ----------------------------------

if __name__ == "__main__":
    unittest.main()
