import argparse
import datetime as dt
import logging
import unittest
from typing import Any, List, Tuple
from unittest.mock import MagicMock, Mock, patch

import requests
from benchmark_regression_summary_report.common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiResponse,
    BenchmarkTimeSeriesDataModel,
    TimeRange,
)
from benchmark_regression_summary_report.common.config_model import (
    BenchmarkApiSource,
    BenchmarkConfig,
    Frequency,
    PolicyConfig,
    RangeConfig,
)
from benchmark_regression_summary_report.lambda_function import (
    BenchmarkSummaryProcessor,
    format_ts_with_t,
    get_clickhouse_client,
    lambda_handler,
    main,
    truncate_to_hour,
)

from .common import MockClickHouseQuery, setup_mock_db_client


logger = logging.getLogger(__name__)


# ------------------------ TEST DATA & MOCKS START ----------------------------------
_TEST_DATETIME = dt.datetime(2025, 1, 15, 10, 30, 0, tzinfo=dt.timezone.utc)
_TEST_TIMESTAMP = int(_TEST_DATETIME.timestamp())


class BenchmarkRegressionMockQuery(MockClickHouseQuery):
    def __init__(
        self,
        latest_record_ts: int = None,
    ) -> None:
        super().__init__()
        self.latest_record_ts = latest_record_ts

    def get_response_for_query(
        self, query: str, parameters: None, type: str = ""
    ) -> Tuple[Tuple[str, ...], List[Tuple]]:
        column_names = ()
        rows = []
        if "toUnixTimestamp(max(last_record_ts))" in query:
            column_names = ("max(last_record_ts)",)
            rows = [(self.latest_record_ts,)]
        return column_names, rows


def get_default_environment_variables():
    return {
        "GITHUB_TOKEN": "test_token",
        "CLICKHOUSE_ENDPOINT": "test_endpoint",
        "CLICKHOUSE_PASSWORD": "test_password",
        "CLICKHOUSE_USERNAME": "test_user",
        "HUD_INTERNAL_BOT_TOKEN": "test_hud_token",
    }


def create_mock_config(
    config_id: str = "test_config",
    frequency: Frequency = Frequency.DAILY,
    comparison_time_s: int = 7 * 24 * 3600,
    total_time_s: int = 14 * 24 * 3600,
) -> BenchmarkConfig:
    """Helper to create a mock BenchmarkConfig"""
    mock_range = Mock(spec=RangeConfig)
    mock_range.comparison_timedelta_s.return_value = comparison_time_s
    mock_range.total_timedelta_s.return_value = total_time_s

    mock_policy = Mock(spec=PolicyConfig)
    mock_policy.frequency = frequency
    mock_policy.range = mock_range

    mock_source = Mock(spec=BenchmarkApiSource)
    mock_source.api_query_url = "https://test-api.example.com"
    mock_source.render.return_value = "test_query"

    mock_config = Mock(spec=BenchmarkConfig)
    mock_config.id = config_id
    mock_config.policy = mock_policy
    mock_config.source = mock_source

    return mock_config


def create_mock_time_series_data(
    num_series: int = 1,
    end_time: dt.datetime = _TEST_DATETIME,
) -> BenchmarkTimeSeriesDataModel:
    """Helper to create mock time series data"""
    mock_data = Mock(spec=BenchmarkTimeSeriesDataModel)
    mock_data.time_series = [{"metric": f"test_metric_{i}"} for i in range(num_series)]
    mock_data.time_range = Mock(spec=TimeRange)
    mock_data.time_range.end = end_time.isoformat()
    return mock_data


class EnvironmentBaseTest(unittest.TestCase):
    """Base test class with common setup for environment variables and mocks"""

    def setUp(self) -> None:
        # Patch environment variables
        envs_patcher = patch(
            "benchmark_regression_summary_report.lambda_function.ENVS",
            new=get_default_environment_variables(),
        )
        self.mock_envs = envs_patcher.start()
        self.addCleanup(envs_patcher.stop)

        # Patch clickhouse client
        get_clickhouse_client_patcher = patch(
            "benchmark_regression_summary_report.lambda_function.get_clickhouse_client_environment"
        )
        self.mock_get_cc = get_clickhouse_client_patcher.start()
        self.addCleanup(get_clickhouse_client_patcher.stop)

        # Setup mock clickhouse client
        self.mock_cc = MagicMock()
        setup_mock_db_client(
            self.mock_cc, BenchmarkRegressionMockQuery(latest_record_ts=None), "", False
        )
        self.mock_get_cc.return_value = self.mock_cc


