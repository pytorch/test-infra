import SwiftUI
import Charts

struct AutorevertMetricsView: View {
    @StateObject private var viewModel = AutorevertMetricsViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading autorevert metrics...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadMetrics() }
                }

            case .loaded:
                autorevertContent
            }
        }
        .navigationTitle("Autorevert")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadMetrics()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var autorevertContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                explanationSection

                TimeRangePicker(
                    selectedRangeID: $viewModel.selectedTimeRange,
                    ranges: Array(TimeRange.presets.suffix(from: 2).map { $0 })
                )

                healthIndicator

                summaryCards

                metricsLegend

                weeklyTrendChart

                stackedBarChart

                if let reverts = viewModel.significantReverts, !reverts.isEmpty {
                    significantRevertsSection
                }

                if let fps = viewModel.falsePositivesData {
                    falsePositivesSection(data: fps)
                }
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
        .onChange(of: viewModel.selectedTimeRange) {
            viewModel.onParametersChanged()
        }
    }

    // MARK: - Explanation

    @ViewBuilder
    private var explanationSection: some View {
        Text("Tracks autorevert system performance using precision/recall metrics. **Precision** = TP / (TP + FP) measures how often autoreverts are correct. **Recall** = TP / (TP + FN) measures how many reverts autorevert catches.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal)
    }

    // MARK: - Health Indicator

    @ViewBuilder
    private var healthIndicator: some View {
        let precision = viewModel.summary?.precision
        let recall = viewModel.summary?.recall
        let hasData = precision != nil || recall != nil

        if hasData {
            HStack(spacing: 16) {
                healthGauge(label: "Precision", value: precision)
                healthGauge(label: "Recall", value: recall)
            }
            .padding()
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
            .accessibilityIdentifier("autorevert_health_indicator")
        }
    }

    @ViewBuilder
    private func healthGauge(label: String, value: Double?) -> some View {
        VStack(spacing: 6) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

            if let value {
                ZStack {
                    Circle()
                        .stroke(Color(.systemGray5), lineWidth: 6)

                    Circle()
                        .trim(from: 0, to: min(value / 100.0, 1.0))
                        .stroke(
                            metricHealthColor(value),
                            style: StrokeStyle(lineWidth: 6, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))

                    Text(String(format: "%.0f%%", value))
                        .font(.system(.caption2, design: .rounded).bold())
                        .foregroundStyle(metricHealthColor(value))
                }
                .frame(width: 52, height: 52)
                .accessibilityLabel("\(label) \(String(format: "%.1f", value)) percent")
            } else {
                Text("--")
                    .font(.title3.bold())
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Summary Cards

    @ViewBuilder
    private var summaryCards: some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
        ], spacing: 10) {
            MetricCard(
                title: "Precision",
                value: formatPercentage(viewModel.summary?.precision),
                subtitle: "TP / (TP + FP)",
                valueColor: metricHealthColor(viewModel.summary?.precision),
                trendIsGoodWhenNegative: false
            )

            MetricCard(
                title: "Recall",
                value: formatPercentage(viewModel.summary?.recall),
                subtitle: "TP / (TP + FN)",
                valueColor: metricHealthColor(viewModel.summary?.recall),
                trendIsGoodWhenNegative: false
            )

            MetricCard(
                title: "True Positives",
                value: viewModel.summary.map { "\($0.truePositives ?? 0)" } ?? "--",
                subtitle: viewModel.summary.map {
                    "\($0.tpWithSignalRecovery ?? 0) recovered + \($0.tpWithoutSignalRecovery ?? 0) verified"
                },
                valueColor: AutorevertColors.truePositive
            )

            MetricCard(
                title: "False Positives",
                value: viewModel.summary.map { "\($0.confirmedFalsePositives ?? 0)" } ?? "--",
                subtitle: "Wrong autoreverts",
                valueColor: viewModel.summary.flatMap {
                    ($0.confirmedFalsePositives ?? 0) > 0 ? AppColors.failure : nil
                } ?? .primary
            )

            MetricCard(
                title: "False Negatives",
                value: viewModel.summary.map { "\($0.falseNegatives ?? 0)" } ?? "--",
                subtitle: "Missed by autorevert",
                valueColor: viewModel.summary.flatMap {
                    ($0.falseNegatives ?? 0) > 0 ? AutorevertColors.falseNegative : nil
                } ?? .primary
            )

            MetricCard(
                title: "Total Autoreverts",
                value: viewModel.summary.map { "\($0.totalAutoreverts ?? 0)" } ?? "--"
            )
        }
        .accessibilityIdentifier("autorevert_summary_cards")
    }

    // MARK: - Metrics Legend

    @ViewBuilder
    private var metricsLegend: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                LegendItem(
                    color: AutorevertColors.truePositive,
                    label: "TP",
                    description: "True Positive (correct autorevert)"
                )
                LegendItem(
                    color: AutorevertColors.falseNegative,
                    label: "FN",
                    description: "False Negative (missed by autorevert)"
                )
                LegendItem(
                    color: AppColors.failure,
                    label: "FP",
                    description: "False Positive (incorrect autorevert)"
                )
                LegendItem(
                    color: AutorevertColors.nonRevert,
                    label: "Other",
                    description: "Non-revert recoveries"
                )
            }
            .font(.caption)
            .padding(.top, 4)
        } label: {
            Text("Metrics Legend")
                .font(.headline)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        .accessibilityIdentifier("autorevert_metrics_legend")
    }

    // MARK: - Weekly Trend Chart

    @ViewBuilder
    private var weeklyTrendChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Weekly Precision & Recall")
                .font(.headline)

            if let weeklyMetrics = viewModel.weeklyMetrics, !weeklyMetrics.isEmpty {
                Chart {
                    ForEach(weeklyMetrics) { metric in
                        if let precision = metric.precision {
                            LineMark(
                                x: .value("Week", metric.week),
                                y: .value("Value", precision),
                                series: .value("Metric", "Precision")
                            )
                            .foregroundStyle(.blue)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                            .interpolationMethod(.catmullRom)
                            .symbol {
                                Circle()
                                    .fill(.blue)
                                    .frame(width: 6, height: 6)
                            }
                        }

                        if let recall = metric.recall {
                            LineMark(
                                x: .value("Week", metric.week),
                                y: .value("Value", recall),
                                series: .value("Metric", "Recall")
                            )
                            .foregroundStyle(.green)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                            .interpolationMethod(.catmullRom)
                            .symbol {
                                Circle()
                                    .fill(.green)
                                    .frame(width: 6, height: 6)
                            }
                        }
                    }
                }
                .chartYScale(domain: 0...100)
                .chartYAxis {
                    AxisMarks(position: .leading, values: .stride(by: 25)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("\(Int(v))%")
                                    .font(.caption2)
                            }
                        }
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) {
                        AxisValueLabel()
                            .font(.caption2)
                        AxisGridLine()
                    }
                }
                .chartForegroundStyleScale([
                    "Precision": Color.blue,
                    "Recall": Color.green,
                ])
                .chartLegend(position: .bottom, alignment: .center, spacing: 12)
                .frame(height: 200)
                .accessibilityIdentifier("autorevert_precision_recall_chart")
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Stacked Bar Chart

    @ViewBuilder
    private var stackedBarChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Weekly Recoveries by Type")
                .font(.headline)

            if let weeklyMetrics = viewModel.weeklyMetrics, !weeklyMetrics.isEmpty {
                Chart {
                    ForEach(weeklyMetrics) { metric in
                        BarMark(
                            x: .value("Week", metric.week),
                            y: .value("Count", metric.autorevertRecoveries ?? 0),
                            stacking: .standard
                        )
                        .foregroundStyle(AutorevertColors.truePositive)
                        .position(by: .value("Type", "TP"))

                        BarMark(
                            x: .value("Week", metric.week),
                            y: .value("Count", metric.humanRevertRecoveries ?? 0),
                            stacking: .standard
                        )
                        .foregroundStyle(AutorevertColors.falseNegative)
                        .position(by: .value("Type", "FN"))

                        BarMark(
                            x: .value("Week", metric.week),
                            y: .value("Count", metric.falsePositives ?? 0),
                            stacking: .standard
                        )
                        .foregroundStyle(AppColors.failure)
                        .position(by: .value("Type", "FP"))

                        BarMark(
                            x: .value("Week", metric.week),
                            y: .value("Count", metric.nonRevertRecoveries ?? 0),
                            stacking: .standard
                        )
                        .foregroundStyle(AutorevertColors.nonRevert)
                        .position(by: .value("Type", "Other"))
                    }
                }
                .chartForegroundStyleScale([
                    "TP": AutorevertColors.truePositive,
                    "FN": AutorevertColors.falseNegative,
                    "FP": AppColors.failure,
                    "Other": AutorevertColors.nonRevert,
                ])
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                        AxisValueLabel()
                            .font(.caption2)
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) {
                        AxisValueLabel()
                            .font(.caption2)
                        AxisGridLine()
                    }
                }
                .chartLegend(position: .bottom, alignment: .center, spacing: 12)
                .frame(height: 200)
                .accessibilityIdentifier("autorevert_recoveries_chart")
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Significant Reverts Section

    @ViewBuilder
    private var significantRevertsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Significant Reverts")
                    .font(.headline)

                Text("\(viewModel.significantReverts?.count ?? 0)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.accentColor)
                    .clipShape(Capsule())
            }

            if let reverts = viewModel.significantReverts {
                let displayCount = viewModel.showAllReverts ? reverts.count : min(reverts.count, 5)

                ForEach(reverts.prefix(displayCount)) { revert in
                    SignificantRevertRow(revert: revert)
                }

                if reverts.count > 5 {
                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            viewModel.showAllReverts.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(viewModel.showAllReverts ? "Show less" : "Show all \(reverts.count) reverts")
                            Image(systemName: viewModel.showAllReverts ? "chevron.up" : "chevron.down")
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        .accessibilityIdentifier("autorevert_significant_reverts")
    }

    // MARK: - False Positives Section

    @ViewBuilder
    private func falsePositivesSection(data: FalsePositivesData) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("False Positive Analysis")
                .font(.headline)

            if data.candidatesChecked == 0 {
                Text("No autoreverts without signal recovery found in this time range.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    fpStatBadge(
                        count: data.confirmed?.count ?? 0,
                        label: "Confirmed FP",
                        color: AppColors.failure
                    )
                    fpStatBadge(
                        count: data.legitReverts?.count ?? 0,
                        label: "Legit",
                        color: AutorevertColors.truePositive
                    )
                    fpStatBadge(
                        count: data.candidatesChecked,
                        label: "Checked",
                        color: .secondary
                    )
                }

                if let confirmed = data.confirmed, !confirmed.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Confirmed False Positives (\(confirmed.count))")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppColors.failure)

                        ForEach(confirmed.prefix(5)) { fp in
                            FalsePositiveRow(fp: fp)
                        }

                        if confirmed.count > 5 {
                            Text("Showing 5 of \(confirmed.count) false positives")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                    }
                }

                if let legit = data.legitReverts, !legit.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Legit Reverts (\(legit.count))")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AutorevertColors.truePositive)

                        ForEach(legit.prefix(5)) { fp in
                            FalsePositiveRow(fp: fp)
                        }

                        if legit.count > 5 {
                            Text("Showing 5 of \(legit.count) legit reverts")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                    }
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        .accessibilityIdentifier("autorevert_false_positives")
    }

    @ViewBuilder
    private func fpStatBadge(count: Int, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(count)")
                .font(.title3.bold())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Helpers

    @ViewBuilder
    private var emptyChartPlaceholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 180)
            .overlay {
                Text("No data available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
    }

    private func formatPercentage(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.1f%%", value)
    }

    private func metricHealthColor(_ value: Double?) -> Color {
        guard let value else { return .secondary }
        if value >= 80 { return AppColors.success }
        if value >= 60 { return AutorevertColors.falseNegative }
        return AppColors.failure
    }
}

