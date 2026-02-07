import Foundation
import SwiftUI

@MainActor
final class BenchmarkDashboardViewModel: ObservableObject {
    // MARK: - State

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.loaded, .loaded):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    @Published var state: ViewState = .idle
    @Published var timeSeriesData: [BenchmarkTimeSeriesPoint] = []
    @Published var groupData: BenchmarkGroupData?
    @Published var regressionReports: [RegressionReport] = []

    // MARK: - Filters

    @Published var selectedModels: Set<String> = []
    @Published var selectedMetric: String = ""
    @Published var selectedBranch: String = "main"
    @Published var startDate: Date = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
    @Published var endDate: Date = Date()

    static let branches: [String] = ["main", "viable/strict", "nightly"]

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    let benchmark: BenchmarkMetadata

    // MARK: - Computed

    var isLoading: Bool { state == .loading }

    var availableModels: [String] {
        let models = Set(timeSeriesData.compactMap(\.model))
        return models.sorted()
    }

    var availableMetrics: [String] {
        let metrics = Set(timeSeriesData.compactMap(\.metric))
        return metrics.sorted()
    }

    var filteredTimeSeries: [BenchmarkTimeSeriesPoint] {
        timeSeriesData.filter { point in
            let modelMatch = selectedModels.isEmpty || (point.model.map { selectedModels.contains($0) } ?? true)
            let metricMatch = selectedMetric.isEmpty || point.metric == selectedMetric
            return modelMatch && metricMatch
        }
    }

    var filteredGroupDataPoints: [BenchmarkDataPoint] {
        guard let data = groupData?.data else { return [] }
        if selectedModels.isEmpty { return data }
        return data.filter { selectedModels.contains($0.name) }
    }

    var regressionCommits: Set<String> {
        var commits = Set<String>()
        for report in regressionReports {
            if let items = report.details?.regression {
                for _ in items {
                    // Regression reports don't have commit shas directly on items,
                    // but the report ID often encodes the commit
                    commits.insert(report.id)
                }
            }
        }
        return commits
    }

    var hasRegressions: Bool {
        !regressionReports.isEmpty
    }

    var totalRegressionCount: Int {
        regressionReports.reduce(0) { $0 + ($1.details?.regression?.count ?? 0) }
    }

    // MARK: - Statistics

    var statistics: BenchmarkStatistics {
        let values = filteredTimeSeries.map(\.value)
        guard !values.isEmpty else {
            return BenchmarkStatistics(
                mean: 0, median: 0, stddev: 0,
                min: 0, max: 0,
                p25: 0, p75: 0, p90: 0, p95: 0
            )
        }

        let sorted = values.sorted()
        let count = Double(sorted.count)
        let mean = values.reduce(0, +) / count
        let variance = values.map { pow($0 - mean, 2) }.reduce(0, +) / count
        let stddev = sqrt(variance)

        let median = percentile(sorted, 0.5)
        let p25 = percentile(sorted, 0.25)
        let p75 = percentile(sorted, 0.75)
        let p90 = percentile(sorted, 0.90)
        let p95 = percentile(sorted, 0.95)

        return BenchmarkStatistics(
            mean: mean,
            median: median,
            stddev: stddev,
            min: sorted.first ?? 0,
            max: sorted.last ?? 0,
            p25: p25,
            p75: p75,
            p90: p90,
            p95: p95
        )
    }

    var performanceTrend: PerformanceTrend {
        let recent = filteredTimeSeries.suffix(10).map(\.value)
        let older = filteredTimeSeries.prefix(max(10, filteredTimeSeries.count / 2)).map(\.value)

        guard !recent.isEmpty, !older.isEmpty else { return .stable }

        let recentAvg = recent.reduce(0, +) / Double(recent.count)
        let olderAvg = older.reduce(0, +) / Double(older.count)

        let change = (recentAvg - olderAvg) / olderAvg
        if change > 0.05 { return .improving }
        if change < -0.05 { return .regressing }
        return .stable
    }

    var comparisonData: BenchmarkComparison? {
        guard filteredTimeSeries.count >= 2 else { return nil }
        let latest = filteredTimeSeries.last!
        let baseline = filteredTimeSeries.first!

        let change = ((latest.value - baseline.value) / baseline.value) * 100
        let speedup = baseline.value / latest.value

        return BenchmarkComparison(
            baseline: baseline,
            current: latest,
            changePercent: change,
            speedup: speedup
        )
    }

    var varianceLevel: VarianceLevel {
        let values = filteredTimeSeries.map(\.value)
        guard values.count > 1 else { return .unknown }

        let mean = statistics.mean
        let coefficientOfVariation = mean != 0 ? (statistics.stddev / mean) * 100 : 0

        if coefficientOfVariation < 5 {
            return .low
        } else if coefficientOfVariation < 15 {
            return .moderate
        } else {
            return .high
        }
    }

    var bestPerformancePoint: BenchmarkTimeSeriesPoint? {
        // For most benchmarks, lower values are better (latency, time)
        filteredTimeSeries.min(by: { $0.value < $1.value })
    }

    var worstPerformancePoint: BenchmarkTimeSeriesPoint? {
        filteredTimeSeries.max(by: { $0.value < $1.value })
    }

    private func percentile(_ sorted: [Double], _ p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let index = p * Double(sorted.count - 1)
        let lower = Int(floor(index))
        let upper = Int(ceil(index))
        if lower == upper {
            return sorted[lower]
        }
        let weight = index - Double(lower)
        return sorted[lower] * (1 - weight) + sorted[upper] * weight
    }

    // MARK: - Init

    init(benchmark: BenchmarkMetadata, apiClient: APIClientProtocol = APIClient.shared) {
        self.benchmark = benchmark
        self.apiClient = apiClient
    }

    // MARK: - Actions

    func loadData() async {
        state = .loading

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")

        let queryParams: [String: Any] = [
            "branches": [selectedBranch],
            "startTime": dateFormatter.string(from: startDate),
            "stopTime": dateFormatter.string(from: endDate),
        ]

        let groupDataParams: [String: String] = [
            "benchmark_name": benchmark.id,
            "repo": "pytorch/pytorch",
            "start_time": dateFormatter.string(from: startDate),
            "end_time": dateFormatter.string(from: endDate),
        ]

        // Pre-build endpoints to avoid capturing non-Sendable [String: Any] in async let
        let tsEndpoint = APIEndpoint.benchmarkTimeSeries(
            name: benchmark.id,
            queryParams: queryParams,
            responseFormats: ["time_series"]
        )
        let groupEndpoint = APIEndpoint.benchmarkGroupData(params: groupDataParams)
        let regressionEndpoint = APIEndpoint.regressionReports(reportId: benchmark.id)

        do {
            let client = apiClient
            async let timeSeriesFetch: BenchmarkTimeSeriesResponse = client.fetch(tsEndpoint)
            async let groupFetch: BenchmarkGroupData = client.fetch(groupEndpoint)
            async let regressionFetch: RegressionReportListResponse = client.fetch(regressionEndpoint)

            let (timeSeriesResponse, group, regressionResponse) = try await (timeSeriesFetch, groupFetch, regressionFetch)

            timeSeriesData = timeSeriesResponse.flattenedTimeSeries
            groupData = group
            regressionReports = regressionResponse.reports ?? []

            // Auto-select first metric if none selected
            if selectedMetric.isEmpty, let first = availableMetrics.first {
                selectedMetric = first
            }

            state = .loaded
        } catch {
            // Try loading each piece individually so partial data still shows
            await loadTimeSeries(queryParams: queryParams)
            await loadGroupData(params: groupDataParams)
            await loadRegressions()

            if timeSeriesData.isEmpty && groupData == nil {
                state = .error(error.localizedDescription)
            } else {
                state = .loaded
            }
        }
    }

    func refresh() async {
        await loadData()
    }

    func selectMetric(_ metric: String) {
        selectedMetric = metric
    }

    func updateDateRange(start: Date, end: Date) {
        startDate = start
        endDate = end
        Task { await loadData() }
    }

    // MARK: - Private

    private func loadTimeSeries(queryParams: [String: Any]) async {
        do {
            let result: BenchmarkTimeSeriesResponse = try await apiClient.fetch(
                APIEndpoint.benchmarkTimeSeries(
                    name: benchmark.id,
                    queryParams: queryParams,
                    responseFormats: ["time_series"]
                )
            )
            timeSeriesData = result.flattenedTimeSeries
        } catch {
            // Silently fail for partial load
        }
    }

    private func loadGroupData(params: [String: String]) async {
        do {
            let result: BenchmarkGroupData = try await apiClient.fetch(
                APIEndpoint.benchmarkGroupData(params: params)
            )
            groupData = result
        } catch {
            // Silently fail for partial load
        }
    }

    private func loadRegressions() async {
        do {
            let result: RegressionReportListResponse = try await apiClient.fetch(
                APIEndpoint.regressionReports(reportId: benchmark.id)
            )
            regressionReports = result.reports ?? []
        } catch {
            // Silently fail for partial load
        }
    }
}

