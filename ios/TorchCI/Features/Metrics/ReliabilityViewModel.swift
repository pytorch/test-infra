import Foundation
import SwiftUI

@MainActor
final class ReliabilityViewModel: ObservableObject {
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

    @Published var state: ViewState = .loading
    @Published var workflows: [ReliabilityData] = []
    @Published var reliabilityTrendSeries: [TimeSeriesDataPoint] = []
    @Published var selectedFilter: WorkflowFilter = .all
    @Published var selectedTimeRange: String = "7d"
    @Published var searchText: String = ""
    @Published var sortOrder: SortOrder = .worstFirst

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?

    // MARK: - Workflow Names (matches web source)

    /// Primary workflows as defined in the web reliability page.
    static let primaryWorkflows = [
        "lint", "pull", "trunk",
        "linux-binary-libtorch-release", "linux-binary-manywheel", "linux-aarch64",
    ]
    /// Secondary workflows as defined in the web reliability page.
    static let secondaryWorkflows = ["periodic", "inductor"]
    /// Unstable workflows as defined in the web reliability page.
    static let unstableWorkflows = ["unstable"]
    /// All workflows combined.
    static let allWorkflowNames: [String] =
        primaryWorkflows + secondaryWorkflows + unstableWorkflows

    // MARK: - Failure Classification Thresholds (matches web metricUtils)

    /// When N consecutive failures of the same job happen, they are counted as broken trunk.
    static let brokenTrunkThreshold = 3
    /// When more than N failures happen in the same commit, they are counted as infra broken.
    static let outageThreshold = 10

    // MARK: - Workflow Filters

    enum WorkflowFilter: String, CaseIterable, CustomStringConvertible {
        case all = "All"
        case primary = "Primary"
        case secondary = "Secondary"
        case unstable = "Unstable"

        var description: String { rawValue }
    }

    enum SortOrder: String, CaseIterable {
        case worstFirst = "Worst First"
        case bestFirst = "Best First"
        case nameAZ = "Name A-Z"
        case nameZA = "Name Z-A"
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Computed

    var filteredWorkflows: [ReliabilityData] {
        var filtered: [ReliabilityData]

        // Apply category filter
        switch selectedFilter {
        case .all:
            filtered = workflows
        case .primary:
            filtered = workflows.filter { isPrimaryWorkflow($0.workflowName) }
        case .secondary:
            filtered = workflows.filter { isSecondaryWorkflow($0.workflowName) }
        case .unstable:
            filtered = workflows.filter { isUnstableWorkflow($0.workflowName) }
        }

        // Apply search filter
        if !searchText.isEmpty {
            filtered = filtered.filter {
                $0.workflowName.localizedCaseInsensitiveContains(searchText)
            }
        }

        // Apply sort order
        switch sortOrder {
        case .worstFirst:
            filtered.sort { $0.failureRate > $1.failureRate }
        case .bestFirst:
            filtered.sort { $0.failureRate < $1.failureRate }
        case .nameAZ:
            filtered.sort { $0.workflowName.localizedCompare($1.workflowName) == .orderedAscending }
        case .nameZA:
            filtered.sort { $0.workflowName.localizedCompare($1.workflowName) == .orderedDescending }
        }

        return filtered
    }

    var totalJobs: Int {
        filteredWorkflows.reduce(0) { $0 + $1.totalJobs }
    }

    var totalFailed: Int {
        filteredWorkflows.reduce(0) { $0 + $1.failedJobs }
    }

    var overallFailureRate: Double {
        guard totalJobs > 0 else { return 0 }
        return Double(totalFailed) / Double(totalJobs) * 100
    }

    var overallReliabilityRate: Double {
        return 100 - overallFailureRate
    }

    var totalBrokenTrunk: Int {
        filteredWorkflows.reduce(0) { $0 + ($1.brokenTrunk ?? 0) }
    }

