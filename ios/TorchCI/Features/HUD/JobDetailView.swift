import SwiftUI

struct JobDetailView: View {
    @StateObject private var viewModel: JobDetailViewModel

    @State private var showingSafari = false
    @State private var safariURL: URL?

    @Environment(\.dismiss) private var dismiss

    init(job: JobData) {
        _viewModel = StateObject(wrappedValue: JobDetailViewModel(job: job))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerSection
                statusCard

                if viewModel.hasFailureInfo {
                    failureBanner
                }

                if viewModel.hasAnyMetrics {
                    metricsSection
                }

                if viewModel.hasFailureInfo {
                    failureDetailsSection
                }

                if viewModel.hasSteps {
                    stepsSection
                }

                if viewModel.hasRunnerInfo {
                    runnerSection
                }

                if viewModel.hasPreviousRun {
                    previousRunSection
                }

                actionsSection
            }
            .padding()
        }
        .navigationTitle("Job Details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
        .sheet(isPresented: $showingSafari) {
            if let url = safariURL {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(viewModel.displayName)
                .font(.title2.weight(.bold))
                .textSelection(.enabled)
                .lineLimit(3)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(viewModel.workflowDisplayName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let jobId = viewModel.jobIdDisplay {
                    HStack(spacing: 4) {
                        Image(systemName: "number")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(jobId)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Status Card

    private var statusCardColor: Color {
        AppColors.forConclusion(
            viewModel.job.unstable == true ? "unstable" : viewModel.job.conclusion
        )
    }

    private var statusCard: some View {
        HStack(spacing: 14) {
            JobStatusBadge(
                conclusion: viewModel.job.conclusion,
                isUnstable: viewModel.job.unstable == true,
                showLabel: true
            )

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(viewModel.statusSummaryText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)

                if let status = viewModel.job.status?.lowercased(),
                   status != viewModel.job.conclusion?.lowercased() {
                    Text(status.capitalized)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(statusCardColor.opacity(0.3), lineWidth: 2)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Failure Banner

    @ViewBuilder
    private var failureBanner: some View {
        if let summary = viewModel.failureSummary {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(AppColors.failure)

                Text(summary)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(AppColors.failure)
                    .lineLimit(2)
                    .textSelection(.enabled)

                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppColors.failure.opacity(0.08))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(AppColors.failure.opacity(0.2), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Metrics

    private var metricsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Metrics")

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 10),
                    GridItem(.flexible(), spacing: 10),
                ],
                spacing: 10
            ) {
                if let duration = viewModel.job.durationFormatted {
                    metricTile(
                        icon: "clock.fill",
                        label: "Duration",
                        value: duration,
                        color: .blue
                    )
                }

                if let queueTime = viewModel.queueTimeFormatted {
                    metricTile(
                        icon: "hourglass",
                        label: "Queue Time",
                        value: queueTime,
                        color: .orange
                    )
                }

                if let attempt = viewModel.runAttemptDisplay {
                    metricTile(
                        icon: "arrow.clockwise",
                        label: "Run",
                        value: attempt,
                        color: .purple
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func metricTile(icon: String, label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(color)
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Failure Details

    private var failureDetailsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Failure Details")

            if let failureLines = viewModel.job.failureLines, !failureLines.isEmpty {
                DisclosureGroup(
                    isExpanded: $viewModel.isFailureLinesExpanded
                ) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(failureLines.enumerated()), id: \.offset) { index, line in
                            HStack(alignment: .top, spacing: 8) {
                                Text("\(index + 1)")
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 18, alignment: .trailing)

                                Text(line)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(AppColors.failure)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppColors.failure.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(AppColors.failure)
                        Text("Failure Lines (\(failureLines.count))")
                            .font(.subheadline.weight(.medium))
                    }
                }
            }

            if let failureCaptures = viewModel.job.failureCaptures, !failureCaptures.isEmpty {
                DisclosureGroup(
                    isExpanded: $viewModel.isFailureCapturesExpanded
                ) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(failureCaptures.enumerated()), id: \.offset) { _, capture in
                            Text(capture)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(AppColors.failure)
                                .textSelection(.enabled)
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppColors.failure.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "text.magnifyingglass")
                            .foregroundStyle(AppColors.failure)
                        Text("Failure Captures (\(failureCaptures.count))")
                            .font(.subheadline.weight(.medium))
                    }
                }
            }

            if let failureContext = viewModel.job.failureContext, !failureContext.isEmpty {
                DisclosureGroup(
                    isExpanded: $viewModel.isFailureContextExpanded
                ) {
                    Text(failureContext)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text")
                            .foregroundStyle(.secondary)
                        Text("Failure Context")
                            .font(.subheadline.weight(.medium))
                    }
                }
            }
        }
    }

    // MARK: - Steps

    private var stepsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            let progress = viewModel.stepsProgress
            let counts = viewModel.stepCounts

            DisclosureGroup(
                isExpanded: $viewModel.isStepsExpanded
            ) {
                VStack(spacing: 0) {
                    // Step progress bar
                    stepProgressBar

                    Divider()

                    ForEach(viewModel.sortedSteps) { step in
                        stepRow(step)
                        if step.id != viewModel.sortedSteps.last?.id {
                            Divider()
                                .padding(.leading, 48)
                        }
                    }
                }
                .padding(.vertical, 4)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            } label: {
                HStack(spacing: 12) {
                    SectionHeader(
                        title: "Steps",
                        subtitle: stepsSummarySubtitle(
                            progress: progress,
                            counts: counts
                        )
                    )
                    Spacer()
                }
            }
        }
    }

    private func stepsSummarySubtitle(
        progress: (completed: Int, total: Int),
        counts: (success: Int, failure: Int, skipped: Int, pending: Int)
    ) -> String {
        var parts: [String] = []
        if counts.success > 0 {
            parts.append("\(counts.success) passed")
        }
        if counts.failure > 0 {
            parts.append("\(counts.failure) failed")
        }
        if counts.skipped > 0 {
            parts.append("\(counts.skipped) skipped")
        }
        if counts.pending > 0 {
            parts.append("\(counts.pending) pending")
        }
        if parts.isEmpty {
            return "\(progress.completed)/\(progress.total) completed"
        }
        return parts.joined(separator: " \u{2022} ")
    }

    private var stepProgressBar: some View {
        let counts = viewModel.stepCounts
        let total = viewModel.stepsProgress.total

        return GeometryReader { geometry in
            HStack(spacing: 1) {
                if counts.success > 0 {
                    Rectangle()
                        .fill(AppColors.success)
                        .frame(width: segmentWidth(counts.success, total: total, in: geometry.size.width))
                }
                if counts.failure > 0 {
                    Rectangle()
                        .fill(AppColors.failure)
                        .frame(width: segmentWidth(counts.failure, total: total, in: geometry.size.width))
                }
                if counts.skipped > 0 {
                    Rectangle()
                        .fill(AppColors.skipped)
                        .frame(width: segmentWidth(counts.skipped, total: total, in: geometry.size.width))
                }
                if counts.pending > 0 {
                    Rectangle()
                        .fill(AppColors.pending.opacity(0.4))
                        .frame(width: segmentWidth(counts.pending, total: total, in: geometry.size.width))
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 6)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func segmentWidth(_ count: Int, total: Int, in totalWidth: CGFloat) -> CGFloat {
        guard total > 0 else { return 0 }
        return max(2, totalWidth * CGFloat(count) / CGFloat(total))
    }

    @ViewBuilder
    private func stepRow(_ step: JobStep) -> some View {
        let isFailed = step.conclusion == "failure"

        HStack(spacing: 10) {
            // Step number and status icon column
            VStack(spacing: 2) {
                JobStatusIcon(conclusion: step.conclusion)

                Text("\(step.number)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            .frame(width: 28)

            // Step details
            VStack(alignment: .leading, spacing: 3) {
                Text(step.name)
                    .font(.subheadline.weight(isFailed ? .semibold : .regular))
                    .foregroundStyle(isFailed ? AppColors.failure : .primary)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let duration = stepDuration(step) {
                        Label(duration, systemImage: "clock")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if let conclusion = step.conclusion {
                        Text(conclusionDisplayText(conclusion))
                            .font(.caption2)
                            .foregroundStyle(AppColors.forConclusion(conclusion))
                    }
                }
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(isFailed ? AppColors.failure.opacity(0.05) : Color.clear)
    }

    private func conclusionDisplayText(_ conclusion: String) -> String {
        switch conclusion.lowercased() {
        case "success": return "Passed"
        case "failure": return "Failed"
        case "skipped": return "Skipped"
        case "cancelled", "canceled": return "Cancelled"
        case "in_progress": return "Running"
        default: return conclusion.capitalized
        }
    }

    private func stepDuration(_ step: JobStep) -> String? {
        guard let startedAt = step.startedAt,
              let completedAt = step.completedAt,
              let startDate = ISO8601DateFormatter().date(from: startedAt),
              let endDate = ISO8601DateFormatter().date(from: completedAt)
        else {
            return nil
        }

        let seconds = Int(endDate.timeIntervalSince(startDate))
        if seconds < 0 { return nil }

        let minutes = seconds / 60
        let secs = seconds % 60
        if minutes > 0 {
            return "\(minutes)m \(secs)s"
        } else {
            return "\(secs)s"
        }
    }

    // MARK: - Runner

    private var runnerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(
                isExpanded: $viewModel.isRunnerInfoExpanded
            ) {
                VStack(alignment: .leading, spacing: 10) {
                    if let runnerName = viewModel.job.runnerName {
                        HStack(spacing: 8) {
                            Image(systemName: "server.rack")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Runner Name")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(runnerName)
                                    .font(.subheadline)
                                    .textSelection(.enabled)
                            }
                        }
                    }

                    if let runnerGroup = viewModel.job.runnerGroup {
                        HStack(spacing: 8) {
                            Image(systemName: "square.stack.3d.up")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Runner Group")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(runnerGroup)
                                    .font(.subheadline)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } label: {
                SectionHeader(title: "Runner")
            }
        }
    }

    // MARK: - Actions

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Actions")

            VStack(spacing: 10) {
                if let htmlUrl = viewModel.githubURL, URL(string: htmlUrl) != nil {
                    Button {
                        safariURL = URL(string: htmlUrl)
                        showingSafari = true
                    } label: {
                        HStack {
                            Image(systemName: "arrow.up.right.square")
                                .font(.subheadline)
                            Text("View on GitHub")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }

                if let logUrl = viewModel.logsURL, URL(string: logUrl) != nil {
                    Button {
                        safariURL = URL(string: logUrl)
                        showingSafari = true
                    } label: {
                        HStack {
                            Image(systemName: "doc.text.magnifyingglass")
                                .font(.subheadline)
                            Text("View Full Logs")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }

                if viewModel.githubURL != nil {
                    Button {
                        viewModel.copyLink()
                    } label: {
                        HStack {
                            Image(systemName: viewModel.copiedLink ? "checkmark.circle.fill" : "doc.on.doc")
                                .font(.subheadline)
                            Text(viewModel.copiedLink ? "Copied to Clipboard" : "Copy Job Link")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            if !viewModel.copiedLink {
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .foregroundStyle(viewModel.copiedLink ? AppColors.success : .primary)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .animation(.easeInOut(duration: 0.2), value: viewModel.copiedLink)
                }
            }
        }
    }

    // MARK: - Previous Run

    @ViewBuilder
    private var previousRunSection: some View {
        if let previousRun = viewModel.job.previousRun {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Previous Run",
                    subtitle: "Compare with last attempt"
                )

                HStack(spacing: 12) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    JobStatusBadge(
                        conclusion: previousRun.conclusion,
                        showLabel: true
                    )

                    Spacer()

                    if let htmlUrl = previousRun.htmlUrl, URL(string: htmlUrl) != nil {
                        Button {
                            safariURL = URL(string: htmlUrl)
                            showingSafari = true
                        } label: {
                            HStack(spacing: 4) {
                                Text("View")
                                    .font(.subheadline.weight(.medium))
                                Image(systemName: "arrow.up.right")
                                    .font(.caption)
                            }
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    }
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

#Preview {
    NavigationStack {
        JobDetailView(
            job: JobData(
                id: 12345,
                name: "linux-test / test-distributed",
                workflowName: "linux-test",
                workflowId: 100,
                jobName: "test-distributed (shard 1/3)",
                conclusion: "failure",
                htmlUrl: "https://github.com/pytorch/pytorch/actions/runs/12345",
                logUrl: "https://ossci-raw-job-status.s3.amazonaws.com/log/12345",
                durationS: 3450,
                queueTimeS: 125,
                failureLines: [
                    "FAIL test_c10d_spawn.py::TestDistributed::test_allreduce",
                    "RuntimeError: NCCL error: unhandled system error",
                ],
                failureCaptures: [
                    "RuntimeError: NCCL error",
                ],
                failureContext: "Process finished with exit code 1",
                runnerName: "linux.g5.4xlarge.nvidia.gpu-0",
                runnerGroup: "linux.g5.4xlarge.nvidia.gpu",
                status: "completed",
                steps: [
                    JobStep(name: "Set up job", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
                    JobStep(name: "Checkout code", conclusion: "success", number: 2, startedAt: nil, completedAt: nil),
                    JobStep(name: "Run tests", conclusion: "failure", number: 3, startedAt: nil, completedAt: nil),
                    JobStep(name: "Upload artifacts", conclusion: "skipped", number: 4, startedAt: nil, completedAt: nil),
                ],
                time: nil,
                unstable: false,
                previousRun: PreviousRun(conclusion: "success", htmlUrl: "https://github.com/pytorch/pytorch/actions/runs/12344"),
                runAttempt: 2
            )
        )
    }
}
