import SwiftUI
import Charts

struct ClaudeBillingView: View {
    @StateObject private var viewModel = ClaudeBillingViewModel()

    var body: some View {
        VStack(spacing: 0) {
            headerSection
                .padding(.horizontal)
                .padding(.top, 8)

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Claude Billing")
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
                url: "https://metrics.pytorch.org/d/claude-billing",
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
                icon: "creditcard",
                title: "Claude Billing",
                message: "Loading Claude AI usage and cost data..."
            )

        case .loading:
            LoadingView(message: "Fetching billing data...")

        case .loaded:
            billingContent

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Billing Content

    private var billingContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                totalCostSummaryCard
                costMetricsSection

                if !viewModel.costTrendData.isEmpty {
                    costTrendChart
                }

                usageMetricsSection

                if !viewModel.costByWorkflow.isEmpty {
                    costByWorkflowSection
                }

                if !viewModel.costByModel.isEmpty {
                    costByModelSection
                }

                if !viewModel.topUsers.isEmpty {
                    topUsersSection
                }

                if !viewModel.topRepos.isEmpty {
                    topReposSection
                }
            }
            .padding()
        }
        .refreshable { await viewModel.refresh() }
    }

    // MARK: - Total Cost Summary

    private var totalCostSummaryCard: some View {
        InfoCard(title: "Total Spending", icon: "dollarsign.circle.fill") {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(viewModel.totalCost)
                        .font(.system(.largeTitle, design: .rounded).bold())
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text("in \(viewModel.timeRangeLabel)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 12) {
                    MetricPill(
                        label: "Daily Avg",
                        value: viewModel.avgDailyCost,
                        icon: "calendar"
                    )
                    MetricPill(
                        label: "Requests",
                        value: viewModel.totalRequests,
                        icon: "paperplane"
                    )
                }
            }
        }
    }

    // MARK: - Cost Metrics

    private var costMetricsSection: some View {
        VStack(spacing: 12) {
            SectionHeader(title: "Cost Breakdown", subtitle: "Input vs Output tokens")

            HStack(spacing: 12) {
                MetricCard(
                    title: "Input Tokens Cost",
                    value: viewModel.inputTokensCost,
                    subtitle: "prompt tokens"
                )
                MetricCard(
                    title: "Output Tokens Cost",
                    value: viewModel.outputTokensCost,
                    subtitle: "completion tokens"
                )
            }
        }
    }

    // MARK: - Cost Trend Chart

    private var costTrendChart: some View {
        TimeSeriesChart(
            title: "Daily Cost Trend",
            data: viewModel.costTrendData,
            color: .purple,
            valueFormat: .decimal(2),
            chartHeight: 200
        )
    }

    // MARK: - Usage Metrics

    private var usageMetricsSection: some View {
        VStack(spacing: 12) {
            SectionHeader(title: "Usage", subtitle: "Token consumption")

            HStack(spacing: 12) {
                MetricCard(
                    title: "Total Requests",
                    value: viewModel.totalRequests
                )
                MetricCard(
                    title: "Total Tokens",
                    value: viewModel.totalTokens
                )
            }

            HStack(spacing: 12) {
                MetricCard(
                    title: "Input Tokens",
                    value: viewModel.inputTokens,
                    subtitle: "prompt tokens"
                )
                MetricCard(
                    title: "Output Tokens",
                    value: viewModel.outputTokens,
                    subtitle: "completion tokens"
                )
            }
        }
    }

    // MARK: - Cost by Workflow

    private var costByWorkflowSection: some View {
        InfoCard(title: "Cost by Use Case", icon: "arrow.triangle.branch") {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(viewModel.costByWorkflow.count) workflows")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(Array(viewModel.costByWorkflow.prefix(8).enumerated()), id: \.element.id) { index, entry in
                    VStack(spacing: 6) {
                        HStack {
                            HStack(spacing: 8) {
                                ZStack {
                                    Circle()
                                        .fill(Color.purple.opacity(0.15))
                                        .frame(width: 28, height: 28)
                                    Text("\(index + 1)")
                                        .font(.caption2.bold())
                                        .foregroundStyle(Color.purple)
                                }

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.name)
                                        .font(.subheadline)
                                        .lineLimit(2)

                                    Text("\(entry.requestCount) requests")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }

                            Spacer()

                            Text(entry.costFormatted)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Color.purple)
                        }

                        GeometryReader { geometry in
                            let maxCost = viewModel.costByWorkflow.first?.cost ?? 1
                            let fraction = entry.cost / max(maxCost, 0.01)

                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(.systemGray5))
                                    .frame(width: geometry.size.width, height: 6)

                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color.purple.gradient)
                                    .frame(width: geometry.size.width * fraction, height: 6)
                            }
                        }
                        .frame(height: 6)
                    }
                    .padding(.top, index == 0 ? 6 : 4)
                }
            }
        }
    }

    // MARK: - Cost by Model

    private var costByModelSection: some View {
        InfoCard(title: "Cost by Model", icon: "brain") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(viewModel.costByModel.enumerated()), id: \.offset) { index, entry in
                    VStack(spacing: 6) {
                        HStack {
                            HStack(spacing: 8) {
                                ZStack {
                                    Circle()
                                        .fill(modelColor(for: index).opacity(0.2))
                                        .frame(width: 28, height: 28)
                                    Text("\(index + 1)")
                                        .font(.caption2.bold())
                                        .foregroundStyle(modelColor(for: index))
                                }

                                Text(entry.model)
                                    .font(.subheadline)
                                    .lineLimit(1)
                            }

                            Spacer()

                            Text(entry.costFormatted)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(modelColor(for: index))
                        }

                        GeometryReader { geometry in
                            let maxCost = viewModel.costByModel.first?.cost ?? 1
                            let fraction = entry.cost / max(maxCost, 0.01)

                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(.systemGray5))
                                    .frame(width: geometry.size.width, height: 8)

                                RoundedRectangle(cornerRadius: 4)
                                    .fill(modelColor(for: index).gradient)
                                    .frame(width: geometry.size.width * fraction, height: 8)
                            }
                        }
                        .frame(height: 8)
                    }
                }
            }
        }
    }

    private func modelColor(for index: Int) -> Color {
        let colors: [Color] = [.purple, .blue, .green, .orange, .pink, .cyan]
        return colors[index % colors.count]
    }

    // MARK: - Top Users

    private var topUsersSection: some View {
        InfoCard(title: "Top Users by Cost", icon: "person.2") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(viewModel.topUsers.prefix(10).enumerated()), id: \.offset) { index, user in
                    VStack(spacing: 6) {
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.caption.monospacedDigit().bold())
                                .foregroundStyle(.secondary)
                                .frame(width: 20, alignment: .center)
                                .padding(6)
                                .background(Color(.systemGray5))
                                .clipShape(RoundedRectangle(cornerRadius: 6))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name)
                                    .font(.subheadline)
                                    .lineLimit(1)

                                Text("\(user.requestCount) requests")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Text(user.costFormatted)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Color.purple)
                        }

                        GeometryReader { geometry in
                            let maxCost = viewModel.topUsers.first?.cost ?? 1
                            let fraction = user.cost / max(maxCost, 0.01)

                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color(.systemGray5))
                                    .frame(width: geometry.size.width, height: 4)

                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.purple.opacity(0.6))
                                    .frame(width: geometry.size.width * fraction, height: 4)
                            }
                        }
                        .frame(height: 4)
                    }
                }
            }
        }
    }

    // MARK: - Top Repos

    private var topReposSection: some View {
        InfoCard(title: "Top Repositories by Cost", icon: "folder.badge.gearshape") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(viewModel.topRepos.prefix(10).enumerated()), id: \.offset) { index, repo in
                    VStack(spacing: 6) {
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.caption.monospacedDigit().bold())
                                .foregroundStyle(.secondary)
                                .frame(width: 20, alignment: .center)
                                .padding(6)
                                .background(Color(.systemGray5))
                                .clipShape(RoundedRectangle(cornerRadius: 6))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(repo.name)
                                    .font(.subheadline)
                                    .lineLimit(1)

                                Text("\(repo.requestCount) requests")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Text(repo.costFormatted)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Color.blue)
                        }

                        GeometryReader { geometry in
                            let maxCost = viewModel.topRepos.first?.cost ?? 1
                            let fraction = repo.cost / max(maxCost, 0.01)

                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color(.systemGray5))
                                    .frame(width: geometry.size.width, height: 4)

                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.blue.opacity(0.6))
                                    .frame(width: geometry.size.width * fraction, height: 4)
                            }
                        }
                        .frame(height: 4)
                    }
                }
            }
        }
    }
}

