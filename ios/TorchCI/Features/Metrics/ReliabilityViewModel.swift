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

    func onParametersChanged() async {
        await fetchData()
    }

    private struct RedPercentGroupEntry: Decodable {
        let granularity_bucket: String
        let name: String
        let red: Double

        enum CodingKeys: String, CodingKey {
            case granularity_bucket, name, red
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            granularity_bucket = try container.decode(String.self, forKey: .granularity_bucket)
            name = try container.decode(String.self, forKey: .name)
            if let v = try? container.decode(Double.self, forKey: .red) {
                red = v
            } else if let s = try? container.decode(String.self, forKey: .red), let v = Double(s) {
                red = v
            } else {
                red = 0
            }
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

    private func fetchData() async {
        do {
            let range = TimeRange.presets.first { $0.id == selectedTimeRange }
            let days = range?.days ?? 7
            let timeRange = APIEndpoint.timeRange(days: days)

            let client = apiClient
            let workflowNames = ["lint", "pull", "trunk", "linux-aarch64"]
            let granularity = days <= 7 ? "day" : "week"

            async let groupData: [RedPercentGroupEntry] = client.fetch(
                .clickhouseQuery(
                    name: "master_commit_red_percent_groups",
                    parameters: [
                        "startTime": timeRange.startTime,
                        "stopTime": timeRange.stopTime,
                        "granularity": granularity,
                        "workflowNames": workflowNames,
                    ] as [String: Any]
                )
            )

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

            // Group per-workflow red percentages and average across time buckets
            let fetchedGroups = try await groupData
            let byName = Dictionary(grouping: fetchedGroups, by: { $0.name })
            workflows = byName.map { (name, entries) in
                let avgRed = entries.map(\.red).reduce(0, +) / Double(entries.count)
                let failedScaled = Int(avgRed * 100) // Scale for precision
                return ReliabilityData(
                    workflowName: name,
                    totalJobs: 10000,
                    failedJobs: failedScaled,
                    brokenTrunk: nil,
                    flaky: nil,
                    infra: nil
                )
            }.sorted { $0.failureRate > $1.failureRate }

            // Convert red-rate to reliability (100 - redRate)
            // Filter to "Total" entries only for the trend line
            let fetchedTrend = (try? await trendData) ?? []
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

    func isPrimaryWorkflow(_ name: String) -> Bool {
        let primaryKeywords = ["pull", "trunk", "lint", "linux", "win", "macos", "inductor"]
        return primaryKeywords.contains { name.lowercased().contains($0) }
    }

    func isSecondaryWorkflow(_ name: String) -> Bool {
        let secondaryKeywords = ["periodic", "nightly", "docker", "binary"]
        return secondaryKeywords.contains { name.lowercased().contains($0) }
    }

    func isUnstableWorkflow(_ name: String) -> Bool {
        name.lowercased().contains("unstable")
    }
}