# ------------------------ TEST DATA & MOCKS END ----------------------------------


# ------------------------ UTILITY FUNCTION TESTS START ----------------------------------
class TestUtilityFunctions(unittest.TestCase):
    def test_format_ts_with_t_returns_correct_format(self):
        ts = 1705320600  # 2024-01-15 10:30:00 UTC
        result = format_ts_with_t(ts)
        self.assertEqual(result, "2024-01-15T10:30:00")

    def test_truncate_to_hour_removes_minutes_and_seconds(self):
        dt_with_minutes = dt.datetime(
            2025, 1, 15, 10, 30, 45, 123456, tzinfo=dt.timezone.utc
        )
        result = truncate_to_hour(dt_with_minutes)
        expected = dt.datetime(2025, 1, 15, 10, 0, 0, 0, tzinfo=dt.timezone.utc)
        self.assertEqual(result, expected)

    def test_get_clickhouse_client_creates_client_with_params(self):
        with patch(
            "benchmark_regression_summary_report.lambda_function.clickhouse_connect.get_client"
        ) as mock_get_client:
            get_clickhouse_client("host", "user", "password")
            mock_get_client.assert_called_once_with(
                host="host", user="user", password="password", secure=True
            )


# ------------------------ UTILITY FUNCTION TESTS END ----------------------------------