// MARK: - MetricPill

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
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.systemGray6))
        .clipShape(Capsule())
    }
}

// MARK: - View Model

@MainActor
final class ClaudeBillingViewModel: ObservableObject {
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

    // Cost metrics
    @Published var totalCost: String = "$0.00"
    @Published var avgDailyCost: String = "$0.00"
    @Published var inputTokensCost: String = "$0.00"
    @Published var outputTokensCost: String = "$0.00"

    // Usage metrics
    @Published var totalRequests: String = "0"
    @Published var totalTokens: String = "0"
    @Published var inputTokens: String = "0"
    @Published var outputTokens: String = "0"

    // Breakdown
    @Published var costByModel: [ModelCostEntry] = []
    @Published var costByWorkflow: [WorkflowCostEntry] = []
    @Published var topUsers: [UserCostEntry] = []
    @Published var topRepos: [RepoCostEntry] = []
    @Published var costTrendData: [TimeSeriesDataPoint] = []

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    func loadData() async {
        if state != .loaded {
            state = .loading
        }
        do {
            let days = daysForRange(selectedTimeRange)
            let range = APIEndpoint.timeRange(days: days)
            let granularity = days <= 7 ? "day" : "week"
            let client = apiClient

            // Fetch daily usage data and repo data first (no repo filter needed)
            async let dailyData: [ClaudeUsageRow] = client.fetch(
                .clickhouseQuery(
                    name: "claude_code_usage_daily",
                    parameters: [
                        "startTime": range.startTime,
                        "stopTime": range.stopTime,
                    ] as [String: Any]
                )
            )

            async let repoData: [ClaudeRepoRow] = client.fetch(
                .clickhouseQuery(
                    name: "claude_code_usage_by_repo",
                    parameters: [
                        "startTime": range.startTime,
                        "stopTime": range.stopTime,
                        "granularity": granularity,
                    ] as [String: Any]
                )
            )

            let daily = try await dailyData
            let repos = (try? await repoData) ?? []

            // Extract unique repo names from the data to use as selectedRepos
            // for the actor query (which requires a non-empty selectedRepos)
            let repoNames = Array(Set(daily.map(\.repo) + repos.map(\.repo))).sorted()

            // Fetch per-actor data only if we have repos to filter by
            var actors: [ClaudeActorRow] = []
            if !repoNames.isEmpty {
                actors = (try? await client.fetch(
                    .clickhouseQuery(
                        name: "claude_code_usage_by_actor",
                        parameters: [
                            "startTime": range.startTime,
                            "stopTime": range.stopTime,
                            "granularity": granularity,
                            "selectedRepos": repoNames,
                        ] as [String: Any]
                    )
                )) ?? []
            }

            applyData(daily: daily, actors: actors, repos: repos, days: days)
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        await loadData()
    }

    func selectTimeRange(_ range: String) {
        guard range != selectedTimeRange else { return }
        selectedTimeRange = range
        Task { await loadData() }
    }

    private func applyData(daily: [ClaudeUsageRow], actors: [ClaudeActorRow], repos: [ClaudeRepoRow], days: Int) {
        // Aggregate totals from daily data
        let total = daily.reduce(0.0) { $0 + $1.total_cost }
        let totalInvocations = daily.reduce(0) { $0 + $1.invocations }
        let totalTurns = daily.reduce(0) { $0 + $1.total_turns }

        totalCost = formatCurrency(total)
        avgDailyCost = days > 0 ? formatCurrency(total / Double(days)) : "$0.00"
        totalRequests = formatCount(totalInvocations)
        totalTokens = formatCount(totalTurns)

        // The daily query doesn't provide token breakdowns; show turns as proxy
        inputTokensCost = "--"
        outputTokensCost = "--"
        inputTokens = "--"
        outputTokens = "--"

        // Cost by day → trend chart
        let byDay = Dictionary(grouping: daily, by: { $0.day })
        costTrendData = byDay.map { (day, rows) in
            TimeSeriesDataPoint(
                granularity_bucket: day,
                value: rows.reduce(0.0) { $0 + $1.total_cost }
            )
        }.sorted { $0.granularity_bucket < $1.granularity_bucket }

        // Cost by workflow
        let byWorkflow = Dictionary(grouping: daily, by: { $0.workflow_name })
        costByWorkflow = byWorkflow.map { (name, rows) in
            WorkflowCostEntry(
                name: name,
                cost: rows.reduce(0.0) { $0 + $1.total_cost },
                requestCount: rows.reduce(0) { $0 + $1.invocations }
            )
        }.sorted { $0.cost > $1.cost }

        // No per-model data from these queries
        costByModel = []

        // Top users from actor data
        let byActor = Dictionary(grouping: actors, by: { $0.actor })
        topUsers = byActor.map { (actor, rows) in
            UserCostEntry(
                name: actor,
                cost: rows.reduce(0.0) { $0 + $1.total_cost },
                requestCount: rows.reduce(0) { $0 + $1.invocations }
            )
        }.sorted { $0.cost > $1.cost }

        // Top repos from repo data
        let byRepo = Dictionary(grouping: repos, by: { $0.repo })
        topRepos = byRepo.map { (repo, rows) in
            RepoCostEntry(
                name: repo,
                cost: rows.reduce(0.0) { $0 + $1.total_cost },
                requestCount: rows.reduce(0) { $0 + $1.invocations }
            )
        }.sorted { $0.cost > $1.cost }
    }

    private func formatCurrency(_ value: Double) -> String {
        if value >= 1000 {
            return String(format: "$%.1fK", value / 1000)
        }
        return String(format: "$%.2f", value)
    }

    private func formatCount(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fK", Double(value) / 1_000)
        }
        return "\(value)"
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

    var timeRangeLabel: String {
        switch selectedTimeRange {
        case "1d": return "last 24 hours"
        case "7d": return "last 7 days"
        case "14d": return "last 14 days"
        case "30d": return "last 30 days"
        default: return "selected period"
        }
    }
}

// MARK: - Display Models

struct ModelCostEntry {
    let model: String
    let cost: Double

