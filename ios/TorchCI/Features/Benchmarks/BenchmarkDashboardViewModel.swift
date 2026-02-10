import Foundation
import SwiftUI

@MainActor
final class BenchmarkDashboardViewModel: ObservableObject {
    nonisolated(unsafe) private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

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
    @Published var selectedGranularity: String = "day"
    @Published var startDate: Date = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
    @Published var endDate: Date = Date()

    static let branches: [String] = ["main", "viable/strict", "nightly"]
    static let granularityOptions: [String] = ["hour", "day", "week"]

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?
    @Published var partialLoadError: String?
    let benchmark: BenchmarkMetadata

    /// Maps benchmark IDs that route to the generic dashboard to their ClickHouse query config.
    /// Derived from the web app's BENCHMARK_ID_MAPPING (all 8 V3 benchmark IDs).
    static let benchmarkConfig: [String: (repo: String, benchmarks: [String])] = [
        "pytorch_operator_microbenchmark": (
            repo: "pytorch/pytorch",
            benchmarks: ["PyTorch operator microbenchmark"]
        ),
        "pytorch_helion": (
            repo: "pytorch/helion",
            benchmarks: ["Helion Benchmark"]
        ),
        "executorch_benchmark": (
            repo: "pytorch/executorch",
            benchmarks: ["ExecuTorch"]
        ),
        "compiler_inductor": (
            repo: "pytorch/pytorch",
            benchmarks: ["TorchInductor"]
        ),
        "pytorch_x_vllm_benchmark": (
            repo: "pytorch/pytorch",
            benchmarks: ["PyTorch x vLLM"]
        ),
        "compiler_precompute": (
            repo: "pytorch/pytorch",
            benchmarks: ["TorchInductor"]
        ),
        "torchao_micro_api_benchmark": (
            repo: "pytorch/ao",
            benchmarks: ["TorchAO API Microbenchmark"]
        ),
        "vllm_benchmark": (
            repo: "vllm-project/vllm",
            benchmarks: ["vLLM"]
        ),
        "pytorch_gptfast": (
            repo: "pytorch/pytorch",
            benchmarks: ["GPT-Fast"]
        ),
        "sglang_benchmark": (
            repo: "sgl-project/sglang",
            benchmarks: ["SGLang"]
        ),
    ]

    /// Benchmark IDs that should query `compilers_benchmark_performance` instead of
    /// `oss_ci_benchmark_llms`. These correspond to the web's compiler benchmark pages.
    static let compilerBenchmarkIds: Set<String> = [
        "compiler_inductor",
        "compiler_precompute",
    ]

    /// Excluded metrics matching the web app's EXCLUDED_METRICS.
    static let excludedMetrics: [String] = [
        "load_status",
        "mean_itl_ms",
        "mean_tpot_ms",
        "mean_ttft_ms",
        "std_itl_ms",
        "std_tpot_ms",
        "std_ttft_ms",
        "cold_compile_time(s)",
        "warm_compile_time(s)",
        "speedup_pct",
        "generate_time(ms)",
    ]

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
        var ids = Set<String>()
        for report in regressionReports {
            // Match by lastRecordCommit (maps to commit SHA in time series if available)
            if let commit = report.lastRecordCommit {
                ids.insert(commit)
            }
            // Also collect workflowIds from regression detail points, since
            // the time series uses workflowId as its commit identifier
            if let items = report.details?.regression {
                for item in items {
                    for point in item.points ?? [] {
                        if let wfId = point.workflowId {
                            ids.insert(wfId)
                        }
                    }
                }
            }
        }
        return ids
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
        let older = filteredTimeSeries.prefix(filteredTimeSeries.count / 2).map(\.value)

        guard !recent.isEmpty, !older.isEmpty else { return .stable }

        let recentAvg = recent.reduce(0, +) / Double(recent.count)
        let olderAvg = older.reduce(0, +) / Double(older.count)

