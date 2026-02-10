import Foundation
import SwiftUI

@MainActor
final class LLMBenchmarkViewModel: ObservableObject {
    // MARK: - Published State

    @Published var state: ViewState = .idle
    @Published var timeSeriesData: [BenchmarkTimeSeriesPoint] = []
    @Published var groupData: BenchmarkGroupData?

    // MARK: - Filters

    @Published var selectedModels: Set<String> = []
    @Published var selectedMetricType: MetricType = .throughput
    @Published var selectedDevice: String = "All Devices"
    @Published var selectedBackend: String = "All Backends"
    @Published var selectedMode: String = "All Modes"
    @Published var selectedDtype: String = "All DTypes"
    @Published var selectedBranch: String = "main"

    // MARK: - UI State

    @Published var selectedPoint: BenchmarkTimeSeriesPoint?
    @Published var isComparisonMode: Bool = false

    // MARK: - Filter Options (populated from metadata query)

    @Published private var discoveredDevices: [String] = []
    @Published private var discoveredBackends: [String] = []
    @Published private var discoveredModes: [String] = []
    @Published private var discoveredDtypes: [String] = []

    private let apiClient: APIClientProtocol
    private let benchmarkId: String
    private var loadTask: Task<Void, Never>?

    static let branches: [String] = ["main", "viable/strict", "nightly"]

    /// Maps iOS benchmark item IDs to the ClickHouse repo and benchmark name values.
    /// Derived from the web app's BENCHMARK_ID_MAPPING and REPO_TO_BENCHMARKS.
    static let benchmarkConfig: [String: (repo: String, benchmarks: [String])] = [
        "pytorch_gptfast": (
            repo: "pytorch/pytorch",
            benchmarks: ["PyTorch gpt-fast benchmark"]
        ),
        "pytorch_x_vllm_benchmark": (
            repo: "pytorch/pytorch",
            benchmarks: ["PyTorch x vLLM benchmark"]
        ),
        "vllm_benchmark": (
            repo: "vllm-project/vllm",
            benchmarks: ["vLLM benchmark"]
        ),
        "sglang_benchmark": (
            repo: "sgl-project/sglang",
            benchmarks: ["SGLang benchmark"]
        ),
    ]

    /// Excluded metrics that are not useful for display (matches web app's EXCLUDED_METRICS).
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

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    enum MetricType: String, CaseIterable, CustomStringConvertible {
        case throughput = "Throughput"
        case latency = "Latency"
        case memory = "Memory"
        case compilation = "Compilation"

        var description: String { rawValue }

        var icon: String {
            switch self {
            case .throughput: return "arrow.up.right"
            case .latency: return "clock"
            case .memory: return "memorychip"
            case .compilation: return "hammer"
            }
        }

        var unit: String {
            switch self {
            case .throughput: return "tokens/s"
            case .latency: return "ms"
            case .memory: return "GB/s"
            case .compilation: return "s"
            }
        }

        var keywords: [String] {
            switch self {
            case .throughput:
                return ["throughput", "tokens_per_second", "token_per_sec", "tok/s", "tps"]
            case .latency:
                return ["latency", "time", "ms", "ttft", "tpot", "itl"]
            case .memory:
                return ["memory", "bandwidth", "gb/s", "mem_usage", "peak"]
            case .compilation:
                return ["compilation", "compile_time", "compile"]
            }
        }
    }

    // MARK: - Computed Properties

    var availableModels: [String] {
        let fromTimeSeries = Set(timeSeriesData.compactMap(\.model))
        let fromGroup = Set(groupData?.data.map(\.name) ?? [])
        return fromTimeSeries.union(fromGroup).sorted()
    }

    var availableDevices: [String] {
        if discoveredDevices.isEmpty { return ["All Devices"] }
        return ["All Devices"] + discoveredDevices
    }

    var availableBackends: [String] {
        if discoveredBackends.isEmpty { return ["All Backends"] }
        return ["All Backends"] + discoveredBackends
    }

    var availableModes: [String] {
        if discoveredModes.isEmpty { return ["All Modes"] }
        return ["All Modes"] + discoveredModes
    }

    var availableDtypes: [String] {
        if discoveredDtypes.isEmpty { return ["All DTypes"] }
        return ["All DTypes"] + discoveredDtypes
    }

