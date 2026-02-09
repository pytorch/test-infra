import XCTest
@testable import TorchCI

@MainActor
final class TestFileReportViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TestFileReportViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TestFileReportViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Build a minimal valid FileReportResponse JSON string.
    private func makeFileReportJSON(
        results: [(file: String, workflowName: String, jobName: String, time: Double, count: Int, success: Int, skipped: Int, sha: String, label: String)] = [],
        costInfo: [(label: String, pricePerHour: Double)] = [],
        shas: [(sha: String, pushDate: Int)] = [],
        testOwnerLabels: [(file: String, ownerLabels: [String])] = []
    ) -> String {
        let resultsJSON = results.map { r in
            """
            {
                "file": "\(r.file)",
                "workflow_name": "\(r.workflowName)",
                "job_name": "\(r.jobName)",
                "time": \(r.time),
                "count": \(r.count),
                "success": \(r.success),
                "skipped": \(r.skipped),
                "sha": "\(r.sha)",
                "label": "\(r.label)"
            }
            """
        }.joined(separator: ",")

        let costJSON = costInfo.map { c in
            """
            {"label": "\(c.label)", "price_per_hour": \(c.pricePerHour)}
            """
        }.joined(separator: ",")

        let shasJSON = shas.map { s in
            """
            {"sha": "\(s.sha)", "push_date": \(s.pushDate)}
            """
        }.joined(separator: ",")

        let ownerJSON = testOwnerLabels.map { o in
            let labels = o.ownerLabels.map { "\"\($0)\"" }.joined(separator: ",")
            return """
            {"file": "\(o.file)", "owner_labels": [\(labels)]}
            """
        }.joined(separator: ",")

        return """
        {
            "results": [\(resultsJSON)],
            "costInfo": [\(costJSON)],
            "shas": [\(shasJSON)],
            "testOwnerLabels": [\(ownerJSON)]
        }
        """
    }

    private func registerFileReport(
        results: [(file: String, workflowName: String, jobName: String, time: Double, count: Int, success: Int, skipped: Int, sha: String, label: String)] = [],
        costInfo: [(label: String, pricePerHour: Double)] = [],
        shas: [(sha: String, pushDate: Int)] = [],
        testOwnerLabels: [(file: String, ownerLabels: [String])] = []
    ) {
        let json = makeFileReportJSON(
            results: results,
            costInfo: costInfo,
            shas: shas,
            testOwnerLabels: testOwnerLabels
        )
        mockClient.setResponse(json, for: "/api/flaky-tests/fileReport")
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.searchQuery, "")
        XCTAssertEqual(viewModel.sortOption, .failureCount)
        XCTAssertTrue(viewModel.expandedFiles.isEmpty)
        XCTAssertEqual(viewModel.selectedDateRange, 7)
        XCTAssertTrue(viewModel.fileStats.isEmpty)
        XCTAssertTrue(viewModel.rawResults.isEmpty)
        XCTAssertTrue(viewModel.commits.isEmpty)
        XCTAssertTrue(viewModel.filteredAndSortedFiles.isEmpty)
    }

    // MARK: - Load Data

    func testLoadDataSuccess() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "trunk", jobName: "linux-focal-py3.8-gcc7", time: 120.0, count: 100, success: 95, skipped: 3, sha: "abc123", label: "linux.2xlarge"),
            ],
            costInfo: [(label: "linux.2xlarge", pricePerHour: 0.5)],
            shas: [(sha: "abc123", pushDate: 1700000000)],
            testOwnerLabels: [(file: "test_ops.py", ownerLabels: ["module: core"])]
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.fileStats.count, 1)
        XCTAssertEqual(viewModel.rawResults.count, 1)
        XCTAssertEqual(viewModel.commits.count, 1)

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.file, "test_ops")
        XCTAssertEqual(stats.totalTests, 100)
        XCTAssertEqual(stats.successCount, 95)
        XCTAssertEqual(stats.skippedCount, 3)
        XCTAssertEqual(stats.failureCount, 2) // 100 - 95 - 3
    }

    func testLoadDataError() async {
        mockClient.setError(APIError.serverError(500), for: "/api/flaky-tests/fileReport")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataSetsLoadingState() async {
        // Register a valid response so load eventually succeeds
        registerFileReport()

        // Before load, state should be idle
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        // After load completes, state should be loaded (not loading)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerFileReport(
            results: [
                (file: "test_a", workflowName: "trunk", jobName: "job1", time: 10.0, count: 5, success: 5, skipped: 0, sha: "sha1", label: "linux"),
            ]
        )

        await viewModel.loadData()
        XCTAssertEqual(viewModel.fileStats.count, 1)

        // Update the mock to return different data
        registerFileReport(
            results: [
                (file: "test_a", workflowName: "trunk", jobName: "job1", time: 10.0, count: 5, success: 5, skipped: 0, sha: "sha1", label: "linux"),
                (file: "test_b", workflowName: "trunk", jobName: "job2", time: 20.0, count: 10, success: 8, skipped: 1, sha: "sha2", label: "linux"),
            ]
        )

        await viewModel.refresh()
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.fileStats.count, 2)
    }

    // MARK: - Filtering

    func testSearchFiltersByFileName() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "trunk", jobName: "j1", time: 10, count: 10, success: 10, skipped: 0, sha: "a", label: "l"),
                (file: "test_nn", workflowName: "trunk", jobName: "j1", time: 20, count: 5, success: 5, skipped: 0, sha: "a", label: "l"),
                (file: "test_autograd", workflowName: "trunk", jobName: "j1", time: 15, count: 8, success: 8, skipped: 0, sha: "a", label: "l"),
            ]
        )

        await viewModel.loadData()
        XCTAssertEqual(viewModel.filteredAndSortedFiles.count, 3)

        viewModel.searchQuery = "ops"
        let filtered = viewModel.filteredAndSortedFiles
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.file, "test_ops")
    }

    func testSearchFiltersByOwnerLabel() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "trunk", jobName: "j1", time: 10, count: 10, success: 10, skipped: 0, sha: "a", label: "l"),
                (file: "test_nn", workflowName: "trunk", jobName: "j1", time: 20, count: 5, success: 5, skipped: 0, sha: "a", label: "l"),
            ],
            testOwnerLabels: [
                (file: "test_ops.py", ownerLabels: ["module: core"]),
                (file: "test_nn.py", ownerLabels: ["module: nn"]),
            ]
        )

        await viewModel.loadData()
        viewModel.searchQuery = "nn"
        let filtered = viewModel.filteredAndSortedFiles
        // "nn" matches "test_nn" by file name (and also its "module: nn" label),
        // but both matches are on the same file so only 1 result is returned.
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.file, "test_nn")
    }

    func testSearchIsCaseInsensitive() async {
        registerFileReport(
            results: [
                (file: "test_OPS", workflowName: "trunk", jobName: "j1", time: 10, count: 10, success: 10, skipped: 0, sha: "a", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.searchQuery = "ops"
        XCTAssertEqual(viewModel.filteredAndSortedFiles.count, 1)

        viewModel.searchQuery = "OPS"
        XCTAssertEqual(viewModel.filteredAndSortedFiles.count, 1)
    }

    func testEmptySearchShowsAllFiles() async {
        registerFileReport(
            results: [
                (file: "test_a", workflowName: "w", jobName: "j", time: 1, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
                (file: "test_b", workflowName: "w", jobName: "j", time: 2, count: 2, success: 2, skipped: 0, sha: "s", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.searchQuery = ""
        XCTAssertEqual(viewModel.filteredAndSortedFiles.count, 2)
    }

    // MARK: - Sorting

    func testSortByFailureCount() async {
        registerFileReport(
            results: [
                (file: "test_a", workflowName: "w", jobName: "j", time: 10, count: 10, success: 10, skipped: 0, sha: "s", label: "l"),
                (file: "test_b", workflowName: "w", jobName: "j", time: 20, count: 20, success: 15, skipped: 0, sha: "s", label: "l"),
                (file: "test_c", workflowName: "w", jobName: "j", time: 30, count: 30, success: 20, skipped: 0, sha: "s", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.sortOption = .failureCount

        let sorted = viewModel.filteredAndSortedFiles
        XCTAssertEqual(sorted[0].file, "test_c") // 10 failures
        XCTAssertEqual(sorted[1].file, "test_b") // 5 failures
        XCTAssertEqual(sorted[2].file, "test_a") // 0 failures
    }

    func testSortByTotalTests() async {
        registerFileReport(
            results: [
                (file: "test_small", workflowName: "w", jobName: "j", time: 10, count: 5, success: 5, skipped: 0, sha: "s", label: "l"),
                (file: "test_large", workflowName: "w", jobName: "j", time: 20, count: 100, success: 100, skipped: 0, sha: "s", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.sortOption = .totalTests

        let sorted = viewModel.filteredAndSortedFiles
        XCTAssertEqual(sorted[0].file, "test_large")
        XCTAssertEqual(sorted[1].file, "test_small")
    }

    func testSortByDuration() async {
        registerFileReport(
            results: [
                (file: "test_fast", workflowName: "w", jobName: "j", time: 5.0, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
                (file: "test_slow", workflowName: "w", jobName: "j", time: 3600.0, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.sortOption = .duration

        let sorted = viewModel.filteredAndSortedFiles
        XCTAssertEqual(sorted[0].file, "test_slow")
        XCTAssertEqual(sorted[1].file, "test_fast")
    }

    func testSortByCost() async {
        registerFileReport(
            results: [
                (file: "test_cheap", workflowName: "w", jobName: "j", time: 10.0, count: 1, success: 1, skipped: 0, sha: "s", label: "cheap_runner"),
                (file: "test_expensive", workflowName: "w", jobName: "j", time: 100.0, count: 1, success: 1, skipped: 0, sha: "s", label: "expensive_runner"),
            ],
            costInfo: [
                (label: "cheap_runner", pricePerHour: 0.1),
                (label: "expensive_runner", pricePerHour: 10.0),
            ]
        )

        await viewModel.loadData()
        viewModel.sortOption = .cost

        let sorted = viewModel.filteredAndSortedFiles
        XCTAssertEqual(sorted[0].file, "test_expensive")
        XCTAssertEqual(sorted[1].file, "test_cheap")
    }

    func testSortByFileName() async {
        registerFileReport(
            results: [
                (file: "test_z", workflowName: "w", jobName: "j", time: 1, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
                (file: "test_a", workflowName: "w", jobName: "j", time: 1, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
                (file: "test_m", workflowName: "w", jobName: "j", time: 1, count: 1, success: 1, skipped: 0, sha: "s", label: "l"),
            ]
        )

        await viewModel.loadData()
        viewModel.sortOption = .fileName

        let sorted = viewModel.filteredAndSortedFiles
        XCTAssertEqual(sorted[0].file, "test_a")
        XCTAssertEqual(sorted[1].file, "test_m")
        XCTAssertEqual(sorted[2].file, "test_z")
    }

    // MARK: - Toggle Expanded

    func testToggleExpanded() {
        XCTAssertTrue(viewModel.expandedFiles.isEmpty)

        viewModel.toggleExpanded("test_ops")
        XCTAssertTrue(viewModel.expandedFiles.contains("test_ops"))

        viewModel.toggleExpanded("test_ops")
        XCTAssertFalse(viewModel.expandedFiles.contains("test_ops"))
    }

    func testToggleExpandedMultipleFiles() {
        viewModel.toggleExpanded("file_a")
        viewModel.toggleExpanded("file_b")
        XCTAssertEqual(viewModel.expandedFiles.count, 2)
        XCTAssertTrue(viewModel.expandedFiles.contains("file_a"))
        XCTAssertTrue(viewModel.expandedFiles.contains("file_b"))

        viewModel.toggleExpanded("file_a")
        XCTAssertEqual(viewModel.expandedFiles.count, 1)
        XCTAssertFalse(viewModel.expandedFiles.contains("file_a"))
        XCTAssertTrue(viewModel.expandedFiles.contains("file_b"))
    }

    // MARK: - Results For File

    func testResultsForFile() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "trunk", jobName: "j1", time: 10, count: 5, success: 5, skipped: 0, sha: "a", label: "l"),
                (file: "test_ops", workflowName: "trunk", jobName: "j2", time: 20, count: 10, success: 8, skipped: 1, sha: "a", label: "l"),
                (file: "test_nn", workflowName: "trunk", jobName: "j1", time: 15, count: 3, success: 3, skipped: 0, sha: "a", label: "l"),
            ]
        )

        await viewModel.loadData()

        let opsResults = viewModel.resultsForFile("test_ops")
        XCTAssertEqual(opsResults.count, 2)
        XCTAssertTrue(opsResults.allSatisfy { $0.file == "test_ops" })

        let nnResults = viewModel.resultsForFile("test_nn")
        XCTAssertEqual(nnResults.count, 1)

        let noResults = viewModel.resultsForFile("nonexistent")
        XCTAssertTrue(noResults.isEmpty)
    }

    // MARK: - Cost Computation

    func testCostComputation() async {
        // time=3600s at $1/hr = $1.00
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w", jobName: "j", time: 3600.0, count: 1, success: 1, skipped: 0, sha: "s", label: "gpu_runner"),
            ],
            costInfo: [(label: "gpu_runner", pricePerHour: 1.0)]
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.estimatedCost, 1.0, accuracy: 0.001)
    }

    func testCostComputationWithUnknownLabel() async {
        // When cost info doesn't include the label, cost should be 0
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w", jobName: "j", time: 3600.0, count: 1, success: 1, skipped: 0, sha: "s", label: "unknown_runner"),
            ],
            costInfo: [] // no cost info
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.estimatedCost, 0.0, accuracy: 0.001)
    }

    func testCostAcrossMultipleJobsForSameFile() async {
        // Two jobs: 1800s at $2/hr = $1.00 each, total = $2.00
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w", jobName: "j1", time: 1800.0, count: 5, success: 5, skipped: 0, sha: "s", label: "runner"),
                (file: "test_ops", workflowName: "w", jobName: "j2", time: 1800.0, count: 5, success: 5, skipped: 0, sha: "s", label: "runner"),
            ],
            costInfo: [(label: "runner", pricePerHour: 2.0)]
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.estimatedCost, 2.0, accuracy: 0.001)
    }

    // MARK: - File Stats Aggregation

    func testFileStatsAggregation() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w1", jobName: "j1", time: 100.0, count: 50, success: 45, skipped: 2, sha: "a", label: "l"),
                (file: "test_ops", workflowName: "w2", jobName: "j2", time: 200.0, count: 30, success: 25, skipped: 3, sha: "b", label: "l"),
            ]
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.file, "test_ops")
        XCTAssertEqual(stats.totalTests, 80) // 50 + 30
        XCTAssertEqual(stats.successCount, 70) // 45 + 25
        XCTAssertEqual(stats.skippedCount, 5) // 2 + 3
        XCTAssertEqual(stats.failureCount, 5) // 80 - 70 - 5
        XCTAssertEqual(stats.totalDuration, 300.0, accuracy: 0.001) // 100 + 200
    }

    func testOwnerLabelMapping() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w", jobName: "j", time: 10, count: 1, success: 1, skipped: 0, sha: "a", label: "l"),
            ],
            testOwnerLabels: [
                (file: "test_ops.py", ownerLabels: ["module: core", "oncall: pt2"]),
            ]
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.ownerLabels, ["module: core", "oncall: pt2"])
    }

    func testOwnerLabelDefaultsToUnknown() async {
        registerFileReport(
            results: [
                (file: "test_ops", workflowName: "w", jobName: "j", time: 10, count: 1, success: 1, skipped: 0, sha: "a", label: "l"),
            ],
            testOwnerLabels: [] // no owner labels
        )

        await viewModel.loadData()

        let stats = viewModel.fileStats.first!
        XCTAssertEqual(stats.ownerLabels, ["unknown"])
    }

    // MARK: - Commits Sorting

    func testCommitsSortedByPushDate() async {
        registerFileReport(
            results: [
                (file: "test_a", workflowName: "w", jobName: "j", time: 1, count: 1, success: 1, skipped: 0, sha: "oldest", label: "l"),
            ],
            shas: [
                (sha: "newest", pushDate: 1700003000),
                (sha: "oldest", pushDate: 1700001000),
                (sha: "middle", pushDate: 1700002000),
            ]
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.commits.count, 3)
        XCTAssertEqual(viewModel.commits[0].sha, "oldest")
        XCTAssertEqual(viewModel.commits[1].sha, "middle")
        XCTAssertEqual(viewModel.commits[2].sha, "newest")
    }

    // MARK: - Date Range

    func testDateRangeChangeTriggersReload() async {
        registerFileReport()

        await viewModel.loadData()
        let callCountAfterFirst = mockClient.callCount

        viewModel.selectedDateRange = 14
        viewModel.onDateRangeChanged()

        // Wait for unstructured Task in onDateRangeChanged
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertGreaterThan(mockClient.callCount, callCountAfterFirst)
    }

    // MARK: - API Call Correctness

    func testCorrectEndpointCalled() async {
        registerFileReport()

        await viewModel.loadData()

        XCTAssertEqual(mockClient.callCount, 1)
        let call = mockClient.recordedCalls.first!
        XCTAssertEqual(call.path, "/api/flaky-tests/fileReport")
        XCTAssertEqual(call.method, "GET")

        // Should have startDate and endDate query items
        let queryItemNames = call.queryItems?.map(\.name) ?? []
        XCTAssertTrue(queryItemNames.contains("startDate"))
        XCTAssertTrue(queryItemNames.contains("endDate"))
    }

    func testDateRangeAffectsQueryParams() async {
        registerFileReport()

        viewModel.selectedDateRange = 3
        await viewModel.loadData()

        let call = mockClient.recordedCalls.first!
        let startDateStr = call.queryItems?.first(where: { $0.name == "startDate" })?.value ?? ""
        let endDateStr = call.queryItems?.first(where: { $0.name == "endDate" })?.value ?? ""

        let startDate = Int(startDateStr)!
        let endDate = Int(endDateStr)!

        // The difference should be approximately 3 days (259200 seconds)
        let diff = endDate - startDate
        XCTAssertEqual(diff, 3 * 24 * 60 * 60)
    }

    // MARK: - Empty Response

    func testEmptyResponseShowsLoadedState() async {
        registerFileReport()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.fileStats.isEmpty)
        XCTAssertTrue(viewModel.rawResults.isEmpty)
        XCTAssertTrue(viewModel.commits.isEmpty)
    }

    // MARK: - FileStats Model

    func testFileStatsSuccessRate() {
        let stats = FileStats(
            file: "test",
            totalTests: 100,
            successCount: 90,
            failureCount: 5,
            skippedCount: 5,
            totalDuration: 60,
            estimatedCost: 0.5,
            jobNames: ["j1"],
            ownerLabels: []
        )
        XCTAssertEqual(stats.successRate, 0.9, accuracy: 0.001)
    }

    func testFileStatsSuccessRateWithZeroTests() {
        let stats = FileStats(
            file: "test",
            totalTests: 0,
            successCount: 0,
            failureCount: 0,
            skippedCount: 0,
            totalDuration: 0,
            estimatedCost: 0,
            jobNames: [],
            ownerLabels: []
        )
        XCTAssertEqual(stats.successRate, 0.0)
    }

    func testFileStatsStatusColor() {
        let failStats = FileStats(file: "f", totalTests: 10, successCount: 5, failureCount: 3, skippedCount: 2, totalDuration: 0, estimatedCost: 0, jobNames: [], ownerLabels: [])
        XCTAssertEqual(failStats.statusColor, "red")

        let skipStats = FileStats(file: "f", totalTests: 10, successCount: 8, failureCount: 0, skippedCount: 2, totalDuration: 0, estimatedCost: 0, jobNames: [], ownerLabels: [])
        XCTAssertEqual(skipStats.statusColor, "orange")

        let passStats = FileStats(file: "f", totalTests: 10, successCount: 10, failureCount: 0, skippedCount: 0, totalDuration: 0, estimatedCost: 0, jobNames: [], ownerLabels: [])
        XCTAssertEqual(passStats.statusColor, "green")
    }

    // MARK: - FileReportResult Model

    func testFileReportResultComputedProperties() {
        let result = try! JSONDecoder().decode(FileReportResult.self, from: """
        {
            "file": "test_ops",
            "workflow_name": "trunk",
            "job_name": "linux-focal-py3.8-gcc7",
            "time": 120.5,
            "count": 100,
            "success": 90,
            "skipped": 5,
            "sha": "abc123",
            "label": "linux.2xlarge"
        }
        """.data(using: .utf8)!)

        XCTAssertEqual(result.failures, 5) // 100 - 90 - 5
        XCTAssertEqual(result.shortJobName, "trunk / linux-focal-py3.8-gcc7")
        XCTAssertEqual(result.successRate, 0.9, accuracy: 0.001)
        XCTAssertEqual(result.id, "test_ops-linux-focal-py3.8-gcc7-abc123")
    }

    func testFileReportResultSuccessRateWithZeroCount() {
        let result = try! JSONDecoder().decode(FileReportResult.self, from: """
        {
            "file": "empty",
            "workflow_name": "w",
            "job_name": "j",
            "time": 0,
            "count": 0,
            "success": 0,
            "skipped": 0,
            "sha": "s",
            "label": "l"
        }
        """.data(using: .utf8)!)

        XCTAssertEqual(result.successRate, 0.0)
        XCTAssertEqual(result.failures, 0)
    }

    // MARK: - FileReportCommitSha Model

    func testFileReportCommitSha() {
        let commit = try! JSONDecoder().decode(FileReportCommitSha.self, from: """
        {"sha": "abc123def", "push_date": 1700000000}
        """.data(using: .utf8)!)

        XCTAssertEqual(commit.sha, "abc123def")
        XCTAssertEqual(commit.pushDate, 1700000000)
        XCTAssertEqual(commit.id, "abc123def")
        XCTAssertEqual(commit.date, Date(timeIntervalSince1970: 1700000000))
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(TestFileReportViewModel.ViewState.idle, .idle)
        XCTAssertEqual(TestFileReportViewModel.ViewState.loading, .loading)
        XCTAssertEqual(TestFileReportViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(TestFileReportViewModel.ViewState.error("msg"), .error("msg"))
        XCTAssertNotEqual(TestFileReportViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(TestFileReportViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(TestFileReportViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - SortOption

    func testSortOptionAllCases() {
        let cases = TestFileReportViewModel.SortOption.allCases
        XCTAssertEqual(cases.count, 5)
        XCTAssertTrue(cases.contains(.failureCount))
        XCTAssertTrue(cases.contains(.totalTests))
        XCTAssertTrue(cases.contains(.duration))
        XCTAssertTrue(cases.contains(.cost))
        XCTAssertTrue(cases.contains(.fileName))
    }

    func testSortOptionSystemImages() {
        XCTAssertEqual(TestFileReportViewModel.SortOption.failureCount.systemImage, "exclamationmark.triangle")
        XCTAssertEqual(TestFileReportViewModel.SortOption.totalTests.systemImage, "number")
        XCTAssertEqual(TestFileReportViewModel.SortOption.duration.systemImage, "clock")
        XCTAssertEqual(TestFileReportViewModel.SortOption.cost.systemImage, "dollarsign.circle")
        XCTAssertEqual(TestFileReportViewModel.SortOption.fileName.systemImage, "abc")
    }

    func testSortOptionRawValues() {
        XCTAssertEqual(TestFileReportViewModel.SortOption.failureCount.rawValue, "Failures")
        XCTAssertEqual(TestFileReportViewModel.SortOption.totalTests.rawValue, "Total Tests")
        XCTAssertEqual(TestFileReportViewModel.SortOption.duration.rawValue, "Duration")
        XCTAssertEqual(TestFileReportViewModel.SortOption.cost.rawValue, "Cost")
        XCTAssertEqual(TestFileReportViewModel.SortOption.fileName.rawValue, "File Name")
    }
}
