"""
Tests for missing-data / insufficient-data alerting.

Verifies that:
 1. status="insufficient_data" triggers a GitHub comment (new behaviour)
 2. status="no_regression" does NOT trigger a GitHub comment (existing behaviour)
 3. status="regression" still triggers a GitHub comment (existing behaviour)
 4. Empty target data from HUD API triggers a no-data alert
 5. Empty baseline data from HUD API triggers a no-data alert
 6. The no-data alert is deduplicated (one per day per config)
"""

import datetime as dt
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers to build minimal fakes that satisfy ReportManager / lambda_function
# ---------------------------------------------------------------------------

FAKE_CONFIG_ID = "pytorch_helion"

# Minimal regression report that ReportManager.__init__ can unpack
def _make_regression_report(*, status: str):
    """Return a minimal BenchmarkRegressionReport dict for the given *overall* status."""
    # Map overall status -> summary counts
    summary_map = {
        "regression": {
            "total_count": 10,
            "regression_count": 3,
            "suspicious_count": 0,
            "no_regression_count": 7,
            "insufficient_data_count": 0,
            "is_regression": 1,
        },
        "insufficient_data": {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 0,
            "no_regression_count": 1,
            "insufficient_data_count": 9,
            "is_regression": 0,
        },
        "no_regression": {
            "total_count": 10,
            "regression_count": 0,
            "suspicious_count": 0,
            "no_regression_count": 10,
            "insufficient_data_count": 0,
            "is_regression": 0,
        },
    }
    summary = summary_map[status]
    ts_now = dt.datetime.now(dt.timezone.utc).isoformat()
    meta = {"start": {"commit": "aaa", "branch": "main", "timestamp": ts_now, "workflow_id": "1"},
            "end":   {"commit": "bbb", "branch": "main", "timestamp": ts_now, "workflow_id": "2"}}
    return {
        "summary": summary,
        "results": [],
        "baseline_meta_data": meta,
        "new_meta_data": meta,
        "device_info": ["cuda_h100"],
        "metadata": {"regression_devices": []},
    }


def _make_config():
    """Return a minimal BenchmarkConfig for FAKE_CONFIG_ID."""
    from common.config_model import (
        BenchmarkApiSource,
        BenchmarkConfig,
        DayRangeWindow,
        Frequency,
        Policy,
        RangeConfig,
        RegressionPolicy,
        ReportConfig,
    )

    return BenchmarkConfig(
        name="Test Benchmark",
        id=FAKE_CONFIG_ID,
        source=BenchmarkApiSource(
            api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
            type="benchmark_time_series_api",
            api_endpoint_params_template='{"name":"test","query_params":{"startTime":"{{ startTime }}","stopTime":"{{ stopTime }}"}}',
        ),
        policy=Policy(
            frequency=Frequency(value=1, unit="days"),
            range=RangeConfig(
                baseline=DayRangeWindow(value=4),
                comparison=DayRangeWindow(value=4),
            ),
            metrics={
                "helion_speedup": RegressionPolicy(
                    name="helion_speedup",
                    condition="greater_equal",
                    threshold=0.95,
                    baseline_aggregation="median",
                ),
            },
            notification_config={
                "configs": [
                    {
                        "type": "github",
                        "repo": "pytorch/test-infra",
                        "issue": "7472",
                    }
                ]
            },
        ),
        report_config=ReportConfig(report_level="insufficient_data"),
    )


# ---------------------------------------------------------------------------
# 1-3: ReportManager.notify_github_comments gate
# ---------------------------------------------------------------------------

class TestReportManagerNotifyGate:
    """Verify the status gate in notify_github_comments."""

    def _build_manager(self, status: str):
        from common.report_manager import ReportManager

        config = _make_config()
        report = _make_regression_report(status=status)
        return ReportManager(
            db_table_name="benchmark.benchmark_regression_report",
            config=config,
            regression_report=report,
            is_dry_run=True,
        )

    def test_notify_on_insufficient_data(self):
        """When report status is 'insufficient_data', a GitHub comment SHOULD be created."""
        mgr = self._build_manager("insufficient_data")
        assert mgr.status == "insufficient_data"

        with patch.object(mgr, "_to_markdown", return_value="md body"):
            result = mgr.notify_github_comments("fake-token")

        # Should NOT have returned early (the old code returned None for non-regression)
        assert result is not None, (
            "notify_github_comments returned None for insufficient_data — "
            "it should post a comment"
        )

    def test_no_notify_on_no_regression(self):
        """When status is 'no_regression', no comment should be posted (existing behaviour)."""
        mgr = self._build_manager("no_regression")
        assert mgr.status == "no_regression"

        result = mgr.notify_github_comments("fake-token")
        # The method returns None when it skips early
        assert result is None

    def test_notify_on_regression_unchanged(self):
        """When status is 'regression', a comment SHOULD be posted (existing behaviour)."""
        mgr = self._build_manager("regression")
        assert mgr.status == "regression"

        with patch.object(mgr, "_to_markdown", return_value="md body"):
            result = mgr.notify_github_comments("fake-token")

        assert result is not None