// MARK: - Autorevert Colors

enum AutorevertColors {
    static let truePositive = Color(red: 59/255, green: 162/255, blue: 114/255)
    static let falseNegative = Color(red: 237/255, green: 108/255, blue: 2/255)
    static let nonRevert = Color(red: 140/255, green: 140/255, blue: 140/255)
}

// MARK: - Supporting Views

struct LegendItem: View {
    let color: Color
    let label: String
    let description: String

    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(color)
                .frame(width: 12, height: 12)

            Text("**\(label)** = \(description)")
                .font(.caption)
        }
    }
}

struct SignificantRevertRow: View {
    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    let revert: SignificantRevert

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(revert.isTP ? "TP" : "FN")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(revert.isTP ? AutorevertColors.truePositive : AutorevertColors.falseNegative)
                    .clipShape(RoundedRectangle(cornerRadius: 4))

                Text(formatDate(revert.recoveryTime))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer()

                Text("\(revert.signalsFixed) signal\(revert.signalsFixed != 1 ? "s" : "")")
                    .font(.caption.weight(.medium))
            }

            HStack(spacing: 8) {
                Text(revert.recoverySha.prefix(7))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)

                if let prs = revert.revertedPrNumbers, !prs.isEmpty {
                    Text("PRs: \(prs.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(revert.isTP ? "True positive" : "False negative") revert, \(revert.signalsFixed) signals fixed")
    }

    private func formatDate(_ isoString: String) -> String {
        guard let date = Self.isoFormatter.date(from: isoString) else {
            return isoString
        }
        let display = DateFormatter()
        display.dateStyle = .short
        display.timeStyle = .short
        return display.string(from: date)
    }
}