# ------------------------ BENCHMARKSUMMARYPROCESSOR TESTS START ----------------------------------
class TestBenchmarkSummaryProcessor(unittest.TestCase):
    def setUp(self):
        self.config_id = "test_config"
        self.end_time = _TEST_TIMESTAMP
        self.processor = BenchmarkSummaryProcessor(
            config_id=self.config_id,
            end_time=self.end_time,
            hud_access_token="test_token",
            is_dry_run=False,
            is_pass_check=False,
        )

    def test_processor_initialization(self):
        self.assertEqual(self.processor.config_id, self.config_id)
        self.assertEqual(self.processor.end_time, self.end_time)
        self.assertEqual(self.processor.hud_access_token, "test_token")
        self.assertFalse(self.processor.is_dry_run)
        self.assertFalse(self.processor.is_pass_check)

    def test_log_info_formats_correctly(self):
        with self.assertLogs(level="INFO") as log:
            self.processor.log_info("Test message")
            self.assertIn(str(self.end_time), log.output[0])
            self.assertIn(self.config_id, log.output[0])
            self.assertIn("Test message", log.output[0])

    def test_log_error_formats_correctly(self):
        with self.assertLogs(level="ERROR") as log:
            self.processor.log_error("Error message")
            self.assertIn(str(self.end_time), log.output[0])
            self.assertIn(self.config_id, log.output[0])
            self.assertIn("Error message", log.output[0])

    @patch(
        "benchmark_regression_summary_report.lambda_function.get_benchmark_regression_config"
    )
    def test_process_skip_when_invalid_config(self, mock_get_config):
        mock_get_config.side_effect = ValueError("Invalid config")
        mock_cc = MagicMock()

        self.processor.process(cc=mock_cc)

        mock_get_config.assert_called_once_with(self.config_id)

    @patch(
        "benchmark_regression_summary_report.lambda_function.get_benchmark_regression_config"
    )
    def test_process_skip_when_unexpected_error(self, mock_get_config):
        mock_get_config.side_effect = Exception("Unexpected error")
        mock_cc = MagicMock()

        self.processor.process(cc=mock_cc)

        mock_get_config.assert_called_once_with(self.config_id)

    @patch("benchmark_regression_summary_report.lambda_function.ReportManager")
    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkRegressionReportGenerator"
    )
    @patch(
        "benchmark_regression_summary_report.lambda_function.get_benchmark_regression_config"
    )
    def test_process_skip_when_should_not_generate_report(
        self, mock_get_config, mock_generator, mock_report_manager
    ):
        mock_config = create_mock_config()
        mock_get_config.return_value = mock_config

        mock_cc = MagicMock()
        # Setup to return a recent timestamp that would prevent report generation
        setup_mock_db_client(
            mock_cc,
            BenchmarkRegressionMockQuery(latest_record_ts=self.end_time - 3600),
            "",
            False,
        )

        self.processor.process(cc=mock_cc)

        mock_get_config.assert_called_once()
        mock_generator.assert_not_called()
        mock_report_manager.assert_not_called()

    def test_should_use_data_returns_true_when_within_delta(self):
        end_time = _TEST_TIMESTAMP
        latest_ts = end_time - 24 * 3600  # 1 day ago
        min_delta = dt.timedelta(days=2)

        result = self.processor.should_use_data(latest_ts, end_time, min_delta)

        self.assertTrue(result)

    def test_should_use_data_returns_false_when_exceeds_delta(self):
        end_time = _TEST_TIMESTAMP
        latest_ts = end_time - 3 * 24 * 3600  # 3 days ago
        min_delta = dt.timedelta(days=2)

        result = self.processor.should_use_data(latest_ts, end_time, min_delta)

        self.assertFalse(result)

    def test_should_use_data_returns_false_when_no_timestamp(self):
        result = self.processor.should_use_data(None, _TEST_TIMESTAMP)

        self.assertFalse(result)

    def test_should_use_data_uses_default_delta_when_not_provided(self):
        end_time = _TEST_TIMESTAMP
        latest_ts = end_time - 24 * 3600  # 1 day ago (within default 2 days)

        result = self.processor.should_use_data(latest_ts, end_time)

        self.assertTrue(result)

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_fetch_from_benchmark_ts_api_success(self, mock_from_request):
        mock_config = create_mock_config()
        mock_data = create_mock_time_series_data()
        mock_response = Mock()
        mock_response.data = mock_data
        mock_from_request.return_value = mock_response

        result = self.processor._fetch_from_benchmark_ts_api(
            config_id="test_config",
            end_time=_TEST_TIMESTAMP,
            start_time=_TEST_TIMESTAMP - 3600,
            access_token="test_token",
            source=mock_config.source,
        )

        self.assertEqual(result, mock_data)
        mock_from_request.assert_called_once()

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_fetch_from_benchmark_ts_api_http_error(self, mock_from_request):
        mock_config = create_mock_config()
        mock_response = Mock()
        mock_response.json.return_value = {"error": "API Error"}
        http_error = requests.exceptions.HTTPError()
        http_error.response = mock_response
        mock_from_request.side_effect = http_error

        with self.assertRaises(requests.exceptions.HTTPError):
            self.processor._fetch_from_benchmark_ts_api(
                config_id="test_config",
                end_time=_TEST_TIMESTAMP,
                start_time=_TEST_TIMESTAMP - 3600,
                access_token="test_token",
                source=mock_config.source,
            )

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_fetch_from_benchmark_ts_api_generic_exception(self, mock_from_request):
        mock_config = create_mock_config()
        mock_from_request.side_effect = Exception("Network error")

        with self.assertRaises(RuntimeError) as context:
            self.processor._fetch_from_benchmark_ts_api(
                config_id="test_config",
                end_time=_TEST_TIMESTAMP,
                start_time=_TEST_TIMESTAMP - 3600,
                access_token="test_token",
                source=mock_config.source,
            )

        self.assertIn("Fetch failed", str(context.exception))

    def test_should_generate_report_returns_true_when_no_previous_record(self):
        mock_cc = MagicMock()
        setup_mock_db_client(
            mock_cc, BenchmarkRegressionMockQuery(latest_record_ts=None), "", False
        )

        result = self.processor._should_generate_report(
            mock_cc, _TEST_TIMESTAMP, "test_config", Frequency.DAILY
        )

        self.assertTrue(result)

    def test_should_generate_report_returns_true_when_time_boundary_exceeded(self):
        mock_cc = MagicMock()
        # Set previous record to 2 days ago
        previous_ts = _TEST_TIMESTAMP - 2 * 24 * 3600
        setup_mock_db_client(
            mock_cc,
            BenchmarkRegressionMockQuery(latest_record_ts=previous_ts),
            "",
            False,
        )

        result = self.processor._should_generate_report(
            mock_cc, _TEST_TIMESTAMP, "test_config", Frequency.DAILY
        )

        self.assertTrue(result)

    def test_should_generate_report_returns_false_when_too_soon(self):
        mock_cc = MagicMock()
        # Set previous record to 1 hour ago (less than daily frequency)
        previous_ts = _TEST_TIMESTAMP - 3600
        setup_mock_db_client(
            mock_cc,
            BenchmarkRegressionMockQuery(latest_record_ts=previous_ts),
            "",
            False,
        )

        result = self.processor._should_generate_report(
            mock_cc, _TEST_TIMESTAMP, "test_config", Frequency.DAILY
        )

        self.assertFalse(result)

    def test_should_generate_report_forced_in_dry_run_with_pass_check(self):
        processor = BenchmarkSummaryProcessor(
            config_id=self.config_id,
            end_time=self.end_time,
            is_dry_run=True,
            is_pass_check=True,
        )
        mock_cc = MagicMock()
        # Set previous record to 1 hour ago (would normally prevent generation)
        previous_ts = _TEST_TIMESTAMP - 3600
        setup_mock_db_client(
            mock_cc,
            BenchmarkRegressionMockQuery(latest_record_ts=previous_ts),
            "",
            False,
        )

        result = processor._should_generate_report(
            mock_cc, _TEST_TIMESTAMP, "test_config", Frequency.DAILY
        )

        self.assertTrue(result)

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_get_target_returns_none_when_no_data(self, mock_from_request):
        mock_config = create_mock_config()
        mock_data = Mock(spec=BenchmarkTimeSeriesDataModel)
        mock_data.time_series = []
        mock_data.time_range = None
        mock_response = Mock()
        mock_response.data = mock_data
        mock_from_request.return_value = mock_response

        result, _, _ = self.processor.get_target(
            mock_config, _TEST_TIMESTAMP, "test_token"
        )

        self.assertIsNone(result)

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_get_target_returns_data_when_available(self, mock_from_request):
        mock_config = create_mock_config()
        mock_data = create_mock_time_series_data(num_series=5)
        mock_response = Mock()
        mock_response.data = mock_data
        mock_from_request.return_value = mock_response

        result, start, end = self.processor.get_target(
            mock_config, _TEST_TIMESTAMP, "test_token"
        )

        self.assertEqual(result, mock_data)
        self.assertIsNotNone(start)
        self.assertIsNotNone(end)

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    def test_get_baseline_returns_none_when_data_too_old(self, mock_from_request):
        mock_config = create_mock_config()
        # Create data with timestamp that's too old
        old_time = _TEST_DATETIME - dt.timedelta(days=10)
        mock_data = create_mock_time_series_data(end_time=old_time)
        mock_response = Mock()
        mock_response.data = mock_data
        mock_from_request.return_value = mock_response

        result, _, _ = self.processor.get_baseline(
            mock_config, _TEST_TIMESTAMP, "test_token"
        )

        self.assertIsNone(result)