// MARK: - Supporting Types

struct BenchmarkStatistics: Sendable {
    let mean: Double
    let median: Double
    let stddev: Double
    let min: Double
    let max: Double
    let p25: Double
    let p75: Double
    let p90: Double
    let p95: Double
}

struct BenchmarkComparison: Sendable {
    let baseline: BenchmarkTimeSeriesPoint
    let current: BenchmarkTimeSeriesPoint
    let changePercent: Double
    let speedup: Double

    var isImprovement: Bool {
        // For most metrics, lower is better (latency, memory)
        // For throughput metrics, higher is better
        // We'll use a simple heuristic: if speedup > 1, it's an improvement
        speedup > 1.0
    }

    var isRegression: Bool {
        speedup < 0.95
    }
}

enum PerformanceTrend {
    case improving
    case stable
    case regressing

    var color: Color {
        switch self {
        case .improving: return AppColors.success
        case .stable: return .blue
        case .regressing: return AppColors.failure
        }
    }

    var icon: String {
        switch self {
        case .improving: return "arrow.up.circle.fill"
        case .stable: return "minus.circle.fill"
        case .regressing: return "arrow.down.circle.fill"
        }
    }

    var label: String {
        switch self {
        case .improving: return "Improving"
        case .stable: return "Stable"
        case .regressing: return "Regressing"
        }
    }
}

enum VarianceLevel {
    case low
    case moderate
    case high
    case unknown

    var color: Color {
        switch self {
        case .low: return AppColors.success
        case .moderate: return .orange
        case .high: return AppColors.failure
        case .unknown: return .gray
        }
    }

    var icon: String {
        switch self {
        case .low: return "checkmark.circle.fill"
        case .moderate: return "exclamationmark.circle.fill"
        case .high: return "xmark.circle.fill"
        case .unknown: return "questionmark.circle.fill"
        }
    }

    var label: String {
        switch self {
        case .low: return "Low Variance (Stable)"
        case .moderate: return "Moderate Variance"
        case .high: return "High Variance (Unstable)"
        case .unknown: return "Unknown"
        }
    }

    var description: String {
        switch self {
        case .low: return "Results are consistent and reliable"
        case .moderate: return "Some variability in results"
        case .high: return "High variability, results may be unreliable"
        case .unknown: return "Not enough data to determine"
        }
    }
}
