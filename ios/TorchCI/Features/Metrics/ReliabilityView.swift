import SwiftUI
import Charts

struct ReliabilityView: View {
    @StateObject private var viewModel = ReliabilityViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading reliability data...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadReliability() }
                }

            case .loaded:
                reliabilityContent
            }
        }
        .navigationTitle("Reliability")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadReliability()
        }
    }

    @ViewBuilder
    private var reliabilityContent: some View {
        VStack(spacing: 0) {
            // Overall reliability card (pinned at top)
            overallReliabilityCard
                .padding(.horizontal)
                .padding(.top, 8)

            ScrollView {
                VStack(spacing: 16) {
                    summaryRow

                    healthDistributionBar

                    filterAndTimeRange

                    reliabilityTrendChart

                    searchAndSortBar

                    failureBreakdownChart

                    workflowList
                }
                .padding()
            }
            .refreshable {
                await viewModel.refresh()
            }
        }
    }

    // MARK: - Summary

    @ViewBuilder
    private var overallReliabilityCard: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Overall Reliability")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                Spacer()
                trendBadge
            }

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(String(format: "%.1f", viewModel.overallReliabilityRate))
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(reliabilityColor(viewModel.overallReliabilityRate))
                Text("%")
                    .font(.title2.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }

            HStack(spacing: 16) {
                statBadge(
                    label: "Jobs",
                    value: formatCount(viewModel.totalJobs),
                    color: .blue
                )
                statBadge(
                    label: "Failed",
                    value: formatCount(viewModel.totalFailed),
                    color: AppColors.failure
                )
                statBadge(
                    label: "Passed",
                    value: formatCount(viewModel.totalJobs - viewModel.totalFailed),
                    color: AppColors.success
                )
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
    }

    @ViewBuilder
    private var trendBadge: some View {
        let trend = viewModel.reliabilityTrend
        HStack(spacing: 3) {
            Image(systemName: trend.icon)
            Text(trend.label)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(trend.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(trend.color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private var summaryRow: some View {
        HStack(spacing: 10) {
            ScalarPanel(
                label: "Total Jobs",
                value: formatCount(viewModel.totalJobs),
                icon: "number"
            )
            ScalarPanel(
                label: "Failure Rate",
                value: String(format: "%.1f%%", viewModel.overallFailureRate),
                icon: "xmark.circle",
                valueColor: viewModel.overallFailureRate > 10
                    ? AppColors.failure : AppColors.success
            )
            ScalarPanel(
                label: "Failed",
                value: formatCount(viewModel.totalFailed),
                icon: "exclamationmark.triangle",
                valueColor: AppColors.failure
            )
        }
    }

    // MARK: - Health Distribution

    @ViewBuilder
    private var healthDistributionBar: some View {
        let total = max(viewModel.filteredWorkflows.count, 1)
        let healthy = viewModel.healthyWorkflowCount
        let warning = viewModel.warningWorkflowCount
        let critical = viewModel.criticalWorkflowCount

        VStack(alignment: .leading, spacing: 8) {
            Text("Workflow Health")
                .font(.subheadline.weight(.medium))

            GeometryReader { geometry in
                HStack(spacing: 1) {
                    let healthyWidth = CGFloat(healthy) / CGFloat(total) * geometry.size.width
                    let warningWidth = CGFloat(warning) / CGFloat(total) * geometry.size.width
                    let criticalWidth = CGFloat(critical) / CGFloat(total) * geometry.size.width

                    Rectangle()
                        .fill(AppColors.success)
                        .frame(width: max(healthyWidth, healthy > 0 ? 4 : 0))

                    Rectangle()
                        .fill(AppColors.unstable)
                        .frame(width: max(warningWidth, warning > 0 ? 4 : 0))

                    Rectangle()
                        .fill(AppColors.failure)
                        .frame(width: max(criticalWidth, critical > 0 ? 4 : 0))
                }
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            .frame(height: 10)

            HStack(spacing: 16) {
                healthLegendItem(
                    color: AppColors.success,
                    label: "Healthy",
                    count: healthy
                )
                healthLegendItem(
                    color: AppColors.unstable,
                    label: "Warning",
                    count: warning
                )
                healthLegendItem(
                    color: AppColors.failure,
                    label: "Critical",
                    count: critical
                )
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Filters

    @ViewBuilder
    private var filterAndTimeRange: some View {
        VStack(spacing: 10) {
            TimeRangePicker(
                selectedRangeID: $viewModel.selectedTimeRange,
                ranges: Array(TimeRange.presets.prefix(5))
            )

            Picker("Filter", selection: $viewModel.selectedFilter) {
                ForEach(ReliabilityViewModel.WorkflowFilter.allCases, id: \.self) { filter in
                    Text(filter.rawValue).tag(filter)
                }
            }
            .pickerStyle(.segmented)
        }
        .onChange(of: viewModel.selectedTimeRange) {
            Task { await viewModel.onParametersChanged() }
        }
        .onChange(of: viewModel.selectedFilter) {
            // Filtering is local; no refetch needed
        }
    }

    @ViewBuilder
    private var searchAndSortBar: some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search workflows...", text: $viewModel.searchText)
                    .textFieldStyle(.plain)
                if !viewModel.searchText.isEmpty {
                    Button {
                        viewModel.searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            HStack {
                Text("Sort by:")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Picker("Sort", selection: $viewModel.sortOrder) {
                    ForEach(ReliabilityViewModel.SortOrder.allCases, id: \.self) { order in
                        Text(order.rawValue).tag(order)
                    }
                }
                .pickerStyle(.menu)
                .tint(.primary)
                Spacer()
            }
        }
    }

    // MARK: - Reliability Trend Chart

    @ViewBuilder
    private var reliabilityTrendChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Reliability Trend")
                    .font(.headline)
                Spacer()
                trendBadge
            }

            if viewModel.reliabilityTrendSeries.isEmpty {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.secondarySystemBackground))
                    .frame(height: 160)
                    .overlay {
                        Text("No trend data available")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
            } else {
                SparklineChart(
                    data: viewModel.reliabilityTrendSeries,
                    color: reliabilityColor(viewModel.overallReliabilityRate),
                    height: 160
                )
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Stacked Bar Chart

    @ViewBuilder
    private var failureBreakdownChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Failure Breakdown")
                .font(.headline)

            Chart(viewModel.failureBreakdown) { item in
                BarMark(
                    x: .value("Count", item.count),
                    y: .value("Category", item.category)
                )
                .foregroundStyle(item.color)
                .cornerRadius(4)
            }
            .chartXAxis {
                AxisMarks(position: .bottom) {
                    AxisValueLabel()
                    AxisGridLine()
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) {
                    AxisValueLabel()
                }
            }
            .frame(height: 140)

            HStack(spacing: 16) {
                legendItem(color: AppColors.failure, label: "Broken Trunk")
                legendItem(color: AppColors.unstable, label: "Flaky")
                legendItem(color: AppColors.pending, label: "Infra")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Workflow List

    @ViewBuilder
    private var workflowList: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "Per-Workflow Stats",
                subtitle: "\(viewModel.filteredWorkflows.count) workflows"
            )

            if viewModel.filteredWorkflows.isEmpty {
                Text("No workflows match the current filters")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(viewModel.filteredWorkflows) { workflow in
                        workflowRow(workflow)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func workflowRow(_ workflow: ReliabilityData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(workflow.workflowName)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(2)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)

                        // Reliability percentage with color
                        HStack(spacing: 6) {
                            Image(systemName: reliabilityIcon(100 - workflow.failureRate))
                                .font(.caption2)
                            Text(String(format: "%.1f%% reliable", 100 - workflow.failureRate))
                                .font(.caption)
                        }
                        .foregroundStyle(reliabilityColor(100 - workflow.failureRate))
                    }

                    Spacer()

                    VStack(alignment: .trailing, spacing: 2) {
                        Text(String(format: "%.1f%%", workflow.failureRate))
                            .font(.title3.bold())
                            .foregroundStyle(
                                workflow.failureRate > 10 ? AppColors.failure
                                    : workflow.failureRate > 5 ? AppColors.unstable
                                    : AppColors.success
                            )
                        Text("failure rate")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 12) {
                    statLabel("Total", value: "\(workflow.totalJobs)")
                    statLabel("Failed", value: "\(workflow.failedJobs)", color: AppColors.failure)
                    if let brokenTrunk = workflow.brokenTrunk, brokenTrunk > 0 {
                        statLabel("Trunk", value: "\(brokenTrunk)", color: AppColors.failure)
                    }
                    if let flaky = workflow.flaky, flaky > 0 {
                        statLabel("Flaky", value: "\(flaky)", color: AppColors.unstable)
                    }
                    if let infra = workflow.infra, infra > 0 {
                        statLabel("Infra", value: "\(infra)", color: AppColors.pending)
                    }
                }

                // Proportional bar
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        let total = max(workflow.totalJobs, 1)
                        let passWidth = CGFloat(workflow.totalJobs - workflow.failedJobs) / CGFloat(total) * geometry.size.width
                        let failWidth = geometry.size.width - passWidth

                        Rectangle()
                            .fill(AppColors.success.opacity(0.6))
                            .frame(width: max(passWidth, 0))

                        Rectangle()
                            .fill(AppColors.failure.opacity(0.6))
                            .frame(width: max(failWidth, 0))
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 3))
                }
                .frame(height: 6)
            }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Helpers

    @ViewBuilder
    private func statLabel(_ title: String, value: String, color: Color = .secondary) -> some View {
        HStack(spacing: 3) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(value)
                .foregroundStyle(color)
        }
        .font(.caption2)
    }

    @ViewBuilder
    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
        }
    }

    @ViewBuilder
    private func healthLegendItem(color: Color, label: String, count: Int) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text("\(label) (\(count))")
        }
    }

    @ViewBuilder
    private func statBadge(label: String, value: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.bold())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(color.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func formatCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        }
        if count >= 1_000 {
            return String(format: "%.1fk", Double(count) / 1_000)
        }
        return "\(count)"
    }

    private func reliabilityColor(_ reliability: Double) -> Color {
        if reliability >= 95 {
            return AppColors.success
        } else if reliability >= 90 {
            return AppColors.unstable
        } else {
            return AppColors.failure
        }
    }

    private func reliabilityIcon(_ reliability: Double) -> String {
        if reliability >= 95 {
            return "checkmark.circle.fill"
        } else if reliability >= 90 {
            return "exclamationmark.triangle.fill"
        } else {
            return "xmark.circle.fill"
        }
    }
}

#Preview {
    NavigationStack {
        ReliabilityView()
    }
}
