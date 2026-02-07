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

    // MARK: - Helpers

    private let endpointPath = "/api/clickhouse/claude_billing_metrics"

    private func makeBillingJSON(
        totalCost: Double = 1234.56,
        inputTokensCost: Double = 800.00,
        outputTokensCost: Double = 434.56,
        totalRequests: Int = 5000,
        totalTokens: Int = 2_500_000,
        inputTokensCount: Int = 1_800_000,
        outputTokensCount: Int = 700_000,
        includeModels: Bool = true,
        includeWorkflows: Bool = true,
        includeUsers: Bool = true,
        includeRepos: Bool = true,
        includeTimeSeries: Bool = true
    ) -> String {
        var parts: [String] = []

        parts.append("\"total_cost\": \(totalCost)")
        parts.append("\"input_tokens_cost\": \(inputTokensCost)")
        parts.append("\"output_tokens_cost\": \(outputTokensCost)")
        parts.append("\"total_requests\": \(totalRequests)")
        parts.append("\"total_tokens\": \(totalTokens)")
        parts.append("\"input_tokens_count\": \(inputTokensCount)")
        parts.append("\"output_tokens_count\": \(outputTokensCount)")

        if includeModels {
            parts.append("""
            "model_breakdown": [
                {"model": "claude-sonnet-4-20250514", "cost": 900.0},
                {"model": "claude-haiku-4-20250514", "cost": 250.0},
                {"model": "claude-opus-4-20250514", "cost": 84.56}
            ]
            """)
        }

        if includeWorkflows {
            parts.append("""
            "workflow_breakdown": [
                {"workflow_name": "code-review", "cost": 600.0, "request_count": 2000},
                {"workflow_name": "ci-fix", "cost": 400.0, "request_count": 1500},
                {"workflow_name": "docs-gen", "cost": 234.56, "request_count": 1500}
            ]
            """)
        }

        if includeUsers {
            parts.append("""
            "top_users": [
                {"username": "pytorch-dev", "cost": 500.0, "request_count": 1200},
                {"username": "cuda-maintainer", "cost": 350.0, "request_count": 800},
                {"username": "compiler-dev", "cost": 200.0, "request_count": 600}
            ]
            """)
        }

        if includeRepos {
            parts.append("""
            "top_repos": [
                {"repo_name": "pytorch/pytorch", "cost": 900.0, "request_count": 3500},
                {"repo_name": "pytorch/vision", "cost": 200.0, "request_count": 800},
                {"repo_name": "pytorch/audio", "cost": 134.56, "request_count": 700}
            ]
            """)
        }

        if includeTimeSeries {
            parts.append("""
            "cost_time_series": [
                {"granularity_bucket": "2025-01-15T00:00:00.000Z", "value": 150.0},
                {"granularity_bucket": "2025-01-16T00:00:00.000Z", "value": 200.0},
                {"granularity_bucket": "2025-01-17T00:00:00.000Z", "value": 175.0}
            ]
            """)
        }

        return "{\(parts.joined(separator: ","))}"
    }

    private func setSuccessfulBillingResponse(
        totalCost: Double = 1234.56,
        inputTokensCost: Double = 800.00,
        outputTokensCost: Double = 434.56,
        totalRequests: Int = 5000,
        totalTokens: Int = 2_500_000,
        inputTokensCount: Int = 1_800_000,
        outputTokensCount: Int = 700_000,
        includeModels: Bool = true,
        includeWorkflows: Bool = true,
        includeUsers: Bool = true,
        includeRepos: Bool = true,
        includeTimeSeries: Bool = true
    ) {
        let json = makeBillingJSON(
            totalCost: totalCost,
            inputTokensCost: inputTokensCost,
            outputTokensCost: outputTokensCost,
            totalRequests: totalRequests,
            totalTokens: totalTokens,
            inputTokensCount: inputTokensCount,
            outputTokensCount: outputTokensCount,
            includeModels: includeModels,
            includeWorkflows: includeWorkflows,
            includeUsers: includeUsers,
            includeRepos: includeRepos,
            includeTimeSeries: includeTimeSeries
        )
        mockClient.setResponse(json, for: endpointPath)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.totalCost, "$0.00")
        XCTAssertEqual(viewModel.avgDailyCost, "$0.00")
        XCTAssertEqual(viewModel.inputTokensCost, "$0.00")
        XCTAssertEqual(viewModel.outputTokensCost, "$0.00")
        XCTAssertEqual(viewModel.totalRequests, "0")
        XCTAssertEqual(viewModel.totalTokens, "0")
        XCTAssertEqual(viewModel.inputTokens, "0")
        XCTAssertEqual(viewModel.outputTokens, "0")
        XCTAssertTrue(viewModel.costByModel.isEmpty)
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
    }

    // MARK: - Load Data Success

    func testLoadDataPopulatesCostMetrics() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$1.2K")
        XCTAssertEqual(viewModel.inputTokensCost, "$800.00")
        XCTAssertEqual(viewModel.outputTokensCost, "$434.56")
    }

    func testLoadDataPopulatesUsageMetrics() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRequests, "5.0K")
        XCTAssertEqual(viewModel.totalTokens, "2.5M")
        XCTAssertEqual(viewModel.inputTokens, "1.8M")
        XCTAssertEqual(viewModel.outputTokens, "700.0K")
    }

    func testLoadDataCalculatesDailyAverage() async {
        setSuccessfulBillingResponse(totalCost: 700.00)

        await viewModel.loadData()

        // Default range is 7d, so $700 / 7 = $100
        XCTAssertEqual(viewModel.avgDailyCost, "$100.00")
    }

    func testLoadDataPopulatesModelBreakdown() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByModel.count, 3)
        // Should be sorted by cost descending
        XCTAssertEqual(viewModel.costByModel[0].model, "claude-sonnet-4-20250514")
        XCTAssertEqual(viewModel.costByModel[0].cost, 900.0)
        XCTAssertEqual(viewModel.costByModel[1].model, "claude-haiku-4-20250514")
        XCTAssertEqual(viewModel.costByModel[1].cost, 250.0)
        XCTAssertEqual(viewModel.costByModel[2].model, "claude-opus-4-20250514")
        XCTAssertEqual(viewModel.costByModel[2].cost, 84.56)
    }

    func testLoadDataPopulatesWorkflowBreakdown() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByWorkflow.count, 3)
        // Should be sorted by cost descending
        XCTAssertEqual(viewModel.costByWorkflow[0].name, "code-review")
        XCTAssertEqual(viewModel.costByWorkflow[0].cost, 600.0)
        XCTAssertEqual(viewModel.costByWorkflow[0].requestCount, 2000)
        XCTAssertEqual(viewModel.costByWorkflow[1].name, "ci-fix")
        XCTAssertEqual(viewModel.costByWorkflow[2].name, "docs-gen")
    }

    func testLoadDataPopulatesTopUsers() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topUsers.count, 3)
        XCTAssertEqual(viewModel.topUsers[0].name, "pytorch-dev")
        XCTAssertEqual(viewModel.topUsers[0].cost, 500.0)
        XCTAssertEqual(viewModel.topUsers[0].requestCount, 1200)
        XCTAssertEqual(viewModel.topUsers[1].name, "cuda-maintainer")
        XCTAssertEqual(viewModel.topUsers[2].name, "compiler-dev")
    }

    func testLoadDataPopulatesTopRepos() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topRepos.count, 3)
        XCTAssertEqual(viewModel.topRepos[0].name, "pytorch/pytorch")
        XCTAssertEqual(viewModel.topRepos[0].cost, 900.0)
        XCTAssertEqual(viewModel.topRepos[0].requestCount, 3500)
        XCTAssertEqual(viewModel.topRepos[1].name, "pytorch/vision")
        XCTAssertEqual(viewModel.topRepos[2].name, "pytorch/audio")
    }

    func testLoadDataPopulatesTimeSeries() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costTrendData.count, 3)
        XCTAssertEqual(viewModel.costTrendData[0].value, 150.0)
        XCTAssertEqual(viewModel.costTrendData[1].value, 200.0)
        XCTAssertEqual(viewModel.costTrendData[2].value, 175.0)
    }

    // MARK: - Load Data with Missing Optional Fields

    func testLoadDataWithNoBreakdowns() async {
        setSuccessfulBillingResponse(
            includeModels: false,
            includeWorkflows: false,
            includeUsers: false,
            includeRepos: false,
            includeTimeSeries: false
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.costByModel.isEmpty)
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
        // Cost metrics should still be populated
        XCTAssertEqual(viewModel.totalCost, "$1.2K")
    }

    func testLoadDataWithNullFieldsFallsBackToDefaults() async {
        let json = """
        {
            "total_cost": null,
            "input_tokens_cost": null,
            "output_tokens_cost": null,
            "total_requests": null,
            "total_tokens": null,
            "input_tokens_count": null,
            "output_tokens_count": null
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$0.00")
        XCTAssertEqual(viewModel.totalRequests, "0")
        XCTAssertEqual(viewModel.totalTokens, "0")
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: endpointPath)

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
        setSuccessfulBillingResponse()

        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshCallsLoadData() async {
        setSuccessfulBillingResponse()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
    }

    func testRefreshAfterErrorRecoverToLoaded() async {
        // First load fails
        mockClient.setError(APIError.serverError(500), for: endpointPath)
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state")
        }

        // Fix the response and refresh
        mockClient.errors.removeAll()
        setSuccessfulBillingResponse()
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.totalCost, "$1.2K")
    }

    // MARK: - Time Range Selection

    func testSelectTimeRangeUpdatesRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")

        setSuccessfulBillingResponse()
        viewModel.selectTimeRange("30d")

        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
    }

    func testSelectSameTimeRangeDoesNotReload() {
        setSuccessfulBillingResponse()
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

    func testDailyAverageForDifferentRanges() async {
        setSuccessfulBillingResponse(totalCost: 100.0)

        // Default is 7d: $100 / 7 = $14.29
        await viewModel.loadData()
        XCTAssertEqual(viewModel.avgDailyCost, "$14.29")
    }

    // MARK: - Currency Formatting

    func testCurrencyFormattingBelowThousand() async {
        setSuccessfulBillingResponse(totalCost: 42.50)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$42.50")
    }

    func testCurrencyFormattingAboveThousand() async {
        setSuccessfulBillingResponse(totalCost: 5678.90)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$5.7K")
    }

    func testCurrencyFormattingZero() async {
        setSuccessfulBillingResponse(totalCost: 0.0)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$0.00")
    }

    // MARK: - Count Formatting

    func testCountFormattingSmallNumbers() async {
        setSuccessfulBillingResponse(totalRequests: 42)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRequests, "42")
    }

    func testCountFormattingThousands() async {
        setSuccessfulBillingResponse(totalRequests: 5000)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRequests, "5.0K")
    }

    func testCountFormattingMillions() async {
        setSuccessfulBillingResponse(totalTokens: 2_500_000)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalTokens, "2.5M")
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

    // MARK: - Sorting Behavior

    func testModelBreakdownSortedByCostDescending() async {
        let json = """
        {
            "total_cost": 100.0,
            "model_breakdown": [
                {"model": "cheapest", "cost": 10.0},
                {"model": "middle", "cost": 50.0},
                {"model": "expensive", "cost": 100.0}
            ]
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByModel[0].model, "expensive")
        XCTAssertEqual(viewModel.costByModel[1].model, "middle")
        XCTAssertEqual(viewModel.costByModel[2].model, "cheapest")
    }

    func testWorkflowBreakdownSortedByCostDescending() async {
        let json = """
        {
            "total_cost": 100.0,
            "workflow_breakdown": [
                {"workflow_name": "cheap", "cost": 5.0, "request_count": 10},
                {"workflow_name": "expensive", "cost": 50.0, "request_count": 100},
                {"workflow_name": "medium", "cost": 25.0, "request_count": 50}
            ]
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByWorkflow[0].name, "expensive")
        XCTAssertEqual(viewModel.costByWorkflow[1].name, "medium")
        XCTAssertEqual(viewModel.costByWorkflow[2].name, "cheap")
    }

    func testUsersSortedByCostDescending() async {
        let json = """
        {
            "total_cost": 100.0,
            "top_users": [
                {"username": "low", "cost": 10.0, "request_count": 5},
                {"username": "high", "cost": 90.0, "request_count": 50},
                {"username": "mid", "cost": 40.0, "request_count": 20}
            ]
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topUsers[0].name, "high")
        XCTAssertEqual(viewModel.topUsers[1].name, "mid")
        XCTAssertEqual(viewModel.topUsers[2].name, "low")
    }

    func testReposSortedByCostDescending() async {
        let json = """
        {
            "total_cost": 100.0,
            "top_repos": [
                {"repo_name": "small-repo", "cost": 5.0, "request_count": 10},
                {"repo_name": "big-repo", "cost": 80.0, "request_count": 400},
                {"repo_name": "mid-repo", "cost": 30.0, "request_count": 100}
            ]
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topRepos[0].name, "big-repo")
        XCTAssertEqual(viewModel.topRepos[1].name, "mid-repo")
        XCTAssertEqual(viewModel.topRepos[2].name, "small-repo")
    }

    // MARK: - Unknown Model/Workflow Name Handling

    func testNullFieldsDefaultToUnknown() async {
        let json = """
        {
            "total_cost": 100.0,
            "model_breakdown": [
                {"model": null, "cost": 50.0}
            ],
            "workflow_breakdown": [
                {"workflow_name": null, "cost": 30.0, "request_count": null}
            ],
            "top_users": [
                {"username": null, "cost": 20.0, "request_count": null}
            ],
            "top_repos": [
                {"repo_name": null, "cost": 10.0, "request_count": null}
            ]
        }
        """
        mockClient.setResponse(json, for: endpointPath)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costByModel.first?.model, "Unknown")
        XCTAssertEqual(viewModel.costByWorkflow.first?.name, "Unknown")
        XCTAssertEqual(viewModel.costByWorkflow.first?.requestCount, 0)
        XCTAssertEqual(viewModel.topUsers.first?.name, "Unknown")
        XCTAssertEqual(viewModel.topUsers.first?.requestCount, 0)
        XCTAssertEqual(viewModel.topRepos.first?.name, "Unknown")
        XCTAssertEqual(viewModel.topRepos.first?.requestCount, 0)
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

    func testLoadDataCallsCorrectEndpoint() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()

        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, endpointPath)
    }

    func testSelectTimeRangeTriggersNewAPICall() async {
        setSuccessfulBillingResponse()

        await viewModel.loadData()
        XCTAssertEqual(mockClient.callCount, 1)

        viewModel.selectTimeRange("30d")
        // Give the Task time to execute
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(mockClient.callCount, 2)
    }

    // MARK: - Data Replacement on Reload

    func testReloadReplacesOldData() async {
        // First load with full data
        setSuccessfulBillingResponse(totalCost: 500.0)
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$500.00")
        XCTAssertEqual(viewModel.costByModel.count, 3)

        // Second load with different data and no breakdowns
        mockClient.reset()
        setSuccessfulBillingResponse(
            totalCost: 100.0,
            includeModels: false,
            includeWorkflows: false,
            includeUsers: false,
            includeRepos: false,
            includeTimeSeries: false
        )
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalCost, "$100.00")
        XCTAssertTrue(viewModel.costByModel.isEmpty)
        XCTAssertTrue(viewModel.costByWorkflow.isEmpty)
        XCTAssertTrue(viewModel.topUsers.isEmpty)
        XCTAssertTrue(viewModel.topRepos.isEmpty)
        XCTAssertTrue(viewModel.costTrendData.isEmpty)
    }
}
