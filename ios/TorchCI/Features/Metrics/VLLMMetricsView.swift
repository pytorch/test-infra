import SwiftUI
import Charts

struct VLLMMetricsView: View {
    @StateObject private var viewModel = VLLMMetricsViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading vLLM metrics...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadData() }
                }

            case .loaded:
                vllmContent
            }
        }
        .navigationTitle("vLLM CI Metrics")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadData()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var vllmContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                headerView

                TimeRangePicker(selectedRangeID: $viewModel.selectedTimeRange)
                    .onChange(of: viewModel.selectedTimeRange) {
                        Task { await viewModel.onParametersChanged() }
                    }

                jobGroupFilter

                keyMetricsOverview

                Picker("Section", selection: $viewModel.selectedTab) {
                    Text("Reliability").tag(0)
                    Text("Duration").tag(1)
                    Text("Source Control").tag(2)
                }
                .pickerStyle(.segmented)
                .padding(.top, 8)

                switch viewModel.selectedTab {
                case 0:
                    reliabilitySection
                case 1:
                    durationSection
                case 2:
                    sourceControlSection
                default:
                    EmptyView()
                }
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var headerView: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Link(destination: URL(string: "https://app.codecov.io/github/vllm-project/vllm/tree/main")!) {
                    Label("Coverage", systemImage: "chart.bar.fill")
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.accentColor.opacity(0.1))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(Capsule())
                }

                Link(destination: URL(string: "https://buildkite.com/vllm")!) {
                    Label("Buildkite", systemImage: "arrow.up.right.square")
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.accentColor.opacity(0.1))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(Capsule())
                }

                Spacer()
            }
        }
    }

    // MARK: - Job Group Filter

    @ViewBuilder
    private var jobGroupFilter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Job Groups")
                .font(.subheadline.bold())
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    jobGroupButton("AMD", group: "amd")
                    jobGroupButton("Torch Nightly", group: "torch_nightly")
                    jobGroupButton("Main", group: "main")
                }
            }
        }
    }

    @ViewBuilder
    private func jobGroupButton(_ label: String, group: String) -> some View {
        Button {
            withAnimation {
                if viewModel.selectedJobGroups.contains(group) {
                    viewModel.selectedJobGroups.removeAll { $0 == group }
                } else {
                    viewModel.selectedJobGroups.append(group)
                }
                Task { await viewModel.onParametersChanged() }
            }
        } label: {
            Text(label)
                .font(.caption.bold())
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    viewModel.selectedJobGroups.contains(group)
                        ? Color.accentColor
                        : Color(.systemGray5)
                )
                .foregroundStyle(
                    viewModel.selectedJobGroups.contains(group) ? .white : .primary
                )
                .clipShape(Capsule())
        }
    }

    // MARK: - Key Metrics Overview

    @ViewBuilder
    private var keyMetricsOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Key Metrics Overview",
                subtitle: "Critical vLLM CI health indicators"
            )

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Trunk Health",
                    value: formatPercentage(viewModel.trunkHealthPercent),
                    subtitle: viewModel.trunkHealthDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.trunkHealthPercent, threshold: 90, higherIsBetter: true)
                )

                MetricCard(
                    title: "CI Stability",
                    value: formatPercentage(viewModel.ciStabilityScore),
                    subtitle: viewModel.ciStabilityDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.ciStabilityScore, threshold: 70, higherIsBetter: true)
                )

                MetricCard(
                    title: "Commits on Red",
                    value: formatPercentage(viewModel.commitsOnRedPercent),
                    subtitle: viewModel.commitsOnRedDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.commitsOnRedPercent, threshold: 10, higherIsBetter: false)
                )

                MetricCard(
                    title: "Force Merges",
                    value: formatPercentage(viewModel.forceMergePercent),
                    subtitle: viewModel.forceMergeDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.forceMergePercent, threshold: 20, higherIsBetter: false)
                )

                MetricCard(
                    title: "Time to Signal (P50)",
                    value: formatHours(viewModel.ciSuccessP50),
                    subtitle: viewModel.ciSuccessP50Delta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.ciSuccessP50, threshold: 2, higherIsBetter: false)
                )

                MetricCard(
                    title: "Time to Signal (P90)",
                    value: formatHours(viewModel.ciSuccessP90),
                    subtitle: viewModel.ciSuccessP90Delta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.ciSuccessP90, threshold: 6, higherIsBetter: false)
                )
            }
        }
    }

    // MARK: - Reliability Section

    @ViewBuilder
    private var reliabilitySection: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Success Rate",
                    value: formatPercentage(viewModel.overallSuccessRate),
                    subtitle: viewModel.overallSuccessDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.overallSuccessRate, threshold: 85, higherIsBetter: true)
                )

                MetricCard(
                    title: "Failed Builds",
                    value: viewModel.totalFailedBuilds.map { "\($0)" } ?? "--",
                    subtitle: viewModel.totalFailedDelta.map { formatDelta($0) },
                    valueColor: .red
                )

                MetricCard(
                    title: "State Transitions",
                    value: viewModel.stateTransitions.map { "\($0)" } ?? "--",
                    valueColor: .orange
                )

                MetricCard(
                    title: "Jobs Retried",
                    value: formatPercentage(viewModel.retryRate),
                    valueColor: metricColor(viewModel.retryRate, threshold: 1, higherIsBetter: false)
                )

                MetricCard(
                    title: "Avg Breakage Time",
                    value: formatHours(viewModel.avgRecoveryHours),
                    valueColor: metricColor(viewModel.avgRecoveryHours, threshold: 12, higherIsBetter: false)
                )
            }

            TimeSeriesChart(
                title: "CI Reliability Over Time",
                data: viewModel.reliabilitySeries,
                color: AppColors.success,
                valueFormat: .percentage(1),
                showArea: true,
                chartHeight: 200
            )

            TimeSeriesChart(
                title: "Trunk Health Trend",
                data: viewModel.trunkHealthSeries,
                color: .green,
                valueFormat: .percentage(1),
                showArea: true,
                chartHeight: 200
            )

            TimeSeriesChart(
                title: "Retry Rate Trend",
                data: viewModel.retryRateSeries,
                color: .orange,
                valueFormat: .percentage(2),
                chartHeight: 200
            )
        }
    }

    // MARK: - Duration Section

    @ViewBuilder
    private var durationSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "CI P50",
                    value: formatHours(viewModel.ciSuccessP50),
                    subtitle: viewModel.ciSuccessP50Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "CI P90",
                    value: formatHours(viewModel.ciSuccessP90),
                    subtitle: viewModel.ciSuccessP90Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "Non-Cancel P50",
                    value: formatHours(viewModel.ciNonCancelP50)
                )

                MetricCard(
                    title: "Non-Cancel P90",
                    value: formatHours(viewModel.ciNonCancelP90)
                )
            }

            TimeSeriesChart(
                title: "CI Duration Distribution (Success)",
                data: viewModel.ciDurationSeries,
                color: .blue,
                valueFormat: .duration,
                chartHeight: 200
            )

            TimeSeriesChart(
                title: "Time to Signal Trend",
                data: viewModel.timeToSignalSeries,
                color: .indigo,
                valueFormat: .duration,
                chartHeight: 200
            )
        }
    }

    // MARK: - Source Control Section

    @ViewBuilder
    private var sourceControlSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Manual Merges",
                    value: formatPercentage(viewModel.manualMergePercent),
                    subtitle: viewModel.manualMergeDelta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.manualMergePercent, threshold: 50, higherIsBetter: false)
                )

                MetricCard(
                    title: "Total Merges",
                    value: viewModel.totalMerges.map { "\($0)" } ?? "--"
                )

                MetricCard(
                    title: "Auto Merges",
                    value: viewModel.autoMerges.map { "\($0)" } ?? "--"
                )

                MetricCard(
                    title: "Force Merges",
                    value: viewModel.forceMerges.map { "\($0)" } ?? "--",
                    valueColor: .orange
                )

                MetricCard(
                    title: "Review Time (P50)",
                    value: formatHours(viewModel.timeToReviewP50),
                    subtitle: viewModel.timeToReviewP50Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "Review Time (P90)",
                    value: formatHours(viewModel.timeToReviewP90),
                    subtitle: viewModel.timeToReviewP90Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "Approval Time (P50)",
                    value: formatHours(viewModel.timeToApprovalP50),
                    subtitle: viewModel.timeToApprovalP50Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "Approval Time (P90)",
                    value: formatHours(viewModel.timeToApprovalP90),
                    subtitle: viewModel.timeToApprovalP90Delta.map { formatDelta($0) }
                )

                MetricCard(
                    title: "Queue Time (P50)",
                    value: formatHours(viewModel.mergeQueueP50),
                    subtitle: viewModel.mergeQueueP50Delta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.mergeQueueP50, threshold: 24, higherIsBetter: false)
                )

                MetricCard(
                    title: "Queue Time (P90)",
                    value: formatHours(viewModel.mergeQueueP90),
                    subtitle: viewModel.mergeQueueP90Delta.map { formatDelta($0) },
                    valueColor: metricColor(viewModel.mergeQueueP90, threshold: 72, higherIsBetter: false)
                )
            }

            TimeSeriesChart(
                title: "Force Merge Trend",
                data: viewModel.forceMergeSeries,
                color: .orange,
                valueFormat: .integer,
                chartHeight: 200
            )

            TimeSeriesChart(
                title: "Merge Activity",
                data: viewModel.mergeTrendSeries,
                color: .green,
                valueFormat: .integer,
                chartHeight: 200
            )
        }
    }

    // MARK: - Helpers

    private func formatPercentage(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.1f%%", value)
    }

    private func formatHours(_ hours: Double?) -> String {
        guard let hours else { return "--" }
        if hours >= 1 {
            return String(format: "%.1fh", hours)
        }
        return String(format: "%.0fm", hours * 60)
    }

    private func formatDelta(_ delta: Double) -> String {
        let sign = delta >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", delta))pp"
    }

    private func metricColor(_ value: Double?, threshold: Double, higherIsBetter: Bool) -> Color {
        guard let value else { return .primary }
        if higherIsBetter {
            return value >= threshold ? .green : .red
        } else {
            return value <= threshold ? .green : .red
        }
    }
}