    var totalFlaky: Int {
        filteredWorkflows.reduce(0) { $0 + ($1.flaky ?? 0) }
    }

    var totalInfra: Int {
        filteredWorkflows.reduce(0) { $0 + ($1.infra ?? 0) }
    }

    /// Top-level breakdown for the stacked bar chart
    struct FailureBreakdown: Identifiable {
        let id = UUID()
        let category: String
        let count: Int
        let color: Color
    }

    var failureBreakdown: [FailureBreakdown] {
        [
            FailureBreakdown(category: "Broken Trunk", count: totalBrokenTrunk, color: AppColors.failure),
            FailureBreakdown(category: "Flaky", count: totalFlaky, color: AppColors.unstable),
            FailureBreakdown(category: "Infra", count: totalInfra, color: AppColors.pending),
        ]
    }

    // MARK: - Trend Computation

    /// Describes how reliability is trending compared to the first half of the time window.
    enum TrendDirection: Equatable {
        case improving(Double)
        case declining(Double)
        case stable

        var icon: String {
            switch self {
            case .improving: return "arrow.up.right"
            case .declining: return "arrow.down.right"
            case .stable: return "arrow.right"
            }
        }

        var color: Color {
            switch self {
            case .improving: return AppColors.success
            case .declining: return AppColors.failure
            case .stable: return AppColors.neutral
            }
        }

        var label: String {
            switch self {
            case .improving(let delta): return String(format: "+%.1f%%", delta)
            case .declining(let delta): return String(format: "%.1f%%", -delta)
            case .stable: return "Stable"
            }
        }
    }

    /// Computes the trend by comparing average reliability in the second half of the
    /// time series to the first half. Returns `.stable` when there are fewer than 2 data points.
    var reliabilityTrend: TrendDirection {
        let values = reliabilityTrendSeries.compactMap(\.value)
        guard values.count >= 2 else { return .stable }

        let midpoint = values.count / 2
        let firstHalf = Array(values.prefix(midpoint))
        let secondHalf = Array(values.suffix(from: midpoint))

        let firstAvg = firstHalf.reduce(0, +) / Double(firstHalf.count)
        let secondAvg = secondHalf.reduce(0, +) / Double(secondHalf.count)
        let delta = secondAvg - firstAvg

        // Treat changes smaller than 0.5% as stable
        if abs(delta) < 0.5 {
            return .stable
        } else if delta > 0 {
            return .improving(delta)
        } else {
            return .declining(abs(delta))
        }
    }

    /// The number of workflows that have a reliability rate below 90%.
    var criticalWorkflowCount: Int {
        filteredWorkflows.filter { (100 - $0.failureRate) < 90 }.count
    }

    /// The number of workflows with reliability between 90% and 95%.
    var warningWorkflowCount: Int {
        filteredWorkflows.filter {
            let reliability = 100 - $0.failureRate
            return reliability >= 90 && reliability < 95
        }.count
    }

    /// The number of workflows with reliability >= 95%.
    var healthyWorkflowCount: Int {
        filteredWorkflows.filter { (100 - $0.failureRate) >= 95 }.count
    }

    // MARK: - Data Loading

    func loadReliability() async {
        state = .loading
        await fetchData()
    }

    func refresh() async {
        await fetchData()
    }

    func onParametersChanged() {
        loadTask?.cancel()
        loadTask = Task { await fetchData() }
    }

    /// Per-commit job data returned by `master_commit_red_jobs`.
    /// Each row represents one commit with arrays of failing and succeeding job names.
    struct CommitRedJobsEntry: Decodable {
        let sha: String
        let time: String
        let author: String
        let body: String?
        let failures: [String]
        let successes: [String]

        enum CodingKeys: String, CodingKey {
            case sha, time, author, body, failures, successes
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            sha = try container.decode(String.self, forKey: .sha)
            time = try container.decode(String.self, forKey: .time)
            author = try container.decodeIfPresent(String.self, forKey: .author) ?? ""
            body = try container.decodeIfPresent(String.self, forKey: .body)
            failures = (try? container.decode([String].self, forKey: .failures)) ?? []
            successes = (try? container.decode([String].self, forKey: .successes)) ?? []
        }

