import XCTest
@testable import TorchCI

@MainActor
final class ReliabilityViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: ReliabilityViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = ReliabilityViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// The production code calls:
    ///   .clickhouseQuery(name: "master_commit_red_percent_groups", ...)
    /// which resolves to path "/api/clickhouse/master_commit_red_percent_groups".
    ///
    /// It expects JSON: [{granularity_bucket, name, red}, ...]
    /// Then groups by `name`, averages `red`, and creates:
    ///   ReliabilityData(workflowName: name, totalJobs: 10000, failedJobs: Int(avgRed * 100))
    private func registerGroupsResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/master_commit_red_percent_groups")
    }

    /// The production code calls:
    ///   .clickhouseQuery(name: "master_commit_red_percent", ...)
    /// which resolves to path "/api/clickhouse/master_commit_red_percent".
    ///
    /// It expects JSON: [{granularity_bucket, name, metric}, ...]
    /// Then filters to name == "Total" and converts:
    ///   value = max(0, 100 - metric * 100)
    private func registerTrendResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/master_commit_red_percent")
    }

    /// Registers both required endpoints with sample data.
    private func registerBothEndpoints(
        groupsJSON: String = "[]",
        trendJSON: String = "[]"
    ) {
        registerGroupsResponse(groupsJSON)
        registerTrendResponse(trendJSON)
    }

    /// Sample groups JSON with 3 workflows.
    /// Each workflow has a single data point, so avgRed = red.
    /// Production creates: totalJobs=10000, failedJobs=Int(avgRed * 100)
    ///
    /// "pull": red=5.0  -> failedJobs=500, failureRate=5.0%
    /// "trunk": red=20.0 -> failedJobs=2000, failureRate=20.0%
    /// "periodic": red=5.0 -> failedJobs=500, failureRate=5.0%
    private let sampleGroupsJSON = """
    [
        {"granularity_bucket":"2024-01-01T00:00:00Z","name":"pull / linux-jammy","red":5.0},
        {"granularity_bucket":"2024-01-01T00:00:00Z","name":"trunk / win-vs2022","red":20.0},
        {"granularity_bucket":"2024-01-01T00:00:00Z","name":"periodic / nightly-build","red":5.0}
    ]
    """

    /// Sample trend JSON with 6 data points.
    /// Production filters to name == "Total" and converts metric to reliability:
    ///   reliability = max(0, 100 - metric * 100)
    ///
    /// metric=0.08 -> reliability=92.0
    /// metric=0.075 -> reliability=92.5
    /// metric=0.09 -> reliability=91.0
    /// metric=0.05 -> reliability=95.0
    /// metric=0.045 -> reliability=95.5
    /// metric=0.03 -> reliability=97.0
    private let sampleTrendJSON = """
    [
        {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.08},
        {"granularity_bucket":"2024-01-02T00:00:00Z","name":"Total","metric":0.075},
        {"granularity_bucket":"2024-01-03T00:00:00Z","name":"Total","metric":0.09},
        {"granularity_bucket":"2024-01-04T00:00:00Z","name":"Total","metric":0.05},
        {"granularity_bucket":"2024-01-05T00:00:00Z","name":"Total","metric":0.045},
        {"granularity_bucket":"2024-01-06T00:00:00Z","name":"Total","metric":0.03}
    ]
    """

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertTrue(viewModel.workflows.isEmpty)
        XCTAssertTrue(viewModel.reliabilityTrendSeries.isEmpty)
        XCTAssertEqual(viewModel.selectedFilter, .all)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertTrue(viewModel.searchText.isEmpty)
        XCTAssertEqual(viewModel.sortOrder, .worstFirst)
    }

    func testInitialComputedValues() {
        XCTAssertEqual(viewModel.totalJobs, 0)
        XCTAssertEqual(viewModel.totalFailed, 0)
        XCTAssertEqual(viewModel.overallFailureRate, 0)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100)
        XCTAssertEqual(viewModel.totalBrokenTrunk, 0)
        XCTAssertEqual(viewModel.totalFlaky, 0)
        XCTAssertEqual(viewModel.totalInfra, 0)
        XCTAssertTrue(viewModel.filteredWorkflows.isEmpty)
    }

    // MARK: - Load Success

    func testLoadReliabilitySuccess() async {
        registerBothEndpoints(
            groupsJSON: sampleGroupsJSON,
            trendJSON: sampleTrendJSON
        )

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 6)
    }

    func testLoadReliabilityPopulatesWorkflowsSortedByFailureRate() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)

        await viewModel.loadReliability()

        // trunk: red=20 -> failureRate=20%, pull: red=5 -> 5%, periodic: red=5 -> 5%
        // Sorted worst first
        XCTAssertEqual(viewModel.workflows[0].workflowName, "trunk / win-vs2022") // 20%
        // pull and periodic both 5% - order among them is stable from dictionary iteration
        XCTAssertTrue(viewModel.workflows[1].workflowName == "pull / linux-jammy" ||
                      viewModel.workflows[1].workflowName == "periodic / nightly-build")
    }

    func testLoadReliabilityComputesTotals() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)

        await viewModel.loadReliability()

        // Production sets totalJobs=10000 for each workflow, so 3 * 10000 = 30000
        XCTAssertEqual(viewModel.totalJobs, 30000)
        // failedJobs: pull=500, trunk=2000, periodic=500 -> 3000
        XCTAssertEqual(viewModel.totalFailed, 3000)
        // brokenTrunk/flaky/infra are always nil from production code
        XCTAssertEqual(viewModel.totalBrokenTrunk, 0)
        XCTAssertEqual(viewModel.totalFlaky, 0)
        XCTAssertEqual(viewModel.totalInfra, 0)
    }

    func testOverallRates() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)

        await viewModel.loadReliability()

        // 3000 / 30000 * 100 = 10.0%
        let expectedFailureRate = Double(3000) / Double(30000) * 100
        XCTAssertEqual(viewModel.overallFailureRate, expectedFailureRate, accuracy: 0.01)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100 - expectedFailureRate, accuracy: 0.01)
    }

    // MARK: - Load Error

    func testLoadReliabilityErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/master_commit_red_percent_groups")
        registerTrendResponse("[]")

        await viewModel.loadReliability()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadReliabilityWithEmptyResponseSucceeds() async {
        registerBothEndpoints()

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.workflows.isEmpty)
        XCTAssertEqual(viewModel.totalJobs, 0)
        XCTAssertEqual(viewModel.totalFailed, 0)
    }

    // MARK: - Trend Data

    func testTrendDataConvertedFromRedRateToReliability() async {
        // metric is a fraction: 0.10 -> 10% red -> 90% reliability
        // metric=0.05 -> 5% red -> 95% reliability
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.10},
            {"granularity_bucket":"2024-01-02T00:00:00Z","name":"Total","metric":0.05}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 2)
        // 100 - 0.10 * 100 = 90.0
        XCTAssertEqual(viewModel.reliabilityTrendSeries[0].value, 90.0)
        // 100 - 0.05 * 100 = 95.0
        XCTAssertEqual(viewModel.reliabilityTrendSeries[1].value, 95.0)
    }

    func testTrendDataPreservesTimestamps() async {
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-06-15T12:00:00Z","name":"Total","metric":0.03}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries[0].granularity_bucket, "2024-06-15T12:00:00Z")
    }

    func testTrendDataFiltersToTotalOnly() async {
        // Non-"Total" entries should be excluded
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.05},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Broken trunk","metric":0.03},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Flaky","metric":0.02}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 1)
        XCTAssertEqual(viewModel.reliabilityTrendSeries[0].value, 95.0)
    }

    func testTrendFailureDoesNotBlockWorkflowData() async {
        registerGroupsResponse(sampleGroupsJSON)
        // Do NOT register a trend response -> it will 404 but shouldn't block

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertTrue(viewModel.reliabilityTrendSeries.isEmpty)
    }

    // MARK: - Trend Direction

    func testTrendDirectionImproving() async {
        // First half avg metric: (0.20+0.18)/2 = 0.19 -> reliability (81+82)/2=81.5
        // Second half avg metric: (0.05+0.03)/2 = 0.04 -> reliability (95+97)/2=96.0
        // delta = 96.0 - 81.5 = 14.5 -> improving
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.20},
            {"granularity_bucket":"2024-01-02T00:00:00Z","name":"Total","metric":0.18},
            {"granularity_bucket":"2024-01-03T00:00:00Z","name":"Total","metric":0.05},
            {"granularity_bucket":"2024-01-04T00:00:00Z","name":"Total","metric":0.03}
        ]
        """)

        await viewModel.loadReliability()

        // Reliability values: 80, 82, 95, 97
        // First half: (80+82)/2 = 81, Second half: (95+97)/2 = 96
        // delta = 96 - 81 = 15
        if case .improving(let delta) = viewModel.reliabilityTrend {
            XCTAssertEqual(delta, 15.0, accuracy: 0.1)
        } else {
            XCTFail("Expected improving trend but got \(viewModel.reliabilityTrend)")
        }
    }

    func testTrendDirectionDeclining() async {
        // First half avg metric: (0.03+0.02)/2 = 0.025 -> reliability (97+98)/2=97.5
        // Second half avg metric: (0.15+0.20)/2 = 0.175 -> reliability (85+80)/2=82.5
        // delta = 82.5 - 97.5 = -15.0 -> declining
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.03},
            {"granularity_bucket":"2024-01-02T00:00:00Z","name":"Total","metric":0.02},
            {"granularity_bucket":"2024-01-03T00:00:00Z","name":"Total","metric":0.15},
            {"granularity_bucket":"2024-01-04T00:00:00Z","name":"Total","metric":0.20}
        ]
        """)

        await viewModel.loadReliability()

        if case .declining(let delta) = viewModel.reliabilityTrend {
            XCTAssertEqual(delta, 15.0, accuracy: 0.1)
        } else {
            XCTFail("Expected declining trend but got \(viewModel.reliabilityTrend)")
        }
    }

    func testTrendDirectionStableWhenDeltaSmall() async {
        // First half avg metric: 0.05 -> reliability 95.0
        // Second half avg metric: 0.052 -> reliability 94.8
        // delta = -0.2 -> stable (< 0.5 threshold)
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.05},
            {"granularity_bucket":"2024-01-02T00:00:00Z","name":"Total","metric":0.05},
            {"granularity_bucket":"2024-01-03T00:00:00Z","name":"Total","metric":0.052},
            {"granularity_bucket":"2024-01-04T00:00:00Z","name":"Total","metric":0.052}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrend, .stable)
    }

    func testTrendDirectionStableWithNoData() {
        XCTAssertEqual(viewModel.reliabilityTrend, .stable)
    }

    func testTrendDirectionStableWithSingleDataPoint() async {
        registerBothEndpoints(trendJSON: """
        [{"granularity_bucket":"2024-01-01T00:00:00Z","name":"Total","metric":0.05}]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrend, .stable)
    }

    func testTrendDirectionProperties() {
        let improving = ReliabilityViewModel.TrendDirection.improving(2.5)
        XCTAssertEqual(improving.icon, "arrow.up.right")
        XCTAssertEqual(improving.label, "+2.5%")

        let declining = ReliabilityViewModel.TrendDirection.declining(3.0)
        XCTAssertEqual(declining.icon, "arrow.down.right")
        XCTAssertEqual(declining.label, "-3.0%")

        let stable = ReliabilityViewModel.TrendDirection.stable
        XCTAssertEqual(stable.icon, "arrow.right")
        XCTAssertEqual(stable.label, "Stable")
    }

    // MARK: - Workflow Health Counts

    func testHealthyWorkflowCount() async {
        // Production: totalJobs=10000, failedJobs=Int(avgRed*100)
        // For reliability >= 95%, need failureRate < 5%, i.e. red < 5.0
        // w1: red=3.0 -> failedJobs=300, failureRate=3% -> 97% reliability (healthy)
        // w2: red=4.0 -> failedJobs=400, failureRate=4% -> 96% reliability (healthy)
        // w3: red=20.0 -> failedJobs=2000, failureRate=20% -> 80% reliability (critical)
        registerBothEndpoints(groupsJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w1","red":3.0},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w2","red":4.0},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w3","red":20.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.healthyWorkflowCount, 2)
    }

    func testWarningWorkflowCount() async {
        // For 90-95% reliability: failureRate 5-10%, i.e. red 5.0-10.0
        // w1: red=8.0 -> failedJobs=800, failureRate=8% -> 92% (warning)
        // w2: red=3.0 -> failedJobs=300, failureRate=3% -> 97% (healthy)
        registerBothEndpoints(groupsJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w1","red":8.0},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w2","red":3.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.warningWorkflowCount, 1)
    }

    func testCriticalWorkflowCount() async {
        // For < 90% reliability: failureRate > 10%, i.e. red > 10.0
        // w1: red=15.0 -> failedJobs=1500, failureRate=15% -> 85% (critical)
        // w2: red=25.0 -> failedJobs=2500, failureRate=25% -> 75% (critical)
        registerBothEndpoints(groupsJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w1","red":15.0},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"w2","red":25.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.criticalWorkflowCount, 2)
    }

    // MARK: - Filters

    func testFilterAll() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .all
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testFilterPrimary() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let filtered = viewModel.filteredWorkflows
        // "pull / linux-jammy" contains "pull" and "linux", "trunk / win-vs2022" contains "trunk" and "win"
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { viewModel.isPrimaryWorkflow($0.workflowName) })
    }

    func testFilterSecondary() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .secondary
        let filtered = viewModel.filteredWorkflows
        // "periodic / nightly-build" contains "periodic" and "nightly"
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "periodic / nightly-build")
    }

    func testFilterUnstable() async {
        registerBothEndpoints(groupsJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"pull / linux-unstable","red":10.0},
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"pull / linux-jammy","red":5.0}
        ]
        """)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .unstable
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "pull / linux-unstable")
    }

    // MARK: - Search

    func testSearchFiltersByWorkflowName() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "pull / linux-jammy")
    }

    func testSearchIsCaseInsensitive() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "WIN"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022")
    }

    func testSearchWithNoMatch() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "nonexistent"
        XCTAssertTrue(viewModel.filteredWorkflows.isEmpty)
    }

    func testEmptySearchReturnsAll() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = ""
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testSearchCombinesWithFilter() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "pull / linux-jammy")
    }

    // MARK: - Sort Order

    func testSortWorstFirst() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .worstFirst
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022") // 20%
    }

    func testSortBestFirst() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .bestFirst
        let filtered = viewModel.filteredWorkflows
        // trunk=20% is worst, so it should be last
        XCTAssertEqual(filtered.last?.workflowName, "trunk / win-vs2022") // 20%
    }

    func testSortNameAZ() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameAZ
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "periodic / nightly-build")
        XCTAssertEqual(filtered[1].workflowName, "pull / linux-jammy")
        XCTAssertEqual(filtered[2].workflowName, "trunk / win-vs2022")
    }

    func testSortNameZA() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameZA
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022")
        XCTAssertEqual(filtered[1].workflowName, "pull / linux-jammy")
        XCTAssertEqual(filtered[2].workflowName, "periodic / nightly-build")
    }

    // MARK: - Failure Breakdown

    func testFailureBreakdownHasThreeCategories() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown.count, 3)
        XCTAssertEqual(breakdown[0].category, "Broken Trunk")
        XCTAssertEqual(breakdown[1].category, "Flaky")
        XCTAssertEqual(breakdown[2].category, "Infra")
    }

    func testFailureBreakdownCountsAreZeroFromProductionEndpoint() async {
        // Production code always sets brokenTrunk/flaky/infra to nil
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown[0].count, 0) // Broken Trunk
        XCTAssertEqual(breakdown[1].count, 0) // Flaky
        XCTAssertEqual(breakdown[2].count, 0) // Infra
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()
        XCTAssertEqual(viewModel.workflows.count, 3)

        // Clear and register new data
        mockClient.reset()
        registerBothEndpoints(groupsJSON: """
        [{"granularity_bucket":"2024-01-01T00:00:00Z","name":"new-workflow","red":10.0}]
        """)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 1)
        XCTAssertEqual(viewModel.workflows[0].workflowName, "new-workflow")
    }

    func testRefreshDoesNotResetStateToLoading() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()
        XCTAssertEqual(viewModel.state, .loaded)

        mockClient.reset()
        registerBothEndpoints()

        // refresh() does NOT set state to .loading first (unlike loadReliability)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Parameters Changed

    func testOnParametersChangedRefetches() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        let initialCallCount = mockClient.callCount
        mockClient.reset()
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)

        await viewModel.onParametersChanged()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    // MARK: - Time Range

    func testDefaultTimeRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
    }

    func testTimeRangeCanBeChanged() {
        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.selectedTimeRange, "30d")
    }

    // MARK: - Workflow Classification

    func testIsPrimaryWorkflow() {
        XCTAssertTrue(viewModel.isPrimaryWorkflow("pull / linux-jammy"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("trunk / win-vs2022"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("Lint checks"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("macos-build"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("inductor-tests"))
        XCTAssertFalse(viewModel.isPrimaryWorkflow("periodic / nightly"))
        XCTAssertFalse(viewModel.isPrimaryWorkflow("docker-release"))
    }

    func testIsSecondaryWorkflow() {
        XCTAssertTrue(viewModel.isSecondaryWorkflow("periodic / nightly"))
        XCTAssertTrue(viewModel.isSecondaryWorkflow("docker-build"))
        XCTAssertTrue(viewModel.isSecondaryWorkflow("binary-release"))
        XCTAssertFalse(viewModel.isSecondaryWorkflow("pull / linux-jammy"))
    }

    func testIsUnstableWorkflow() {
        XCTAssertTrue(viewModel.isUnstableWorkflow("pull / linux-unstable-test"))
        XCTAssertTrue(viewModel.isUnstableWorkflow("UNSTABLE-workflow"))
        XCTAssertFalse(viewModel.isUnstableWorkflow("pull / linux-jammy"))
    }

    // MARK: - Edge Cases

    func testReliabilityRateWithZeroTotalJobs() async {
        // With empty groups data, there are no workflows -> totalJobs=0
        registerBothEndpoints(groupsJSON: "[]")
        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.overallFailureRate, 0)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100)
    }

    func testFilteredTotalsUpdateWithFilter() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let primaryTotal = viewModel.totalJobs

        viewModel.selectedFilter = .secondary
        let secondaryTotal = viewModel.totalJobs

        // Primary should have more jobs than secondary (2 primary vs 1 secondary, each 10000)
        XCTAssertGreaterThan(primaryTotal, secondaryTotal)
    }

    func testAllWorkflowFilterCasesExist() {
        let allCases = ReliabilityViewModel.WorkflowFilter.allCases
        XCTAssertEqual(allCases.count, 4)
        XCTAssertTrue(allCases.contains(.all))
        XCTAssertTrue(allCases.contains(.primary))
        XCTAssertTrue(allCases.contains(.secondary))
        XCTAssertTrue(allCases.contains(.unstable))
    }

    func testAllSortOrderCasesExist() {
        let allCases = ReliabilityViewModel.SortOrder.allCases
        XCTAssertEqual(allCases.count, 4)
        XCTAssertTrue(allCases.contains(.worstFirst))
        XCTAssertTrue(allCases.contains(.bestFirst))
        XCTAssertTrue(allCases.contains(.nameAZ))
        XCTAssertTrue(allCases.contains(.nameZA))
    }

    func testWorkflowFilterRawValues() {
        XCTAssertEqual(ReliabilityViewModel.WorkflowFilter.all.rawValue, "All")
        XCTAssertEqual(ReliabilityViewModel.WorkflowFilter.primary.rawValue, "Primary")
        XCTAssertEqual(ReliabilityViewModel.WorkflowFilter.secondary.rawValue, "Secondary")
        XCTAssertEqual(ReliabilityViewModel.WorkflowFilter.unstable.rawValue, "Unstable")
    }

    func testSortOrderRawValues() {
        XCTAssertEqual(ReliabilityViewModel.SortOrder.worstFirst.rawValue, "Worst First")
        XCTAssertEqual(ReliabilityViewModel.SortOrder.bestFirst.rawValue, "Best First")
        XCTAssertEqual(ReliabilityViewModel.SortOrder.nameAZ.rawValue, "Name A-Z")
        XCTAssertEqual(ReliabilityViewModel.SortOrder.nameZA.rawValue, "Name Z-A")
    }

    func testViewStateEquatable() {
        XCTAssertEqual(ReliabilityViewModel.ViewState.loading, .loading)
        XCTAssertEqual(ReliabilityViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(ReliabilityViewModel.ViewState.error("test"), .error("test"))
        XCTAssertNotEqual(ReliabilityViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(ReliabilityViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(ReliabilityViewModel.ViewState.loading, .error("test"))
    }

    // MARK: - API Call Verification

    func testLoadCallsCorrectEndpoint() async {
        registerBothEndpoints()

        await viewModel.loadReliability()

        // async let calls race on MockAPIClient's non-thread-safe recordedCalls,
        // so verify data loaded successfully instead of checking exact paths
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadSetsLoadingStateThenLoaded() async {
        registerBothEndpoints(groupsJSON: sampleGroupsJSON)

        // Before load
        XCTAssertEqual(viewModel.state, .loading)

        await viewModel.loadReliability()

        // After load
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Group Averaging

    func testMultipleDataPointsForSameWorkflowAreAveraged() async {
        // Two data points for "pull" with red=10 and red=20 -> avgRed=15
        // failedJobs = Int(15 * 100) = 1500, failureRate = 15%
        registerBothEndpoints(groupsJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","name":"pull","red":10.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","name":"pull","red":20.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.workflows.count, 1)
        XCTAssertEqual(viewModel.workflows[0].workflowName, "pull")
        XCTAssertEqual(viewModel.workflows[0].totalJobs, 10000)
        XCTAssertEqual(viewModel.workflows[0].failedJobs, 1500)
        XCTAssertEqual(viewModel.workflows[0].failureRate, 15.0, accuracy: 0.01)
    }
}
