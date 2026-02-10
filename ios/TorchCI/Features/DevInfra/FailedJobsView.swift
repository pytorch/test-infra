import SwiftUI

struct FailedJobsView: View {
    @StateObject private var viewModel = FailedJobsViewModel()

    var body: some View {
        VStack(spacing: 0) {
            filterBar
                .padding(.horizontal)
                .padding(.top, 8)

            timeRangePicker
                .padding(.horizontal)
                .padding(.top, 8)

            failureTypeBar
                .padding(.horizontal)
                .padding(.top, 8)

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Failed Jobs")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.loadData() }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                RepoSelector(
                    repos: FailedJobsViewModel.repos,
                    selectedRepo: Binding(
                        get: { viewModel.selectedRepo },
                        set: { viewModel.selectRepo($0) }
                    )
                )

                BranchSelector(
                    branches: FailedJobsViewModel.branches,
                    selectedBranch: Binding(
                        get: { viewModel.selectedBranch },
                        set: { viewModel.selectBranch($0) }
                    )
                )

                Spacer()
            }

            SearchBar(
                text: $viewModel.searchFilter,
                placeholder: "Filter jobs by name..."
            )
        }
    }

    // MARK: - Time Range Picker

    private var timeRangePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach([1, 3, 7, 14, 30], id: \.self) { days in
                    Button {
                        viewModel.updateTimeRange(days: days)
                    } label: {
                        Text("\(days)d")
                            .font(.caption)
                            .fontWeight(viewModel.timeRangeDays == days ? .semibold : .regular)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                viewModel.timeRangeDays == days
                                    ? Color.accentColor
                                    : Color(.systemGray5)
                            )
                            .foregroundStyle(
                                viewModel.timeRangeDays == days ? .white : .primary
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 1)
        }
    }

    // MARK: - Failure Type Filter

    private var failureTypeBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(FailedJobsViewModel.FailureType.allCases, id: \.self) { type in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.filterType = type
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: type.icon)
                                .font(.caption2)
                            Text(type.description)
                                .font(.caption)
                                .fontWeight(viewModel.filterType == type ? .semibold : .regular)
                            if let count = viewModel.failureCounts[type] {
                                Text("\(count)")
                                    .font(.caption2.monospacedDigit())
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(
                                        viewModel.filterType == type
                                            ? Color.white.opacity(0.3)
                                            : Color(.systemGray4)
                                    )
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            viewModel.filterType == type
                                ? type.color
                                : Color(.systemGray5)
                        )
                        .foregroundStyle(
                            viewModel.filterType == type ? .white : .primary
                        )
                        .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 1)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            EmptyStateView(
                icon: "tag",
                title: "Failed Jobs",
                message: "Loading failed jobs from the HUD..."
            )

        case .loading:
            LoadingView(message: "Fetching failed jobs...")

        case .loaded:
            if viewModel.jobs.isEmpty {
                EmptyStateView(
                    icon: "checkmark.circle",
                    title: "No Failed Jobs",
                    message: "No failures found in the selected time range for \(viewModel.selectedRepo.name)/\(viewModel.selectedBranch)."
                )
            } else if viewModel.groupedFailures.isEmpty {
                EmptyStateView(
                    icon: "magnifyingglass",
                    title: "No Matching Failures",
                    message: "No failures match the current filters. Try adjusting your search or classification filter."
                )
            } else {
                jobsList
            }

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Jobs List

    private var jobsList: some View {
        List {
            if let syncError = viewModel.annotationSyncError {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(syncError)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Dismiss") {
                            viewModel.annotationSyncError = nil
                        }
                        .font(.caption.weight(.medium))
                    }
                    .listRowBackground(Color.orange.opacity(0.1))
                }
            }

            Section {
                summaryCards
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
            }

            // Group by failure type
            ForEach(sortedFailureTypes, id: \.self) { failureType in
                if let groups = viewModel.groupedFailures[failureType], !groups.isEmpty {
                    Section {
                        ForEach(groups) { group in
                            FailureGroupRow(
                                group: group,
                                annotation: group.representativeJob.jobId.flatMap { viewModel.annotations[$0] },
                                isAuthenticated: viewModel.isAuthenticated,
                                isPending: group.jobs.contains(where: { job in
                                    job.jobId.map { viewModel.pendingAnnotationJobIds.contains($0) } ?? false
                                }),
                                onAnnotate: { value in
                                    // Annotate all jobs in the group with a single backend call
                                    let jobIds = group.jobs.compactMap(\.jobId)
                                    viewModel.annotateMultiple(jobIds: jobIds, value: value)
                                }
                            )
                        }
                    } header: {
                        HStack {
                            Image(systemName: failureType.icon)
                            Text(failureType.description)
                            Spacer()
                            Text("\(groups.reduce(0) { $0 + $1.count })")
                                .font(.caption.monospacedDigit())
                        }
                        .foregroundStyle(failureType.color)
                    }
                }
            }

            Section {
                PaginationView(
                    currentPage: $viewModel.currentPage,
                    totalPages: nil,
                    onPageChange: { _ in Task { await viewModel.loadData() } }
                )
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await viewModel.refresh() }
    }

    // MARK: - Summary Cards

    private var summaryCards: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                MetricCard(
                    title: "Total Failures",
                    value: "\(viewModel.failureCounts[.all] ?? 0)",
                    valueColor: AppColors.failure
                )
                MetricCard(
                    title: "Unique Issues",
                    value: "\(uniqueIssuesCount)"
                )
            }

            // Breakdown mini-bar showing distribution of failure types
            if let total = viewModel.failureCounts[.all], total > 0 {
                failureDistributionBar(total: total)
            }
        }
    }

    private func failureDistributionBar(total: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Stacked horizontal bar
            GeometryReader { geometry in
                HStack(spacing: 1) {
                    ForEach(
                        [FailedJobsViewModel.FailureType.brokenTrunk,
                         .flaky, .infra, .notAnnotated],
                        id: \.self
                    ) { type in
                        let count = viewModel.failureCounts[type] ?? 0
                        if count > 0 {
                            let fraction = CGFloat(count) / CGFloat(total)
                            RoundedRectangle(cornerRadius: 2)
                                .fill(type.color)
                                .frame(width: max(4, fraction * geometry.size.width))
                        }
                    }
                }
            }
            .frame(height: 6)
            .clipShape(Capsule())

            // Legend
            HStack(spacing: 12) {
                ForEach(
                    [FailedJobsViewModel.FailureType.brokenTrunk,
                     .flaky, .infra, .notAnnotated],
                    id: \.self
                ) { type in
                    if let count = viewModel.failureCounts[type], count > 0 {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(type.color)
                                .frame(width: 6, height: 6)
                            Text("\(count)")
                                .font(.caption2.monospacedDigit().weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var sortedFailureTypes: [FailedJobsViewModel.FailureType] {
        if viewModel.filterType != .all {
            return [viewModel.filterType]
        }
        // Show in order: Broken Trunk, Flaky, Infra, Not Annotated
        return FailedJobsViewModel.FailureType.allCases.filter { $0 != .all }
    }

    private var uniqueIssuesCount: Int {
        viewModel.groupedFailures.values.reduce(0) { $0 + $1.count }
    }
}

// MARK: - Shared Helpers

/// Extracts a short commit SHA from a GitHub URL containing "/commit/".
private func extractSha(from url: String?) -> String? {
    guard let url = url else { return nil }
    let components = url.split(separator: "/")
    if let commitIndex = components.firstIndex(of: "commit"),
       commitIndex + 1 < components.count {
        return String(String(components[commitIndex + 1]).prefix(7))
    }
    return nil
}

/// Formats an ISO 8601 timestamp as a relative time string (e.g. "2h ago").
private func relativeTimeString(from isoString: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: isoString) else {
        return isoString
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: date, relativeTo: Date())
}

// MARK: - Failure Group Row (expandable)

private struct FailureGroupRow: View {
    let group: FailedJobsViewModel.FailureGroup
    let annotation: FailedJobsViewModel.AnnotationValue?
    let isAuthenticated: Bool
    let isPending: Bool
    let onAnnotate: (FailedJobsViewModel.AnnotationValue) -> Void

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Main job row (always visible)
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                mainRowContent
            }
            .buttonStyle(.plain)

            // Annotation controls
            if isAuthenticated {
                annotationBar
                    .padding(.top, 8)
            }

            // Expanded similar jobs list
            if isExpanded && group.count > 1 {
                expandedJobsList
            }
        }
        .contextMenu {
            let jobName = group.representativeJob.jobName ?? group.representativeJob.name ?? "Unknown"
            Button {
                UIPasteboard.general.string = jobName
            } label: {
                Label("Copy Job Name", systemImage: "doc.on.doc")
            }
            if let captures = group.representativeJob.failureCaptures, !captures.isEmpty {
                Button {
                    UIPasteboard.general.string = captures.joined(separator: "\n")
                } label: {
                    Label("Copy Failure", systemImage: "doc.on.clipboard")
                }
            }
            if let url = group.representativeJob.htmlUrl, let htmlUrl = URL(string: url) {
                Link(destination: htmlUrl) {
                    Label("Open on GitHub", systemImage: "arrow.up.right.square")
                }
            }
        }
    }

    // MARK: - Main Row

    private var mainRowContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Top: chevron + status icon + job name + occurrence count
            HStack(alignment: .top, spacing: 8) {
                VStack {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                }
                .padding(.top, 3)

                JobStatusIcon(conclusion: group.representativeJob.conclusion)

                VStack(alignment: .leading, spacing: 3) {
                    Text(group.representativeJob.jobName ?? group.representativeJob.name ?? "Unknown Job")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(3)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let workflow = group.representativeJob.workflowName {
                        Text(workflow)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 4)

                if group.count > 1 {
                    Text("\(group.count)\u{00D7}")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(group.failureType.color)
                        .clipShape(Capsule())
                }
            }

            // Middle: metadata badges row (wraps naturally)
            metadataBadges

            // Bottom: failure preview snippet
            if let preview = failurePreviewText(for: group.representativeJob) {
                Text(preview)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: - Metadata Badges

    private var metadataBadges: some View {
        HStack(spacing: 6) {
            failureTypeBadge

            if let sha = extractSha(from: group.representativeJob.htmlUrl) {
                Text(sha)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            if let duration = group.representativeJob.durationFormatted {
                HStack(spacing: 2) {
                    Image(systemName: "clock")
                        .font(.system(size: 9))
                    Text(duration)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            if let time = group.representativeJob.time {
                Text(relativeTimeString(from: time))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if let url = group.representativeJob.htmlUrl, let htmlUrl = URL(string: url) {
                Link(destination: htmlUrl) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
    }

    private var failureTypeBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: group.failureType.icon)
                .font(.caption2)
            Text(group.failureType.description)
                .font(.caption2.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(group.failureType.color.opacity(0.15))
        .foregroundStyle(group.failureType.color)
        .clipShape(Capsule())
    }

    // MARK: - Annotation Bar

    private var annotationBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text("Classify:")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                ForEach(FailedJobsViewModel.AnnotationValue.allCases, id: \.self) { value in
                    if value != .none {
                        Button {
                            onAnnotate(value)
                        } label: {
                            Text(value.displayName)
                                .font(.caption2)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(
                                    annotation == value
                                        ? Color.accentColor
                                        : Color(.systemGray5)
                                )
                                .foregroundStyle(
                                    annotation == value ? .white : .primary
                                )
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(isPending)
                    }
                }

                if isPending {
                    ProgressView()
                        .scaleEffect(0.7)
                }

                if annotation != nil && !isPending {
                    Button {
                        onAnnotate(.none)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - Expanded Jobs List

    private var expandedJobsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
                .padding(.vertical, 8)

            VStack(alignment: .leading, spacing: 6) {
                Text("Similar Failures (\(group.count))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)

                ForEach(group.jobs) { job in
                    CompactJobRow(job: job)
                }
            }
            .padding(.leading, 12)
        }
    }

    private func failurePreviewText(for job: JobData) -> String? {
        if let lines = job.failureLines, !lines.isEmpty {
            return lines.prefix(2).joined(separator: "\n")
        }
        if let captures = job.failureCaptures, !captures.isEmpty {
            return captures.prefix(2).joined(separator: "\n")
        }
        return nil
    }
}

// MARK: - Compact Job Row (for expanded similar jobs)

private struct CompactJobRow: View {
    let job: JobData

    var body: some View {
        HStack(spacing: 8) {
            JobStatusIcon(conclusion: job.conclusion)
                .font(.caption2)

            VStack(alignment: .leading, spacing: 2) {
                if let time = job.time {
                    Text(relativeTimeString(from: time))
                        .font(.caption2.weight(.medium))
                }

                HStack(spacing: 6) {
                    if let sha = extractSha(from: job.htmlUrl) {
                        Text(sha)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }

                    if let duration = job.durationFormatted {
                        HStack(spacing: 2) {
                            Image(systemName: "clock")
                                .font(.system(size: 8))
                            Text(duration)
                        }
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            if let url = job.htmlUrl, let htmlUrl = URL(string: url) {
                Link(destination: htmlUrl) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.caption)
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(Color(.systemGray6).opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

#Preview {
    NavigationStack {
        FailedJobsView()
    }
}
