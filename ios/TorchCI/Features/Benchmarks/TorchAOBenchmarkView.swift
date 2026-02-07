import Charts
import SwiftUI

struct TorchAOBenchmarkView: View {
    let benchmarkId: String?

    @StateObject private var viewModel: TorchAOBenchmarkViewModel

    init(benchmarkId: String?) {
        self.benchmarkId = benchmarkId
        _viewModel = StateObject(wrappedValue: TorchAOBenchmarkViewModel())
    }

    // MARK: - Body

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading where viewModel.groupData == nil:
                LoadingView(message: "Loading TorchAO benchmarks...")

            case .error(let message) where viewModel.groupData == nil:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.loadData() } }
                )

            default:
                torchAOContent
            }
        }
        .navigationTitle("TorchAO Performance")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel.state == .idle {
                await viewModel.loadData()
            }
        }
    }

    // MARK: - Content

    private var torchAOContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                filtersSection

                summaryCardsSection

                if viewModel.filteredDataPoints.isEmpty {
                    noDataView
                } else {
                    speedupChartSection

                    comparisonChartSection

                    dataTableSection
                }
            }
            .padding()
        }
        .refreshable {
            await viewModel.loadData()
        }
        .overlay {
            if viewModel.state == .loading && viewModel.groupData != nil {
                VStack {
                    InlineLoadingView()
                        .padding(8)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                    Spacer()
                }
                .padding(.top, 8)
            }
        }
    }

    private var noDataView: some View {
        InfoCard(title: "No Data", icon: "chart.bar.xaxis") {
            EmptyStateView(
                icon: "chart.bar.xaxis",
                title: "No Results",
                message: "No data available for the selected filters."
            )
            .frame(height: 160)
        }
    }

    // MARK: - Filters

    private var filtersSection: some View {
        InfoCard(title: "Filters", icon: "slider.horizontal.3") {
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    filterPicker(
                        title: "Suite",
                        icon: "folder",
                        selection: $viewModel.selectedSuite,
                        options: viewModel.availableSuites
                    )

                    filterPicker(
                        title: "Quantization",
                        icon: "gauge.with.dots.needle.33percent",
                        selection: $viewModel.selectedQuantization,
                        options: viewModel.availableQuantizations
                    )
                }

                HStack(spacing: 12) {
                    filterPicker(
                        title: "Mode",
                        icon: "waveform",
                        selection: $viewModel.selectedMode,
                        options: viewModel.availableModes
                    )

                    filterPicker(
                        title: "Device",
                        icon: "cpu",
                        selection: $viewModel.selectedDevice,
                        options: viewModel.availableDevices
                    )
                }
            }
        }
    }

    private func filterPicker(title: String, icon: String, selection: Binding<String>, options: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: icon)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            Menu {
                ForEach(options, id: \.self) { option in
                    Button {
                        selection.wrappedValue = option
                    } label: {
                        HStack {
                            Text(option.capitalized)
                            if selection.wrappedValue == option {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack {
                    Text(selection.wrappedValue.capitalized)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Summary Cards

    private let summaryColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    private var summaryCardsSection: some View {
        LazyVGrid(columns: summaryColumns, spacing: 10) {
            MetricCard(
                title: "Models",
                value: "\(viewModel.modelCount)",
                subtitle: viewModel.selectedSuite.capitalized
            )

            MetricCard(
                title: "Avg Speedup",
                value: viewModel.averageSpeedup.map { String(format: "%.2fx", $0) } ?? "--",
                subtitle: viewModel.averageSpeedup.map { $0 >= 1.0 ? "Improved" : "Regressed" },
                valueColor: viewModel.averageSpeedup.map { speedupValueColor($0) } ?? .primary,
                trend: viewModel.averageSpeedup.map { ($0 - 1.0) * 100 },
                trendIsGoodWhenNegative: false
            )

            MetricCard(
                title: "Pass Rate",
                value: viewModel.passRate.map { String(format: "%.1f%%", $0) } ?? "--",
                subtitle: "Successful runs",
                valueColor: viewModel.passRate.map { $0 >= 90 ? AppColors.success : ($0 >= 70 ? AppColors.unstable : AppColors.failure) } ?? .primary
            )

            MetricCard(
                title: "Memory Savings",
                value: viewModel.averageMemorySavings.map { String(format: "%.1f%%", $0) } ?? "--",
                subtitle: "vs baseline",
                trend: viewModel.averageMemorySavings,
                trendIsGoodWhenNegative: false
            )
        }
    }

    // MARK: - Speedup Chart (Horizontal Bars)

    private var speedupChartSection: some View {
        InfoCard(title: "Speedup by Model", icon: "chart.bar.fill") {
            VStack(spacing: 8) {
                let topModels = Array(viewModel.filteredDataPoints.prefix(15))
                let chartHeight = CGFloat(max(topModels.count * 28 + 40, 120))

                Chart(topModels) { point in
                    BarMark(
                        x: .value("Speedup", point.speedup ?? 1.0),
                        y: .value("Model", point.name)
                    )
                    .foregroundStyle(speedupColor(point.speedup))
                    .cornerRadius(3)

                    RuleMark(x: .value("Baseline", 1.0))
                        .foregroundStyle(.secondary.opacity(0.5))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 5]))
                }
                .chartXAxis {
                    AxisMarks(position: .bottom, values: .automatic(desiredCount: 5)) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                            .foregroundStyle(.secondary.opacity(0.3))
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.system(size: 9))
                    }
                }
                .chartXScale(domain: viewModel.chartXDomain)
                .frame(height: chartHeight)

                // Legend
                HStack(spacing: 16) {
                    legendDot(color: AppColors.success, label: ">1.05x")
                    legendDot(color: .primary, label: "0.95-1.05x")
                    legendDot(color: AppColors.failure, label: "<0.95x")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                Text("Baseline = 1.0x \u{2022} \(viewModel.selectedQuantization.capitalized) quantization")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                if viewModel.filteredDataPoints.count > 15 {
                    Text("Showing top 15 of \(viewModel.filteredDataPoints.count) models")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func legendDot(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
        }
    }

    // MARK: - Comparison Chart (Horizontal Bars)

    private var comparisonChartSection: some View {
        InfoCard(title: "Quantization Comparison", icon: "arrow.left.arrow.right") {
            VStack(spacing: 8) {
                if viewModel.quantizationComparison.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "chart.bar.xaxis")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("No quantization comparison data available")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                } else {
                    let barCount = viewModel.quantizationComparison.count
                    let chartHeight = CGFloat(max(barCount * 36 + 40, 120))

                    Chart {
                        ForEach(viewModel.quantizationComparison, id: \.quantization) { item in
                            BarMark(
                                x: .value("Avg Speedup", item.avgSpeedup),
                                y: .value("Quantization", item.quantization)
                            )
                            .foregroundStyle(by: .value("Type", item.quantization))
                            .cornerRadius(4)
                            .annotation(position: .trailing, spacing: 4) {
                                Text(String(format: "%.2fx", item.avgSpeedup))
                                    .font(.caption2.weight(.medium).monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .chartXAxis {
                        AxisMarks(position: .bottom, values: .automatic(desiredCount: 5)) { _ in
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                .foregroundStyle(.secondary.opacity(0.3))
                            AxisValueLabel()
                                .font(.caption2)
                        }
                    }
                    .chartYAxis {
                        AxisMarks { _ in
                            AxisValueLabel()
                                .font(.caption)
                        }
                    }
                    .chartXScale(domain: 0...viewModel.maxComparisonSpeedup)
                    .chartLegend(.hidden)
                    .frame(height: chartHeight)

                    Text("Average speedup across all models in \(viewModel.selectedSuite)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Data Table

    private var dataTableSection: some View {
        InfoCard(title: "Detailed Results (\(viewModel.filteredDataPoints.count))", icon: "tablecells.fill") {
            VStack(spacing: 0) {
                // Header with sort toggle
                HStack(spacing: 4) {
                    Text("Model")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.sortBySpeedup.toggle()
                        }
                    } label: {
                        HStack(spacing: 2) {
                            Text("Speedup")
                                .font(.caption.weight(.semibold))
                            Image(systemName: viewModel.sortBySpeedup ? "arrow.down" : "arrow.up.arrow.down")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(viewModel.sortBySpeedup ? Color.accentColor : .secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width: 70, alignment: .trailing)

                    Text("Value")
                        .font(.caption.weight(.semibold))
                        .frame(width: 52, alignment: .trailing)

                    Text("Status")
                        .font(.caption.weight(.semibold))
                        .frame(width: 40, alignment: .center)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))

                Divider()

                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(viewModel.sortedDataPoints) { point in
                            dataRow(point)
                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 400)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(.separator).opacity(0.3), lineWidth: 1)
            )
        }
    }

    private func dataRow(_ point: BenchmarkDataPoint) -> some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(point.name)
                    .font(.caption)
                    .lineLimit(1)
                if let metric = point.metric {
                    Text(metric)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            speedupBadge(point.speedup)
                .frame(width: 70, alignment: .trailing)

            Text(formatAccuracy(point.value))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 52, alignment: .trailing)

            statusBadge(for: point)
                .frame(width: 40, alignment: .center)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(rowBackground(for: point))
    }

    private func speedupBadge(_ speedup: Double?) -> some View {
        Group {
            if let speedup {
                Text(String(format: "%.2fx", speedup))
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(speedupColor(speedup).opacity(0.12))
                    .foregroundStyle(speedupColor(speedup))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Text("--")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func statusBadge(for point: BenchmarkDataPoint) -> some View {
        Group {
            if let status = point.status {
                statusIconView(status)
            } else if let speedup = point.speedup {
                if speedup >= 1.05 {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(AppColors.success)
                } else if speedup < 0.95 {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(AppColors.failure)
                } else {
                    Image(systemName: "minus.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func statusIconView(_ status: String) -> some View {
        switch status.lowercased() {
        case "pass", "passed":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(AppColors.success)
        case "fail", "failed":
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(AppColors.failure)
        default:
            Image(systemName: "minus.circle.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func formatAccuracy(_ value: Double) -> String {
        if value >= 99.0 {
            return String(format: "%.2f%%", value)
        } else if value >= 1.0 {
            return String(format: "%.1f%%", value)
        } else if value > 0 {
            return String(format: "%.3f", value)
        }
        return "--"
    }

    // MARK: - Helpers

    private func speedupColor(_ speedup: Double?) -> Color {
        guard let speedup else { return .secondary }
        if speedup >= 1.05 { return AppColors.success }
        if speedup < 0.95 { return AppColors.failure }
        return .primary
    }

    private func speedupValueColor(_ speedup: Double) -> Color {
        if speedup >= 1.05 { return AppColors.success }
        if speedup < 0.95 { return AppColors.failure }
        return .primary
    }

    private func rowBackground(for point: BenchmarkDataPoint) -> Color {
        guard let speedup = point.speedup else { return .clear }
        if speedup >= 1.05 { return AppColors.success.opacity(0.04) }
        if speedup < 0.95 { return AppColors.failure.opacity(0.04) }
        return .clear
    }

    private func formatValue(_ value: Double) -> String {
        if value >= 1_000_000 {
            return String(format: "%.2fM", value / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fK", value / 1_000)
        } else if value < 0.01 && value > 0 {
            return String(format: "%.4f", value)
        } else {
            return String(format: "%.2f", value)
        }
    }
}

// MARK: - ViewModel

@MainActor
final class TorchAOBenchmarkViewModel: ObservableObject {
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
    @Published var groupData: BenchmarkGroupData?

    @Published var selectedSuite: String = "all"
    @Published var selectedQuantization: String = "all"
    @Published var selectedMode: String = "inference"
    @Published var selectedDevice: String = "cuda"
    @Published var sortBySpeedup: Bool = true

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Filter Options

    var availableSuites: [String] {
        ["all", "torchbench", "huggingface", "timm_models"]
    }

    var availableQuantizations: [String] {
        ["all", "autoquant", "int8dynamic", "int8weightonly", "noquant"]
    }

    var availableModes: [String] {
        ["inference", "training"]
    }

    var availableDevices: [String] {
        ["cuda", "cpu"]
    }

    // MARK: - Filtered Data

    var filteredDataPoints: [BenchmarkDataPoint] {
        guard let data = groupData?.data else { return [] }

        return data.filter { point in
            var matches = true

            if selectedSuite != "all" {
                matches = matches && (point.name.lowercased().contains(selectedSuite.lowercased()) ||
                                      point.metric?.lowercased().contains(selectedSuite.lowercased()) ?? false)
            }

            if selectedQuantization != "all" {
                matches = matches && (point.name.lowercased().contains(selectedQuantization.lowercased()) ||
                                      point.metric?.lowercased().contains(selectedQuantization.lowercased()) ?? false)
            }

            return matches
        }
        .sorted { ($0.speedup ?? 1.0) > ($1.speedup ?? 1.0) }
    }

    /// Data points with the user-selected sort applied (speedup descending or alphabetical).
    var sortedDataPoints: [BenchmarkDataPoint] {
        if sortBySpeedup {
            return filteredDataPoints
        } else {
            return filteredDataPoints.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    // MARK: - Computed Metrics

    var modelCount: Int {
        filteredDataPoints.count
    }

    var averageSpeedup: Double? {
        let speedups = filteredDataPoints.compactMap(\.speedup)
        guard !speedups.isEmpty else { return nil }
        return speedups.reduce(0.0, +) / Double(speedups.count)
    }

    var passRate: Double? {
        guard !filteredDataPoints.isEmpty else { return nil }
        let passed = filteredDataPoints.filter { point in
            if let speedup = point.speedup {
                return speedup >= 0.95
            }
            return false
        }.count
        return (Double(passed) / Double(filteredDataPoints.count)) * 100
    }

    var averageMemorySavings: Double? {
        let savings = filteredDataPoints.compactMap { point -> Double? in
            guard let baseline = point.baseline, baseline > 0 else { return nil }
            return ((baseline - point.value) / baseline) * 100
        }
        guard !savings.isEmpty else { return nil }
        return savings.reduce(0.0, +) / Double(savings.count)
    }

    /// X-axis domain for the horizontal speedup chart.
    var chartXDomain: ClosedRange<Double> {
        let speedups = filteredDataPoints.prefix(15).compactMap(\.speedup)
        guard let minVal = speedups.min(), let maxVal = speedups.max() else {
            return 0.5...2.0
        }
        let padding = (maxVal - minVal) * 0.15
        return max(0, minVal - padding)...(maxVal + padding)
    }

    // MARK: - Quantization Comparison

    struct QuantizationStats: Identifiable {
        let quantization: String
        let avgSpeedup: Double
        let modelCount: Int

        var id: String { quantization }
    }

    var quantizationComparison: [QuantizationStats] {
        guard let data = groupData?.data else { return [] }

        let quantizations = ["autoquant", "int8dynamic", "int8weightonly", "noquant"]
        var stats: [QuantizationStats] = []

        for quant in quantizations {
            let filtered = data.filter { point in
                point.name.lowercased().contains(quant.lowercased()) ||
                point.metric?.lowercased().contains(quant.lowercased()) ?? false
            }
            let speedups = filtered.compactMap(\.speedup)
            if !speedups.isEmpty {
                let avg = speedups.reduce(0.0, +) / Double(speedups.count)
                stats.append(QuantizationStats(quantization: quant, avgSpeedup: avg, modelCount: speedups.count))
            }
        }

        return stats.sorted { $0.avgSpeedup > $1.avgSpeedup }
    }

    var maxComparisonSpeedup: Double {
        let maxSpeedup = quantizationComparison.map(\.avgSpeedup).max() ?? 2.0
        return maxSpeedup * 1.1
    }

    // MARK: - Actions

    func loadData() async {
        state = .loading

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let now = Date()
        let startDate = Calendar.current.date(byAdding: .day, value: -7, to: now) ?? now

        do {
            // Use the torchao_query ClickHouse query directly.
            // Parameters must match clickhouse_queries/torchao_query/params.json exactly:
            //   branches: Array(String), commits: Array(String), device: String,
            //   dtypes: Array(String), granularity: String, mode: String,
            //   repo: String, startTime: DateTime64(3), stopTime: DateTime64(3),
            //   suites: Array(String), workflowId: Int64
            let parameters: [String: Any] = [
                "branches": ["main"],
                "commits": [] as [String],
                "device": selectedDevice,
                "dtypes": selectedQuantization == "all"
                    ? ["autoquant", "int8dynamic", "int8weightonly", "noquant"]
                    : [selectedQuantization],
                "granularity": "hour",
                "mode": selectedMode,
                "repo": "pytorch/ao",
                "startTime": dateFormatter.string(from: startDate),
                "stopTime": dateFormatter.string(from: now),
                "suites": selectedSuite == "all"
                    ? ["torchbench", "huggingface", "timm_models"]
                    : [selectedSuite],
                "workflowId": 0,
            ]

            // The ClickHouse API returns a plain JSON array of raw rows.
            // Each row has: suite, model, dtype, metric, value, extra_info,
            //               workflow_id, job_id, granularity_bucket
            let rawRows: [TorchAORawRow] = try await apiClient.fetch(
                APIEndpoint.clickhouseQuery(name: "torchao_query", parameters: parameters)
            )
            groupData = Self.pivotRawRows(rawRows)
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Pivots raw ClickHouse rows into aggregated BenchmarkGroupData.
    /// Groups by (workflow_id, model, dtype) and extracts speedup/accuracy/etc.
    /// Keeps only the latest workflow per (model, dtype) group.
    static func pivotRawRows(_ rawRows: [TorchAORawRow]) -> BenchmarkGroupData {
        // Group by (workflow_id, model, dtype) and pivot metrics
        struct MutableRecord {
            let name: String
            let suite: String
            let dtype: String
            let workflowId: Int
            var speedup: Double?
            var accuracy: String?
            var compressionRatio: Double?
            var absLatency: Double?
        }

        var grouped: [String: MutableRecord] = [:]
        for row in rawRows {
            let key = "\(row.workflowId) \(row.model) \(row.dtype)"
            if grouped[key] == nil {
                grouped[key] = MutableRecord(
                    name: row.model,
                    suite: row.suite,
                    dtype: row.dtype,
                    workflowId: row.workflowId
                )
            }
            switch row.metric {
            case "speedup":
                grouped[key]?.speedup = row.value
            case "accuracy":
                grouped[key]?.accuracy = "pass" // if it has accuracy data, it passed
            case "compression_ratio":
                grouped[key]?.compressionRatio = row.value
            case "abs_latency":
                grouped[key]?.absLatency = row.value
            default:
                break
            }
        }

        // Keep latest workflow per (model, dtype)
        var latestByModel: [String: MutableRecord] = [:]
        for entry in grouped.values {
            let modelKey = "\(entry.name)-\(entry.dtype)"
            if let existing = latestByModel[modelKey] {
                if entry.workflowId > existing.workflowId {
                    latestByModel[modelKey] = entry
                }
            } else {
                latestByModel[modelKey] = entry
            }
        }

        let dataPoints: [BenchmarkDataPoint] = latestByModel.values.map { record in
            BenchmarkDataPoint(
                name: record.name,
                metric: record.dtype,
                value: record.absLatency ?? 0,
                baseline: 1.0,
                speedup: record.speedup,
                status: (record.speedup ?? 0) >= 0.95 ? "pass" : "fail"
            )
        }

        return BenchmarkGroupData(data: dataPoints, metadata: nil)
    }
}

// MARK: - Raw Row Model

/// Raw row returned by the `torchao_query` ClickHouse query.
/// Columns: suite, model, dtype, metric, value, extra_info, workflow_id, job_id, granularity_bucket
struct TorchAORawRow: Decodable {
    let suite: String
    let model: String
    let dtype: String
    let metric: String
    let value: Double
    let workflowId: Int
    let jobId: Int?
    let granularityBucket: String

    enum CodingKeys: String, CodingKey {
        case suite, model, dtype, metric, value
        case workflowId = "workflow_id"
        case jobId = "job_id"
        case granularityBucket = "granularity_bucket"
    }
}

#Preview {
    NavigationStack {
        TorchAOBenchmarkView(benchmarkId: nil)
    }
}
