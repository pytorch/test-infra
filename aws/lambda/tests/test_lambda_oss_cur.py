import logging
import unittest
from typing import Any, Dict, List, Tuple
from unittest.mock import MagicMock, patch

from oss_ci_cur.lambda_function import CostExplorerProcessor

from .common import MockClickHouseQuery, setup_mock_db_client


logger = logging.getLogger(__name__)


def get_default_environment_variables():
    return {
        "CLICKHOUSE_ENDPOINT": "test",
        "CLICKHOUSE_USERNAME": "test",
        "CLICKHOUSE_PASSWORD": "test",
    }


def get_mock_fetch_data() -> Dict[str, Any]:
    return {
        "ResultsByTime": [
            {
                "TimePeriod": {"Start": "2025-05-28", "End": "2025-05-29"},
                "Groups": [
                    {
                        "Keys": ["c5.12xlarge", "Test:c5.12xlarge"],
                        "Metrics": {
                            "UsageQuantity": {"Amount": "157.445277", "Unit": "Hrs"}
                        },
                    }
                ],
            }
        ]
    }


class CostExplorerMockQuery(MockClickHouseQuery):
    def __init__(self):
        super().__init__()

    def get_response_for_query(
        self, query: str, parameters: None, type: str = ""
    ) -> Tuple[Tuple[str, ...], List[Tuple]]:
        column_names = ()
        rows = []
        match type:
            case "empty":
                column_names = ()
                rows = []
            case "one_row":
                column_names = ("time",)
                rows = [("1748380800",)]
            case "two_rows":
                column_names = ("time",)
                rows = [("1748380800",), ("1748380800",)]
            case _:
                column_names = ("time",)
                rows = [("1748380800",)]
        return column_names, rows


class TestCostExplorerProcessor(unittest.TestCase):
    def setUp(self):
        # Mock environment variables
        envs_patcher = patch(
            "oss_ci_cur.lambda_function.ENVS",
            new=get_default_environment_variables(),
        )
        self.mock_envs = envs_patcher.start()
        self.addCleanup(envs_patcher.stop)

        # Mock boto3 client
        boto3_patcher = patch("oss_ci_cur.lambda_function.boto3.client")
        self.mock_boto3_client = boto3_patcher.start()
        self.addCleanup(boto3_patcher.stop)

        # Mock get_clickhouse_client method
        get_clickhouse_client_patcher = patch(
            "oss_ci_cur.lambda_function.get_clickhouse_client"
        )
        self.mock_get_cc = get_clickhouse_client_patcher.start()
        self.addCleanup(get_clickhouse_client_patcher.stop)

        # Set up the mock for clickhouse client
        self.mock_cc = MagicMock()
        setup_mock_db_client(self.mock_cc, CostExplorerMockQuery(), "", False)
        self.mock_get_cc.return_value = self.mock_cc

        # Set up the mock for AWS Cost Explorer client
        self.mock_ce_client = MagicMock()
        self.mock_boto3_client.return_value = self.mock_ce_client

        self.processor = CostExplorerProcessor(True)

    def test_process_raw_ce_data(self):
        # Sample input data
        input_data = get_mock_fetch_data().get("ResultsByTime", {})
        # Call the _process_raw_ce_data method
        result = self.processor._process_raw_ce_data(input_data)

        # Assert the processed data
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["Amount"], "157.445277")

    def test_flatten_ts_record(self):
        # Sample input data
        input_record = {
            "TimePeriod": {
                "Start": "2025-05-27T00:00:00Z",
                "End": "2025-05-28T01:00:00Z",
            },
            "Groups": [
                {
                    "Keys": ["c5.12xlarge", "Test:c5.12xlarge"],
                    "Metrics": {
                        "UsageQuantity": {"Amount": "157.445277", "Unit": "Hrs"}
                    },
                }
            ],
        }
        # Call the flatten_ts_record method
        result = self.processor.flatten_ts_record(input_record)

        # Assert the flattened record
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["Amount"], "157.445277")

    def test_to_db_schema(self):
        # Sample input data
        input_record = {
            "Start": "2025-05-28T00:00:00Z",
            "Keys": ["c5.12xlarge", "Test:c5.12xlarge"],
            "Unit": "Hrs",
            "Amount": "157.445277",
        }
        # Call the to_db_schema method
        result = self.processor.to_db_schema(input_record, "meta-runner-ec", "DAILY")

        # Assert the database schema
        self.assertIsNotNone(result)
        if result:
            self.assertEqual(result["instance_type"], "c5.12xlarge")
            self.assertEqual(result["value"], "157.445277")

    def test_fetch_max_time_missing_rows_throws_error(self):
        # Mock the response from AWS Cost Explorer
        setup_mock_db_client(self.mock_cc, CostExplorerMockQuery(), "empty", False)
        processor = CostExplorerProcessor()

        with self.assertRaises(ValueError) as context:
            processor.start()
        self.assertTrue("Expected 1 row, got 0" in str(context.exception))

    def test_fetch_max_time_multiple_rows_throws_error(self):
        # Mock the response from AWS Cost Explorer
        setup_mock_db_client(self.mock_cc, CostExplorerMockQuery(), "two_rows", False)
        processor = CostExplorerProcessor()

        with self.assertRaises(ValueError) as context:
            processor.start()
        self.assertTrue("Expected 1 row, got 2" in str(context.exception))

    def test_start_dry_run(self):
        # Mock the response from AWS Cost Explorer
        self.mock_ce_client.get_cost_and_usage.return_value = {
            "ResultsByTime": [
                {
                    "TimePeriod": {"Start": "2025-05-28", "End": "2025-05-29"},
                    "Groups": [],
                }
            ]
        }
        processor = CostExplorerProcessor(is_dry_run=True)
        # Call the start method
        processor.start()

        # Assert that the clickhouse client was not called
        self.mock_cc.assert_not_called()

    def test_start(self):
        # Mock the response from AWS Cost Explorer
        self.mock_ce_client.get_cost_and_usage.return_value = get_mock_fetch_data()
        # Call the start method
        processor = CostExplorerProcessor()
        processor.start()

        # Assert that the clickhouse client was called
        self.assertEqual(self.mock_cc.insert.call_count, 1)


if __name__ == "__main__":
    unittest.main()