        /// Memberwise initializer for testing.
        init(sha: String, time: String, author: String = "", body: String? = nil,
             failures: [String] = [], successes: [String] = []) {
            self.sha = sha
            self.time = time
            self.author = author
            self.body = body
            self.failures = failures
            self.successes = successes
        }
    }

    /// master_commit_red_percent returns {granularity_bucket, name, metric} with name in [Total, Broken trunk, Flaky]
    private struct RedPercentTrendEntry: Decodable {
        let granularity_bucket: String
        let name: String
        let metric: Double

        enum CodingKeys: String, CodingKey {
            case granularity_bucket, name, metric
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            granularity_bucket = try container.decode(String.self, forKey: .granularity_bucket)
            name = try container.decode(String.self, forKey: .name)
            if let v = try? container.decode(Double.self, forKey: .metric) {
                metric = v
            } else if let s = try? container.decode(String.self, forKey: .metric), let v = Double(s) {
                metric = v
            } else {
                metric = 0
            }
        }
    }

    // MARK: - Failure Classification (port of web metricUtils)

    /// Failure counts per job, broken down by type.
    struct FailureCounts {
        var brokenTrunk: Int = 0
        var flaky: Int = 0
        var infra: Int = 0

        var total: Int { brokenTrunk + flaky + infra }
    }

    /// Port of `approximateFailureByType` from `torchci/lib/metricUtils.ts`.
    ///
    /// Walks commits in time-descending order (newest first, as returned by the query).
    /// Tracks consecutive-failure streaks per job name:
    /// - streak >= `brokenTrunkThreshold` -> Broken Trunk
    /// - otherwise -> Test Flake (i.e. "Flaky")
    /// If a commit has >= `outageThreshold` failures, each failure is also counted as Infra.
    static func approximateFailureByType(
        _ commits: [CommitRedJobsEntry],
        brokenTrunkThreshold: Int = ReliabilityViewModel.brokenTrunkThreshold,
        outageThreshold: Int = ReliabilityViewModel.outageThreshold
    ) -> [String: FailureCounts] {
        var failuresByType: [String: FailureCounts] = [:]
        // Track consecutive failure streaks per job name
        var sequentialFailuresCount: [String: Int] = [:]

        for commit in commits {
            let failuresInCommit = Set(commit.failures.filter { !$0.isEmpty })

            // Increment streak counters for jobs that failed in this commit
            for failure in failuresInCommit {
                sequentialFailuresCount[failure, default: 0] += 1
            }

            // Check which tracked jobs did NOT fail in this commit (streak ended)
            for (failure, count) in sequentialFailuresCount {
                guard !failuresInCommit.contains(failure) else {
                    // If this commit has >= outageThreshold failures, count as infra
                    if failuresInCommit.count >= outageThreshold {
                        failuresByType[failure, default: FailureCounts()].infra += 1
                    }
                    continue
                }

                // Streak ended - classify the accumulated count
                if count > 0 {
                    if count >= brokenTrunkThreshold {
                        failuresByType[failure, default: FailureCounts()].brokenTrunk += count
                    } else {
                        failuresByType[failure, default: FailureCounts()].flaky += count
                    }
                }

                // Reset
                sequentialFailuresCount[failure] = 0
            }
        }

        // Flush remaining streaks
        for (failure, count) in sequentialFailuresCount where count > 0 {
            if count >= brokenTrunkThreshold {
                failuresByType[failure, default: FailureCounts()].brokenTrunk += count
            } else {
                failuresByType[failure, default: FailureCounts()].flaky += count
            }
        }

        return failuresByType
    }

