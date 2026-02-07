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

    /// Registers a successful response for the workflow_reliability endpoint.
    private func registerReliabilityResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/workflow_reliability")
    }

    /// Registers a successful response for the master_commit_red_percent (trend) endpoint.
    private func registerTrendResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/master_commit_red_percent")
    }

    /// Registers both required endpoints with sample data.
    private func registerBothEndpoints(
        reliabilityJSON: String = "[]",
        trendJSON: String = "[]"
    ) {
        registerReliabilityResponse(reliabilityJSON)
        registerTrendResponse(trendJSON)
    }

    /// Sample reliability JSON with 3 workflows.
    private let sampleReliabilityJSON = """
    [
        {"workflow_name":"pull / linux-jammy","total_jobs":1000,"failed_jobs":50,"broken_trunk":20,"flaky":15,"infra":15},
        {"workflow_name":"trunk / win-vs2022","total_jobs":500,"failed_jobs":100,"broken_trunk":40,"flaky":30,"infra":30},
        {"workflow_name":"periodic / nightly-build","total_jobs":200,"failed_jobs":10,"broken_trunk":5,"flaky":3,"infra":2}
    ]
    """

    /// Sample trend JSON with 6 data points (red-rate percentage values).
    private let sampleTrendJSON = """
    [
        {"granularity_bucket":"2024-01-01T00:00:00Z","value":8.0},
        {"granularity_bucket":"2024-01-02T00:00:00Z","value":7.5},
        {"granularity_bucket":"2024-01-03T00:00:00Z","value":9.0},
        {"granularity_bucket":"2024-01-04T00:00:00Z","value":5.0},
        {"granularity_bucket":"2024-01-05T00:00:00Z","value":4.5},
        {"granularity_bucket":"2024-01-06T00:00:00Z","value":3.0}
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
            reliabilityJSON: sampleReliabilityJSON,
            trendJSON: sampleTrendJSON
        )

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 6)
    }

    func testLoadReliabilityPopulatesWorkflowsSortedByFailureRate() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)

        await viewModel.loadReliability()

        // The workflows should be stored sorted by failure rate (worst first)
        XCTAssertEqual(viewModel.workflows[0].workflowName, "trunk / win-vs2022") // 20%
        XCTAssertEqual(viewModel.workflows[1].workflowName, "pull / linux-jammy") // 5%
        XCTAssertEqual(viewModel.workflows[2].workflowName, "periodic / nightly-build") // 5%
    }

    func testLoadReliabilityComputesTotals() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.totalJobs, 1700)
        XCTAssertEqual(viewModel.totalFailed, 160)
        XCTAssertEqual(viewModel.totalBrokenTrunk, 65)
        XCTAssertEqual(viewModel.totalFlaky, 48)
        XCTAssertEqual(viewModel.totalInfra, 47)
    }

    func testOverallRates() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)

        await viewModel.loadReliability()

        // 160/1700 * 100 = 9.41%
        let expectedFailureRate = Double(160) / Double(1700) * 100
        XCTAssertEqual(viewModel.overallFailureRate, expectedFailureRate, accuracy: 0.01)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100 - expectedFailureRate, accuracy: 0.01)
    }

    // MARK: - Load Error

    func testLoadReliabilityErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/workflow_reliability")
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
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":10.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":5.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 2)
        // 100 - 10 = 90
        XCTAssertEqual(viewModel.reliabilityTrendSeries[0].value, 90.0)
        // 100 - 5 = 95
        XCTAssertEqual(viewModel.reliabilityTrendSeries[1].value, 95.0)
    }

    func testTrendDataPreservesTimestamps() async {
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-06-15T12:00:00Z","value":3.0}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries[0].granularity_bucket, "2024-06-15T12:00:00Z")
    }

    func testTrendDataHandlesNullValues() async {
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":null}
        ]
        """)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 1)
        XCTAssertNil(viewModel.reliabilityTrendSeries[0].value)
    }

    func testTrendFailureDoesNotBlockWorkflowData() async {
        registerReliabilityResponse(sampleReliabilityJSON)
        // Do NOT register a trend response -> it will 404 but shouldn't block

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertTrue(viewModel.reliabilityTrendSeries.isEmpty)
    }

    // MARK: - Trend Direction

    func testTrendDirectionImproving() async {
        // First half average red: (20+18)/2 = 19, second half average red: (5+3)/2 = 4
        // Reliability first: (80+82)/2=81, second: (95+97)/2=96 -> delta = +15 -> improving
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":20.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":18.0},
            {"granularity_bucket":"2024-01-03T00:00:00Z","value":5.0},
            {"granularity_bucket":"2024-01-04T00:00:00Z","value":3.0}
        ]
        """)

        await viewModel.loadReliability()

        if case .improving(let delta) = viewModel.reliabilityTrend {
            XCTAssertEqual(delta, 15.0, accuracy: 0.1)
        } else {
            XCTFail("Expected improving trend but got \(viewModel.reliabilityTrend)")
        }
    }

    func testTrendDirectionDeclining() async {
        // First half average red: (3+2)/2 = 2.5, second half average red: (15+20)/2 = 17.5
        // Reliability first: 97.5, second: 82.5 -> delta = -15 -> declining
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":3.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":2.0},
            {"granularity_bucket":"2024-01-03T00:00:00Z","value":15.0},
            {"granularity_bucket":"2024-01-04T00:00:00Z","value":20.0}
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
        // First half avg red: 5.0, second half avg red: 5.2
        // Reliability first: 95.0, second: 94.8 -> delta = -0.2 -> stable (< 0.5 threshold)
        registerBothEndpoints(trendJSON: """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","value":5.0},
            {"granularity_bucket":"2024-01-02T00:00:00Z","value":5.0},
            {"granularity_bucket":"2024-01-03T00:00:00Z","value":5.2},
            {"granularity_bucket":"2024-01-04T00:00:00Z","value":5.2}
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
        [{"granularity_bucket":"2024-01-01T00:00:00Z","value":5.0}]
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
        // 95%+ reliability -> healthy
        registerBothEndpoints(reliabilityJSON: """
        [
            {"workflow_name":"w1","total_jobs":100,"failed_jobs":3,"broken_trunk":1,"flaky":1,"infra":1},
            {"workflow_name":"w2","total_jobs":100,"failed_jobs":4,"broken_trunk":2,"flaky":1,"infra":1},
            {"workflow_name":"w3","total_jobs":100,"failed_jobs":20,"broken_trunk":10,"flaky":5,"infra":5}
        ]
        """)

        await viewModel.loadReliability()

        // w1: 97% (healthy), w2: 96% (healthy), w3: 80% (critical)
        XCTAssertEqual(viewModel.healthyWorkflowCount, 2)
    }

    func testWarningWorkflowCount() async {
        // 90-95% reliability -> warning
        registerBothEndpoints(reliabilityJSON: """
        [
            {"workflow_name":"w1","total_jobs":100,"failed_jobs":8,"broken_trunk":null,"flaky":null,"infra":null},
            {"workflow_name":"w2","total_jobs":100,"failed_jobs":3,"broken_trunk":null,"flaky":null,"infra":null}
        ]
        """)

        await viewModel.loadReliability()

        // w1: 92% (warning), w2: 97% (healthy)
        XCTAssertEqual(viewModel.warningWorkflowCount, 1)
    }

    func testCriticalWorkflowCount() async {
        // < 90% reliability -> critical
        registerBothEndpoints(reliabilityJSON: """
        [
            {"workflow_name":"w1","total_jobs":100,"failed_jobs":15,"broken_trunk":null,"flaky":null,"infra":null},
            {"workflow_name":"w2","total_jobs":100,"failed_jobs":25,"broken_trunk":null,"flaky":null,"infra":null}
        ]
        """)

        await viewModel.loadReliability()

        // w1: 85% (critical), w2: 75% (critical)
        XCTAssertEqual(viewModel.criticalWorkflowCount, 2)
    }

    // MARK: - Filters

    func testFilterAll() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .all
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testFilterPrimary() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let filtered = viewModel.filteredWorkflows
        // "pull / linux-jammy" contains "pull" and "linux", "trunk / win-vs2022" contains "trunk" and "win"
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { viewModel.isPrimaryWorkflow($0.workflowName) })
    }

    func testFilterSecondary() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .secondary
        let filtered = viewModel.filteredWorkflows
        // "periodic / nightly-build" contains "periodic" and "nightly"
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "periodic / nightly-build")
    }

    func testFilterUnstable() async {
        registerBothEndpoints(reliabilityJSON: """
        [
            {"workflow_name":"pull / linux-unstable","total_jobs":100,"failed_jobs":10,"broken_trunk":null,"flaky":null,"infra":null},
            {"workflow_name":"pull / linux-jammy","total_jobs":100,"failed_jobs":5,"broken_trunk":null,"flaky":null,"infra":null}
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
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "pull / linux-jammy")
    }

    func testSearchIsCaseInsensitive() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "WIN"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022")
    }

    func testSearchWithNoMatch() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "nonexistent"
        XCTAssertTrue(viewModel.filteredWorkflows.isEmpty)
    }

    func testEmptySearchReturnsAll() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.searchText = ""
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testSearchCombinesWithFilter() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].workflowName, "pull / linux-jammy")
    }

    // MARK: - Sort Order

    func testSortWorstFirst() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .worstFirst
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022") // 20%
        XCTAssertEqual(filtered.last?.workflowName, "periodic / nightly-build") // 5%
    }

    func testSortBestFirst() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .bestFirst
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "periodic / nightly-build") // 5%
        XCTAssertEqual(filtered.last?.workflowName, "trunk / win-vs2022") // 20%
    }

    func testSortNameAZ() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameAZ
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "periodic / nightly-build")
        XCTAssertEqual(filtered[1].workflowName, "pull / linux-jammy")
        XCTAssertEqual(filtered[2].workflowName, "trunk / win-vs2022")
    }

    func testSortNameZA() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameZA
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered[0].workflowName, "trunk / win-vs2022")
        XCTAssertEqual(filtered[1].workflowName, "pull / linux-jammy")
        XCTAssertEqual(filtered[2].workflowName, "periodic / nightly-build")
    }

    // MARK: - Failure Breakdown

    func testFailureBreakdownHasThreeCategories() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown.count, 3)
        XCTAssertEqual(breakdown[0].category, "Broken Trunk")
        XCTAssertEqual(breakdown[1].category, "Flaky")
        XCTAssertEqual(breakdown[2].category, "Infra")
    }

    func testFailureBreakdownCounts() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown[0].count, 65) // Broken Trunk
        XCTAssertEqual(breakdown[1].count, 48) // Flaky
        XCTAssertEqual(breakdown[2].count, 47) // Infra
    }

    func testFailureBreakdownWithNullCategoriesDefaultsToZero() async {
        registerBothEndpoints(reliabilityJSON: """
        [{"workflow_name":"w1","total_jobs":100,"failed_jobs":10,"broken_trunk":null,"flaky":null,"infra":null}]
        """)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown[0].count, 0) // Broken Trunk
        XCTAssertEqual(breakdown[1].count, 0) // Flaky
        XCTAssertEqual(breakdown[2].count, 0) // Infra
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()
        XCTAssertEqual(viewModel.workflows.count, 3)

        // Clear and register new data
        mockClient.reset()
        registerBothEndpoints(reliabilityJSON: """
        [{"workflow_name":"new-workflow","total_jobs":50,"failed_jobs":5,"broken_trunk":null,"flaky":null,"infra":null}]
        """)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 1)
        XCTAssertEqual(viewModel.workflows[0].workflowName, "new-workflow")
    }

    func testRefreshDoesNotResetStateToLoading() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
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
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        let initialCallCount = mockClient.callCount
        mockClient.reset()
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)

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
        registerBothEndpoints(reliabilityJSON: """
        [{"workflow_name":"empty","total_jobs":0,"failed_jobs":0,"broken_trunk":null,"flaky":null,"infra":null}]
        """)
        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.overallFailureRate, 0)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100)
    }

    func testFilteredTotalsUpdateWithFilter() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let primaryTotal = viewModel.totalJobs

        viewModel.selectedFilter = .secondary
        let secondaryTotal = viewModel.totalJobs

        // Primary should have more jobs than secondary
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

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/workflow_reliability"))
        XCTAssertTrue(paths.contains("/api/clickhouse/master_commit_red_percent"))
    }

    func testLoadSetsLoadingStateThenLoaded() async {
        registerBothEndpoints(reliabilityJSON: sampleReliabilityJSON)

        // Before load
        XCTAssertEqual(viewModel.state, .loading)

        await viewModel.loadReliability()

        // After load
        XCTAssertEqual(viewModel.state, .loaded)
    }
}
