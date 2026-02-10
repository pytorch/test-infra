import SwiftUI
import UIKit

struct HUDView: View {
    @StateObject var viewModel = HUDViewModel()
    @Binding var navigationPath: NavigationPath

    @State private var selectedJob: HUDJob?
    @State private var selectedJobName: String = ""
    @State private var showingJobDetail = false
    @State private var selectedCommitRow: HUDRow?
    @State private var showingCommitJobs = false

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    var body: some View {
        VStack(spacing: 0) {
            FilterBar(viewModel: viewModel)

                // Show warning banner for consecutive failures
                if viewModel.consecutiveFailures >= 3 {
                    failureWarningBanner
                }

                // Show quick stats bar when data is loaded
                if viewModel.hasData && viewModel.state == .loaded {
                    quickStatsBar
                }

                if let lastRefreshed = viewModel.lastRefreshed {
                    HStack {
                        Spacer()
                        Text("Updated \(lastRefreshed, formatter: Self.relativeFormatter)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }

                mainContent
            }
            .navigationTitle("CI HUD")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        if viewModel.hasData {
                            Menu {
                                let stats = viewModel.jobHealthStats
                                Section("Summary") {
                                    Label("\(viewModel.filteredRows.count) commits", systemImage: "tray.2")
                                    Label("\(viewModel.filteredJobNames.count) jobs", systemImage: "square.grid.2x2")
                                    if !stats.isEmpty {
                                        Label("\(stats.successPercentage) pass rate", systemImage: "checkmark.circle")
                                    }
                                }

                                if viewModel.consecutiveFailures > 0 {
                                    Section("Health") {
                                        Label(
                                            "\(viewModel.consecutiveFailures) consecutive failures",
                                            systemImage: "exclamationmark.triangle"
                                        )
                                    }
                                }

                                Divider()

                                Button {
                                    let link = "https://hud.pytorch.org/hud/\(viewModel.selectedRepo.owner)/\(viewModel.selectedRepo.name)/\(viewModel.selectedBranch)"
                                    UIPasteboard.general.string = link
                                } label: {
                                    Label("Copy HUD Link", systemImage: "link")
                                }

                                Button {
                                    Task { await viewModel.refresh() }
                                } label: {
                                    Label("Refresh", systemImage: "arrow.clockwise")
                                }

                                Button {
                                    viewModel.toggleAutoRefresh()
                                } label: {
                                    Label(
                                        viewModel.isAutoRefreshEnabled ? "Disable Auto-Refresh" : "Enable Auto-Refresh",
                                        systemImage: viewModel.isAutoRefreshEnabled ? "clock.badge.checkmark" : "clock"
                                    )
                                }
                            } label: {
                                Image(systemName: "info.circle")
                                    .font(.body)
                            }
                        }
                    }
                }
            }
            .refreshable {
                let impact = UIImpactFeedbackGenerator(style: .medium)
                impact.impactOccurred()
                await viewModel.refresh()
            }
            .onAppear {
                if viewModel.state == .idle {
                    Task { await viewModel.loadData() }
                }
                viewModel.startAutoRefresh()
            }
            .onDisappear {
                viewModel.stopAutoRefresh()
            }
            .navigationDestination(for: CommitNavigation.self) { nav in
                CommitDetailView(
                    sha: nav.sha,
                    repoOwner: nav.repoOwner,
                    repoName: nav.repoName
                )
            }
            .navigationDestination(for: PRNavigation.self) { nav in
                PRDetailView(
                    prNumber: nav.prNumber,
                    repoOwner: nav.repoOwner,
                    repoName: nav.repoName
                )
            }
            .sheet(isPresented: $showingJobDetail) {
                if let job = selectedJob {
                    NavigationStack {
                        HUDJobDetailView(job: job, jobName: selectedJobName)
                    }
                    .presentationDetents([.medium, .large])
                }
            }
            .sheet(isPresented: $showingCommitJobs) {
                if let row = selectedCommitRow {
                    NavigationStack {
                        CommitJobsListView(
                            row: row,
                            jobNames: viewModel.filteredJobNames,
                            onJobTap: { job, name in
                                showingCommitJobs = false
                                Task { @MainActor in
                                    try? await Task.sleep(for: .milliseconds(300))
                                    selectedJob = job
                                    selectedJobName = name
                                    showingJobDetail = true
                                }
                            }
                        )
                    }
                    .presentationDetents([.medium, .large])
                }
            }
    }

    // MARK: - Banners