// MARK: - ViewModel

@MainActor
final class VLLMMetricsViewModel: ObservableObject {
    enum ViewState: Equatable {
        case loading
        case loaded
        case error(String)
    }

    @Published var state: ViewState = .loading
    @Published var selectedTimeRange: String = "7d"
    @Published var selectedJobGroups: [String] = ["amd", "torch_nightly", "main"]
    @Published var selectedTab: Int = 0

    // Key metrics overview
    @Published var trunkHealthPercent: Double?
    @Published var trunkHealthDelta: Double?
    @Published var ciStabilityScore: Double?
    @Published var ciStabilityDelta: Double?
    @Published var commitsOnRedPercent: Double?
    @Published var commitsOnRedDelta: Double?
    @Published var forceMergePercent: Double?
    @Published var forceMergeDelta: Double?
    @Published var ciSuccessP50: Double?
    @Published var ciSuccessP50Delta: Double?
    @Published var ciSuccessP90: Double?
    @Published var ciSuccessP90Delta: Double?

    // Reliability metrics
    @Published var overallSuccessRate: Double?
    @Published var overallSuccessDelta: Double?
    @Published var totalFailedBuilds: Int?
    @Published var totalFailedDelta: Double?
    @Published var stateTransitions: Int?
    @Published var retryRate: Double?
    @Published var avgRecoveryHours: Double?
    @Published var reliabilitySeries: [TimeSeriesDataPoint] = []
    @Published var trunkHealthSeries: [TimeSeriesDataPoint] = []
    @Published var retryRateSeries: [TimeSeriesDataPoint] = []