struct FalsePositiveRow: View {
    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    let fp: FalsePositive

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("#\(fp.prNumber)")
                    .font(.caption.weight(.semibold))

                Spacer()

                Text(formatDate(fp.autorevertTime))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Text(fp.verificationReason)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            if let signals = fp.sourceSignalKeys, !signals.isEmpty {
                Text("\(signals.count) signal\(signals.count != 1 ? "s" : "")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }

    private func formatDate(_ isoString: String) -> String {
        guard let date = Self.isoFormatter.date(from: isoString) else {
            return isoString
        }
        let display = DateFormatter()
        display.dateStyle = .short
        display.timeStyle = .short
        return display.string(from: date)
    }
}

// MARK: - ViewModel

@MainActor
final class AutorevertMetricsViewModel: ObservableObject {
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
    @Published var selectedTimeRange: String = "30d"
    @Published var summary: AutorevertSummary?
    @Published var weeklyMetrics: [WeeklyMetric]?
    @Published var significantReverts: [SignificantRevert]?
    @Published var falsePositivesData: FalsePositivesData?
    @Published var showAllReverts: Bool = false

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    func loadMetrics() async {
        state = .loading
        await fetchData()
    }

    func refresh() async {
        await fetchData()
    }

    func onParametersChanged() {
        showAllReverts = false
        loadTask?.cancel()
        loadTask = Task { await fetchData() }
    }

    private func fetchData() async {
        do {
            let days = selectedRange?.days ?? 30
            let range = APIEndpoint.timeRange(days: days)

            let metrics: AutorevertMetrics = try await apiClient.fetch(
                .autorevertMetrics(startTime: range.startTime, stopTime: range.stopTime)
            )
            guard !Task.isCancelled else { return }

            summary = metrics.summary
            weeklyMetrics = metrics.weeklyMetrics
            significantReverts = metrics.significantReverts
            falsePositivesData = metrics.falsePositives
            state = .loaded
        } catch is CancellationError {
            // Task was cancelled — don't update state
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}

#Preview {
    NavigationStack {
        AutorevertMetricsView()
    }
}
