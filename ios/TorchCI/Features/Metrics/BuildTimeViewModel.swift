import Foundation
import SwiftUI

@MainActor
final class BuildTimeViewModel: ObservableObject {
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

    struct WorkflowDuration: Identifiable {
        let id = UUID()
        let name: String
        let avgMinutes: Double
        let p90Minutes: Double
        let runCount: Int
    }

    struct BuildStepBreakdown: Identifiable {
        let id = UUID()
        let jobName: String
        let checkoutMinutes: Double
        let pullDockerMinutes: Double
        let buildMinutes: Double

        var totalMinutes: Double {
            checkoutMinutes + pullDockerMinutes + buildMinutes
        }
    }

    struct BuildRegression: Identifiable {
        let id = UUID()
        let jobName: String
        let currentMinutes: Double
        let baselineMinutes: Double

        var changePercent: Double {
            guard baselineMinutes > 0 else { return 0 }
            return ((currentMinutes - baselineMinutes) / baselineMinutes) * 100
        }

        var changeDescription: String {
            String(format: "+%.1f%%", changePercent)
        }
    }

    @Published var state: ViewState = .loading
    @Published var selectedTimeRange: String = "14d"
    @Published var granularity: TimeGranularity = .day

    @Published var durationSeries: [TimeSeriesDataPoint] = []
    @Published var p50Series: [TimeSeriesDataPoint] = []
    @Published var p75Series: [TimeSeriesDataPoint] = []
    @Published var p90Series: [TimeSeriesDataPoint] = []
    @Published var slowestWorkflows: [WorkflowDuration] = []
    @Published var buildSteps: [BuildStepBreakdown] = []
    @Published var regressions: [BuildRegression] = []

    @Published var avgDurationMinutes: Double?
    @Published var p90DurationMinutes: Double?
    @Published var totalBuildCount: Int = 0

    @Published var allJobNames: [String] = []
    @Published var selectedJobs: Set<String> = []

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    var selectedJobCount: Int {
        selectedJobs.count
    }

    var selectedBuildSteps: [BuildStepBreakdown] {
        buildSteps.filter { selectedJobs.contains($0.jobName) }
    }

    func isJobSelected(_ jobName: String) -> Bool {
        selectedJobs.contains(jobName)
    }

    func toggleJobSelection(_ jobName: String) {
        if selectedJobs.contains(jobName) {
            selectedJobs.remove(jobName)
        } else {
            selectedJobs.insert(jobName)
        }
    }

    func selectAllJobs() {
        selectedJobs = Set(allJobNames)
    }

    func deselectAllJobs() {
        selectedJobs.removeAll()
    }

