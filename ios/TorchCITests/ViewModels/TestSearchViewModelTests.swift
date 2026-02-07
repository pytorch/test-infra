import XCTest
@testable import TorchCI

@MainActor
final class TestSearchViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TestSearchViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TestSearchViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        // Clean up UserDefaults test data
        UserDefaults.standard.removeObject(forKey: "test_search_recent_searches")
        super.tearDown()
    }

    // MARK: - Helpers

    /// Build a JSON string matching the real TestSearchResponse format:
    /// { "count": N, "tests": [{ "name", "classname", "file", "invoking_file", "last_run" }] }
    private func makeSearchResponseJSON(
        tests: [(name: String, classname: String, file: String)] = [],
        count: Int? = nil
    ) -> String {
        let testsJSON = tests.map { test in
            """
            {
                "name": "\(test.name)",
                "classname": "\(test.classname)",
                "file": "\(test.file)",
                "invoking_file": "\(test.file)",
                "last_run": "2025-01-15T10:30:00Z"
            }
            """
        }.joined(separator: ",")

        let totalCount = count ?? tests.count

        return """
        {
            "count": \(totalCount),
            "tests": [\(testsJSON)]
        }
        """
    }

    /// Build a JSON string matching the real DisabledTestsAPIResponse format:
    /// { "disabledTests": { "SuiteName.test_name": ["issueNumber", "url", ["platforms"]] } }
    private func makeDisabledTestsJSON(
        tests: [(name: String, issueNumber: String, platforms: [String])] = []
    ) -> String {
        let entries = tests.map { test in
            let platformsArray = test.platforms.map { "\"\($0)\"" }.joined(separator: ",")
            return """
            "\(test.name)": ["\(test.issueNumber)", "https://github.com/pytorch/pytorch/issues/\(test.issueNumber)", [\(platformsArray)]]
            """
        }.joined(separator: ",\n")

        return """
        {
            "disabledTests": {
                \(entries)
            }
        }
        """
    }

    private func registerSearchResponse(
        tests: [(name: String, classname: String, file: String)] = [],
        count: Int? = nil
    ) {
        let json = makeSearchResponseJSON(tests: tests, count: count)
        mockClient.setResponse(json, for: "/api/flaky-tests/search")
    }

    private func registerDisabledResponse(
        tests: [(name: String, issueNumber: String, platforms: [String])] = []
    ) {
        let json = makeDisabledTestsJSON(tests: tests)
        mockClient.setResponse(json, for: "/api/flaky-tests/getDisabledTestsAndJobs")
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(viewModel.searchQuery, "")
        XCTAssertEqual(viewModel.selectedTab, .all)
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.tests.isEmpty)
        XCTAssertNil(viewModel.totalCount)
        XCTAssertTrue(viewModel.disabledTests.isEmpty)
        XCTAssertFalse(viewModel.hasResults)
        XCTAssertFalse(viewModel.hasActiveFilters)
        XCTAssertFalse(viewModel.hasSearchQuery)
        XCTAssertFalse(viewModel.canLoadMore)
    }

    func testLoadInitialDataSetsLoadedState() async {
        // loadInitialData now performs an initial search (with empty filters)
        registerSearchResponse(tests: [
            (name: "test_a", classname: "Suite", file: "test.py"),
        ], count: 1)

        await viewModel.loadInitialData()
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.tests.count, 1)
    }

    func testLoadInitialDataOnlyLoadsOnce() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "Suite", file: "test.py"),
        ], count: 1)

        await viewModel.loadInitialData()
        XCTAssertEqual(viewModel.state, .loaded)

        let callCountAfterFirst = mockClient.callCount

        // Second call should be a no-op because state is no longer .idle
        await viewModel.loadInitialData()
        XCTAssertEqual(mockClient.callCount, callCountAfterFirst)
    }

    // MARK: - Active Filters

    func testHasActiveFiltersWithNameFilter() {
        XCTAssertFalse(viewModel.hasActiveFilters)
        viewModel.nameFilter = "test_add"
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testHasActiveFiltersWithSuiteFilter() {
        viewModel.suiteFilter = "TestNN"
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testHasActiveFiltersWithFileFilter() {
        viewModel.fileFilter = "test_nn.py"
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testActiveFilterSummary() {
        viewModel.nameFilter = "test_add"
        viewModel.suiteFilter = "TestNN"
        XCTAssertEqual(viewModel.activeFilterSummary, "name: test_add, suite: TestNN")
    }

    func testActiveFilterSummaryWithAllFilters() {
        viewModel.nameFilter = "conv"
        viewModel.suiteFilter = "TestNN"
        viewModel.fileFilter = "test_nn.py"
        XCTAssertEqual(viewModel.activeFilterSummary, "name: conv, suite: TestNN, file: test_nn.py")
    }

    func testActiveFilterChips() {
        viewModel.nameFilter = "conv"
        viewModel.fileFilter = "test_nn.py"

        let chips = viewModel.activeFilterChips
        XCTAssertEqual(chips.count, 2)
        XCTAssertEqual(chips[0].label, "name: conv")
        XCTAssertEqual(chips[1].label, "file: test_nn.py")
    }

    // MARK: - Has Search Query

    func testHasSearchQuery() {
        XCTAssertFalse(viewModel.hasSearchQuery)
        viewModel.searchQuery = "  "
        XCTAssertFalse(viewModel.hasSearchQuery)
        viewModel.searchQuery = "test"
        XCTAssertTrue(viewModel.hasSearchQuery)
    }

    // MARK: - Search Functionality

    func testApplyFiltersPerformsSearch() async {
        registerSearchResponse(tests: [
            (name: "test_conv2d", classname: "TestConvNN", file: "test/test_nn.py"),
        ], count: 1)

        viewModel.nameFilter = "conv"
        viewModel.applyFilters()

        // Wait for unstructured Task
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertFalse(viewModel.isShowingFilters)
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.tests.count, 1)
        XCTAssertEqual(viewModel.tests.first?.name, "test_conv2d")
        XCTAssertTrue(viewModel.hasResults)
    }

    func testApplyFiltersSavesRecentSearch() async {
        registerSearchResponse(tests: [
            (name: "test_add", classname: "TestOps", file: "test/test_ops.py"),
        ])

        viewModel.nameFilter = "test_add"
        viewModel.applyFilters()

        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertFalse(viewModel.recentSearches.isEmpty)
        XCTAssertEqual(viewModel.recentSearches.first?.name, "test_add")
    }

    func testSearchErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/flaky-tests/search")

        viewModel.nameFilter = "conv"
        viewModel.applyFilters()

        try? await Task.sleep(nanoseconds: 300_000_000)

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testRefreshResetsPageAndSearches() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "Suite", file: "test.py"),
        ], count: 1)

        viewModel.currentPage = 3
        await viewModel.refresh()

        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Clear Filters

    func testClearFiltersResetsAllState() {
        viewModel.nameFilter = "test_add"
        viewModel.suiteFilter = "Suite"
        viewModel.fileFilter = "test.py"
        viewModel.searchQuery = "query"
        viewModel.currentPage = 3

        viewModel.clearFilters()

        XCTAssertTrue(viewModel.nameFilter.isEmpty)
        XCTAssertTrue(viewModel.suiteFilter.isEmpty)
        XCTAssertTrue(viewModel.fileFilter.isEmpty)
        XCTAssertTrue(viewModel.searchQuery.isEmpty)
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.tests.isEmpty)
        XCTAssertTrue(viewModel.disabledTests.isEmpty)
        XCTAssertNil(viewModel.totalCount)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Remove Individual Filter

    func testRemoveFilterRemovesNameFilter() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "Suite", file: "test.py"),
        ], count: 1)

        viewModel.nameFilter = "test"
        viewModel.suiteFilter = "Suite"

        viewModel.removeFilter(.name)

        XCTAssertTrue(viewModel.nameFilter.isEmpty)
        XCTAssertEqual(viewModel.suiteFilter, "Suite")
        // Still has active filters, so it should trigger a search
        XCTAssertTrue(viewModel.hasActiveFilters)
    }

    func testRemoveLastFilterClearsAll() {
        viewModel.nameFilter = "test"

        viewModel.removeFilter(.name)

        // When last filter is removed, clearFilters is called
        XCTAssertFalse(viewModel.hasActiveFilters)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Tab Switching

    func testTabSwitchClearsOldData() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "Suite", file: "test.py"),
        ], count: 1)

        // Manually set some data
        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(viewModel.tests.isEmpty)

        // Switch to disabled tab - old tests should be cleared
        registerDisabledResponse(tests: [
            (name: "Suite.disabled_test", issueNumber: "123", platforms: ["linux"]),
        ])
        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()

        // Tests should be cleared immediately
        XCTAssertTrue(viewModel.tests.isEmpty)
        XCTAssertNil(viewModel.totalCount)
        XCTAssertEqual(viewModel.currentPage, 1)
    }

    func testTabSwitchToDisabledFetchesDisabledTests() async {
        registerDisabledResponse(tests: [
            (name: "Suite1.test_broken", issueNumber: "100", platforms: ["linux"]),
            (name: "Suite2.test_flaky", issueNumber: "200", platforms: ["mac"]),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()

        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.disabledTests.count, 2)
        XCTAssertTrue(viewModel.hasResults)
    }

    func testHasResultsForDisabledTab() async {
        viewModel.selectedTab = .disabled
        XCTAssertFalse(viewModel.hasResults)

        registerDisabledResponse(tests: [
            (name: "Suite.test_x", issueNumber: "999", platforms: []),
        ])
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertTrue(viewModel.hasResults)
    }

    // MARK: - Disabled Tests Local Filtering

    func testDisabledTestsFilteredBySearchQuery() async {
        registerDisabledResponse(tests: [
            (name: "TestConv.test_conv2d", issueNumber: "100", platforms: ["linux"]),
            (name: "TestLinear.test_linear", issueNumber: "200", platforms: ["linux"]),
            (name: "TestConv.test_conv3d", issueNumber: "300", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // All 3 should be loaded
        XCTAssertEqual(viewModel.disabledTests.count, 3)

        // Now filter by search query
        viewModel.searchQuery = "conv"
        viewModel.onSearchQueryChanged()
        try? await Task.sleep(nanoseconds: 600_000_000)

        // Only conv tests should match
        XCTAssertEqual(viewModel.disabledTests.count, 2)
        XCTAssertTrue(viewModel.disabledTests.allSatisfy {
            $0.testName.lowercased().contains("conv")
        })
    }

    func testDisabledTestsFilteredByAdvancedSuiteFilter() async {
        registerDisabledResponse(tests: [
            (name: "TestConv.test_conv2d", issueNumber: "100", platforms: []),
            (name: "TestLinear.test_linear", issueNumber: "200", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.disabledTests.count, 2)

        // Apply suite filter
        viewModel.suiteFilter = "TestLinear"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.disabledTests.count, 1)
        XCTAssertEqual(viewModel.disabledTests.first?.suiteName, "TestLinear")
    }

    func testDisabledTestsClearSearchRestoresAll() async {
        registerDisabledResponse(tests: [
            (name: "TestA.test_a", issueNumber: "1", platforms: []),
            (name: "TestB.test_b", issueNumber: "2", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // Filter down
        viewModel.searchQuery = "test_a"
        viewModel.onSearchQueryChanged()
        try? await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(viewModel.disabledTests.count, 1)

        // Clear search - should show all again
        viewModel.searchQuery = ""
        viewModel.onSearchQueryChanged()
        try? await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(viewModel.disabledTests.count, 2)
    }

    // MARK: - Pagination

    func testPaginationUpdatesPage() async {
        registerSearchResponse(tests: [
            (name: "test_page2", classname: "Suite", file: "test.py"),
        ], count: 200)

        viewModel.onPageChanged(2)

        XCTAssertEqual(viewModel.currentPage, 2)

        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.tests.count, 1)
        XCTAssertEqual(viewModel.tests.first?.name, "test_page2")
    }

    func testCanLoadMoreWhenMorePagesExist() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
        ], count: 200)

        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // 200 total / 100 per page = 2 pages, we're on page 1
        XCTAssertTrue(viewModel.canLoadMore)
    }

    func testCannotLoadMoreOnLastPage() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
        ], count: 1)

        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // Only 1 result, no more pages
        XCTAssertFalse(viewModel.canLoadMore)
    }

    func testTotalPagesComputation() {
        viewModel.totalCount = 250
        // 250 / 100 = 3 pages (ceil)
        XCTAssertEqual(viewModel.totalPages, 3)
    }

    func testTotalPagesWithPartialPage() {
        viewModel.totalCount = 101
        // 101 / 100 = 2 pages (ceil)
        XCTAssertEqual(viewModel.totalPages, 2)
    }

    func testTotalPagesIsNilWhenNoTotalCount() {
        XCTAssertNil(viewModel.totalPages)
    }

    func testTotalPagesWithZeroCount() {
        viewModel.totalCount = 0
        // max(1, ceil(0/100)) = 1
        XCTAssertEqual(viewModel.totalPages, 1)
    }

    // MARK: - Result Count Text

    func testResultCountTextNilInNonLoadedState() {
        XCTAssertNil(viewModel.resultCountText)
    }

    func testResultCountTextForAllTestsTab() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
            (name: "test_b", classname: "S", file: "t.py"),
        ], count: 2)

        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        let text = viewModel.resultCountText
        XCTAssertNotNil(text)
        XCTAssertEqual(text, "2 results")
    }

    func testResultCountTextShowsPartialCount() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
        ], count: 500)

        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        let text = viewModel.resultCountText
        XCTAssertNotNil(text)
        XCTAssertTrue(text?.contains("Showing 1 of 500") == true)
    }

    func testResultCountTextForDisabledTab() async {
        registerDisabledResponse(tests: [
            (name: "S.test_a", issueNumber: "1", platforms: []),
            (name: "S.test_b", issueNumber: "2", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        let text = viewModel.resultCountText
        XCTAssertNotNil(text)
        XCTAssertEqual(text, "2 disabled tests")
    }

    func testResultCountTextSingularForm() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
        ], count: 1)

        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.resultCountText, "1 result")
    }

    func testResultCountTextNilWhenNoResults() async {
        registerSearchResponse(tests: [], count: 0)

        viewModel.nameFilter = "nonexistent"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertNil(viewModel.resultCountText)
    }

    func testResultCountTextForFilteredDisabledTests() async {
        registerDisabledResponse(tests: [
            (name: "TestA.test_a", issueNumber: "1", platforms: []),
            (name: "TestB.test_b", issueNumber: "2", platforms: []),
            (name: "TestA.test_c", issueNumber: "3", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // Filter down
        viewModel.searchQuery = "test_a"
        viewModel.onSearchQueryChanged()
        try? await Task.sleep(nanoseconds: 600_000_000)

        let text = viewModel.resultCountText
        XCTAssertNotNil(text)
        XCTAssertTrue(text?.contains("1 of 3") == true)
    }

    // MARK: - Recent Searches

    func testApplyRecentSearchSetsFilters() {
        let search = RecentSearch(
            name: "conv",
            suite: "TestNN",
            file: nil,
            timestamp: Date()
        )

        registerSearchResponse(tests: [])
        viewModel.applyRecentSearch(search)

        XCTAssertEqual(viewModel.nameFilter, "conv")
        XCTAssertEqual(viewModel.suiteFilter, "TestNN")
        XCTAssertTrue(viewModel.fileFilter.isEmpty)
        XCTAssertEqual(viewModel.currentPage, 1)
    }

    func testRemoveRecentSearch() {
        let search = RecentSearch(
            name: "conv",
            suite: nil,
            file: nil,
            timestamp: Date()
        )

        viewModel.recentSearches = [search]
        XCTAssertEqual(viewModel.recentSearches.count, 1)

        viewModel.removeRecentSearch(search)
        XCTAssertTrue(viewModel.recentSearches.isEmpty)
    }

    // MARK: - Format Relative Time

    func testFormatRelativeTimeWithISO8601() {
        // Create a date string 2 hours ago
        let twoHoursAgo = Date().addingTimeInterval(-7200)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: twoHoursAgo)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertNotNil(result)
        XCTAssertEqual(result, "2h ago")
    }

    func testFormatRelativeTimeWithMinutes() {
        let thirtyMinutesAgo = Date().addingTimeInterval(-1800)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: thirtyMinutesAgo)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertNotNil(result)
        XCTAssertEqual(result, "30m ago")
    }

    func testFormatRelativeTimeWithDays() {
        let threeDaysAgo = Date().addingTimeInterval(-259200)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: threeDaysAgo)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertNotNil(result)
        XCTAssertEqual(result, "3d ago")
    }

    func testFormatRelativeTimeWithWeeks() {
        let twoWeeksAgo = Date().addingTimeInterval(-1209600)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: twoWeeksAgo)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertNotNil(result)
        XCTAssertEqual(result, "2w ago")
    }

    func testFormatRelativeTimeJustNow() {
        let justNow = Date().addingTimeInterval(-30)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: justNow)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertEqual(result, "just now")
    }

    func testFormatRelativeTimeWithInvalidString() {
        let result = TestSearchViewModel.formatRelativeTime("not-a-date")
        XCTAssertNil(result)
    }

    func testFormatRelativeTimeWithSimpleDateFormat() {
        // Test the yyyy-MM-dd'T'HH:mm:ss fallback format
        let twoHoursAgo = Date().addingTimeInterval(-7200)
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        df.timeZone = TimeZone(identifier: "UTC")
        let dateString = df.string(from: twoHoursAgo)

        let result = TestSearchViewModel.formatRelativeTime(dateString)
        XCTAssertNotNil(result)
        XCTAssertTrue(result?.contains("h ago") == true)
    }

    // MARK: - Recent Search Model

    func testRecentSearchDisplayTextWithAllFields() {
        let search = RecentSearch(name: "conv", suite: "TestNN", file: "test.py", timestamp: Date())
        XCTAssertEqual(search.displayText, "conv \u{2022} TestNN \u{2022} test.py")
    }

    func testRecentSearchDisplayTextWithPartialFields() {
        let search = RecentSearch(name: "conv", suite: nil, file: nil, timestamp: Date())
        XCTAssertEqual(search.displayText, "conv")
    }

    func testRecentSearchDisplayTextEmpty() {
        let search = RecentSearch(name: nil, suite: nil, file: nil, timestamp: Date())
        XCTAssertEqual(search.displayText, "Empty search")
    }

    func testRecentSearchMatches() {
        let search1 = RecentSearch(name: "conv", suite: "TestNN", file: nil, timestamp: Date())
        let search2 = RecentSearch(name: "conv", suite: "TestNN", file: nil, timestamp: Date())
        let search3 = RecentSearch(name: "conv", suite: nil, file: nil, timestamp: Date())

        XCTAssertTrue(search1.matches(search2))
        XCTAssertFalse(search1.matches(search3))
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(TestSearchViewModel.ViewState.idle, .idle)
        XCTAssertEqual(TestSearchViewModel.ViewState.loading, .loading)
        XCTAssertEqual(TestSearchViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(TestSearchViewModel.ViewState.error("msg"), .error("msg"))
        XCTAssertNotEqual(TestSearchViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(TestSearchViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(TestSearchViewModel.ViewState.loading, .loaded)
    }

    // MARK: - TestTab

    func testTestTabDescription() {
        XCTAssertEqual(TestSearchViewModel.TestTab.all.description, "All Tests")
        XCTAssertEqual(TestSearchViewModel.TestTab.disabled.description, "Disabled Tests")
    }

    func testTestTabAllCases() {
        XCTAssertEqual(TestSearchViewModel.TestTab.allCases.count, 2)
    }

    // MARK: - FilterType

    func testFilterTypePlaceholders() {
        XCTAssertFalse(TestSearchViewModel.FilterType.name.placeholder.isEmpty)
        XCTAssertFalse(TestSearchViewModel.FilterType.suite.placeholder.isEmpty)
        XCTAssertFalse(TestSearchViewModel.FilterType.file.placeholder.isEmpty)
    }

    // MARK: - Edge Cases

    func testApplyFiltersWithWhitespaceOnly() async {
        viewModel.nameFilter = "   "
        viewModel.suiteFilter = "\t"
        viewModel.fileFilter = "  \n  "

        // hasActiveFilters checks for isEmpty, not trimmed
        XCTAssertTrue(viewModel.hasActiveFilters)

        registerSearchResponse(tests: [], count: 0)
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // The search should still proceed (the VM trims internally)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadMoreIncreasesPage() async {
        registerSearchResponse(tests: [
            (name: "test_a", classname: "S", file: "t.py"),
        ], count: 200)

        // First page
        viewModel.nameFilter = "test"
        viewModel.applyFilters()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertTrue(viewModel.canLoadMore)
        XCTAssertEqual(viewModel.currentPage, 1)

        // Load more
        viewModel.loadMore()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(viewModel.currentPage, 2)
    }

    func testLoadMoreWhenCannotLoadMoreIsNoOp() {
        viewModel.canLoadMore = false
        viewModel.currentPage = 1

        viewModel.loadMore()

        // Page should not have changed
        XCTAssertEqual(viewModel.currentPage, 1)
    }

    func testDisabledTestsCanLoadMoreIsFalse() async {
        registerDisabledResponse(tests: [
            (name: "S.test_a", issueNumber: "1", platforms: []),
        ])

        viewModel.selectedTab = .disabled
        viewModel.onTabChanged()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // Disabled tests don't paginate
        XCTAssertFalse(viewModel.canLoadMore)
    }
}
