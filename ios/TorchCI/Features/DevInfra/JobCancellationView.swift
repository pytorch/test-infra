import SwiftUI
import Charts

struct JobCancellationView: View {
    @StateObject private var viewModel = JobCancellationViewModel()

    var body: some View {
        VStack(spacing: 0) {
            headerSection
                .padding(.horizontal)
                .padding(.top, 8)

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Job Cancellations")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.loadData() }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Time Range")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            TimeRangePicker(
                selectedRangeID: Binding(
                    get: { viewModel.selectedTimeRange },
                    set: { viewModel.selectTimeRange($0) }
                ),
                ranges: [
                    TimeRange(id: "1d", label: "1 Day", days: 1),
                    TimeRange(id: "7d", label: "1 Week", days: 7),
                    TimeRange(id: "14d", label: "2 Weeks", days: 14),
                    TimeRange(id: "30d", label: "1 Month", days: 30),
                ]
            )

            LinkButton(
                title: "View Full Dashboard in Grafana",
                url: "https://metrics.pytorch.org/d/job-cancellation",
                icon: "chart.bar.xaxis"
            )
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            EmptyStateView(
                icon: "xmark.circle",
                title: "Job Cancellations",
                message: "Loading cancellation metrics..."
            )

        case .loading:
            LoadingView(message: "Fetching cancellation data...")

        case .loaded:
            cancellationContent

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Cancellation Content

    private var cancellationContent: some View {
        ScrollView {
            VStack(spacing: 20) {
                summaryMetricsSection

                if !viewModel.cancellationTrend.isEmpty {
                    cancellationTrendChart
                }

                if !viewModel.timeSavedTrend.isEmpty {
                    timeSavedTrendChart
                }

                if !viewModel.cancellationsByReason.isEmpty {
                    cancellationsByReasonSection
                }

                if !viewModel.topCancelledWorkflows.isEmpty {
                    topWorkflowsSection
                }

                if !viewModel.recentCancellations.isEmpty {
                    recentCancellationsSection
                }
            }
            .padding()
        }
        .refreshable { await viewModel.refresh() }
    }

    // MARK: - Summary Metrics

    private var summaryMetricsSection: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                MetricCard(
                    title: "Total Cancellations",
                    value: "\(viewModel.totalCancellations)"
                )
                .accessibleMetric(
                    name: "Total Cancellations",
                    value: "\(viewModel.totalCancellations)",
                    unit: "jobs"
                )

                MetricCard(
                    title: "Cancellation Rate",
                    value: viewModel.cancellationRate
                )
                .accessibleMetric(
                    name: "Cancellation Rate",
                    value: viewModel.cancellationRate
                )
            }

            HStack(spacing: 12) {
                MetricCard(
                    title: "Time Saved",
                    value: viewModel.timeSaved,
                    subtitle: "estimated compute hours"
                )
                .accessibleMetric(
                    name: "Time Saved",
                    value: viewModel.timeSaved,
                    unit: "estimated compute hours"
                )

                MetricCard(
                    title: "Avg per Day",
                    value: viewModel.avgPerDay
                )
                .accessibleMetric(
                    name: "Average Cancellations per Day",
                    value: viewModel.avgPerDay
                )
            }

