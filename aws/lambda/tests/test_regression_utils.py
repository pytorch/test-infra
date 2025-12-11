import datetime as dt
import math
import unittest
from typing import Any, Dict, List
from unittest.mock import Mock

from benchmark_regression_summary_report.common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiData,
    BenchmarkTimeSeriesItem,
)
from benchmark_regression_summary_report.common.config_model import (
    BenchmarkConfig,
    Policy,
    RegressionPolicy,
)
from benchmark_regression_summary_report.common.regression_utils import (
    BaselineResult,
    BenchmarkRegressionPoint,
    BenchmarkRegressionPointGroup,
    BenchmarkRegressionReport,
    BenchmarkRegressionReportGenerator,
    BenchmarkRegressionSummary,
    get_regression_status,
    PerGroupResult,
)


# ------------------------ HELPER FUNCTIONS START ----------------------------------
def create_benchmark_time_series_item(
    group_info: Dict[str, Any],
    data: List[Dict[str, Any]],
) -> BenchmarkTimeSeriesItem:
    """Helper to create a BenchmarkTimeSeriesItem"""
    item = Mock(spec=BenchmarkTimeSeriesItem)
    item.group_info = group_info
    item.data = data
    return item


def create_time_series_data(
    time_series: List[BenchmarkTimeSeriesItem],
) -> BenchmarkTimeSeriesApiData:
    """Helper to create BenchmarkTimeSeriesApiData"""
    data = Mock(spec=BenchmarkTimeSeriesApiData)
    data.time_series = time_series
    return data


def create_mock_config(
    metric_policies: Dict[str, RegressionPolicy] = None,
) -> BenchmarkConfig:
    """Helper to create a mock BenchmarkConfig"""
    if metric_policies is None:
        metric_policies = {
            "test_metric": RegressionPolicy(
                name="test_metric",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }

    mock_policy = Mock(spec=Policy)
    mock_policy.metrics = metric_policies

    mock_config = Mock(spec=BenchmarkConfig)
    mock_config.policy = mock_policy

    return mock_config


def create_data_point(
    value: float,
    timestamp: str,
    commit: str = "abc123",
    branch: str = "main",
    workflow_id: str = "12345",
) -> Dict[str, Any]:
    """Helper to create a data point"""
    return {
        "value": value,
        "granularity_bucket": timestamp,
        "commit": commit,
        "branch": branch,
        "workflow_id": workflow_id,
    }


# ------------------------ HELPER FUNCTIONS END ----------------------------------


# ------------------------ UTILITY FUNCTION TESTS START ----------------------------------
class TestGetRegressionStatus(unittest.TestCase):
    def test_returns_regression_when_regression_count_positive(self):
        summary: BenchmarkRegressionSummary = {
            "total_count": 10,
            "regression_count": 1,
            "suspicious_count": 0,
            "no_regression_count": 9,
            "insufficient_data_count": 0,
            "is_regression": 1,
        }
        result = get_regression_status(summary)
        self.assertEqual(result, "regression")

    def test_returns_suspicious_when_suspicious_count_positive(self):
        summary: BenchmarkRegressionSummary = {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 2,
            "no_regression_count": 8,
            "insufficient_data_count": 0,
            "is_regression": 0,
        }
        result = get_regression_status(summary)
        self.assertEqual(result, "suspicious")

    def test_returns_insufficient_data_when_above_threshold(self):
        summary: BenchmarkRegressionSummary = {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 0,
            "no_regression_count": 1,
            "insufficient_data_count": 9,
            "is_regression": 0,
        }
        result = get_regression_status(summary)
        self.assertEqual(result, "insufficient_data")

    def test_returns_no_regression_when_insufficient_data_below_threshold(self):
        summary: BenchmarkRegressionSummary = {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 0,
            "no_regression_count": 8,
            "insufficient_data_count": 2,
            "is_regression": 0,
        }
        result = get_regression_status(summary)
        self.assertEqual(result, "no_regression")

    def test_returns_no_regression_when_all_clean(self):
        summary: BenchmarkRegressionSummary = {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 0,
            "no_regression_count": 10,
            "insufficient_data_count": 0,
            "is_regression": 0,
        }
        result = get_regression_status(summary)
        self.assertEqual(result, "no_regression")


# ------------------------ UTILITY FUNCTION TESTS END ----------------------------------


# ------------------------ BENCHMARKREGRESSIONREPORTGENERATOR TESTS START ----------------------------------
class TestBenchmarkRegressionReportGeneratorInit(unittest.TestCase):
    def test_initialization_success(self):
        config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z"),
                create_data_point(110.0, "2025-01-02T00:00:00Z"),
            ],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[
                create_data_point(95.0, "2025-01-03T00:00:00Z"),
            ],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)

        self.assertIsNotNone(generator.metric_policies)
        self.assertIsNotNone(generator.baseline_ts_info)
        self.assertIsNotNone(generator.lastest_ts_info)
        self.assertIsNotNone(generator.target_ts)
        self.assertIsNotNone(generator.baseline_ts)

    def test_generate_raises_error_when_no_baseline(self):
        config = create_mock_config()
        baseline_ts = create_time_series_data([])
        target_ts = create_time_series_data([])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)

        with self.assertRaises(ValueError) as context:
            generator.generate()

        self.assertIn("No baseline or target data found", str(context.exception))