    // Duration metrics
    @Published var ciNonCancelP50: Double?
    @Published var ciNonCancelP90: Double?
    @Published var ciDurationSeries: [TimeSeriesDataPoint] = []
    @Published var timeToSignalSeries: [TimeSeriesDataPoint] = []

    // Source control metrics
    @Published var manualMergePercent: Double?
    @Published var manualMergeDelta: Double?
    @Published var totalMerges: Int?
    @Published var autoMerges: Int?
    @Published var forceMerges: Int?
    @Published var timeToReviewP50: Double?
    @Published var timeToReviewP50Delta: Double?
    @Published var timeToReviewP90: Double?
    @Published var timeToReviewP90Delta: Double?
    @Published var timeToApprovalP50: Double?
    @Published var timeToApprovalP50Delta: Double?
    @Published var timeToApprovalP90: Double?
    @Published var timeToApprovalP90Delta: Double?
    @Published var mergeQueueP50: Double?
    @Published var mergeQueueP50Delta: Double?
    @Published var mergeQueueP90: Double?
    @Published var mergeQueueP90Delta: Double?
    @Published var forceMergeSeries: [TimeSeriesDataPoint] = []
    @Published var mergeTrendSeries: [TimeSeriesDataPoint] = []

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    private var timeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 7
        return APIEndpoint.timeRange(days: days)
    }

    private var prevTimeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 7
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let now = Date()
        let stop = Calendar.current.date(byAdding: .day, value: -days, to: now) ?? now
        let start = Calendar.current.date(byAdding: .day, value: -days, to: stop) ?? stop
        return (startTime: formatter.string(from: start), stopTime: formatter.string(from: stop))
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

    private func fetchAllData() async {
        do {
            async let reliability = fetchReliability()
            async let prevReliability = fetchPrevReliability()
            async let trunkHealth = fetchTrunkHealth()
            async let prevTrunkHealth = fetchPrevTrunkHealth()
            async let ciDurations = fetchCIDurations()
            async let prevCIDurations = fetchPrevCIDurations()
            async let merges = fetchMerges()
            async let prevMerges = fetchPrevMerges()
            async let prCycle = fetchPRCycle()
            async let prevPRCycle = fetchPrevPRCycle()
            async let retryRate = fetchRetryRate()
            async let trunkRecovery = fetchTrunkRecovery()

            let (rel, prevRel, trunk, prevTrunk, ciDur, prevCiDur, merge, prevMerge, prC, prevPrC, retry, recovery) = try await (
                reliability, prevReliability, trunkHealth, prevTrunkHealth,
                ciDurations, prevCIDurations, merges, prevMerges,
                prCycle, prevPRCycle, retryRate, trunkRecovery
            )

            processReliability(rel, prev: prevRel)
            processTrunkHealth(trunk, prev: prevTrunk)
            processCIDurations(ciDur, prev: prevCiDur)
            processMerges(merge, prev: prevMerge)
            processPRCycle(prC, prev: prevPrC)
            processRetryRate(retry)
            processTrunkRecovery(recovery)

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    // MARK: - Data Structures

    struct ReliabilityRow: Decodable {
        let granularity_bucket: String
        let passed_count: Int
        let failed_count: Int
        let canceled_count: Int
        let total_count: Int
        let non_canceled_count: Int
        let success_rate: Double?
    }

    struct TrunkHealthRow: Decodable {
        let build_number: Int
        let build_started_at: String
        let build_state: String
        let hard_failure_count: Int
        let is_green: Int
    }

    struct CIDurationRow: Decodable {
        let pipeline_name: String?
        let build_number: Int
        let started_at: String
        let finished_at: String
        let build_state: String
        let duration_seconds: Int
        let duration_hours: Double
    }

    struct MergeRow: Decodable {
        let granularity_bucket: String
        let total_count: Int?
        let auto_merged_count: Int?
        let manual_merged_count: Int?
        let manual_merged_with_failures_count: Int?
    }

    struct PRCycleRow: Decodable {
        let time_to_first_review_p50: Double?
        let time_to_first_review_p90: Double?
        let time_to_approval_p50: Double?
        let time_to_approval_p90: Double?
        let time_in_merge_queue_p50: Double?
        let time_in_merge_queue_p90: Double?
    }

    struct RetryRateRow: Decodable {
        let granularity_bucket: String
        let total_jobs: Int
        let retried_count: Int
        let retry_rate: Double?
    }

    struct TrunkRecoveryRow: Decodable {
        let recovery_sha: String
        let recovery_time: String
        let recovery_hours: Double
    }

    // MARK: - Fetch Methods

    private func fetchReliability() async throws -> [ReliabilityRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/ci_reliability",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    private func fetchPrevReliability() async throws -> [ReliabilityRow] {
        let range = prevTimeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/ci_reliability",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    private func fetchTrunkHealth() async throws -> [TrunkHealthRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/trunk_health",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    private func fetchPrevTrunkHealth() async throws -> [TrunkHealthRow] {
        let range = prevTimeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/trunk_health",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    private func fetchCIDurations() async throws -> [CIDurationRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/ci_run_duration",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                ] as [String: Any]
            )
        )
    }

    private func fetchPrevCIDurations() async throws -> [CIDurationRow] {
        let range = prevTimeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/ci_run_duration",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                ] as [String: Any]
            )
        )
    }

    private func fetchMerges() async throws -> [MergeRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/merges_percentage",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "repo": "vllm-project/vllm",
                ] as [String: Any]
            )
        )
    }

    private func fetchPrevMerges() async throws -> [MergeRow] {
        let range = prevTimeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/merges_percentage",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "repo": "vllm-project/vllm",
                ] as [String: Any]
            )
        )
    }

    private func fetchPRCycle() async throws -> [PRCycleRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/pr_cycle_time_breakdown",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "vllm-project/vllm",
                ] as [String: Any]
            )
        )
    }

    private func fetchPrevPRCycle() async throws -> [PRCycleRow] {
        let range = prevTimeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/pr_cycle_time_breakdown",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "vllm-project/vllm",
                ] as [String: Any]
            )
        )
    }

    private func fetchRetryRate() async throws -> [RetryRateRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/rebuild_rate",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": "day",
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    private func fetchTrunkRecovery() async throws -> [TrunkRecoveryRow] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "vllm/trunk_recovery_time",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "https://github.com/vllm-project/vllm",
                    "pipelineName": "vllm-ci",
                    "jobGroups": selectedJobGroups,
                ] as [String: Any]
            )
        )
    }

    // MARK: - Processing Methods

    func processReliability(_ data: [ReliabilityRow], prev: [ReliabilityRow]) {
        let totalPassed = data.reduce(0) { $0 + $1.passed_count }
        let totalFailed = data.reduce(0) { $0 + $1.failed_count }
        let totalNonCanceled = data.reduce(0) { $0 + $1.non_canceled_count }

        if totalNonCanceled > 0 {
            overallSuccessRate = Double(totalPassed) / Double(totalNonCanceled) * 100
        }
        totalFailedBuilds = totalFailed

        let prevTotalPassed = prev.reduce(0) { $0 + $1.passed_count }
        let prevTotalNonCanceled = prev.reduce(0) { $0 + $1.non_canceled_count }
        let prevRate = prevTotalNonCanceled > 0 ? Double(prevTotalPassed) / Double(prevTotalNonCanceled) : nil
        if let current = overallSuccessRate, let prev = prevRate {
            overallSuccessDelta = (current / 100 - prev) * 100
        }

        let prevFailed = prev.reduce(0) { $0 + $1.failed_count }
        if prevFailed > 0 {
            totalFailedDelta = (Double(totalFailed) - Double(prevFailed)) / Double(prevFailed) * 100
        }

        reliabilitySeries = data.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.granularity_bucket,
                value: ($0.success_rate ?? 0) * 100
            )
        }
    }

    func processTrunkHealth(_ data: [TrunkHealthRow], prev: [TrunkHealthRow]) {
        let buildsByDay = Dictionary(grouping: data) { row in
            String(row.build_started_at.prefix(10))
        }
        let dailyStatus = buildsByDay.map { day, builds -> (day: String, isGreen: Bool) in
            let sorted = builds.sorted { $0.build_started_at < $1.build_started_at }
            let isGreen = sorted.last?.is_green == 1
            return (day: day, isGreen: isGreen)
        }.sorted { $0.day < $1.day }

        let greenDays = dailyStatus.filter { $0.isGreen }.count
        let totalDays = dailyStatus.count
        if totalDays > 0 {
            trunkHealthPercent = Double(greenDays) / Double(totalDays) * 100
            commitsOnRedPercent = Double(totalDays - greenDays) / Double(totalDays) * 100
        }

        let prevBuildsByDay = Dictionary(grouping: prev) { String($0.build_started_at.prefix(10)) }
        let prevDailyStatus = prevBuildsByDay.map { $0.value.sorted { $0.build_started_at < $1.build_started_at }.last?.is_green == 1 }
        let prevGreen = prevDailyStatus.filter { $0 }.count
        let prevTotal = prevDailyStatus.count
        if let current = trunkHealthPercent, prevTotal > 0 {
            let prevPct = Double(prevGreen) / Double(prevTotal) * 100
            trunkHealthDelta = (current - prevPct)
        }
        if let current = commitsOnRedPercent, prevTotal > 0 {
            let prevPct = Double(prevTotal - prevGreen) / Double(prevTotal) * 100
            commitsOnRedDelta = (current - prevPct)
        }

        let dailyHealthPct = dailyStatus.map { $0.isGreen ? 1.0 : 0.0 }
        if !dailyHealthPct.isEmpty {
            let mean = dailyHealthPct.reduce(0, +) / Double(dailyHealthPct.count)
            let variance = dailyHealthPct.map { pow($0 - mean, 2) }.reduce(0, +) / Double(dailyHealthPct.count)
            let volatility = sqrt(variance)
            let transitions = dailyHealthPct.enumerated().filter { $0.offset > 0 && dailyHealthPct[$0.offset - 1] != $0.element }.count
            stateTransitions = transitions
            let volatilityPenalty = volatility * 50
            let transitionPenalty = min(Double(transitions) / Double(dailyHealthPct.count), 1) * 50
            ciStabilityScore = max(0, 100 - volatilityPenalty - transitionPenalty)
        }

        let prevDailyHealthPct = prevDailyStatus.map { $0 ? 1.0 : 0.0 }
        if !prevDailyHealthPct.isEmpty {
            let mean = prevDailyHealthPct.reduce(0, +) / Double(prevDailyHealthPct.count)
            let variance = prevDailyHealthPct.map { pow($0 - mean, 2) }.reduce(0, +) / Double(prevDailyHealthPct.count)
            let volatility = sqrt(variance)
            let transitions = prevDailyHealthPct.enumerated().filter { $0.offset > 0 && prevDailyHealthPct[$0.offset - 1] != $0.element }.count
            let volatilityPenalty = volatility * 50
            let transitionPenalty = min(Double(transitions) / Double(prevDailyHealthPct.count), 1) * 50
            let prevStability = max(0, 100 - volatilityPenalty - transitionPenalty)
            if let current = ciStabilityScore {
                ciStabilityDelta = (current - prevStability)
            }
        }

        trunkHealthSeries = dailyStatus.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.day,
                value: $0.isGreen ? 100 : 0
            )
        }
    }

    func processCIDurations(_ data: [CIDurationRow], prev: [CIDurationRow]) {
        let successStates = Set(["passed", "finished", "success"])
        let successDurations = data
            .filter { successStates.contains($0.build_state.lowercased()) }
            .map { $0.duration_hours }
            .sorted()

        let nonCanceledDurations = data
            .filter { !["canceled", "cancelled"].contains($0.build_state.lowercased()) }
            .map { $0.duration_hours }
            .sorted()

        ciSuccessP50 = percentile(successDurations, 0.5)
        ciSuccessP90 = percentile(successDurations, 0.9)
        ciNonCancelP50 = percentile(nonCanceledDurations, 0.5)
        ciNonCancelP90 = percentile(nonCanceledDurations, 0.9)

        let prevSuccessDurations = prev
            .filter { successStates.contains($0.build_state.lowercased()) }
            .map { $0.duration_hours }
            .sorted()
        let prevP50 = percentile(prevSuccessDurations, 0.5)
        let prevP90 = percentile(prevSuccessDurations, 0.9)

        if let current = ciSuccessP50, let prev = prevP50, prev > 0 {
            ciSuccessP50Delta = (current - prev) / prev * 100
        }
        if let current = ciSuccessP90, let prev = prevP90, prev > 0 {
            ciSuccessP90Delta = (current - prev) / prev * 100
        }

        ciDurationSeries = data.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.started_at,
                value: Double($0.duration_seconds)
            )
        }
        // Convert hours to seconds so the .duration formatter displays correctly
        timeToSignalSeries = data
            .filter { successStates.contains($0.build_state.lowercased()) }
            .map {
                TimeSeriesDataPoint(
                    granularity_bucket: $0.started_at,
                    value: $0.duration_hours * 3600
                )
            }
    }

    func processMerges(_ data: [MergeRow], prev: [MergeRow]) {
        let manualMerged = data.reduce(0) { $0 + ($1.manual_merged_count ?? 0) }
        let autoMerged = data.reduce(0) { $0 + ($1.auto_merged_count ?? 0) }
        let forceMerged = data.reduce(0) { $0 + ($1.manual_merged_with_failures_count ?? 0) }
        let total = manualMerged + autoMerged

        totalMerges = total
        autoMerges = autoMerged
        forceMerges = forceMerged

        if total > 0 {
            manualMergePercent = Double(manualMerged) / Double(total) * 100
            forceMergePercent = Double(forceMerged) / Double(total) * 100
        }

        let prevManual = prev.reduce(0) { $0 + ($1.manual_merged_count ?? 0) }
        let prevAuto = prev.reduce(0) { $0 + ($1.auto_merged_count ?? 0) }
        let prevForce = prev.reduce(0) { $0 + ($1.manual_merged_with_failures_count ?? 0) }
        let prevTotal = prevManual + prevAuto

        if let current = manualMergePercent, prevTotal > 0 {
            let prevPct = Double(prevManual) / Double(prevTotal) * 100
            manualMergeDelta = (current - prevPct)
        }
        if let current = forceMergePercent, prevTotal > 0 {
            let prevPct = Double(prevForce) / Double(prevTotal) * 100
            forceMergeDelta = (current - prevPct)
        }

        forceMergeSeries = data.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.granularity_bucket,
                value: Double($0.manual_merged_with_failures_count ?? 0)
            )
        }
        mergeTrendSeries = data.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.granularity_bucket,
                value: Double(($0.manual_merged_count ?? 0) + ($0.auto_merged_count ?? 0))
            )
        }
    }

    func processPRCycle(_ data: [PRCycleRow], prev: [PRCycleRow]) {
        timeToReviewP50 = data.first?.time_to_first_review_p50
        timeToReviewP90 = data.first?.time_to_first_review_p90
        timeToApprovalP50 = data.first?.time_to_approval_p50
        timeToApprovalP90 = data.first?.time_to_approval_p90
        mergeQueueP50 = data.first?.time_in_merge_queue_p50
        mergeQueueP90 = data.first?.time_in_merge_queue_p90

        if let current = timeToReviewP50, let prevVal = prev.first?.time_to_first_review_p50, prevVal > 0 {
            timeToReviewP50Delta = (current - prevVal) / prevVal * 100
        }
        if let current = timeToReviewP90, let prevVal = prev.first?.time_to_first_review_p90, prevVal > 0 {
            timeToReviewP90Delta = (current - prevVal) / prevVal * 100
        }
        if let current = timeToApprovalP50, let prevVal = prev.first?.time_to_approval_p50, prevVal > 0 {
            timeToApprovalP50Delta = (current - prevVal) / prevVal * 100
        }
        if let current = timeToApprovalP90, let prevVal = prev.first?.time_to_approval_p90, prevVal > 0 {
            timeToApprovalP90Delta = (current - prevVal) / prevVal * 100
        }
        if let current = mergeQueueP50, let prevVal = prev.first?.time_in_merge_queue_p50, prevVal > 0 {
            mergeQueueP50Delta = (current - prevVal) / prevVal * 100
        }
        if let current = mergeQueueP90, let prevVal = prev.first?.time_in_merge_queue_p90, prevVal > 0 {
            mergeQueueP90Delta = (current - prevVal) / prevVal * 100
        }
    }

    func processRetryRate(_ data: [RetryRateRow]) {
        let totalJobs = data.reduce(0) { $0 + $1.total_jobs }
        let totalRetries = data.reduce(0) { $0 + $1.retried_count }
        if totalJobs > 0 {
            retryRate = Double(totalRetries) / Double(totalJobs) * 100
        }
        retryRateSeries = data.map {
            TimeSeriesDataPoint(
                granularity_bucket: $0.granularity_bucket,
                value: ($0.retry_rate ?? 0) * 100
            )
        }
    }

    func processTrunkRecovery(_ data: [TrunkRecoveryRow]) {
        if !data.isEmpty {
            avgRecoveryHours = data.reduce(0) { $0 + $1.recovery_hours } / Double(data.count)
        }
    }

    func percentile(_ sorted: [Double], _ p: Double) -> Double? {
        guard !sorted.isEmpty else { return nil }
        let index = Int(floor(Double(sorted.count - 1) * p))
        return sorted[index]
    }
}

#Preview {
    NavigationStack {
        VLLMMetricsView()
    }
}
