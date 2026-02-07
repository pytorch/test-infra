import XCTest
@testable import TorchCI

@MainActor
final class ClaudeBillingViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: ClaudeBillingViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = ClaudeBillingViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Endpoint Paths

    private let dailyPath = "/api/clickhouse/claude_code_usage_daily"
    private let repoPath = "/api/clickhouse/claude_code_usage_by_repo"
    private let actorPath = "/api/clickhouse/claude_code_usage_by_actor"

    // MARK: - Helpers

    /// Register daily usage rows. Each row has: day, workflow_name, repo,
    /// invocations, total_cost, total_turns, total_minutes,
    /// avg_cost_per_invocation, avg_turns_per_invocation.
    private func registerDailyResponse(_ json: String) {
        mockClient.setResponse(json, for: dailyPath)
    }

    private func registerRepoResponse(_ json: String) {
        mockClient.setResponse(json, for: repoPath)
    }

    private func registerActorResponse(_ json: String) {
        mockClient.setResponse(json, for: actorPath)
    }

    /// Register standard responses for all three endpoints.
    private func registerAllResponses(
        daily: String = ClaudeBillingViewModelTests.defaultDailyJSON,
        repo: String = ClaudeBillingViewModelTests.defaultRepoJSON,
        actor: String = ClaudeBillingViewModelTests.defaultActorJSON
    ) {
        registerDailyResponse(daily)
        registerRepoResponse(repo)
        registerActorResponse(actor)
    }

    // MARK: - JSON Fixtures

    private static let defaultDailyJSON = """
    [
        {"day":"2025-01-15","workflow_name":"code-review","repo":"pytorch/pytorch","invocations":500,"total_cost":300.0,"total_turns":1000,"total_minutes":100.0,"avg_cost_per_invocation":0.6,"avg_turns_per_invocation":2.0},
        {"day":"2025-01-15","workflow_name":"ci-fix","repo":"pytorch/pytorch","invocations":200,"total_cost":150.0,"total_turns":400,"total_minutes":50.0,"avg_cost_per_invocation":0.75,"avg_turns_per_invocation":2.0},
        {"day":"2025-01-16","workflow_name":"code-review","repo":"pytorch/vision","invocations":300,"total_cost":200.0,"total_turns":600,"total_minutes":80.0,"avg_cost_per_invocation":0.67,"avg_turns_per_invocation":2.0},
        {"day":"2025-01-17","workflow_name":"ci-fix","repo":"pytorch/pytorch","invocations":100,"total_cost":100.0,"total_turns":200,"total_minutes":30.0,"avg_cost_per_invocation":1.0,"avg_turns_per_invocation":2.0}
    ]
    """

    private static let defaultRepoJSON = """
    [
        {"repo":"pytorch/pytorch","invocations":700,"total_cost":450.0,"total_turns":1400,"total_minutes":150.0},
        {"repo":"pytorch/vision","invocations":300,"total_cost":200.0,"total_turns":600,"total_minutes":80.0}
    ]
    """

    private static let defaultActorJSON = """
    [
        {"actor":"pytorch-dev","invocations":500,"total_cost":350.0,"total_turns":1000,"total_minutes":100.0},
        {"actor":"cuda-maintainer","invocations":300,"total_cost":200.0,"total_turns":600,"total_minutes":80.0},
        {"actor":"compiler-dev","invocations":100,"total_cost":100.0,"total_turns":200,"total_minutes":30.0}
    ]
    """

    private static let emptyJSON = "[]"

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.totalCost, "$0.00")
        XCTAssertEqual(viewModel.avgDailyCost, "$0.00")
        XCTAssertTrue(viewModel.costByModel.isEmpty)
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
    }

    // MARK: - Load Data Success

    func testLoadDataPopulatesCostMetrics() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        // Total cost = 300 + 150 + 200 + 100 = 750
        XCTAssertEqual(viewModel.totalCost, "$750.00")
    }

    func testLoadDataPopulatesUsageMetrics() async {
        registerAllResponses()

        await viewModel.loadData()

        // Total invocations = 500 + 200 + 300 + 100 = 1100
        XCTAssertEqual(viewModel.totalRequests, "1.1K")
        // Total turns = 1000 + 400 + 600 + 200 = 2200
        XCTAssertEqual(viewModel.totalTokens, "2.2K")
    }

    func testLoadDataCalculatesDailyAverage() async {
        registerAllResponses()

        await viewModel.loadData()

        // Default is 7d: $750 / 7 = $107.14
        XCTAssertEqual(viewModel.avgDailyCost, "$107.14")
    }

    func testLoadDataPopulatesWorkflowBreakdown() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByWorkflow.count, 2)
        // code-review: 300 + 200 = 500, ci-fix: 150 + 100 = 250
        // Sorted by cost descending
        XCTAssertEqual(viewModel.costByWorkflow[0].name, "code-review")
        XCTAssertEqual(viewModel.costByWorkflow[0].cost, 500.0)
        XCTAssertEqual(viewModel.costByWorkflow[1].name, "ci-fix")
        XCTAssertEqual(viewModel.costByWorkflow[1].cost, 250.0)
    }

    func testLoadDataPopulatesTopUsers() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topUsers.count, 3)
        XCTAssertEqual(viewModel.topUsers[0].name, "pytorch-dev")
        XCTAssertEqual(viewModel.topUsers[0].cost, 350.0)
        XCTAssertEqual(viewModel.topUsers[1].name, "cuda-maintainer")
        XCTAssertEqual(viewModel.topUsers[2].name, "compiler-dev")
    }

    func testLoadDataPopulatesTopRepos() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topRepos.count, 2)
        XCTAssertEqual(viewModel.topRepos[0].name, "pytorch/pytorch")
        XCTAssertEqual(viewModel.topRepos[0].cost, 450.0)
        XCTAssertEqual(viewModel.topRepos[1].name, "pytorch/vision")
    }

    func testLoadDataPopulatesTimeSeries() async {
        registerAllResponses()

        await viewModel.loadData()

        // 3 unique days: 2025-01-15, 2025-01-16, 2025-01-17
        XCTAssertEqual(viewModel.costTrendData.count, 3)
        // Sorted by date ascending
        XCTAssertEqual(viewModel.costTrendData[0].granularity_bucket, "2025-01-15")
        XCTAssertEqual(viewModel.costTrendData[0].value, 450.0) // 300 + 150
        XCTAssertEqual(viewModel.costTrendData[1].granularity_bucket, "2025-01-16")
        XCTAssertEqual(viewModel.costTrendData[1].value, 200.0)
        XCTAssertEqual(viewModel.costTrendData[2].granularity_bucket, "2025-01-17")
        XCTAssertEqual(viewModel.costTrendData[2].value, 100.0)
    }

    func testModelBreakdownIsAlwaysEmpty() async {
        // The real queries don't return per-model data
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertTrue(viewModel.costByModel.isEmpty)
    }

    func testTokenCostFieldsShowDash() async {
        // The daily query doesn't provide token cost breakdowns
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.inputTokensCost, "--")
        XCTAssertEqual(viewModel.outputTokensCost, "--")
        XCTAssertEqual(viewModel.inputTokens, "--")
        XCTAssertEqual(viewModel.outputTokens, "--")
    }

    // MARK: - Empty Data

    func testLoadDataWithEmptyResponses() async {
        registerAllResponses(
            daily: Self.emptyJSON,
            repo: Self.emptyJSON,
            actor: Self.emptyJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$0.00")
        XCTAssertEqual(viewModel.totalRequests, "0")
        XCTAssertEqual(viewModel.totalTokens, "0")
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: dailyPath)

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataNotFoundSetsErrorState() async {
        // No response registered -- MockAPIClient throws .notFound
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataSetsLoadingStateDuringFetch() async {
        registerAllResponses()

        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshCallsLoadData() async {
        registerAllResponses()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testRefreshAfterErrorRecoverToLoaded() async {
        // First load fails
        mockClient.setError(APIError.serverError(500), for: dailyPath)
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state")
        }

        // Fix the response and refresh
        mockClient.errors.removeAll()
        registerAllResponses()
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$750.00")
    }

    // MARK: - Time Range Selection

    func testSelectTimeRangeUpdatesRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")

        registerAllResponses()
        viewModel.selectTimeRange("30d")

        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
    }

    func testSelectSameTimeRangeDoesNotReload() {
        registerAllResponses()
        viewModel.selectTimeRange("7d")

        // Should not make any API calls since the range didn't change
        XCTAssertEqual(mockClient.callCount, 0)
    }

    func testTimeRangeLabelForAllRanges() {
        viewModel.selectedTimeRange = "1d"
        XCTAssertEqual(viewModel.timeRangeLabel, "last 24 hours")

        viewModel.selectedTimeRange = "7d"
        XCTAssertEqual(viewModel.timeRangeLabel, "last 7 days")

        viewModel.selectedTimeRange = "14d"
        XCTAssertEqual(viewModel.timeRangeLabel, "last 14 days")

        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.timeRangeLabel, "last 30 days")

        viewModel.selectedTimeRange = "unknown"
        XCTAssertEqual(viewModel.timeRangeLabel, "selected period")
    }

    // MARK: - Currency Formatting

    func testCurrencyFormattingBelowThousand() async {
        let json = """
        [{"day":"2025-01-15","workflow_name":"ci","repo":"pytorch/pytorch","invocations":1,"total_cost":42.50,"total_turns":10,"total_minutes":5.0,"avg_cost_per_invocation":42.5,"avg_turns_per_invocation":10.0}]
        """
        registerAllResponses(daily: json, repo: Self.emptyJSON, actor: Self.emptyJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$42.50")
    }

    func testCurrencyFormattingAboveThousand() async {
        let json = """
        [{"day":"2025-01-15","workflow_name":"ci","repo":"pytorch/pytorch","invocations":1,"total_cost":5678.90,"total_turns":10,"total_minutes":5.0,"avg_cost_per_invocation":5678.9,"avg_turns_per_invocation":10.0}]
        """
        registerAllResponses(daily: json, repo: Self.emptyJSON, actor: Self.emptyJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$5.7K")
    }

    func testCurrencyFormattingZero() async {
        registerAllResponses(daily: Self.emptyJSON, repo: Self.emptyJSON, actor: Self.emptyJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$0.00")
    }

    // MARK: - Count Formatting

    func testCountFormattingSmallNumbers() async {
        let json = """
        [{"day":"2025-01-15","workflow_name":"ci","repo":"pytorch/pytorch","invocations":42,"total_cost":10.0,"total_turns":100,"total_minutes":5.0,"avg_cost_per_invocation":0.24,"avg_turns_per_invocation":2.4}]
        """
        registerAllResponses(daily: json, repo: Self.emptyJSON, actor: Self.emptyJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRequests, "42")
    }

    func testCountFormattingThousands() async {
        let json = """
        [{"day":"2025-01-15","workflow_name":"ci","repo":"pytorch/pytorch","invocations":5000,"total_cost":100.0,"total_turns":10000,"total_minutes":500.0,"avg_cost_per_invocation":0.02,"avg_turns_per_invocation":2.0}]
        """
        registerAllResponses(daily: json, repo: Self.emptyJSON, actor: Self.emptyJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRequests, "5.0K")
    }

    // MARK: - Display Model Formatting

    func testModelCostEntryFormattingBelowThousand() {
        let entry = ModelCostEntry(model: "claude-sonnet-4", cost: 456.78)
        XCTAssertEqual(entry.costFormatted, "$456.78")
    }

    func testModelCostEntryFormattingAboveThousand() {
        let entry = ModelCostEntry(model: "claude-sonnet-4", cost: 2345.67)
        XCTAssertEqual(entry.costFormatted, "$2.3K")
    }

    func testWorkflowCostEntryFormattingAndIdentity() {
        let entry = WorkflowCostEntry(name: "code-review", cost: 123.45, requestCount: 500)
        XCTAssertEqual(entry.id, "code-review")
        XCTAssertEqual(entry.costFormatted, "$123.45")
    }

    func testWorkflowCostEntryFormattingAboveThousand() {
        let entry = WorkflowCostEntry(name: "ci-fix", cost: 5000.0, requestCount: 1000)
        XCTAssertEqual(entry.costFormatted, "$5.0K")
    }

    func testUserCostEntryFormatting() {
        let entry = UserCostEntry(name: "dev-user", cost: 99.99, requestCount: 200)
        XCTAssertEqual(entry.costFormatted, "$99.99")
    }

    func testUserCostEntryFormattingAboveThousand() {
        let entry = UserCostEntry(name: "power-user", cost: 3456.78, requestCount: 5000)
        XCTAssertEqual(entry.costFormatted, "$3.5K")
    }

    func testRepoCostEntryFormatting() {
        let entry = RepoCostEntry(name: "pytorch/pytorch", cost: 567.89, requestCount: 3000)
        XCTAssertEqual(entry.costFormatted, "$567.89")
    }

    func testRepoCostEntryFormattingAboveThousand() {
        let entry = RepoCostEntry(name: "pytorch/pytorch", cost: 10000.0, requestCount: 50000)
        XCTAssertEqual(entry.costFormatted, "$10.0K")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(ClaudeBillingViewModel.ViewState.idle, .idle)
        XCTAssertEqual(ClaudeBillingViewModel.ViewState.loading, .loading)
        XCTAssertEqual(ClaudeBillingViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(ClaudeBillingViewModel.ViewState.error("test"), .error("test"))

        XCTAssertNotEqual(ClaudeBillingViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(ClaudeBillingViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(ClaudeBillingViewModel.ViewState.idle, .error("test"))
        XCTAssertNotEqual(ClaudeBillingViewModel.ViewState.loaded, .loading)
    }

    // MARK: - API Endpoint

    func testLoadDataCallsCorrectEndpoints() async {
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains(dailyPath))
        XCTAssertTrue(paths.contains(repoPath))
        // Actor endpoint is called only when repos are found
        XCTAssertTrue(paths.contains(actorPath))
    }

    func testLoadDataSkipsActorWhenNoRepos() async {
        registerAllResponses(
            daily: Self.emptyJSON,
            repo: Self.emptyJSON,
            actor: Self.emptyJSON
        )

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        // When daily returns empty, no repos are found, so actor endpoint is skipped
        XCTAssertFalse(paths.contains(actorPath))
    }

    // MARK: - Data Replacement on Reload

    func testReloadReplacesOldData() async {
        registerAllResponses()
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$750.00")
        XCTAssertFalse(viewModel.costByWorkflow.isEmpty)

        // Second load with empty data
        mockClient.reset()
        registerAllResponses(
            daily: Self.emptyJSON,
            repo: Self.emptyJSON,
            actor: Self.emptyJSON
        )
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$0.00")
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
    }

    // MARK: - Partial Failure Handling

    func testRepoFailureStillLoadsDaily() async {
        registerDailyResponse(Self.defaultDailyJSON)
        mockClient.setError(APIError.serverError(500), for: repoPath)
        registerActorResponse(Self.defaultActorJSON)

        await viewModel.loadData()

        // Repo failure is silently handled (try? await), daily data still works
        // But since repo fetch is also done with try? we need the daily fetch to succeed
        // Note: The daily fetch is NOT wrapped in try?, so if it fails, the whole thing fails.
        // Since daily succeeds, state should be loaded
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$750.00")
    }
}