class TestToDataMap(unittest.TestCase):
    def test_to_data_map_converts_time_series_correctly(self):
        config = create_mock_config()
        item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric", "device": "gpu"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z"),
                create_data_point(110.0, "2025-01-02T00:00:00Z"),
            ],
        )
        ts_data = create_time_series_data([item])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item])
        )
        result = generator._to_data_map(ts_data)

        self.assertEqual(len(result), 1)
        key = tuple(sorted({"metric": "test_metric", "device": "gpu"}.items()))
        self.assertIn(key, result)
        self.assertEqual(len(result[key]["values"]), 2)
        self.assertEqual(result[key]["values"][0]["value"], 100.0)
        self.assertEqual(result[key]["values"][1]["value"], 110.0)

    def test_to_data_map_skips_none_values(self):
        config = create_mock_config()
        data_with_none = [
            create_data_point(100.0, "2025-01-01T00:00:00Z"),
            {**create_data_point(None, "2025-01-02T00:00:00Z")},
            create_data_point(110.0, "2025-01-03T00:00:00Z"),
        ]
        item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=data_with_none,
        )
        ts_data = create_time_series_data([item])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item])
        )
        result = generator._to_data_map(ts_data)

        key = tuple(sorted({"metric": "test_metric"}.items()))
        self.assertEqual(len(result[key]["values"]), 2)

    def test_to_data_map_skips_nan_values(self):
        config = create_mock_config()
        data_with_nan = [
            create_data_point(100.0, "2025-01-01T00:00:00Z"),
            create_data_point(math.nan, "2025-01-02T00:00:00Z"),
            create_data_point(110.0, "2025-01-03T00:00:00Z"),
        ]
        item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=data_with_nan,
        )
        ts_data = create_time_series_data([item])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item])
        )
        result = generator._to_data_map(ts_data)

        key = tuple(sorted({"metric": "test_metric"}.items()))
        self.assertEqual(len(result[key]["values"]), 2)

    def test_to_data_map_sorts_by_timestamp(self):
        config = create_mock_config()
        data_unsorted = [
            create_data_point(110.0, "2025-01-03T00:00:00Z"),
            create_data_point(100.0, "2025-01-01T00:00:00Z"),
            create_data_point(105.0, "2025-01-02T00:00:00Z"),
        ]
        item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=data_unsorted,
        )
        ts_data = create_time_series_data([item])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item])
        )
        result = generator._to_data_map(ts_data)

        key = tuple(sorted({"metric": "test_metric"}.items()))
        values = result[key]["values"]
        self.assertEqual(values[0]["value"], 100.0)
        self.assertEqual(values[1]["value"], 105.0)
        self.assertEqual(values[2]["value"], 110.0)


