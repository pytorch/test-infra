import Foundation
import SwiftUI

@MainActor
final class LLMBenchmarkViewModel: ObservableObject {
    // MARK: - Published State

    @Published var state: ViewState = .idle
    @Published var timeSeriesData: [BenchmarkTimeSeriesPoint] = []
    @Published var groupData: BenchmarkGroupData?
    @Published var metadataOptions: BenchmarkMetadataResponse?

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

    private let apiClient: APIClientProtocol
    private let benchmarkId: String

    static let branches: [String] = ["main", "viable/strict", "nightly"]

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
        guard let options = metadataOptions?.data else {
            return ["All Devices"]
        }
        let deviceOption = options.first { $0.name == "device" }
        return ["All Devices"] + (deviceOption?.values ?? [])
    }

    var availableBackends: [String] {
        guard let options = metadataOptions?.data else {
            return ["All Backends"]
        }
        let backendOption = options.first { $0.name == "backend" }
        return ["All Backends"] + (backendOption?.values ?? [])
    }

    var availableModes: [String] {
        guard let options = metadataOptions?.data else {
            return ["All Modes"]
        }
        let modeOption = options.first { $0.name == "mode" }
        return ["All Modes"] + (modeOption?.values ?? [])
    }

    var availableDtypes: [String] {
        guard let options = metadataOptions?.data else {
            return ["All DTypes"]
        }
        let dtypeOption = options.first { $0.name == "dtype" }
        return ["All DTypes"] + (dtypeOption?.values ?? [])
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

    func loadData() async {
        state = .loading

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let now = Date()
        let startDate = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now

        var queryParams: [String: Any] = [
            "branches": [selectedBranch],
            "startTime": dateFormatter.string(from: startDate),
            "stopTime": dateFormatter.string(from: now),
        ]

        // Add filters if not "All"
        if selectedDevice != "All Devices" {
            queryParams["device"] = selectedDevice
        }
        if selectedBackend != "All Backends" {
            queryParams["backend"] = selectedBackend
        }
        if selectedMode != "All Modes" {
            queryParams["mode"] = selectedMode
        }
        if selectedDtype != "All DTypes" {
            queryParams["dtype"] = selectedDtype
        }

        let groupDataParams: [String: String] = [
            "benchmark_name": benchmarkId,
            "repo": "pytorch/pytorch",
            "start_time": dateFormatter.string(from: startDate),
            "end_time": dateFormatter.string(from: now),
        ]

        // Pre-build endpoints to avoid capturing non-Sendable [String: Any] in async let
        let tsEndpoint = APIEndpoint.benchmarkTimeSeries(
            name: benchmarkId,
            queryParams: queryParams,
            responseFormats: ["time_series"]
        )
        let groupEndpoint = APIEndpoint.benchmarkGroupData(params: groupDataParams)
        let metadataEndpoint = APIEndpoint.benchmarkList(name: benchmarkId, queryParams: queryParams)

        do {
            let client = apiClient
            async let timeSeriesFetch: BenchmarkTimeSeriesResponse = client.fetch(tsEndpoint)
            async let groupFetch: BenchmarkGroupData = client.fetch(groupEndpoint)
            async let metadataFetch: BenchmarkMetadataResponse = client.fetch(metadataEndpoint)

            let (tsResponse, group, metadata) = try await (timeSeriesFetch, groupFetch, metadataFetch)
            timeSeriesData = tsResponse.flattenedTimeSeries
            groupData = group
            metadataOptions = metadata
            state = .loaded
        } catch {
            // Try individual fetches for partial data
            do {
                let tsResponse: BenchmarkTimeSeriesResponse = try await apiClient.fetch(
                    APIEndpoint.benchmarkTimeSeries(
                        name: benchmarkId,
                        queryParams: queryParams,
                        responseFormats: ["time_series"]
                    )
                )
                timeSeriesData = tsResponse.flattenedTimeSeries
            } catch {
                // Ignore partial failure
            }

            do {
                let group: BenchmarkGroupData = try await apiClient.fetch(
                    APIEndpoint.benchmarkGroupData(params: groupDataParams)
                )
                groupData = group
            } catch {
                // Ignore partial failure
            }

            do {
                let metadata: BenchmarkMetadataResponse = try await apiClient.fetch(
                    APIEndpoint.benchmarkList(name: benchmarkId, queryParams: queryParams)
                )
                metadataOptions = metadata
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

    // MARK: - Helpers

    private func matchesMetricType(_ metric: String?, type: MetricType? = nil) -> Bool {
        let targetType = type ?? selectedMetricType
        guard let metric = metric?.lowercased() else { return true }
        return targetType.keywords.contains { metric.contains($0) }
    }
}
