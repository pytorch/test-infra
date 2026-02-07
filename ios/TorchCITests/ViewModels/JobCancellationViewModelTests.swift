import XCTest
@testable import TorchCI

@MainActor
final class JobCancellationViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: JobCancellationViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = JobCancellationViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// The endpoint path used by the view model for job_cancellation_metrics.
    private let metricsPath = "/api/clickhouse/job_cancellation_metrics"

    /// Registers a full successful response JSON for the job cancellation metrics endpoint.
    private func registerFullResponse(
        totalCancellations: Int = 150,
        cancellationRate: Double = 12.5,
        timeSavedHours: Double = 320.0,
        topWorkflows: [(name: String, count: Int)] = [
            ("build-linux", 50),
            ("build-windows", 30),
            ("test-cuda", 20),
        ],
        cancellationTrend: [(date: String, value: Double)] = [
            ("2024-01-01T00:00:00Z", 10),
            ("2024-01-02T00:00:00Z", 25),
            ("2024-01-03T00:00:00Z", 15),
        ],
        timeSavedTrend: [(date: String, value: Double)] = [
            ("2024-01-01T00:00:00Z", 20.0),
            ("2024-01-02T00:00:00Z", 45.0),
        ],
        byReason: [(reason: String, count: Int, timeSavedHours: Double?)] = [
            ("Superseded by newer push", 80, 150.0),
            ("Timeout exceeded", 40, 100.0),
            ("Manual cancellation", 30, 70.0),
        ],
        recentCancellations: [(id: String, jobName: String, workflowName: String?, reason: String, cancelledAt: String?, timeSavedMinutes: Int?)] = [
            ("1", "build / linux-bionic-cuda11.8", "build-linux", "Superseded by newer push", "2024-01-03T14:30:00Z", 15),
            ("2", "test / test-cuda-distributed", nil, "Timeout exceeded", "2024-01-03T13:00:00Z", nil),
        ]
    ) {
        let workflowsJSON = topWorkflows.map { """
            {"name":"\($0.name)","count":\($0.count)}
            """
        }.joined(separator: ",")

        let trendJSON = cancellationTrend.map { """
            {"granularity_bucket":"\($0.date)","value":\($0.value)}
            """
        }.joined(separator: ",")

        let timeSavedTrendJSON = timeSavedTrend.map { """
            {"granularity_bucket":"\($0.date)","value":\($0.value)}
            """
        }.joined(separator: ",")

        let byReasonJSON = byReason.map { item -> String in
            let timeSavedStr = item.timeSavedHours.map { "\($0)" } ?? "null"
            return """
            {"reason":"\(item.reason)","count":\(item.count),"time_saved_hours":\(timeSavedStr)}
            """
        }.joined(separator: ",")

        let recentJSON = recentCancellations.map { item -> String in
            let workflowStr = item.workflowName.map { "\"\($0)\"" } ?? "null"
            let cancelledAtStr = item.cancelledAt.map { "\"\($0)\"" } ?? "null"
            let timeSavedStr = item.timeSavedMinutes.map { "\($0)" } ?? "null"
            return """
            {"id":"\(item.id)","job_name":"\(item.jobName)","workflow_name":\(workflowStr),"reason":"\(item.reason)","cancelled_at":\(cancelledAtStr),"time_saved_minutes":\(timeSavedStr)}
            """
        }.joined(separator: ",")

        let json = """
        {
            "total_cancellations": \(totalCancellations),
            "cancellation_rate": \(cancellationRate),
            "time_saved_hours": \(timeSavedHours),
            "top_workflows": [\(workflowsJSON)],
            "cancellation_trend": [\(trendJSON)],
            "time_saved_trend": [\(timeSavedTrendJSON)],
            "by_reason": [\(byReasonJSON)],
            "recent_cancellations": [\(recentJSON)]
        }
        """
        mockClient.setResponse(json, for: metricsPath)
    }

    /// Registers a minimal response with only required fields.
    private func registerMinimalResponse() {
        let json = "{}"
        mockClient.setResponse(json, for: metricsPath)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.totalCancellations, 0)
        XCTAssertEqual(viewModel.cancellationRate, "N/A")
        XCTAssertEqual(viewModel.timeSaved, "N/A")
        XCTAssertEqual(viewModel.avgPerDay, "N/A")
        XCTAssertEqual(viewModel.costSavings, "N/A")
        XCTAssertEqual(viewModel.peakDayCancellations, "N/A")
        XCTAssertTrue(viewModel.topCancelledWorkflows.isEmpty)
        XCTAssertTrue(viewModel.cancellationTrend.isEmpty)
        XCTAssertTrue(viewModel.timeSavedTrend.isEmpty)
        XCTAssertTrue(viewModel.cancellationsByReason.isEmpty)
        XCTAssertTrue(viewModel.recentCancellations.isEmpty)
    }

    // MARK: - Load Data Success

    func testLoadDataSuccessPopulatesAllFields() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCancellations, 150)
        XCTAssertEqual(viewModel.cancellationRate, "12.5%")
        XCTAssertEqual(viewModel.timeSaved, "320 hrs")
        XCTAssertEqual(viewModel.avgPerDay, "21")  // 150 / 7 = 21.4 rounded to 21
        XCTAssertEqual(viewModel.costSavings, "$160")  // 320 * $0.50 = $160
        XCTAssertEqual(viewModel.peakDayCancellations, "25")  // max of trend values
    }

    func testLoadDataPopulatesTopWorkflows() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topCancelledWorkflows.count, 3)
        XCTAssertEqual(viewModel.topCancelledWorkflows[0].name, "build-linux")
        XCTAssertEqual(viewModel.topCancelledWorkflows[0].count, 50)
        XCTAssertEqual(viewModel.topCancelledWorkflows[1].name, "build-windows")
        XCTAssertEqual(viewModel.topCancelledWorkflows[1].count, 30)
        XCTAssertEqual(viewModel.topCancelledWorkflows[2].name, "test-cuda")
        XCTAssertEqual(viewModel.topCancelledWorkflows[2].count, 20)
    }

    func testLoadDataPopulatesCancellationTrend() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.cancellationTrend.count, 3)
        XCTAssertEqual(viewModel.cancellationTrend[0].value, 10)
        XCTAssertEqual(viewModel.cancellationTrend[1].value, 25)
        XCTAssertEqual(viewModel.cancellationTrend[2].value, 15)
    }

    func testLoadDataPopulatesTimeSavedTrend() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.timeSavedTrend.count, 2)
        XCTAssertEqual(viewModel.timeSavedTrend[0].value, 20.0)
        XCTAssertEqual(viewModel.timeSavedTrend[1].value, 45.0)
    }

    func testLoadDataPopulatesCancellationsByReason() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.cancellationsByReason.count, 3)

        // Reasons should be present (order depends on API response, not sorted here)
        let reasons = Set(viewModel.cancellationsByReason.map(\.reason))
        XCTAssertTrue(reasons.contains("Superseded by newer push"))
        XCTAssertTrue(reasons.contains("Timeout exceeded"))
        XCTAssertTrue(reasons.contains("Manual cancellation"))

        // Check percentage calculation: 80/(80+40+30) = 53.3%
        let superseded = viewModel.cancellationsByReason.first { $0.reason == "Superseded by newer push" }
        XCTAssertNotNil(superseded)
        XCTAssertEqual(superseded?.count, 80)
        XCTAssertNotNil(superseded?.percentage)
        if let pct = superseded?.percentage {
            XCTAssertEqual(pct, 53.33, accuracy: 0.1)
        }
        XCTAssertEqual(superseded?.timeSavedHours, 150.0)
    }

    func testLoadDataPopulatesRecentCancellations() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.recentCancellations.count, 2)

        let first = viewModel.recentCancellations[0]
        XCTAssertEqual(first.id, "1")
        XCTAssertEqual(first.jobName, "build / linux-bionic-cuda11.8")
        XCTAssertEqual(first.workflowName, "build-linux")
        XCTAssertEqual(first.reason, "Superseded by newer push")
        XCTAssertEqual(first.cancelledAt, "2024-01-03T14:30:00Z")
        XCTAssertEqual(first.timeSavedMinutes, 15)

        let second = viewModel.recentCancellations[1]
        XCTAssertEqual(second.id, "2")
        XCTAssertNil(second.workflowName)
        XCTAssertNil(second.timeSavedMinutes)
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: metricsPath)

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataNotFoundSetsErrorState() async {
        // No response registered, MockAPIClient throws notFound
        await viewModel.loadData()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Minimal / Null Response

    func testLoadDataWithMinimalResponseHandlesNils() async {
        registerMinimalResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCancellations, 0)
        XCTAssertEqual(viewModel.cancellationRate, "N/A")
        XCTAssertEqual(viewModel.timeSaved, "0 hrs")
        XCTAssertEqual(viewModel.avgPerDay, "N/A")
        XCTAssertEqual(viewModel.costSavings, "N/A")
        XCTAssertEqual(viewModel.peakDayCancellations, "N/A")
        XCTAssertTrue(viewModel.topCancelledWorkflows.isEmpty)
        XCTAssertTrue(viewModel.cancellationTrend.isEmpty)
        XCTAssertTrue(viewModel.timeSavedTrend.isEmpty)
        XCTAssertTrue(viewModel.cancellationsByReason.isEmpty)
        XCTAssertTrue(viewModel.recentCancellations.isEmpty)
    }

    func testLoadDataWithNullFieldsHandledGracefully() async {
        let json = """
        {
            "total_cancellations": null,
            "cancellation_rate": null,
            "time_saved_hours": null,
            "top_workflows": null,
            "cancellation_trend": null,
            "time_saved_trend": null,
            "by_reason": null,
            "recent_cancellations": null
        }
        """
        mockClient.setResponse(json, for: metricsPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCancellations, 0)
        XCTAssertEqual(viewModel.cancellationRate, "N/A")
        XCTAssertEqual(viewModel.costSavings, "N/A")
        XCTAssertTrue(viewModel.topCancelledWorkflows.isEmpty)
        XCTAssertTrue(viewModel.cancellationsByReason.isEmpty)
        XCTAssertTrue(viewModel.recentCancellations.isEmpty)
    }

    // MARK: - Time Saved Formatting

    func testTimeSavedFormattingSmallHours() async {
        registerFullResponse(timeSavedHours: 42.0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.timeSaved, "42 hrs")
    }

    func testTimeSavedFormattingLargeHours() async {
        registerFullResponse(timeSavedHours: 2500.0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.timeSaved, "2.5K hrs")
    }

    func testTimeSavedFormattingZeroHours() async {
        registerFullResponse(timeSavedHours: 0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.timeSaved, "0 hrs")
    }

    // MARK: - Cost Savings Calculation

    func testCostSavingsSmallAmount() async {
        registerFullResponse(timeSavedHours: 100.0)

        await viewModel.loadData()

        // 100 * $0.50 = $50
        XCTAssertEqual(viewModel.costSavings, "$50")
    }

    func testCostSavingsLargeAmount() async {
        registerFullResponse(timeSavedHours: 5000.0)

        await viewModel.loadData()

        // 5000 * $0.50 = $2500 -> $2.5K
        XCTAssertEqual(viewModel.costSavings, "$2.5K")
    }

    func testCostSavingsZeroHours() async {
        registerFullResponse(timeSavedHours: 0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costSavings, "N/A")
    }

    // MARK: - Average Per Day

    func testAvgPerDayCalculation() async {
        registerFullResponse(totalCancellations: 70)

        await viewModel.loadData()

        // 70 / 7 days = 10
        XCTAssertEqual(viewModel.avgPerDay, "10")
    }

    func testAvgPerDayZeroCancellations() async {
        registerFullResponse(totalCancellations: 0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.avgPerDay, "N/A")
    }

    // MARK: - Peak Day Cancellations

    func testPeakDayFromTrend() async {
        registerFullResponse(
            cancellationTrend: [
                ("2024-01-01T00:00:00Z", 5),
                ("2024-01-02T00:00:00Z", 42),
                ("2024-01-03T00:00:00Z", 18),
            ]
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.peakDayCancellations, "42")
    }

    func testPeakDayWithEmptyTrend() async {
        registerFullResponse(cancellationTrend: [])

        await viewModel.loadData()

        XCTAssertEqual(viewModel.peakDayCancellations, "N/A")
    }

    // MARK: - Cancellation Rate Formatting

    func testCancellationRateFormatting() async {
        registerFullResponse(cancellationRate: 8.756)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.cancellationRate, "8.8%")
    }

    func testCancellationRateWholeNumber() async {
        registerFullResponse(cancellationRate: 10.0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.cancellationRate, "10.0%")
    }

    // MARK: - Time Range Selection

    func testSelectTimeRangeUpdatesProperty() {
        viewModel.selectTimeRange("14d")

        XCTAssertEqual(viewModel.selectedTimeRange, "14d")
    }

    func testSelectSameTimeRangeNoOp() {
        // Default is "7d", selecting same range should not trigger load
        let initialCallCount = mockClient.callCount
        viewModel.selectTimeRange("7d")

        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(mockClient.callCount, initialCallCount)
    }

    func testSelectDifferentTimeRangeTriggersLoad() async {
        registerFullResponse()

        viewModel.selectTimeRange("30d")

        // Give the Task time to start
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
        XCTAssertGreaterThanOrEqual(mockClient.callCount, 1)
        XCTAssertTrue(mockClient.callPaths().contains(metricsPath))
    }

    func testSelectTimeRange1Day() async {
        registerFullResponse(totalCancellations: 10)

        viewModel.selectTimeRange("1d")

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(viewModel.selectedTimeRange, "1d")
        // 10 cancellations / 1 day = 10 avg per day
        XCTAssertEqual(viewModel.avgPerDay, "10")
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerFullResponse()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, metricsPath)
    }

    func testRefreshAfterErrorRecovers() async {
        // First load: error
        mockClient.setError(APIError.serverError(500), for: metricsPath)
        await viewModel.loadData()
        XCTAssertTrue(viewModel.state != .loaded)

        // Now register successful response and refresh
        mockClient.errors.removeAll()
        registerFullResponse()
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCancellations, 150)
    }

    // MARK: - API Endpoint Verification

    func testLoadDataCallsCorrectEndpoint() async {
        registerFullResponse()

        await viewModel.loadData()

        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, metricsPath)

        // Verify method is GET (clickhouseQuery uses GET)
        let call = mockClient.recordedCalls.first
        XCTAssertEqual(call?.method, "GET")
    }

    // MARK: - Top Workflows Sorting

    func testTopWorkflowsSortedByCountDescending() async {
        registerFullResponse(topWorkflows: [
            ("low-count", 5),
            ("high-count", 100),
            ("mid-count", 50),
        ])

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topCancelledWorkflows.count, 3)
        XCTAssertEqual(viewModel.topCancelledWorkflows[0].name, "high-count")
        XCTAssertEqual(viewModel.topCancelledWorkflows[0].count, 100)
        XCTAssertEqual(viewModel.topCancelledWorkflows[1].name, "mid-count")
        XCTAssertEqual(viewModel.topCancelledWorkflows[1].count, 50)
        XCTAssertEqual(viewModel.topCancelledWorkflows[2].name, "low-count")
        XCTAssertEqual(viewModel.topCancelledWorkflows[2].count, 5)
    }

    // MARK: - By Reason Percentage Calculation

    func testByReasonPercentagesAddUpTo100() async {
        registerFullResponse(byReason: [
            ("Reason A", 25, nil),
            ("Reason B", 50, nil),
            ("Reason C", 25, nil),
        ])

        await viewModel.loadData()

        let totalPercentage = viewModel.cancellationsByReason.compactMap(\.percentage).reduce(0, +)
        XCTAssertEqual(totalPercentage, 100.0, accuracy: 0.1)

        let reasonA = viewModel.cancellationsByReason.first { $0.reason == "Reason A" }
        XCTAssertEqual(reasonA?.percentage, 25.0, accuracy: 0.1)

        let reasonB = viewModel.cancellationsByReason.first { $0.reason == "Reason B" }
        XCTAssertEqual(reasonB?.percentage, 50.0, accuracy: 0.1)
    }

    func testByReasonWithZeroTotalCountHandled() async {
        registerFullResponse(byReason: [
            ("Empty", 0, nil),
        ])

        await viewModel.loadData()

        XCTAssertEqual(viewModel.cancellationsByReason.count, 1)
        // 0/0 should result in nil percentage (total is 0)
        XCTAssertNil(viewModel.cancellationsByReason.first?.percentage)
    }

    // MARK: - Recent Cancellations Defaults

    func testRecentCancellationDefaultsForMissingFields() async {
        let json = """
        {
            "recent_cancellations": [
                {"id":null,"job_name":null,"workflow_name":null,"reason":null,"cancelled_at":null,"time_saved_minutes":null}
            ]
        }
        """
        mockClient.setResponse(json, for: metricsPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.recentCancellations.count, 1)
        let item = viewModel.recentCancellations[0]
        // id should be a generated UUID
        XCTAssertFalse(item.id.isEmpty)
        // jobName should default to "Unknown Job"
        XCTAssertEqual(item.jobName, "Unknown Job")
        // reason should default to empty string
        XCTAssertEqual(item.reason, "")
        XCTAssertNil(item.workflowName)
        XCTAssertNil(item.cancelledAt)
        XCTAssertNil(item.timeSavedMinutes)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(JobCancellationViewModel.ViewState.idle, .idle)
        XCTAssertEqual(JobCancellationViewModel.ViewState.loading, .loading)
        XCTAssertEqual(JobCancellationViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(JobCancellationViewModel.ViewState.error("test"), .error("test"))
        XCTAssertNotEqual(JobCancellationViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(JobCancellationViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(JobCancellationViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - Loading State Transition

    func testLoadDataSetsLoadingStateDuringFetch() async {
        // Use a delay to observe intermediate state
        mockClient.artificialDelayNanoseconds = 100_000_000 // 0.1 seconds
        registerFullResponse()

        let task = Task {
            await viewModel.loadData()
        }

        // Small delay to let loadData start
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state, .loading)

        await task.value

        XCTAssertEqual(viewModel.state, .loaded)
    }
}