    var costFormatted: String {
        if cost >= 1000 {
            return String(format: "$%.1fK", cost / 1000)
        }
        return String(format: "$%.2f", cost)
    }
}

struct WorkflowCostEntry: Identifiable {
    var id: String { name }
    let name: String
    let cost: Double
    let requestCount: Int

    var costFormatted: String {
        if cost >= 1000 {
            return String(format: "$%.1fK", cost / 1000)
        }
        return String(format: "$%.2f", cost)
    }
}

struct UserCostEntry {
    let name: String
    let cost: Double
    let requestCount: Int

    var costFormatted: String {
        if cost >= 1000 {
            return String(format: "$%.1fK", cost / 1000)
        }
        return String(format: "$%.2f", cost)
    }
}

struct RepoCostEntry {
    let name: String
    let cost: Double
    let requestCount: Int

    var costFormatted: String {
        if cost >= 1000 {
            return String(format: "$%.1fK", cost / 1000)
        }
        return String(format: "$%.2f", cost)
    }
}

// MARK: - API Response Models

/// Row from claude_code_usage_daily query
private struct ClaudeUsageRow: Decodable {
    let day: String
    let workflow_name: String
    let repo: String
    let invocations: Int
    let total_cost: Double
    let total_turns: Int
    let total_minutes: Double
    let avg_cost_per_invocation: Double
    let avg_turns_per_invocation: Double
}

/// Row from claude_code_usage_by_actor query
private struct ClaudeActorRow: Decodable {
    let actor: String
    let invocations: Int
    let total_cost: Double
    let total_turns: Int
    let total_minutes: Double
}

/// Row from claude_code_usage_by_repo query
private struct ClaudeRepoRow: Decodable {
    let repo: String
    let invocations: Int
    let total_cost: Double
    let total_turns: Int
    let total_minutes: Double
}

#Preview {
    NavigationStack {
        ClaudeBillingView()
    }
}
