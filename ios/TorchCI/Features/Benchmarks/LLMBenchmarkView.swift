import Charts
import SwiftUI

struct LLMBenchmarkView: View {
    let benchmarkId: String?

    @StateObject private var viewModel: LLMBenchmarkViewModel
    @State private var isFilterExpanded: Bool = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(benchmarkId: String?) {
        self.benchmarkId = benchmarkId
        _viewModel = StateObject(wrappedValue: LLMBenchmarkViewModel(benchmarkId: benchmarkId ?? "llm-benchmark"))
    }


    // MARK: - Body

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading where viewModel.timeSeriesData.isEmpty && viewModel.groupData == nil:
                LoadingView(message: "Loading LLM benchmarks...")

            case .error(let message) where viewModel.timeSeriesData.isEmpty:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.loadData() } }
                )

            default:
                llmContent
            }
        }
        .navigationTitle("LLM Benchmarks")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel.state == .idle {
                await viewModel.loadData()
            }
        }
    }

    // MARK: - Content

    private var llmContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                controlsSection

                filterSection

                summarySection

                chartSection

                if viewModel.isComparisonMode {
                    comparisonSection
                }

                modelDataSection
            }
            .padding()
        }
        .refreshable {
            await viewModel.loadData()
        }
        .overlay {
            if viewModel.state == .loading && !viewModel.timeSeriesData.isEmpty {
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

    // MARK: - Controls

    private var controlsSection: some View {
        VStack(spacing: 10) {
            HStack {
                BranchSelector(
                    branches: LLMBenchmarkViewModel.branches,
                    selectedBranch: $viewModel.selectedBranch
                )
                .onChange(of: viewModel.selectedBranch) { _, _ in
                    Task { await viewModel.loadData() }
                }

                Spacer()

                Toggle(isOn: $viewModel.isComparisonMode) {
                    Label("Compare", systemImage: "arrow.left.arrow.right")
                        .font(.caption.weight(.medium))
                }
                .toggleStyle(.button)
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            // Metric type picker
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(LLMBenchmarkViewModel.MetricType.allCases, id: \.self) { metric in
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.selectedMetricType = metric
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: metric.icon)
                                    .font(.caption2)
                                Text(metric.rawValue)
                                    .font(.caption)
                                    .fontWeight(viewModel.selectedMetricType == metric ? .semibold : .regular)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                viewModel.selectedMetricType == metric
                                    ? Color.accentColor
                                    : Color(.systemGray5)
                            )
                            .foregroundStyle(
                                viewModel.selectedMetricType == metric ? .white : .primary
                            )
                            .clipShape(Capsule())
                        }
                    }
                }
            }

            if !viewModel.availableModels.isEmpty {
                ModelPicker(
                    title: "Models",
                    models: viewModel.availableModels,
                    selectedModels: $viewModel.selectedModels
                )
            }
        }
    }

    // MARK: - Filters

    private var filterSection: some View {
        InfoCard(title: "Filters", icon: "slider.horizontal.3") {
            VStack(spacing: 0) {
                // Collapsed summary showing active filters
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isFilterExpanded.toggle()
                    }
                } label: {
                    HStack {
                        activeFilterSummary
                        Spacer()
                        Image(systemName: isFilterExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)

                if isFilterExpanded {
                    VStack(spacing: 12) {
                        Divider()
                            .padding(.vertical, 4)

                        FilterRow(
                            label: "Device",
                            icon: "cpu",
                            options: viewModel.availableDevices,
                            selection: $viewModel.selectedDevice
                        )
                        .onChange(of: viewModel.selectedDevice) { _, _ in
                            Task { await viewModel.loadData() }
                        }

                        FilterRow(
                            label: "Backend",
                            icon: "gearshape.2",
                            options: viewModel.availableBackends,
                            selection: $viewModel.selectedBackend
                        )
                        .onChange(of: viewModel.selectedBackend) { _, _ in
                            Task { await viewModel.loadData() }
                        }

                        FilterRow(
                            label: "Mode",
                            icon: "waveform",
                            options: viewModel.availableModes,
                            selection: $viewModel.selectedMode
                        )
                        .onChange(of: viewModel.selectedMode) { _, _ in
                            Task { await viewModel.loadData() }
                        }

                        FilterRow(
                            label: "DType",
                            icon: "number",
                            options: viewModel.availableDtypes,
                            selection: $viewModel.selectedDtype
                        )
                        .onChange(of: viewModel.selectedDtype) { _, _ in
                            Task { await viewModel.loadData() }
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var activeFilterSummary: some View {
        let activeFilters: [(String, String)] = [
            ("Device", viewModel.selectedDevice),
            ("Backend", viewModel.selectedBackend),
            ("Mode", viewModel.selectedMode),
            ("DType", viewModel.selectedDtype),
        ].filter { !$0.1.starts(with: "All ") }

        return Group {
            if activeFilters.isEmpty {
                Text("No active filters")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(activeFilters, id: \.0) { filter in
                            Text("\(filter.0): \(filter.1)")
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.accentColor.opacity(0.12))
                                .foregroundStyle(Color.accentColor)
                                .clipShape(Capsule())
                        }
                    }
                }
            }
        }
    }

    // MARK: - Summary

    private var summarySection: some View {
        let isCompact = sizeClass == .compact

        return VStack(spacing: 10) {
            if isCompact {
                compactSummaryContent
            } else {
                HStack(spacing: 10) {
                    summaryPanels
                }
            }
        }
    }

    @ViewBuilder
    private var compactSummaryContent: some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
        ], spacing: 10) {
            summaryPanels
        }
    }

    @ViewBuilder
    private var summaryPanels: some View {
        switch viewModel.selectedMetricType {
        case .throughput:
            if let stats = viewModel.throughputStats {
                ScalarPanel(
                    label: "Avg",
                    value: String(format: "%.1f", stats.avg),
                    icon: "arrow.up.right",
                    valueColor: .blue,
                    caption: "tokens/s"
                )

                ScalarPanel(
                    label: "Peak",
                    value: String(format: "%.1f", stats.max),
                    icon: "arrow.up",
                    valueColor: AppColors.success,
                    caption: "tokens/s"
                )

                ScalarPanel(
                    label: "Min",
                    value: String(format: "%.1f", stats.min),
                    icon: "arrow.down",
                    valueColor: AppColors.unstable,
                    caption: "tokens/s"
                )
            }

        case .latency:
            if let stats = viewModel.latencyStats {
                ScalarPanel(
                    label: "Avg",
                    value: String(format: "%.1f", stats.avg),
                    icon: "clock",
                    valueColor: .blue,
                    caption: "ms"
                )

                ScalarPanel(
                    label: "P99",
                    value: String(format: "%.1f", stats.p99),
                    icon: "arrow.up",
                    valueColor: AppColors.unstable,
                    caption: "ms"
                )

                ScalarPanel(
                    label: "Best",
                    value: String(format: "%.1f", stats.min),
                    icon: "arrow.down",
                    valueColor: AppColors.success,
                    caption: "ms"
                )
            }

        case .memory:
            if let stats = viewModel.memoryStats {
                ScalarPanel(
                    label: "Avg BW",
                    value: String(format: "%.2f", stats.avg),
                    icon: "memorychip",
                    valueColor: .blue,
                    caption: "GB/s"
                )

                ScalarPanel(
                    label: "Peak",
                    value: String(format: "%.2f", stats.max),
                    icon: "arrow.up",
                    valueColor: AppColors.success,
                    caption: "GB/s"
                )

                ScalarPanel(
                    label: "Min",
                    value: String(format: "%.2f", stats.min),
                    icon: "arrow.down",
                    valueColor: AppColors.unstable,
                    caption: "GB/s"
                )
            }

        case .compilation:
            if let stats = viewModel.compilationStats {
                ScalarPanel(
                    label: "Avg",
                    value: String(format: "%.2f", stats.avg),
                    icon: "hammer",
                    valueColor: .blue,
                    caption: "s"
                )

                ScalarPanel(
                    label: "Max",
                    value: String(format: "%.2f", stats.max),
                    icon: "arrow.up",
                    valueColor: AppColors.unstable,
                    caption: "s"
                )

                ScalarPanel(
                    label: "Best",
                    value: String(format: "%.2f", stats.min),
                    icon: "arrow.down",
                    valueColor: AppColors.success,
                    caption: "s"
                )
            }
        }

        if viewModel.selectedMetricType == .throughput && viewModel.throughputStats == nil ||
           viewModel.selectedMetricType == .latency && viewModel.latencyStats == nil ||
           viewModel.selectedMetricType == .memory && viewModel.memoryStats == nil ||
           viewModel.selectedMetricType == .compilation && viewModel.compilationStats == nil {
            ScalarPanel(
                label: "Models",
                value: "\(viewModel.availableModels.count)",
                icon: "cpu",
                valueColor: .blue
            )

            ScalarPanel(
                label: "Data Points",
                value: "\(viewModel.filteredTimeSeries.count)",
                icon: "chart.dots.scatter",
                valueColor: .purple
            )

            ScalarPanel(
                label: "Metric",
                value: viewModel.selectedMetricType.rawValue,
                icon: viewModel.selectedMetricType.icon
            )
        }
    }

    // MARK: - Chart

    private var chartSection: some View {
        InfoCard(
            title: "\(viewModel.selectedMetricType.rawValue) Over Time",
            icon: "chart.xyaxis.line"
        ) {
            BenchmarkChart(
                dataPoints: viewModel.filteredTimeSeries,
                metricLabel: "\(viewModel.selectedMetricType.rawValue) (\(viewModel.selectedMetricType.unit))",
                selectedPoint: viewModel.selectedPoint,
                onPointSelected: { point in
                    viewModel.selectedPoint = point
                }
            )

            if let point = viewModel.selectedPoint {
                selectedPointBanner(point)
            }
        }
    }

    private func selectedPointBanner(_ point: BenchmarkTimeSeriesPoint) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                if let model = point.model {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Model")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(model)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                    }
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 1) {
                    Text(viewModel.selectedMetricType.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(String(format: "%.2f %@", point.value, viewModel.selectedMetricType.unit))
                        .font(.caption.weight(.semibold).monospacedDigit())
                }
            }

            HStack {
                Text(String(point.commit.prefix(8)))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)

                Spacer()

                if let dateStr = point.commitDate {
                    Text(dateStr.prefix(10))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Comparison

    private var comparisonSection: some View {
        InfoCard(title: "Model Comparison", icon: "arrow.left.arrow.right") {
            if viewModel.filteredGroupPoints.isEmpty {
                emptyState
            } else {
                Chart(viewModel.filteredGroupPoints.prefix(20)) { point in
                    BarMark(
                        x: .value("Value", point.value),
                        y: .value("Model", point.name)
                    )
                    .foregroundStyle(barColor(for: point))
                    .cornerRadius(4)

                    if let baseline = point.baseline {
                        RuleMark(x: .value("Baseline", baseline))
                            .foregroundStyle(.secondary.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                            .foregroundStyle(.secondary.opacity(0.3))
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .frame(height: CGFloat(min(viewModel.filteredGroupPoints.prefix(20).count, 20) * 32 + 40))
            }
        }
    }

    // MARK: - Model Data Table

    private var modelDataSection: some View {
        InfoCard(title: "Model Results", icon: "tablecells") {
            if viewModel.filteredGroupPoints.isEmpty {
                emptyState
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(spacing: 0) {
                        // Header
                        HStack(spacing: 0) {
                            Text("Model")
                                .font(.caption.weight(.semibold))
                                .frame(width: 140, alignment: .leading)
                            Text("Value")
                                .font(.caption.weight(.semibold))
                                .frame(width: 74, alignment: .trailing)
                            Text("Baseline")
                                .font(.caption.weight(.semibold))
                                .frame(width: 74, alignment: .trailing)
                            Text("Change")
                                .font(.caption.weight(.semibold))
                                .frame(width: 68, alignment: .trailing)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground))

                        Divider()

                        ForEach(viewModel.filteredGroupPoints.prefix(50)) { point in
                            VStack(spacing: 0) {
                                HStack(spacing: 0) {
                                    Text(point.name)
                                        .font(.caption)
                                        .lineLimit(1)
                                        .frame(width: 140, alignment: .leading)

                                    Text(formatValue(point.value))
                                        .font(.system(.caption, design: .monospaced))
                                        .frame(width: 74, alignment: .trailing)

                                    Text(point.baseline.map { formatValue($0) } ?? "--")
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 74, alignment: .trailing)

                                    changeCell(for: point)
                                        .frame(width: 68, alignment: .trailing)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)

                                Divider()
                            }
                        }

                        if viewModel.filteredGroupPoints.count > 50 {
                            Text("Showing 50 of \(viewModel.filteredGroupPoints.count) rows")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                    }
                    .frame(minWidth: 356)
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(.separator).opacity(0.3), lineWidth: 1)
                )
            }
        }
    }

    @ViewBuilder
    private func changeCell(for point: BenchmarkDataPoint) -> some View {
        if let change = point.changePercent {
            HStack(spacing: 2) {
                Image(systemName: change > 0 ? "arrow.up.right" : change < 0 ? "arrow.down.right" : "minus")
                    .font(.system(size: 8, weight: .bold))
                Text(String(format: "%.1f%%", abs(change)))
                    .font(.system(.caption, design: .monospaced).weight(.medium))
            }
            .foregroundStyle(changeColor(change))
        } else {
            Text("--")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.bar.xaxis")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No data available")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 120)
    }

    // MARK: - Helpers

    private func barColor(for point: BenchmarkDataPoint) -> Color {
        if let speedup = point.speedup {
            if speedup >= 1.05 { return AppColors.success }
            if speedup < 0.95 { return AppColors.failure }
        }
        return Color.accentColor
    }

    private func changeColor(_ change: Double) -> Color {
        // For throughput, memory, higher is better; for latency and compilation, lower is better
        let isGood: Bool
        switch viewModel.selectedMetricType {
        case .throughput, .memory:
            isGood = change > 0
        case .latency, .compilation:
            isGood = change < 0
        }
        if abs(change) < 1 { return .primary }
        return isGood ? AppColors.success : AppColors.failure
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

// MARK: - Filter Row Component

private struct FilterRow: View {
    let label: String
    let icon: String
    let options: [String]
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 12) {
            Label(label, systemImage: icon)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)

            Menu {
                ForEach(options, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        HStack {
                            Text(option)
                            if selection == option {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack {
                    Text(selection)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

#Preview {
    NavigationStack {
        LLMBenchmarkView(benchmarkId: "llm-benchmark")
    }
}
