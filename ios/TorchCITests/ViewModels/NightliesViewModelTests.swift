import XCTest
@testable import TorchCI

@MainActor
final class NightliesViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: NightliesViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = NightliesViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Register successful empty responses for all 10 nightly endpoints.
    private func registerAllEmptyResponses() {
        // Trend endpoints (3 repos)
        mockClient.setResponse("[]", for: "/api/clickhouse/nightly_jobs_red")

        // Failed jobs past day (3 repos)
        mockClient.setResponse("[]", for: "/api/clickhouse/nightly_jobs_red_past_day")

        // Platform breakdown
        mockClient.setResponse("[]", for: "/api/clickhouse/nightly_jobs_red_by_platform")

        // Failed by name
        mockClient.setResponse("[]", for: "/api/clickhouse/nightly_jobs_red_by_name")

        // Validation jobs (2 channels)
        mockClient.setResponse("[]", for: "/api/clickhouse/validation_jobs_red_past_day")
    }

    /// Register trend data for a specific repo.
    private func registerTrendResponse(points: [(bucket: String, red: Double)]) {
        let jsonArray = points.map { point in
            #"{"granularity_bucket":"\#(point.bucket)","red":\#(point.red)}"#
        }
        let json = "[\(jsonArray.joined(separator: ","))]"
        mockClient.setResponse(json, for: "/api/clickhouse/nightly_jobs_red")
    }

    /// Register failed jobs response (used for past day, by name, and validation).
    private func registerFailedJobsResponse(path: String, jobs: [(name: String, count: Int)]) {
        let jsonArray = jobs.map { job in
            #"{"name":"\#(job.name)","COUNT":\#(job.count)}"#
        }
        let json = "[\(jsonArray.joined(separator: ","))]"
        mockClient.setResponse(json, for: path)
    }

    /// Register platform breakdown response.
    private func registerPlatformResponse(platforms: [(platform: String, count: Int)]) {
        let jsonArray = platforms.map { p in
            #"{"Platform":"\#(p.platform)","Count":\#(p.count)}"#
        }
        let json = "[\(jsonArray.joined(separator: ","))]"
        mockClient.setResponse(json, for: "/api/clickhouse/nightly_jobs_red_by_platform")
    }

    /// Register a full set of realistic mock data.
    private func registerRealisticData() {
        // Trends: 3 days of data for each repo
        registerTrendResponse(points: [
            (bucket: "2026-02-04T00:00:00Z", red: 0.05),
            (bucket: "2026-02-05T00:00:00Z", red: 0.08),
            (bucket: "2026-02-06T00:00:00Z", red: 0.03),
        ])

        // Failed jobs past day for each repo
        registerFailedJobsResponse(
            path: "/api/clickhouse/nightly_jobs_red_past_day",
            jobs: [
                (name: "manywheel-py3_10-cuda11_8-build", count: 5),
                (name: "libtorch-linux-x64-build", count: 3),
            ]
        )

        // Platform breakdown
        registerPlatformResponse(platforms: [
            (platform: "manywheel", count: 12),
            (platform: "libtorch", count: 8),
            (platform: "conda", count: 4),
        ])

        // Failed by name
        registerFailedJobsResponse(
            path: "/api/clickhouse/nightly_jobs_red_by_name",
            jobs: [
                (name: "manywheel-py3_10-cuda11_8-build", count: 15),
                (name: "conda-linux-py3_10-build", count: 7),
            ]
        )

        // Validation jobs
        registerFailedJobsResponse(
            path: "/api/clickhouse/validation_jobs_red_past_day",
            jobs: [
                (name: "validate-release-linux-x64", count: 2),
            ]
        )
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.pytorchTrend.isEmpty)
        XCTAssertTrue(viewModel.visionTrend.isEmpty)
        XCTAssertTrue(viewModel.audioTrend.isEmpty)
        XCTAssertTrue(viewModel.pytorchFailedJobs.isEmpty)
        XCTAssertTrue(viewModel.visionFailedJobs.isEmpty)
        XCTAssertTrue(viewModel.audioFailedJobs.isEmpty)
        XCTAssertTrue(viewModel.platformBreakdown.isEmpty)
        XCTAssertTrue(viewModel.releaseValidationJobs.isEmpty)
        XCTAssertTrue(viewModel.nightlyValidationJobs.isEmpty)
        XCTAssertTrue(viewModel.failedJobsByName.isEmpty)
        XCTAssertNil(viewModel.lastUpdated)
        XCTAssertEqual(viewModel.selectedTimeRange, .oneWeek)
    }

    func testDefaultTimeRangeIsOneWeek() {
        XCTAssertEqual(viewModel.selectedTimeRange, .oneWeek)
        XCTAssertEqual(viewModel.selectedTimeRange.days, 7)
        XCTAssertEqual(viewModel.selectedTimeRange.label, "1 Week")
        XCTAssertEqual(viewModel.selectedTimeRange.shortLabel, "7d")
    }

    // MARK: - Load Data Success

    func testLoadDataSuccessWithEmptyResponses() async {
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.pytorchTrend.isEmpty)
        XCTAssertTrue(viewModel.pytorchFailedJobs.isEmpty)
        XCTAssertTrue(viewModel.platformBreakdown.isEmpty)
        XCTAssertTrue(viewModel.failedJobsByName.isEmpty)
        XCTAssertNotNil(viewModel.lastUpdated)
    }

    func testLoadDataSuccessPopulatesAllData() async {
        registerRealisticData()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)

        // All three repos get the same trend data (same path pattern)
        XCTAssertEqual(viewModel.pytorchTrend.count, 3)
        XCTAssertEqual(viewModel.visionTrend.count, 3)
        XCTAssertEqual(viewModel.audioTrend.count, 3)

        // All three repos get the same failed jobs
        XCTAssertEqual(viewModel.pytorchFailedJobs.count, 2)
        XCTAssertEqual(viewModel.visionFailedJobs.count, 2)
        XCTAssertEqual(viewModel.audioFailedJobs.count, 2)

        // Platform breakdown
        XCTAssertEqual(viewModel.platformBreakdown.count, 3)
        XCTAssertEqual(viewModel.platformBreakdown.first?.platform, "manywheel")
        XCTAssertEqual(viewModel.platformBreakdown.first?.count, 12)

        // Failed by name
        XCTAssertEqual(viewModel.failedJobsByName.count, 2)

        // Validation
        XCTAssertEqual(viewModel.releaseValidationJobs.count, 1)
        XCTAssertEqual(viewModel.nightlyValidationJobs.count, 1)

        // Last updated set
        XCTAssertNotNil(viewModel.lastUpdated)
    }

    func testLoadDataSetsLoadingState() async {
        registerAllEmptyResponses()

        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        // After load completes it should be loaded, not loading
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadDataSetsLastUpdatedTimestamp() async {
        registerAllEmptyResponses()

        XCTAssertNil(viewModel.lastUpdated)

        let before = Date()
        await viewModel.loadData()
        let after = Date()

        XCTAssertNotNil(viewModel.lastUpdated)
        if let ts = viewModel.lastUpdated {
            XCTAssertTrue(ts >= before && ts <= after)
        }
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/nightly_jobs_red")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataNotFoundSetsErrorState() async {
        // Don't register any responses -- MockAPIClient throws .notFound by default
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataErrorDoesNotSetLastUpdated() async {
        // No responses registered -> will error
        await viewModel.loadData()

        XCTAssertNil(viewModel.lastUpdated)
    }

    // MARK: - Refresh

    func testRefreshReloadsAllData() async {
        registerAllEmptyResponses()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        // refresh() calls loadData() which hits all 10 endpoints
        // (but due to path reuse with the mock, we get fewer unique paths)
        XCTAssertGreaterThanOrEqual(mockClient.callCount, 10)
    }

    func testRefreshUpdatesLastUpdated() async {
        registerAllEmptyResponses()

        await viewModel.loadData()
        let firstUpdate = viewModel.lastUpdated

        // Small delay to ensure timestamps differ
        try? await Task.sleep(nanoseconds: 10_000_000)

        await viewModel.refresh()
        let secondUpdate = viewModel.lastUpdated

        XCTAssertNotNil(firstUpdate)
        XCTAssertNotNil(secondUpdate)
        // Second update should be same or after first
        if let first = firstUpdate, let second = secondUpdate {
            XCTAssertTrue(second >= first)
        }
    }

    // MARK: - Time Range

    func testTimeRangeOptions() {
        let allCases = NightliesViewModel.TimeRangeOption.allCases
        XCTAssertEqual(allCases.count, 5)

        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneDay.days, 1)
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.threeDays.days, 3)
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneWeek.days, 7)
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.twoWeeks.days, 14)
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneMonth.days, 30)
    }

    func testTimeRangeLabels() {
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneDay.label, "1 Day")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.threeDays.label, "3 Days")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneWeek.label, "1 Week")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.twoWeeks.label, "2 Weeks")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneMonth.label, "1 Month")
    }

    func testTimeRangeShortLabels() {
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneDay.shortLabel, "1d")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.threeDays.shortLabel, "3d")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneWeek.shortLabel, "7d")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.twoWeeks.shortLabel, "14d")
        XCTAssertEqual(NightliesViewModel.TimeRangeOption.oneMonth.shortLabel, "30d")
    }

    func testChangingTimeRangeUpdatesProperty() {
        viewModel.selectedTimeRange = .oneDay
        XCTAssertEqual(viewModel.selectedTimeRange, .oneDay)

        viewModel.selectedTimeRange = .oneMonth
        XCTAssertEqual(viewModel.selectedTimeRange, .oneMonth)
    }

    func testTimeRangeIdentifiable() {
        // Each option should have a unique ID
        let ids = Set(NightliesViewModel.TimeRangeOption.allCases.map(\.id))
        XCTAssertEqual(ids.count, 5)
    }

    // MARK: - Overall Health Computed Properties

    func testOverallHealthPercentageWithNoData() {
        // No trends loaded -> all health values = 0 -> 100% pass rate
        XCTAssertEqual(viewModel.overallHealthPercentage, "100")
    }

    func testOverallHealthPercentageWithLowFailure() async {
        // 3% failure rate on last day for pytorch -> overall avg = 0.03 / 3 = 0.01
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.03),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // pytorchHealthValue = 0.03, vision = 0, audio = 0
        // avg = 0.01, pass = 99%
        XCTAssertEqual(viewModel.overallHealthPercentage, "99")
    }

    func testOverallHealthColorGreen() {
        // No data -> average = 0 < 0.05 -> green
        XCTAssertEqual(viewModel.overallHealthColor, .green)
    }

    func testOverallHealthStatusOperational() {
        // No data -> average = 0 < 0.05 -> operational
        XCTAssertEqual(viewModel.overallHealthStatus, "All systems operational")
    }

    func testOverallHealthIconCheckmark() {
        // No data -> average = 0 < 0.05 -> checkmark
        XCTAssertEqual(viewModel.overallHealthIcon, "checkmark.circle.fill")
    }

    func testAverageFailureRateNoData() {
        XCTAssertEqual(viewModel.averageFailureRate, 0.0)
    }

    // MARK: - Individual Health

    func testPytorchHealthPercentageNoData() {
        // No trend data -> health value = 0 -> 100%
        XCTAssertEqual(viewModel.pytorchHealthPercentage, "100%")
    }

    func testPytorchHealthColorNoData() {
        // No data -> 0 < 0.05 -> green
        XCTAssertEqual(viewModel.pytorchHealthColor, .green)
    }

    func testVisionHealthPercentageNoData() {
        XCTAssertEqual(viewModel.visionHealthPercentage, "100%")
    }

    func testVisionHealthColorNoData() {
        XCTAssertEqual(viewModel.visionHealthColor, .green)
    }

    func testAudioHealthPercentageNoData() {
        XCTAssertEqual(viewModel.audioHealthPercentage, "100%")
    }

    func testAudioHealthColorNoData() {
        XCTAssertEqual(viewModel.audioHealthColor, .green)
    }

    func testHealthColorYellowRange() async {
        // 10% failure rate -> yellow range (0.05 <= x < 0.15)
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.10),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // pytorchHealthValue = 0.10 -> yellow
        XCTAssertEqual(viewModel.pytorchHealthColor, .yellow)
    }

    func testHealthColorRedRange() async {
        // 20% failure rate -> red range (>= 0.15)
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.20),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // pytorchHealthValue = 0.20 -> red
        XCTAssertEqual(viewModel.pytorchHealthColor, .red)
    }

    func testHealthPercentageWithHighFailureRate() async {
        // 50% failure rate -> 50% pass rate
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.50),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchHealthPercentage, "50%")
    }

    func testHealthUsesLastTrendPoint() async {
        // Multiple trend points - health should use the last one
        registerTrendResponse(points: [
            (bucket: "2026-02-04T00:00:00Z", red: 0.50),
            (bucket: "2026-02-05T00:00:00Z", red: 0.30),
            (bucket: "2026-02-06T00:00:00Z", red: 0.02),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // Last point: 0.02 -> 98% pass, color green
        XCTAssertEqual(viewModel.pytorchHealthPercentage, "98%")
        XCTAssertEqual(viewModel.pytorchHealthColor, .green)
    }

    // MARK: - Computed Properties

    func testTotalFailedJobCountEmpty() {
        XCTAssertEqual(viewModel.totalFailedJobCount, 0)
    }

    func testTotalFailedJobCountWithData() async {
        registerRealisticData()
        await viewModel.loadData()

        // Each repo gets 2 failed jobs from mock = 6 total
        XCTAssertEqual(viewModel.totalFailedJobCount, 6)
    }

    func testMaxPlatformCountEmpty() {
        XCTAssertEqual(viewModel.maxPlatformCount, 0)
    }

    func testMaxPlatformCountWithData() async {
        registerRealisticData()
        await viewModel.loadData()

        // The max platform count should be 12 (manywheel)
        XCTAssertEqual(viewModel.maxPlatformCount, 12)
    }

    // MARK: - API Endpoints Called

    func testLoadDataCallsAllExpectedEndpoints() async {
        registerAllEmptyResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()

        // Should call 10 endpoints: 3 trend + 3 failed + 1 platform + 1 byName + 2 validation
        XCTAssertEqual(mockClient.callCount, 10)

        // Trend endpoints (3x nightly_jobs_red)
        let trendCalls = paths.filter { $0 == "/api/clickhouse/nightly_jobs_red" }
        XCTAssertEqual(trendCalls.count, 3)

        // Failed jobs past day (3x)
        let failedCalls = paths.filter { $0 == "/api/clickhouse/nightly_jobs_red_past_day" }
        XCTAssertEqual(failedCalls.count, 3)

        // Platform breakdown (1x)
        let platformCalls = paths.filter { $0 == "/api/clickhouse/nightly_jobs_red_by_platform" }
        XCTAssertEqual(platformCalls.count, 1)

        // Failed by name (1x)
        let byNameCalls = paths.filter { $0 == "/api/clickhouse/nightly_jobs_red_by_name" }
        XCTAssertEqual(byNameCalls.count, 1)

        // Validation jobs (2x)
        let validationCalls = paths.filter { $0 == "/api/clickhouse/validation_jobs_red_past_day" }
        XCTAssertEqual(validationCalls.count, 2)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(NightliesViewModel.ViewState.idle, .idle)
        XCTAssertEqual(NightliesViewModel.ViewState.loading, .loading)
        XCTAssertEqual(NightliesViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(NightliesViewModel.ViewState.error("test"), .error("test"))
    }

    func testViewStateInequality() {
        XCTAssertNotEqual(NightliesViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(NightliesViewModel.ViewState.idle, .loaded)
        XCTAssertNotEqual(NightliesViewModel.ViewState.idle, .error("test"))
        XCTAssertNotEqual(NightliesViewModel.ViewState.error("a"), .error("b"))
    }

    // MARK: - Overall Health Thresholds

    func testOverallHealthMultipleFailures() async {
        // All three repos at 20% failure -> avg = 0.20 > 0.15 -> red/multiple failures
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.20),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // avg = (0.20 + 0.20 + 0.20) / 3 = 0.20
        XCTAssertEqual(viewModel.overallHealthColor, .red)
        XCTAssertEqual(viewModel.overallHealthStatus, "Multiple failures")
        XCTAssertEqual(viewModel.overallHealthIcon, "xmark.circle.fill")
    }

    func testOverallHealthSomeIssues() async {
        // All three repos at 10% -> avg = 0.10, which is 0.05..0.15 -> yellow
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.10),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.overallHealthColor, .yellow)
        XCTAssertEqual(viewModel.overallHealthStatus, "Some issues detected")
        XCTAssertEqual(viewModel.overallHealthIcon, "exclamationmark.triangle.fill")
    }

    func testOverallHealthOperational() async {
        // All three repos at 2% -> avg = 0.02 < 0.05 -> green
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.02),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.overallHealthColor, .green)
        XCTAssertEqual(viewModel.overallHealthStatus, "All systems operational")
        XCTAssertEqual(viewModel.overallHealthIcon, "checkmark.circle.fill")
    }

    // MARK: - Edge Cases

    func testLoadDataWithSingleTrendPoint() async {
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.15),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchTrend.count, 1)
        XCTAssertEqual(viewModel.pytorchTrend.first?.failureRate, 0.15)
    }

    func testLoadDataWithZeroFailureRate() async {
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 0.0),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchHealthPercentage, "100%")
        XCTAssertEqual(viewModel.pytorchHealthColor, .green)
    }

    func testLoadDataWithFullFailureRate() async {
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 1.0),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchHealthPercentage, "0%")
        XCTAssertEqual(viewModel.pytorchHealthColor, .red)
    }

    func testOverallHealthPercentageWithFullFailure() async {
        registerTrendResponse(points: [
            (bucket: "2026-02-06T00:00:00Z", red: 1.0),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        // avg = (1.0 + 1.0 + 1.0) / 3 = 1.0 -> pass = 0%
        XCTAssertEqual(viewModel.overallHealthPercentage, "0")
    }

    // MARK: - Trend Data Parsing

    func testTrendDataParsesCorrectly() async {
        registerTrendResponse(points: [
            (bucket: "2026-02-04T00:00:00Z", red: 0.05),
            (bucket: "2026-02-05T00:00:00Z", red: 0.12),
        ])
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchTrend.count, 2)
        XCTAssertEqual(viewModel.pytorchTrend[0].failureRate, 0.05)
        XCTAssertEqual(viewModel.pytorchTrend[1].failureRate, 0.12)
    }

    func testFailedJobsParseName() async {
        registerAllEmptyResponses()
        registerFailedJobsResponse(
            path: "/api/clickhouse/nightly_jobs_red_past_day",
            jobs: [
                (name: "test-job-with-special-chars_v2.1", count: 42),
            ]
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.pytorchFailedJobs.first?.name, "test-job-with-special-chars_v2.1")
        XCTAssertEqual(viewModel.pytorchFailedJobs.first?.count, 42)
    }

    func testPlatformBreakdownParsesCorrectly() async {
        registerAllEmptyResponses()
        registerPlatformResponse(platforms: [
            (platform: "manywheel", count: 25),
            (platform: "conda", count: 10),
        ])

        await viewModel.loadData()

        XCTAssertEqual(viewModel.platformBreakdown.count, 2)
        XCTAssertEqual(viewModel.platformBreakdown[0].platform, "manywheel")
        XCTAssertEqual(viewModel.platformBreakdown[0].count, 25)
        XCTAssertEqual(viewModel.platformBreakdown[1].platform, "conda")
        XCTAssertEqual(viewModel.platformBreakdown[1].count, 10)
    }
}
