import XCTest
@testable import TorchCI

@MainActor
final class VLLMMetricsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: VLLMMetricsViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = VLLMMetricsViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// All vLLM clickhouse query names used by the ViewModel.
    private static let allQueryNames: [String] = [
        "vllm%2Fci_reliability",
        "vllm%2Ftrunk_health",
        "vllm%2Fci_run_duration",
        "vllm%2Fmerges_percentage",
        "vllm%2Fpr_cycle_time_breakdown",
        "vllm%2Frebuild_rate",
        "vllm%2Ftrunk_recovery_time",
        "vllm%2Fqueue_per_build_windowed",
        "vllm%2Fcontinuous_builds",
        "vllm%2Fjob_list",
        "vllm%2Fdocker_build_runtime",
        "vllm%2Fjob_runtime_trends",
    ]

    /// Register empty array responses for all endpoints so loadData() succeeds.
    private func registerAllEmptyResponses() {
        for name in Self.allQueryNames {
            mockClient.setResponse("[]", for: "/api/clickhouse/\(name)")
        }
    }

    /// Register a JSON response for a given vLLM clickhouse query name.
    private func registerResponse(_ json: String, forQuery name: String) {
        let encodedName = name.replacingOccurrences(of: "/", with: "%2F")
        mockClient.setResponse(json, for: "/api/clickhouse/\(encodedName)")
    }

    /// Register an error for a given vLLM clickhouse query name.
    private func registerError(_ error: Error, forQuery name: String) {
        let encodedName = name.replacingOccurrences(of: "/", with: "%2F")
        mockClient.setError(error, for: "/api/clickhouse/\(encodedName)")
    }

    // MARK: - Initial State

    func testInitialStateDefaults() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedTab, 0)
        XCTAssertEqual(viewModel.selectedJobGroups, ["amd", "torch_nightly", "main"])
    }

    func testInitialStateKeyMetricsAreNil() {
        XCTAssertNil(viewModel.trunkHealthPercent)
        XCTAssertNil(viewModel.trunkHealthDelta)
        XCTAssertNil(viewModel.ciStabilityScore)
        XCTAssertNil(viewModel.ciStabilityDelta)
        XCTAssertNil(viewModel.commitsOnRedPercent)
        XCTAssertNil(viewModel.commitsOnRedDelta)
        XCTAssertNil(viewModel.forceMergePercent)
        XCTAssertNil(viewModel.forceMergeDelta)
        XCTAssertNil(viewModel.ciSuccessP50)
        XCTAssertNil(viewModel.ciSuccessP50Delta)
        XCTAssertNil(viewModel.ciSuccessP90)
        XCTAssertNil(viewModel.ciSuccessP90Delta)
    }

    func testInitialStateReliabilityMetricsAreNil() {
        XCTAssertNil(viewModel.overallSuccessRate)
        XCTAssertNil(viewModel.overallSuccessDelta)
        XCTAssertNil(viewModel.totalFailedBuilds)
        XCTAssertNil(viewModel.totalFailedDelta)
        XCTAssertNil(viewModel.stateTransitions)
        XCTAssertNil(viewModel.retryRate)
        XCTAssertNil(viewModel.avgRecoveryHours)
        XCTAssertTrue(viewModel.reliabilitySeries.isEmpty)
        XCTAssertTrue(viewModel.trunkHealthSeries.isEmpty)
        XCTAssertTrue(viewModel.retryRateSeries.isEmpty)
    }

    func testInitialStateDurationMetricsAreNil() {
        XCTAssertNil(viewModel.ciNonCancelP50)
        XCTAssertNil(viewModel.ciNonCancelP90)
        XCTAssertTrue(viewModel.ciDurationSeries.isEmpty)
        XCTAssertTrue(viewModel.timeToSignalSeries.isEmpty)
        XCTAssertTrue(viewModel.dockerBuildRuntimeSeries.isEmpty)
    }

    func testInitialStateSourceControlMetricsAreNil() {
        XCTAssertNil(viewModel.manualMergePercent)
        XCTAssertNil(viewModel.totalMerges)
        XCTAssertNil(viewModel.autoMerges)
        XCTAssertNil(viewModel.forceMerges)
        XCTAssertNil(viewModel.timeToReviewP50)
        XCTAssertNil(viewModel.timeToReviewP90)
        XCTAssertNil(viewModel.timeToApprovalP50)
        XCTAssertNil(viewModel.timeToApprovalP90)
        XCTAssertNil(viewModel.mergeQueueP50)
        XCTAssertNil(viewModel.mergeQueueP90)
        XCTAssertTrue(viewModel.forceMergeSeries.isEmpty)
        XCTAssertTrue(viewModel.mergeTrendSeries.isEmpty)
    }

    func testInitialStateUtilizationAndBuildsEmpty() {
        XCTAssertTrue(viewModel.queuePerBuildData.isEmpty)
        XCTAssertTrue(viewModel.continuousBuildsData.isEmpty)
        XCTAssertTrue(viewModel.jobListData.isEmpty)
        XCTAssertTrue(viewModel.jobRuntimeTrendsData.isEmpty)
    }

    // MARK: - Tab Selection

    func testDefaultTabIsZero() {
        XCTAssertEqual(viewModel.selectedTab, 0)
    }

    func testTabSelectionChanges() {
        viewModel.selectedTab = 1
        XCTAssertEqual(viewModel.selectedTab, 1)

        viewModel.selectedTab = 2
        XCTAssertEqual(viewModel.selectedTab, 2)

        viewModel.selectedTab = 3
        XCTAssertEqual(viewModel.selectedTab, 3)

        viewModel.selectedTab = 4
        XCTAssertEqual(viewModel.selectedTab, 4)
    }

    func testTabSelectionBackToZero() {
        viewModel.selectedTab = 3
        XCTAssertEqual(viewModel.selectedTab, 3)

        viewModel.selectedTab = 0
        XCTAssertEqual(viewModel.selectedTab, 0)
    }

    // MARK: - Time Range Selection

    func testDefaultTimeRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Week")
    }

    func testTimeRangeChangeTo14d() {
        viewModel.selectedTimeRange = "14d"
        XCTAssertEqual(viewModel.selectedTimeRange, "14d")
        XCTAssertEqual(viewModel.selectedRange?.days, 14)
    }

    func testTimeRangeChangeTo30d() {
        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    func testInvalidTimeRangeReturnsNilSelectedRange() {
        viewModel.selectedTimeRange = "invalid"
        XCTAssertNil(viewModel.selectedRange)
    }

    func testTimeRangeChangeTriggersRefetch() async {
        registerAllEmptyResponses()

        viewModel.selectedTimeRange = "30d"
        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    // MARK: - Job Group Filtering

    func testDefaultJobGroups() {
        XCTAssertEqual(viewModel.selectedJobGroups, ["amd", "torch_nightly", "main"])
    }

    func testJobGroupRemoval() {
        viewModel.selectedJobGroups.removeAll { $0 == "amd" }
        XCTAssertEqual(viewModel.selectedJobGroups, ["torch_nightly", "main"])
    }

    func testJobGroupAddition() {
        viewModel.selectedJobGroups.append("custom_group")
        XCTAssertTrue(viewModel.selectedJobGroups.contains("custom_group"))
        XCTAssertEqual(viewModel.selectedJobGroups.count, 4)
    }

    // MARK: - Loading State Transitions

    func testLoadDataTransitionsToLoaded() async {
        registerAllEmptyResponses()

        XCTAssertEqual(viewModel.state, .loading)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadDataWithEmptyResponsesSucceeds() async {
        registerAllEmptyResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.reliabilitySeries.isEmpty)
        XCTAssertTrue(viewModel.trunkHealthSeries.isEmpty)
        XCTAssertTrue(viewModel.ciDurationSeries.isEmpty)
    }

    func testRefreshCallsFetchAllData() async {
        registerAllEmptyResponses()

        await viewModel.refresh()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testOnParametersChangedCallsFetchAllData() async {
        registerAllEmptyResponses()

        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    // MARK: - Error Handling

    func testLoadDataSetsErrorStateWhenCriticalEndpointFails() async {
        // fetchAllData wraps critical endpoints in `try await` (not try?),
        // so errors on reliability/trunkHealth/etc. cause .error state.
        // Register all empty first, then override a critical one with error.
        registerAllEmptyResponses()
        registerError(APIError.serverError(500), forQuery: "vllm/ci_reliability")

        await viewModel.loadData()

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataSetsErrorStateWhenTrunkHealthFails() async {
        registerAllEmptyResponses()
        registerError(APIError.networkError(URLError(.notConnectedToInternet)), forQuery: "vllm/trunk_health")

        await viewModel.loadData()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataSucceedsWhenNonCriticalEndpointFails() async {
        // Non-critical endpoints (queue_per_build, continuous_builds, job_list, docker_build_runtime,
        // job_runtime_trends) use try? so their failure should not prevent .loaded state.
        registerAllEmptyResponses()
        registerError(APIError.serverError(500), forQuery: "vllm/queue_per_build_windowed")
        registerError(APIError.serverError(500), forQuery: "vllm/continuous_builds")
        registerError(APIError.serverError(500), forQuery: "vllm/job_list")
        registerError(APIError.serverError(500), forQuery: "vllm/docker_build_runtime")
        registerError(APIError.serverError(500), forQuery: "vllm/job_runtime_trends")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.queuePerBuildData.isEmpty)
        XCTAssertTrue(viewModel.continuousBuildsData.isEmpty)
        XCTAssertTrue(viewModel.jobListData.isEmpty)
    }

    // MARK: - ViewState Equality

    func testViewStateLoadingEquality() {
        let a = VLLMMetricsViewModel.ViewState.loading
        let b = VLLMMetricsViewModel.ViewState.loading
        XCTAssertEqual(a, b)
    }

    func testViewStateLoadedEquality() {
        let a = VLLMMetricsViewModel.ViewState.loaded
        let b = VLLMMetricsViewModel.ViewState.loaded
        XCTAssertEqual(a, b)
    }

    func testViewStateErrorEquality() {
        let a = VLLMMetricsViewModel.ViewState.error("oops")
        let b = VLLMMetricsViewModel.ViewState.error("oops")
        XCTAssertEqual(a, b)
    }

    func testViewStateDifferentErrorsNotEqual() {
        let a = VLLMMetricsViewModel.ViewState.error("a")
        let b = VLLMMetricsViewModel.ViewState.error("b")
        XCTAssertNotEqual(a, b)
    }

    func testViewStateDifferentKindsNotEqual() {
        let a = VLLMMetricsViewModel.ViewState.loading
        let b = VLLMMetricsViewModel.ViewState.loaded
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Process Reliability

    func testProcessReliabilityComputesSuccessRate() {
        let data: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-01", passed_count: 80, failed_count: 10, canceled_count: 10, total_count: 100, non_canceled_count: 90, success_rate: 0.889),
            .init(granularity_bucket: "2024-01-02", passed_count: 90, failed_count: 5, canceled_count: 5, total_count: 100, non_canceled_count: 95, success_rate: 0.947),
        ]
        let prev: [VLLMMetricsViewModel.ReliabilityRow] = []

        viewModel.processReliability(data, prev: prev)

        // totalPassed = 170, totalNonCanceled = 185
        // successRate = 170/185 * 100 = ~91.89
        XCTAssertNotNil(viewModel.overallSuccessRate)
        XCTAssertEqual(viewModel.overallSuccessRate!, 170.0 / 185.0 * 100, accuracy: 0.01)
        XCTAssertEqual(viewModel.totalFailedBuilds, 15)
    }

    func testProcessReliabilityComputesDelta() {
        let data: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-03", passed_count: 90, failed_count: 5, canceled_count: 5, total_count: 100, non_canceled_count: 95, success_rate: 0.947),
        ]
        let prev: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-01", passed_count: 70, failed_count: 20, canceled_count: 10, total_count: 100, non_canceled_count: 90, success_rate: 0.778),
        ]

        viewModel.processReliability(data, prev: prev)

        // current = 90/95 * 100 = 94.74%
        // prevRate = 70/90 = 0.7778
        // delta = (0.9474 - 0.7778) * 100 = ~16.96
        XCTAssertNotNil(viewModel.overallSuccessDelta)
        XCTAssertGreaterThan(viewModel.overallSuccessDelta!, 0)
    }

    func testProcessReliabilityComputesFailedDelta() {
        let data: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-03", passed_count: 90, failed_count: 10, canceled_count: 0, total_count: 100, non_canceled_count: 100, success_rate: 0.9),
        ]
        let prev: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-01", passed_count: 80, failed_count: 20, canceled_count: 0, total_count: 100, non_canceled_count: 100, success_rate: 0.8),
        ]

        viewModel.processReliability(data, prev: prev)

        // totalFailed = 10, prevFailed = 20
        // totalFailedDelta = (10 - 20) / 20 * 100 = -50
        XCTAssertEqual(viewModel.totalFailedDelta!, -50.0, accuracy: 0.01)
    }

    func testProcessReliabilityPopulatesSeries() {
        let data: [VLLMMetricsViewModel.ReliabilityRow] = [
            .init(granularity_bucket: "2024-01-01", passed_count: 80, failed_count: 10, canceled_count: 10, total_count: 100, non_canceled_count: 90, success_rate: 0.889),
            .init(granularity_bucket: "2024-01-02", passed_count: 95, failed_count: 3, canceled_count: 2, total_count: 100, non_canceled_count: 98, success_rate: 0.969),
        ]

        viewModel.processReliability(data, prev: [])

        XCTAssertEqual(viewModel.reliabilitySeries.count, 2)
        // success_rate * 100
        XCTAssertEqual(viewModel.reliabilitySeries[0].value!, 88.9, accuracy: 0.01)
        XCTAssertEqual(viewModel.reliabilitySeries[1].value!, 96.9, accuracy: 0.01)
    }

    func testProcessReliabilityWithEmptyData() {
        viewModel.processReliability([], prev: [])

        XCTAssertNil(viewModel.overallSuccessRate)
        // totalFailedBuilds is computed via reduce which returns 0 for empty data
        XCTAssertEqual(viewModel.totalFailedBuilds, 0)
        XCTAssertTrue(viewModel.reliabilitySeries.isEmpty)
    }

    // MARK: - Process Trunk Health

    func testProcessTrunkHealthComputesPercentage() {
        let data: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 1, build_started_at: "2024-01-01T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 2, build_started_at: "2024-01-01T12:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 3, build_started_at: "2024-01-02T10:00:00", build_state: "failed", hard_failure_count: 3, is_green: 0),
            .init(build_number: 4, build_started_at: "2024-01-03T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
        ]

        viewModel.processTrunkHealth(data, prev: [])

        // 3 days: 2024-01-01 (last build green), 2024-01-02 (not green), 2024-01-03 (green)
        // 2 green out of 3 = 66.67%
        XCTAssertNotNil(viewModel.trunkHealthPercent)
        XCTAssertEqual(viewModel.trunkHealthPercent!, 2.0 / 3.0 * 100, accuracy: 0.01)

        // commitsOnRed = 1/3 * 100 = 33.33%
        XCTAssertNotNil(viewModel.commitsOnRedPercent)
        XCTAssertEqual(viewModel.commitsOnRedPercent!, 1.0 / 3.0 * 100, accuracy: 0.01)
    }

    func testProcessTrunkHealthComputesCIStability() {
        // All green: stability should be high
        let data: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 1, build_started_at: "2024-01-01T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 2, build_started_at: "2024-01-02T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 3, build_started_at: "2024-01-03T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
        ]

        viewModel.processTrunkHealth(data, prev: [])

        // All green, no transitions, no volatility => stability = 100
        XCTAssertNotNil(viewModel.ciStabilityScore)
        XCTAssertEqual(viewModel.ciStabilityScore!, 100.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.stateTransitions, 0)
    }

    func testProcessTrunkHealthComputesStateTransitions() {
        // Alternating green/red: high transitions, lower stability
        let data: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 1, build_started_at: "2024-01-01T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 2, build_started_at: "2024-01-02T10:00:00", build_state: "failed", hard_failure_count: 2, is_green: 0),
            .init(build_number: 3, build_started_at: "2024-01-03T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 4, build_started_at: "2024-01-04T10:00:00", build_state: "failed", hard_failure_count: 1, is_green: 0),
        ]

        viewModel.processTrunkHealth(data, prev: [])

        // 4 days, alternating: green, red, green, red => 3 transitions
        XCTAssertEqual(viewModel.stateTransitions, 3)
        XCTAssertNotNil(viewModel.ciStabilityScore)
        XCTAssertLessThan(viewModel.ciStabilityScore!, 100.0)
    }

    func testProcessTrunkHealthPopulatesSeries() {
        let data: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 1, build_started_at: "2024-01-01T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 2, build_started_at: "2024-01-02T10:00:00", build_state: "failed", hard_failure_count: 2, is_green: 0),
        ]

        viewModel.processTrunkHealth(data, prev: [])

        XCTAssertEqual(viewModel.trunkHealthSeries.count, 2)
        // Series values should be 100 for green days and 0 for red days
        let sorted = viewModel.trunkHealthSeries.sorted { $0.granularity_bucket < $1.granularity_bucket }
        XCTAssertEqual(sorted[0].value, 100)
        XCTAssertEqual(sorted[1].value, 0)
    }

    func testProcessTrunkHealthComputesDelta() {
        let data: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 1, build_started_at: "2024-01-01T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 2, build_started_at: "2024-01-02T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
        ]
        let prev: [VLLMMetricsViewModel.TrunkHealthRow] = [
            .init(build_number: 10, build_started_at: "2023-12-30T10:00:00", build_state: "passed", hard_failure_count: 0, is_green: 1),
            .init(build_number: 11, build_started_at: "2023-12-31T10:00:00", build_state: "failed", hard_failure_count: 1, is_green: 0),
        ]

        viewModel.processTrunkHealth(data, prev: prev)

        // current: 100% green (2/2), prev: 50% green (1/2)
        // delta = 100 - 50 = +50
        XCTAssertNotNil(viewModel.trunkHealthDelta)
        XCTAssertEqual(viewModel.trunkHealthDelta!, 50.0, accuracy: 0.01)
    }

    func testProcessTrunkHealthWithEmptyData() {
        viewModel.processTrunkHealth([], prev: [])

        XCTAssertNil(viewModel.trunkHealthPercent)
        XCTAssertNil(viewModel.commitsOnRedPercent)
        XCTAssertTrue(viewModel.trunkHealthSeries.isEmpty)
    }

    // MARK: - Process CI Durations

    func testProcessCIDurationsComputesPercentiles() {
        let data: [VLLMMetricsViewModel.CIDurationRow] = [
            .init(pipeline_name: "CI", build_number: 1, started_at: "2024-01-01T10:00:00", finished_at: "2024-01-01T11:00:00", build_state: "passed", duration_seconds: 3600, duration_hours: 1.0),
            .init(pipeline_name: "CI", build_number: 2, started_at: "2024-01-01T12:00:00", finished_at: "2024-01-01T14:00:00", build_state: "passed", duration_seconds: 7200, duration_hours: 2.0),
            .init(pipeline_name: "CI", build_number: 3, started_at: "2024-01-01T15:00:00", finished_at: "2024-01-01T18:00:00", build_state: "passed", duration_seconds: 10800, duration_hours: 3.0),
            .init(pipeline_name: "CI", build_number: 4, started_at: "2024-01-01T19:00:00", finished_at: "2024-01-01T19:30:00", build_state: "canceled", duration_seconds: 1800, duration_hours: 0.5),
        ]

        viewModel.processCIDurations(data, prev: [])

        // Success durations sorted: [1.0, 2.0, 3.0]
        // P50: index = floor(2 * 0.5) = 1 => 2.0
        // P90: index = floor(2 * 0.9) = 1 => 2.0
        XCTAssertNotNil(viewModel.ciSuccessP50)
        XCTAssertEqual(viewModel.ciSuccessP50!, 2.0, accuracy: 0.01)
        XCTAssertNotNil(viewModel.ciSuccessP90)
        XCTAssertEqual(viewModel.ciSuccessP90!, 2.0, accuracy: 0.01)

        // Non-canceled durations sorted: [1.0, 2.0, 3.0]
        XCTAssertNotNil(viewModel.ciNonCancelP50)
        XCTAssertNotNil(viewModel.ciNonCancelP90)
    }

    func testProcessCIDurationsPopulatesSeries() {
        let data: [VLLMMetricsViewModel.CIDurationRow] = [
            .init(pipeline_name: "CI", build_number: 1, started_at: "2024-01-01T10:00:00", finished_at: "2024-01-01T11:00:00", build_state: "passed", duration_seconds: 3600, duration_hours: 1.0),
        ]

        viewModel.processCIDurations(data, prev: [])

        XCTAssertEqual(viewModel.ciDurationSeries.count, 1)
        XCTAssertEqual(viewModel.ciDurationSeries[0].value, 3600.0)

        // timeToSignalSeries only includes "passed" builds, hours converted to seconds
        XCTAssertEqual(viewModel.timeToSignalSeries.count, 1)
        XCTAssertEqual(viewModel.timeToSignalSeries[0].value, 3600.0)
    }

    func testProcessCIDurationsComputesDelta() {
        let data: [VLLMMetricsViewModel.CIDurationRow] = [
            .init(pipeline_name: "CI", build_number: 1, started_at: "2024-01-02T10:00:00", finished_at: "2024-01-02T12:00:00", build_state: "passed", duration_seconds: 7200, duration_hours: 2.0),
        ]
        let prev: [VLLMMetricsViewModel.CIDurationRow] = [
            .init(pipeline_name: "CI", build_number: 1, started_at: "2024-01-01T10:00:00", finished_at: "2024-01-01T11:00:00", build_state: "passed", duration_seconds: 3600, duration_hours: 1.0),
        ]

        viewModel.processCIDurations(data, prev: prev)

        // current P50 = 2.0, prev P50 = 1.0
        // delta = (2.0 - 1.0) / 1.0 * 100 = 100%
        XCTAssertNotNil(viewModel.ciSuccessP50Delta)
        XCTAssertEqual(viewModel.ciSuccessP50Delta!, 100.0, accuracy: 0.01)
    }

    func testProcessCIDurationsWithEmptyData() {
        viewModel.processCIDurations([], prev: [])

        XCTAssertNil(viewModel.ciSuccessP50)
        XCTAssertNil(viewModel.ciSuccessP90)
        XCTAssertNil(viewModel.ciNonCancelP50)
        XCTAssertNil(viewModel.ciNonCancelP90)
        XCTAssertTrue(viewModel.ciDurationSeries.isEmpty)
        XCTAssertTrue(viewModel.timeToSignalSeries.isEmpty)
    }

    // MARK: - Process Merges

    func testProcessMergesComputesPercentages() {
        let data: [VLLMMetricsViewModel.MergeRow] = [
            .init(granularity_bucket: "2024-01-01", total_count: 10, auto_merged_count: 6, manual_merged_count: 4, manual_merged_with_failures_count: 2),
            .init(granularity_bucket: "2024-01-02", total_count: 10, auto_merged_count: 8, manual_merged_count: 2, manual_merged_with_failures_count: 1),
        ]

        viewModel.processMerges(data, prev: [])

        // manualMerged = 6, autoMerged = 14, total = 20
        // forceMerged = 3
        XCTAssertEqual(viewModel.totalMerges, 20)
        XCTAssertEqual(viewModel.autoMerges, 14)
        XCTAssertEqual(viewModel.forceMerges, 3)
        XCTAssertNotNil(viewModel.manualMergePercent)
        XCTAssertEqual(viewModel.manualMergePercent!, 6.0 / 20.0 * 100, accuracy: 0.01)
        XCTAssertNotNil(viewModel.forceMergePercent)
        XCTAssertEqual(viewModel.forceMergePercent!, 3.0 / 20.0 * 100, accuracy: 0.01)
    }

    func testProcessMergesPopulatesSeries() {
        let data: [VLLMMetricsViewModel.MergeRow] = [
            .init(granularity_bucket: "2024-01-01", total_count: 10, auto_merged_count: 6, manual_merged_count: 4, manual_merged_with_failures_count: 2),
        ]

        viewModel.processMerges(data, prev: [])

        XCTAssertEqual(viewModel.forceMergeSeries.count, 1)
        XCTAssertEqual(viewModel.forceMergeSeries[0].value, 2.0)

        XCTAssertEqual(viewModel.mergeTrendSeries.count, 1)
        // mergeTrend = manual + auto = 4 + 6 = 10
        XCTAssertEqual(viewModel.mergeTrendSeries[0].value, 10.0)
    }

    func testProcessMergesWithEmptyData() {
        viewModel.processMerges([], prev: [])

        XCTAssertNil(viewModel.manualMergePercent)
        XCTAssertNil(viewModel.forceMergePercent)
        XCTAssertEqual(viewModel.totalMerges, 0)
        XCTAssertEqual(viewModel.autoMerges, 0)
        XCTAssertEqual(viewModel.forceMerges, 0)
    }

    // MARK: - Process PR Cycle

    func testProcessPRCyclePopulatesValues() {
        let data: [VLLMMetricsViewModel.PRCycleRow] = [
            .init(
                time_to_first_review_p50: 2.5,
                time_to_first_review_p90: 8.0,
                time_to_approval_p50: 4.0,
                time_to_approval_p90: 12.0,
                time_in_merge_queue_p50: 1.0,
                time_in_merge_queue_p90: 3.0
            ),
        ]

        viewModel.processPRCycle(data, prev: [])

        XCTAssertEqual(viewModel.timeToReviewP50, 2.5)
        XCTAssertEqual(viewModel.timeToReviewP90, 8.0)
        XCTAssertEqual(viewModel.timeToApprovalP50, 4.0)
        XCTAssertEqual(viewModel.timeToApprovalP90, 12.0)
        XCTAssertEqual(viewModel.mergeQueueP50, 1.0)
        XCTAssertEqual(viewModel.mergeQueueP90, 3.0)
    }

    func testProcessPRCycleComputesDeltas() {
        let data: [VLLMMetricsViewModel.PRCycleRow] = [
            .init(
                time_to_first_review_p50: 3.0,
                time_to_first_review_p90: 10.0,
                time_to_approval_p50: 6.0,
                time_to_approval_p90: 15.0,
                time_in_merge_queue_p50: 2.0,
                time_in_merge_queue_p90: 5.0
            ),
        ]
        let prev: [VLLMMetricsViewModel.PRCycleRow] = [
            .init(
                time_to_first_review_p50: 2.0,
                time_to_first_review_p90: 8.0,
                time_to_approval_p50: 4.0,
                time_to_approval_p90: 10.0,
                time_in_merge_queue_p50: 1.0,
                time_in_merge_queue_p90: 4.0
            ),
        ]

        viewModel.processPRCycle(data, prev: prev)

        // timeToReviewP50Delta = (3.0 - 2.0) / 2.0 * 100 = 50%
        XCTAssertNotNil(viewModel.timeToReviewP50Delta)
        XCTAssertEqual(viewModel.timeToReviewP50Delta!, 50.0, accuracy: 0.01)
        // mergeQueueP50Delta = (2.0 - 1.0) / 1.0 * 100 = 100%
        XCTAssertNotNil(viewModel.mergeQueueP50Delta)
        XCTAssertEqual(viewModel.mergeQueueP50Delta!, 100.0, accuracy: 0.01)
    }

    func testProcessPRCycleWithEmptyData() {
        viewModel.processPRCycle([], prev: [])

        XCTAssertNil(viewModel.timeToReviewP50)
        XCTAssertNil(viewModel.timeToReviewP90)
        XCTAssertNil(viewModel.timeToApprovalP50)
        XCTAssertNil(viewModel.timeToApprovalP90)
        XCTAssertNil(viewModel.mergeQueueP50)
        XCTAssertNil(viewModel.mergeQueueP90)
    }

    // MARK: - Process Retry Rate

    func testProcessRetryRateComputesRate() {
        let data: [VLLMMetricsViewModel.RetryRateRow] = [
            .init(granularity_bucket: "2024-01-01", total_jobs: 100, retried_count: 5, retry_rate: 0.05),
            .init(granularity_bucket: "2024-01-02", total_jobs: 200, retried_count: 10, retry_rate: 0.05),
        ]

        viewModel.processRetryRate(data)

        // totalJobs = 300, totalRetries = 15
        // retryRate = 15/300 * 100 = 5.0%
        XCTAssertNotNil(viewModel.retryRate)
        XCTAssertEqual(viewModel.retryRate!, 5.0, accuracy: 0.01)
    }

    func testProcessRetryRatePopulatesSeries() {
        let data: [VLLMMetricsViewModel.RetryRateRow] = [
            .init(granularity_bucket: "2024-01-01", total_jobs: 100, retried_count: 3, retry_rate: 0.03),
            .init(granularity_bucket: "2024-01-02", total_jobs: 100, retried_count: 7, retry_rate: 0.07),
        ]

        viewModel.processRetryRate(data)

        XCTAssertEqual(viewModel.retryRateSeries.count, 2)
        // retry_rate * 100
        XCTAssertEqual(viewModel.retryRateSeries[0].value!, 3.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.retryRateSeries[1].value!, 7.0, accuracy: 0.01)
    }

    func testProcessRetryRateWithEmptyData() {
        viewModel.processRetryRate([])

        XCTAssertNil(viewModel.retryRate)
        XCTAssertTrue(viewModel.retryRateSeries.isEmpty)
    }

    // MARK: - Process Trunk Recovery

    func testProcessTrunkRecoveryComputesAverage() {
        let data: [VLLMMetricsViewModel.TrunkRecoveryRow] = [
            .init(recovery_sha: "abc123", recovery_time: "2024-01-01T12:00:00", recovery_hours: 6.0),
            .init(recovery_sha: "def456", recovery_time: "2024-01-02T12:00:00", recovery_hours: 12.0),
        ]

        viewModel.processTrunkRecovery(data)

        XCTAssertNotNil(viewModel.avgRecoveryHours)
        XCTAssertEqual(viewModel.avgRecoveryHours!, 9.0, accuracy: 0.01)
    }

    func testProcessTrunkRecoveryWithEmptyData() {
        viewModel.processTrunkRecovery([])

        XCTAssertNil(viewModel.avgRecoveryHours)
    }

    // MARK: - Percentile Helper

    func testPercentileWithEmptyArray() {
        XCTAssertNil(viewModel.percentile([], 0.5))
    }

    func testPercentileP50() {
        let sorted = [1.0, 2.0, 3.0, 4.0, 5.0]
        // index = floor(4 * 0.5) = 2 => value = 3.0
        XCTAssertEqual(viewModel.percentile(sorted, 0.5), 3.0)
    }

    func testPercentileP90() {
        let sorted = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
        // index = floor(9 * 0.9) = 8 => value = 9.0
        XCTAssertEqual(viewModel.percentile(sorted, 0.9), 9.0)
    }

    func testPercentileSingleElement() {
        let sorted = [42.0]
        XCTAssertEqual(viewModel.percentile(sorted, 0.5), 42.0)
        XCTAssertEqual(viewModel.percentile(sorted, 0.9), 42.0)
    }

    // MARK: - Full Load Data with Reliability Data

    func testLoadDataPopulatesReliabilityMetrics() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"granularity_bucket":"2024-01-01","passed_count":85,"failed_count":10,"canceled_count":5,"total_count":100,"non_canceled_count":95,"success_rate":0.894},
            {"granularity_bucket":"2024-01-02","passed_count":90,"failed_count":5,"canceled_count":5,"total_count":100,"non_canceled_count":95,"success_rate":0.947}
        ]
        """, forQuery: "vllm/ci_reliability")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.overallSuccessRate)
        XCTAssertEqual(viewModel.totalFailedBuilds, 15)
        XCTAssertEqual(viewModel.reliabilitySeries.count, 2)
    }

    // MARK: - Full Load Data with Trunk Health Data

    func testLoadDataPopulatesTrunkHealthMetrics() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"build_number":100,"build_started_at":"2024-01-01T10:00:00","build_state":"passed","hard_failure_count":0,"is_green":1},
            {"build_number":101,"build_started_at":"2024-01-02T10:00:00","build_state":"failed","hard_failure_count":3,"is_green":0}
        ]
        """, forQuery: "vllm/trunk_health")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.trunkHealthPercent)
        XCTAssertEqual(viewModel.trunkHealthPercent!, 50.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.trunkHealthSeries.count, 2)
    }

    // MARK: - Full Load Data with Continuous Builds

    func testLoadDataPopulatesContinuousBuilds() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"build_number":200,"build_state":"passed","started_at":"2024-01-01T10:00:00"},
            {"build_number":201,"build_state":"failed","started_at":"2024-01-02T10:00:00"}
        ]
        """, forQuery: "vllm/continuous_builds")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.continuousBuildsData.count, 2)
        XCTAssertEqual(viewModel.continuousBuildsData[0].buildNumber, 200)
        XCTAssertEqual(viewModel.continuousBuildsData[0].buildState, "passed")
        XCTAssertEqual(viewModel.continuousBuildsData[1].buildState, "failed")
    }

    // MARK: - Full Load Data with Queue Per Build

    func testLoadDataPopulatesQueuePerBuild() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"build_number":300,"started_at":"2024-01-01T10:00:00","gpu_1_queue_wait_p90_hours":0.5,"gpu_4_queue_wait_p90_hours":1.2,"cpu_queue_wait_p90_hours":0.1,"total_cost_dollars":350.0}
        ]
        """, forQuery: "vllm/queue_per_build_windowed")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.queuePerBuildData.count, 1)
        XCTAssertEqual(viewModel.queuePerBuildData[0].buildNumber, 300)
        XCTAssertEqual(viewModel.queuePerBuildData[0].gpu1QueueWaitP90Hours, 0.5, accuracy: 0.01)
        XCTAssertEqual(viewModel.queuePerBuildData[0].totalCostDollars, 350.0, accuracy: 0.01)
    }

    // MARK: - Full Load Data with Job List

    func testLoadDataPopulatesJobList() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"job_name":"test-gpu-a100","build_count":42},
            {"job_name":"lint","build_count":100}
        ]
        """, forQuery: "vllm/job_list")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.jobListData.count, 2)
        XCTAssertEqual(viewModel.jobListData[0].jobName, "test-gpu-a100")
        XCTAssertEqual(viewModel.jobListData[0].buildCount, 42)
    }

    // MARK: - API Endpoint Paths

    func testLoadDataCallsCorrectEndpoints() async {
        registerAllEmptyResponses()

        await viewModel.loadData()

        let pathSet = Set(mockClient.callPaths())
        // Each query is called twice (current + previous) for critical queries
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fci_reliability"), "Missing ci_reliability")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Ftrunk_health"), "Missing trunk_health")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fci_run_duration"), "Missing ci_run_duration")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fmerges_percentage"), "Missing merges_percentage")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fpr_cycle_time_breakdown"), "Missing pr_cycle_time_breakdown")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Frebuild_rate"), "Missing rebuild_rate")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Ftrunk_recovery_time"), "Missing trunk_recovery_time")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fqueue_per_build_windowed"), "Missing queue_per_build_windowed")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fcontinuous_builds"), "Missing continuous_builds")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fjob_list"), "Missing job_list")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fdocker_build_runtime"), "Missing docker_build_runtime")
        XCTAssertTrue(pathSet.contains("/api/clickhouse/vllm%2Fjob_runtime_trends"), "Missing job_runtime_trends")
    }

    func testLoadDataCallsCurrentAndPreviousEndpoints() async {
        registerAllEmptyResponses()

        await viewModel.loadData()

        // Queries that have both current + prev should appear twice
        let reliabilityCalls = mockClient.callPaths().filter { $0 == "/api/clickhouse/vllm%2Fci_reliability" }
        XCTAssertEqual(reliabilityCalls.count, 2, "ci_reliability should be called twice (current + prev)")

        let trunkHealthCalls = mockClient.callPaths().filter { $0 == "/api/clickhouse/vllm%2Ftrunk_health" }
        XCTAssertEqual(trunkHealthCalls.count, 2, "trunk_health should be called twice (current + prev)")
    }

    // MARK: - Docker Build Runtime

    func testLoadDataPopulatesDockerBuildRuntime() async {
        registerAllEmptyResponses()

        registerResponse("""
        [
            {"started_at":"2024-01-01T10:00:00","duration_seconds":1800.0},
            {"started_at":"2024-01-02T10:00:00","duration_seconds":2400.0}
        ]
        """, forQuery: "vllm/docker_build_runtime")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.dockerBuildRuntimeSeries.count, 2)
        XCTAssertEqual(viewModel.dockerBuildRuntimeSeries[0].value, 1800.0)
        XCTAssertEqual(viewModel.dockerBuildRuntimeSeries[1].value, 2400.0)
    }
}

// MARK: - Decodable Row Test Initializers

extension VLLMMetricsViewModel.ReliabilityRow {
    init(granularity_bucket: String, passed_count: Int, failed_count: Int, canceled_count: Int, total_count: Int, non_canceled_count: Int, success_rate: Double?) {
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.ReliabilityRow.self,
            from: JSONSerialization.data(withJSONObject: [
                "granularity_bucket": granularity_bucket,
                "passed_count": passed_count,
                "failed_count": failed_count,
                "canceled_count": canceled_count,
                "total_count": total_count,
                "non_canceled_count": non_canceled_count,
                "success_rate": success_rate as Any,
            ])
        )
    }
}

extension VLLMMetricsViewModel.TrunkHealthRow {
    init(build_number: Int, build_started_at: String, build_state: String, hard_failure_count: Int, is_green: Int) {
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.TrunkHealthRow.self,
            from: JSONSerialization.data(withJSONObject: [
                "build_number": build_number,
                "build_started_at": build_started_at,
                "build_state": build_state,
                "hard_failure_count": hard_failure_count,
                "is_green": is_green,
            ])
        )
    }
}

extension VLLMMetricsViewModel.CIDurationRow {
    init(pipeline_name: String?, build_number: Int, started_at: String, finished_at: String, build_state: String, duration_seconds: Int, duration_hours: Double) {
        var dict: [String: Any] = [
            "build_number": build_number,
            "started_at": started_at,
            "finished_at": finished_at,
            "build_state": build_state,
            "duration_seconds": duration_seconds,
            "duration_hours": duration_hours,
        ]
        if let pipeline_name {
            dict["pipeline_name"] = pipeline_name
        }
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.CIDurationRow.self,
            from: JSONSerialization.data(withJSONObject: dict)
        )
    }
}

extension VLLMMetricsViewModel.MergeRow {
    init(granularity_bucket: String, total_count: Int?, auto_merged_count: Int?, manual_merged_count: Int?, manual_merged_with_failures_count: Int?) {
        var dict: [String: Any] = ["granularity_bucket": granularity_bucket]
        if let total_count { dict["total_count"] = total_count }
        if let auto_merged_count { dict["auto_merged_count"] = auto_merged_count }
        if let manual_merged_count { dict["manual_merged_count"] = manual_merged_count }
        if let manual_merged_with_failures_count { dict["manual_merged_with_failures_count"] = manual_merged_with_failures_count }
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.MergeRow.self,
            from: JSONSerialization.data(withJSONObject: dict)
        )
    }
}

extension VLLMMetricsViewModel.PRCycleRow {
    init(time_to_first_review_p50: Double?, time_to_first_review_p90: Double?, time_to_approval_p50: Double?, time_to_approval_p90: Double?, time_in_merge_queue_p50: Double?, time_in_merge_queue_p90: Double?) {
        var dict: [String: Any] = [:]
        if let v = time_to_first_review_p50 { dict["time_to_first_review_p50"] = v }
        if let v = time_to_first_review_p90 { dict["time_to_first_review_p90"] = v }
        if let v = time_to_approval_p50 { dict["time_to_approval_p50"] = v }
        if let v = time_to_approval_p90 { dict["time_to_approval_p90"] = v }
        if let v = time_in_merge_queue_p50 { dict["time_in_merge_queue_p50"] = v }
        if let v = time_in_merge_queue_p90 { dict["time_in_merge_queue_p90"] = v }
        if dict.isEmpty { dict["_placeholder"] = true }
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.PRCycleRow.self,
            from: JSONSerialization.data(withJSONObject: dict)
        )
    }
}

extension VLLMMetricsViewModel.RetryRateRow {
    init(granularity_bucket: String, total_jobs: Int, retried_count: Int, retry_rate: Double?) {
        var dict: [String: Any] = [
            "granularity_bucket": granularity_bucket,
            "total_jobs": total_jobs,
            "retried_count": retried_count,
        ]
        if let retry_rate { dict["retry_rate"] = retry_rate }
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.RetryRateRow.self,
            from: JSONSerialization.data(withJSONObject: dict)
        )
    }
}

extension VLLMMetricsViewModel.TrunkRecoveryRow {
    init(recovery_sha: String, recovery_time: String, recovery_hours: Double) {
        self = try! JSONDecoder().decode(
            VLLMMetricsViewModel.TrunkRecoveryRow.self,
            from: JSONSerialization.data(withJSONObject: [
                "recovery_sha": recovery_sha,
                "recovery_time": recovery_time,
                "recovery_hours": recovery_hours,
            ])
        )
    }
}