class TestGetBaseline(unittest.TestCase):
    def setUp(self):
        self.config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        self.generator = BenchmarkRegressionReportGenerator(
            self.config,
            create_time_series_data([target_item]),
            create_time_series_data([baseline_item]),
        )

    def test_get_baseline_max_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": 150.0,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="max")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 150.0)
        self.assertEqual(result["original_point"]["commit"], "b")

    def test_get_baseline_min_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": 50.0,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="min")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 50.0)
        self.assertEqual(result["original_point"]["commit"], "b")

    def test_get_baseline_target_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": 50.0,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="target")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 120.0)
        self.assertEqual(result["original_point"]["commit"], "c")

    def test_get_baseline_earliest_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": 50.0,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="earliest")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 100.0)
        self.assertEqual(result["original_point"]["commit"], "a")

    def test_get_baseline_median_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": 110.0,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="median")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 110.0)

    def test_get_baseline_returns_none_when_empty(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [],
        }

        result = self.generator._get_baseline(data, mode="max")

        self.assertIsNone(result)

    def test_get_baseline_returns_none_for_unknown_mode(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="unknown_mode")

        self.assertIsNone(result)

    def test_get_baseline_filters_nan_values(self):
        data: BenchmarkRegressionPointGroup = {
            "group_info": {"metric": "test"},
            "values": [
                {
                    "value": 100.0,
                    "commit": "a",
                    "branch": "main",
                    "workflow_id": "1",
                    "timestamp": "t1",
                },
                {
                    "value": math.nan,
                    "commit": "b",
                    "branch": "main",
                    "workflow_id": "2",
                    "timestamp": "t2",
                },
                {
                    "value": 120.0,
                    "commit": "c",
                    "branch": "main",
                    "workflow_id": "3",
                    "timestamp": "t3",
                },
            ],
        }

        result = self.generator._get_baseline(data, mode="max")

        self.assertIsNotNone(result)
        self.assertEqual(result["value"], 120.0)
        self.assertEqual(len(result["all_baseline_points"]), 2)


class TestClassifyFlags(unittest.TestCase):
    def setUp(self):
        self.config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        self.generator = BenchmarkRegressionReportGenerator(
            self.config,
            create_time_series_data([target_item]),
            create_time_series_data([baseline_item]),
        )

    def test_returns_insufficient_data_when_empty(self):
        result = self.generator.classify_flags([])
        self.assertEqual(result, "insufficient_data")

    def test_returns_insufficient_data_when_below_min_points(self):
        result = self.generator.classify_flags([True, False], min_points=3)
        self.assertEqual(result, "insufficient_data")

    def test_returns_regression_when_last_flag_true_and_min_points_1(self):
        result = self.generator.classify_flags([False, True], min_points=1)
        self.assertEqual(result, "regression")

    def test_returns_no_regression_when_last_flag_false_and_min_points_1(self):
        result = self.generator.classify_flags([True, False], min_points=1)
        self.assertEqual(result, "no_regression")

    def test_returns_regression_when_two_trailing_true(self):
        result = self.generator.classify_flags([False, True, True], min_points=3)
        self.assertEqual(result, "regression")

    def test_returns_regression_when_three_trailing_true(self):
        result = self.generator.classify_flags([False, True, True, True], min_points=3)
        self.assertEqual(result, "regression")

    def test_returns_suspicious_when_three_consecutive_true_not_at_end(self):
        result = self.generator.classify_flags(
            [False, True, True, True, False], min_points=3
        )
        self.assertEqual(result, "suspicious")

    def test_returns_no_regression_when_no_long_runs(self):
        result = self.generator.classify_flags(
            [True, False, True, False, True], min_points=3
        )
        self.assertEqual(result, "no_regression")

    def test_handles_all_true_flags(self):
        result = self.generator.classify_flags([True, True, True, True], min_points=3)
        self.assertEqual(result, "regression")

    def test_handles_all_false_flags(self):
        result = self.generator.classify_flags(
            [False, False, False, False], min_points=3
        )
        self.assertEqual(result, "no_regression")

    def test_edge_case_exactly_two_trailing_true(self):
        result = self.generator.classify_flags([False, False, True, True], min_points=3)
        self.assertEqual(result, "regression")


