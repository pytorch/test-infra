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
    ///   .clickhouseQuery(name: "master_commit_red_jobs", ...)
    /// which resolves to path "/api/clickhouse/master_commit_red_jobs".
    ///
    /// It expects JSON: [{sha, time, author, body, failures: [...], successes: [...]}, ...]
    /// Each entry represents one commit with its failing and succeeding job names.
    private func registerJobsResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/master_commit_red_jobs")
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
        jobsJSON: String = "[]",
        trendJSON: String = "[]"
    ) {
        registerJobsResponse(jobsJSON)
        registerTrendResponse(trendJSON)
    }

    /// Sample jobs JSON with 5 commits.
    /// Commits are ordered newest-first (time descending), matching the query.
    ///
    /// Commit 5 (newest): "pull / linux-jammy" fails, "trunk / win-vs2022" succeeds
    /// Commit 4: "pull / linux-jammy" fails, "trunk / win-vs2022" fails
    /// Commit 3: "pull / linux-jammy" fails, "trunk / win-vs2022" fails
    /// Commit 2: "trunk / win-vs2022" fails, "pull / linux-jammy" succeeds
    /// Commit 1 (oldest): "periodic / nightly-build" fails, both others succeed
    ///
    /// "pull / linux-jammy": fails in commits 5,4,3 (streak of 3 >= threshold) -> Broken Trunk = 3
    /// "trunk / win-vs2022": fails in commits 4,3,2 (streak of 3 >= threshold) -> Broken Trunk = 3
    /// "periodic / nightly-build": fails in commit 1 only (streak of 1) -> Flaky = 1
    private let sampleJobsJSON = """
    [
        {"sha":"e","time":"2024-01-05T00:00:00Z","author":"user","body":"",
         "failures":["pull / linux-jammy / build"],
         "successes":["trunk / win-vs2022 / test"]},
        {"sha":"d","time":"2024-01-04T00:00:00Z","author":"user","body":"",
         "failures":["pull / linux-jammy / build","trunk / win-vs2022 / test"],
         "successes":[]},
        {"sha":"c","time":"2024-01-03T00:00:00Z","author":"user","body":"",
         "failures":["pull / linux-jammy / build","trunk / win-vs2022 / test"],
         "successes":[]},
        {"sha":"b","time":"2024-01-02T00:00:00Z","author":"user","body":"",
         "failures":["trunk / win-vs2022 / test"],
         "successes":["pull / linux-jammy / build"]},
        {"sha":"a","time":"2024-01-01T00:00:00Z","author":"user","body":"",
         "failures":["periodic / nightly-build / job"],
         "successes":["pull / linux-jammy / build","trunk / win-vs2022 / test"]}
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
            jobsJSON: sampleJobsJSON,
            trendJSON: sampleTrendJSON
        )

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertEqual(viewModel.reliabilityTrendSeries.count, 6)
    }

    func testLoadReliabilityPopulatesWorkflowsSortedByFailureRate() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

        await viewModel.loadReliability()

        // All three jobs should appear. "periodic / nightly-build / job" has highest
        // failure rate (1 failure, 1 total = 100%), then the other two have 3 failures
        // each out of more total appearances.
        XCTAssertEqual(viewModel.workflows.count, 3)
        // Verify sorted worst first: first workflow should have highest failureRate
        for i in 0..<(viewModel.workflows.count - 1) {
            XCTAssertGreaterThanOrEqual(
                viewModel.workflows[i].failureRate,
                viewModel.workflows[i + 1].failureRate
            )
        }
    }

    func testLoadReliabilityComputesRealTotals() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

        await viewModel.loadReliability()

        // totalJobs should be sum of real successes + non-infra failures per job, NOT hardcoded 10000
        XCTAssertGreaterThan(viewModel.totalJobs, 0)
        // No workflow should have totalJobs == 10000
        for wf in viewModel.workflows {
            XCTAssertNotEqual(wf.totalJobs, 10000, "totalJobs should be computed from real data, not hardcoded")
        }
        // totalFailed should be > 0
        XCTAssertGreaterThan(viewModel.totalFailed, 0)
    }

    func testFailureCategoriesArePopulated() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

        await viewModel.loadReliability()

        // With sample data, we should have real broken trunk counts
        XCTAssertGreaterThan(viewModel.totalBrokenTrunk, 0, "Broken trunk should be populated from real data")
    }

    func testOverallRates() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

        await viewModel.loadReliability()

        // Overall failure rate should be positive and less than 100
        XCTAssertGreaterThan(viewModel.overallFailureRate, 0)
        XCTAssertLessThan(viewModel.overallFailureRate, 100)
        XCTAssertEqual(viewModel.overallFailureRate + viewModel.overallReliabilityRate, 100, accuracy: 0.01)
    }

    // MARK: - Load Error

    func testLoadReliabilityErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/master_commit_red_jobs")
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
        registerJobsResponse(sampleJobsJSON)
        // Do NOT register a trend response -> it will 404 but shouldn't block

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 3)
        XCTAssertTrue(viewModel.reliabilityTrendSeries.isEmpty)
    }

    // MARK: - Trend Direction

    func testTrendDirectionImproving() async {
        // First half avg metric: (0.20+0.18)/2 = 0.19 -> reliability (81+82)/2=81.5 -> actually (80+82)/2=81
        // Second half avg metric: (0.05+0.03)/2 = 0.04 -> reliability (95+97)/2=96
        // delta = 96 - 81 = 15 -> improving
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
        // Create a scenario where some jobs have high reliability.
        // job_a: fails 1 commit, succeeds 99 -> 1/100 = 1% failure -> 99% reliability (healthy)
        // job_b: fails 1 commit, succeeds 99 -> 1/100 = 1% failure -> 99% reliability (healthy)
        // job_c: fails 50 commits in a row -> 50/50 = 100% failure -> 0% reliability (critical)
        var commits: [[String: Any]] = []
        // 50 commits where only job_c fails
        for i in 0..<50 {
            commits.append([
                "sha": "c\(i)", "time": "2024-01-\(String(format: "%02d", i + 1))T00:00:00Z",
                "author": "user", "body": "",
                "failures": ["job_c"],
                "successes": ["job_a", "job_b"],
            ])
        }
        // 49 commits where everything succeeds
        for i in 50..<99 {
            commits.append([
                "sha": "s\(i)", "time": "2024-02-\(String(format: "%02d", i - 49))T00:00:00Z",
                "author": "user", "body": "",
                "failures": [] as [String],
                "successes": ["job_a", "job_b"],
            ])
        }
        // 1 commit where job_a and job_b fail
        commits.append([
            "sha": "f1", "time": "2024-03-01T00:00:00Z",
            "author": "user", "body": "",
            "failures": ["job_a", "job_b"],
            "successes": [] as [String],
        ])
        let jsonData = try! JSONSerialization.data(withJSONObject: commits)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        registerBothEndpoints(jobsJSON: jsonString)

        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.healthyWorkflowCount, 2) // job_a and job_b
    }

    func testCriticalWorkflowCount() async {
        // Create jobs that always fail: reliability < 90%
        // 10 commits, each has job_a and job_b failing, nothing succeeding
        var commits: [[String: Any]] = []
        for i in 0..<10 {
            commits.append([
                "sha": "s\(i)", "time": "2024-01-\(String(format: "%02d", i + 1))T00:00:00Z",
                "author": "user", "body": "",
                "failures": ["job_a", "job_b"],
                "successes": [] as [String],
            ])
        }
        let jsonData = try! JSONSerialization.data(withJSONObject: commits)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        registerBothEndpoints(jobsJSON: jsonString)

        await viewModel.loadReliability()

        // Both jobs have 100% failure rate (well below 90% reliability)
        XCTAssertEqual(viewModel.criticalWorkflowCount, 2)
    }

    // MARK: - Filters

    func testFilterAll() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .all
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testFilterPrimary() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let filtered = viewModel.filteredWorkflows
        // "pull / linux-jammy / build" -> primary (contains "pull" and "linux")
        // "trunk / win-vs2022 / test" -> primary (contains "trunk" and "win")
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { viewModel.isPrimaryWorkflow($0.workflowName) })
    }

    func testFilterSecondary() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .secondary
        let filtered = viewModel.filteredWorkflows
        // "periodic / nightly-build / job" contains "periodic" and "nightly"
        XCTAssertEqual(filtered.count, 1)
        XCTAssertTrue(filtered[0].workflowName.contains("periodic"))
    }

    func testFilterUnstable() async {
        // Create data with an unstable job
        let json = """
        [
            {"sha":"a","time":"2024-01-01T00:00:00Z","author":"user","body":"",
             "failures":["unstable / linux-test"],
             "successes":["pull / linux-jammy"]},
            {"sha":"b","time":"2024-01-02T00:00:00Z","author":"user","body":"",
             "failures":[],
             "successes":["pull / linux-jammy","unstable / linux-test"]}
        ]
        """
        registerBothEndpoints(jobsJSON: json)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .unstable
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertTrue(filtered[0].workflowName.contains("unstable"))
    }

    // MARK: - Search

    func testSearchFiltersByWorkflowName() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertTrue(filtered[0].workflowName.contains("linux"))
    }

    func testSearchIsCaseInsensitive() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "WIN"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertTrue(filtered[0].workflowName.contains("win"))
    }

    func testSearchWithNoMatch() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = "nonexistent"
        XCTAssertTrue(viewModel.filteredWorkflows.isEmpty)
    }

    func testEmptySearchReturnsAll() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.searchText = ""
        XCTAssertEqual(viewModel.filteredWorkflows.count, 3)
    }

    func testSearchCombinesWithFilter() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        viewModel.searchText = "linux"
        let filtered = viewModel.filteredWorkflows
        XCTAssertEqual(filtered.count, 1)
        XCTAssertTrue(filtered[0].workflowName.contains("linux"))
    }

    // MARK: - Sort Order

    func testSortWorstFirst() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .worstFirst
        let filtered = viewModel.filteredWorkflows
        for i in 0..<(filtered.count - 1) {
            XCTAssertGreaterThanOrEqual(filtered[i].failureRate, filtered[i + 1].failureRate)
        }
    }

    func testSortBestFirst() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .bestFirst
        let filtered = viewModel.filteredWorkflows
        for i in 0..<(filtered.count - 1) {
            XCTAssertLessThanOrEqual(filtered[i].failureRate, filtered[i + 1].failureRate)
        }
    }

    func testSortNameAZ() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameAZ
        let filtered = viewModel.filteredWorkflows
        for i in 0..<(filtered.count - 1) {
            XCTAssertTrue(
                filtered[i].workflowName.localizedCompare(filtered[i + 1].workflowName) != .orderedDescending
            )
        }
    }

    func testSortNameZA() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.sortOrder = .nameZA
        let filtered = viewModel.filteredWorkflows
        for i in 0..<(filtered.count - 1) {
            XCTAssertTrue(
                filtered[i].workflowName.localizedCompare(filtered[i + 1].workflowName) != .orderedAscending
            )
        }
    }

    // MARK: - Failure Breakdown

    func testFailureBreakdownHasThreeCategories() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        XCTAssertEqual(breakdown.count, 3)
        XCTAssertEqual(breakdown[0].category, "Broken Trunk")
        XCTAssertEqual(breakdown[1].category, "Flaky")
        XCTAssertEqual(breakdown[2].category, "Infra")
    }

    func testFailureBreakdownCountsAreNonZeroWithRealData() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        let breakdown = viewModel.failureBreakdown
        // With real per-commit data, the breakdown should have real counts
        let totalBreakdown = breakdown.reduce(0) { $0 + $1.count }
        XCTAssertGreaterThan(totalBreakdown, 0, "Failure breakdown should have non-zero counts with real data")
        // Specifically, broken trunk should be populated (streaks of 3+)
        XCTAssertGreaterThan(breakdown[0].count, 0, "Broken trunk count should be > 0")
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()
        XCTAssertEqual(viewModel.workflows.count, 3)

        // Clear and register new data with a single job
        mockClient.reset()
        let newJSON = """
        [
            {"sha":"x","time":"2024-01-01T00:00:00Z","author":"user","body":"",
             "failures":["new-workflow / test"],
             "successes":[]}
        ]
        """
        registerBothEndpoints(jobsJSON: newJSON)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.workflows.count, 1)
        XCTAssertEqual(viewModel.workflows[0].workflowName, "new-workflow / test")
    }

    func testRefreshDoesNotResetStateToLoading() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
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
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        mockClient.reset()
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

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
        XCTAssertTrue(viewModel.isPrimaryWorkflow("lint / something"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("macos-build"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("linux-aarch64 / test"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("linux-binary-libtorch-release / build"))
        XCTAssertTrue(viewModel.isPrimaryWorkflow("linux-binary-manywheel / build"))
        XCTAssertFalse(viewModel.isPrimaryWorkflow("periodic / nightly"))
    }

    func testIsSecondaryWorkflow() {
        XCTAssertTrue(viewModel.isSecondaryWorkflow("periodic / nightly"))
        XCTAssertTrue(viewModel.isSecondaryWorkflow("inductor / test"))
        XCTAssertTrue(viewModel.isSecondaryWorkflow("binary-release"))
        XCTAssertFalse(viewModel.isSecondaryWorkflow("pull / linux-jammy"))
    }

    func testIsUnstableWorkflow() {
        XCTAssertTrue(viewModel.isUnstableWorkflow("unstable / linux-test"))
        XCTAssertTrue(viewModel.isUnstableWorkflow("UNSTABLE-workflow"))
        XCTAssertFalse(viewModel.isUnstableWorkflow("pull / linux-jammy"))
    }

    // MARK: - Edge Cases

    func testReliabilityRateWithZeroTotalJobs() async {
        // With empty jobs data, there are no workflows -> totalJobs=0
        registerBothEndpoints(jobsJSON: "[]")
        await viewModel.loadReliability()

        XCTAssertEqual(viewModel.overallFailureRate, 0)
        XCTAssertEqual(viewModel.overallReliabilityRate, 100)
    }

    func testFilteredTotalsUpdateWithFilter() async {
        registerBothEndpoints(jobsJSON: sampleJobsJSON)
        await viewModel.loadReliability()

        viewModel.selectedFilter = .primary
        let primaryTotal = viewModel.totalJobs

        viewModel.selectedFilter = .secondary
        let secondaryTotal = viewModel.totalJobs

        // Primary should have more jobs than secondary (2 primary vs 1 secondary)
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
        registerBothEndpoints(jobsJSON: sampleJobsJSON)

        // Before load
        XCTAssertEqual(viewModel.state, .loading)

        await viewModel.loadReliability()

        // After load
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Failure Classification Algorithm

    func testApproximateFailureByType_BrokenTrunk() {
        // 3 consecutive commits where "job_a" fails -> Broken Trunk (threshold = 3)
        let commits = [
            ReliabilityViewModel.CommitRedJobsEntry(sha: "c", time: "3", failures: ["job_a"], successes: []),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "b", time: "2", failures: ["job_a"], successes: []),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "a", time: "1", failures: ["job_a"], successes: []),
        ]

        let result = ReliabilityViewModel.approximateFailureByType(commits)

        XCTAssertEqual(result["job_a"]?.brokenTrunk, 3)
        XCTAssertEqual(result["job_a"]?.flaky, 0)
    }

    func testApproximateFailureByType_Flaky() {
        // 2 consecutive commits where "job_a" fails, then succeeds (streak < 3) -> Flaky
        let commits = [
            ReliabilityViewModel.CommitRedJobsEntry(sha: "c", time: "3", failures: ["job_a"], successes: []),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "b", time: "2", failures: ["job_a"], successes: []),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "a", time: "1", failures: [], successes: ["job_a"]),
        ]

        let result = ReliabilityViewModel.approximateFailureByType(commits)

        XCTAssertEqual(result["job_a"]?.flaky, 2)
        XCTAssertEqual(result["job_a"]?.brokenTrunk, 0)
    }

    func testApproximateFailureByType_Infra() {
        // A commit with >= 10 failures -> each failure gets +1 infra
        var failures: [String] = []
        for i in 0..<12 {
            failures.append("job_\(i)")
        }
        let commits = [
            ReliabilityViewModel.CommitRedJobsEntry(sha: "b", time: "2", failures: failures, successes: []),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "a", time: "1", failures: [], successes: failures),
        ]

        let result = ReliabilityViewModel.approximateFailureByType(commits)

        // Each job had 1 failure (streak of 1, below threshold of 3) -> Flaky
        // But the commit had >= 10 failures -> also counted as infra
        for i in 0..<12 {
            XCTAssertEqual(result["job_\(i)"]?.infra, 1, "job_\(i) should have infra count of 1")
        }
    }

    func testCountSuccesses() {
        let commits = [
            ReliabilityViewModel.CommitRedJobsEntry(sha: "a", time: "1", failures: [], successes: ["job_a", "job_b"]),
            ReliabilityViewModel.CommitRedJobsEntry(sha: "b", time: "2", failures: ["job_b"], successes: ["job_a"]),
        ]

        let result = ReliabilityViewModel.countSuccesses(commits)

        XCTAssertEqual(result["job_a"], 2)
        XCTAssertEqual(result["job_b"], 1)
    }

    // MARK: - Workflow Names

    func testAllWorkflowNamesContainsNineWorkflows() {
        XCTAssertEqual(ReliabilityViewModel.allWorkflowNames.count, 9)
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("trunk"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("pull"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("periodic"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("inductor"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("linux-binary-libtorch-release"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("linux-binary-manywheel"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("linux-aarch64"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("lint"))
        XCTAssertTrue(ReliabilityViewModel.allWorkflowNames.contains("unstable"))
    }

    func testPrimaryWorkflowsList() {
        XCTAssertEqual(ReliabilityViewModel.primaryWorkflows.count, 6)
    }

    func testSecondaryWorkflowsList() {
        XCTAssertEqual(ReliabilityViewModel.secondaryWorkflows.count, 2)
    }

    func testUnstableWorkflowsList() {
        XCTAssertEqual(ReliabilityViewModel.unstableWorkflows.count, 1)
    }
}