            HStack(spacing: 12) {
                MetricCard(
                    title: "Cost Savings",
                    value: viewModel.costSavings,
                    subtitle: "estimated in USD"
                )
                .accessibleMetric(
                    name: "Cost Savings",
                    value: viewModel.costSavings,
                    unit: "estimated USD"
                )

                MetricCard(
                    title: "Peak Day",
                    value: viewModel.peakDayCancellations
                )
                .accessibleMetric(
                    name: "Peak Day Cancellations",
                    value: viewModel.peakDayCancellations
                )
            }
        }
    }

    // MARK: - Charts

    private var cancellationTrendChart: some View {
        let values = viewModel.cancellationTrend.compactMap(\.value)
        let chartSummary = ChartSummaryBuilder.summary(
            title: "Cancellation Trend",
            values: values,
            format: { String(format: "%.0f", $0) }
        )

        return InfoCard(title: "Cancellation Trend", icon: "chart.line.uptrend.xyaxis") {
            Chart {
                ForEach(viewModel.cancellationTrend) { point in
                    LineMark(
                        x: .value("Date", point.date ?? Date()),
                        y: .value("Cancellations", point.value ?? 0)
                    )
                    .foregroundStyle(AppColors.cancelled)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Date", point.date ?? Date()),
                        y: .value("Cancellations", point.value ?? 0)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [AppColors.cancelled.opacity(0.3), AppColors.cancelled.opacity(0.05)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
            }
            .frame(height: 200)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) {
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    AxisGridLine()
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                    AxisValueLabel()
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                }
            }
            .accessibleChart(
                title: "Cancellation Trend",
                summary: chartSummary,
                dataPointCount: viewModel.cancellationTrend.count
            )
        }
    }

    private var timeSavedTrendChart: some View {
        let values = viewModel.timeSavedTrend.compactMap(\.value)
        let chartSummary = ChartSummaryBuilder.summary(
            title: "Time Saved",
            values: values,
            format: { String(format: "%.1f hrs", $0) }
        )

        return InfoCard(title: "Time Saved Over Time", icon: "clock.badge.checkmark") {
            Chart {
                ForEach(viewModel.timeSavedTrend) { point in
                    BarMark(
                        x: .value("Date", point.date ?? Date()),
                        y: .value("Hours", point.value ?? 0)
                    )
                    .foregroundStyle(AppColors.success)
                    .cornerRadius(3)
                }
            }
            .frame(height: 200)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) {
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    AxisGridLine()
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                    AxisValueLabel()
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                }
            }
            .accessibleChart(
                title: "Time Saved Over Time",
                summary: chartSummary,
                dataPointCount: viewModel.timeSavedTrend.count
            )
        }
    }

    // MARK: - Cancellations by Reason

    private var cancellationsByReasonSection: some View {
        InfoCard(title: "Cancellations by Reason", icon: "chart.pie") {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(viewModel.cancellationsByReason.sorted(by: { $0.count > $1.count }), id: \.reason) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            reasonIcon(item.reason)
                                .font(.caption)
                                .foregroundStyle(reasonColor(item.reason))

                            Text(item.reason.isEmpty ? "Unknown" : item.reason)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)

                            Spacer()

                            Text("\(item.count)")
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.secondary)
                        }

                        reasonBar(count: item.count, percentage: item.percentage, color: reasonColor(item.reason))

                        if let timeSaved = item.timeSavedHours, timeSaved > 0 {
                            HStack(spacing: 4) {
                                Image(systemName: "clock.arrow.circlepath")
                                    .font(.caption2)
                                Text(formatHours(timeSaved))
                                    .font(.caption2)
                            }
                            .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(item.reason.isEmpty ? "Unknown reason" : item.reason))
                    .accessibilityValue(reasonAccessibilityValue(item))
                }
            }
        }
    }

    private func reasonAccessibilityValue(_ item: CancellationByReason) -> String {
        var parts: [String] = ["\(item.count) cancellations"]
        if let percentage = item.percentage {
            parts.append("\(Int(percentage)) percent")
        }
        if let hours = item.timeSavedHours, hours > 0 {
            parts.append(formatHours(hours))
        }
        return parts.joined(separator: ", ")
    }

    private func reasonIcon(_ reason: String) -> Image {
        let lowercased = reason.lowercased()
        if lowercased.contains("duplicate") || lowercased.contains("superseded") {
            return Image(systemName: "doc.on.doc")
        } else if lowercased.contains("timeout") || lowercased.contains("stale") {
            return Image(systemName: "clock.badge.xmark")
        } else if lowercased.contains("failed") || lowercased.contains("error") {
            return Image(systemName: "exclamationmark.triangle")
        } else if lowercased.contains("manual") || lowercased.contains("user") {
            return Image(systemName: "person.crop.circle")
        } else {
            return Image(systemName: "xmark.circle")
        }
    }

    private func reasonColor(_ reason: String) -> Color {
        let lowercased = reason.lowercased()
        if lowercased.contains("duplicate") || lowercased.contains("superseded") {
            return AppColors.skipped
        } else if lowercased.contains("timeout") || lowercased.contains("stale") {
            return AppColors.pending
        } else if lowercased.contains("failed") || lowercased.contains("error") {
            return AppColors.failure
        } else {
            return AppColors.cancelled
        }
    }

    private func reasonBar(count: Int, percentage: Double?, color: Color) -> some View {
        let maxCount = viewModel.cancellationsByReason.map(\.count).max() ?? 1
        let fraction = CGFloat(count) / CGFloat(max(maxCount, 1))

        return HStack(spacing: 8) {
            GeometryReader { geometry in
                RoundedRectangle(cornerRadius: 4)
                    .fill(color.opacity(0.7))
                    .frame(width: geometry.size.width * fraction, height: 10)
            }
            .frame(height: 10)

            if let percentage {
                Text("\(Int(percentage))%")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 36, alignment: .trailing)
            }
        }
    }

    // MARK: - Top Workflows

    private var topWorkflowsSection: some View {
        InfoCard(title: "Top Cancelled Workflows", icon: "list.number") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(viewModel.topCancelledWorkflows.prefix(10).enumerated()), id: \.offset) { index, workflow in
                    HStack(spacing: 8) {
                        rankBadge(index + 1)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(workflow.name)
                                .font(.caption)
                                .lineLimit(2)

                            Text("\(workflow.count) cancellations")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        Spacer(minLength: 4)

                        workflowBar(count: workflow.count)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("Rank \(index + 1): \(workflow.name)"))
                    .accessibilityValue("\(workflow.count) cancellations")
                }
            }
        }
    }

    private func rankBadge(_ rank: Int) -> some View {
        Text("\(rank)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(rank <= 3 ? Color.white : Color.secondary)
            .frame(width: 24, height: 24)
            .background(
                Circle()
                    .fill(rank <= 3 ? Color.accentColor : Color(.systemGray5))
            )
    }

    private func workflowBar(count: Int) -> some View {
        let maxCount = viewModel.topCancelledWorkflows.first?.count ?? 1
        let fraction = CGFloat(count) / CGFloat(max(maxCount, 1))

        return RoundedRectangle(cornerRadius: 3)
            .fill(AppColors.cancelled.opacity(0.7))
            .frame(width: 60 * fraction, height: 10)
    }

    // MARK: - Recent Cancellations

    private var recentCancellationsSection: some View {
        InfoCard(title: "Recent Cancellations", icon: "clock") {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(viewModel.recentCancellations.prefix(15).enumerated()), id: \.element.id) { index, cancellation in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top) {
                            Text(cancellation.jobName)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(2)

                            Spacer(minLength: 8)

                            if let time = cancellation.cancelledAt {
                                Text(relativeTime(from: time))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        HStack(spacing: 8) {
                            Label(cancellation.reason.isEmpty ? "Unknown" : cancellation.reason, systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(reasonColor(cancellation.reason))
                                .lineLimit(1)

                            Spacer()

                            if let timeSaved = cancellation.timeSavedMinutes, timeSaved > 0 {
                                Label("\(timeSaved)m saved", systemImage: "clock.arrow.circlepath")
                                    .font(.caption2)
                                    .foregroundStyle(AppColors.success)
                            }
                        }

                        if let workflow = cancellation.workflowName {
                            Text(workflow)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.vertical, 10)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(cancellation.jobName))
                    .accessibilityValue(recentCancellationAccessibilityValue(cancellation))

                    if index < min(viewModel.recentCancellations.count, 15) - 1 {
                        Divider()
                    }
                }
            }
        }
    }

    private func recentCancellationAccessibilityValue(_ cancellation: RecentCancellation) -> String {
        var parts: [String] = []
        parts.append("Reason: \(cancellation.reason.isEmpty ? "Unknown" : cancellation.reason)")
        if let timeSaved = cancellation.timeSavedMinutes, timeSaved > 0 {
            parts.append("\(timeSaved) minutes saved")
        }
        if let workflow = cancellation.workflowName {
            parts.append("Workflow: \(workflow)")
        }
        if let time = cancellation.cancelledAt {
            parts.append(relativeTime(from: time))
        }
        return parts.joined(separator: ", ")
    }

    // MARK: - Helpers

    private func formatHours(_ hours: Double) -> String {
        if hours >= 1000 {
            return String(format: "%.1fK hrs saved", hours / 1000)
        } else if hours >= 1 {
            return String(format: "%.0f hrs saved", hours)
        } else {
            let minutes = Int(hours * 60)
            return "\(minutes)m saved"
        }
    }

    private func relativeTime(from isoString: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: isoString) else {
            return isoString
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - View Model

@MainActor
final class JobCancellationViewModel: ObservableObject {
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
    @Published var selectedTimeRange: String = "7d"
    @Published var totalCancellations: Int = 0
    @Published var cancellationRate: String = "N/A"
    @Published var timeSaved: String = "N/A"
    @Published var avgPerDay: String = "N/A"
    @Published var costSavings: String = "N/A"
    @Published var peakDayCancellations: String = "N/A"
    @Published var topCancelledWorkflows: [(name: String, count: Int)] = []
    @Published var cancellationTrend: [TimeSeriesDataPoint] = []
    @Published var timeSavedTrend: [TimeSeriesDataPoint] = []
    @Published var cancellationsByReason: [CancellationByReason] = []
    @Published var recentCancellations: [RecentCancellation] = []

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    func loadData() async {
        // The job_cancellation_metrics query is not available on the server.
        // Show a meaningful message instead of a generic error.
        state = .error("Job cancellation metrics are not yet available. This feature requires a custom ClickHouse query to be added to the HUD backend.")
    }

    func refresh() async {
        await loadData()
    }

    func selectTimeRange(_ range: String) {
        guard range != selectedTimeRange else { return }
        selectedTimeRange = range
        Task { await loadData() }
    }

    private func applyResponse(_ response: JobCancellationResponse, days: Int) {
        totalCancellations = response.totalCancellations ?? 0

        if let rate = response.cancellationRate {
            cancellationRate = String(format: "%.1f%%", rate)
        } else {
            cancellationRate = "N/A"
        }

        let totalHoursSaved = response.timeSavedHours ?? 0
        if totalHoursSaved >= 1000 {
            timeSaved = String(format: "%.1fK hrs", totalHoursSaved / 1000)
        } else {
            timeSaved = String(format: "%.0f hrs", totalHoursSaved)
        }

        // Calculate cost savings (assuming $0.50 per compute hour as a rough estimate)
        if totalHoursSaved > 0 {
            let costPerHour = 0.50
            let totalCost = totalHoursSaved * costPerHour
            if totalCost >= 1000 {
                costSavings = String(format: "$%.1fK", totalCost / 1000)
            } else {
                costSavings = String(format: "$%.0f", totalCost)
            }
        } else {
            costSavings = "N/A"
        }

        if days > 0 && totalCancellations > 0 {
            let daily = Double(totalCancellations) / Double(days)
            avgPerDay = String(format: "%.0f", daily)
        } else {
            avgPerDay = "N/A"
        }

        // Peak day from trend data
        if let trend = response.cancellationTrend, !trend.isEmpty {
            let peak = trend.max(by: { ($0.value ?? 0) < ($1.value ?? 0) })
            if let peakValue = peak?.value {
                peakDayCancellations = String(format: "%.0f", peakValue)
            }
        }

        // Top workflows
        if let workflows = response.topWorkflows {
            topCancelledWorkflows = workflows
                .sorted { ($0.count ?? 0) > ($1.count ?? 0) }
                .map { (name: $0.name, count: $0.count ?? 0) }
        } else {
            topCancelledWorkflows = []
        }

        // Cancellation trend over time
        cancellationTrend = response.cancellationTrend ?? []

        // Time saved trend over time
        timeSavedTrend = response.timeSavedTrend ?? []

        // Cancellations by reason
        if let byReason = response.byReason {
            let total = Double(byReason.reduce(0) { $0 + ($1.count ?? 0) })
            cancellationsByReason = byReason.map { item in
                let count = item.count ?? 0
                let percentage = total > 0 ? (Double(count) / total * 100) : nil
                return CancellationByReason(
                    reason: item.reason ?? "",
                    count: count,
                    percentage: percentage,
                    timeSavedHours: item.timeSavedHours
                )
            }
        } else {
            cancellationsByReason = []
        }

        // Recent cancellations
        if let recent = response.recentCancellations {
            recentCancellations = recent.map { item in
                RecentCancellation(
                    id: item.id ?? UUID().uuidString,
                    jobName: item.jobName ?? "Unknown Job",
                    workflowName: item.workflowName,
                    reason: item.reason ?? "",
                    cancelledAt: item.cancelledAt,
                    timeSavedMinutes: item.timeSavedMinutes
                )
            }
        } else {
            recentCancellations = []
        }
    }

    private func daysForRange(_ range: String) -> Int {
        switch range {
        case "1d": return 1
        case "7d": return 7
        case "14d": return 14
        case "30d": return 30
        default: return 7
        }
    }
}

// MARK: - Response Models

private struct JobCancellationResponse: Decodable {
    let totalCancellations: Int?
    let cancellationRate: Double?
    let timeSavedHours: Double?
    let topWorkflows: [CancelledWorkflow]?
    let cancellationTrend: [TimeSeriesDataPoint]?
    let timeSavedTrend: [TimeSeriesDataPoint]?
    let byReason: [CancellationReasonItem]?
    let recentCancellations: [RecentCancellationItem]?

    enum CodingKeys: String, CodingKey {
        case totalCancellations = "total_cancellations"
        case cancellationRate = "cancellation_rate"
        case timeSavedHours = "time_saved_hours"
        case topWorkflows = "top_workflows"
        case cancellationTrend = "cancellation_trend"
        case timeSavedTrend = "time_saved_trend"
        case byReason = "by_reason"
        case recentCancellations = "recent_cancellations"
    }
}

private struct CancelledWorkflow: Decodable {
    let name: String
    let count: Int?
}

private struct CancellationReasonItem: Decodable {
    let reason: String?
    let count: Int?
    let timeSavedHours: Double?

    enum CodingKeys: String, CodingKey {
        case reason
        case count
        case timeSavedHours = "time_saved_hours"
    }
}

private struct RecentCancellationItem: Decodable {
    let id: String?
    let jobName: String?
    let workflowName: String?
    let reason: String?
    let cancelledAt: String?
    let timeSavedMinutes: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case jobName = "job_name"
        case workflowName = "workflow_name"
        case reason
        case cancelledAt = "cancelled_at"
        case timeSavedMinutes = "time_saved_minutes"
    }
}

// MARK: - View Models

struct CancellationByReason {
    let reason: String
    let count: Int
    let percentage: Double?
    let timeSavedHours: Double?
}

struct RecentCancellation: Identifiable {
    let id: String
    let jobName: String
    let workflowName: String?
    let reason: String
    let cancelledAt: String?
    let timeSavedMinutes: Int?
}

#Preview {
    NavigationStack {
        JobCancellationView()
    }
}
