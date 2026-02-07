import XCTest
@testable import TorchCI

@MainActor
final class DisabledTestsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: DisabledTestsViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = DisabledTestsViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Test Data Helpers

    private func makeDisabledTestsJSON(
        tests: [(name: String, number: Int, htmlUrl: String, assignee: String?, updatedAt: String, labels: [String], body: String)]
    ) -> String {
        // The ClickHouse API returns a flat array, not wrapped in {data: [...]}.
        let testsJSON = tests.map { test in
            let assigneeStr = test.assignee.map { "\"\($0)\"" } ?? "null"
            let labelsStr = test.labels.map { "\"\($0)\"" }.joined(separator: ",")
            return """
            {
                "number": \(test.number),
                "name": "\(test.name)",
                "assignee": \(assigneeStr),
                "html_url": "\(test.htmlUrl)",
                "updated_at": "\(test.updatedAt)",
                "labels": [\(labelsStr)],
                "body": "\(test.body)"
            }
            """
        }.joined(separator: ",")

        return "[\(testsJSON)]"
    }

    private func makeHistoricalJSON(
        entries: [(day: String, count: Int, new: Int, deleted: Int)]
    ) -> String {
        // The ClickHouse API returns a flat array, not wrapped in {data: [...]}.
        let entriesJSON = entries.map { entry in
            """
            {
                "day": "\(entry.day)",
                "count": \(entry.count),
                "new": \(entry.new),
                "deleted": \(entry.deleted)
            }
            """
        }.joined(separator: ",")

        return "[\(entriesJSON)]"
    }

    /// Register both disabled tests and historical data responses.
    private func registerResponses(
        tests: [(name: String, number: Int, htmlUrl: String, assignee: String?, updatedAt: String, labels: [String], body: String)] = [],
        historical: [(day: String, count: Int, new: Int, deleted: Int)] = []
    ) {
        let testsJSON = makeDisabledTestsJSON(tests: tests)
        mockClient.setResponse(testsJSON, for: "/api/clickhouse/disabled_tests")

        let historicalJSON = makeHistoricalJSON(entries: historical)
        mockClient.setResponse(historicalJSON, for: "/api/clickhouse/disabled_test_historical")
    }

    /// A standard set of test data for reuse across multiple tests.
    private let sampleTests: [(name: String, number: Int, htmlUrl: String, assignee: String?, updatedAt: String, labels: [String], body: String)] = [
        (
            name: "TestNCCL.test_allreduce",
            number: 12345,
            htmlUrl: "https://github.com/pytorch/pytorch/issues/12345",
            assignee: "alice",
            updatedAt: "2026-02-05T10:00:00Z",
            labels: ["triaged", "high priority"],
            body: "Platforms: linux, rocm"
        ),
        (
            name: "TestNCCL.test_broadcast",
            number: 12346,
            htmlUrl: "https://github.com/pytorch/pytorch/issues/12346",
            assignee: "bob",
            updatedAt: "2026-02-04T10:00:00Z",
            labels: ["triaged"],
            body: "Platforms: linux"
        ),
        (
            name: "TestAutograd.test_gradient",
            number: 12347,
            htmlUrl: "https://github.com/pytorch/pytorch/issues/12347",
            assignee: nil,
            updatedAt: "2026-01-01T10:00:00Z",
            labels: [],
            body: "Platforms: win, mac"
        ),
        (
            name: "TestDynamo.test_compile",
            number: 12348,
            htmlUrl: "https://github.com/pytorch/pytorch/issues/12348",
            assignee: "charlie",
            updatedAt: "2026-02-06T10:00:00Z",
            labels: ["high priority"],
            body: "Platforms: dynamo, inductor"
        ),
        (
            name: "test_standalone",
            number: 12349,
            htmlUrl: "https://github.com/pytorch/pytorch/issues/12349",
            assignee: nil,
            updatedAt: "2025-10-01T10:00:00Z",
            labels: [],
            body: "No platform info"
        ),
    ]

    private let sampleHistorical: [(day: String, count: Int, new: Int, deleted: Int)] = [
        ("2026-02-05", 100, 5, 3),
        ("2026-02-06", 105, 8, 3),
        ("2026-02-07", 102, 2, 5),
    ]

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertTrue(viewModel.allTests.isEmpty)
        XCTAssertTrue(viewModel.historicalData.isEmpty)
        XCTAssertEqual(viewModel.platformFilter, "All")
        XCTAssertEqual(viewModel.triagedFilter, .both)
        XCTAssertEqual(viewModel.sortOption, .highPriority)
        XCTAssertEqual(viewModel.searchQuery, "")
        XCTAssertFalse(viewModel.groupBySuite)
        XCTAssertEqual(viewModel.totalCount, 0)
        XCTAssertEqual(viewModel.triagedCount, 0)
        XCTAssertEqual(viewModel.untriagedCount, 0)
        XCTAssertEqual(viewModel.highPriorityCount, 0)
        XCTAssertNil(viewModel.trend)
        XCTAssertNil(viewModel.currentCount)
        XCTAssertFalse(viewModel.hasActiveFilters)
        XCTAssertNil(viewModel.activeFilterDescription)
    }

    // MARK: - Loading

    func testLoadDisabledTestsSetsLoadedState() async {
        registerResponses(tests: sampleTests, historical: sampleHistorical)

        await viewModel.loadDisabledTests()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.allTests.count, 5)
        XCTAssertEqual(viewModel.historicalData.count, 3)
    }

    func testLoadDisabledTestsMapsFieldsCorrectly() async {
        registerResponses(tests: [sampleTests[0]])

        await viewModel.loadDisabledTests()

        let test = viewModel.allTests[0]
        XCTAssertEqual(test.testName, "TestNCCL.test_allreduce")
        XCTAssertEqual(test.issueNumber, 12345)
        XCTAssertEqual(test.issueUrl, "https://github.com/pytorch/pytorch/issues/12345")
        XCTAssertEqual(test.assignee, "alice")
        XCTAssertEqual(test.updatedAt, "2026-02-05T10:00:00Z")
        XCTAssertEqual(test.labels, ["triaged", "high priority"])
        XCTAssertTrue(test.isTriaged)
        XCTAssertTrue(test.isHighPriority)
    }

    func testLoadExtractsPlatformsFromBody() async {
        registerResponses(tests: [sampleTests[0]])

        await viewModel.loadDisabledTests()

        let test = viewModel.allTests[0]
        XCTAssertNotNil(test.platforms)
        XCTAssertTrue(test.platforms!.contains("linux"))
        XCTAssertTrue(test.platforms!.contains("rocm"))
    }

    func testLoadWithNoPlatformInBody() async {
        registerResponses(tests: [sampleTests[4]])

        await viewModel.loadDisabledTests()

        let test = viewModel.allTests[0]
        XCTAssertNil(test.platforms)
    }

    func testLoadSetsErrorStateOnFailure() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/disabled_tests")

        await viewModel.loadDisabledTests()

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadRecordsCorrectAPICalls() async {
        registerResponses(tests: [], historical: [])

        await viewModel.loadDisabledTests()

        let paths = mockClient.callPaths()
        XCTAssertEqual(paths.count, 2)
        XCTAssertTrue(paths.contains("/api/clickhouse/disabled_tests"))
        XCTAssertTrue(paths.contains("/api/clickhouse/disabled_test_historical"))
    }

    // MARK: - Refresh

    func testRefreshUpdatesData() async {
        registerResponses(tests: [sampleTests[0]])
        await viewModel.loadDisabledTests()
        XCTAssertEqual(viewModel.allTests.count, 1)

        // Now register more data and refresh
        registerResponses(tests: [sampleTests[0], sampleTests[1]])
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.allTests.count, 2)
    }

    func testRefreshSetsErrorOnFailure() async {
        registerResponses(tests: [sampleTests[0]])
        await viewModel.loadDisabledTests()

        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/disabled_tests")
        await viewModel.refresh()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state after failed refresh")
        }
    }

    // MARK: - Computed Counts

    func testTotalCount() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        XCTAssertEqual(viewModel.totalCount, 5)
    }

    func testTriagedCount() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        // sampleTests[0] has "triaged", sampleTests[1] has "triaged"
        XCTAssertEqual(viewModel.triagedCount, 2)
    }

    func testUntriagedCount() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        // 5 total - 2 triaged = 3 untriaged
        XCTAssertEqual(viewModel.untriagedCount, 3)
    }

    func testHighPriorityCount() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        // sampleTests[0] and sampleTests[3] have "high priority"
        XCTAssertEqual(viewModel.highPriorityCount, 2)
    }

    // MARK: - Trend

    func testTrendWithMultipleDataPoints() async {
        registerResponses(tests: [], historical: sampleHistorical)
        await viewModel.loadDisabledTests()

        // Last: 102, Second to last: 105 => trend = -3
        XCTAssertEqual(viewModel.trend, -3)
    }

    func testTrendIsNilWithSingleDataPoint() async {
        registerResponses(tests: [], historical: [("2026-02-07", 100, 5, 3)])
        await viewModel.loadDisabledTests()

        XCTAssertNil(viewModel.trend)
    }

    func testTrendIsNilWithNoData() async {
        registerResponses(tests: [], historical: [])
        await viewModel.loadDisabledTests()

        XCTAssertNil(viewModel.trend)
    }

    func testPositiveTrend() async {
        registerResponses(tests: [], historical: [
            ("2026-02-06", 100, 5, 3),
            ("2026-02-07", 110, 12, 2),
        ])
        await viewModel.loadDisabledTests()

        XCTAssertEqual(viewModel.trend, 10)
    }

    func testCurrentCount() async {
        registerResponses(tests: [], historical: sampleHistorical)
        await viewModel.loadDisabledTests()

        XCTAssertEqual(viewModel.currentCount, 102)
    }

    func testCurrentCountIsNilWithNoData() async {
        registerResponses(tests: [], historical: [])
        await viewModel.loadDisabledTests()

        XCTAssertNil(viewModel.currentCount)
    }

    // MARK: - Platform Filter

    func testPlatformFilterAll() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "All"
        XCTAssertEqual(viewModel.filteredTests.count, 5)
    }

    func testPlatformFilterLinux() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        let filtered = viewModel.filteredTests

        // sampleTests[0] has linux, rocm; sampleTests[1] has linux
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { $0.platforms?.contains("linux") ?? false })
    }

    func testPlatformFilterCaseInsensitive() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "Linux"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 2)
    }

    func testPlatformFilterNoMatches() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "nonexistent"
        XCTAssertTrue(viewModel.filteredTests.isEmpty)
    }

    // MARK: - Available Platforms

    func testAvailablePlatformsIncludesAll() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let platforms = viewModel.availablePlatforms
        XCTAssertEqual(platforms.first, "All")
    }

    func testAvailablePlatformsAreSorted() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let platforms = viewModel.availablePlatforms
        // "All" first, then sorted
        let rest = Array(platforms.dropFirst())
        XCTAssertEqual(rest, rest.sorted())
    }

    func testAvailablePlatformsNoDuplicates() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let platforms = viewModel.availablePlatforms
        let unique = Set(platforms)
        XCTAssertEqual(platforms.count, unique.count)
    }

    // MARK: - Triaged Filter

    func testTriagedFilterBoth() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.triagedFilter = .both
        XCTAssertEqual(viewModel.filteredTests.count, 5)
    }

    func testTriagedFilterYes() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.triagedFilter = .yes
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { $0.isTriaged })
    }

    func testTriagedFilterNo() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.triagedFilter = .no
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 3)
        XCTAssertTrue(filtered.allSatisfy { !$0.isTriaged })
    }

    // MARK: - Search Filter

    func testSearchByTestName() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "allreduce"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.testName, "TestNCCL.test_allreduce")
    }

    func testSearchBySuiteName() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "TestNCCL"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 2)
    }

    func testSearchByAssignee() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "alice"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.assignee, "alice")
    }

    func testSearchByIssueNumber() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "12345"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.issueNumber, 12345)
    }

    func testSearchByIssueNumberWithHash() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "#12345"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.issueNumber, 12345)
    }

    func testSearchByPlatform() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "dynamo"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.testName, "TestDynamo.test_compile")
    }

    func testSearchIsCaseInsensitive() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "ALLREDUCE"
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
    }

    func testSearchTrimsWhitespace() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "  allreduce  "
        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
    }

    func testEmptySearchShowsAll() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = ""
        XCTAssertEqual(viewModel.filteredTests.count, 5)
    }

    func testSearchNoResults() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "zzz_nonexistent"
        XCTAssertTrue(viewModel.filteredTests.isEmpty)
    }

    // MARK: - Combined Filters

    func testPlatformAndTriagedFilterCombined() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        viewModel.triagedFilter = .yes

        let filtered = viewModel.filteredTests
        // linux triaged: sampleTests[0] and sampleTests[1]
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { $0.isTriaged })
        XCTAssertTrue(filtered.allSatisfy { $0.platforms?.contains("linux") ?? false })
    }

    func testSearchAndPlatformFilterCombined() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        viewModel.searchQuery = "allreduce"

        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.testName, "TestNCCL.test_allreduce")
    }

    func testAllFiltersCombined() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        viewModel.triagedFilter = .yes
        viewModel.searchQuery = "allreduce"

        let filtered = viewModel.filteredTests
        XCTAssertEqual(filtered.count, 1)
    }

    // MARK: - Sort Options

    func testSortByHighPriority() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.sortOption = .highPriority
        let filtered = viewModel.filteredTests

        // High priority tests should come first
        let highPriorityIndices = filtered.enumerated().compactMap { $0.element.isHighPriority ? $0.offset : nil }
        let nonHighPriorityIndices = filtered.enumerated().compactMap { !$0.element.isHighPriority ? $0.offset : nil }

        if let lastHigh = highPriorityIndices.last, let firstNonHigh = nonHighPriorityIndices.first {
            XCTAssertLessThan(lastHigh, firstNonHigh)
        }
    }

    func testSortByNewest() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.sortOption = .newest
        let filtered = viewModel.filteredTests

        // Verify descending order of updatedAt
        for i in 0..<(filtered.count - 1) {
            let current = filtered[i].updatedAt ?? ""
            let next = filtered[i + 1].updatedAt ?? ""
            XCTAssertGreaterThanOrEqual(current, next)
        }
    }

    func testSortByOldest() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.sortOption = .oldest
        let filtered = viewModel.filteredTests

        // Verify ascending order of updatedAt
        for i in 0..<(filtered.count - 1) {
            let current = filtered[i].updatedAt ?? ""
            let next = filtered[i + 1].updatedAt ?? ""
            XCTAssertLessThanOrEqual(current, next)
        }
    }

    func testSortByPlatform() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.sortOption = .platform
        let filtered = viewModel.filteredTests

        // Verify sorted by first platform name
        for i in 0..<(filtered.count - 1) {
            let current = filtered[i].platforms?.first ?? ""
            let next = filtered[i + 1].platforms?.first ?? ""
            XCTAssertLessThanOrEqual(current, next)
        }
    }

    // MARK: - Group By Suite

    func testGroupBySuiteOff() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.groupBySuite = false
        // groupedTests should still work even when groupBySuite is off
        XCTAssertFalse(viewModel.groupedTests.isEmpty)
    }

    func testGroupedTestsGroupsBySuite() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.groupBySuite = true
        let groups = viewModel.groupedTests

        // We expect 4 groups: TestNCCL (2), TestAutograd (1), TestDynamo (1), Unknown Suite (1)
        XCTAssertEqual(groups.count, 4)

        let ncclGroup = groups.first { $0.suiteName == "TestNCCL" }
        XCTAssertNotNil(ncclGroup)
        XCTAssertEqual(ncclGroup?.tests.count, 2)

        let unknownGroup = groups.first { $0.suiteName == "Unknown Suite" }
        XCTAssertNotNil(unknownGroup)
        XCTAssertEqual(unknownGroup?.tests.count, 1)
    }

    func testGroupedTestsSortedAlphabetically() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let groups = viewModel.groupedTests
        let suiteNames = groups.map(\.suiteName)
        XCTAssertEqual(suiteNames, suiteNames.sorted())
    }

    func testGroupedTestsRespectFilters() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "TestNCCL"
        let groups = viewModel.groupedTests

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.suiteName, "TestNCCL")
        XCTAssertEqual(groups.first?.tests.count, 2)
    }

    func testGroupedTestsRespectPlatformFilter() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "dynamo"
        let groups = viewModel.groupedTests

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.suiteName, "TestDynamo")
    }

    // MARK: - Available Suites

    func testAvailableSuites() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let suites = viewModel.availableSuites
        XCTAssertTrue(suites.contains("TestNCCL"))
        XCTAssertTrue(suites.contains("TestAutograd"))
        XCTAssertTrue(suites.contains("TestDynamo"))
        // "test_standalone" has no suite
        XCTAssertEqual(suites.count, 3)
    }

    func testAvailableSuitesAreSorted() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        let suites = viewModel.availableSuites
        XCTAssertEqual(suites, suites.sorted())
    }

    // MARK: - Clear Filters

    func testClearFiltersResetsAll() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        viewModel.triagedFilter = .yes
        viewModel.searchQuery = "test"
        viewModel.sortOption = .newest

        viewModel.clearFilters()

        XCTAssertEqual(viewModel.platformFilter, "All")
        XCTAssertEqual(viewModel.triagedFilter, .both)
        XCTAssertEqual(viewModel.searchQuery, "")
        XCTAssertEqual(viewModel.sortOption, .highPriority)
    }

    // MARK: - Issue URL

    func testIssueURLReturnsValidURL() async {
        registerResponses(tests: [sampleTests[0]])
        await viewModel.loadDisabledTests()

        let test = viewModel.allTests[0]
        let url = viewModel.issueURL(for: test)

        XCTAssertNotNil(url)
        XCTAssertEqual(url?.absoluteString, "https://github.com/pytorch/pytorch/issues/12345")
    }

    func testIssueURLReturnsNilForMissingURL() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: nil,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )

        XCTAssertNil(viewModel.issueURL(for: test))
    }

    // MARK: - Has Active Filters

    func testHasActiveFiltersWhenPlatformSet() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testHasActiveFiltersWhenTriagedSet() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.triagedFilter = .yes
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testHasActiveFiltersWhenSearchSet() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.searchQuery = "test"
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testHasActiveFiltersWhenWhitespaceOnlySearch() {
        viewModel.searchQuery = "   "
        XCTAssertFalse(viewModel.hasActiveFilters)
    }

    func testHasNoActiveFiltersDefault() {
        XCTAssertFalse(viewModel.hasActiveFilters)
    }

    // MARK: - Active Filter Description

    func testActiveFilterDescriptionWithPlatform() {
        viewModel.platformFilter = "linux"
        XCTAssertEqual(viewModel.activeFilterDescription, "linux")
    }

    func testActiveFilterDescriptionWithMultipleFilters() {
        viewModel.platformFilter = "linux"
        viewModel.triagedFilter = .yes
        viewModel.searchQuery = "test"

        let desc = viewModel.activeFilterDescription
        XCTAssertNotNil(desc)
        XCTAssertTrue(desc!.contains("linux"))
        XCTAssertTrue(desc!.contains("Triaged"))
        XCTAssertTrue(desc!.contains("\"test\""))
    }

    func testActiveFilterDescriptionIsNilWithNoFilters() {
        XCTAssertNil(viewModel.activeFilterDescription)
    }

    // MARK: - DisabledTest Model Properties

    func testParsedTestName() {
        let test = DisabledTest(
            testName: "TestSuite.test_method",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertEqual(test.parsedTestName, "test_method")
    }

    func testParsedTestNameWithoutDot() {
        let test = DisabledTest(
            testName: "test_standalone",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertEqual(test.parsedTestName, "test_standalone")
    }

    func testSuiteName() {
        let test = DisabledTest(
            testName: "TestSuite.test_method",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertEqual(test.suiteName, "TestSuite")
    }

    func testSuiteNameNilForStandalone() {
        let test = DisabledTest(
            testName: "test_standalone",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertNil(test.suiteName)
    }

    func testIsTriagedTrue() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: ["triaged"],
            body: nil
        )
        XCTAssertTrue(test.isTriaged)
    }

    func testIsTriagedFalse() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: [],
            body: nil
        )
        XCTAssertFalse(test.isTriaged)
    }

    func testIsTriagedNilLabels() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertFalse(test.isTriaged)
    }

    func testIsHighPriorityTrue() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: ["high priority"],
            body: nil
        )
        XCTAssertTrue(test.isHighPriority)
    }

    func testIsHighPriorityFalse() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: ["triaged"],
            body: nil
        )
        XCTAssertFalse(test.isHighPriority)
    }

    func testTestPath() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: "Test file path: `test/distributed/test_nccl.py`"
        )
        XCTAssertEqual(test.testPath, "test/distributed/test_nccl.py")
    }

    func testTestPathNilWhenNotInBody() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: "No path here"
        )
        XCTAssertNil(test.testPath)
    }

    func testTestPathNilForNilBody() {
        let test = DisabledTest(
            testName: "test",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertNil(test.testPath)
    }

    func testTestId() {
        let test = DisabledTest(
            testName: "TestSuite.test_method",
            issueNumber: 1,
            issueUrl: nil,
            platforms: nil,
            assignee: nil,
            updatedAt: nil,
            labels: nil,
            body: nil
        )
        XCTAssertEqual(test.id, "TestSuite.test_method")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(
            DisabledTestsViewModel.ViewState.loading,
            DisabledTestsViewModel.ViewState.loading
        )
        XCTAssertEqual(
            DisabledTestsViewModel.ViewState.loaded,
            DisabledTestsViewModel.ViewState.loaded
        )
        XCTAssertEqual(
            DisabledTestsViewModel.ViewState.error("msg"),
            DisabledTestsViewModel.ViewState.error("msg")
        )
        XCTAssertNotEqual(
            DisabledTestsViewModel.ViewState.loading,
            DisabledTestsViewModel.ViewState.loaded
        )
        XCTAssertNotEqual(
            DisabledTestsViewModel.ViewState.error("a"),
            DisabledTestsViewModel.ViewState.error("b")
        )
    }

    // MARK: - SortOption / TriagedFilter Enums

    func testSortOptionCases() {
        let cases = DisabledTestsViewModel.SortOption.allCases
        XCTAssertEqual(cases.count, 4)
        XCTAssertTrue(cases.contains(.highPriority))
        XCTAssertTrue(cases.contains(.newest))
        XCTAssertTrue(cases.contains(.oldest))
        XCTAssertTrue(cases.contains(.platform))
    }

    func testSortOptionIdentifiable() {
        let option = DisabledTestsViewModel.SortOption.newest
        XCTAssertEqual(option.id, "Newest")
    }

    func testTriagedFilterCases() {
        let cases = DisabledTestsViewModel.TriagedFilter.allCases
        XCTAssertEqual(cases.count, 3)
        XCTAssertTrue(cases.contains(.both))
        XCTAssertTrue(cases.contains(.yes))
        XCTAssertTrue(cases.contains(.no))
    }

    func testTriagedFilterIdentifiable() {
        let filter = DisabledTestsViewModel.TriagedFilter.yes
        XCTAssertEqual(filter.id, "Triaged")
    }

    // MARK: - Edge Cases

    func testEmptyResponseLoadsSuccessfully() async {
        registerResponses(tests: [], historical: [])
        await viewModel.loadDisabledTests()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.allTests.isEmpty)
        XCTAssertTrue(viewModel.filteredTests.isEmpty)
        XCTAssertEqual(viewModel.totalCount, 0)
    }

    func testGroupedTestsEmptyWhenNoTests() async {
        registerResponses(tests: [], historical: [])
        await viewModel.loadDisabledTests()

        XCTAssertTrue(viewModel.groupedTests.isEmpty)
    }

    func testSearchPartialIssueNumber() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        // "1234" should match issues 12345, 12346, 12347, 12348, 12349
        viewModel.searchQuery = "1234"
        XCTAssertEqual(viewModel.filteredTests.count, 5)
    }

    func testFilteredTestCountWithAllFiltersActive() async {
        registerResponses(tests: sampleTests)
        await viewModel.loadDisabledTests()

        viewModel.platformFilter = "linux"
        viewModel.triagedFilter = .no
        viewModel.searchQuery = "nonexistent"

        XCTAssertTrue(viewModel.filteredTests.isEmpty)
    }
}
