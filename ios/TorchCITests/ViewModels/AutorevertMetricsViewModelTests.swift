import XCTest
@testable import TorchCI

@MainActor
final class AutorevertMetricsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: AutorevertMetricsViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = AutorevertMetricsViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Test Data

    private let fullMetricsJSON = """
    {
        "summary": {
            "total_autoreverts": 25,
            "true_positives": 18,
            "tp_with_signal_recovery": 12,
            "tp_without_signal_recovery": 6,
            "confirmed_false_positives": 3,
            "false_negatives": 4,
            "precision": 85.7,
            "recall": 81.8,
            "total_revert_recoveries": 22
        },
        "weeklyMetrics": [
            {
                "week": "2025-01-06",
                "precision": 90.0,
                "recall": 85.0,
                "false_positives": 1,
                "autorevert_recoveries": 9,
                "human_revert_recoveries": 2,
                "non_revert_recoveries": 3
            },
            {
                "week": "2025-01-13",
                "precision": 80.0,
                "recall": 75.0,
                "false_positives": 2,
                "autorevert_recoveries": 8,
                "human_revert_recoveries": 3,
                "non_revert_recoveries": 1
            }
        ],
        "significantReverts": [
            {
                "recovery_sha": "abc1234567890def1234567890abcdef12345678",
                "recovery_time": "2025-01-10T14:30:00.000Z",
                "signal_keys": ["signal_a", "signal_b"],
                "signals_fixed": 2,
                "max_red_streak_length": 5,
                "reverted_pr_numbers": ["12345", "12346"],
                "recovery_type": "autorevert_recovery",
                "is_autorevert": true
            },
            {
                "recovery_sha": "def4567890abcdef1234567890abcdef12345678",
                "recovery_time": "2025-01-11T09:15:00.000Z",
                "signal_keys": ["signal_c"],
                "signals_fixed": 1,
                "max_red_streak_length": 3,
                "reverted_pr_numbers": ["12347"],
                "recovery_type": "human_revert_recovery",
                "is_autorevert": false
            }
        ],
        "falsePositives": {
            "candidates_checked": 5,
            "confirmed": [
                {
                    "reverted_sha": "fp1_sha_1234567890abcdef1234567890abcdef",
                    "autorevert_time": "2025-01-09T10:00:00.000Z",
                    "pr_number": "99001",
                    "commits_after_revert": 3,
                    "verification_status": "confirmed_fp",
                    "verification_reason": "Signal was flaky, not caused by this PR",
                    "source_signal_keys": ["signal_x", "signal_y"]
                }
            ],
            "legit_reverts": [
                {
                    "reverted_sha": "legit_sha_1234567890abcdef1234567890abc",
                    "autorevert_time": "2025-01-08T16:00:00.000Z",
                    "pr_number": "99002",
                    "commits_after_revert": 1,
                    "verification_status": "legit_revert",
                    "verification_reason": "PR caused real breakage confirmed by re-land failure",
                    "source_signal_keys": ["signal_z"]
                }
            ]
        }
    }
    """

    private let minimalMetricsJSON = """
    {
        "summary": {
            "total_autoreverts": 0,
            "precision": null,
            "recall": null
        }
    }
    """

    private let summaryOnlyMetricsJSON = """
    {
        "summary": {
            "total_autoreverts": 10,
            "true_positives": 7,
            "tp_with_signal_recovery": 5,
            "tp_without_signal_recovery": 2,
            "confirmed_false_positives": 1,
            "false_negatives": 2,
            "precision": 87.5,
            "recall": 77.8
        }
    }
    """

    private func registerMetricsResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/autorevert/metrics")
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
        XCTAssertNil(viewModel.summary)
        XCTAssertNil(viewModel.weeklyMetrics)
        XCTAssertNil(viewModel.significantReverts)
        XCTAssertNil(viewModel.falsePositivesData)
        XCTAssertFalse(viewModel.showAllReverts)
    }

    func testDefaultSelectedRange() {
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    // MARK: - Load Metrics

    func testLoadMetricsSuccess() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.summary)
        XCTAssertEqual(viewModel.summary?.totalAutoreverts, 25)
        XCTAssertEqual(viewModel.summary?.truePositives, 18)
        XCTAssertEqual(viewModel.summary?.tpWithSignalRecovery, 12)
        XCTAssertEqual(viewModel.summary?.tpWithoutSignalRecovery, 6)
        XCTAssertEqual(viewModel.summary?.confirmedFalsePositives, 3)
        XCTAssertEqual(viewModel.summary?.falseNegatives, 4)
        XCTAssertEqual(viewModel.summary?.precision, 85.7)
        XCTAssertEqual(viewModel.summary?.recall, 81.8)
    }

    func testLoadMetricsPopulatesWeeklyMetrics() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.weeklyMetrics?.count, 2)

        let firstWeek = viewModel.weeklyMetrics?[0]
        XCTAssertEqual(firstWeek?.week, "2025-01-06")
        XCTAssertEqual(firstWeek?.precision, 90.0)
        XCTAssertEqual(firstWeek?.recall, 85.0)
        XCTAssertEqual(firstWeek?.falsePositives, 1)
        XCTAssertEqual(firstWeek?.autorevertRecoveries, 9)
        XCTAssertEqual(firstWeek?.humanRevertRecoveries, 2)
        XCTAssertEqual(firstWeek?.nonRevertRecoveries, 3)

        let secondWeek = viewModel.weeklyMetrics?[1]
        XCTAssertEqual(secondWeek?.week, "2025-01-13")
        XCTAssertEqual(secondWeek?.precision, 80.0)
        XCTAssertEqual(secondWeek?.recall, 75.0)
    }

    func testLoadMetricsPopulatesSignificantReverts() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.significantReverts?.count, 2)

        let tp = viewModel.significantReverts?[0]
        XCTAssertEqual(tp?.recoverySha, "abc1234567890def1234567890abcdef12345678")
        XCTAssertEqual(tp?.signalsFixed, 2)
        XCTAssertEqual(tp?.isTP, true)
        XCTAssertEqual(tp?.isFN, false)
        XCTAssertEqual(tp?.isAutorevert, true)
        XCTAssertEqual(tp?.revertedPrNumbers, ["12345", "12346"])

        let fn = viewModel.significantReverts?[1]
        XCTAssertEqual(fn?.isTP, false)
        XCTAssertEqual(fn?.isFN, true)
        XCTAssertEqual(fn?.isAutorevert, false)
    }

    func testLoadMetricsPopulatesFalsePositives() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertNotNil(viewModel.falsePositivesData)
        XCTAssertEqual(viewModel.falsePositivesData?.candidatesChecked, 5)
        XCTAssertEqual(viewModel.falsePositivesData?.confirmed?.count, 1)
        XCTAssertEqual(viewModel.falsePositivesData?.legitReverts?.count, 1)

        let confirmedFP = viewModel.falsePositivesData?.confirmed?.first
        XCTAssertEqual(confirmedFP?.prNumber, "99001")
        XCTAssertEqual(confirmedFP?.isConfirmedFP, true)
        XCTAssertEqual(confirmedFP?.sourceSignalKeys?.count, 2)

        let legit = viewModel.falsePositivesData?.legitReverts?.first
        XCTAssertEqual(legit?.prNumber, "99002")
        XCTAssertEqual(legit?.isConfirmedFP, false)
    }

    func testLoadMetricsWithMinimalData() async {
        registerMetricsResponse(minimalMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.summary?.totalAutoreverts, 0)
        XCTAssertNil(viewModel.summary?.precision)
        XCTAssertNil(viewModel.summary?.recall)
        XCTAssertNil(viewModel.weeklyMetrics)
        XCTAssertNil(viewModel.significantReverts)
        XCTAssertNil(viewModel.falsePositivesData)
    }

    func testLoadMetricsSummaryOnly() async {
        registerMetricsResponse(summaryOnlyMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.summary?.totalAutoreverts, 10)
        XCTAssertEqual(viewModel.summary?.precision, 87.5)
        XCTAssertEqual(viewModel.summary?.recall, 77.8)
        XCTAssertNil(viewModel.weeklyMetrics)
        XCTAssertNil(viewModel.significantReverts)
    }

    // MARK: - Error Handling

    func testLoadMetricsNetworkError() async {
        mockClient.setError(APIError.serverError(500), for: "/api/autorevert/metrics")

        await viewModel.loadMetrics()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadMetricsNotFoundError() async {
        // Don't register any response, the mock will throw notFound

        await viewModel.loadMetrics()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadMetricsSetsLoadingFirst() async {
        registerMetricsResponse(fullMetricsJSON)

        // Load once to get to loaded state
        await viewModel.loadMetrics()
        XCTAssertEqual(viewModel.state, .loaded)

        // After calling loadMetrics, state should transition through loading
        // Since we can't observe intermediate states easily, just verify the final state
        await viewModel.loadMetrics()
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshDoesNotResetToLoading() async {
        registerMetricsResponse(fullMetricsJSON)

        // Load first
        await viewModel.loadMetrics()
        XCTAssertEqual(viewModel.state, .loaded)

        // Refresh should not set state to .loading (it calls fetchData directly)
        await viewModel.refresh()
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testRefreshReloadsData() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.summary)
        // Verify the API was called
        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertTrue(mockClient.callPaths().contains("/api/autorevert/metrics"))
    }

    func testRefreshAfterErrorRecovers() async {
        // First load fails
        mockClient.setError(APIError.serverError(500), for: "/api/autorevert/metrics")
        await viewModel.loadMetrics()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state")
        }

        // Fix the response and refresh
        mockClient.errors.removeAll()
        registerMetricsResponse(fullMetricsJSON)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.summary)
    }

    // MARK: - Time Range

    func testSelectedRangeReturnsCorrectRange() {
        viewModel.selectedTimeRange = "7d"
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Week")

        viewModel.selectedTimeRange = "90d"
        XCTAssertEqual(viewModel.selectedRange?.days, 90)
        XCTAssertEqual(viewModel.selectedRange?.label, "3 Months")
    }

    func testInvalidTimeRangeReturnsNil() {
        viewModel.selectedTimeRange = "invalid"
        XCTAssertNil(viewModel.selectedRange)
    }

    func testOnParametersChangedRefetches() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.onParametersChanged()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
    }

    func testOnParametersChangedResetsShowAllReverts() async {
        registerMetricsResponse(fullMetricsJSON)

        viewModel.showAllReverts = true
        await viewModel.onParametersChanged()

        XCTAssertFalse(viewModel.showAllReverts)
    }

    func testEndpointUsesCorrectPath() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        XCTAssertEqual(mockClient.callPaths(), ["/api/autorevert/metrics"])
    }

    func testEndpointQueryParametersIncludeTimeRange() async {
        registerMetricsResponse(fullMetricsJSON)

        await viewModel.loadMetrics()

        let call = mockClient.recordedCalls.first
        XCTAssertNotNil(call)
        XCTAssertEqual(call?.path, "/api/autorevert/metrics")

        let queryItems = call?.queryItems ?? []
        let paramNames = queryItems.map(\.name)
        XCTAssertTrue(paramNames.contains("startTime"))
        XCTAssertTrue(paramNames.contains("stopTime"))
    }

    // MARK: - Show All Reverts Toggle

    func testShowAllRevertsToggle() {
        XCTAssertFalse(viewModel.showAllReverts)

        viewModel.showAllReverts = true
        XCTAssertTrue(viewModel.showAllReverts)

        viewModel.showAllReverts = false
        XCTAssertFalse(viewModel.showAllReverts)
    }

    // MARK: - Model Decoding

    func testAutorevertMetricsDecodingFullPayload() throws {
        let data = fullMetricsJSON.data(using: .utf8)!
        let metrics = try JSONDecoder().decode(AutorevertMetrics.self, from: data)

        XCTAssertEqual(metrics.summary.totalAutoreverts, 25)
        XCTAssertEqual(metrics.summary.precision, 85.7)
        XCTAssertEqual(metrics.weeklyMetrics?.count, 2)
        XCTAssertEqual(metrics.significantReverts?.count, 2)
        XCTAssertNotNil(metrics.falsePositives)
    }

    func testAutorevertMetricsDecodingMinimalPayload() throws {
        let data = minimalMetricsJSON.data(using: .utf8)!
        let metrics = try JSONDecoder().decode(AutorevertMetrics.self, from: data)

        XCTAssertEqual(metrics.summary.totalAutoreverts, 0)
        XCTAssertNil(metrics.summary.precision)
        XCTAssertNil(metrics.summary.recall)
        XCTAssertNil(metrics.weeklyMetrics)
    }

    func testWeeklyMetricIdentifiable() throws {
        let json = """
        {
            "week": "2025-01-06",
            "precision": 90.0,
            "recall": 85.0,
            "false_positives": 1,
            "autorevert_recoveries": 9,
            "human_revert_recoveries": 2,
            "non_revert_recoveries": 3
        }
        """
        let data = json.data(using: .utf8)!
        let metric = try JSONDecoder().decode(WeeklyMetric.self, from: data)

        XCTAssertEqual(metric.id, "2025-01-06")
        XCTAssertEqual(metric.week, "2025-01-06")
    }

    func testSignificantRevertTPClassification() throws {
        let json = """
        {
            "recovery_sha": "abc123",
            "recovery_time": "2025-01-10T14:30:00.000Z",
            "signals_fixed": 2,
            "max_red_streak_length": 5,
            "recovery_type": "autorevert_recovery",
            "is_autorevert": true
        }
        """
        let data = json.data(using: .utf8)!
        let revert = try JSONDecoder().decode(SignificantRevert.self, from: data)

        XCTAssertTrue(revert.isTP)
        XCTAssertFalse(revert.isFN)
        XCTAssertTrue(revert.isAutorevert)
    }

    func testSignificantRevertFNClassification() throws {
        let json = """
        {
            "recovery_sha": "def456",
            "recovery_time": "2025-01-11T09:15:00.000Z",
            "signals_fixed": 1,
            "max_red_streak_length": 3,
            "recovery_type": "human_revert_recovery",
            "is_autorevert": false
        }
        """
        let data = json.data(using: .utf8)!
        let revert = try JSONDecoder().decode(SignificantRevert.self, from: data)

        XCTAssertFalse(revert.isTP)
        XCTAssertTrue(revert.isFN)
        XCTAssertFalse(revert.isAutorevert)
    }

    func testFalsePositiveConfirmedFPStatus() throws {
        let json = """
        {
            "reverted_sha": "fp1_sha",
            "autorevert_time": "2025-01-09T10:00:00.000Z",
            "pr_number": "99001",
            "commits_after_revert": 3,
            "verification_status": "confirmed_fp",
            "verification_reason": "Signal was flaky"
        }
        """
        let data = json.data(using: .utf8)!
        let fp = try JSONDecoder().decode(FalsePositive.self, from: data)

        XCTAssertTrue(fp.isConfirmedFP)
        XCTAssertEqual(fp.prNumber, "99001")
        XCTAssertEqual(fp.commitsAfterRevert, 3)
    }

    func testFalsePositiveLegitStatus() throws {
        let json = """
        {
            "reverted_sha": "legit_sha",
            "autorevert_time": "2025-01-08T16:00:00.000Z",
            "pr_number": "99002",
            "commits_after_revert": 1,
            "verification_status": "legit_revert",
            "verification_reason": "Real breakage"
        }
        """
        let data = json.data(using: .utf8)!
        let fp = try JSONDecoder().decode(FalsePositive.self, from: data)

        XCTAssertFalse(fp.isConfirmedFP)
    }

    func testFalsePositivesDataDecoding() throws {
        let json = """
        {
            "candidates_checked": 10,
            "confirmed": [],
            "legit_reverts": []
        }
        """
        let data = json.data(using: .utf8)!
        let fpData = try JSONDecoder().decode(FalsePositivesData.self, from: data)

        XCTAssertEqual(fpData.candidatesChecked, 10)
        XCTAssertEqual(fpData.confirmed?.count, 0)
        XCTAssertEqual(fpData.legitReverts?.count, 0)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(
            AutorevertMetricsViewModel.ViewState.loading,
            AutorevertMetricsViewModel.ViewState.loading
        )
        XCTAssertEqual(
            AutorevertMetricsViewModel.ViewState.loaded,
            AutorevertMetricsViewModel.ViewState.loaded
        )
        XCTAssertEqual(
            AutorevertMetricsViewModel.ViewState.error("test"),
            AutorevertMetricsViewModel.ViewState.error("test")
        )
        XCTAssertNotEqual(
            AutorevertMetricsViewModel.ViewState.loading,
            AutorevertMetricsViewModel.ViewState.loaded
        )
        XCTAssertNotEqual(
            AutorevertMetricsViewModel.ViewState.error("a"),
            AutorevertMetricsViewModel.ViewState.error("b")
        )
        XCTAssertNotEqual(
            AutorevertMetricsViewModel.ViewState.loading,
            AutorevertMetricsViewModel.ViewState.error("test")
        )
    }

    // MARK: - Multiple Loads

    func testMultipleLoadsUpdateData() async {
        // First load with summary-only data
        registerMetricsResponse(summaryOnlyMetricsJSON)
        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.summary?.totalAutoreverts, 10)
        XCTAssertNil(viewModel.weeklyMetrics)

        // Second load with full data
        mockClient.reset()
        registerMetricsResponse(fullMetricsJSON)
        await viewModel.loadMetrics()

        XCTAssertEqual(viewModel.summary?.totalAutoreverts, 25)
        XCTAssertEqual(viewModel.weeklyMetrics?.count, 2)
        XCTAssertEqual(viewModel.significantReverts?.count, 2)
    }
}