    func onJobSelectionChanged() async {
        computeSummaries()
    }

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    private var timeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 14
        return APIEndpoint.timeRange(days: days)
    }

    var isImproving: Bool {
        guard durationSeries.count >= 2 else { return true }
        let recent = durationSeries.suffix(3).compactMap(\.value)
        let earlier = durationSeries.prefix(3).compactMap(\.value)
        guard let recentAvg = recent.isEmpty ? nil : recent.reduce(0, +) / Double(recent.count),
              let earlierAvg = earlier.isEmpty ? nil : earlier.reduce(0, +) / Double(earlier.count) else {
            return true
        }
        return recentAvg <= earlierAvg
    }

    var trendDescription: String {
        guard durationSeries.count >= 2,
              let first = durationSeries.first?.value, first > 0,
              let last = durationSeries.last?.value else {
            return "--"
        }
        let change = ((last - first) / first) * 100
        return String(format: "%+.1f%%", change)
    }

    // MARK: - Formatting Helpers

    static func formatDuration(_ minutes: Double?) -> String {
        guard let minutes else { return "--" }
        let totalMinutes = Int(minutes)
        if totalMinutes >= 60 {
            let hours = totalMinutes / 60
            let mins = totalMinutes % 60
            return "\(hours)h \(mins)m"
        }
        return "\(totalMinutes)m"
    }

    static func durationColor(_ minutes: Double?) -> Color {
        guard let minutes else { return .secondary }
        if minutes > 180 { return AppColors.failure }
        if minutes > 90 { return AppColors.unstable }
        return AppColors.success
    }

    // MARK: - Data Loading

    private func baseParams() -> [String: Any] {
        let range = timeRangeTuple
        let params: [String: Any] = [
            "startTime": range.startTime,
            "stopTime": range.stopTime,
            "granularity": granularity.rawValue,
        ]
        return params
    }

    func loadData() async {
        state = .loading
        await fetchAllData()
    }

    func refresh() async {
        await fetchAllData()
    }

    func onParametersChanged() {
        loadTask?.cancel()
        loadTask = Task { await fetchAllData() }
    }

    private func fetchAllData() async {
        do {
            async let overall = fetchOverallEntries()
            async let steps = fetchBuildSteps()

            let (overallEntries, stepsResult) = try await (overall, steps)
            guard !Task.isCancelled else { return }

            // Compute duration series: average across all jobs per time bucket
            let grouped = Dictionary(grouping: overallEntries, by: { $0.bucket })
            durationSeries = grouped.map { (bucket, items) in
                let avgSec = items.map(\.duration_sec).reduce(0, +) / Double(items.count)
                return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgSec)
            }.sorted { $0.granularity_bucket < $1.granularity_bucket }

            // Compute percentile series (P50, P75, P90) across job durations per bucket
            let percentiles = computePercentileSeries(from: overallEntries)
            p50Series = percentiles.p50
            p75Series = percentiles.p75
            p90Series = percentiles.p90

            // Derive slowest workflows from overall data
            slowestWorkflows = deriveSlowestWorkflows(from: overallEntries)
            buildSteps = stepsResult

            // Extract all unique job names from build steps
            let jobNames = Set(buildSteps.map { $0.jobName }).sorted()
            allJobNames = jobNames

            // Initialize selected jobs (select all by default)
            if selectedJobs.isEmpty {
                selectedJobs = Set(jobNames)
            } else {
                // Keep only jobs that still exist
                selectedJobs = selectedJobs.intersection(Set(jobNames))
            }

            computeSummaries()
            detectRegressions()
            state = .loaded
        } catch is CancellationError {
            // Task was cancelled — don't update state
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private struct BuildTimeOverallEntry: Decodable {
        let bucket: String
        let duration_sec: Double
        let job_name: String
    }

    private func fetchOverallEntries() async throws -> [BuildTimeOverallEntry] {
        try await apiClient.fetch(
            .clickhouseQuery(
                name: "build_time_metrics/overall",
                parameters: baseParams()
            )
        )
    }

    /// Compute P50, P75, P90 percentile series from per-job per-bucket duration data.
    /// For each time bucket, collects all job durations, sorts them, and picks the
    /// value at each percentile rank.
    private func computePercentileSeries(
        from entries: [BuildTimeOverallEntry]
    ) -> (p50: [TimeSeriesDataPoint], p75: [TimeSeriesDataPoint], p90: [TimeSeriesDataPoint]) {
        let grouped = Dictionary(grouping: entries, by: { $0.bucket })
        var p50Points: [TimeSeriesDataPoint] = []
        var p75Points: [TimeSeriesDataPoint] = []
        var p90Points: [TimeSeriesDataPoint] = []

        for (bucket, items) in grouped {
            let sorted = items.map(\.duration_sec).sorted()
            guard !sorted.isEmpty else { continue }

            p50Points.append(TimeSeriesDataPoint(
                granularity_bucket: bucket,
                value: Self.percentile(sorted, p: 0.50)
            ))
            p75Points.append(TimeSeriesDataPoint(
                granularity_bucket: bucket,
                value: Self.percentile(sorted, p: 0.75)
            ))
            p90Points.append(TimeSeriesDataPoint(
                granularity_bucket: bucket,
                value: Self.percentile(sorted, p: 0.90)
            ))
        }

        return (
            p50: p50Points.sorted { $0.granularity_bucket < $1.granularity_bucket },
            p75: p75Points.sorted { $0.granularity_bucket < $1.granularity_bucket },
            p90: p90Points.sorted { $0.granularity_bucket < $1.granularity_bucket }
        )
    }

    /// Linear interpolation percentile on a pre-sorted array of values.
    private static func percentile(_ sorted: [Double], p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        if sorted.count == 1 { return sorted[0] }
        let rank = p * Double(sorted.count - 1)
        let lower = Int(rank)
        let upper = min(lower + 1, sorted.count - 1)
        let fraction = rank - Double(lower)
        return sorted[lower] + fraction * (sorted[upper] - sorted[lower])
    }

    private struct BuildStepEntry: Decodable {
        let job_name: String
        let step_name: String
        let duration_min: Double?
    }

    /// Derive slowest workflows from already-fetched overall entries (no extra network call).
    private func deriveSlowestWorkflows(from entries: [BuildTimeOverallEntry]) -> [WorkflowDuration] {
        let grouped = Dictionary(grouping: entries, by: { $0.job_name })
        return grouped.map { (jobName, items) in
            let durations = items.map(\.duration_sec).sorted()
            let avgSec = durations.reduce(0, +) / Double(durations.count)
            let p90Sec = Self.percentile(durations, p: 0.90)
            return WorkflowDuration(
                name: jobName,
                avgMinutes: avgSec / 60,
                p90Minutes: p90Sec / 60,
                runCount: items.count
            )
        }
        .sorted { $0.avgMinutes > $1.avgMinutes }
        .prefix(10)
        .map { $0 }
    }

    private func fetchBuildSteps() async throws -> [BuildStepBreakdown] {
        let range = timeRangeTuple
        do {
            let entries: [BuildStepEntry] = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "build_time_metrics/steps",
                    parameters: [
                        "startTime": range.startTime,
                        "stopTime": range.stopTime,
                    ] as [String: Any]
                )
            )

            // Group by job_name
            let grouped = Dictionary(grouping: entries, by: { $0.job_name })

            return grouped.map { (jobName, steps) in
                let checkout = steps.first(where: { $0.step_name == "Checkout PyTorch" })?.duration_min ?? 0
                let pullDocker = steps.first(where: { $0.step_name == "Pull docker image" })?.duration_min ?? 0
                let build = steps.first(where: { $0.step_name == "Build" })?.duration_min ?? 0

                return BuildStepBreakdown(
                    jobName: jobName,
                    checkoutMinutes: checkout,
                    pullDockerMinutes: pullDocker,
                    buildMinutes: build
                )
            }.sorted { $0.totalMinutes > $1.totalMinutes }
        } catch {
            // Degrade gracefully if the query schema doesn't match
            return []
        }
    }

    func computeSummaries() {
        // Compute average from duration series
        if let lastValue = durationSeries.last?.value {
            avgDurationMinutes = lastValue / 60
        } else {
            avgDurationMinutes = nil
        }

        if let lastP90 = p90Series.last?.value {
            p90DurationMinutes = lastP90 / 60
        } else {
            p90DurationMinutes = nil
        }

        // Compute total build count from slowest workflows
        totalBuildCount = slowestWorkflows.reduce(0) { $0 + $1.runCount }
    }

    func detectRegressions() {
        // Compare recent builds to baseline (earlier period)
        // A regression is when current avg > baseline avg by 15%+

        guard !buildSteps.isEmpty else {
            regressions = []
            return
        }

        let regressionThreshold = 0.15 // 15% increase
        let avgTotal = buildSteps.map { $0.totalMinutes }.reduce(0, +) / Double(buildSteps.count)

        regressions = buildSteps.compactMap { step in
            let current = step.totalMinutes

            guard avgTotal > 0, current > avgTotal * (1 + regressionThreshold) else {
                return nil
            }

            return BuildRegression(
                jobName: step.jobName,
                currentMinutes: current,
                baselineMinutes: avgTotal
            )
        }.sorted { $0.changePercent > $1.changePercent }
        .prefix(5)
        .map { $0 }
    }
}
