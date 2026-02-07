import Foundation

@MainActor
final class DisabledTestsViewModel: ObservableObject {
    // MARK: - State

    enum ViewState: Equatable {
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case (.error(let a), .error(let b)): return a == b
            default: return false
            }
        }
    }

    enum SortOption: String, CaseIterable, Identifiable {
        case highPriority = "High Priority"
        case newest = "Newest"
        case oldest = "Oldest"
        case platform = "Platform"

        var id: String { rawValue }
    }

    enum TriagedFilter: String, CaseIterable, Identifiable {
        case both = "All"
        case yes = "Triaged"
        case no = "Untriaged"

        var id: String { rawValue }
    }

    /// A group of disabled tests belonging to the same suite.
    struct SuiteGroup: Identifiable {
        let suiteName: String
        let tests: [DisabledTest]

        var id: String { suiteName }
    }

    @Published var state: ViewState = .loading
    @Published var allTests: [DisabledTest] = []
    @Published var historicalData: [DisabledTestHistoricalData] = []
    @Published var platformFilter: String = "All"
    @Published var triagedFilter: TriagedFilter = .both
    @Published var sortOption: SortOption = .highPriority
    @Published var searchQuery: String = ""
    @Published var groupBySuite: Bool = false

    // MARK: - Computed Properties

    var filteredTests: [DisabledTest] {
        var results = allTests

        // Platform filter
        if platformFilter != "All" {
            results = results.filter { test in
                test.platforms?.contains(where: {
                    $0.lowercased() == platformFilter.lowercased()
                }) ?? false
            }
        }

        // Triaged filter
        switch triagedFilter {
        case .yes:
            results = results.filter { $0.isTriaged }
        case .no:
            results = results.filter { !$0.isTriaged }
        case .both:
            break
        }

        // Search filter - supports test name, suite, assignee, issue number, and platform
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !query.isEmpty {
            results = results.filter { test in
                test.testName.lowercased().contains(query) ||
                (test.suiteName?.lowercased().contains(query) ?? false) ||
                (test.assignee?.lowercased().contains(query) ?? false) ||
                matchesIssueNumber(test: test, query: query) ||
                matchesPlatform(test: test, query: query)
            }
        }

        // Sort
        results = sortTests(results)

        return results
    }

    /// Returns the filtered tests grouped by suite name, sorted alphabetically by suite.
    var groupedTests: [SuiteGroup] {
        var groups: [String: [DisabledTest]] = [:]
        for test in filteredTests {
            let suite = test.suiteName ?? "Unknown Suite"
            groups[suite, default: []].append(test)
        }
        return groups.map { SuiteGroup(suiteName: $0.key, tests: $0.value) }
            .sorted { $0.suiteName < $1.suiteName }
    }

    /// Returns the set of unique suite names across all tests (unfiltered).
    var availableSuites: [String] {
        var suites = Set<String>()
        for test in allTests {
            if let suite = test.suiteName {
                suites.insert(suite)
            }
        }
        return suites.sorted()
    }

    var availablePlatforms: [String] {
        var platforms = Set<String>()
        for test in allTests {
            test.platforms?.forEach { platforms.insert($0) }
        }
        return ["All"] + platforms.sorted()
    }

    var totalCount: Int {
        allTests.count
    }

    var triagedCount: Int {
        allTests.filter { $0.isTriaged }.count
    }

    var untriagedCount: Int {
        allTests.filter { !$0.isTriaged }.count
    }

    var highPriorityCount: Int {
        allTests.filter { $0.isHighPriority }.count
    }

    var currentCount: Int? {
        historicalData.last?.count
    }

    var trend: Int? {
        guard historicalData.count >= 2 else { return nil }
        let current = historicalData.last?.count ?? 0
        let previous = historicalData[historicalData.count - 2].count
        return current - previous
    }

    /// Returns a summary string for the active filters.
    var activeFilterDescription: String? {
        var parts: [String] = []
        if platformFilter != "All" { parts.append(platformFilter) }
        if triagedFilter != .both { parts.append(triagedFilter.rawValue) }
        if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("\"\(searchQuery.trimmingCharacters(in: .whitespacesAndNewlines))\"")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " + ")
    }

    /// Whether any filters are currently active.
    var hasActiveFilters: Bool {
        platformFilter != "All" || triagedFilter != .both ||
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Private

    private let apiClient: APIClientProtocol

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Data Loading

    func loadDisabledTests() async {
        state = .loading

        do {
            // Load detailed test data from clickhouse
            // Note: The ClickHouse API returns a flat array, not wrapped in {data: [...]}.
            // The disabled_tests params.json only allows: state, platform, label, triaged
            // (no repo param needed -- the query already filters by pytorch/pytorch in the SQL).
            let timeRange = APIEndpoint.timeRange(days: 180)
            let response: DisabledTestDetailsResponse = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "disabled_tests",
                    parameters: [
                        "state": "open",
                        "platform": "",
                        "label": "skipped",
                        "triaged": ""
                    ]
                )
            )

            self.allTests = response.map { detail in
                DisabledTest(
                    testName: detail.name,
                    issueNumber: detail.number,
                    issueUrl: detail.htmlUrl,
                    platforms: extractPlatforms(from: detail.body),
                    assignee: detail.assignee?.isEmpty == true ? nil : detail.assignee,
                    updatedAt: detail.updatedAt,
                    labels: detail.labels,
                    body: detail.body
                )
            }

            // Load historical trend data
            let historicalResponse: DisabledTestHistoricalResponse = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "disabled_test_historical",
                    parameters: [
                        "startTime": timeRange.startTime,
                        "stopTime": timeRange.stopTime,
                        "platform": "",
                        "label": "skipped",
                        "triaged": ""
                    ]
                )
            )
            self.historicalData = historicalResponse

            self.state = .loaded
        } catch {
            self.state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        do {
            // Load detailed test data from clickhouse
            let timeRange = APIEndpoint.timeRange(days: 180)
            let response: DisabledTestDetailsResponse = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "disabled_tests",
                    parameters: [
                        "state": "open",
                        "platform": "",
                        "label": "skipped",
                        "triaged": ""
                    ]
                )
            )

            self.allTests = response.map { detail in
                DisabledTest(
                    testName: detail.name,
                    issueNumber: detail.number,
                    issueUrl: detail.htmlUrl,
                    platforms: extractPlatforms(from: detail.body),
                    assignee: detail.assignee?.isEmpty == true ? nil : detail.assignee,
                    updatedAt: detail.updatedAt,
                    labels: detail.labels,
                    body: detail.body
                )
            }

            // Load historical trend data
            let historicalResponse: DisabledTestHistoricalResponse = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "disabled_test_historical",
                    parameters: [
                        "startTime": timeRange.startTime,
                        "stopTime": timeRange.stopTime,
                        "platform": "",
                        "label": "skipped",
                        "triaged": ""
                    ]
                )
            )
            self.historicalData = historicalResponse

            self.state = .loaded
        } catch {
            self.state = .error(error.localizedDescription)
        }
    }

    // MARK: - Actions

    func clearFilters() {
        platformFilter = "All"
        triagedFilter = .both
        searchQuery = ""
        sortOption = .highPriority
    }

    func issueURL(for test: DisabledTest) -> URL? {
        guard let urlString = test.issueUrl else { return nil }
        return URL(string: urlString)
    }

    // MARK: - Helpers

    private func matchesIssueNumber(test: DisabledTest, query: String) -> Bool {
        guard let issueNumber = test.issueNumber else { return false }
        let cleaned = query.hasPrefix("#") ? String(query.dropFirst()) : query
        return String(issueNumber).contains(cleaned)
    }

    private func matchesPlatform(test: DisabledTest, query: String) -> Bool {
        test.platforms?.contains(where: { $0.lowercased().contains(query) }) ?? false
    }

    private func sortTests(_ tests: [DisabledTest]) -> [DisabledTest] {
        var results = tests
        switch sortOption {
        case .highPriority:
            results.sort { lhs, rhs in
                if lhs.isHighPriority != rhs.isHighPriority {
                    return lhs.isHighPriority
                }
                return (lhs.updatedAt ?? "") > (rhs.updatedAt ?? "")
            }
        case .newest:
            results.sort { (lhs, rhs) in
                (lhs.updatedAt ?? "") > (rhs.updatedAt ?? "")
            }
        case .oldest:
            results.sort { (lhs, rhs) in
                (lhs.updatedAt ?? "") < (rhs.updatedAt ?? "")
            }
        case .platform:
            results.sort { lhs, rhs in
                let lhsPlatform = lhs.platforms?.first ?? ""
                let rhsPlatform = rhs.platforms?.first ?? ""
                return lhsPlatform < rhsPlatform
            }
        }
        return results
    }

    private func extractPlatforms(from body: String) -> [String]? {
        // The disabled test body contains platforms in a specific format
        // This is a simplified extraction - in production you'd parse the actual format
        let platforms = ["linux", "mac", "win", "rocm", "asan", "dynamo", "inductor", "slow", "xpu"]
        let found = platforms.filter { body.lowercased().contains($0) }
        return found.isEmpty ? nil : found
    }
}