class TestResolvePolicy(unittest.TestCase):
    def setUp(self):
        self.config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        self.generator = BenchmarkRegressionReportGenerator(
            self.config,
            create_time_series_data([target_item]),
            create_time_series_data([baseline_item]),
        )

    def test_returns_policy_when_metric_exists(self):
        policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.95,
                baseline_aggregation="max",
            )
        }

        result = self.generator._resolve_policy(policies, "accuracy")

        self.assertIsNotNone(result)
        self.assertEqual(result.name, "accuracy")

    def test_case_insensitive_match(self):
        policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.95,
                baseline_aggregation="max",
            )
        }

        result = self.generator._resolve_policy(policies, "ACCURACY")

        self.assertIsNotNone(result)
        self.assertEqual(result.name, "accuracy")

    def test_returns_none_when_metric_not_found(self):
        policies = {}
        result = self.generator._resolve_policy(policies, "nonexistent")
        self.assertIsNone(result)

    def test_returns_none_when_metric_empty(self):
        policies = {
            "test": RegressionPolicy(
                name="test",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        result = self.generator._resolve_policy(policies, "")
        self.assertIsNone(result)


class TestSummarizeLabelCounts(unittest.TestCase):
    def setUp(self):
        self.config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        self.generator = BenchmarkRegressionReportGenerator(
            self.config,
            create_time_series_data([target_item]),
            create_time_series_data([baseline_item]),
        )

    def test_summarize_counts_all_labels(self):
        results: List[PerGroupResult] = [
            {
                "group_info": {},
                "baseline_point": None,
                "points": [],
                "label": "regression",
                "policy": None,
                "all_baseline_points": [],
            },
            {
                "group_info": {},
                "baseline_point": None,
                "points": [],
                "label": "suspicious",
                "policy": None,
                "all_baseline_points": [],
            },
            {
                "group_info": {},
                "baseline_point": None,
                "points": [],
                "label": "no_regression",
                "policy": None,
                "all_baseline_points": [],
            },
            {
                "group_info": {},
                "baseline_point": None,
                "points": [],
                "label": "insufficient_data",
                "policy": None,
                "all_baseline_points": [],
            },
        ]

        summary = self.generator.summarize_label_counts(results)

        self.assertEqual(summary["total_count"], 4)
        self.assertEqual(summary["regression_count"], 1)
        self.assertEqual(summary["suspicious_count"], 1)
        self.assertEqual(summary["no_regression_count"], 1)
        self.assertEqual(summary["insufficient_data_count"], 1)
        self.assertEqual(summary["is_regression"], 1)

    def test_summarize_no_regression(self):
        results: List[PerGroupResult] = [
            {
                "group_info": {},
                "baseline_point": None,
                "points": [],
                "label": "no_regression",
                "policy": None,
                "all_baseline_points": [],
            },
        ]

        summary = self.generator.summarize_label_counts(results)

        self.assertEqual(summary["total_count"], 1)
        self.assertEqual(summary["regression_count"], 0)
        self.assertEqual(summary["is_regression"], 0)


class TestDetectRegressionsWithPolicies(unittest.TestCase):
    def test_detect_regressions_with_regression(self):
        metric_policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        config = create_mock_config(metric_policies=metric_policies)

        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z"),
                create_data_point(95.0, "2025-01-02T00:00:00Z"),
            ],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[
                create_data_point(85.0, "2025-01-03T00:00:00Z"),
                create_data_point(80.0, "2025-01-04T00:00:00Z"),
            ],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)
        report = generator.generate()

        self.assertIsNotNone(report)
        self.assertEqual(report["summary"]["regression_count"], 1)
        self.assertEqual(len(report["results"]), 1)
        self.assertEqual(report["results"][0]["label"], "regression")

    def test_detect_regressions_no_regression(self):
        metric_policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        config = create_mock_config(metric_policies=metric_policies)

        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z"),
            ],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[
                create_data_point(95.0, "2025-01-03T00:00:00Z"),
                create_data_point(96.0, "2025-01-04T00:00:00Z"),
                create_data_point(97.0, "2025-01-05T00:00:00Z"),
            ],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)
        report = generator.generate()

        self.assertEqual(report["summary"]["no_regression_count"], 1)
        self.assertEqual(report["results"][0]["label"], "no_regression")

    def test_detect_regressions_missing_policy(self):
        metric_policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        config = create_mock_config(metric_policies=metric_policies)

        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "latency"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "latency"},
            data=[create_data_point(200.0, "2025-01-03T00:00:00Z")],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)
        report = generator.generate()

        self.assertEqual(len(report["results"]), 0)

    def test_detect_regressions_missing_baseline(self):
        metric_policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        config = create_mock_config(metric_policies=metric_policies)

        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "latency"},
            data=[create_data_point(200.0, "2025-01-03T00:00:00Z")],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)
        report = generator.generate()

        self.assertEqual(report["summary"]["insufficient_data_count"], 0)

    def test_detect_regressions_enriches_points_with_flags(self):
        metric_policies = {
            "accuracy": RegressionPolicy(
                name="accuracy",
                condition="greater_than",
                threshold=0.9,
                baseline_aggregation="max",
            )
        }
        config = create_mock_config(metric_policies=metric_policies)

        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "accuracy"},
            data=[
                create_data_point(95.0, "2025-01-03T00:00:00Z"),
                create_data_point(85.0, "2025-01-04T00:00:00Z"),
            ],
        )

        baseline_ts = create_time_series_data([baseline_item])
        target_ts = create_time_series_data([target_item])

        generator = BenchmarkRegressionReportGenerator(config, target_ts, baseline_ts)
        report = generator.generate()

        result = report["results"][0]
        self.assertEqual(len(result["points"]), 2)
        self.assertIn("flag", result["points"][0])
        self.assertFalse(result["points"][0]["flag"])
        self.assertTrue(result["points"][1]["flag"])


