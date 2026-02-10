import Charts
import SwiftUI
import UIKit

struct BenchmarkDashboardView: View {
    @StateObject private var viewModel: BenchmarkDashboardViewModel

    init(benchmark: BenchmarkMetadata) {
        _viewModel = StateObject(wrappedValue: BenchmarkDashboardViewModel(benchmark: benchmark))
    }

    @State private var selectedPoint: BenchmarkTimeSeriesPoint?

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading where viewModel.timeSeriesData.isEmpty:
                LoadingView(message: "Loading benchmark data...")

            case .error(let message) where viewModel.timeSeriesData.isEmpty:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.refresh() } }
                )

            default:
                dashboardContent
            }
        }
        .navigationTitle(viewModel.benchmark.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel.state == .idle {
                await viewModel.loadData()
            }
        }
    }

    // MARK: - Dashboard Content

    private var dashboardContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let partialError = viewModel.partialLoadError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(partialError)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Retry") {
                            viewModel.partialLoadError = nil
                            Task { await viewModel.loadData() }
                        }
                        .font(.caption.weight(.medium))
                        Button("Dismiss") {
                            viewModel.partialLoadError = nil
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .padding(.horizontal)
                }

                filtersSection

                // Quick insights
                if !viewModel.filteredTimeSeries.isEmpty {
                    insightsSection
                }

                summaryCardsSection

                trendIndicatorSection

                chartSection

                if let comparison = viewModel.comparisonData {
                    comparisonSection(comparison)
                }

                statisticsSection

                if viewModel.hasRegressions {
                    regressionsSection
                }

                dataTableSection
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
        .overlay {
            if viewModel.isLoading && !viewModel.timeSeriesData.isEmpty {
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

    // MARK: - Filters

    private var filtersSection: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                BranchSelector(
                    branches: BenchmarkDashboardViewModel.branches,
                    selectedBranch: $viewModel.selectedBranch
                )
                .onChange(of: viewModel.selectedBranch) { _, _ in
                    Task { await viewModel.refresh() }
                }

                Spacer()

                granularityPicker

                dateRangePicker
            }

            if !viewModel.availableMetrics.isEmpty {
                metricPicker
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

    private var granularityPicker: some View {
        Menu {
            ForEach(BenchmarkDashboardViewModel.granularityOptions, id: \.self) { option in
                Button {
                    viewModel.selectedGranularity = option
                    Task { await viewModel.refresh() }
                } label: {
                    HStack {
                        Text(option.capitalized)
                        if viewModel.selectedGranularity == option {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .font(.caption)
                Text(viewModel.selectedGranularity.capitalized)
                    .font(.subheadline.weight(.medium))
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var dateRangePicker: some View {
        Menu {
            Button("Last 7 Days") {
                let end = Date()
                let start = Calendar.current.date(byAdding: .day, value: -7, to: end) ?? end
                viewModel.updateDateRange(start: start, end: end)
            }
            Button("Last 14 Days") {
                let end = Date()
                let start = Calendar.current.date(byAdding: .day, value: -14, to: end) ?? end
                viewModel.updateDateRange(start: start, end: end)
            }
            Button("Last 30 Days") {
                let end = Date()
                let start = Calendar.current.date(byAdding: .day, value: -30, to: end) ?? end
                viewModel.updateDateRange(start: start, end: end)
            }
            Button("Last 90 Days") {
                let end = Date()
                let start = Calendar.current.date(byAdding: .day, value: -90, to: end) ?? end
                viewModel.updateDateRange(start: start, end: end)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "calendar")
                    .font(.caption)
                Text(dateRangeLabel)
                    .font(.subheadline.weight(.medium))
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var dateRangeLabel: String {
        let days = Calendar.current.dateComponents([.day], from: viewModel.startDate, to: viewModel.endDate).day ?? 30
        return "\(max(0, days))d"
    }

    private var metricPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(viewModel.availableMetrics, id: \.self) { metric in
                    Button {
                        viewModel.selectMetric(metric)
                    } label: {
                        Text(metric)
                            .font(.caption)
                            .fontWeight(viewModel.selectedMetric == metric ? .semibold : .regular)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                viewModel.selectedMetric == metric
                                    ? Color.accentColor
                                    : Color(.systemGray5)
                            )
                            .foregroundStyle(
                                viewModel.selectedMetric == metric ? .white : .primary
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 1)
        }
    }

    // MARK: - Insights

    private var insightsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lightbulb.fill")
                    .font(.caption)
                    .foregroundStyle(.yellow)
                Text("Key Insights")
                    .font(.subheadline.weight(.semibold))
            }

            VStack(alignment: .leading, spacing: 6) {
                // Performance insight
                insightRow(
                    icon: viewModel.performanceTrend.icon,
                    color: viewModel.performanceTrend.color,
                    text: "Performance is \(viewModel.performanceTrend.label.lowercased()) over the selected period"
                )

                // Variance insight
                insightRow(
                    icon: viewModel.varianceLevel.icon,
                    color: viewModel.varianceLevel.color,
                    text: viewModel.varianceLevel.description
                )

                // Regression insight
                if viewModel.hasRegressions {
                    insightRow(
                        icon: "exclamationmark.triangle.fill",
                        color: AppColors.failure,
                        text: "\(viewModel.totalRegressionCount) regression\(viewModel.totalRegressionCount == 1 ? "" : "s") detected"
                    )
                }

                // Data quality insight
                if let comparison = viewModel.comparisonData {
                    let absChange = abs(comparison.changePercent)
                    if absChange > 10 {
                        insightRow(
                            icon: "chart.line.uptrend.xyaxis",
                            color: comparison.isRegression ? AppColors.failure : AppColors.success,
                            text: String(format: "%.1f%% %@ from baseline to current", absChange, comparison.changePercent > 0 ? "increase" : "decrease")
                        )
                    }
                }
            }
        }
        .padding(12)
        .background(
            LinearGradient(
                colors: [Color.yellow.opacity(0.08), Color.orange.opacity(0.06)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.yellow.opacity(0.2), lineWidth: 1)
        )
    }

    private func insightRow(icon: String, color: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(color)
                .frame(width: 16)

            Text(text)
                .font(.caption)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Summary Cards

    private var summaryCardsSection: some View {
        VStack(spacing: 10) {
            // First row
            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Data Points",
                    value: "\(viewModel.filteredTimeSeries.count)",
                    icon: "chart.dots.scatter",
                    valueColor: .blue
                )

                ScalarPanel(
                    label: "Regressions",
                    value: "\(viewModel.totalRegressionCount)",
                    icon: "exclamationmark.triangle",
                    valueColor: viewModel.hasRegressions ? AppColors.failure : AppColors.success
                )

                if let latest = viewModel.filteredTimeSeries.last {
                    ScalarPanel(
                        label: "Latest",
                        value: formatValue(latest.value),
                        icon: "arrow.right.circle",
                        valueColor: .primary
                    )
                } else {
                    ScalarPanel(
                        label: "Latest",
                        value: "--",
                        icon: "arrow.right.circle"
                    )
                }
            }

            // Second row - Key statistics
            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Mean",
                    value: formatValue(viewModel.statistics.mean),
                    icon: "target",
                    valueColor: .purple
                )

                ScalarPanel(
                    label: "Median",
                    value: formatValue(viewModel.statistics.median),
                    icon: "line.3.horizontal.decrease",
                    valueColor: .orange
                )

                ScalarPanel(
                    label: "P95",
                    value: formatValue(viewModel.statistics.p95),
                    icon: "chart.line.uptrend.xyaxis",
                    valueColor: .teal
                )
            }
        }
    }

    // MARK: - Chart

    @State private var showStatisticsOverlay: Bool = false

    private var chartSection: some View {
        InfoCard(title: viewModel.selectedMetric.isEmpty ? "Performance" : viewModel.selectedMetric, icon: "chart.xyaxis.line") {
            VStack(spacing: 12) {
                // Chart controls
                HStack {
                    Text("\(viewModel.filteredTimeSeries.count) data points")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button {
                        showStatisticsOverlay.toggle()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: showStatisticsOverlay ? "chart.bar.fill" : "chart.bar")
                                .font(.caption)
                            Text(showStatisticsOverlay ? "Hide Stats" : "Show Stats")
                                .font(.caption.weight(.medium))
                        }
                        .foregroundStyle(.blue)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.blue.opacity(0.1))
                        .clipShape(Capsule())
                    }
                }

                BenchmarkChart(
                    dataPoints: viewModel.filteredTimeSeries,
                    metricLabel: viewModel.selectedMetric.isEmpty ? "Value" : viewModel.selectedMetric,
                    regressionCommits: viewModel.regressionCommits,
                    selectedPoint: selectedPoint,
                    onPointSelected: { point in
                        selectedPoint = point
                    }
                )

                if showStatisticsOverlay {
                    statisticsOverlay
                }

                if let point = selectedPoint {
                    selectedPointDetail(point)
                }
            }
        }
    }

    private var statisticsOverlay: some View {
        VStack(spacing: 8) {
            Text("Distribution Guide")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(.orange)
                        .frame(width: 8, height: 8)
                    Text("Mean: \(formatValue(viewModel.statistics.mean))")
                        .font(.caption)
                }

                HStack(spacing: 6) {
                    Circle()
                        .fill(.purple)
                        .frame(width: 8, height: 8)
                    Text("Median: \(formatValue(viewModel.statistics.median))")
                        .font(.caption)
                }

                Spacer()
            }
            .foregroundStyle(.secondary)

            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    Rectangle()
                        .fill(.blue.opacity(0.3))
                        .frame(width: 12, height: 8)
                    Text("P25-P75 Range")
                        .font(.caption)
                }

                HStack(spacing: 6) {
                    Rectangle()
                        .fill(.red.opacity(0.2))
                        .frame(width: 12, height: 8)
                    Text("Outliers (>P95)")
                        .font(.caption)
                }

                Spacer()
            }
            .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func selectedPointDetail(_ point: BenchmarkTimeSeriesPoint) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Value")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(formatValue(point.value))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                }

                if let model = point.model {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Model")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(model)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Commit")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(String(point.commit.prefix(7)))
                        .font(.system(.caption, design: .monospaced))
                }
            }

            // Show comparison to mean/median
            if !viewModel.filteredTimeSeries.isEmpty {
                Divider()

                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("vs Mean")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        let meanDiff = viewModel.statistics.mean != 0
                            ? ((point.value - viewModel.statistics.mean) / viewModel.statistics.mean) * 100
                            : 0
                        HStack(spacing: 3) {
                            Image(systemName: meanDiff > 0 ? "arrow.up" : "arrow.down")
                                .font(.caption2)
                            Text(String(format: "%.1f%%", abs(meanDiff)))
                                .font(.caption.weight(.medium).monospacedDigit())
                        }
                        .foregroundStyle(meanDiff > 0 ? AppColors.failure : AppColors.success)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("vs Median")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        let medianDiff = viewModel.statistics.median != 0
                            ? ((point.value - viewModel.statistics.median) / viewModel.statistics.median) * 100
                            : 0
                        HStack(spacing: 3) {
                            Image(systemName: medianDiff > 0 ? "arrow.up" : "arrow.down")
                                .font(.caption2)
                            Text(String(format: "%.1f%%", abs(medianDiff)))
                                .font(.caption.weight(.medium).monospacedDigit())
                        }
                        .foregroundStyle(medianDiff > 0 ? AppColors.failure : AppColors.success)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Trend Indicator

    private var trendIndicatorSection: some View {
        HStack(spacing: 12) {
            // Performance Trend
            HStack(spacing: 8) {
                Image(systemName: viewModel.performanceTrend.icon)
                    .font(.title3)
                    .foregroundStyle(viewModel.performanceTrend.color)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Performance Trend")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(viewModel.performanceTrend.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(viewModel.performanceTrend.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()
                .frame(height: 40)

            // Variance Level
            HStack(spacing: 8) {
                Image(systemName: viewModel.varianceLevel.icon)
                    .font(.title3)
                    .foregroundStyle(viewModel.varianceLevel.color)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Data Stability")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(viewModel.varianceLevel.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(viewModel.varianceLevel.color)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Comparison

    private func comparisonSection(_ comparison: BenchmarkComparison) -> some View {
        InfoCard(title: "Baseline Comparison", icon: "arrow.left.arrow.right") {
            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    // Baseline
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Baseline")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        Text(formatValue(comparison.baseline.value))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)

                        Text(String(comparison.baseline.commit.prefix(7)))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    // Arrow with change percentage
                    VStack(spacing: 4) {
                        Image(systemName: comparison.isRegression ? "arrow.right" : "arrow.right")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(comparison.isRegression ? AppColors.failure : AppColors.success)

                        Text(String(format: "%+.1f%%", comparison.changePercent))
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(comparison.isRegression ? AppColors.failure : AppColors.success)
                    }

                    // Current
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Current")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        Text(formatValue(comparison.current.value))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)

                        Text(String(comparison.current.commit.prefix(7)))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                // Change metrics row
                HStack(spacing: 0) {
                    VStack(spacing: 3) {
                        Text("Change")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 2) {
                            Image(systemName: comparison.changePercent > 0 ? "arrow.up" : "arrow.down")
                                .font(.caption2)
                            Text(String(format: "%.2f%%", abs(comparison.changePercent)))
                                .font(.caption.weight(.semibold).monospacedDigit())
                        }
                        .foregroundStyle(comparison.isRegression ? AppColors.failure : AppColors.success)
                    }
                    .frame(maxWidth: .infinity)

                    Divider()
                        .frame(height: 28)

                    VStack(spacing: 3) {
                        Text("Speedup")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(String(format: "%.3fx", comparison.speedup))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(comparison.isRegression ? AppColors.failure : AppColors.success)
                    }
                    .frame(maxWidth: .infinity)

                    Divider()
                        .frame(height: 28)

                    VStack(spacing: 3) {
                        Text("Status")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 3) {
                            Image(systemName: comparison.isRegression ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                                .font(.caption2)
                            Text(comparison.isRegression ? "Regress" : "OK")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(comparison.isRegression ? AppColors.failure : AppColors.success)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - Statistics

    @State private var showDistribution: Bool = false

    private var statisticsSection: some View {
        InfoCard(title: "Statistical Analysis", icon: "chart.bar") {
            VStack(spacing: 16) {
                // Primary stats
                HStack(spacing: 12) {
                    StatBox(label: "Mean", value: formatValue(viewModel.statistics.mean), icon: "target")
                    StatBox(label: "Median", value: formatValue(viewModel.statistics.median), icon: "line.3.horizontal.decrease")
                    StatBox(label: "Std Dev", value: formatValue(viewModel.statistics.stddev), icon: "waveform")
                }

                // Coefficient of variation
                if viewModel.statistics.mean > 0 {
                    let cv = (viewModel.statistics.stddev / viewModel.statistics.mean) * 100
                    HStack {
                        Label("Coefficient of Variation", systemImage: "percent")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(String(format: "%.2f%%", cv))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(viewModel.varianceLevel.color)
                    }
                    .padding(10)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                Divider()

                // Range with commit info
                VStack(spacing: 8) {
                    HStack(spacing: 12) {
                        StatBox(label: "Min", value: formatValue(viewModel.statistics.min), icon: "arrow.down.to.line", color: AppColors.success)
                        StatBox(label: "Max", value: formatValue(viewModel.statistics.max), icon: "arrow.up.to.line", color: AppColors.failure)
                    }

                    // Best/Worst performance commits
                    HStack(spacing: 12) {
                        if let best = viewModel.bestPerformancePoint {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 4) {
                                    Image(systemName: "trophy.fill")
                                        .font(.caption2)
                                        .foregroundStyle(.yellow)
                                    Text("Best Performance")
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                                Text(String(best.commit.prefix(8)))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.primary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .contextMenu {
                                Button {
                                    UIPasteboard.general.string = best.commit
                                } label: {
                                    Label("Copy SHA", systemImage: "doc.on.doc")
                                }
                            }
                        }

                        if let worst = viewModel.worstPerformancePoint {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 4) {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.caption2)
                                        .foregroundStyle(.red)
                                    Text("Worst Performance")
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                                Text(String(worst.commit.prefix(8)))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.primary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .contextMenu {
                                Button {
                                    UIPasteboard.general.string = worst.commit
                                } label: {
                                    Label("Copy SHA", systemImage: "doc.on.doc")
                                }
                            }
                        }
                    }
                }

                Divider()

                // Percentiles
                VStack(spacing: 8) {
                    Text("Percentiles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 8) {
                        PercentileBox(percentile: "P25", value: formatValue(viewModel.statistics.p25))
                        PercentileBox(percentile: "P50", value: formatValue(viewModel.statistics.median))
                        PercentileBox(percentile: "P75", value: formatValue(viewModel.statistics.p75))
                        PercentileBox(percentile: "P90", value: formatValue(viewModel.statistics.p90))
                        PercentileBox(percentile: "P95", value: formatValue(viewModel.statistics.p95))
                    }
                }

                Divider()

                // Distribution toggle
                Button {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        showDistribution.toggle()
                    }
                } label: {
                    HStack {
                        Image(systemName: showDistribution ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                        Text(showDistribution ? "Hide Distribution" : "Show Distribution")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                    }
                    .foregroundStyle(.blue)
                }

                if showDistribution {
                    distributionHistogram
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var distributionHistogram: some View {
        let stats = viewModel.statistics
        let values = viewModel.filteredTimeSeries.map(\.value).sorted()
        let bucketCount = 20
        let bucketSize = stats.max > stats.min ? (stats.max - stats.min) / Double(bucketCount) : 1.0
        let buckets: [(id: Int, midpoint: Double, count: Int)] = (0..<bucketCount).map { i in
            let bucketStart = stats.min + Double(i) * bucketSize
            let midpoint = bucketStart + bucketSize / 2
            let count = values.filter { $0 >= bucketStart && $0 < bucketStart + bucketSize }.count
            return (id: i, midpoint: midpoint, count: count)
        }

        return VStack(alignment: .leading, spacing: 8) {
            Text("Value Distribution")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            if !values.isEmpty {
                Chart {
                    ForEach(buckets, id: \.id) { bucket in
                        BarMark(
                            x: .value("Value", bucket.midpoint),
                            y: .value("Count", bucket.count)
                        )
                        .foregroundStyle(
                            bucket.midpoint >= stats.p25 && bucket.midpoint <= stats.p75
                                ? Color.blue.gradient
                                : Color.blue.opacity(0.4).gradient
                        )
                    }

                    RuleMark(x: .value("Mean", stats.mean))
                        .foregroundStyle(.orange)
                        .lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 4]))

                    RuleMark(x: .value("Median", stats.median))
                        .foregroundStyle(.purple)
                        .lineStyle(StrokeStyle(lineWidth: 2, dash: [2, 2]))
                }
                .frame(height: 180)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(.secondary.opacity(0.2))
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(.secondary.opacity(0.2))
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    // MARK: - Regressions

    private var regressionsSection: some View {
        InfoCard(title: "Recent Regressions", icon: "exclamationmark.triangle") {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(viewModel.regressionReports.prefix(5))) { report in
                    NavigationLink {
                        RegressionReportView(reportId: report.id)
                    } label: {
                        HStack(spacing: 10) {
                            // Status indicator
                            Circle()
                                .fill(report.status == "active" ? AppColors.failure : .orange)
                                .frame(width: 8, height: 8)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(report.reportId ?? "Regression Report")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)

                                HStack(spacing: 8) {
                                    let count = report.details?.regression?.count ?? report.regressionCount ?? 0
                                    if count > 0 {
                                        Text("\(count) regression\(count == 1 ? "" : "s")")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }

                                    if let suspicious = report.details?.suspicious, !suspicious.isEmpty {
                                        Text("\(suspicious.count) suspicious")
                                            .font(.caption2)
                                            .foregroundStyle(.orange)
                                    }
                                }
                            }

                            Spacer(minLength: 4)

                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)

                    if report.id != viewModel.regressionReports.prefix(5).last?.id {
                        Divider()
                    }
                }
            }
        }
    }

    // MARK: - Data Table

    private var dataTableSection: some View {
        InfoCard(title: "Data Table", icon: "tablecells") {
            if viewModel.filteredGroupDataPoints.isEmpty && viewModel.filteredTimeSeries.isEmpty {
                EmptyStateView(
                    icon: "tablecells",
                    title: "No Data",
                    message: "No data points match the current filters."
                )
                .frame(height: 120)
            } else if !viewModel.filteredGroupDataPoints.isEmpty {
                groupDataTable
            } else {
                timeSeriesTable
            }
        }
    }

    private var groupDataTable: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Model")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Value")
                    .font(.caption.weight(.semibold))
                    .frame(width: 62, alignment: .trailing)
                Text("Base")
                    .font(.caption.weight(.semibold))
                    .frame(width: 62, alignment: .trailing)
                Text("Speed")
                    .font(.caption.weight(.semibold))
                    .frame(width: 56, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground))

            Divider()

            // Rows
            ForEach(viewModel.filteredGroupDataPoints.prefix(50)) { point in
                HStack {
                    Text(point.name)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Text(formatValue(point.value))
                        .font(.system(.caption2, design: .monospaced))
                        .frame(width: 62, alignment: .trailing)

                    Text(point.baseline.map { formatValue($0) } ?? "--")
                        .font(.system(.caption2, design: .monospaced))
                        .frame(width: 62, alignment: .trailing)

                    Text(point.speedup.map { String(format: "%.2fx", $0) } ?? "--")
                        .font(.system(.caption2, design: .monospaced).weight(.medium))
                        .foregroundStyle(speedupColor(point.speedup))
                        .frame(width: 56, alignment: .trailing)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)

                Divider()
            }

            if viewModel.filteredGroupDataPoints.count > 50 {
                Text("Showing 50 of \(viewModel.filteredGroupDataPoints.count) rows")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 1)
        )
    }

    private var timeSeriesTable: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Commit")
                    .font(.caption.weight(.semibold))
                    .frame(width: 68, alignment: .leading)
                Text("Details")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Value")
                    .font(.caption.weight(.semibold))
                    .frame(width: 70, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground))

            Divider()

            ForEach(viewModel.filteredTimeSeries.suffix(50).reversed()) { point in
                HStack(alignment: .center) {
                    Text(String(point.commit.prefix(7)))
                        .font(.system(.caption2, design: .monospaced))
                        .frame(width: 68, alignment: .leading)

                    VStack(alignment: .leading, spacing: 1) {
                        if let model = point.model {
                            Text(model)
                                .font(.caption)
                                .lineLimit(1)
                        }
                        if let metric = point.metric {
                            Text(metric)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Text(formatValue(point.value))
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 70, alignment: .trailing)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)

                Divider()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Helpers

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

    private func speedupColor(_ speedup: Double?) -> Color {
        guard let speedup else { return .secondary }
        if speedup >= 1.05 { return AppColors.success }
        if speedup < 0.95 { return AppColors.failure }
        return .primary
    }
}

// MARK: - Supporting Views

private struct StatBox: View {
    let label: String
    let value: String
    let icon: String
    var color: Color = .blue

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(color.opacity(0.7))

            Text(value)
                .font(.system(.subheadline, design: .monospaced).weight(.bold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct PercentileBox: View {
    let percentile: String
    let value: String

    var body: some View {
        VStack(spacing: 3) {
            Text(percentile)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)

            Text(value)
                .font(.system(.caption2, design: .monospaced).weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .padding(.horizontal, 2)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

#Preview {
    NavigationStack {
        BenchmarkDashboardView(
            benchmark: BenchmarkMetadata(
                id: "test",
                name: "Test Benchmark",
                description: "A test benchmark for preview",
                suites: ["suite1"],
                lastUpdated: nil
            )
        )
    }
}
