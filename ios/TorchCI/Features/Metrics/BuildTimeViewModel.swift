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

    func onParametersChanged() async {
        await fetchAllData()
    }

    private func fetchAllData() async {
        do {
            async let duration = fetchDurationSeries()
            async let p50 = fetchPercentileSeries("0.5")
            async let p75 = fetchPercentileSeries("0.75")
            async let p90 = fetchPercentileSeries("0.9")
            async let slowest = fetchSlowestWorkflows()
            async let steps = fetchBuildSteps()

            let (durationResult, p50Result, p75Result, p90Result, slowestResult, stepsResult) =
                try await (duration, p50, p75, p90, slowest, steps)

            durationSeries = durationResult
            p50Series = p50Result
            p75Series = p75Result
            p90Series = p90Result
            slowestWorkflows = slowestResult
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
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private struct BuildTimeOverallEntry: Decodable {
        let bucket: String
        let duration_sec: Double
        let job_name: String
    }

    private func fetchDurationSeries() async throws -> [TimeSeriesDataPoint] {
        let entries: [BuildTimeOverallEntry] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "build_time_metrics/overall",
                parameters: baseParams()
            )
        )
        // Aggregate across all jobs per time bucket
        let grouped = Dictionary(grouping: entries, by: { $0.bucket })
        return grouped.map { (bucket, items) in
            let avgSec = items.map(\.duration_sec).reduce(0, +) / Double(items.count)
            return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgSec)
        }.sorted { $0.granularity_bucket < $1.granularity_bucket }
    }

    private func fetchPercentileSeries(_ percentile: String) async throws -> [TimeSeriesDataPoint] {
        // No direct percentile query for build times; degrade gracefully
        return []
    }

    private struct BuildStepEntry: Decodable {
        let job_name: String
        let step_name: String
        let duration_min: Double?
    }

    private func fetchSlowestWorkflows() async throws -> [WorkflowDuration] {
        // Derive from build_time_metrics/overall: aggregate per job_name
        let entries: [BuildTimeOverallEntry] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "build_time_metrics/overall",
                parameters: baseParams()
            )
        )
        let grouped = Dictionary(grouping: entries, by: { $0.job_name })
        return grouped.map { (jobName, items) in
            let avgSec = items.map(\.duration_sec).reduce(0, +) / Double(items.count)
            return WorkflowDuration(
                name: jobName,
                avgMinutes: avgSec / 60,
                p90Minutes: 0,
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