    var filteredTimeSeries: [BenchmarkTimeSeriesPoint] {
        timeSeriesData.filter { point in
            let modelMatch = selectedModels.isEmpty || (point.model.map { selectedModels.contains($0) } ?? true)
            let metricMatch = matchesMetricType(point.metric)
            return modelMatch && metricMatch
        }
    }

    var filteredGroupPoints: [BenchmarkDataPoint] {
        guard let data = groupData?.data else { return [] }
        let filtered = data.filter { point in
            let modelMatch = selectedModels.isEmpty || selectedModels.contains(point.name)
            let metricMatch = matchesMetricType(point.metric)
            return modelMatch && metricMatch
        }
        return filtered.sorted { ($0.value) > ($1.value) }
    }

    var throughputStats: (avg: Double, max: Double, min: Double)? {
        let throughputPoints = timeSeriesData.filter { matchesMetricType($0.metric, type: .throughput) }
        guard !throughputPoints.isEmpty else { return nil }
        let values = throughputPoints.map(\.value)
        let avg = values.reduce(0, +) / Double(values.count)
        return (avg: avg, max: values.max() ?? 0, min: values.min() ?? 0)
    }

    var latencyStats: (avg: Double, p99: Double, min: Double)? {
        let latencyPoints = timeSeriesData.filter { matchesMetricType($0.metric, type: .latency) }
        guard !latencyPoints.isEmpty else { return nil }
        let values = latencyPoints.map(\.value).sorted()
        let avg = values.reduce(0, +) / Double(values.count)
        let p99Index = min(Int(Double(values.count) * 0.99), values.count - 1)
        return (avg: avg, p99: values[p99Index], min: values.first ?? 0)
    }

    var memoryStats: (avg: Double, max: Double, min: Double)? {
        let memoryPoints = timeSeriesData.filter { matchesMetricType($0.metric, type: .memory) }
        guard !memoryPoints.isEmpty else { return nil }
        let values = memoryPoints.map(\.value)
        let avg = values.reduce(0, +) / Double(values.count)
        return (avg: avg, max: values.max() ?? 0, min: values.min() ?? 0)
    }

    var compilationStats: (avg: Double, max: Double, min: Double)? {
        let compPoints = timeSeriesData.filter { matchesMetricType($0.metric, type: .compilation) }
        guard !compPoints.isEmpty else { return nil }
        let values = compPoints.map(\.value)
        let avg = values.reduce(0, +) / Double(values.count)
        return (avg: avg, max: values.max() ?? 0, min: values.min() ?? 0)
    }

    // MARK: - Init

    init(benchmarkId: String, apiClient: APIClientProtocol = APIClient.shared) {
        self.benchmarkId = benchmarkId
        self.apiClient = apiClient
    }

    // MARK: - Actions

    func onFiltersChanged() {
        loadTask?.cancel()
        loadTask = Task { await loadData() }
    }