# ------------------------ BENCHMARKSUMMARYPROCESSOR TESTS END ----------------------------------


# ------------------------ MAIN FUNCTION TESTS START ----------------------------------
class TestMainFunction(unittest.TestCase):
    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    def test_main_raises_error_when_no_github_token(self, mock_processor):
        with self.assertRaises(ValueError) as context:
            main(config_id="test_config", github_access_token="")

        self.assertIn("GITHUB_TOKEN", str(context.exception))
        mock_processor.assert_not_called()

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    def test_main_raises_error_when_no_config_id(self, mock_processor):
        with self.assertRaises(ValueError) as context:
            main(config_id="", github_access_token="test_token")

        self.assertIn("config_id", str(context.exception))
        mock_processor.assert_not_called()

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    @patch("benchmark_regression_summary_report.lambda_function.dt.datetime")
    def test_main_uses_current_time_when_no_args(
        self, mock_datetime, mock_processor_class
    ):
        mock_now = _TEST_DATETIME
        mock_datetime.now.return_value = mock_now
        mock_datetime.timezone = dt.timezone
        mock_processor = MagicMock()
        mock_processor_class.return_value = mock_processor

        main(
            config_id="test_config",
            github_access_token="test_token",
            is_dry_run=True,
        )

        mock_processor_class.assert_called_once()
        mock_processor.process.assert_called_once()

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    @patch("benchmark_regression_summary_report.lambda_function.isoparse")
    def test_main_uses_custom_end_time_from_args(
        self, mock_isoparse, mock_processor_class
    ):
        custom_time = _TEST_DATETIME
        mock_isoparse.return_value = custom_time
        mock_processor = MagicMock()
        mock_processor_class.return_value = mock_processor

        args = argparse.Namespace(end_time="2025-01-15T10:30:00")

        main(
            config_id="test_config",
            github_access_token="test_token",
            args=args,
            is_dry_run=True,
        )

        mock_isoparse.assert_called_once_with("2025-01-15T10:30:00")
        mock_processor.process.assert_called_once()

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    def test_main_disables_force_when_not_dry_run(self, mock_processor_class):
        mock_processor = MagicMock()
        mock_processor_class.return_value = mock_processor

        main(
            config_id="test_config",
            github_access_token="test_token",
            is_dry_run=False,
            is_forced=True,
        )

        # Check that the processor was created with is_pass_check=False
        call_kwargs = mock_processor_class.call_args[1]
        self.assertFalse(call_kwargs["is_pass_check"])

    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkSummaryProcessor"
    )
    def test_main_propagates_processor_exception(self, mock_processor_class):
        mock_processor = MagicMock()
        mock_processor.process.side_effect = Exception("Processing failed")
        mock_processor_class.return_value = mock_processor

        with self.assertRaises(Exception) as context:
            main(
                config_id="test_config",
                github_access_token="test_token",
                is_dry_run=True,
            )

        self.assertIn("Processing failed", str(context.exception))


