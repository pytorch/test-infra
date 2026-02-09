import SwiftUI
import Charts

struct CostAnalysisView: View {
    @StateObject private var viewModel = CostAnalysisViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading cost data...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadData() }
                }

            case .loaded:
                costContent
            }
        }
        .navigationTitle("Cost Analysis")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadData()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var costContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                controlsSection

                totalCostSummary

                if let comparison = viewModel.periodComparison {
                    periodComparisonCard(comparison)
                }

                costTrendChart

                costBreakdownChart

                topContributorsCard

                costDetailsList
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controlsSection: some View {
        VStack(spacing: 10) {
            TimeRangePicker(selectedRangeID: $viewModel.selectedTimeRange)

            Picker("Group By", selection: $viewModel.selectedGrouping) {
                ForEach(CostAnalysisViewModel.CostGrouping.allCases, id: \.self) { grouping in
                    Text(grouping.displayName).tag(grouping)
                }
            }
            .pickerStyle(.segmented)
        }
        .onChange(of: viewModel.selectedTimeRange) {
            Task { await viewModel.onParametersChanged() }
        }
        .onChange(of: viewModel.selectedGrouping) {
            Task { await viewModel.onParametersChanged() }
        }
    }

    // MARK: - Total Cost Summary

    @ViewBuilder
    private var totalCostSummary: some View {
        InfoCard(title: "Cost Summary", icon: "dollarsign.circle.fill") {
            VStack(spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text(CostAnalysisViewModel.formatCurrency(viewModel.totalCost))
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .accessibilityLabel("Total cost \(CostAnalysisViewModel.formatCurrency(viewModel.totalCost))")
                    Text("total")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }

                HStack(spacing: 8) {
                    MetricPill(
                        label: "Daily Avg",
                        value: CostAnalysisViewModel.formatCurrency(viewModel.dailyAverageCost),
                        icon: "calendar"
                    )

                    MetricPill(
                        label: "Jobs",
                        value: viewModel.formattedTotalJobs,
                        icon: "square.stack.3d.up"
                    )

                    if viewModel.costPerJob > 0 {
                        MetricPill(
                            label: "Per Job",
                            value: CostAnalysisViewModel.formatCurrency(viewModel.costPerJob),
                            icon: "dollarsign.arrow.circlepath"
                        )
                    }
                }
            }
        }
    }

    // MARK: - Period Comparison

    @ViewBuilder
    private func periodComparisonCard(_ comparison: CostAnalysisViewModel.PeriodComparison) -> some View {
        InfoCard(title: "Period Comparison", icon: "arrow.left.arrow.right") {
            VStack(spacing: 12) {
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Current Period")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(CostAnalysisViewModel.formatCurrency(comparison.currentPeriodCost))
                            .font(.title3.bold())
                    }

                    Spacer()

                    VStack(alignment: .trailing, spacing: 4) {
                        Text("Previous Period")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(CostAnalysisViewModel.formatCurrency(comparison.previousPeriodCost))
                            .font(.title3.bold())
                    }
                }

                Divider()

                HStack {
                    Image(systemName: comparison.isDecrease ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                        .foregroundStyle(comparison.isDecrease ? AppColors.success : AppColors.failure)
                    Text(comparison.changeText)
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text(comparison.percentageText)
                        .font(.subheadline.bold())
                        .foregroundStyle(comparison.isDecrease ? AppColors.success : AppColors.failure)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Cost \(comparison.isDecrease ? "decreased" : "increased") by \(comparison.percentageText)")
            }
        }
    }

    // MARK: - Cost Trend Chart

    @ViewBuilder
    private var costTrendChart: some View {
        TimeSeriesChart(
            title: "Daily Cost Trend",
            data: viewModel.costTrendSeries,
            color: .purple,
            valueFormat: .decimal(0),
            chartHeight: 200
        )
    }

    // MARK: - Cost Breakdown Chart

    @ViewBuilder
    private var costBreakdownChart: some View {
        let items = Array(viewModel.costBreakdown.prefix(8))
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Cost by \(viewModel.selectedGrouping.displayName)")
                    .font(.headline)
                Spacer()
                Text("\(viewModel.costBreakdown.count) categories")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !items.isEmpty {
                Chart(items) { item in
                    BarMark(
                        x: .value("Cost", item.cost),
                        y: .value("Category", CostAnalysisViewModel.truncateLabel(item.category))
                    )
                    .foregroundStyle(item.color)
                    .cornerRadius(4)
                }
                .chartXAxis {
                    AxisMarks(position: .bottom, values: .automatic(desiredCount: 3)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text(CostAnalysisViewModel.formatCurrencyShort(v))
                            }
                        }
                        AxisGridLine()
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) {
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .frame(height: CGFloat(items.count) * 40 + 20)
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Top Contributors

    @ViewBuilder
    private var topContributorsCard: some View {
        if !viewModel.costBreakdown.isEmpty {
            InfoCard(title: "Top Cost Contributors", icon: "chart.bar.fill") {
                VStack(spacing: 8) {
                    ForEach(Array(viewModel.costBreakdown.prefix(5).enumerated()), id: \.element.id) { index, item in
                        VStack(spacing: 6) {
                            HStack(spacing: 10) {
                                ZStack {
                                    Circle()
                                        .fill(item.color.opacity(0.2))
                                        .frame(width: 28, height: 28)
                                    Text("\(index + 1)")
                                        .font(.caption2.bold())
                                        .foregroundStyle(item.color)
                                }

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.category)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text("\(item.jobCount) jobs")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }

                                Spacer()

                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(CostAnalysisViewModel.formatCurrency(item.cost))
                                        .font(.subheadline.bold())
                                    if viewModel.totalCost > 0 {
                                        Text(String(format: "%.1f%%", item.cost / viewModel.totalCost * 100))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }

                            if viewModel.totalCost > 0 {
                                GeometryReader { geometry in
                                    ZStack(alignment: .leading) {
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(Color(.systemGray5))
                                            .frame(height: 4)
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(item.color)
                                            .frame(
                                                width: geometry.size.width * CGFloat(min(item.cost / viewModel.totalCost, 1.0)),
                                                height: 4
                                            )
                                    }
                                }
                                .frame(height: 4)
                            }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(item.category), \(CostAnalysisViewModel.formatCurrency(item.cost)), \(item.jobCount) jobs")

                        if index < 4 && index < viewModel.costBreakdown.count - 1 {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Cost Details List

    @ViewBuilder
    private var costDetailsList: some View {
        if !viewModel.costBreakdown.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "All Categories",
                    subtitle: "\(viewModel.costBreakdown.count) total"
                )

                LazyVStack(spacing: 8) {
                    ForEach(viewModel.costBreakdown) { item in
                        VStack(spacing: 8) {
                            HStack {
                                Circle()
                                    .fill(item.color)
                                    .frame(width: 10, height: 10)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.category)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(2)
                                    Text("\(item.jobCount) jobs")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }

                                Spacer()

                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(CostAnalysisViewModel.formatCurrency(item.cost))
                                        .font(.subheadline.bold())
                                    if viewModel.totalCost > 0 {
                                        Text(String(format: "%.1f%%", item.cost / viewModel.totalCost * 100))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }

                            if viewModel.totalCost > 0 {
                                GeometryReader { geometry in
                                    ZStack(alignment: .leading) {
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(Color(.systemGray5))
                                            .frame(height: 3)
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(item.color.opacity(0.7))
                                            .frame(
                                                width: geometry.size.width * CGFloat(min(item.cost / viewModel.totalCost, 1.0)),
                                                height: 3
                                            )
                                    }
                                }
                                .frame(height: 3)
                            }
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(item.category), \(CostAnalysisViewModel.formatCurrency(item.cost)), \(item.jobCount) jobs")
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private var emptyChartPlaceholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 160)
            .overlay {
                Text("No data available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
    }
}

// MARK: - Supporting Views

private struct MetricPill: View {
    let label: String
    let value: String
    var icon: String?

    var body: some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.subheadline.bold())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

// MARK: - ViewModel

@MainActor
final class CostAnalysisViewModel: ObservableObject {
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

    enum CostGrouping: String, CaseIterable {
        case workflow = "Workflow"
        case runnerType = "Runner Type"
        case repository = "Repository"
        case provider = "Provider"
        case platform = "Platform"

        var displayName: String { rawValue }

        var queryName: String {
            switch self {
            case .workflow: return "cost_job_per_workflow_name"
            case .runnerType: return "cost_job_per_runner_type"
            case .repository: return "cost_job_per_repo"
            case .provider: return "cost_job_per_provider"
            case .platform: return "cost_job_per_platform"
            }
        }
    }

    struct CostBreakdownItem: Identifiable {
        let id: UUID
        let category: String
        let cost: Double
        let jobCount: Int
        let color: Color

        init(id: UUID = UUID(), category: String, cost: Double, jobCount: Int, color: Color) {
            self.id = id
            self.category = category
            self.cost = cost
            self.jobCount = jobCount
            self.color = color
        }
    }

    struct PeriodComparison {
        let currentPeriodCost: Double
        let previousPeriodCost: Double

        var isDecrease: Bool {
            currentPeriodCost < previousPeriodCost
        }

        var changeAmount: Double {
            currentPeriodCost - previousPeriodCost
        }

        var changePercentage: Double {
            guard previousPeriodCost > 0 else { return 0 }
            return (changeAmount / previousPeriodCost) * 100
        }

        var changeText: String {
            let absChange = abs(changeAmount)
            if absChange >= 1_000 {
                return String(format: "$%.1fk %@", absChange / 1_000, isDecrease ? "saved" : "increase")
            }
            return String(format: "$%.0f %@", absChange, isDecrease ? "saved" : "increase")
        }

        var percentageText: String {
            String(format: "%@%.1f%%", isDecrease ? "-" : "+", abs(changePercentage))
        }
    }

    @Published var state: ViewState = .loading
    @Published var selectedTimeRange: String = "30d"
    @Published var selectedGrouping: CostGrouping = .workflow

    @Published var totalCost: Double = 0
    @Published var totalJobs: Int = 0
    @Published var dailyAverageCost: Double?
    @Published var costBreakdown: [CostBreakdownItem] = []
    @Published var costTrendSeries: [TimeSeriesDataPoint] = []
    @Published var periodComparison: PeriodComparison?

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    /// Cost per job, computed from total cost and total jobs.
    var costPerJob: Double {
        guard totalJobs > 0 else { return 0 }
        return totalCost / Double(totalJobs)
    }

    /// Formatted total jobs count with compact notation for large numbers.
    var formattedTotalJobs: String {
        if totalJobs >= 1_000_000 {
            return String(format: "%.1fM", Double(totalJobs) / 1_000_000)
        }
        if totalJobs >= 1_000 {
            return String(format: "%.1fk", Double(totalJobs) / 1_000)
        }
        return "\(totalJobs)"
    }

    private var timeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 30
        return APIEndpoint.timeRange(days: days)
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

    // MARK: - Static Formatters

    /// Formats a currency value with appropriate precision and suffix.
    static func formatCurrency(_ value: Double?) -> String {
        guard let value else { return "--" }
        if value >= 1_000_000 {
            return String(format: "$%.1fM", value / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "$%.1fk", value / 1_000)
        }
        if value >= 100 {
            return String(format: "$%.0f", value)
        }
        return String(format: "$%.2f", value)
    }

    /// Short currency format for chart axis labels.
    static func formatCurrencyShort(_ value: Double) -> String {
        if value >= 1_000_000 {
            return String(format: "$%.0fM", value / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "$%.0fk", value / 1_000)
        }
        return String(format: "$%.0f", value)
    }

    /// Truncates a label for chart Y-axis display to avoid overflow on mobile.
    static func truncateLabel(_ label: String, maxLength: Int = 20) -> String {
        if label.count <= maxLength {
            return label
        }
        return String(label.prefix(maxLength - 1)) + "\u{2026}"
    }

    // MARK: - Data Fetching

    private func fetchAllData() async {
        do {
            let client = apiClient
            async let breakdown = fetchBreakdown(client: client)
            async let trend = fetchTrend(client: client)
            async let comparison = fetchPeriodComparison(client: client)

            let (breakdownResult, trendResult, comparisonResult) = try await (breakdown, trend, comparison)

            costBreakdown = breakdownResult
            costTrendSeries = trendResult
            periodComparison = comparisonResult
            totalCost = breakdownResult.reduce(0) { $0 + $1.cost }
            totalJobs = breakdownResult.reduce(0) { $0 + $1.jobCount }

            if let range = selectedRange, range.days > 0 {
                dailyAverageCost = totalCost / Double(range.days)
            } else {
                dailyAverageCost = nil
            }

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    struct CostQueryResult: Decodable {
        let granularity_bucket: String
        let workflow_name: String?
        let runner_type: String?
        let repo: String?
        let provider: String?
        let platform: String?
        let total_cost: Double

        var categoryName: String {
            workflow_name ?? runner_type ?? repo ?? provider ?? platform ?? "Unknown"
        }
    }

    private func fetchBreakdown(client: APIClientProtocol) async throws -> [CostBreakdownItem] {
        let range = timeRangeTuple

        let results: [CostQueryResult] = try await client.fetch(
            .clickhouseQuery(
                name: selectedGrouping.queryName,
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "selectedRepos": ["pytorch/pytorch", "pytorch/vision", "pytorch/audio"],
                    "selectedGPU": [0, 1],
                    "selectedPlatforms": ["linux", "windows", "macos", "NA"],
                    "selectedProviders": ["aws", "gcp", "github", "amd", "NA"],
                    "selectedOwners": ["linux_foundation", "meta", "amd", "NA"],
                ] as [String: Any]
            )
        )

        var categoryTotals: [String: (cost: Double, count: Int)] = [:]
        for result in results {
            let category = result.categoryName
            let existing = categoryTotals[category] ?? (cost: 0, count: 0)
            categoryTotals[category] = (
                cost: existing.cost + result.total_cost,
                count: existing.count + 1
            )
        }

        let colors: [Color] = [
            .purple, .blue, .teal, .green, .orange,
            .pink, .indigo, .cyan, .mint, .brown,
        ]

        return categoryTotals.enumerated().map { index, item in
            CostBreakdownItem(
                category: item.key,
                cost: item.value.cost,
                jobCount: item.value.count,
                color: colors[index % colors.count]
            )
        }
        .sorted { $0.cost > $1.cost }
    }

    private func fetchTrend(client: APIClientProtocol) async throws -> [TimeSeriesDataPoint] {
        let range = timeRangeTuple

        let results: [CostQueryResult] = try await client.fetch(
            .clickhouseQuery(
                name: selectedGrouping.queryName,
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "selectedRepos": ["pytorch/pytorch", "pytorch/vision", "pytorch/audio"],
                    "selectedGPU": [0, 1],
                    "selectedPlatforms": ["linux", "windows", "macos", "NA"],
                    "selectedProviders": ["aws", "gcp", "github", "amd", "NA"],
                    "selectedOwners": ["linux_foundation", "meta", "amd", "NA"],
                ] as [String: Any]
            )
        )

        var dailyTotals: [String: Double] = [:]
        for result in results {
            let bucket = result.granularity_bucket
            dailyTotals[bucket, default: 0] += result.total_cost
        }

        return dailyTotals.map { bucket, cost in
            TimeSeriesDataPoint(granularity_bucket: bucket, value: cost)
        }
        .sorted { $0.granularity_bucket < $1.granularity_bucket }
    }

    private func fetchPeriodComparison(client: APIClientProtocol) async throws -> PeriodComparison? {
        guard let range = selectedRange, range.days > 1 else { return nil }

        let now = Date()
        let currentStart = Calendar.current.date(byAdding: .day, value: -range.days, to: now) ?? now
        let previousStart = Calendar.current.date(byAdding: .day, value: -range.days * 2, to: currentStart) ?? now

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        formatter.timeZone = TimeZone(identifier: "UTC")

        let currentRange = (
            startTime: formatter.string(from: currentStart),
            stopTime: formatter.string(from: now)
        )
        let previousRange = (
            startTime: formatter.string(from: previousStart),
            stopTime: formatter.string(from: currentStart)
        )

        async let currentResults: [CostQueryResult] = client.fetch(
            .clickhouseQuery(
                name: selectedGrouping.queryName,
                parameters: [
                    "startTime": currentRange.startTime,
                    "stopTime": currentRange.stopTime,
                    "granularity": "day",
                    "selectedRepos": ["pytorch/pytorch", "pytorch/vision", "pytorch/audio"],
                    "selectedGPU": [0, 1],
                    "selectedPlatforms": ["linux", "windows", "macos", "NA"],
                    "selectedProviders": ["aws", "gcp", "github", "amd", "NA"],
                    "selectedOwners": ["linux_foundation", "meta", "amd", "NA"],
                ] as [String: Any]
            )
        )

        async let previousResults: [CostQueryResult] = client.fetch(
            .clickhouseQuery(
                name: selectedGrouping.queryName,
                parameters: [
                    "startTime": previousRange.startTime,
                    "stopTime": previousRange.stopTime,
                    "granularity": "day",
                    "selectedRepos": ["pytorch/pytorch", "pytorch/vision", "pytorch/audio"],
                    "selectedGPU": [0, 1],
                    "selectedPlatforms": ["linux", "windows", "macos", "NA"],
                    "selectedProviders": ["aws", "gcp", "github", "amd", "NA"],
                    "selectedOwners": ["linux_foundation", "meta", "amd", "NA"],
                ] as [String: Any]
            )
        )

        let (current, previous) = try await (currentResults, previousResults)

        let currentCost = current.reduce(0) { $0 + $1.total_cost }
        let previousCost = previous.reduce(0) { $0 + $1.total_cost }

        return PeriodComparison(
            currentPeriodCost: currentCost,
            previousPeriodCost: previousCost
        )
    }
}

#Preview {
    NavigationStack {
        CostAnalysisView()
    }
}