    /// Count successes per job name across all commits.
    static func countSuccesses(_ commits: [CommitRedJobsEntry]) -> [String: Int] {
        var result: [String: Int] = [:]
        for commit in commits {
            for success in Set(commit.successes.filter { !$0.isEmpty }) {
                result[success, default: 0] += 1
            }
        }
        return result
    }

    private func fetchData() async {
        do {
            let range = TimeRange.presets.first { $0.id == selectedTimeRange }
            let days = range?.days ?? 7
            let timeRange = APIEndpoint.timeRange(days: days)

            let client = apiClient
            let workflowNames = Self.allWorkflowNames
            let granularity = days <= 7 ? "day" : "week"

            // Fetch per-commit job-level data (the same query the web uses)
            async let jobsData: [CommitRedJobsEntry] = client.fetch(
                .clickhouseQuery(
                    name: "master_commit_red_jobs",
                    parameters: [
                        "startTime": timeRange.startTime,
                        "stopTime": timeRange.stopTime,
                        "workflowNames": workflowNames,
                    ] as [String: Any]
                )
            )

            // Fetch trend data for the sparkline (categories: "Total", "Broken trunk", "Flaky")
            async let trendData: [RedPercentTrendEntry] = client.fetch(
                .clickhouseQuery(
                    name: "master_commit_red_percent",
                    parameters: [
                        "startTime": timeRange.startTime,
                        "stopTime": timeRange.stopTime,
                        "granularity": granularity,
                        "workflowNames": workflowNames,
                    ] as [String: Any]
                )
            )

            let fetchedJobs = try await jobsData
            let fetchedTrend = (try? await trendData) ?? []
            guard !Task.isCancelled else { return }

            // Classify failures using the same algorithm as the web
            let failuresByType = Self.approximateFailureByType(fetchedJobs)
            let successesByJob = Self.countSuccesses(fetchedJobs)

            // Build per-job ReliabilityData with real counts
            workflows = failuresByType.map { (jobName, counts) in
                let successCount = successesByJob[jobName] ?? 0
                // Total = successes + non-infra failures (matches web: successCount + failureCount)
                let failureCount = counts.brokenTrunk + counts.flaky
                let total = successCount + failureCount
                return ReliabilityData(
                    workflowName: jobName,
                    totalJobs: total,
                    failedJobs: failureCount,
                    brokenTrunk: counts.brokenTrunk,
                    flaky: counts.flaky,
                    infra: counts.infra
                )
            }.sorted { $0.failureRate > $1.failureRate }

            // Convert red-rate to reliability (100 - redRate)
            // Filter to "Total" entries only for the trend line
            reliabilityTrendSeries = fetchedTrend
                .filter { $0.name == "Total" }
                .map { entry in
                    // metric is a fraction (e.g. 0.25 = 25% red), convert to reliability %
                    let reliability = max(0, 100.0 - entry.metric * 100)
                    return TimeSeriesDataPoint(
                        granularity_bucket: entry.granularity_bucket,
                        value: reliability
                    )
                }

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    // MARK: - Workflow Classification

    /// Checks if a job name belongs to a primary workflow by matching the workflow prefix
    /// (the part before the first " / ") against the primary workflow name list.
    func isPrimaryWorkflow(_ name: String) -> Bool {
        let lower = name.lowercased()
        return Self.primaryWorkflows.contains { lower.hasPrefix($0) }
            || ["pull", "trunk", "lint", "linux", "win", "macos"]
                .contains { lower.contains($0) }
    }

    /// Checks if a job name belongs to a secondary workflow.
    func isSecondaryWorkflow(_ name: String) -> Bool {
        let lower = name.lowercased()
        return Self.secondaryWorkflows.contains { lower.hasPrefix($0) }
            || ["periodic", "inductor", "nightly", "docker", "binary"]
                .contains { lower.contains($0) }
    }

    /// Checks if a job name belongs to an unstable workflow.
    func isUnstableWorkflow(_ name: String) -> Bool {
        name.lowercased().contains("unstable")
    }
}