    private var failureWarningBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.white)

                VStack(alignment: .leading, spacing: 2) {
                    Text("\(viewModel.consecutiveFailures) consecutive failures")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)

                    Text("on \(viewModel.selectedBranch)")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.9))
                }

                Spacer()
            }

            // Show top failure patterns if available
            if !viewModel.failurePatterns.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Top failing jobs:")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.white.opacity(0.8))

                    ForEach(Array(viewModel.failurePatterns.prefix(3).enumerated()), id: \.offset) { _, pattern in
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 8))
                            Text(pattern)
                                .font(.caption2)
                                .lineLimit(1)
                        }
                        .foregroundStyle(.white.opacity(0.9))
                    }
                }
                .padding(.leading, 30)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(AppColors.failure.gradient)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Warning: \(viewModel.consecutiveFailures) consecutive failures on \(viewModel.selectedBranch)"))
    }

    private var quickStatsBar: some View {
        VStack(spacing: 8) {
            // Top row: commit count, job count, latest time
            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    Image(systemName: "tray.2")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("\(viewModel.filteredRows.count) commits")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }

                Divider()
                    .frame(height: 12)

                HStack(spacing: 6) {
                    Image(systemName: "square.grid.2x2")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("\(viewModel.filteredJobNames.count) jobs")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let latestCommit = viewModel.filteredRows.first {
                    HStack(spacing: 4) {
                        Image(systemName: "clock")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(latestCommit.relativeTime)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Health bar showing overall pass/fail/pending ratio
            let stats = viewModel.jobHealthStats
            if !stats.isEmpty {
                VStack(spacing: 4) {
                    // Proportional status bar using GeometryReader for correct widths
                    let nonBlockingFails = max(0, stats.failureCount - stats.blockingFailureCount)
                    let segments: [(Color, Int)] = [
                        (AppColors.success, stats.successCount),
                        (Color.green.opacity(0.5), stats.flakyCount),
                        (AppColors.failure, stats.blockingFailureCount),
                        (Color.red.opacity(0.5), nonBlockingFails),
                        (AppColors.unstable, stats.unstableCount),
                        (AppColors.pending, stats.pendingCount),
                    ].filter { $0.1 > 0 }
                    let segmentTotal = segments.reduce(0) { $0 + $1.1 }

                    GeometryReader { geometry in
                        let totalWidth = geometry.size.width
                        let spacing: CGFloat = CGFloat(max(0, segments.count - 1)) * 0.5
                        let available = totalWidth - spacing

                        HStack(spacing: 0.5) {
                            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(segment.0)
                                    .frame(width: max(2, available * CGFloat(segment.1) / CGFloat(segmentTotal)))
                            }
                        }
                    }
                    .frame(height: 6)
                    .clipShape(RoundedRectangle(cornerRadius: 3))

                    // Legend with failure breakdown badges
                    HStack(spacing: 4) {
                        if stats.blockingFailureCount > 0 {
                            healthBadge(count: stats.blockingFailureCount, color: AppColors.failure, label: "blocking")
                        }
                        if stats.newFailureCount > stats.blockingFailureCount {
                            healthBadge(count: stats.newFailureCount - stats.blockingFailureCount, color: Color.red.opacity(0.7), label: "failed")
                        }
                        if stats.repeatFailureCount > 0 {
                            healthBadge(count: stats.repeatFailureCount, color: Color(.systemGray2), label: "known")
                        }
                        if stats.unstableCount > 0 {
                            healthBadge(count: stats.unstableCount, color: AppColors.unstable, label: "unstable")
                        }
                        if stats.flakyCount > 0 {
                            healthBadge(count: stats.flakyCount, color: Color.green.opacity(0.7), label: "flaky")
                        }

                        Spacer()

                        healthLegendItem(
                            color: AppColors.success,
                            label: "\(stats.successCount + stats.flakyCount) passed"
                        )
                        Text(stats.successPercentage)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(AppColors.success)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.tertiarySystemBackground))
    }

    private func healthLegendItem(color: Color, label: String) -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func healthBadge(count: Int, color: Color, label: String) -> some View {
        HStack(spacing: 2) {
            Text("\(count)")
                .font(.system(size: 9, weight: .bold))
            Text(label)
                .font(.system(size: 8))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(color)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    // MARK: - Main Content

    @ViewBuilder
    private var mainContent: some View {
        switch viewModel.state {
        case .idle, .loading:
            if viewModel.hasData {
                hudContent
                    .overlay(alignment: .center) {
                        if viewModel.isLoading {
                            ProgressView()
                                .controlSize(.large)
                                .padding()
                                .background(.ultraThinMaterial)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
            } else {
                LoadingView(message: "Loading CI data...")
            }

        case .loaded:
            if viewModel.hasData {
                hudContent
            } else {
                EmptyStateView(
                    icon: "tray",
                    title: "No Data",
                    message: "No CI data found for \(viewModel.selectedRepo.name) on \(viewModel.selectedBranch).",
                    actionTitle: "Refresh"
                ) {
                    Task { await viewModel.refresh() }
                }
            }

        case .error(let message):
            if viewModel.hasData {
                hudContent
                    .overlay(alignment: .bottom) {
                        InlineErrorView(message: message) {
                            Task { await viewModel.refresh() }
                        }
                        .padding()
                    }
            } else {
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.refresh() } }
                )
            }
        }
    }

    // MARK: - HUD Content

    private var hudContent: some View {
        VStack(spacing: 0) {
            if viewModel.filteredRows.isEmpty && !viewModel.searchFilter.isEmpty {
                // Empty state when filtering
                VStack(spacing: 16) {
                    Spacer()

                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)

                    Text("No matching jobs")
                        .font(.title3.weight(.semibold))

                    Text("Try adjusting your filter to see more results.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button("Clear Filter") {
                        viewModel.clearFilter()
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 8)

                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HUDGridView(
                    rows: viewModel.filteredRows,
                    allJobs: viewModel.filteredRows.map(\.jobs),
                    jobNames: viewModel.filteredJobNames,
                    repoOwner: viewModel.selectedRepo.owner,
                    repoName: viewModel.selectedRepo.name,
                    isLoadingMore: viewModel.isLoadingMore,
                    hasMorePages: viewModel.hasMorePages,
                    loadMoreError: viewModel.loadMoreError,
                    onCommitRowTap: { row in
                        selectedCommitRow = row
                        showingCommitJobs = true
                    },
                    onLoadMore: {
                        viewModel.loadMoreIfNeeded()
                    },
                    onRetryLoadMore: {
                        viewModel.retryLoadMore()
                    },
                    onDismissLoadMoreError: {
                        viewModel.dismissLoadMoreError()
                    }
                )
            }
        }
    }
}

// MARK: - Navigation Models

struct CommitNavigation: Hashable {
    let sha: String
    let repoOwner: String
    let repoName: String
}

struct PRNavigation: Hashable {
    let prNumber: Int
    let repoOwner: String
    let repoName: String
}

// MARK: - HUD Job Detail View (sheet for HUDJob from the grid)

private struct HUDJobDetailView: View {
    let job: HUDJob
    let jobName: String

    @State private var showingSafari = false
    @State private var safariURL: URL?
    @State private var copiedLink = false

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerSection
                statusAndDurationSection

                if job.isFailure {
                    failureDetailsSection
                }

                previousRunSection
                runnerSection
                linksSection
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
        VStack(alignment: .leading, spacing: 8) {
            Text(jobName)
                .font(.title3.weight(.bold))
                .textSelection(.enabled)

            if let name = job.name {
                Text(name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Status and Duration

    private var statusAndDurationSection: some View {
        HStack(spacing: 16) {
            JobStatusBadge(
                conclusion: job.conclusion,
                isUnstable: job.isUnstable,
                showLabel: true
            )

            if let duration = job.durationFormatted {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.subheadline)
                    Text(duration)
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Failure Details

    @ViewBuilder
    private var failureDetailsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Failure Details")

            if let failureLines = job.failureLines, !failureLines.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Failure Lines")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(failureLines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(AppColors.failure)
                                .textSelection(.enabled)
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppColors.failure.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            if let failureCaptures = job.failureCaptures, !failureCaptures.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Failure Captures")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

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
                }
            }
        }
    }

    // MARK: - Previous Run

    @ViewBuilder
    private var previousRunSection: some View {
        if let failed = job.failedPreviousRun, failed {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Previous Run")

                HStack(spacing: 12) {
                    JobStatusBadge(
                        conclusion: "failure",
                        showLabel: true
                    )
                    Text("Previous run also failed")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Runner

    @ViewBuilder
    private var runnerSection: some View {
        if let runnerName = job.runnerName {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Runner")

                HStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(runnerName)
                        .font(.subheadline)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Links

    private var linksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Links")

            VStack(spacing: 8) {
                if let htmlUrl = job.htmlUrl, URL(string: htmlUrl) != nil {
                    Button {
                        safariURL = URL(string: htmlUrl)
                        showingSafari = true
                    } label: {
                        Label("View on GitHub", systemImage: "safari")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if let logUrl = job.logUrl, URL(string: logUrl) != nil {
                    Button {
                        safariURL = URL(string: logUrl)
                        showingSafari = true
                    } label: {
                        Label("View Logs", systemImage: "doc.text")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if let htmlUrl = job.htmlUrl {
                    Button {
                        UIPasteboard.general.string = htmlUrl
                        copiedLink = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            copiedLink = false
                        }
                    } label: {
                        Label(
                            copiedLink ? "Copied!" : "Copy Link",
                            systemImage: copiedLink ? "checkmark" : "doc.on.doc"
                        )
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }
}

// MARK: - Commit Jobs List View (shows all jobs for a commit row vertically)

private struct CommitJobsListView: View {
    let row: HUDRow
    let jobNames: [String]
    var onJobTap: ((HUDJob, String) -> Void)?

    @Environment(\.dismiss) private var dismiss

    private var jobPairs: [(name: String, job: HUDJob)] {
        row.jobs.enumerated().map { index, job in
            let name = index < jobNames.count ? jobNames[index] : (job.name ?? "Job \(index)")
            return (name: name, job: job)
        }
    }

    // Failure breakdown
    private var blockingFailures: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isFailure && $0.job.isViableStrictBlocking && !$0.job.isUnstable }
    }
    private var newFailures: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isNewFailure && !$0.job.isViableStrictBlocking && !$0.job.isUnstable }
    }
    private var repeatFailures: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isRepeatFailure && !$0.job.isViableStrictBlocking && !$0.job.isUnstable }
    }
    private var unstableFailures: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isFailure && $0.job.isUnstable }
    }
    private var pendingJobs: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isPending }
    }
    private var successJobs: [(name: String, job: HUDJob)] {
        jobPairs.filter { $0.job.isSuccess }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(row.commitTitle ?? "No title")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(3)

                    HStack(spacing: 10) {
                        HStack(spacing: 4) {
                            Image(systemName: "number")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(row.shortSha)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Color.accentColor)
                        }

                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(row.relativeTime)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        if let pr = row.prNumber {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.triangle.pull")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text("#\(pr)")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }

                    HStack(spacing: 8) {
                        let totalFailed = blockingFailures.count + newFailures.count + repeatFailures.count + unstableFailures.count
                        jobStatPill(count: totalFailed, label: "Failed", color: AppColors.failure)
                        jobStatPill(count: pendingJobs.count, label: "Pending", color: AppColors.pending)
                        jobStatPill(count: successJobs.count, label: "Passed", color: AppColors.success)
                    }
                }
                .padding(.vertical, 4)
            }

            if !blockingFailures.isEmpty {
                Section {
                    ForEach(Array(blockingFailures.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                } header: {
                    Label("Blocking Viable/Strict (\(blockingFailures.count))", systemImage: "exclamationmark.octagon.fill")
                        .foregroundStyle(AppColors.failure)
                        .font(.caption.weight(.semibold))
                }
            }

            if !newFailures.isEmpty {
                Section {
                    ForEach(Array(newFailures.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                } header: {
                    Label("New Failures (\(newFailures.count))", systemImage: "flame.fill")
                        .foregroundStyle(.orange)
                        .font(.caption.weight(.semibold))
                }
            }

            if !repeatFailures.isEmpty {
                Section {
                    ForEach(Array(repeatFailures.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                } header: {
                    Label("Known Failures (\(repeatFailures.count))", systemImage: "arrow.counterclockwise")
                        .foregroundStyle(.secondary)
                        .font(.caption.weight(.semibold))
                } footer: {
                    Text("Also failed on previous commit")
                        .font(.caption2)
                }
            }

            if !unstableFailures.isEmpty {
                Section {
                    ForEach(Array(unstableFailures.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                } header: {
                    Label("Flaky / Unstable (\(unstableFailures.count))", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppColors.unstable)
                        .font(.caption.weight(.semibold))
                }
            }

            if !pendingJobs.isEmpty {
                Section("Running (\(pendingJobs.count))") {
                    ForEach(Array(pendingJobs.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                }
            }

            if !successJobs.isEmpty {
                Section("Succeeded (\(successJobs.count))") {
                    ForEach(Array(successJobs.enumerated()), id: \.offset) { _, pair in
                        jobRow(name: pair.name, job: pair.job)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Commit Jobs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func jobRow(name: String, job: HUDJob) -> some View {
        Button {
            onJobTap?(job, name)
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(job.isUnstable ? AppColors.unstable : AppColors.forConclusion(job.conclusion))
                    .frame(width: 24, height: 24)
                    .overlay {
                        if job.isUnstable {
                            Image(systemName: "exclamationmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }

                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        Text(job.conclusion?.capitalized ?? "Pending")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(AppColors.forConclusion(job.conclusion))

                        if let duration = job.durationFormatted {
                            Text(duration)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Job Stat Pill
    private func jobStatPill(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Text("\(count)")
                .font(.caption.weight(.bold))
                .foregroundStyle(color)

            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

#Preview {
    @Previewable @State var path = NavigationPath()
    NavigationStack(path: $path) {
        HUDView(navigationPath: $path)
    }
}