class TestGetMetaInfo(unittest.TestCase):
    def test_get_meta_info_returns_start_and_end(self):
        config = create_mock_config()
        item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z", commit="commit1"),
                create_data_point(110.0, "2025-01-02T00:00:00Z", commit="commit2"),
                create_data_point(120.0, "2025-01-03T00:00:00Z", commit="commit3"),
            ],
        )
        ts_data = create_time_series_data([item])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item])
        )
        meta_info = generator._get_meta_info(ts_data.time_series)

        self.assertEqual(meta_info["start"]["commit"], "commit1")
        self.assertEqual(meta_info["start"]["timestamp"], "2025-01-01T00:00:00Z")
        self.assertEqual(meta_info["end"]["commit"], "commit3")
        self.assertEqual(meta_info["end"]["timestamp"], "2025-01-03T00:00:00Z")

    def test_get_meta_info_multiple_series(self):
        config = create_mock_config()
        item1 = create_benchmark_time_series_item(
            group_info={"metric": "test1"},
            data=[
                create_data_point(100.0, "2025-01-02T00:00:00Z", commit="commit2"),
            ],
        )
        item2 = create_benchmark_time_series_item(
            group_info={"metric": "test2"},
            data=[
                create_data_point(100.0, "2025-01-01T00:00:00Z", commit="commit1"),
                create_data_point(100.0, "2025-01-05T00:00:00Z", commit="commit5"),
            ],
        )
        ts_data = create_time_series_data([item1, item2])

        generator = BenchmarkRegressionReportGenerator(
            config, ts_data, create_time_series_data([item1])
        )
        meta_info = generator._get_meta_info(ts_data.time_series)

        self.assertEqual(meta_info["start"]["commit"], "commit1")
        self.assertEqual(meta_info["end"]["commit"], "commit5")


class TestLabelStr(unittest.TestCase):
    def setUp(self):
        self.config = create_mock_config()
        baseline_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        target_item = create_benchmark_time_series_item(
            group_info={"metric": "test_metric"},
            data=[create_data_point(100.0, "2025-01-01T00:00:00Z")],
        )
        self.generator = BenchmarkRegressionReportGenerator(
            self.config,
            create_time_series_data([target_item]),
            create_time_series_data([baseline_item]),
        )

    def test_label_str_handles_string(self):
        result = self.generator._label_str("REGRESSION")
        self.assertEqual(result, "regression")

    def test_label_str_handles_lowercase_string(self):
        result = self.generator._label_str("suspicious")
        self.assertEqual(result, "suspicious")

    def test_label_str_handles_object_with_value_attribute(self):
        mock_obj = Mock()
        mock_obj.value = "NO_REGRESSION"
        result = self.generator._label_str(mock_obj)
        self.assertEqual(result, "no_regression")


# ------------------------ BENCHMARKREGRESSIONREPORTGENERATOR TESTS END ----------------------------------


if __name__ == "__main__":
    unittest.main()