        guard olderAvg != 0 else { return .stable }
        let change = (recentAvg - olderAvg) / olderAvg
        if change > 0.05 { return .improving }
        if change < -0.05 { return .regressing }
        return .stable
    }

    var comparisonData: BenchmarkComparison? {
        guard filteredTimeSeries.count >= 2,
              let latest = filteredTimeSeries.last,
              let baseline = filteredTimeSeries.first else { return nil }
        guard baseline.value != 0, latest.value != 0 else { return nil }

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

    /// Whether this benchmark should use the compiler-specific ClickHouse query.
    var isCompilerBenchmark: Bool {
        Self.compilerBenchmarkIds.contains(benchmark.id)
    }

    func loadData() async {
        guard !Task.isCancelled else { return }
        if state != .loaded {
            state = .loading
        }
        partialLoadError = nil

        let config = Self.benchmarkConfig[benchmark.id]
        let repo = config?.repo ?? "pytorch/pytorch"
        let benchmarks = config?.benchmarks ?? [benchmark.name]

        let startTime = Self.dateFormatter.string(from: startDate)
        let stopTime = Self.dateFormatter.string(from: endDate)

        // Also fetch regression reports (this API does not require auth)
        let regressionEndpoint = APIEndpoint.regressionReports(reportId: benchmark.id)

        if isCompilerBenchmark {
            // Compiler benchmarks use the compilers_benchmark_performance ClickHouse query,
            // matching the web's compiler dashboard pages.
            let compilerParameters: [String: Any] = [
                "branches": [selectedBranch],
                "commits": [] as [String],
                "compilers": [] as [String],
                "arch": "h100",
                "device": "cuda",
                "dtype": "amp",
                "granularity": selectedGranularity,
                "mode": "training",
                "startTime": startTime,
                "stopTime": stopTime,
                "suites": ["torchbench", "huggingface", "timm_models"],
                "workflowId": 0,
            ]

            let dataEndpoint = APIEndpoint.clickhouseQuery(
                name: "compilers_benchmark_performance",
                parameters: compilerParameters
            )

            do {
                let client = apiClient
                async let dataFetch: [CompilerBenchmarkRawRow] = client.fetch(dataEndpoint)
                async let regressionFetch: RegressionReportListResponse = client.fetch(regressionEndpoint)

                let (rawRows, regressionResponse) = try await (dataFetch, regressionFetch)
                let (timeSeries, group) = Self.convertCompilerRawRows(rawRows)
                timeSeriesData = timeSeries
                groupData = group
                regressionReports = regressionResponse.reports ?? []

                if selectedMetric.isEmpty, let first = availableMetrics.first {
                    selectedMetric = first
                }

                state = .loaded
            } catch {
                await loadCompilerTimeSeries(parameters: compilerParameters)
                await loadRegressions()

                if timeSeriesData.isEmpty && groupData == nil {
                    state = .error(error.localizedDescription)
                } else {
                    state = .loaded
                }
            }
        } else {
            // Non-compiler benchmarks use the oss_ci_benchmark_llms ClickHouse query.
            // Must match clickhouse_queries/oss_ci_benchmark_llms/params.json exactly.
            let dataParameters: [String: Any] = [
                "arch": "",
                "branches": [selectedBranch],
                "commits": [] as [String],
                "device": "",
                "mode": "",
                "dtypes": [] as [String],
                "excludedMetrics": Self.excludedMetrics,
                "benchmarks": benchmarks,
                "granularity": selectedGranularity,
                "models": [] as [String],
                "backends": [] as [String],
                "repo": repo,
                "startTime": startTime,
                "stopTime": stopTime,
                "requestRate": "",
            ]

            let dataEndpoint = APIEndpoint.clickhouseQuery(
                name: "oss_ci_benchmark_llms",
                parameters: dataParameters
            )

            do {
                let client = apiClient
                async let dataFetch: [LLMBenchmarkRawRow] = client.fetch(dataEndpoint)
                async let regressionFetch: RegressionReportListResponse = client.fetch(regressionEndpoint)

                let (rawRows, regressionResponse) = try await (dataFetch, regressionFetch)
                let (timeSeries, group) = Self.convertRawRows(rawRows)
                timeSeriesData = timeSeries
                groupData = group
                regressionReports = regressionResponse.reports ?? []

                if selectedMetric.isEmpty, let first = availableMetrics.first {
                    selectedMetric = first
                }

                state = .loaded
            } catch {
                await loadTimeSeriesFromClickHouse(parameters: dataParameters)
                await loadRegressions()

                if timeSeriesData.isEmpty && groupData == nil {
                    state = .error(error.localizedDescription)
                } else {
                    state = .loaded
                }
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
        loadTask?.cancel()
        // Ensure start <= end
        if start <= end {
            startDate = start
            endDate = end
        } else {
            startDate = end
            endDate = start
        }
        loadTask = Task { await loadData() }
    }

    // MARK: - Data Conversion

    /// Converts raw ClickHouse rows into time series points and group data.
    /// Reuses the same logic as LLMBenchmarkViewModel.convertRawRows.
    static func convertRawRows(_ rawRows: [LLMBenchmarkRawRow]) -> ([BenchmarkTimeSeriesPoint], BenchmarkGroupData?) {
        guard !rawRows.isEmpty else { return ([], nil) }

        // 1. Build time series points from all rows
        var timeSeriesPoints: [BenchmarkTimeSeriesPoint] = []
        for row in rawRows {
            timeSeriesPoints.append(BenchmarkTimeSeriesPoint(
                commit: "\(row.workflowId)",
                commitDate: row.granularityBucket,
                value: row.actual,
                metric: row.metric,
                model: row.model
            ))
        }

        // 2. Build group data by taking the latest workflow per (model, metric, backend, dtype)
        struct GroupKey: Hashable {
            let model: String
            let metric: String
            let backend: String
            let dtype: String
        }
        var latestByGroup: [GroupKey: LLMBenchmarkRawRow] = [:]
        for row in rawRows {
            let key = GroupKey(model: row.model, metric: row.metric, backend: row.backend, dtype: row.dtype)
            if let existing = latestByGroup[key] {
                if row.workflowId > existing.workflowId {
                    latestByGroup[key] = row
                }
            } else {
                latestByGroup[key] = row
            }
        }

        let dataPoints: [BenchmarkDataPoint] = latestByGroup.values.map { row in
            BenchmarkDataPoint(
                name: row.model,
                metric: row.metric,
                value: row.actual,
                baseline: row.target > 0 ? row.target : nil,
                speedup: row.target > 0 ? row.actual / row.target : nil,
                status: nil
            )
        }

        let groupData = BenchmarkGroupData(data: dataPoints, metadata: nil)
        return (timeSeriesPoints, groupData)
    }

    /// Converts raw compiler benchmark rows into time series points and group data.
    /// Uses the same pivot logic as CompilerBenchmarkView but produces the generic
    /// BenchmarkTimeSeriesPoint / BenchmarkGroupData types for the dashboard.
    static func convertCompilerRawRows(_ rawRows: [CompilerBenchmarkRawRow]) -> ([BenchmarkTimeSeriesPoint], BenchmarkGroupData?) {
        guard !rawRows.isEmpty else { return ([], nil) }

        // Group by (workflowId, model, backend) and pivot metrics, same as CompilerBenchmarkView
        struct PivotKey: Hashable {
            let workflowId: Int
            let model: String
            let backend: String
        }
        struct PivotEntry {
            let model: String
            let backend: String
            let suite: String
            let workflowId: Int
            let granularityBucket: String
            var speedup: Double?
            var accuracy: String?
            var compilationLatency: Double?
            var compressionRatio: Double?
            var absLatency: Double?
        }

        var workflowBucket: [Int: String] = [:]
        for row in rawRows {
            if workflowBucket[row.workflowId] == nil {
                workflowBucket[row.workflowId] = row.granularityBucket
            }
        }

        var grouped: [PivotKey: PivotEntry] = [:]
        for row in rawRows {
            let key = PivotKey(workflowId: row.workflowId, model: row.model, backend: row.backend)
            if grouped[key] == nil {
                grouped[key] = PivotEntry(
                    model: row.model,
                    backend: row.backend,
                    suite: row.suite,
                    workflowId: row.workflowId,
                    granularityBucket: workflowBucket[row.workflowId] ?? row.granularityBucket
                )
            }
            switch row.metric {
            case "speedup":
                grouped[key]?.speedup = row.value
            case "accuracy":
                if let extraInfo = row.extraInfo,
                   let benchmarkValues = extraInfo["benchmark_values"],
                   let jsonData = benchmarkValues.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: jsonData) as? [Any],
                   let first = parsed.first as? String {
                    grouped[key]?.accuracy = first
                }
            case "compilation_latency":
                grouped[key]?.compilationLatency = row.value
            case "compression_ratio":
                grouped[key]?.compressionRatio = row.value
            case "abs_latency":
                grouped[key]?.absLatency = row.value
            default:
                break
            }
        }

        // Build time series from speedup metric (one point per workflow+model+backend)
        var timeSeriesPoints: [BenchmarkTimeSeriesPoint] = []
        for entry in grouped.values {
            if let speedup = entry.speedup {
                timeSeriesPoints.append(BenchmarkTimeSeriesPoint(
                    commit: "\(entry.workflowId)",
                    commitDate: entry.granularityBucket,
                    value: speedup,
                    metric: "speedup",
                    model: entry.model
                ))
            }
            if let compileTime = entry.compilationLatency {
                timeSeriesPoints.append(BenchmarkTimeSeriesPoint(
                    commit: "\(entry.workflowId)",
                    commitDate: entry.granularityBucket,
                    value: compileTime,
                    metric: "compilation_latency",
                    model: entry.model
                ))
            }
        }

        // Build group data: keep latest workflow per (model, backend)
        struct ModelBackendKey: Hashable {
            let model: String
            let backend: String
        }
        var latestByModelBackend: [ModelBackendKey: PivotEntry] = [:]
        for entry in grouped.values {
            let key = ModelBackendKey(model: entry.model, backend: entry.backend)
            if let existing = latestByModelBackend[key] {
                if entry.workflowId > existing.workflowId {
                    latestByModelBackend[key] = entry
                }
            } else {
                latestByModelBackend[key] = entry
            }
        }

        let dataPoints: [BenchmarkDataPoint] = latestByModelBackend.values.map { entry in
            BenchmarkDataPoint(
                name: entry.model,
                metric: "speedup",
                value: entry.speedup ?? 0,
                baseline: 1.0, // Compiler benchmarks measure speedup over baseline (1.0x)
                speedup: entry.speedup,
                status: entry.accuracy
            )
        }

        let groupData = BenchmarkGroupData(data: dataPoints, metadata: nil)
        return (timeSeriesPoints, groupData)
    }

    // MARK: - Private

    private func loadTimeSeriesFromClickHouse(parameters: [String: Any]) async {
        do {
            let rawRows: [LLMBenchmarkRawRow] = try await apiClient.fetch(
                APIEndpoint.clickhouseQuery(
                    name: "oss_ci_benchmark_llms",
                    parameters: parameters
                )
            )
            let (timeSeries, group) = Self.convertRawRows(rawRows)
            timeSeriesData = timeSeries
            groupData = group
        } catch {
            partialLoadError = "Time series load failed: \(error.localizedDescription)"
        }
    }

    private func loadCompilerTimeSeries(parameters: [String: Any]) async {
        do {
            let rawRows: [CompilerBenchmarkRawRow] = try await apiClient.fetch(
                APIEndpoint.clickhouseQuery(
                    name: "compilers_benchmark_performance",
                    parameters: parameters
                )
            )
            let (timeSeries, group) = Self.convertCompilerRawRows(rawRows)
            timeSeriesData = timeSeries
            groupData = group
        } catch {
            partialLoadError = "Compiler time series load failed: \(error.localizedDescription)"
        }
    }

    private func loadRegressions() async {
        do {
            let result: RegressionReportListResponse = try await apiClient.fetch(
                APIEndpoint.regressionReports(reportId: benchmark.id)
            )
            regressionReports = result.reports ?? []
        } catch {
            partialLoadError = "Regressions load failed: \(error.localizedDescription)"
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
