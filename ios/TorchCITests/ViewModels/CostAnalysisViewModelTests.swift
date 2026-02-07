import XCTest
@testable import TorchCI

@MainActor
final class CostAnalysisViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: CostAnalysisViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = CostAnalysisViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Registers a successful cost query response for the given query name.
    private func registerCostResponse(
        queryName: String,
        json: String
    ) {
        let path = "/api/clickhouse/\(queryName)"
        mockClient.setResponse(json, for: path)
    }

    /// Registers empty responses for all cost grouping query names.
    private func registerEmptyCostResponses() {
        for grouping in CostAnalysisViewModel.CostGrouping.allCases {
            registerCostResponse(queryName: grouping.queryName, json: "[]")
        }
    }

    /// Returns a JSON array string with cost query results for testing.
    private func makeCostJSON(
        entries: [(bucket: String, workflowName: String, cost: Double)]
    ) -> String {
        let items = entries.map { entry in
            """
            {"granularity_bucket":"\(entry.bucket)","workflow_name":"\(entry.workflowName)","runner_type":null,"repo":null,"provider":null,"platform":null,"total_cost":\(entry.cost)}
            """
        }
        return "[\(items.joined(separator: ","))]"
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
        XCTAssertEqual(viewModel.selectedGrouping, .workflow)
        XCTAssertEqual(viewModel.totalCost, 0)
        XCTAssertEqual(viewModel.totalJobs, 0)
        XCTAssertNil(viewModel.dailyAverageCost)
        XCTAssertTrue(viewModel.costBreakdown.isEmpty)
        XCTAssertTrue(viewModel.costTrendSeries.isEmpty)
        XCTAssertNil(viewModel.periodComparison)
    }

    func testDefaultTimeRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    func testDefaultGrouping() {
        XCTAssertEqual(viewModel.selectedGrouping, .workflow)
        XCTAssertEqual(viewModel.selectedGrouping.displayName, "Workflow")
        XCTAssertEqual(viewModel.selectedGrouping.queryName, "cost_job_per_workflow_name")
    }

    // MARK: - Load Data Success

    func testLoadDataPopulatesBreakdownAndTotals() async {
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "pull", cost: 500.0),
            (bucket: "2024-01-02T00:00:00Z", workflowName: "pull", cost: 300.0),
            (bucket: "2024-01-01T00:00:00Z", workflowName: "trunk", cost: 200.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.costBreakdown.count, 2)
        XCTAssertEqual(viewModel.totalCost, 1000.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.totalJobs, 3)
    }

    func testLoadDataSortsByDescendingCost() async {
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "small", cost: 100.0),
            (bucket: "2024-01-01T00:00:00Z", workflowName: "large", cost: 900.0),
            (bucket: "2024-01-01T00:00:00Z", workflowName: "medium", cost: 500.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costBreakdown.count, 3)
        // First item should have the highest cost
        XCTAssertEqual(viewModel.costBreakdown[0].cost, 900.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.costBreakdown[1].cost, 500.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.costBreakdown[2].cost, 100.0, accuracy: 0.01)
    }

    func testLoadDataAggregatesSameCategory() async {
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "pull", cost: 200.0),
            (bucket: "2024-01-02T00:00:00Z", workflowName: "pull", cost: 300.0),
            (bucket: "2024-01-03T00:00:00Z", workflowName: "pull", cost: 500.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costBreakdown.count, 1)
        XCTAssertEqual(viewModel.costBreakdown[0].category, "pull")
        XCTAssertEqual(viewModel.costBreakdown[0].cost, 1000.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.costBreakdown[0].jobCount, 3)
    }

    func testLoadDataComputesDailyAverage() async {
        // 30d time range => daily average = totalCost / 30
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "pull", cost: 3000.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.dailyAverageCost ?? 0, 3000.0 / 30.0, accuracy: 0.01)
    }

    func testLoadDataComputesTrendSeries() async {
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "pull", cost: 100.0),
            (bucket: "2024-01-02T00:00:00Z", workflowName: "pull", cost: 200.0),
            (bucket: "2024-01-01T00:00:00Z", workflowName: "trunk", cost: 50.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.costTrendSeries.count, 2)
        // Trend should be sorted by bucket
        XCTAssertEqual(viewModel.costTrendSeries[0].granularity_bucket, "2024-01-01T00:00:00Z")
        XCTAssertEqual(viewModel.costTrendSeries[1].granularity_bucket, "2024-01-02T00:00:00Z")
        // 2024-01-01: pull=100 + trunk=50 = 150
        XCTAssertEqual(viewModel.costTrendSeries[0].value ?? 0, 150.0, accuracy: 0.01)
        // 2024-01-02: pull=200
        XCTAssertEqual(viewModel.costTrendSeries[1].value ?? 0, 200.0, accuracy: 0.01)
    }

    func testLoadDataWithEmptyResponseSucceeds() async {
        registerEmptyCostResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.costBreakdown.isEmpty)
        XCTAssertTrue(viewModel.costTrendSeries.isEmpty)
        XCTAssertEqual(viewModel.totalCost, 0)
        XCTAssertEqual(viewModel.totalJobs, 0)
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/cost_job_per_workflow_name")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Cost Per Job

    func testCostPerJobComputedCorrectly() {
        viewModel.totalCost = 1000.0
        viewModel.totalJobs = 50

        XCTAssertEqual(viewModel.costPerJob, 20.0, accuracy: 0.01)
    }

    func testCostPerJobZeroWhenNoJobs() {
        viewModel.totalCost = 1000.0
        viewModel.totalJobs = 0

        XCTAssertEqual(viewModel.costPerJob, 0)
    }

    // MARK: - Formatted Total Jobs

    func testFormattedTotalJobsSmallNumber() {
        viewModel.totalJobs = 42
        XCTAssertEqual(viewModel.formattedTotalJobs, "42")
    }

    func testFormattedTotalJobsThousands() {
        viewModel.totalJobs = 1500
        XCTAssertEqual(viewModel.formattedTotalJobs, "1.5k")
    }

    func testFormattedTotalJobsMillions() {
        viewModel.totalJobs = 2_500_000
        XCTAssertEqual(viewModel.formattedTotalJobs, "2.5M")
    }

    func testFormattedTotalJobsExactThousand() {
        viewModel.totalJobs = 1000
        XCTAssertEqual(viewModel.formattedTotalJobs, "1.0k")
    }

    func testFormattedTotalJobsZero() {
        viewModel.totalJobs = 0
        XCTAssertEqual(viewModel.formattedTotalJobs, "0")
    }

    func testFormattedTotalJobsUnderThousand() {
        viewModel.totalJobs = 999
        XCTAssertEqual(viewModel.formattedTotalJobs, "999")
    }

    // MARK: - Currency Formatting

    func testFormatCurrencyNil() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(nil), "--")
    }

    func testFormatCurrencySmallValue() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(42.50), "$42.50")
    }

    func testFormatCurrencyHundreds() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(150.0), "$150")
    }

    func testFormatCurrencyThousands() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(5500.0), "$5.5k")
    }

    func testFormatCurrencyMillions() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(2_500_000.0), "$2.5M")
    }

    func testFormatCurrencyExactThousand() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(1000.0), "$1.0k")
    }

    func testFormatCurrencyExactMillion() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(1_000_000.0), "$1.0M")
    }

    func testFormatCurrencyZero() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(0.0), "$0.00")
    }

    func testFormatCurrencySubDollar() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrency(0.99), "$0.99")
    }

    // MARK: - Short Currency Formatting

    func testFormatCurrencyShortThousands() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrencyShort(5500.0), "$6k")
    }

    func testFormatCurrencyShortMillions() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrencyShort(2_500_000.0), "$3M")
    }

    func testFormatCurrencyShortSmall() {
        XCTAssertEqual(CostAnalysisViewModel.formatCurrencyShort(42.0), "$42")
    }

    // MARK: - Label Truncation

    func testTruncateLabelShortLabel() {
        let result = CostAnalysisViewModel.truncateLabel("short")
        XCTAssertEqual(result, "short")
    }

    func testTruncateLabelExactLength() {
        let label = String(repeating: "a", count: 20)
        let result = CostAnalysisViewModel.truncateLabel(label)
        XCTAssertEqual(result, label)
    }

    func testTruncateLabelTooLong() {
        let label = "linux-jammy-py3.10-gcc9-build-workflow-test"
        let result = CostAnalysisViewModel.truncateLabel(label)
        XCTAssertEqual(result.count, 20)
        XCTAssertTrue(result.hasSuffix("\u{2026}"))
        XCTAssertTrue(result.hasPrefix("linux-jammy-py3.10-"))
    }

    func testTruncateLabelCustomMaxLength() {
        let result = CostAnalysisViewModel.truncateLabel("abcdefghij", maxLength: 5)
        XCTAssertEqual(result, "abcd\u{2026}")
    }

    func testTruncateLabelEmptyString() {
        let result = CostAnalysisViewModel.truncateLabel("")
        XCTAssertEqual(result, "")
    }

    // MARK: - Cost Grouping

    func testAllCostGroupingsExist() {
        let allCases = CostAnalysisViewModel.CostGrouping.allCases
        XCTAssertEqual(allCases.count, 5)
        XCTAssertTrue(allCases.contains(.workflow))
        XCTAssertTrue(allCases.contains(.runnerType))
        XCTAssertTrue(allCases.contains(.repository))
        XCTAssertTrue(allCases.contains(.provider))
        XCTAssertTrue(allCases.contains(.platform))
    }

    func testCostGroupingQueryNames() {
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.workflow.queryName, "cost_job_per_workflow_name")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.runnerType.queryName, "cost_job_per_runner_type")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.repository.queryName, "cost_job_per_repo")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.provider.queryName, "cost_job_per_provider")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.platform.queryName, "cost_job_per_platform")
    }

    func testCostGroupingDisplayNames() {
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.workflow.displayName, "Workflow")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.runnerType.displayName, "Runner Type")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.repository.displayName, "Repository")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.provider.displayName, "Provider")
        XCTAssertEqual(CostAnalysisViewModel.CostGrouping.platform.displayName, "Platform")
    }

    // MARK: - Period Comparison

    func testPeriodComparisonDecrease() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 8000,
            previousPeriodCost: 10000
        )
        XCTAssertTrue(comparison.isDecrease)
        XCTAssertEqual(comparison.changeAmount, -2000, accuracy: 0.01)
        XCTAssertEqual(comparison.changePercentage, -20.0, accuracy: 0.01)
        XCTAssertEqual(comparison.percentageText, "-20.0%")
        XCTAssertEqual(comparison.changeText, "$2.0k saved")
    }

    func testPeriodComparisonIncrease() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 12000,
            previousPeriodCost: 10000
        )
        XCTAssertFalse(comparison.isDecrease)
        XCTAssertEqual(comparison.changeAmount, 2000, accuracy: 0.01)
        XCTAssertEqual(comparison.changePercentage, 20.0, accuracy: 0.01)
        XCTAssertEqual(comparison.percentageText, "+20.0%")
        XCTAssertEqual(comparison.changeText, "$2.0k increase")
    }

    func testPeriodComparisonNoChange() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 10000,
            previousPeriodCost: 10000
        )
        XCTAssertFalse(comparison.isDecrease) // equal is not decrease
        XCTAssertEqual(comparison.changeAmount, 0, accuracy: 0.01)
        XCTAssertEqual(comparison.changePercentage, 0, accuracy: 0.01)
    }

    func testPeriodComparisonZeroPrevious() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 5000,
            previousPeriodCost: 0
        )
        // guard previousPeriodCost > 0 => returns 0
        XCTAssertEqual(comparison.changePercentage, 0)
    }

    func testPeriodComparisonSmallChangeText() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 600,
            previousPeriodCost: 500
        )
        // Change = $100, which is < 1000, so no "k" suffix
        XCTAssertEqual(comparison.changeText, "$100 increase")
    }

    func testPeriodComparisonSmallSavedText() {
        let comparison = CostAnalysisViewModel.PeriodComparison(
            currentPeriodCost: 400,
            previousPeriodCost: 500
        )
        XCTAssertEqual(comparison.changeText, "$100 saved")
    }

    // MARK: - Time Range Changes

    func testTimeRangeChangeUpdatesProperty() {
        viewModel.selectedTimeRange = "7d"
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
    }

    func testInvalidTimeRangeReturnsNilSelectedRange() {
        viewModel.selectedTimeRange = "invalid"
        XCTAssertNil(viewModel.selectedRange)
    }

    // MARK: - Grouping Changes

    func testGroupingChangeUpdatesProperty() {
        viewModel.selectedGrouping = .runnerType
        XCTAssertEqual(viewModel.selectedGrouping, .runnerType)
    }

    func testGroupingChangeCallsCorrectEndpoint() async {
        viewModel.selectedGrouping = .platform

        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "linux", cost: 100.0),
        ])
        registerCostResponse(queryName: "cost_job_per_platform", json: json)

        await viewModel.onParametersChanged()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/cost_job_per_platform"))
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        let json = makeCostJSON(entries: [
            (bucket: "2024-01-01T00:00:00Z", workflowName: "pull", cost: 100.0),
        ])
        registerCostResponse(queryName: "cost_job_per_workflow_name", json: json)

        await viewModel.refresh()

        XCTAssertGreaterThanOrEqual(mockClient.callCount, 1)
    }

    // MARK: - CostQueryResult Decoding

    func testCostQueryResultDecoding() throws {
        let json = """
        {"granularity_bucket":"2024-01-01T00:00:00Z","workflow_name":"pull","runner_type":null,"repo":null,"provider":null,"platform":null,"total_cost":42.5}
        """
        let data = Data(json.utf8)
        let result = try JSONDecoder().decode(CostAnalysisViewModel.CostQueryResult.self, from: data)
        XCTAssertEqual(result.granularity_bucket, "2024-01-01T00:00:00Z")
        XCTAssertEqual(result.workflow_name, "pull")
        XCTAssertNil(result.runner_type)
        XCTAssertEqual(result.total_cost, 42.5, accuracy: 0.01)
        XCTAssertEqual(result.categoryName, "pull")
    }

    func testCostQueryResultCategoryNameFallback() throws {
        let json = """
        {"granularity_bucket":"2024-01-01T00:00:00Z","workflow_name":null,"runner_type":"linux.2xlarge","repo":null,"provider":null,"platform":null,"total_cost":10.0}
        """
        let data = Data(json.utf8)
        let result = try JSONDecoder().decode(CostAnalysisViewModel.CostQueryResult.self, from: data)
        XCTAssertEqual(result.categoryName, "linux.2xlarge")
    }

    func testCostQueryResultCategoryNameAllNil() throws {
        let json = """
        {"granularity_bucket":"2024-01-01T00:00:00Z","workflow_name":null,"runner_type":null,"repo":null,"provider":null,"platform":null,"total_cost":10.0}
        """
        let data = Data(json.utf8)
        let result = try JSONDecoder().decode(CostAnalysisViewModel.CostQueryResult.self, from: data)
        XCTAssertEqual(result.categoryName, "Unknown")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(CostAnalysisViewModel.ViewState.loading, .loading)
        XCTAssertEqual(CostAnalysisViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(CostAnalysisViewModel.ViewState.error("test"), .error("test"))
        XCTAssertNotEqual(CostAnalysisViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(CostAnalysisViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(CostAnalysisViewModel.ViewState.error("a"), .loading)
    }
}
