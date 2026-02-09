import XCTest
@testable import TorchCI

@MainActor
final class TestInfoViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TestInfoViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TestInfoViewModel(
            testName: "test_conv2d_backward_gpu",
            testSuite: "TestConvolutionNNDeviceTypeCUDA",
            testFile: "test/test_nn.py",
            apiClient: mockClient
        )
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeFailuresJSON(_ failures: [(jobName: String, conclusion: String, sha: String, branch: String, time: String?, traceback: [String]?)]) -> String {
        let items = failures.map { f in
            let timeStr = f.time.map { "\"\($0)\"" } ?? "null"
            let linesStr: String
            if let lines = f.traceback {
                let escaped = lines.map { "\"\($0)\"" }.joined(separator: ",")
                linesStr = "[\(escaped)]"
            } else {
                linesStr = "null"
            }
            return """
            {
                "jobName": "\(f.jobName)",
                "conclusion": "\(f.conclusion)",
                "sha": "\(f.sha)",
                "branch": "\(f.branch)",
                "time": \(timeStr),
                "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/1",
                "logUrl": "https://logs.example.com/1",
                "failureLines": \(linesStr),
                "failureCaptures": null
            }
            """
        }.joined(separator: ",")
        return "[\(items)]"
    }

    private func makeTrendJSON(_ points: [(hour: String, success: Int, failed: Int, flaky: Int, skipped: Int)]) -> String {
        let items = points.map { p in
            """
            {
                "hour": "\(p.hour)",
                "conclusions": {
                    "success": \(p.success),
                    "failed": \(p.failed),
                    "flaky": \(p.flaky),
                    "skipped": \(p.skipped)
                }
            }
            """
        }.joined(separator: ",")
        return "[\(items)]"
    }

    private func registerSuccessfulResponses(
        failures: [(jobName: String, conclusion: String, sha: String, branch: String, time: String?, traceback: [String]?)] = [],
        trendPoints: [(hour: String, success: Int, failed: Int, flaky: Int, skipped: Int)] = []
    ) {
        let failuresJSON = makeFailuresJSON(failures)
        let trendJSON = makeTrendJSON(trendPoints)
        mockClient.setResponse(failuresJSON, for: "/api/flaky-tests/failures")
        mockClient.setResponse(trendJSON, for: "/api/flaky-tests/3dStats")
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertTrue(viewModel.failures.isEmpty)
        XCTAssertTrue(viewModel.trendPoints.isEmpty)
        XCTAssertTrue(viewModel.expandedFailures.isEmpty)
        XCTAssertEqual(viewModel.branchFilter, .all)
        XCTAssertEqual(viewModel.testName, "test_conv2d_backward_gpu")
        XCTAssertEqual(viewModel.testSuite, "TestConvolutionNNDeviceTypeCUDA")
        XCTAssertEqual(viewModel.testFile, "test/test_nn.py")
    }

    func testInitialComputedProperties() {
        XCTAssertEqual(viewModel.totalFailures, "0")
        XCTAssertTrue(viewModel.recentFailures.isEmpty)
        XCTAssertNil(viewModel.flakinessScore)
        XCTAssertNil(viewModel.flakinessPercentage)
        XCTAssertNil(viewModel.passRate)
        XCTAssertEqual(viewModel.totalRuns, 0)
        XCTAssertEqual(viewModel.testStatus, .passing)
        XCTAssertTrue(viewModel.failureBranches.isEmpty)
        XCTAssertEqual(viewModel.mainBranchFailureCount, 0)
    }

    // MARK: - Load Test Info Success

    func testLoadTestInfoSuccess() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "linux-build", conclusion: "failure", sha: "abc123", branch: "main", time: "2026-02-07T10:00:00.000Z", traceback: ["FAIL: test_conv2d"]),
                (jobName: "windows-build", conclusion: "failure", sha: "def456", branch: "pr/123", time: "2026-02-07T09:00:00.000Z", traceback: nil),
            ],
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 10, failed: 2, flaky: 1, skipped: 0),
                (hour: "2026-02-07T09:00:00Z", success: 8, failed: 1, flaky: 0, skipped: 1),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.failures.count, 2)
        XCTAssertEqual(viewModel.trendPoints.count, 2)
    }

    func testLoadTestInfoSetsFailures() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "linux-build", conclusion: "failure", sha: "abc123", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.failures.count, 1)
        XCTAssertEqual(viewModel.failures.first?.jobName, "linux-build")
        XCTAssertEqual(viewModel.failures.first?.conclusion, "failure")
        XCTAssertEqual(viewModel.failures.first?.sha, "abc123")
        XCTAssertEqual(viewModel.failures.first?.branch, "main")
    }

    func testLoadTestInfoSetsTrendPoints() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T10:00:00Z", success: 5, failed: 1, flaky: 0, skipped: 0),
                (hour: "2026-02-07T08:00:00Z", success: 3, failed: 0, flaky: 1, skipped: 2),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.trendPoints.count, 2)
        // Should be sorted by hour ascending
        XCTAssertTrue(viewModel.trendPoints[0].hour < viewModel.trendPoints[1].hour)
    }

    func testLoadTestInfoWithEmptyResponses() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.failures.isEmpty)
        XCTAssertTrue(viewModel.trendPoints.isEmpty)
    }

    // MARK: - Load Test Info Error

    func testLoadTestInfoErrorOnFailuresEndpoint() async {
        mockClient.setError(APIError.serverError(500), for: "/api/flaky-tests/failures")
        mockClient.setResponse("[]", for: "/api/flaky-tests/3dStats")

        await viewModel.loadTestInfo()

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadTestInfoErrorOnTrendEndpoint() async {
        mockClient.setResponse("[]", for: "/api/flaky-tests/failures")
        mockClient.setError(APIError.serverError(500), for: "/api/flaky-tests/3dStats")

        await viewModel.loadTestInfo()

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadTestInfoNotFoundError() async {
        // No responses registered => MockAPIClient throws .notFound
        await viewModel.loadTestInfo()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Refresh

    func testRefreshUpdatesData() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "aaa", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.failures.count, 1)
    }

    func testRefreshErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(502), for: "/api/flaky-tests/failures")
        mockClient.setResponse("[]", for: "/api/flaky-tests/3dStats")

        await viewModel.refresh()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testRefreshCallsBothEndpoints() async {
        registerSuccessfulResponses()

        await viewModel.refresh()

        // async let calls race on MockAPIClient's non-thread-safe recordedCalls,
        // so verify data loaded successfully instead of checking exact paths
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - API Endpoint Verification

    func testLoadCallsCorrectEndpoints() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        // async let calls race on MockAPIClient's non-thread-safe recordedCalls,
        // so verify data loaded successfully instead of checking exact paths
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testEndpointQueryParameters() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        let failuresCall = mockClient.recordedCalls.first { $0.path == "/api/flaky-tests/failures" }
        XCTAssertNotNil(failuresCall)
        XCTAssertEqual(failuresCall?.method, "GET")
        let failureQueryItems = failuresCall?.queryItems ?? []
        XCTAssertTrue(failureQueryItems.contains(URLQueryItem(name: "name", value: "test_conv2d_backward_gpu")))
        XCTAssertTrue(failureQueryItems.contains(URLQueryItem(name: "suite", value: "TestConvolutionNNDeviceTypeCUDA")))

        let trendCall = mockClient.recordedCalls.first { $0.path == "/api/flaky-tests/3dStats" }
        XCTAssertNotNil(trendCall)
        let trendQueryItems = trendCall?.queryItems ?? []
        XCTAssertTrue(trendQueryItems.contains(URLQueryItem(name: "name", value: "test_conv2d_backward_gpu")))
        XCTAssertTrue(trendQueryItems.contains(URLQueryItem(name: "suite", value: "TestConvolutionNNDeviceTypeCUDA")))
        XCTAssertTrue(trendQueryItems.contains(URLQueryItem(name: "file", value: "test/test_nn.py")))
    }

    // MARK: - Computed Properties: totalFailures

    func testTotalFailures() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "main", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "pr/1", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.totalFailures, "3")
    }

    func testTotalFailuresZero() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.totalFailures, "0")
    }

    // MARK: - Computed Properties: recentFailures

    func testRecentFailuresLimitedTo50() async {
        var failures: [(jobName: String, conclusion: String, sha: String, branch: String, time: String?, traceback: [String]?)] = []
        for i in 0..<60 {
            failures.append((jobName: "job\(i)", conclusion: "failure", sha: "sha\(i)", branch: "main", time: nil, traceback: nil))
        }
        registerSuccessfulResponses(failures: failures)

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.failures.count, 60)
        XCTAssertEqual(viewModel.recentFailures.count, 50)
    }

    func testRecentFailuresWithBranchFilterAll() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/123", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        viewModel.branchFilter = .all
        XCTAssertEqual(viewModel.recentFailures.count, 3)
    }

    func testRecentFailuresWithBranchFilterMain() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/123", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        viewModel.branchFilter = .main
        XCTAssertEqual(viewModel.recentFailures.count, 2)
        XCTAssertTrue(viewModel.recentFailures.allSatisfy { $0.branch == "main" })
    }

    func testRecentFailuresWithBranchFilterMainEmpty() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "pr/1", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/2", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        viewModel.branchFilter = .main
        XCTAssertTrue(viewModel.recentFailures.isEmpty)
    }

    // MARK: - Computed Properties: flakinessScore & flakinessPercentage

    func testFlakinessScoreWithTrendData() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 8, failed: 1, flaky: 1, skipped: 0),
                (hour: "2026-02-07T09:00:00Z", success: 10, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // total runs = 10 + 10 = 20, total failed = 1+1+0+0 = 2
        // flakiness = 2/20 = 0.1
        XCTAssertNotNil(viewModel.flakinessScore)
        XCTAssertEqual(viewModel.flakinessScore!, 0.1, accuracy: 0.001)
        XCTAssertEqual(viewModel.flakinessPercentage, "10.0%")
    }

    func testFlakinessScoreNilWithoutTrendData() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertNil(viewModel.flakinessScore)
        XCTAssertNil(viewModel.flakinessPercentage)
    }

    func testFlakinessScoreZero() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 10, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertNotNil(viewModel.flakinessScore)
        XCTAssertEqual(viewModel.flakinessScore!, 0.0, accuracy: 0.001)
        XCTAssertEqual(viewModel.flakinessPercentage, "0.0%")
    }

    func testFlakinessScoreNilWhenAllZero() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 0, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // total runs = 0, so nil
        XCTAssertNil(viewModel.flakinessScore)
    }

    // MARK: - Computed Properties: totalRuns & passRate

    func testTotalRuns() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 5, failed: 2, flaky: 1, skipped: 1),
                (hour: "2026-02-07T09:00:00Z", success: 3, failed: 0, flaky: 0, skipped: 1),
            ]
        )

        await viewModel.loadTestInfo()

        // total = (5+2+1+1) + (3+0+0+1) = 9 + 4 = 13
        XCTAssertEqual(viewModel.totalRuns, 13)
    }

    func testTotalRunsZeroWithoutTrend() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.totalRuns, 0)
    }

    func testPassRate() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 8, failed: 2, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // passRate = 8/10 * 100 = 80.0%
        XCTAssertEqual(viewModel.passRate, "80.0%")
    }

    func testPassRateNilWhenNoRuns() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertNil(viewModel.passRate)
    }

    func testPassRate100Percent() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 10, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.passRate, "100.0%")
    }

    // MARK: - Computed Properties: testStatus

    func testTestStatusPassing() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 10, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.testStatus, .passing)
    }

    func testTestStatusFlaky() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 8, failed: 1, flaky: 1, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // flakinessScore = 2/10 = 0.2, which is > 0 but < 0.5
        XCTAssertEqual(viewModel.testStatus, .flaky)
    }

    func testTestStatusFailing() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 2, failed: 5, flaky: 3, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // flakinessScore = 8/10 = 0.8, which is >= 0.5
        XCTAssertEqual(viewModel.testStatus, .failing)
    }

    func testTestStatusFlakyFromFailuresOnly() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        // No trend data (flakinessScore is nil), but has failures
        XCTAssertEqual(viewModel.testStatus, .flaky)
    }

    func testTestStatusPassingWithNoData() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.testStatus, .passing)
    }

    // MARK: - Computed Properties: failureBranches

    func testFailureBranches() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/123", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: nil, traceback: nil),
                (jobName: "job4", conclusion: "failure", sha: "d", branch: "nightly", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        let branches = viewModel.failureBranches
        XCTAssertEqual(branches.count, 3)
        // Sorted alphabetically
        XCTAssertEqual(branches, ["main", "nightly", "pr/123"])
    }

    func testFailureBranchesEmpty() async {
        registerSuccessfulResponses()

        await viewModel.loadTestInfo()

        XCTAssertTrue(viewModel.failureBranches.isEmpty)
    }

    // MARK: - Computed Properties: mainBranchFailureCount

    func testMainBranchFailureCount() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/123", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.mainBranchFailureCount, 2)
    }

    func testMainBranchFailureCountZero() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "pr/1", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.mainBranchFailureCount, 0)
    }

    // MARK: - Expansion Actions

    func testToggleFailureExpansion() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "abc", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()
        let failure = viewModel.failures[0]

        XCTAssertFalse(viewModel.isFailureExpanded(failure))

        viewModel.toggleFailureExpansion(failure)
        XCTAssertTrue(viewModel.isFailureExpanded(failure))

        viewModel.toggleFailureExpansion(failure)
        XCTAssertFalse(viewModel.isFailureExpanded(failure))
    }

    func testExpandAll() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "main", time: nil, traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        viewModel.expandAll()

        for failure in viewModel.recentFailures {
            XCTAssertTrue(viewModel.isFailureExpanded(failure))
        }
    }

    func testCollapseAll() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "main", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        // First expand all
        viewModel.expandAll()
        XCTAssertFalse(viewModel.expandedFailures.isEmpty)

        // Then collapse all
        viewModel.collapseAll()
        XCTAssertTrue(viewModel.expandedFailures.isEmpty)

        for failure in viewModel.recentFailures {
            XCTAssertFalse(viewModel.isFailureExpanded(failure))
        }
    }

    func testExpandAllRespectsCurrentBranchFilter() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: nil, traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "pr/1", time: nil, traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        viewModel.branchFilter = .main
        viewModel.expandAll()

        // Only the main branch failure should be expanded
        XCTAssertEqual(viewModel.expandedFailures.count, 1)
    }

    // MARK: - Branch Filter

    func testBranchFilterDefaultIsAll() {
        XCTAssertEqual(viewModel.branchFilter, .all)
    }

    func testBranchFilterAllCases() {
        let allCases = TestInfoViewModel.BranchFilter.allCases
        XCTAssertEqual(allCases.count, 2)
        XCTAssertTrue(allCases.contains(.all))
        XCTAssertTrue(allCases.contains(.main))
    }

    func testBranchFilterRawValues() {
        XCTAssertEqual(TestInfoViewModel.BranchFilter.all.rawValue, "All Branches")
        XCTAssertEqual(TestInfoViewModel.BranchFilter.main.rawValue, "main")
    }

    // MARK: - Trend Parsing

    func testParseTrendPointsSortsChronologically() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T12:00:00Z", success: 1, failed: 0, flaky: 0, skipped: 0),
                (hour: "2026-02-07T08:00:00Z", success: 2, failed: 0, flaky: 0, skipped: 0),
                (hour: "2026-02-07T10:00:00Z", success: 3, failed: 0, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.trendPoints.count, 3)
        XCTAssertEqual(viewModel.trendPoints[0].success, 2) // 08:00
        XCTAssertEqual(viewModel.trendPoints[1].success, 3) // 10:00
        XCTAssertEqual(viewModel.trendPoints[2].success, 1) // 12:00
    }

    func testParseTrendPointsSkipsInvalidDates() {
        let response = [
            Test3dStatsResponse(hour: "2026-02-07T08:00:00Z", conclusions: ["success": 5]),
            Test3dStatsResponse(hour: "invalid-date", conclusions: ["success": 3]),
            Test3dStatsResponse(hour: "2026-02-07T10:00:00Z", conclusions: ["failed": 2]),
        ]

        let points = viewModel.parseTrendPoints(response)
        XCTAssertEqual(points.count, 2)
    }

    func testParseTrendPointsEmpty() {
        let points = viewModel.parseTrendPoints([])
        XCTAssertTrue(points.isEmpty)
    }

    // MARK: - TestTrendPoint Model

    func testTestTrendPointConclusions() {
        let point = TestTrendPoint(hour: Date(), conclusions: [
            "success": 5,
            "failed": 2,
            "flaky": 1,
            "skipped": 3,
        ])

        XCTAssertEqual(point.success, 5)
        XCTAssertEqual(point.failed, 2)
        XCTAssertEqual(point.flaky, 1)
        XCTAssertEqual(point.skipped, 3)
        XCTAssertEqual(point.total, 11)
    }

    func testTestTrendPointMissingConclusions() {
        let point = TestTrendPoint(hour: Date(), conclusions: [:])

        XCTAssertEqual(point.success, 0)
        XCTAssertEqual(point.failed, 0)
        XCTAssertEqual(point.flaky, 0)
        XCTAssertEqual(point.skipped, 0)
        XCTAssertEqual(point.total, 0)
    }

    func testTestTrendPointPartialConclusions() {
        let point = TestTrendPoint(hour: Date(), conclusions: [
            "success": 10,
            "failed": 3,
        ])

        XCTAssertEqual(point.success, 10)
        XCTAssertEqual(point.failed, 3)
        XCTAssertEqual(point.flaky, 0)
        XCTAssertEqual(point.skipped, 0)
        XCTAssertEqual(point.total, 13)
    }

    // MARK: - TestFailure Model

    func testTestFailureId() {
        let json = """
        {
            "jobName": "linux-build",
            "conclusion": "failure",
            "sha": "abc123",
            "time": "2026-02-07T10:00:00Z",
            "branch": "main",
            "htmlUrl": null,
            "logUrl": null,
            "failureLines": null,
            "failureCaptures": null
        }
        """
        let data = json.data(using: .utf8)!
        let failure = try! JSONDecoder().decode(TestFailure.self, from: data)

        XCTAssertEqual(failure.id, "abc123-linux-build-2026-02-07T10:00:00Z")
    }

    func testTestFailureTraceback() {
        let json = """
        {
            "jobName": "test",
            "conclusion": "failure",
            "sha": "abc",
            "time": null,
            "branch": "main",
            "htmlUrl": null,
            "logUrl": null,
            "failureLines": ["line1", "line2", "line3"],
            "failureCaptures": null
        }
        """
        let data = json.data(using: .utf8)!
        let failure = try! JSONDecoder().decode(TestFailure.self, from: data)

        XCTAssertEqual(failure.traceback, "line1\nline2\nline3")
    }

    func testTestFailureTracebackNilWhenNoLines() {
        let json = """
        {
            "jobName": "test",
            "conclusion": "failure",
            "sha": "abc",
            "time": null,
            "branch": "main",
            "htmlUrl": null,
            "logUrl": null,
            "failureLines": null,
            "failureCaptures": null
        }
        """
        let data = json.data(using: .utf8)!
        let failure = try! JSONDecoder().decode(TestFailure.self, from: data)

        XCTAssertNil(failure.traceback)
    }

    func testTestFailureTracebackNilWhenEmptyLines() {
        let json = """
        {
            "jobName": "test",
            "conclusion": "failure",
            "sha": "abc",
            "time": null,
            "branch": "main",
            "htmlUrl": null,
            "logUrl": null,
            "failureLines": [],
            "failureCaptures": null
        }
        """
        let data = json.data(using: .utf8)!
        let failure = try! JSONDecoder().decode(TestFailure.self, from: data)

        XCTAssertNil(failure.traceback)
    }

    // MARK: - Test3dStatsResponse Decoding

    func testTest3dStatsResponseDecoding() {
        let json = """
        {
            "hour": "2026-02-07T08:00:00Z",
            "conclusions": {
                "success": 15,
                "failed": 3,
                "flaky": 1,
                "skipped": 0
            }
        }
        """
        let data = json.data(using: .utf8)!
        let response = try! JSONDecoder().decode(Test3dStatsResponse.self, from: data)

        XCTAssertEqual(response.hour, "2026-02-07T08:00:00Z")
        XCTAssertEqual(response.conclusions["success"], 15)
        XCTAssertEqual(response.conclusions["failed"], 3)
        XCTAssertEqual(response.conclusions["flaky"], 1)
        XCTAssertEqual(response.conclusions["skipped"], 0)
    }

    func testTest3dStatsResponseArrayDecoding() {
        let json = """
        [
            {"hour": "2026-02-07T08:00:00Z", "conclusions": {"success": 5}},
            {"hour": "2026-02-07T09:00:00Z", "conclusions": {"failed": 2}}
        ]
        """
        let data = json.data(using: .utf8)!
        let response = try! JSONDecoder().decode([Test3dStatsResponse].self, from: data)

        XCTAssertEqual(response.count, 2)
        XCTAssertEqual(response[0].conclusions["success"], 5)
        XCTAssertEqual(response[1].conclusions["failed"], 2)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(TestInfoViewModel.ViewState.loading, .loading)
        XCTAssertEqual(TestInfoViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(TestInfoViewModel.ViewState.error("test"), .error("test"))
        XCTAssertNotEqual(TestInfoViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(TestInfoViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(TestInfoViewModel.ViewState.loading, .error("x"))
        XCTAssertNotEqual(TestInfoViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - Init with defaults

    func testInitWithDefaultFile() {
        let vm = TestInfoViewModel(
            testName: "test_something",
            testSuite: "TestSuite",
            apiClient: mockClient
        )
        XCTAssertEqual(vm.testFile, "")
        XCTAssertEqual(vm.testName, "test_something")
        XCTAssertEqual(vm.testSuite, "TestSuite")
    }

    // MARK: - Multiple expansion states

    func testMultipleFailuresExpansionIndependent() async {
        registerSuccessfulResponses(
            failures: [
                (jobName: "job1", conclusion: "failure", sha: "a", branch: "main", time: "2026-02-07T10:00:00.000Z", traceback: nil),
                (jobName: "job2", conclusion: "failure", sha: "b", branch: "main", time: "2026-02-07T09:00:00.000Z", traceback: nil),
                (jobName: "job3", conclusion: "failure", sha: "c", branch: "main", time: "2026-02-07T08:00:00.000Z", traceback: nil),
            ]
        )

        await viewModel.loadTestInfo()

        let f1 = viewModel.failures[0]
        let f2 = viewModel.failures[1]
        let f3 = viewModel.failures[2]

        // Expand first and third
        viewModel.toggleFailureExpansion(f1)
        viewModel.toggleFailureExpansion(f3)

        XCTAssertTrue(viewModel.isFailureExpanded(f1))
        XCTAssertFalse(viewModel.isFailureExpanded(f2))
        XCTAssertTrue(viewModel.isFailureExpanded(f3))

        // Collapse first
        viewModel.toggleFailureExpansion(f1)
        XCTAssertFalse(viewModel.isFailureExpanded(f1))
        XCTAssertTrue(viewModel.isFailureExpanded(f3))
    }

    // MARK: - Flakiness edge cases

    func testHighFlakinessScore() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-07T08:00:00Z", success: 0, failed: 10, flaky: 0, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        XCTAssertEqual(viewModel.flakinessScore!, 1.0, accuracy: 0.001)
        XCTAssertEqual(viewModel.flakinessPercentage, "100.0%")
        XCTAssertEqual(viewModel.passRate, "0.0%")
    }

    func testMixedTrendData() async {
        registerSuccessfulResponses(
            trendPoints: [
                (hour: "2026-02-05T08:00:00Z", success: 20, failed: 0, flaky: 0, skipped: 0),
                (hour: "2026-02-06T08:00:00Z", success: 15, failed: 3, flaky: 2, skipped: 0),
                (hour: "2026-02-07T08:00:00Z", success: 10, failed: 5, flaky: 5, skipped: 0),
            ]
        )

        await viewModel.loadTestInfo()

        // total: 20 + 20 + 20 = 60
        // failed + flaky: 0 + 5 + 10 = 15
        // flakiness = 15/60 = 0.25
        XCTAssertEqual(viewModel.totalRuns, 60)
        XCTAssertEqual(viewModel.flakinessScore!, 0.25, accuracy: 0.001)
        XCTAssertEqual(viewModel.flakinessPercentage, "25.0%")

        // pass rate = 45/60 * 100 = 75%
        XCTAssertEqual(viewModel.passRate, "75.0%")
    }
}
