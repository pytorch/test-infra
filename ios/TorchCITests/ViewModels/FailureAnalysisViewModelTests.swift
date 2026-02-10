import XCTest
@testable import TorchCI

@MainActor
final class FailureAnalysisViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: FailureAnalysisViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = FailureAnalysisViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeSearchResultJSON(jobs: [(jobName: String, conclusion: String, time: String?)]) -> String {
        let jobsJSON = jobs.map { job in
            let timeField: String
            if let time = job.time {
                timeField = "\"\(time)\""
            } else {
                timeField = "null"
            }
            return """
            {
                "id": \(Int.random(in: 1000...999999)),
                "name": "\(job.jobName)",
                "jobName": "\(job.jobName)",
                "conclusion": "\(job.conclusion)",
                "time": \(timeField),
                "durationS": 3600,
                "failureLines": ["Error: test failed"],
                "failureCaptures": ["AssertionError: expected true"],
                "failureContext": null,
                "runnerName": null,
                "runnerGroup": null,
                "status": "completed",
                "steps": null,
                "unstable": false,
                "htmlUrl": null,
                "logUrl": null,
                "previousRun": null
            }
            """
        }.joined(separator: ",")

        return """
        {
            "jobs": [\(jobsJSON)]
        }
        """
    }

    private func makeSimilarFailuresJSON(
        totalCount: Int,
        jobCount: [String: Int],
        sampleJobs: [(jobName: String, conclusion: String, time: String?)]
    ) -> String {
        let samplesJSON = sampleJobs.map { job in
            let timeField: String
            if let time = job.time {
                timeField = "\"\(time)\""
            } else {
                timeField = "null"
            }
            return """
            {
                "id": \(Int.random(in: 1000...999999)),
                "name": "\(job.jobName)",
                "jobName": "\(job.jobName)",
                "conclusion": "\(job.conclusion)",
                "time": \(timeField),
                "durationS": 1800,
                "failureLines": ["FAIL: test_something"],
                "failureCaptures": ["RuntimeError: something broke"],
                "failureContext": null,
                "runnerName": null,
                "runnerGroup": null,
                "status": "completed",
                "steps": null,
                "unstable": false,
                "htmlUrl": null,
                "logUrl": null,
                "previousRun": null
            }
            """
        }.joined(separator: ",")

        let jobCountJSON = jobCount.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ",")

        return """
        {
            "totalCount": \(totalCount),
            "jobCount": {\(jobCountJSON)},
            "samples": [\(samplesJSON)]
        }
        """
    }

    private func setupSearchResponse(
        jobs: [(jobName: String, conclusion: String, time: String?)] = [
            (jobName: "linux-build", conclusion: "failure", time: "2026-02-06T10:00:00Z"),
            (jobName: "linux-test", conclusion: "failure", time: "2026-02-05T15:30:00Z"),
        ]
    ) {
        let searchJSON = makeSearchResultJSON(jobs: jobs)
        mockClient.setResponse(searchJSON, for: "/api/search")

        let similarJSON = makeSimilarFailuresJSON(
            totalCount: jobs.count,
            jobCount: Dictionary(grouping: jobs, by: \.jobName).mapValues(\.count),
            sampleJobs: jobs
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.searchQuery.isEmpty)
        XCTAssertTrue(viewModel.results.isEmpty)
        XCTAssertNil(viewModel.selectedJob)
        XCTAssertFalse(viewModel.showDatePicker)
        XCTAssertNil(viewModel.similarFailuresResult)
        XCTAssertFalse(viewModel.isSimilarLoading)
        XCTAssertTrue(viewModel.selectedJobFilters.isEmpty)
        XCTAssertFalse(viewModel.hasResults)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertEqual(viewModel.totalCount, 0)
        XCTAssertTrue(viewModel.jobDistribution.isEmpty)
        XCTAssertTrue(viewModel.filteredResults.isEmpty)
    }

    // MARK: - Search

    func testSearchWithEmptyQueryDoesNothing() async {
        viewModel.searchQuery = "   "

        await viewModel.search()

        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(mockClient.callCount, 0)
    }

    func testSearchSuccessPopulatesResults() async {
        setupSearchResponse()
        viewModel.searchQuery = "test_nccl"

        await viewModel.search()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.results.count, 2)
        XCTAssertTrue(viewModel.hasResults)
    }

    func testSearchCallsBothEndpoints() async {
        setupSearchResponse()
        viewModel.searchQuery = "test_nccl"

        await viewModel.search()

        let calledPaths = mockClient.callPaths()
        XCTAssertTrue(calledPaths.contains("/api/search"), "Should call search endpoint")
        XCTAssertTrue(calledPaths.contains("/api/failure"), "Should call similar failures endpoint")
    }

    func testSearchErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/search")
        viewModel.searchQuery = "test_nccl"

        await viewModel.search()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testSearchClearsExistingResults() async {
        // First search
        setupSearchResponse()
        viewModel.searchQuery = "test_nccl"
        await viewModel.search()
        XCTAssertEqual(viewModel.results.count, 2)

        // Prepare for second search that returns empty
        mockClient.reset()
        let emptyJSON = """
        {"jobs": []}
        """
        mockClient.setResponse(emptyJSON, for: "/api/search")
        mockClient.setResponse("""
        {"totalCount": 0, "jobCount": {}, "samples": []}
        """, for: "/api/failure")
        viewModel.searchQuery = "nonexistent"
        viewModel.selectedJobFilters.insert("some-job")

        await viewModel.search()

        XCTAssertTrue(viewModel.results.isEmpty)
        XCTAssertTrue(viewModel.selectedJobFilters.isEmpty)
    }

    func testSearchUsesDateRange() async {
        setupSearchResponse()
        viewModel.searchQuery = "test_nccl"

        await viewModel.search()

        let searchCalls = mockClient.recordedCalls.filter { $0.path == "/api/search" }
        XCTAssertEqual(searchCalls.count, 1)

        let queryItems = searchCalls[0].queryItems ?? []
        XCTAssertTrue(queryItems.contains(where: { $0.name == "startDate" }))
        XCTAssertTrue(queryItems.contains(where: { $0.name == "endDate" }))
        XCTAssertTrue(queryItems.contains(where: { $0.name == "failure" && $0.value == "test_nccl" }))
    }

    // MARK: - Similar Failures

    func testFetchSimilarFailuresPopulatesResult() async {
        let similarJSON = makeSimilarFailuresJSON(
            totalCount: 42,
            jobCount: ["build-job": 30, "test-job": 12],
            sampleJobs: [
                (jobName: "build-job", conclusion: "failure", time: nil),
            ]
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")

        await viewModel.fetchSimilarFailures(name: "test_fail")

        XCTAssertNotNil(viewModel.similarFailuresResult)
        XCTAssertEqual(viewModel.similarFailuresResult?.totalCount, 42)
    }

    func testFetchSimilarFailuresErrorSetsNil() async {
        mockClient.setError(APIError.serverError(500), for: "/api/failure")

        await viewModel.fetchSimilarFailures(name: "test_fail")

        XCTAssertNil(viewModel.similarFailuresResult)
    }

    // MARK: - Total Count

    func testTotalCountPrefersSimilarFailuresResult() async {
        // Set up results with 2 jobs
        setupSearchResponse()
        viewModel.searchQuery = "test"
        await viewModel.search()

        // Override with a higher totalCount
        let similarJSON = makeSimilarFailuresJSON(
            totalCount: 150,
            jobCount: ["build": 100, "test": 50],
            sampleJobs: [
                (jobName: "build", conclusion: "failure", time: nil),
            ]
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        XCTAssertEqual(viewModel.totalCount, 150)
    }

    func testTotalCountFallsBackToResultsCount() {
        // With no similar failures, totalCount should be results.count
        XCTAssertEqual(viewModel.totalCount, 0)
    }

    // MARK: - Job Distribution

    func testJobDistributionFromSimilarFailures() async {
        let similarJSON = makeSimilarFailuresJSON(
            totalCount: 10,
            jobCount: ["job-a": 7, "job-b": 3],
            sampleJobs: []
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        let distribution = viewModel.jobDistribution
        XCTAssertEqual(distribution.count, 2)
        XCTAssertEqual(distribution[0].name, "job-a")
        XCTAssertEqual(distribution[0].count, 7)
        XCTAssertEqual(distribution[1].name, "job-b")
        XCTAssertEqual(distribution[1].count, 3)
    }

    func testJobDistributionFallsBackToResults() async {
        let searchJSON = makeSearchResultJSON(jobs: [
            (jobName: "linux-build", conclusion: "failure", time: nil),
            (jobName: "linux-build", conclusion: "failure", time: nil),
            (jobName: "win-build", conclusion: "failure", time: nil),
        ])
        mockClient.setResponse(searchJSON, for: "/api/search")
        // No similar failures response: will fail and set nil
        mockClient.setError(APIError.notFound, for: "/api/failure")
        viewModel.searchQuery = "test"
        await viewModel.search()

        let distribution = viewModel.jobDistribution
        XCTAssertEqual(distribution.count, 2)
        XCTAssertEqual(distribution[0].name, "linux-build")
        XCTAssertEqual(distribution[0].count, 2)
        XCTAssertEqual(distribution[1].name, "win-build")
        XCTAssertEqual(distribution[1].count, 1)
    }

    // MARK: - Job Filtering

    func testToggleJobFilter() {
        viewModel.toggleJobFilter("build-job")
        XCTAssertTrue(viewModel.selectedJobFilters.contains("build-job"))

        viewModel.toggleJobFilter("build-job")
        XCTAssertFalse(viewModel.selectedJobFilters.contains("build-job"))
    }

    func testFilteredResultsWithNoFilter() async {
        setupSearchResponse()
        viewModel.searchQuery = "test"
        await viewModel.search()

        XCTAssertTrue(viewModel.selectedJobFilters.isEmpty)
        XCTAssertEqual(viewModel.filteredResults.count, viewModel.results.count)
    }

    func testFilteredResultsWithJobFilter() async {
        setupSearchResponse(jobs: [
            (jobName: "linux-build", conclusion: "failure", time: nil),
            (jobName: "linux-test", conclusion: "failure", time: nil),
            (jobName: "win-build", conclusion: "failure", time: nil),
        ])
        viewModel.searchQuery = "test"
        await viewModel.search()

        viewModel.toggleJobFilter("linux-build")

        let filtered = viewModel.filteredResults
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].jobName, "linux-build")
    }

    func testFilteredResultsMultipleFilters() async {
        setupSearchResponse(jobs: [
            (jobName: "linux-build", conclusion: "failure", time: nil),
            (jobName: "linux-test", conclusion: "failure", time: nil),
            (jobName: "win-build", conclusion: "failure", time: nil),
        ])
        viewModel.searchQuery = "test"
        await viewModel.search()

        viewModel.toggleJobFilter("linux-build")
        viewModel.toggleJobFilter("win-build")

        let filtered = viewModel.filteredResults
        XCTAssertEqual(filtered.count, 2)
    }

    // MARK: - Clear Results

    func testClearResults() async {
        setupSearchResponse()
        viewModel.searchQuery = "test"
        await viewModel.search()
        viewModel.toggleJobFilter("linux-build")

        XCTAssertTrue(viewModel.hasResults)
        XCTAssertFalse(viewModel.selectedJobFilters.isEmpty)

        viewModel.clearResults()

        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.results.isEmpty)
        XCTAssertNil(viewModel.similarFailuresResult)
        XCTAssertTrue(viewModel.selectedJobFilters.isEmpty)
        XCTAssertFalse(viewModel.hasResults)
    }

    // MARK: - Date Range

    func testResetDateRange() {
        let futureDate = Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        viewModel.startDate = futureDate

        viewModel.resetDateRange()

        let expected = Calendar.current.date(byAdding: .day, value: -14, to: Date())!
        let diff = abs(viewModel.startDate.timeIntervalSince(expected))
        XCTAssertLessThan(diff, 2, "Start date should be ~14 days ago")

        let endDiff = abs(viewModel.endDate.timeIntervalSince(Date()))
        XCTAssertLessThan(endDiff, 2, "End date should be ~now")
    }

    func testDefaultDateRangeIs14Days() {
        let expected = Calendar.current.date(byAdding: .day, value: -14, to: Date())!
        let diff = abs(viewModel.startDate.timeIntervalSince(expected))
        XCTAssertLessThan(diff, 2, "Default start date should be ~14 days ago")
    }

    // MARK: - Histogram Data

    func testHistogramDataReturns15Buckets() {
        let data = viewModel.histogramData
        XCTAssertEqual(data.count, 15, "Default range of -14 days to today = 15 day buckets (inclusive)")
    }

    func testHistogramDataBucketsAreChronological() {
        let data = viewModel.histogramData
        XCTAssertEqual(data.count, 15)

        // Last bucket should correspond to today
        let todayFormatter = DateFormatter()
        todayFormatter.dateFormat = "MM/d"
        let todayLabel = todayFormatter.string(from: Date())
        XCTAssertEqual(data.last?.date, todayLabel, "Last bucket should be today")
    }

    func testHistogramDataIsEmptyCountsWhenNoResults() {
        let data = viewModel.histogramData
        let totalMain = data.reduce(0) { $0 + $1.main }
        let totalOther = data.reduce(0) { $0 + $1.other }
        XCTAssertEqual(totalMain, 0)
        XCTAssertEqual(totalOther, 0)
    }

    // MARK: - Average Failures Per Day

    func testAverageFailuresPerDayNilWhenNoData() {
        XCTAssertNil(viewModel.averageFailuresPerDay)
    }

    func testMainBranchFailureCountZeroWhenNoData() {
        XCTAssertEqual(viewModel.mainBranchFailureCount, 0)
    }

    // MARK: - State Equatable

    func testViewStateEquality() {
        XCTAssertEqual(FailureAnalysisViewModel.ViewState.idle, .idle)
        XCTAssertEqual(FailureAnalysisViewModel.ViewState.loading, .loading)
        XCTAssertEqual(FailureAnalysisViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(FailureAnalysisViewModel.ViewState.error("a"), .error("a"))
        XCTAssertNotEqual(FailureAnalysisViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(FailureAnalysisViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(FailureAnalysisViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(FailureAnalysisViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - Has Results

    func testHasResultsWithOnlySearchResults() async {
        let searchJSON = makeSearchResultJSON(jobs: [
            (jobName: "build", conclusion: "failure", time: nil),
        ])
        mockClient.setResponse(searchJSON, for: "/api/search")
        mockClient.setError(APIError.notFound, for: "/api/failure")

        viewModel.searchQuery = "test"
        await viewModel.search()

        XCTAssertTrue(viewModel.hasResults)
    }

    func testHasResultsWithSimilarFailuresOnly() async {
        let similarJSON = makeSimilarFailuresJSON(
            totalCount: 5,
            jobCount: ["a": 5],
            sampleJobs: [(jobName: "a", conclusion: "failure", time: nil)]
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        XCTAssertTrue(viewModel.hasResults)
    }

    // MARK: - Loading State

    func testIsLoading() {
        XCTAssertFalse(viewModel.isLoading)

        viewModel.state = .loading
        XCTAssertTrue(viewModel.isLoading)

        viewModel.state = .loaded
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Show Date Picker

    func testShowDatePickerToggle() {
        XCTAssertFalse(viewModel.showDatePicker)
        viewModel.showDatePicker = true
        XCTAssertTrue(viewModel.showDatePicker)
    }

    // MARK: - Selected Job

    func testSelectedJobStartsNil() {
        XCTAssertNil(viewModel.selectedJob)
    }

    // MARK: - Histogram Branch Categorization

    func testHistogramCategorizesMainBranchSeparately() async {
        let today = ISO8601DateFormatter().string(from: Date())
        setupSearchResponse(jobs: [
            (jobName: "build", conclusion: "failure", time: today),
            (jobName: "test", conclusion: "failure", time: today),
        ])
        // Override with samples that include branch info (head_branch is the JSON key)
        let samplesJSON = """
        {
            "totalCount": 3,
            "jobCount": {"build": 2, "test": 1},
            "samples": [
                {"id": 1, "name": "build", "jobName": "build", "conclusion": "failure",
                 "time": "\(today)", "head_branch": "main", "durationS": 100,
                 "status": "completed", "unstable": false},
                {"id": 2, "name": "build", "jobName": "build", "conclusion": "failure",
                 "time": "\(today)", "head_branch": "feature-x", "durationS": 100,
                 "status": "completed", "unstable": false},
                {"id": 3, "name": "test", "jobName": "test", "conclusion": "failure",
                 "time": "\(today)", "head_branch": "master", "durationS": 100,
                 "status": "completed", "unstable": false}
            ]
        }
        """
        mockClient.setResponse(samplesJSON, for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        let mainCount = viewModel.mainBranchFailureCount
        XCTAssertEqual(mainCount, 2, "main + master branches should both count as 'main'")
    }

    // MARK: - Average Failures Per Day

    func testAverageFailuresPerDayWithData() async {
        let formatter = ISO8601DateFormatter()
        let today = formatter.string(from: Date())
        let yesterday = formatter.string(from: Calendar.current.date(byAdding: .day, value: -1, to: Date())!)
        setupSearchResponse(jobs: [
            (jobName: "build", conclusion: "failure", time: today),
            (jobName: "build", conclusion: "failure", time: today),
            (jobName: "build", conclusion: "failure", time: yesterday),
        ])
        viewModel.searchQuery = "test"
        await viewModel.search()

        let avg = viewModel.averageFailuresPerDay
        XCTAssertNotNil(avg)
        // 3 failures over 2 days = 1.5 avg
        XCTAssertEqual(avg, "1.5")
    }

    func testAverageFailuresPerDayWholeNumber() async {
        let formatter = ISO8601DateFormatter()
        let today = formatter.string(from: Date())
        setupSearchResponse(jobs: [
            (jobName: "build", conclusion: "failure", time: today),
            (jobName: "build", conclusion: "failure", time: today),
        ])
        viewModel.searchQuery = "test"
        await viewModel.search()

        let avg = viewModel.averageFailuresPerDay
        XCTAssertNotNil(avg)
        // 2 failures over 1 day = 2 avg (whole number, no decimal)
        XCTAssertEqual(avg, "2")
    }

    // MARK: - Similar Failures Error

    func testSimilarFailuresErrorMessage() async {
        mockClient.setError(APIError.serverError(500), for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        XCTAssertNotNil(viewModel.similarFailuresError)
        XCTAssertTrue(viewModel.similarFailuresError?.contains("Could not load") ?? false)
    }

    func testSimilarFailuresErrorClearedOnSuccess() async {
        // First: fail
        mockClient.setError(APIError.serverError(500), for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")
        XCTAssertNotNil(viewModel.similarFailuresError)

        // Then: succeed
        mockClient.clearError(for: "/api/failure")
        let similarJSON = makeSimilarFailuresJSON(
            totalCount: 5,
            jobCount: ["a": 5],
            sampleJobs: [(jobName: "a", conclusion: "failure", time: nil)]
        )
        mockClient.setResponse(similarJSON, for: "/api/failure")
        await viewModel.fetchSimilarFailures(name: "test")

        XCTAssertNil(viewModel.similarFailuresError)
        XCTAssertNotNil(viewModel.similarFailuresResult)
    }

    func testIsSimilarLoadingDuringFetch() {
        XCTAssertFalse(viewModel.isSimilarLoading)
    }

    // MARK: - Custom Date Range

    func testCustomDateRangeAffectsHistogramBuckets() {
        let calendar = Calendar.current
        viewModel.startDate = calendar.date(byAdding: .day, value: -3, to: Date())!
        viewModel.endDate = Date()

        let data = viewModel.histogramData
        XCTAssertEqual(data.count, 4, "3 days ago to today = 4 day buckets")
    }

    func testSingleDayRangeReturns1Bucket() {
        viewModel.startDate = Calendar.current.startOfDay(for: Date())
        viewModel.endDate = Date()

        let data = viewModel.histogramData
        XCTAssertEqual(data.count, 1, "Same day range = 1 bucket")
    }
}