# ------------------------ MAIN FUNCTION TESTS END ----------------------------------


# ------------------------ LAMBDA HANDLER TESTS START ----------------------------------
class TestLambdaHandler(EnvironmentBaseTest):
    @patch("benchmark_regression_summary_report.lambda_function.main")
    def test_lambda_handler_calls_main_with_config_id(self, mock_main):
        event = {"config_id": "test_config"}

        lambda_handler(event, None)

        mock_main.assert_called_once_with(
            config_id="test_config",
            github_access_token=get_default_environment_variables()["GITHUB_TOKEN"],
            hud_access_token=get_default_environment_variables()[
                "HUD_INTERNAL_BOT_TOKEN"
            ],
        )

    def test_lambda_handler_raises_error_when_missing_config_id(self):
        event = {}

        with self.assertRaises(ValueError) as context:
            lambda_handler(event, None)

        self.assertIn("config_id", str(context.exception))

    @patch("benchmark_regression_summary_report.lambda_function.main")
    def test_lambda_handler_returns_none(self, mock_main):
        event = {"config_id": "test_config"}

        result = lambda_handler(event, None)

        self.assertIsNone(result)


# ------------------------ LAMBDA HANDLER TESTS END ----------------------------------


# ------------------------ INTEGRATION TESTS START ----------------------------------
class TestIntegration(EnvironmentBaseTest):
    @patch("benchmark_regression_summary_report.lambda_function.ReportManager")
    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkRegressionReportGenerator"
    )
    @patch(
        "benchmark_regression_summary_report.lambda_function.BenchmarkTimeSeriesApiResponse.from_request"
    )
    @patch(
        "benchmark_regression_summary_report.lambda_function.get_benchmark_regression_config"
    )
    def test_full_process_flow_success(
        self,
        mock_get_config,
        mock_from_request,
        mock_generator_class,
        mock_report_manager_class,
    ):
        # Setup mocks
        mock_config = create_mock_config()
        mock_get_config.return_value = mock_config

        mock_data = create_mock_time_series_data(num_series=5)
        mock_response = Mock()
        mock_response.data = mock_data
        mock_from_request.return_value = mock_response

        mock_generator = Mock()
        mock_generator.generate.return_value = {"report": "data"}
        mock_generator_class.return_value = mock_generator

        mock_report_manager = Mock()
        mock_report_manager_class.return_value = mock_report_manager

        # Setup database to allow report generation
        setup_mock_db_client(
            self.mock_cc, BenchmarkRegressionMockQuery(latest_record_ts=None), "", False
        )

        # Execute
        processor = BenchmarkSummaryProcessor(
            config_id="test_config",
            end_time=_TEST_TIMESTAMP,
            hud_access_token="test_token",
            is_dry_run=True,
        )
        processor.process(cc=self.mock_cc)

        # Verify
        mock_get_config.assert_called_once()
        self.assertEqual(mock_from_request.call_count, 2)  # target and baseline
        mock_generator.generate.assert_called_once()
        mock_report_manager.run.assert_called_once()


# ------------------------ INTEGRATION TESTS END ----------------------------------


if __name__ == "__main__":
    unittest.main()