# ---------------------------------------------------------------------------
# 4-6: lambda_function no-data path
# ---------------------------------------------------------------------------

class TestNoDataAlerts:
    """Verify that when HUD returns empty data, a no-data alert is posted."""

    @patch("lambda_function.get_clickhouse_client_environment")
    @patch("lambda_function.get_benchmark_regression_config")
    def test_no_data_target_triggers_alert(self, mock_get_config, mock_get_cc):
        """Empty target time_series → _notify_no_data is called."""
        from lambda_function import BenchmarkSummaryProcessor

        config = _make_config()
        mock_get_config.return_value = config

        mock_cc = MagicMock()
        # _should_generate_report returns True
        mock_cc.query.return_value = MagicMock(result_rows=[])

        processor = BenchmarkSummaryProcessor(
            config_id=FAKE_CONFIG_ID,
            end_time=int(dt.datetime.now(dt.timezone.utc).timestamp()),
            hud_access_token="fake",
            is_dry_run=False,
        )

        # Make get_target return None (empty data)
        with patch.object(
            processor, "get_target", return_value=(None, 0, 0)
        ), patch.object(
            processor, "_notify_no_data"
        ) as mock_notify:
            processor.process(cc=mock_cc)

        mock_notify.assert_called_once()

    @patch("lambda_function.get_clickhouse_client_environment")
    @patch("lambda_function.get_benchmark_regression_config")
    def test_no_data_baseline_triggers_alert(self, mock_get_config, mock_get_cc):
        """Empty baseline time_series → _notify_no_data is called."""
        from lambda_function import BenchmarkSummaryProcessor

        config = _make_config()
        mock_get_config.return_value = config

        mock_cc = MagicMock()
        mock_cc.query.return_value = MagicMock(result_rows=[])

        processor = BenchmarkSummaryProcessor(
            config_id=FAKE_CONFIG_ID,
            end_time=int(dt.datetime.now(dt.timezone.utc).timestamp()),
            hud_access_token="fake",
            is_dry_run=False,
        )

        # target returns data, baseline returns None
        fake_target = MagicMock()
        fake_target.time_series = [MagicMock()]
        with patch.object(
            processor, "get_target", return_value=(fake_target, 0, 0)
        ), patch.object(
            processor, "get_baseline", return_value=(None, 0, 0)
        ), patch.object(
            processor, "_notify_no_data"
        ) as mock_notify:
            processor.process(cc=mock_cc)

        mock_notify.assert_called_once()

    @patch("lambda_function.get_clickhouse_client_environment")
    @patch("lambda_function.get_benchmark_regression_config")
    def test_no_data_dedup(self, mock_get_config, mock_get_cc):
        """No-data alert should be deduplicated (not sent twice for the same day)."""
        from lambda_function import BenchmarkSummaryProcessor

        config = _make_config()
        mock_get_config.return_value = config

        mock_cc = MagicMock()
        # First query: _should_generate_report → True (no rows)
        # Second query: _no_data_already_alerted → True (row exists → skip)
        mock_cc.query.side_effect = [
            MagicMock(result_rows=[]),   # _should_generate_report
            MagicMock(result_rows=[(1,)]),  # _no_data_already_alerted → already sent
        ]

        processor = BenchmarkSummaryProcessor(
            config_id=FAKE_CONFIG_ID,
            end_time=int(dt.datetime.now(dt.timezone.utc).timestamp()),
            hud_access_token="fake",
            is_dry_run=False,
        )

        with patch.object(
            processor, "get_target", return_value=(None, 0, 0)
        ):
            # _notify_no_data should be called but should NOT post because of dedup
            with patch(
                "common.config_model.GitHubNotificationConfig.create_github_comment"
            ) as mock_gh:
                processor.process(cc=mock_cc)

            mock_gh.assert_not_called()