    func loadData() async {
        if state != .loaded {
            state = .loading
        }

        let config = Self.benchmarkConfig[benchmarkId]
        let repo = config?.repo ?? "pytorch/pytorch"
        let benchmarks = config?.benchmarks ?? []

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let now = Date()
        let startDate = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now
        let startTime = dateFormatter.string(from: startDate)
        let stopTime = dateFormatter.string(from: now)

        // Build parameters for the oss_ci_benchmark_llms ClickHouse query.
        // Must match clickhouse_queries/oss_ci_benchmark_llms/params.json exactly.
        let dataParameters: [String: Any] = [
            "arch": "",
            "branches": [selectedBranch],
            "commits": [] as [String],
            "device": selectedDevice == "All Devices" ? "" : selectedDevice,
            "mode": selectedMode == "All Modes" ? "" : selectedMode,
            "dtypes": selectedDtype == "All DTypes" ? [] as [String] : [selectedDtype],
            "excludedMetrics": Self.excludedMetrics,
            "benchmarks": benchmarks,
            "granularity": "day",
            "models": [] as [String],
            "backends": selectedBackend == "All Backends" ? [] as [String] : [selectedBackend],
            "repo": repo,
            "startTime": startTime,
            "stopTime": stopTime,
            "requestRate": "",
        ]

        // Build parameters for the oss_ci_benchmark_names metadata query.
        let metadataParameters: [String: Any] = [
            "arch": "",
            "device": "",
            "dtypes": [] as [String],
            "excludedMetrics": Self.excludedMetrics,
            "benchmarks": benchmarks,
            "models": [] as [String],
            "backends": [] as [String],
            "repo": repo,
            "startTime": startTime,
            "stopTime": stopTime,
        ]

        let dataEndpoint = APIEndpoint.clickhouseQuery(
            name: "oss_ci_benchmark_llms",
            parameters: dataParameters
        )
        let metadataEndpoint = APIEndpoint.clickhouseQuery(
            name: "oss_ci_benchmark_names",
            parameters: metadataParameters
        )

        do {
            let client = apiClient
            async let dataFetch: [LLMBenchmarkRawRow] = client.fetch(dataEndpoint)
            async let metadataFetch: [LLMBenchmarkMetadataRow] = client.fetch(metadataEndpoint)

            let (rawRows, metadataRows) = try await (dataFetch, metadataFetch)
            guard !Task.isCancelled else { return }
            let (timeSeries, group) = Self.convertRawRows(rawRows)
            timeSeriesData = timeSeries
            groupData = group
            populateFilterOptions(from: metadataRows)
            state = .loaded
        } catch is CancellationError {
            return
        } catch {
            // Try loading data and metadata individually for partial results
            do {
                let rawRows: [LLMBenchmarkRawRow] = try await apiClient.fetch(dataEndpoint)
                let (timeSeries, group) = Self.convertRawRows(rawRows)
                timeSeriesData = timeSeries
                groupData = group
            } catch {
                // Ignore partial failure
            }

            do {
                let metadataRows: [LLMBenchmarkMetadataRow] = try await apiClient.fetch(metadataEndpoint)
                populateFilterOptions(from: metadataRows)
            } catch {
                // Ignore partial failure
            }

            if timeSeriesData.isEmpty && groupData == nil {
                state = .error(error.localizedDescription)
            } else {
                state = .loaded
            }
        }
    }

    // MARK: - Data Conversion

    /// Converts raw ClickHouse rows into time series points and group data.
    /// Each row represents one metric measurement for a model at a specific granularity bucket.
    /// We convert them to:
    /// 1. Time series points (model + metric + value over time, keyed by granularity_bucket)
    /// 2. Group data (latest values per model+metric for comparison view)
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
        //    "Latest" = highest workflow_id
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

    /// Extracts unique filter option values from metadata rows.
    private func populateFilterOptions(from rows: [LLMBenchmarkMetadataRow]) {
        var devices = Set<String>()
        var backends = Set<String>()
        var modes = Set<String>()
        var dtypes = Set<String>()

        for row in rows {
            if !row.device.isEmpty { devices.insert(row.device) }
            if !row.backend.isEmpty { backends.insert(row.backend) }
            if !row.mode.isEmpty { modes.insert(row.mode) }
            if !row.dtype.isEmpty { dtypes.insert(row.dtype) }
        }

        discoveredDevices = devices.sorted()
        discoveredBackends = backends.sorted()
        discoveredModes = modes.sorted()
        discoveredDtypes = dtypes.sorted()
    }

    // MARK: - Helpers

    private func matchesMetricType(_ metric: String?, type: MetricType? = nil) -> Bool {
        let targetType = type ?? selectedMetricType
        guard let metric = metric?.lowercased() else { return true }
        return targetType.keywords.contains { metric.contains($0) }
    }
}

// MARK: - Raw Row Models

/// Raw row returned by the `oss_ci_benchmark_llms` ClickHouse query.
/// Columns: workflow_id, job_id, model, backend, origins, metric, actual,
///          actual_geomean, target, mode, dtype, device, arch, granularity_bucket,
///          extra, metadata_info
struct LLMBenchmarkRawRow: Decodable {
    let workflowId: Int
    let jobId: Int?
    let model: String
    let backend: String
    let metric: String
    let actual: Double
    let actualGeomean: Double?
    let target: Double
    let mode: String
    let dtype: String
    let device: String
    let arch: String
    let granularityBucket: String

    enum CodingKeys: String, CodingKey {
        case model, backend, metric, actual, target, mode, dtype, device, arch
        case workflowId = "workflow_id"
        case jobId = "job_id"
        case actualGeomean = "actual_geomean"
        case granularityBucket = "granularity_bucket"
    }
}

/// Row returned by the `oss_ci_benchmark_names` metadata query.
/// Columns: benchmark, model, backend, metric, dtype, mode, device, arch
struct LLMBenchmarkMetadataRow: Decodable {
    let benchmark: String
    let model: String
    let backend: String
    let metric: String
    let dtype: String
    let mode: String
    let device: String
    let arch: String
}
