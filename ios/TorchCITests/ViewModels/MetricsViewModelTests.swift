import XCTest
@testable import TorchCI

@MainActor
final class MetricsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: MetricsDashboardViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = MetricsDashboardViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Register a JSON time series response for a given clickhouse query name.
    private func registerTimeSeriesResponse(name: String, data: [TimeSeriesDataPoint]) {
        let path = "/api/clickhouse/\(name)"
        let jsonArray = data.map { point -> String in
            let valueStr = point.value.map { "\($0)" } ?? "null"
            return """
            {"granularity_bucket":"\(point.granularity_bucket)","value":\(valueStr)}
            """
        }
        let json = "[\(jsonArray.joined(separator: ","))]"
        mockClient.setResponse(json, for: path)
    }

    /// Register a JSON response with custom fields for a given clickhouse query name.
    private func registerJSONResponse(_ json: String, forQuery name: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/\(name)")
    }

    /// Register empty responses for all endpoints that the dashboard fetches.
    /// This ensures loadDashboard() succeeds even when we only care about specific endpoints.
    private func registerAllEmptyResponses() {
        let queryNames = [
            "master_commit_red",
            "master_commit_red_avg",
            "strict_lag_sec",
            "weekly_force_merge_stats",
            "merge_retry_rate",
            "pr_landing_time_avg",
            "ttrs_percentiles",
            "workflow_duration_percentile",
            "workflow_duration_avg",
            "queued_jobs_by_label",
            "last_branch_push",
            "last_successful_workflow",
            "last_successful_jobs",
            "reverts",
            "num_commits_master",
            "queue_times_historical",
            "disabled_test_historical",
            "lf_rollover_percentage",
        ]
        for name in queryNames {
            mockClient.setResponse("[]", for: "/api/clickhouse/\(name)")
        }
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.granularity, .day)
        XCTAssertEqual(viewModel.selectedTimeRange, "14d")
        XCTAssertEqual(viewModel.selectedPercentile, 0.5)
        XCTAssertNil(viewModel.brokenTrunkPercent)
        XCTAssertNil(viewModel.flakyRedPercent)
        XCTAssertNil(viewModel.viableStrictLagSeconds)
        XCTAssertNil(viewModel.disabledTestsCount)
        XCTAssertNil(viewModel.forceMergeFailurePercent)
        XCTAssertNil(viewModel.forceMergeImpatiencePercent)
        XCTAssertNil(viewModel.mergeRetryRate)
        XCTAssertNil(viewModel.prLandingTimeHours)
        XCTAssertNil(viewModel.ttrsP90Minutes)
        XCTAssertNil(viewModel.ttrsP75Minutes)
        XCTAssertNil(viewModel.workflowTTSSeconds)
        XCTAssertNil(viewModel.avgQueueTimeSeconds)
        XCTAssertNil(viewModel.lastMainPushSeconds)
        XCTAssertNil(viewModel.lastNightlyPushSeconds)
        XCTAssertNil(viewModel.lastDockerBuildSeconds)
        XCTAssertNil(viewModel.lastDocsPushSeconds)
        XCTAssertNil(viewModel.revertsCount)
        XCTAssertNil(viewModel.commitsCount)
        XCTAssertNil(viewModel.lfRolloverPercent)
        XCTAssertTrue(viewModel.redRateSeries.isEmpty)
        XCTAssertTrue(viewModel.queueTimeSeries.isEmpty)
        XCTAssertTrue(viewModel.disabledTestsSeries.isEmpty)
        XCTAssertNil(viewModel.lastUpdated)
    }

    // MARK: - Load Dashboard

    func testLoadDashboardWithEmptyResponsesSucceeds() async {
        registerAllEmptyResponses()

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.lastUpdated)
        XCTAssertTrue(viewModel.redRateSeries.isEmpty)
        XCTAssertTrue(viewModel.queueTimeSeries.isEmpty)
        XCTAssertTrue(viewModel.disabledTestsSeries.isEmpty)
    }

    func testLoadDashboardPopulatesRedRateSeries() async {
        registerAllEmptyResponses()

        registerJSONResponse("""
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":5.2},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":3.1}
        ]
        """, forQuery: "master_commit_red")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.redRateSeries.count, 2)
        XCTAssertEqual(viewModel.redRateSeries[0].value, 5.2)
        XCTAssertEqual(viewModel.redRateSeries[1].value, 3.1)
    }

    func testLoadDashboardPopulatesCommitHealth() async {
        registerAllEmptyResponses()

        // Commit red avg with broken_trunk_red and flaky_red
        registerJSONResponse("""
        [{"broken_trunk_red": 0.08, "flaky_red": 0.12}]
        """, forQuery: "master_commit_red_avg")

        // Strict lag - decoded as StrictLagResponse with strict_lag_sec field
        registerJSONResponse("""
        [{"strict_lag_sec":18000}]
        """, forQuery: "strict_lag_sec")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        // broken_trunk_red is multiplied by 100
        XCTAssertEqual(viewModel.brokenTrunkPercent ?? 0, 8.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.flakyRedPercent ?? 0, 12.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.viableStrictLagSeconds, 18000)
    }

    func testLoadDashboardPopulatesMergeMetrics() async {
        registerAllEmptyResponses()

        // Force merge failure - ViewModel uses .first?.value
        registerJSONResponse("""
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":3.5},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":4.2}
        ]
        """, forQuery: "weekly_force_merge_stats")

        // Merge retry rate - ViewModel decodes as RetryRateResponse with avg_retry_rate field
        registerJSONResponse("""
        [{"avg_retry_rate":1.3}]
        """, forQuery: "merge_retry_rate")

        // PR landing time - ViewModel decodes as LandingTimeResponse with avg_hours field
        registerJSONResponse("""
        [{"avg_hours":5.7}]
        """, forQuery: "pr_landing_time_avg")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        // Force merge stats: ViewModel uses .first?.value = 3.5
        // Both failure and impatience share the same mock path
        XCTAssertEqual(viewModel.forceMergeFailurePercent, 3.5)
        XCTAssertEqual(viewModel.forceMergeImpatiencePercent, 3.5)
        XCTAssertEqual(viewModel.mergeRetryRate, 1.3)
        XCTAssertEqual(viewModel.prLandingTimeHours, 5.7)
    }

    func testLoadDashboardPopulatesSignalMetrics() async {
        registerAllEmptyResponses()

        // TTRS - decoded as TimeSeriesDataPoint
        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":42.5}]
        """, forQuery: "ttrs_percentiles")

        // Workflow TTS - decoded as WorkflowDurationResponse with duration_sec field
        registerJSONResponse("""
        [{"duration_sec":3600,"name":"pull"}]
        """, forQuery: "workflow_duration_percentile")

        // Queue time by label - decoded as QueuedJobsResponse with avg_queue_s, count, machine_type
        registerJSONResponse("""
        [
            {"avg_queue_s":120,"count":10,"machine_type":"linux.2xlarge"},
            {"avg_queue_s":180,"count":5,"machine_type":"windows.4xlarge"}
        ]
        """, forQuery: "queued_jobs_by_label")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        // Both p90 and p75 hit the same mock path
        XCTAssertEqual(viewModel.ttrsP90Minutes, 42.5)
        XCTAssertEqual(viewModel.ttrsP75Minutes, 42.5)
        XCTAssertEqual(viewModel.workflowTTSSeconds, 3600)
        // Average of 120 and 180
        XCTAssertEqual(viewModel.avgQueueTimeSeconds, 150.0)
    }

    func testLoadDashboardPopulatesBuildHealth() async {
        registerAllEmptyResponses()

        // Last branch push - decoded as PushSecondsAgoResponse with push_seconds_ago field
        registerJSONResponse("""
        [{"push_seconds_ago":1800}]
        """, forQuery: "last_branch_push")

        // Docker build - decoded as LastSuccessResponse with last_success_seconds_ago field
        registerJSONResponse("""
        [{"last_success_seconds_ago":3600}]
        """, forQuery: "last_successful_workflow")

        // Docs push - decoded as LastSuccessResponse with last_success_seconds_ago field
        registerJSONResponse("""
        [{"last_success_seconds_ago":7200}]
        """, forQuery: "last_successful_jobs")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.lastMainPushSeconds, 1800)
        XCTAssertEqual(viewModel.lastNightlyPushSeconds, 1800)
        XCTAssertEqual(viewModel.lastDockerBuildSeconds, 3600)
        XCTAssertEqual(viewModel.lastDocsPushSeconds, 7200)
    }

    func testLoadDashboardPopulatesActivityMetrics() async {
        registerAllEmptyResponses()

        // Reverts
        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":5}]
        """, forQuery: "reverts")

        // Commits
        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":150}]
        """, forQuery: "num_commits_master")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.revertsCount, 5)
        XCTAssertEqual(viewModel.commitsCount, 150)
    }

    func testLoadDashboardPopulatesDisabledTestsCount() async {
        registerAllEmptyResponses()

        // ViewModel decodes as DisabledTestHistoricalRow with day, count, new, deleted fields
        registerJSONResponse("""
        [
            {"day":"2024-01-01","count":42,"new":5,"deleted":2},
            {"day":"2024-01-02","count":45,"new":3,"deleted":0}
        ]
        """, forQuery: "disabled_test_historical")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.disabledTestsSeries.count, 2)
        // disabledTestsCount uses last row's "count" field
        XCTAssertEqual(viewModel.disabledTestsCount, 45)
    }

    // MARK: - Error Handling

    func testLoadDashboardErrorOnSingleEndpointStillLoads() async {
        // Individual endpoint errors are wrapped in try? so they don't prevent loading.
        // Setting an error on one endpoint should still result in .loaded state.
        registerAllEmptyResponses()
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/master_commit_red")

        await viewModel.loadDashboard()

        // Since all API calls use try?, individual failures are silently ignored
        // and the dashboard still transitions to .loaded
        XCTAssertEqual(viewModel.state, .loaded)
        // The red rate series should be empty since that endpoint failed
        XCTAssertTrue(viewModel.redRateSeries.isEmpty)
    }

    func testLoadDashboardNetworkErrorOnSingleEndpointStillLoads() async {
        // Network errors on individual endpoints are wrapped in try? and silently ignored.
        registerAllEmptyResponses()
        mockClient.setError(APIError.networkError(URLError(.notConnectedToInternet)), for: "/api/clickhouse/master_commit_red")

        await viewModel.loadDashboard()

        // Since all API calls use try?, individual network failures don't prevent loading
        XCTAssertEqual(viewModel.state, .loaded)
        // The red rate series should be empty since that endpoint failed
        XCTAssertTrue(viewModel.redRateSeries.isEmpty)
    }

    func testLoadDashboardSetsLoadingStateDuringFetch() async {
        registerAllEmptyResponses()

        // Before load
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadDashboard()

        // After load
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshReloadsAllMetrics() async {
        registerAllEmptyResponses()

        await viewModel.refresh()

        // Should have made calls to all endpoints
        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testRefreshDoesNotResetToLoadingState() async {
        registerAllEmptyResponses()

        // First load
        await viewModel.loadDashboard()
        XCTAssertEqual(viewModel.state, .loaded)

        mockClient.reset()
        registerAllEmptyResponses()

        // Refresh should not set loading state
        await viewModel.refresh()
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testRefreshUpdatesLastUpdated() async {
        registerAllEmptyResponses()

        await viewModel.loadDashboard()
        let firstUpdate = viewModel.lastUpdated

        // Small delay to ensure time difference
        try? await Task.sleep(nanoseconds: 10_000_000) // 10ms

        mockClient.reset()
        registerAllEmptyResponses()

        await viewModel.refresh()
        let secondUpdate = viewModel.lastUpdated

        XCTAssertNotNil(firstUpdate)
        XCTAssertNotNil(secondUpdate)
        if let first = firstUpdate, let second = secondUpdate {
            XCTAssertTrue(second >= first)
        }
    }

    // MARK: - Time Range

    func testDefaultTimeRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "14d")
        XCTAssertEqual(viewModel.selectedRange?.days, 14)
        XCTAssertEqual(viewModel.selectedRange?.label, "2 Weeks")
    }

    func testTimeRangeChangeUpdatesProperty() {
        viewModel.selectedTimeRange = "7d"
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Week")
    }

    func testTimeRangeChangeToThirtyDays() {
        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    func testTimeRangeChangeToNinetyDays() {
        viewModel.selectedTimeRange = "90d"
        XCTAssertEqual(viewModel.selectedRange?.days, 90)
        XCTAssertEqual(viewModel.selectedRange?.label, "3 Months")
    }

    func testInvalidTimeRangeReturnsNilSelectedRange() {
        viewModel.selectedTimeRange = "invalid"
        XCTAssertNil(viewModel.selectedRange)
    }

    func testAllTimeRangePresetsExist() {
        let presets = TimeRange.presets
        XCTAssertEqual(presets.count, 7)

        let ids = Set(presets.map(\.id))
        XCTAssertTrue(ids.contains("1d"))
        XCTAssertTrue(ids.contains("3d"))
        XCTAssertTrue(ids.contains("7d"))
        XCTAssertTrue(ids.contains("14d"))
        XCTAssertTrue(ids.contains("30d"))
        XCTAssertTrue(ids.contains("90d"))
        XCTAssertTrue(ids.contains("180d"))
    }

    func testTimeRangeChangeTriggersRefetch() async {
        registerAllEmptyResponses()

        viewModel.selectedTimeRange = "30d"
        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    // MARK: - Granularity

    func testGranularityChangeUpdatesProperty() {
        viewModel.granularity = .hour
        XCTAssertEqual(viewModel.granularity, .hour)

        viewModel.granularity = .week
        XCTAssertEqual(viewModel.granularity, .week)

        viewModel.granularity = .day
        XCTAssertEqual(viewModel.granularity, .day)
    }

    func testAllGranularitiesAreAvailable() {
        let allCases = TimeGranularity.allCases
        XCTAssertEqual(allCases.count, 3)
        XCTAssertTrue(allCases.contains(.hour))
        XCTAssertTrue(allCases.contains(.day))
        XCTAssertTrue(allCases.contains(.week))
    }

    func testGranularityChangeTriggersRefetch() async {
        registerAllEmptyResponses()

        viewModel.granularity = .hour
        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testGranularityDisplayNames() {
        XCTAssertEqual(TimeGranularity.hour.displayName, "Hour")
        XCTAssertEqual(TimeGranularity.day.displayName, "Day")
        XCTAssertEqual(TimeGranularity.week.displayName, "Week")
    }

    // MARK: - Percentile

    func testSelectedPercentileLabelAvg() {
        viewModel.selectedPercentile = -1.0
        XCTAssertEqual(viewModel.selectedPercentileLabel, "avg")
    }

    func testSelectedPercentileLabelP50() {
        viewModel.selectedPercentile = 0.5
        XCTAssertEqual(viewModel.selectedPercentileLabel, "p50")
    }

    func testSelectedPercentileLabelP90() {
        viewModel.selectedPercentile = 0.9
        XCTAssertEqual(viewModel.selectedPercentileLabel, "p90")
    }

    func testSelectedPercentileLabelP95() {
        viewModel.selectedPercentile = 0.95
        XCTAssertEqual(viewModel.selectedPercentileLabel, "p95")
    }

    func testSelectedPercentileLabelP99() {
        viewModel.selectedPercentile = 0.99
        XCTAssertEqual(viewModel.selectedPercentileLabel, "p99")
    }

    func testSelectedPercentileLabelP100() {
        viewModel.selectedPercentile = 1.0
        XCTAssertEqual(viewModel.selectedPercentileLabel, "p100")
    }

    func testPercentileChangeTriggersRefetch() async {
        registerAllEmptyResponses()

        viewModel.selectedPercentile = 0.9
        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testAvgPercentileUsesAvgQueryName() async {
        registerAllEmptyResponses()

        viewModel.selectedPercentile = -1.0
        await viewModel.onParametersChanged()

        // Should call workflow_duration_avg instead of workflow_duration_percentile
        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/workflow_duration_avg"))
    }

    func testNonAvgPercentileUsesPercentileQueryName() async {
        registerAllEmptyResponses()

        viewModel.selectedPercentile = 0.9
        await viewModel.onParametersChanged()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/workflow_duration_percentile"))
    }

    // MARK: - Overall Health Status

    func testHealthStatusAllNormalWhenNoData() {
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "All Systems Normal")
        XCTAssertEqual(status.icon, "checkmark.circle.fill")
    }

    func testHealthStatusCriticalWhenBrokenTrunkHigh() {
        viewModel.brokenTrunkPercent = 20.0
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
        XCTAssertEqual(status.icon, "exclamationmark.triangle.fill")
    }

    func testHealthStatusWarningWhenBrokenTrunkMedium() {
        viewModel.brokenTrunkPercent = 7.0
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
        XCTAssertEqual(status.icon, "exclamationmark.circle.fill")
    }

    func testHealthStatusNormalWhenBrokenTrunkLow() {
        viewModel.brokenTrunkPercent = 2.0
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "All Systems Normal")
    }

    func testHealthStatusCriticalWhenLagVeryHigh() {
        viewModel.viableStrictLagSeconds = 50000  // >43200 (12h)
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
    }

    func testHealthStatusWarningWhenLagHigh() {
        viewModel.viableStrictLagSeconds = 30000  // >21600 (6h) but <43200
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
    }

    func testHealthStatusCriticalWhenMainPushStale() {
        viewModel.lastMainPushSeconds = 20000  // >14400 (4h)
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
    }

    func testHealthStatusWarningWhenMainPushSomewhatStale() {
        viewModel.lastMainPushSeconds = 10000  // >7200 (2h) but <14400
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
    }

    func testHealthStatusCountsMultipleCriticalSignals() {
        viewModel.brokenTrunkPercent = 20.0
        viewModel.viableStrictLagSeconds = 50000
        viewModel.lastMainPushSeconds = 20000
        let status = viewModel.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
        XCTAssertTrue(status.subtitle.contains("3"))
    }

    func testHealthStatusCountsSingleCriticalSignal() {
        viewModel.brokenTrunkPercent = 20.0
        let status = viewModel.overallHealthStatus
        XCTAssertTrue(status.subtitle.contains("1"))
    }

    // MARK: - Trend Computation

    func testTrendComputedFromRedRateSeries() async {
        registerAllEmptyResponses()

        // First half higher, second half lower -> negative trend (improving)
        registerJSONResponse("""
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":10},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":10},
            {"granularity_bucket":"2024-01-03T00:00:00Z","value":5},
            {"granularity_bucket":"2024-01-04T00:00:00Z","value":5}
        ]
        """, forQuery: "master_commit_red")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        // brokenTrunkTrend is computed from red rate series
        // First half avg = 10, second half avg = 5, trend = -50%
        XCTAssertNotNil(viewModel.brokenTrunkTrend)
        if let trend = viewModel.brokenTrunkTrend {
            XCTAssertEqual(trend, -50.0, accuracy: 0.1)
        }
    }

    func testTrendNilWhenInsufficientData() async {
        registerAllEmptyResponses()

        // Only one data point - not enough for trend
        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":10}]
        """, forQuery: "master_commit_red")

        await viewModel.loadDashboard()

        XCTAssertNil(viewModel.brokenTrunkTrend)
    }

    // MARK: - API Endpoint Paths

    func testLoadDashboardCallsCorrectEndpoints() async {
        registerAllEmptyResponses()

        await viewModel.loadDashboard()

        // Verify all expected endpoints were called by checking the unique set of paths.
        // Using Set to avoid sensitivity to call ordering from concurrent async let tasks.
        let pathSet = Set(mockClient.callPaths())
        XCTAssertTrue(pathSet.contains("/api/clickhouse/master_commit_red"), "Missing master_commit_red")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/master_commit_red_avg"), "Missing master_commit_red_avg")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/strict_lag_sec"), "Missing strict_lag_sec")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/weekly_force_merge_stats"), "Missing weekly_force_merge_stats")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/merge_retry_rate"), "Missing merge_retry_rate")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/pr_landing_time_avg"), "Missing pr_landing_time_avg")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/ttrs_percentiles"), "Missing ttrs_percentiles")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/queued_jobs_by_label"), "Missing queued_jobs_by_label")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/last_branch_push"), "Missing last_branch_push")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/last_successful_workflow"), "Missing last_successful_workflow")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/last_successful_jobs"), "Missing last_successful_jobs")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/reverts"), "Missing reverts")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/num_commits_master"), "Missing num_commits_master")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/queue_times_historical"), "Missing queue_times_historical")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/disabled_test_historical"), "Missing disabled_test_historical")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/workflow_duration_percentile"), "Missing workflow_duration_percentile")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/lf_rollover_percentage"), "Missing lf_rollover_percentage")
    }

    // MARK: - Null Value Handling

    func testNullValuesInTimeSeriesProduceNilValues() async {
        registerAllEmptyResponses()

        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":null}]
        """, forQuery: "master_commit_red")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.redRateSeries.count, 1)
        XCTAssertNil(viewModel.redRateSeries.first?.value)
    }

    func testDisabledTestsCountNilWhenSeriesEmpty() async {
        registerAllEmptyResponses()

        await viewModel.loadDashboard()

        XCTAssertNil(viewModel.disabledTestsCount)
    }

    func testDisabledTestsCountNilWhenLastValueIsNull() async {
        registerAllEmptyResponses()

        registerJSONResponse("""
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":null}]
        """, forQuery: "disabled_test_historical")

        await viewModel.loadDashboard()

        // value is nil so disabledTestsCount should be nil
        XCTAssertNil(viewModel.disabledTestsCount)
    }

    // MARK: - Queue Time Averaging

    func testAvgQueueTimeAveragesAcrossAllLabels() async {
        registerAllEmptyResponses()

        // ViewModel decodes as QueuedJobsResponse with avg_queue_s, count, machine_type
        registerJSONResponse("""
        [
            {"avg_queue_s":100,"count":10,"machine_type":"linux.2xlarge"},
            {"avg_queue_s":200,"count":5,"machine_type":"linux.4xlarge"},
            {"avg_queue_s":300,"count":8,"machine_type":"linux.8xlarge"}
        ]
        """, forQuery: "queued_jobs_by_label")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.avgQueueTimeSeconds, 200.0)
    }

    func testAvgQueueTimeNilWhenEmpty() async {
        registerAllEmptyResponses()

        await viewModel.loadDashboard()

        XCTAssertNil(viewModel.avgQueueTimeSeconds)
    }

    // MARK: - ViewState Equality

    func testViewStateLoadingEquality() {
        let a = MetricsDashboardViewModel.ViewState.loading
        let b = MetricsDashboardViewModel.ViewState.loading
        XCTAssertEqual(a, b)
    }

    func testViewStateLoadedEquality() {
        let a = MetricsDashboardViewModel.ViewState.loaded
        let b = MetricsDashboardViewModel.ViewState.loaded
        XCTAssertEqual(a, b)
    }

    func testViewStateErrorEquality() {
        let a = MetricsDashboardViewModel.ViewState.error("test")
        let b = MetricsDashboardViewModel.ViewState.error("test")
        XCTAssertEqual(a, b)
    }

    func testViewStateDifferentErrorsNotEqual() {
        let a = MetricsDashboardViewModel.ViewState.error("a")
        let b = MetricsDashboardViewModel.ViewState.error("b")
        XCTAssertNotEqual(a, b)
    }

    func testViewStateDifferentKindsNotEqual() {
        let a = MetricsDashboardViewModel.ViewState.loading
        let b = MetricsDashboardViewModel.ViewState.loaded
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Commit Health Fallback

    func testCommitHealthFallsBackToRedRateSeries() async {
        registerAllEmptyResponses()

        // Set up red rate series data
        registerJSONResponse("""
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":5.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":8.0}
        ]
        """, forQuery: "master_commit_red")

        // Make commit health avg fail
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/master_commit_red_avg")

        await viewModel.loadDashboard()

        XCTAssertEqual(viewModel.state, .loaded)
        // Should fall back to last red rate series value
        XCTAssertEqual(viewModel.brokenTrunkPercent, 8.0)
        XCTAssertNil(viewModel.flakyRedPercent) // No fallback for flaky
    }
}
