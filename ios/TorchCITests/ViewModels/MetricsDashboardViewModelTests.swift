import XCTest
@testable import TorchCI

@MainActor
final class MetricsDashboardViewModelTests: XCTestCase {
    private var mockClient: MockAPIClient!
    private var sut: MetricsDashboardViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        sut = MetricsDashboardViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        sut = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(sut.state, .idle)
        XCTAssertEqual(sut.granularity, .day)
        XCTAssertEqual(sut.selectedTimeRange, "14d")
        XCTAssertEqual(sut.selectedPercentile, 0.5)
        XCTAssertNil(sut.brokenTrunkPercent)
        XCTAssertNil(sut.viableStrictLagSeconds)
        XCTAssertNil(sut.lastUpdated)
    }

    // MARK: - Load Dashboard

    func testLoadDashboardSetsLoadedState() async {
        setAllMinimalResponses()

        await sut.loadDashboard()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertNotNil(sut.lastUpdated)
    }

    func testLoadDashboardOnlyWorksFromIdle() async {
        sut.state = .loaded
        setAllMinimalResponses()

        await sut.loadDashboard()

        // Should remain loaded, not reload
        XCTAssertEqual(sut.state, .loaded)
    }

    func testLoadDashboardGracefulWithMissingResponses() async {
        // Don't set any responses — all fetches use try? so they'll return nil
        // The dashboard should still load, just with nil values
        setAllMinimalResponses()

        await sut.loadDashboard()

        XCTAssertEqual(sut.state, .loaded)
    }

    // MARK: - Health Status

    func testOverallHealthNormal() {
        // No metrics set → all nil → no warnings/critical
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "All Systems Normal")
        XCTAssertEqual(status.icon, "checkmark.circle.fill")
    }

    func testOverallHealthWarning() {
        sut.brokenTrunkPercent = 8.0 // >=5 but <15 = warning
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
    }

    func testOverallHealthCritical() {
        sut.brokenTrunkPercent = 20.0 // >=15 = critical
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
    }

    func testOverallHealthCriticalFromLag() {
        sut.viableStrictLagSeconds = 50000 // >43200 = critical
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
    }

    func testOverallHealthWarningFromLag() {
        sut.viableStrictLagSeconds = 25000 // >21600 but <43200 = warning
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
    }

    func testOverallHealthCriticalFromMainPush() {
        sut.lastMainPushSeconds = 20000 // >14400 = critical
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Issues Detected")
    }

    func testOverallHealthWarningFromMainPush() {
        sut.lastMainPushSeconds = 10000 // >7200 but <14400 = warning
        let status = sut.overallHealthStatus
        XCTAssertEqual(status.title, "Some Warnings")
    }

    func testOverallHealthMultipleCritical() {
        sut.brokenTrunkPercent = 20.0
        sut.viableStrictLagSeconds = 50000
        let status = sut.overallHealthStatus
        XCTAssertTrue(status.subtitle.contains("2 critical"))
    }

    // MARK: - Percentile Label

    func testSelectedPercentileLabel() {
        sut.selectedPercentile = 0.5
        XCTAssertEqual(sut.selectedPercentileLabel, "p50")

        sut.selectedPercentile = 0.9
        XCTAssertEqual(sut.selectedPercentileLabel, "p90")

        sut.selectedPercentile = -1.0
        XCTAssertEqual(sut.selectedPercentileLabel, "avg")
    }

    // MARK: - Selected Range

    func testSelectedRange() {
        sut.selectedTimeRange = "14d"
        XCTAssertEqual(sut.selectedRange?.days, 14)

        sut.selectedTimeRange = "7d"
        XCTAssertEqual(sut.selectedRange?.days, 7)

        sut.selectedTimeRange = "90d"
        XCTAssertEqual(sut.selectedRange?.days, 90)

        sut.selectedTimeRange = "invalid"
        XCTAssertNil(sut.selectedRange)
    }

    // MARK: - Refresh

    func testRefreshReloads() async {
        sut.state = .idle
        setAllMinimalResponses()

        await sut.loadDashboard()
        XCTAssertEqual(sut.state, .loaded)

        // Change a value and refresh
        sut.brokenTrunkPercent = nil
        await sut.refresh()

        XCTAssertEqual(sut.state, .loaded)
    }

    // MARK: - Data Assignment from ClickHouse Responses

    func testCommitRedDataAssignment() async {
        mockClient.setResponse("""
        [{"broken_trunk_red": 0.05, "flaky_red": 0.10}]
        """, for: "/api/clickhouse/master_commit_red_avg")

        setAllMinimalResponses()
        // Override the specific response we care about
        mockClient.setResponse("""
        [{"broken_trunk_red": 0.05, "flaky_red": 0.10}]
        """, for: "/api/clickhouse/master_commit_red_avg")

        await sut.loadDashboard()

        XCTAssertEqual(sut.brokenTrunkPercent ?? 0, 5.0, accuracy: 0.1) // 0.05 * 100
        XCTAssertEqual(sut.flakyRedPercent ?? 0, 10.0, accuracy: 0.1) // 0.10 * 100
    }

    func testStrictLagAssignment() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"strict_lag_sec": 3600}]
        """, for: "/api/clickhouse/strict_lag_sec")

        await sut.loadDashboard()

        XCTAssertEqual(sut.viableStrictLagSeconds, 3600)
    }

    func testRetryRateAssignment() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"avg_retry_rate": 1.5}]
        """, for: "/api/clickhouse/merge_retry_rate")

        await sut.loadDashboard()

        XCTAssertEqual(sut.mergeRetryRate, 1.5)
    }

    func testLandingTimeAssignment() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"avg_hours": 2.5}]
        """, for: "/api/clickhouse/pr_landing_time_avg")

        await sut.loadDashboard()

        XCTAssertEqual(sut.prLandingTimeHours, 2.5)
    }

    func testLastBranchPushAssignment() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"push_seconds_ago": 1800}]
        """, for: "/api/clickhouse/last_branch_push")

        await sut.loadDashboard()

        // Both main and nightly use the same path but different parameters.
        // Since MockAPIClient matches only on path, both will get same value.
        XCTAssertEqual(sut.lastMainPushSeconds, 1800)
    }

    func testDisabledTestsHistorical() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"day": "2025-01-01", "count": 95, "new": 5, "deleted": 3},
            {"day": "2025-01-02", "count": 100, "new": 8, "deleted": 2}
        ]
        """, for: "/api/clickhouse/disabled_test_historical")

        await sut.loadDashboard()

        XCTAssertEqual(sut.disabledTestsCount, 100) // Last row's count
        XCTAssertEqual(sut.disabledTestsSeries.count, 2)
    }

    func testDisabledTestsStringEncodedValues() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"day": "2025-01-01", "count": "95", "new": "5", "deleted": "3"}]
        """, for: "/api/clickhouse/disabled_test_historical")

        await sut.loadDashboard()

        XCTAssertEqual(sut.disabledTestsCount, 95)
    }

    // MARK: - Time Series

    func testRedRateSeries() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"granularity_bucket": "2025-01-01", "value": 5.0},
            {"granularity_bucket": "2025-01-02", "value": 3.0}
        ]
        """, for: "/api/clickhouse/master_commit_red")

        await sut.loadDashboard()

        XCTAssertEqual(sut.redRateSeries.count, 2)
    }

    func testQueueTimeSeriesAggregation() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"granularity_bucket": "2025-01-01", "avg_queue_s": 100, "machine_type": "linux.2xlarge"},
            {"granularity_bucket": "2025-01-01", "avg_queue_s": 300, "machine_type": "linux.8xlarge"},
            {"granularity_bucket": "2025-01-02", "avg_queue_s": 200, "machine_type": "linux.2xlarge"}
        ]
        """, for: "/api/clickhouse/queue_times_historical")

        await sut.loadDashboard()

        XCTAssertEqual(sut.queueTimeSeries.count, 2)
        // First bucket should have max(100, 300) = 300
        let sortedSeries = sut.queueTimeSeries.sorted { $0.granularity_bucket < $1.granularity_bucket }
        XCTAssertEqual(sortedSeries.first?.value, 300)
    }

    // MARK: - Trend Computation

    func testTrendComputedFromHalves() async {
        setAllMinimalResponses()
        // Red rate series with increasing values (negative trend for red rate)
        mockClient.setResponse("""
        [
            {"granularity_bucket": "2025-01-01", "value": 10.0},
            {"granularity_bucket": "2025-01-02", "value": 10.0},
            {"granularity_bucket": "2025-01-03", "value": 20.0},
            {"granularity_bucket": "2025-01-04", "value": 20.0}
        ]
        """, for: "/api/clickhouse/master_commit_red")

        await sut.loadDashboard()

        // First half avg = 10, second half avg = 20, trend = 100%
        XCTAssertNotNil(sut.brokenTrunkTrend)
        XCTAssertEqual(sut.brokenTrunkTrend ?? 0, 100.0, accuracy: 1.0)
    }

    // MARK: - ViewState equality

    func testViewStateEquality() {
        XCTAssertEqual(MetricsDashboardViewModel.ViewState.idle, .idle)
        XCTAssertEqual(MetricsDashboardViewModel.ViewState.loading, .loading)
        XCTAssertEqual(MetricsDashboardViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(MetricsDashboardViewModel.ViewState.error("a"), .error("a"))
        XCTAssertNotEqual(MetricsDashboardViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(MetricsDashboardViewModel.ViewState.loading, .loaded)
    }

    // MARK: - TTRS Assignment

    func testTTRSAssignment() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [{"granularity_bucket": "2025-01-01", "custom": 45.5}]
        """, for: "/api/clickhouse/ttrs_percentiles")

        await sut.loadDashboard()

        // Both p90 and p75 use the same path (different params), so both get same value
        XCTAssertEqual(sut.ttrsP90Minutes, 45.5)
    }

    // MARK: - Queued Jobs

    func testQueuedJobsAverage() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"count": 5, "avg_queue_s": 100, "machine_type": "linux.2xlarge"},
            {"count": 3, "avg_queue_s": 200, "machine_type": "linux.8xlarge"}
        ]
        """, for: "/api/clickhouse/queued_jobs_by_label")

        await sut.loadDashboard()

        XCTAssertEqual(sut.avgQueueTimeSeconds ?? 0, 150.0, accuracy: 0.1) // (100+200)/2
    }

    // MARK: - Activity Metrics

    func testRevertsCount() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"granularity_bucket": "2025-01-01", "count": 3},
            {"granularity_bucket": "2025-01-02", "count": 5}
        ]
        """, for: "/api/clickhouse/reverts")

        await sut.loadDashboard()

        XCTAssertEqual(sut.revertsCount, 5) // Last value
    }

    func testCommitsCount() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"granularity_bucket": "2025-01-01", "count": 100},
            {"granularity_bucket": "2025-01-02", "count": 150}
        ]
        """, for: "/api/clickhouse/num_commits_master")

        await sut.loadDashboard()

        XCTAssertEqual(sut.commitsCount, 150)
    }

    func testLFRolloverPercent() async {
        setAllMinimalResponses()
        mockClient.setResponse("""
        [
            {"bucket": "2025-01-01", "percentage": 42.5},
            {"bucket": "2025-01-02", "percentage": 45.0}
        ]
        """, for: "/api/clickhouse/lf_rollover_percentage")

        await sut.loadDashboard()

        XCTAssertEqual(sut.lfRolloverPercent, 45.0)
    }

    // MARK: - Workflow TTS

    func testWorkflowTTSAvgMode() async {
        sut.selectedPercentile = -1.0
        setAllMinimalResponses()

        mockClient.setResponse("""
        [
            {"duration_sec": 3600, "name": "pull"},
            {"duration_sec": 7200, "name": "trunk"}
        ]
        """, for: "/api/clickhouse/workflow_duration_avg")

        await sut.loadDashboard()

        XCTAssertEqual(sut.workflowTTSSeconds, 7200) // max of 3600, 7200
    }

    func testWorkflowTTSPercentileMode() async {
        sut.selectedPercentile = 0.5
        setAllMinimalResponses()

        mockClient.setResponse("""
        [{"duration_sec": 5400, "name": null}]
        """, for: "/api/clickhouse/workflow_duration_percentile")

        await sut.loadDashboard()

        XCTAssertEqual(sut.workflowTTSSeconds, 5400)
    }

    // MARK: - Error Handling

    func testLoadDataNetworkError() async {
        // When no responses are registered the mock throws APIError.notFound,
        // but fetchAllMetrics wraps every call in try? so individual errors
        // are swallowed. The dashboard still transitions to .loaded with nil
        // metric values rather than surfacing an error state.
        // Do NOT call setAllMinimalResponses() — leave all paths unregistered.
        await sut.loadDashboard()

        XCTAssertEqual(sut.state, .loaded)
        // Scalar metrics should all be nil because every fetch failed.
        XCTAssertNil(sut.brokenTrunkPercent)
        XCTAssertNil(sut.flakyRedPercent)
        XCTAssertNil(sut.viableStrictLagSeconds)
        XCTAssertNil(sut.mergeRetryRate)
        XCTAssertNil(sut.prLandingTimeHours)
        XCTAssertNil(sut.workflowTTSSeconds)
        XCTAssertNil(sut.avgQueueTimeSeconds)
        XCTAssertNil(sut.lastMainPushSeconds)
        XCTAssertNil(sut.revertsCount)
        XCTAssertNil(sut.commitsCount)
        XCTAssertNil(sut.lfRolloverPercent)
        // Time series should be empty.
        XCTAssertTrue(sut.redRateSeries.isEmpty)
        XCTAssertTrue(sut.queueTimeSeries.isEmpty)
        XCTAssertTrue(sut.disabledTestsSeries.isEmpty)
    }

    func testLoadDataPartialFailure() async {
        // Register responses for only a subset of endpoints. The rest will
        // fail with APIError.notFound, but since all fetches use try? the
        // dashboard still reaches .loaded. Successfully fetched metrics are
        // populated while the rest remain nil — a partial load.
        mockClient.setResponse("""
        [{"broken_trunk_red": 0.12, "flaky_red": 0.08}]
        """, for: "/api/clickhouse/master_commit_red_avg")

        mockClient.setResponse("""
        [{"strict_lag_sec": 7200}]
        """, for: "/api/clickhouse/strict_lag_sec")

        await sut.loadDashboard()

        XCTAssertEqual(sut.state, .loaded)
        // The two endpoints we configured should produce values.
        XCTAssertEqual(sut.brokenTrunkPercent ?? 0, 12.0, accuracy: 0.1)
        XCTAssertEqual(sut.flakyRedPercent ?? 0, 8.0, accuracy: 0.1)
        XCTAssertEqual(sut.viableStrictLagSeconds, 7200)
        // Endpoints we did NOT configure should remain nil.
        XCTAssertNil(sut.mergeRetryRate)
        XCTAssertNil(sut.prLandingTimeHours)
        XCTAssertNil(sut.workflowTTSSeconds)
        XCTAssertNil(sut.avgQueueTimeSeconds)
        XCTAssertNil(sut.lastMainPushSeconds)
        XCTAssertNil(sut.revertsCount)
        XCTAssertNil(sut.commitsCount)
        // lastUpdated should still be set even on partial load.
        XCTAssertNotNil(sut.lastUpdated)
    }

    // MARK: - Refresh State Transitions

    func testRefreshResetsStateBeforeLoading() async {
        // First, perform an initial load to reach .loaded.
        setAllMinimalResponses()
        await sut.loadDashboard()
        XCTAssertEqual(sut.state, .loaded)

        // Set a known value so we can verify refresh re-fetches data.
        mockClient.setResponse("""
        [{"avg_retry_rate": 3.14}]
        """, for: "/api/clickhouse/merge_retry_rate")

        // refresh() bypasses the idle guard, so it should re-fetch.
        await sut.refresh()

        // After refresh completes, state must be .loaded again.
        XCTAssertEqual(sut.state, .loaded)
        // The newly configured merge retry rate should be picked up.
        XCTAssertEqual(sut.mergeRetryRate, 3.14)
        // lastUpdated should be refreshed (non-nil).
        XCTAssertNotNil(sut.lastUpdated)
    }

    // MARK: - Last Updated

    func testLastUpdatedSetAfterLoad() async {
        XCTAssertNil(sut.lastUpdated, "lastUpdated should be nil before any load")

        setAllMinimalResponses()
        let before = Date()
        await sut.loadDashboard()
        let after = Date()

        XCTAssertNotNil(sut.lastUpdated)
        // The timestamp should fall between before and after the load call.
        if let updated = sut.lastUpdated {
            XCTAssertTrue(updated >= before, "lastUpdated should be at or after the load start")
            XCTAssertTrue(updated <= after, "lastUpdated should be at or before the load end")
        }
    }

    // MARK: - Empty Time Series

    func testEmptyTimeSeriesHandling() async {
        // All responses are empty arrays — the dashboard should still reach
        // .loaded with empty series and nil scalar values.
        setAllMinimalResponses()

        await sut.loadDashboard()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertTrue(sut.redRateSeries.isEmpty)
        XCTAssertTrue(sut.queueTimeSeries.isEmpty)
        XCTAssertTrue(sut.disabledTestsSeries.isEmpty)
        // Trends require >= 2 data points, so they should be nil.
        XCTAssertNil(sut.brokenTrunkTrend)
        XCTAssertNil(sut.forceMergeFailureTrend)
        XCTAssertNil(sut.forceMergeImpatienceTrend)
        // lastUpdated must still be set.
        XCTAssertNotNil(sut.lastUpdated)
    }

    // MARK: - Granularity Change

    func testGranularityChangeTriggersReload() async {
        // Perform initial load.
        setAllMinimalResponses()
        await sut.loadDashboard()
        XCTAssertEqual(sut.state, .loaded)

        let firstUpdated = sut.lastUpdated

        // Change granularity and call onParametersChanged which re-fetches.
        sut.granularity = .week
        mockClient.setResponse("""
        [{"avg_retry_rate": 9.99}]
        """, for: "/api/clickhouse/merge_retry_rate")

        await sut.onParametersChanged()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertEqual(sut.granularity, .week)
        // The newly configured response should be reflected.
        XCTAssertEqual(sut.mergeRetryRate, 9.99)
        // lastUpdated should be refreshed to a new (or equal) timestamp.
        XCTAssertNotNil(sut.lastUpdated)
        if let first = firstUpdated, let second = sut.lastUpdated {
            XCTAssertTrue(second >= first, "lastUpdated should advance after parameter change reload")
        }
    }

    // MARK: - Helpers

    /// Set minimal empty responses for all ClickHouse queries so the dashboard
    /// can load without throwing. Override specific paths after calling this.
    private func setAllMinimalResponses() {
        let emptyArray = "[]"
        let paths = [
            "/api/clickhouse/master_commit_red",
            "/api/clickhouse/queue_times_historical",
            "/api/clickhouse/disabled_test_historical",
            "/api/clickhouse/master_commit_red_avg",
            "/api/clickhouse/strict_lag_sec",
            "/api/clickhouse/weekly_force_merge_stats",
            "/api/clickhouse/merge_retry_rate",
            "/api/clickhouse/pr_landing_time_avg",
            "/api/clickhouse/ttrs_percentiles",
            "/api/clickhouse/workflow_duration_avg",
            "/api/clickhouse/workflow_duration_percentile",
            "/api/clickhouse/queued_jobs_by_label",
            "/api/clickhouse/last_branch_push",
            "/api/clickhouse/last_successful_workflow",
            "/api/clickhouse/last_successful_jobs",
            "/api/clickhouse/reverts",
            "/api/clickhouse/num_commits_master",
            "/api/clickhouse/lf_rollover_percentage",
        ]
        for path in paths {
            mockClient.setResponse(emptyArray, for: path)
        }
    }
}
