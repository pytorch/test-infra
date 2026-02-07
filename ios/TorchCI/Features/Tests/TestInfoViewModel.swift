import Foundation

@MainActor
final class TestInfoViewModel: ObservableObject {
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

    enum BranchFilter: String, CaseIterable {
        case all = "All Branches"
        case main = "main"
    }

    @Published var state: ViewState = .loading
    @Published var failures: [TestFailure] = []
    @Published var trendPoints: [TestTrendPoint] = []
    @Published var expandedFailures: Set<String> = []
    @Published var branchFilter: BranchFilter = .all

    // MARK: - Config

    let testName: String
    let testSuite: String
    let testFile: String

    private let apiClient: APIClientProtocol

    // MARK: - Computed Properties

    var totalFailures: String {
        "\(failures.count)"
    }

    var recentFailures: [TestFailure] {
        let filtered: [TestFailure]
        switch branchFilter {
        case .all:
            filtered = failures
        case .main:
            filtered = failures.filter { $0.branch == "main" }
        }
        return Array(filtered.prefix(50))
    }

    var flakinessScore: Double? {
        guard !trendPoints.isEmpty else { return nil }
        let totalRuns = trendPoints.reduce(0) { $0 + $1.total }
        let totalFailed = trendPoints.reduce(0) { $0 + $1.failed + $1.flaky }
        guard totalRuns > 0 else { return nil }
        return Double(totalFailed) / Double(totalRuns)
    }

    var flakinessPercentage: String? {
        guard let score = flakinessScore else { return nil }
        return String(format: "%.1f%%", score * 100)
    }

    /// Total runs across all trend points in the 3-day window
    var totalRuns: Int {
        trendPoints.reduce(0) { $0 + $1.total }
    }

    /// Pass rate as a formatted percentage string
    var passRate: String? {
        guard totalRuns > 0 else { return nil }
        let totalSuccess = trendPoints.reduce(0) { $0 + $1.success }
        let rate = Double(totalSuccess) / Double(totalRuns) * 100
        return String(format: "%.1f%%", rate)
    }

    /// Overall test status based on failures and flakiness
    var testStatus: TestStatus {
        if let score = flakinessScore {
            if score >= 0.5 {
                return .failing
            } else if score > 0.0 {
                return .flaky
            }
        }
        if !failures.isEmpty {
            return .flaky
        }
        return .passing
    }

    /// Unique branches across all failures
    var failureBranches: [String] {
        let branches = Set(failures.compactMap(\.branch))
        return branches.sorted()
    }

    /// Count of main-branch failures
    var mainBranchFailureCount: Int {
        failures.filter { $0.branch == "main" }.count
    }

    // MARK: - Init

    init(
        testName: String,
        testSuite: String,
        testFile: String = "",
        apiClient: APIClientProtocol = APIClient.shared
    ) {
        self.testName = testName
        self.testSuite = testSuite
        self.testFile = testFile
        self.apiClient = apiClient
    }

    // MARK: - Data Loading

    func loadTestInfo() async {
        state = .loading

        let client = apiClient
        do {
            // Fetch both failures and trend data in parallel
            async let failuresTask: [TestFailure] = client.fetch(
                .testFailures(name: testName, suite: testSuite)
            )
            async let trendTask: [Test3dStatsResponse] = client.fetch(
                .test3dStats(name: testName, suite: testSuite, file: testFile)
            )

            let (failuresResponse, trendResponse) = try await (failuresTask, trendTask)

            self.failures = failuresResponse
            self.trendPoints = parseTrendPoints(trendResponse)
            self.state = .loaded
        } catch {
            self.state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        let client = apiClient
        do {
            async let failuresTask: [TestFailure] = client.fetch(
                .testFailures(name: testName, suite: testSuite)
            )
            async let trendTask: [Test3dStatsResponse] = client.fetch(
                .test3dStats(name: testName, suite: testSuite, file: testFile)
            )

            let (failuresResponse, trendResponse) = try await (failuresTask, trendTask)

            self.failures = failuresResponse
            self.trendPoints = parseTrendPoints(trendResponse)
            self.state = .loaded
        } catch {
            self.state = .error(error.localizedDescription)
        }
    }

    func parseTrendPoints(_ response: [Test3dStatsResponse]) -> [TestTrendPoint] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withDashSeparatorInDate, .withColonSeparatorInTime]

        return response.compactMap { item in
            guard let date = formatter.date(from: item.hour) else { return nil }
            return TestTrendPoint(hour: date, conclusions: item.conclusions)
        }.sorted { $0.hour < $1.hour }
    }

    // MARK: - Actions

    func toggleFailureExpansion(_ failure: TestFailure) {
        if expandedFailures.contains(failure.id) {
            expandedFailures.remove(failure.id)
        } else {
            expandedFailures.insert(failure.id)
        }
    }

    func isFailureExpanded(_ failure: TestFailure) -> Bool {
        expandedFailures.contains(failure.id)
    }

    func collapseAll() {
        expandedFailures.removeAll()
    }

    func expandAll() {
        expandedFailures = Set(recentFailures.map(\.id))
    }
}
