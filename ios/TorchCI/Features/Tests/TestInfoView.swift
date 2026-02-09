import SwiftUI
import Charts

struct TestInfoView: View {
    @StateObject private var viewModel: TestInfoViewModel

    init(testName: String, testSuite: String, testFile: String = "") {
        _viewModel = StateObject(wrappedValue: TestInfoViewModel(
            testName: testName,
            testSuite: testSuite,
            testFile: testFile
        ))
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading test details...")

            case .loaded:
                scrollContent

            case .error(let message):
                ErrorView(
                    error: NSError(
                        domain: "",
                        code: 0,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )
                ) {
                    Task { await viewModel.loadTestInfo() }
                }
            }
        }
        .navigationTitle("Test Details")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadTestInfo()
        }
    }

    // MARK: - Scroll Content

    private var scrollContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                headerSection
                statsRow
                if !viewModel.trendPoints.isEmpty {
                    trendChartSection
                }
                failureHistorySection
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 6) {
                    TestStatusBadge(status: viewModel.testStatus)

                    Text(viewModel.testName)
                        .font(.headline)
                        .lineLimit(3)
                        .textSelection(.enabled)

                    if !viewModel.testSuite.isEmpty {
                        Label(viewModel.testSuite, systemImage: "folder")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }

                    if !viewModel.testFile.isEmpty {
                        Label(viewModel.testFile, systemImage: "doc.text")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .textSelection(.enabled)
                    }
                }

                Spacer()

                Menu {
                    Button {
                        UIPasteboard.general.string = viewModel.testName
                    } label: {
                        Label("Copy Test Name", systemImage: "doc.on.doc")
                    }
                    Button {
                        UIPasteboard.general.string = "\(viewModel.testSuite).\(viewModel.testName)"
                    } label: {
                        Label("Copy Full Name", systemImage: "doc.on.doc.fill")
                    }
                    if !viewModel.testFile.isEmpty {
                        Button {
                            UIPasteboard.general.string = viewModel.testFile
                        } label: {
                            Label("Copy File Path", systemImage: "folder")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Stats Row

    private var statsRow: some View {
        HStack(spacing: 0) {
            statCell(
                title: "Failures",
                value: viewModel.totalFailures,
                icon: "xmark.circle.fill",
                color: viewModel.failures.isEmpty ? AppColors.success : AppColors.failure
            )

            Divider()
                .frame(height: 40)

            if let passRate = viewModel.passRate {
                statCell(
                    title: "Pass Rate (3d)",
                    value: passRate,
                    icon: "checkmark.circle.fill",
                    color: AppColors.success
                )

                Divider()
                    .frame(height: 40)
            }

            if let flakinessPercentage = viewModel.flakinessPercentage {
                statCell(
                    title: "Flakiness (3d)",
                    value: flakinessPercentage,
                    icon: "chart.line.uptrend.xyaxis",
                    color: AppColors.unstable
                )

                Divider()
                    .frame(height: 40)
            }

            statCell(
                title: "Total Runs",
                value: viewModel.totalRuns > 0 ? "\(viewModel.totalRuns)" : "--",
                icon: "number",
                color: .secondary
            )
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    private func statCell(title: String, value: String, icon: String, color: Color) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.caption2)
                Text(value)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(color)

            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Trend Chart

    private var trendChartSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Test Results Trend",
                subtitle: "Last 3 days on main branch"
            )

            Chart {
                ForEach(viewModel.trendPoints) { point in
                    if point.success > 0 {
                        BarMark(
                            x: .value("Time", point.hour, unit: .hour),
                            y: .value("Count", point.success)
                        )
                        .foregroundStyle(AppColors.success)
                        .position(by: .value("Status", "Success"))
                    }

                    if point.failed > 0 {
                        BarMark(
                            x: .value("Time", point.hour, unit: .hour),
                            y: .value("Count", point.failed)
                        )
                        .foregroundStyle(AppColors.failure)
                        .position(by: .value("Status", "Failed"))
                    }

                    if point.flaky > 0 {
                        BarMark(
                            x: .value("Time", point.hour, unit: .hour),
                            y: .value("Count", point.flaky)
                        )
                        .foregroundStyle(AppColors.unstable)
                        .position(by: .value("Status", "Flaky"))
                    }

                    if point.skipped > 0 {
                        BarMark(
                            x: .value("Time", point.hour, unit: .hour),
                            y: .value("Count", point.skipped)
                        )
                        .foregroundStyle(AppColors.skipped)
                        .position(by: .value("Status", "Skipped"))
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .hour, count: 12)) { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                        .foregroundStyle(.secondary.opacity(0.3))
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day().hour())
                        .font(.caption2)
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                        .foregroundStyle(.secondary.opacity(0.3))
                    AxisValueLabel()
                        .font(.caption2)
                }
            }
            .chartLegend(position: .bottom, spacing: 8) {
                HStack(spacing: 16) {
                    legendItem(color: AppColors.success, label: "Success")
                    legendItem(color: AppColors.failure, label: "Failed")
                    legendItem(color: AppColors.unstable, label: "Flaky")
                    legendItem(color: AppColors.skipped, label: "Skipped")
                }
                .font(.caption2)
            }
            .frame(height: 220)
            .padding()
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        }
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Failure History

    private var failureHistorySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionHeader(
                    title: "Failure History",
                    subtitle: "\(viewModel.recentFailures.count) recent failures"
                )

                Spacer()

                Menu {
                    ForEach(TestInfoViewModel.BranchFilter.allCases, id: \.rawValue) { filter in
                        Button {
                            viewModel.branchFilter = filter
                        } label: {
                            HStack {
                                Text(filter.rawValue)
                                if viewModel.branchFilter == filter {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }

                    Divider()

                    Button {
                        viewModel.expandAll()
                    } label: {
                        Label("Expand All", systemImage: "arrow.up.left.and.arrow.down.right")
                    }

                    Button {
                        viewModel.collapseAll()
                    } label: {
                        Label("Collapse All", systemImage: "arrow.down.right.and.arrow.up.left")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "line.3.horizontal.decrease")
                        Text(viewModel.branchFilter.rawValue)
                            .font(.caption)
                    }
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(Capsule())
                }
            }

            if viewModel.recentFailures.isEmpty {
                noFailuresView
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(viewModel.recentFailures) { failure in
                        failureRow(failure)
                        if failure.id != viewModel.recentFailures.last?.id {
                            Divider()
                                .padding(.leading, 44)
                        }
                    }
                }
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
            }
        }
    }

    private var noFailuresView: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(AppColors.success)
            Text("No recent failures")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func failureRow(_ failure: TestFailure) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    viewModel.toggleFailureExpansion(failure)
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: conclusionIcon(failure.conclusion))
                        .foregroundStyle(conclusionColor(failure.conclusion))
                        .font(.subheadline)
                        .frame(width: 24)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(failure.jobName ?? "Unknown Job")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)

                        HStack(spacing: 8) {
                            if let time = failure.time {
                                HStack(spacing: 3) {
                                    Image(systemName: "clock")
                                        .font(.caption2)
                                    Text(formatRelativeTime(time))
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }

                            if let branch = failure.branch {
                                HStack(spacing: 3) {
                                    Image(systemName: "arrow.branch")
                                        .font(.caption2)
                                    Text(branch)
                                        .lineLimit(1)
                                }
                                .font(.caption)
                                .foregroundStyle(branch == "main" ? AppColors.unstable : .secondary)
                            }

                            if let sha = failure.sha {
                                Text(String(sha.prefix(7)))
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(.tertiarySystemBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 4))
                            }
                        }

                        if let traceback = failure.traceback, !traceback.isEmpty,
                           !viewModel.isFailureExpanded(failure) {
                            Text(traceback)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }

                    Spacer()

                    Image(systemName: viewModel.isFailureExpanded(failure) ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(width: 20)
                }
                .padding(12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(viewModel.isFailureExpanded(failure) ? "Collapse failure details" : "Expand failure details")

            if viewModel.isFailureExpanded(failure) {
                expandedFailureContent(failure)
            }
        }
    }

    private func expandedFailureContent(_ failure: TestFailure) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let traceback = failure.traceback, !traceback.isEmpty {
                tracebackView(traceback)
            }

            HStack(spacing: 8) {
                if let htmlUrl = failure.htmlUrl, let url = URL(string: htmlUrl) {
                    Link(destination: url) {
                        Label("View Job", systemImage: "link")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }

                if let logUrl = failure.logUrl, let url = URL(string: logUrl) {
                    Link(destination: url) {
                        Label("View Logs", systemImage: "doc.text")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }

                if let traceback = failure.traceback, !traceback.isEmpty {
                    Button {
                        UIPasteboard.general.string = traceback
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }

    private func tracebackView(_ traceback: String) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(traceback)
                .font(AppTypography.monospacedSmall)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .padding(12)
        }
        .frame(maxHeight: 200)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 12)
    }

    // MARK: - Helpers

    private func formatRelativeTime(_ timeString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: timeString) else {
            return timeString
        }

        let now = Date()
        let interval = now.timeIntervalSince(date)

        if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes)m ago"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h ago"
        } else {
            let days = Int(interval / 86400)
            return "\(days)d ago"
        }
    }

    private func conclusionIcon(_ conclusion: String?) -> String {
        switch conclusion?.lowercased() {
        case "failure", "failed":
            return "xmark.circle.fill"
        case "success":
            return "checkmark.circle.fill"
        case "cancelled", "canceled":
            return "minus.circle.fill"
        default:
            return "questionmark.circle.fill"
        }
    }

    private func conclusionColor(_ conclusion: String?) -> Color {
        switch conclusion?.lowercased() {
        case "failure", "failed":
            return AppColors.failure
        case "success":
            return AppColors.success
        case "cancelled", "canceled":
            return AppColors.skipped
        default:
            return AppColors.neutral
        }
    }
}

#Preview {
    NavigationStack {
        TestInfoView(
            testName: "test_conv2d_backward_gpu",
            testSuite: "TestConvolutionNNDeviceTypeCUDA",
            testFile: "test/test_nn.py"
        )
    }
}
