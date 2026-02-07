import Foundation
import Combine

@MainActor
final class TestSearchViewModel: ObservableObject {
    // MARK: - State

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle): return true
            case (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case (.error(let a), .error(let b)): return a == b
            default: return false
            }
        }
    }

    enum TestTab: String, CaseIterable, CustomStringConvertible, Hashable {
        case all = "All Tests"
        case disabled = "Disabled Tests"

        var description: String { rawValue }
    }

    enum FilterType: String, CaseIterable, Identifiable {
        case name = "Test Name"
        case suite = "Test Suite"
        case file = "Test File"

        var id: String { rawValue }
        var placeholder: String {
            switch self {
            case .name: return "e.g. test_conv2d_backward_gpu"
            case .suite: return "e.g. TestConvolutionNN"
            case .file: return "e.g. test_nn.py"
            }
        }
    }

    @Published var state: ViewState = .idle
    @Published var searchQuery: String = ""
    @Published var selectedTab: TestTab = .all
    @Published var currentPage: Int = 1
    @Published var isShowingFilters: Bool = false

    // Advanced filter fields
    @Published var nameFilter: String = ""
    @Published var suiteFilter: String = ""
    @Published var fileFilter: String = ""

    @Published var tests: [TestResult] = []
    @Published var totalCount: Int?
    @Published var disabledTests: [DisabledTest] = []
    @Published var recentSearches: [RecentSearch] = []
    @Published var canLoadMore: Bool = false

    // All disabled tests before filtering (for local search)
    private var allDisabledTests: [DisabledTest] = []

    var totalPages: Int? {
        guard let total = totalCount else { return nil }
        let perPage = 100
        return max(1, Int(ceil(Double(total) / Double(perPage))))
    }

    var hasResults: Bool {
        if selectedTab == .disabled {
            return !disabledTests.isEmpty
        }
        return !tests.isEmpty
    }

    var hasActiveFilters: Bool {
        !nameFilter.isEmpty || !suiteFilter.isEmpty || !fileFilter.isEmpty
    }

    var hasSearchQuery: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var activeFilterSummary: String {
        var parts: [String] = []
        if !nameFilter.isEmpty { parts.append("name: \(nameFilter)") }
        if !suiteFilter.isEmpty { parts.append("suite: \(suiteFilter)") }
        if !fileFilter.isEmpty { parts.append("file: \(fileFilter)") }
        return parts.joined(separator: ", ")
    }

    /// Formatted result count for display in the UI
    var resultCountText: String? {
        guard state == .loaded else { return nil }

        if selectedTab == .disabled {
            let filtered = disabledTests.count
            let total = allDisabledTests.count
            if hasSearchQuery && total > 0 {
                return "\(filtered) of \(total) disabled tests"
            } else if filtered > 0 {
                return "\(filtered) disabled test\(filtered == 1 ? "" : "s")"
            }
            return nil
        }

        guard let total = totalCount else { return nil }
        if total == 0 { return nil }

        let showing = tests.count
        if showing < total {
            return "Showing \(showing) of \(formatCount(total))"
        }
        return "\(formatCount(total)) result\(total == 1 ? "" : "s")"
    }

    /// Active filter chips for display
    var activeFilterChips: [(label: String, field: FilterField)] {
        var chips: [(label: String, field: FilterField)] = []
        if !nameFilter.isEmpty { chips.append((label: "name: \(nameFilter)", field: .name)) }
        if !suiteFilter.isEmpty { chips.append((label: "suite: \(suiteFilter)", field: .suite)) }
        if !fileFilter.isEmpty { chips.append((label: "file: \(fileFilter)", field: .file)) }
        return chips
    }

    enum FilterField {
        case name, suite, file
    }

    // MARK: - Private

    private let apiClient: APIClientProtocol
    private var searchTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private let recentSearchesKey = "test_search_recent_searches"
    private let maxRecentSearches = 5

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
        loadRecentSearches()
    }

    // MARK: - Search

    func onSearchQueryChanged() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            guard !Task.isCancelled else { return }
            guard let self else { return }

            if self.selectedTab == .disabled {
                // Filter locally for disabled tests
                self.filterDisabledTests()
            } else {
                self.currentPage = 1
                await self.performSearch()
            }
        }
    }

    func onTabChanged() {
        currentPage = 1
        tests = []
        disabledTests = []
        allDisabledTests = []
        totalCount = nil

        Task {
            await performSearch()
        }
    }

    func onPageChanged(_ page: Int) {
        currentPage = page
        Task {
            await performSearch()
        }
    }

    func loadMore() {
        guard canLoadMore else { return }
        currentPage += 1
        Task {
            await performSearch(append: true)
        }
    }

    func refresh() async {
        currentPage = 1
        allDisabledTests = []
        await performSearch()
    }

    func loadInitialData() async {
        guard state == .idle else { return }
        // Load an initial page of test results (all tests, no filter) so
        // the view isn't empty on first appearance.  The web version also
        // fetches results immediately with empty search params.
        if selectedTab == .disabled {
            await performSearch()
        } else {
            await performSearch()
        }
    }

    func applyFilters() {
        isShowingFilters = false
        currentPage = 1

        // Save to recent searches if filters are applied
        if hasActiveFilters {
            saveRecentSearch()
        }

        Task {
            await performSearch()
        }
    }

    func clearFilters() {
        nameFilter = ""
        suiteFilter = ""
        fileFilter = ""
        searchQuery = ""
        currentPage = 1
        tests = []
        disabledTests = []
        allDisabledTests = []
        totalCount = nil
        state = .loaded
    }

    /// Remove a single filter chip
    func removeFilter(_ field: FilterField) {
        switch field {
        case .name: nameFilter = ""
        case .suite: suiteFilter = ""
        case .file: fileFilter = ""
        }

        if hasActiveFilters {
            currentPage = 1
            Task { await performSearch() }
        } else {
            clearFilters()
        }
    }

    func applyRecentSearch(_ search: RecentSearch) {
        nameFilter = search.name ?? ""
        suiteFilter = search.suite ?? ""
        fileFilter = search.file ?? ""
        searchQuery = [search.name, search.suite, search.file]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        currentPage = 1

        Task {
            await performSearch()
        }
    }

    func removeRecentSearch(_ search: RecentSearch) {
        recentSearches.removeAll { $0.id == search.id }
        saveRecentSearchesToDisk()
    }

    // MARK: - Private Search Logic

    private func performSearch(append: Bool = false) async {
        searchTask?.cancel()

        let task = Task { [weak self] in
            guard let self else { return }

            if !append {
                self.state = .loading
            }

            do {
                if self.selectedTab == .disabled {
                    try await self.fetchDisabledTests()
                } else {
                    try await self.fetchSearchResults(append: append)
                }
                guard !Task.isCancelled else { return }
                self.state = .loaded
            } catch {
                guard !Task.isCancelled else { return }
                self.state = .error(error.localizedDescription)
            }
        }
        searchTask = task
        await task.value
    }

    private func fetchSearchResults(append: Bool) async throws {
        let name = nameFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        let suite = suiteFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        let file = fileFilter.trimmingCharacters(in: .whitespacesAndNewlines)

        // Build endpoint with all filters
        let endpoint: APIEndpoint = .searchTests(
            name: name.isEmpty ? nil : name,
            suite: suite.isEmpty ? nil : suite,
            file: file.isEmpty ? nil : file,
            page: currentPage
        )

        let response: TestSearchResponse = try await apiClient.fetch(endpoint)
        guard !Task.isCancelled else { return }

        if append {
            self.tests.append(contentsOf: response.tests)
        } else {
            self.tests = response.tests
        }
        self.totalCount = response.count

        // Update canLoadMore flag
        let perPage = 100
        let totalPages = max(1, Int(ceil(Double(response.count) / Double(perPage))))
        self.canLoadMore = currentPage < totalPages
    }

    private func fetchDisabledTests() async throws {
        let response: DisabledTestsAPIResponse = try await apiClient.fetch(.disabledTests())
        guard !Task.isCancelled else { return }

        // Convert the dictionary response into our array of DisabledTest
        let allTests = response.disabledTests.map { (testName, entry) in
            DisabledTest(
                testName: testName,
                issueNumber: Int(entry.issueNumber),
                issueUrl: entry.issueUrl,
                platforms: entry.platforms.isEmpty ? nil : entry.platforms,
                assignee: nil,
                updatedAt: nil,
                labels: nil,
                body: nil
            )
        }.sorted { $0.testName.localizedCaseInsensitiveCompare($1.testName) == .orderedAscending }

        self.allDisabledTests = allTests
        filterDisabledTests()
    }

    /// Filter disabled tests locally based on search query and advanced filters
    private func filterDisabledTests() {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let nameQ = nameFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let suiteQ = suiteFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let hasFilters = !query.isEmpty || !nameQ.isEmpty || !suiteQ.isEmpty

        if !hasFilters {
            self.disabledTests = allDisabledTests
        } else {
            self.disabledTests = allDisabledTests.filter { test in
                var matches = true

                // Inline search query matches test name or suite name
                if !query.isEmpty {
                    let nameMatch = test.testName.lowercased().contains(query)
                    let suiteMatch = test.suiteName?.lowercased().contains(query) ?? false
                    matches = matches && (nameMatch || suiteMatch)
                }

                // Advanced filter: name
                if !nameQ.isEmpty {
                    matches = matches && test.parsedTestName.lowercased().contains(nameQ)
                }

                // Advanced filter: suite
                if !suiteQ.isEmpty {
                    matches = matches && (test.suiteName?.lowercased().contains(suiteQ) ?? false)
                }

                return matches
            }
        }

        self.totalCount = nil
        self.canLoadMore = false
        self.state = .loaded
    }

    // MARK: - Formatting

    private func formatCount(_ count: Int) -> String {
        if count >= 1000 {
            let k = Double(count) / 1000.0
            return String(format: "%.1fk", k)
        }
        return "\(count)"
    }

    /// Format an ISO 8601 date string into a relative time like "2h ago"
    static func formatRelativeTime(_ dateString: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var date = formatter.date(from: dateString)
        if date == nil {
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: dateString)
        }
        if date == nil {
            // Try simple date format
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
            df.timeZone = TimeZone(identifier: "UTC")
            date = df.date(from: dateString)
        }

        guard let parsedDate = date else { return nil }

        let now = Date()
        let interval = now.timeIntervalSince(parsedDate)

        if interval < 60 {
            return "just now"
        } else if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes)m ago"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h ago"
        } else if interval < 604800 {
            let days = Int(interval / 86400)
            return "\(days)d ago"
        } else {
            let weeks = Int(interval / 604800)
            return "\(weeks)w ago"
        }
    }

    // MARK: - Recent Searches

    private func saveRecentSearch() {
        let search = RecentSearch(
            name: nameFilter.isEmpty ? nil : nameFilter,
            suite: suiteFilter.isEmpty ? nil : suiteFilter,
            file: fileFilter.isEmpty ? nil : fileFilter,
            timestamp: Date()
        )

        // Remove duplicate if exists
        recentSearches.removeAll { $0.matches(search) }

        // Add to front
        recentSearches.insert(search, at: 0)

        // Keep only max recent searches
        if recentSearches.count > maxRecentSearches {
            recentSearches = Array(recentSearches.prefix(maxRecentSearches))
        }

        saveRecentSearchesToDisk()
    }

    private func loadRecentSearches() {
        guard let data = UserDefaults.standard.data(forKey: recentSearchesKey),
              let searches = try? JSONDecoder().decode([RecentSearch].self, from: data) else {
            return
        }
        recentSearches = searches
    }

    private func saveRecentSearchesToDisk() {
        guard let data = try? JSONEncoder().encode(recentSearches) else { return }
        UserDefaults.standard.set(data, forKey: recentSearchesKey)
    }
}

// MARK: - Recent Search Model

struct RecentSearch: Codable, Identifiable {
    let id: UUID
    let name: String?
    let suite: String?
    let file: String?
    let timestamp: Date

    init(id: UUID = UUID(), name: String?, suite: String?, file: String?, timestamp: Date) {
        self.id = id
        self.name = name
        self.suite = suite
        self.file = file
        self.timestamp = timestamp
    }

    var displayText: String {
        let parts = [name, suite, file].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? "Empty search" : parts.joined(separator: " \u{2022} ")
    }

    func matches(_ other: RecentSearch) -> Bool {
        name == other.name && suite == other.suite && file == other.file
    }
}
