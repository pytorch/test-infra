import SwiftUI
import Charts

struct MetricsDashboardView: View {
    @StateObject private var viewModel = MetricsDashboardViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading metrics...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadDashboard() }
                }

            case .loaded:
                metricsContent
            }
        }
        .navigationTitle("Metrics")
        .task {
            await viewModel.loadDashboard()
        }
    }

    @ViewBuilder
    private var metricsContent: some View {
        ScrollView {
            VStack(spacing: 20) {
                controlsSection

                healthSummaryBanner

                commitHealthSection

                mergeMetricsSection

                signalMetricsSection

                buildHealthSection

                activityMetricsSection

                chartsSection

                navigationSection
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Health Summary Banner

    @ViewBuilder
    private var healthSummaryBanner: some View {
        let status = viewModel.overallHealthStatus
        HStack(spacing: 12) {
            Image(systemName: status.icon)
                .font(.title2)
                .foregroundStyle(status.color)
                .frame(width: 36, height: 36)
                .background(status.color.opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(status.title)
                    .font(.headline)
                Text(status.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let lastUpdated = viewModel.lastUpdated {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Updated")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(lastUpdated, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(status.color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(status.color.opacity(0.2), lineWidth: 1)
        )
    }

    // MARK: - Controls

    @ViewBuilder
    private var controlsSection: some View {
        VStack(spacing: 12) {
            TimeRangePicker(selectedRangeID: $viewModel.selectedTimeRange)

            HStack(spacing: 12) {
                GranularityPicker(selection: $viewModel.granularity)

                Picker("Percentile", selection: $viewModel.selectedPercentile) {
                    Text("avg").tag(-1.0)
                    Text("p50").tag(0.5)
                    Text("p90").tag(0.9)
                    Text("p99").tag(0.99)
                }
                .pickerStyle(.menu)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onChange(of: viewModel.selectedTimeRange) {
            Task { await viewModel.onParametersChanged() }
        }
        .onChange(of: viewModel.granularity) {
            Task { await viewModel.onParametersChanged() }
        }
        .onChange(of: viewModel.selectedPercentile) {
            Task { await viewModel.onParametersChanged() }
        }
    }

    // MARK: - Commit Health

    @ViewBuilder
    private var commitHealthSection: some View {
        MetricsSectionCard(
            title: "Commit Health",
            subtitle: "Main branch status",
            icon: "heart.fill",
            iconColor: AppColors.failure
        ) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Red on Main (Broken)",
                    value: formatPercentage(viewModel.brokenTrunkPercent),
                    valueColor: statusColor(
                        for: viewModel.brokenTrunkPercent,
                        thresholds: (warning: 5.0, critical: 15.0)
                    ),
                    trend: viewModel.brokenTrunkTrend,
                    trendIsGoodWhenNegative: true
                )

                MetricCard(
                    title: "Red on Main (Flaky)",
                    value: formatPercentage(viewModel.flakyRedPercent),
                    valueColor: statusColor(
                        for: viewModel.flakyRedPercent,
                        thresholds: (warning: 10.0, critical: 25.0)
                    ),
                    trend: viewModel.flakyRedTrend,
                    trendIsGoodWhenNegative: true
                )

                MetricCard(
                    title: "Viable/Strict Lag",
                    value: formatDuration(viewModel.viableStrictLagSeconds),
                    subtitle: lagStatusLabel(viewModel.viableStrictLagSeconds),
                    valueColor: lagStatusColor(viewModel.viableStrictLagSeconds)
                )

                MetricCard(
                    title: "Disabled Tests",
                    value: viewModel.disabledTestsCount.map { "\($0)" } ?? "--",
                    subtitle: "Currently disabled"
                )
            }
        }
    }

    // MARK: - Merge Metrics

    @ViewBuilder
    private var mergeMetricsSection: some View {
        MetricsSectionCard(
            title: "Merge Metrics",
            subtitle: "PR merge efficiency",
            icon: "arrow.triangle.merge",
            iconColor: .blue
        ) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Force Merge (Failure)",
                    value: formatPercentage(viewModel.forceMergeFailurePercent),
                    subtitle: "Failed PR checks",
                    trend: viewModel.forceMergeFailureTrend,
                    trendIsGoodWhenNegative: true
                )

                MetricCard(
                    title: "Force Merge (Impatience)",
                    value: formatPercentage(viewModel.forceMergeImpatiencePercent),
                    subtitle: "Didn't wait",
                    trend: viewModel.forceMergeImpatienceTrend,
                    trendIsGoodWhenNegative: true
                )

                MetricCard(
                    title: "Merge Retry Rate",
                    value: viewModel.mergeRetryRate.map { String(format: "%.1fx", $0) } ?? "--",
                    subtitle: "Avg retries per merge"
                )

                MetricCard(
                    title: "PR Landing Time",
                    value: viewModel.prLandingTimeHours.map { String(format: "%.1fh", $0) } ?? "--",
                    subtitle: "Avg time to land"
                )
            }
        }
    }

    // MARK: - Signal Metrics

    @ViewBuilder
    private var signalMetricsSection: some View {
        MetricsSectionCard(
            title: "Signal Metrics",
            subtitle: "Time to detect issues",
            icon: "antenna.radiowaves.left.and.right",
            iconColor: .orange
        ) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "TTRS p90",
                    value: viewModel.ttrsP90Minutes.map { "\(Int($0))m" } ?? "--",
                    subtitle: "Time to Red Signal"
                )

                MetricCard(
                    title: "TTRS p75",
                    value: viewModel.ttrsP75Minutes.map { "\(Int($0))m" } ?? "--",
                    subtitle: "Time to Red Signal"
                )

                MetricCard(
                    title: "TTS (pull/trunk)",
                    value: formatDuration(viewModel.workflowTTSSeconds),
                    subtitle: viewModel.selectedPercentileLabel
                )

                MetricCard(
                    title: "Queue Time (Avg)",
                    value: viewModel.avgQueueTimeSeconds.map { formatDurationShort($0) } ?? "--",
                    subtitle: "Current"
                )
            }
        }
    }

    // MARK: - Build Health

    @ViewBuilder
    private var buildHealthSection: some View {
        MetricsSectionCard(
            title: "Build Health",
            subtitle: "Recent build activity",
            icon: "hammer.fill",
            iconColor: .brown
        ) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Last Main Push",
                    value: formatDuration(viewModel.lastMainPushSeconds),
                    subtitle: "Ago",
                    valueColor: freshnesColor(viewModel.lastMainPushSeconds, staleThresholdHours: 2)
                )

                MetricCard(
                    title: "Last Nightly Push",
                    value: formatDuration(viewModel.lastNightlyPushSeconds),
                    subtitle: "Ago",
                    valueColor: freshnesColor(viewModel.lastNightlyPushSeconds, staleThresholdHours: 48)
                )

                MetricCard(
                    title: "Last Docker Build",
                    value: formatDuration(viewModel.lastDockerBuildSeconds),
                    subtitle: "Ago",
                    valueColor: freshnesColor(viewModel.lastDockerBuildSeconds, staleThresholdHours: 48)
                )

                MetricCard(
                    title: "Last Docs Push",
                    value: formatDuration(viewModel.lastDocsPushSeconds),
                    subtitle: "Ago",
                    valueColor: freshnesColor(viewModel.lastDocsPushSeconds, staleThresholdHours: 48)
                )
            }
        }
    }

    // MARK: - Activity Metrics

    @ViewBuilder
    private var activityMetricsSection: some View {
        MetricsSectionCard(
            title: "Activity",
            subtitle: "Development velocity",
            icon: "chart.line.uptrend.xyaxis",
            iconColor: .purple
        ) {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricCard(
                    title: "Reverts",
                    value: viewModel.revertsCount.map { "\($0)" } ?? "--",
                    subtitle: "Last \(viewModel.selectedRange?.label ?? "period")"
                )

                MetricCard(
                    title: "Commits",
                    value: viewModel.commitsCount.map { "\($0)" } ?? "--",
                    subtitle: "Last \(viewModel.selectedRange?.label ?? "period")"
                )

                MetricCard(
                    title: "LF Rollover",
                    value: viewModel.lfRolloverPercent.map { String(format: "%.1f%%", $0) } ?? "--",
                    subtitle: "Linux Foundation fleet"
                )

                if let reverts = viewModel.revertsCount, let commits = viewModel.commitsCount, commits > 0 {
                    MetricCard(
                        title: "Revert Rate",
                        value: String(format: "%.1f%%", Double(reverts) / Double(commits) * 100),
                        subtitle: "Reverts / Commits",
                        valueColor: Double(reverts) / Double(commits) > 0.05
                            ? AppColors.failure
                            : AppColors.success
                    )
                }
            }
        }
    }

    // MARK: - Charts

    @ViewBuilder
    private var chartsSection: some View {
        VStack(spacing: 16) {
            SectionHeader(title: "Trends", subtitle: "Key metric time series")

            if !viewModel.redRateSeries.isEmpty {
                TimeSeriesChart(
                    title: "Commits Red on Main (%)",
                    data: viewModel.redRateSeries,
                    color: AppColors.failure,
                    valueFormat: .percentage(1)
                )
            }

            if !viewModel.queueTimeSeries.isEmpty {
                TimeSeriesChart(
                    title: "Queue Time (seconds)",
                    data: viewModel.queueTimeSeries,
                    color: .teal,
                    valueFormat: .decimal(0)
                )
            }

            if !viewModel.disabledTestsSeries.isEmpty {
                TimeSeriesChart(
                    title: "Disabled Tests (New)",
                    data: viewModel.disabledTestsSeries,
                    color: .purple,
                    valueFormat: .integer,
                    showArea: false
                )
            }

            if viewModel.redRateSeries.isEmpty
                && viewModel.queueTimeSeries.isEmpty
                && viewModel.disabledTestsSeries.isEmpty {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(.secondarySystemBackground))
                    .frame(height: 120)
                    .overlay {
                        VStack(spacing: 8) {
                            Image(systemName: "chart.line.downtrend.xyaxis")
                                .font(.title2)
                                .foregroundStyle(.tertiary)
                            Text("No trend data available")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
            }
        }
    }

    // MARK: - Navigation

    @ViewBuilder
    private var navigationSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Explore", subtitle: "Detailed metric pages")

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 10) {
                MetricsNavLink(
                    title: "KPIs",
                    icon: "chart.bar.fill",
                    color: .blue
                ) {
                    KPIsView()
                }

                MetricsNavLink(
                    title: "Reliability",
                    icon: "checkmark.shield.fill",
                    color: AppColors.success
                ) {
                    ReliabilityView()
                }

                MetricsNavLink(
                    title: "Autorevert",
                    icon: "arrow.uturn.backward.circle.fill",
                    color: .purple
                ) {
                    AutorevertMetricsView()
                }

                MetricsNavLink(
                    title: "vLLM",
                    icon: "brain.filled.head.profile",
                    color: .indigo
                ) {
                    VLLMMetricsView()
                }

                MetricsNavLink(
                    title: "Time-to-Signal",
                    icon: "clock.fill",
                    color: .orange
                ) {
                    TTSView()
                }

                MetricsNavLink(
                    title: "Queue Time",
                    icon: "clock.arrow.circlepath",
                    color: .teal
                ) {
                    QueueTimeView()
                }

                MetricsNavLink(
                    title: "Cost",
                    icon: "dollarsign.circle.fill",
                    color: AppColors.pending
                ) {
                    CostAnalysisView()
                }

                MetricsNavLink(
                    title: "Build Time",
                    icon: "hammer.fill",
                    color: .brown
                ) {
                    BuildTimeView()
                }
            }
        }
    }

    // MARK: - Formatting Helpers

    private func formatPercentage(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.1f%%", value)
    }

    private func formatDuration(_ seconds: Double?) -> String {
        guard let seconds else { return "--" }
        let totalSeconds = Int(seconds)

        if totalSeconds >= 86400 {
            let days = totalSeconds / 86400
            return "\(days)d"
        } else if totalSeconds >= 3600 {
            let hours = totalSeconds / 3600
            let mins = (totalSeconds % 3600) / 60
            return mins > 0 ? "\(hours)h \(mins)m" : "\(hours)h"
        } else if totalSeconds >= 60 {
            let mins = totalSeconds / 60
            return "\(mins)m"
        }
        return "\(totalSeconds)s"
    }

    private func formatDurationShort(_ seconds: Double) -> String {
        let totalSeconds = Int(seconds)

        if totalSeconds >= 3600 {
            let hours = totalSeconds / 3600
            return "\(hours)h"
        } else if totalSeconds >= 60 {
            let mins = totalSeconds / 60
            return "\(mins)m"
        }
        return "\(totalSeconds)s"
    }

    // MARK: - Status Color Helpers

    private func statusColor(
        for value: Double?,
        thresholds: (warning: Double, critical: Double)
    ) -> Color {
        guard let value else { return .primary }
        if value >= thresholds.critical { return AppColors.failure }
        if value >= thresholds.warning { return AppColors.pending }
        return AppColors.success
    }

    private func lagStatusColor(_ seconds: Double?) -> Color {
        guard let seconds else { return .primary }
        if seconds > 43200 { return AppColors.failure }
        if seconds > 21600 { return AppColors.pending }
        return AppColors.success
    }

    private func lagStatusLabel(_ seconds: Double?) -> String? {
        guard let seconds else { return nil }
        if seconds > 43200 { return "Critical" }
        if seconds > 21600 { return "High" }
        return "OK"
    }

    private func freshnesColor(_ seconds: Double?, staleThresholdHours: Int) -> Color {
        guard let seconds else { return .primary }
        let thresholdSeconds = Double(staleThresholdHours * 3600)
        if seconds > thresholdSeconds * 2 { return AppColors.failure }
        if seconds > thresholdSeconds { return AppColors.pending }
        return AppColors.success
    }
}

// MARK: - Section Card Container

private struct MetricsSectionCard<Content: View>: View {
    let title: String
    var subtitle: String?
    var icon: String?
    var iconColor: Color = .primary
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if let icon {
                    Image(systemName: icon)
                        .font(.subheadline)
                        .foregroundStyle(iconColor)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.title3.weight(.semibold))
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            content()
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.04), radius: 6, y: 3)
    }
}

// MARK: - Navigation Link Component

private struct MetricsNavLink<Destination: View>: View {
    let title: String
    let icon: String
    let color: Color
    @ViewBuilder var destination: () -> Destination

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.body)
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)

                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

#Preview {
    NavigationStack {
        MetricsDashboardView()
    }
}
