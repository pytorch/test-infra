import SwiftUI

struct PRDetailView: View {
    @StateObject private var viewModel: PRDetailViewModel
    @State private var showingSafari = false
    @State private var safariURL: URL?
    @State private var selectedJob: JobData?
    @State private var copiedSHA = false

    init(prNumber: Int, repoOwner: String = "pytorch", repoName: String = "pytorch") {
        _viewModel = StateObject(wrappedValue: PRDetailViewModel(
            prNumber: prNumber,
            repoOwner: repoOwner,
            repoName: repoName
        ))
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading PR #\(viewModel.prNumber)...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadPR() }
                }

            case .loaded:
                prContent
            }
        }
        .navigationTitle("PR #\(viewModel.prNumber)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    if let url = URL(string: viewModel.prURL) {
                        safariURL = url
                        showingSafari = true
                    }
                } label: {
                    Image(systemName: "safari")
                        .font(.subheadline)
                }
                .accessibilityLabel("Open in Safari")

                Menu {
                    Button {
                        if let url = URL(string: viewModel.prURL) {
                            safariURL = url
                            showingSafari = true
                        }
                    } label: {
                        Label("Open on GitHub", systemImage: "arrow.up.right.square")
                    }

                    Button {
                        if let url = URL(string: viewModel.hudURL) {
                            safariURL = url
                            showingSafari = true
                        }
                    } label: {
                        Label("Open on HUD", systemImage: "chart.bar.xaxis")
                    }

                    Divider()

                    Button {
                        UIPasteboard.general.string = viewModel.prURL
                    } label: {
                        Label("Copy PR Link", systemImage: "doc.on.doc")
                    }

                    if let shareURL = URL(string: viewModel.prURL) {
                        ShareLink(item: shareURL) {
                            Label("Share PR", systemImage: "square.and.arrow.up")
                        }
                    }

                    if let sha = viewModel.selectedSha {
                        Divider()
                        Button {
                            UIPasteboard.general.string = sha
                            withAnimation { copiedSHA = true }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                withAnimation { copiedSHA = false }
                            }
                        } label: {
                            Label("Copy SHA", systemImage: "doc.on.doc")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.subheadline)
                }
                .accessibilityLabel("More actions")
            }
        }
        .task { await viewModel.loadPR() }
        .sheet(isPresented: $showingSafari) {
            if let url = safariURL {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
        .sheet(item: $selectedJob) { job in
            NavigationStack {
                JobDetailView(job: job)
            }
        }
        .overlay(alignment: .bottom) {
            if copiedSHA {
                Text("SHA copied to clipboard")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color(.systemGray2))
                    .clipShape(Capsule())
                    .shadow(radius: 4)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .padding(.bottom, 20)
            }
        }
    }

    // MARK: - Main Content

    @ViewBuilder
    private var prContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                prHeaderSection
                commitSelectorSection
                summaryStatsSection
                jobFilterBar
                jobsSection
                bodySection
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - PR Header

    @ViewBuilder
    private var prHeaderSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Title
            if let title = viewModel.prResponse?.title {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Metadata chips row -- always show PR number; state/branch only when API provides them
            FlowLayout(spacing: 8) {
                // State Badge (only shown when the API returns state)
                if let state = viewModel.prResponse?.state {
                    HStack(spacing: 5) {
                        Image(systemName: viewModel.prStateIcon)
                            .font(.caption2)
                        Text(state.capitalized)
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(AppColors.forConclusion(viewModel.prStateColor))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(AppColors.forConclusion(viewModel.prStateColor).opacity(0.12))
                    .clipShape(Capsule())
                }

                // PR Number (always available)
                HStack(spacing: 4) {
                    Image(systemName: "number")
                        .font(.caption2)
                    Text("\(viewModel.prNumber)")
                        .font(.system(.caption, design: .monospaced).weight(.medium))
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color(.systemGray6))
                .clipShape(Capsule())

                // Commit count chip (always useful context)
                if !viewModel.commits.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.caption2)
                        Text("\(viewModel.commits.count) commit\(viewModel.commits.count == 1 ? "" : "s")")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.systemGray6))
                    .clipShape(Capsule())
                }

                // Branch info (only shown when the API returns head/base refs)
                if let branchInfo = viewModel.prResponse?.branchInfo {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.caption2)
                        Text(branchInfo)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.systemGray6))
                    .clipShape(Capsule())
                }
            }

            // Author and timestamps row -- only shown when the API returns this data
            if viewModel.prResponse?.author != nil || viewModel.createdTimeAgo != nil || viewModel.updatedTimeAgo != nil {
                HStack(spacing: 12) {
                    // Author
                    if let author = viewModel.prResponse?.author {
                        HStack(spacing: 6) {
                            AsyncImage(url: authorAvatarURL(for: author)) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                case .failure:
                                    Image(systemName: "person.circle.fill")
                                        .resizable()
                                        .foregroundStyle(.secondary)
                                case .empty:
                                    Circle()
                                        .fill(Color(.systemGray4))
                                        .overlay {
                                            Image(systemName: "person.fill")
                                                .foregroundStyle(.secondary)
                                                .font(.system(size: 10))
                                        }
                                @unknown default:
                                    Circle()
                                        .fill(Color(.systemGray4))
                                }
                            }
                            .frame(width: 22, height: 22)
                            .clipShape(Circle())

                            Text(author.login ?? "Unknown")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.primary)
                        }
                    }

                    Spacer()

                    // Timestamps
                    if let created = viewModel.createdTimeAgo {
                        HStack(spacing: 3) {
                            Image(systemName: "clock")
                                .font(.caption2)
                            Text(created)
                                .font(.caption)
                        }
                        .foregroundStyle(.tertiary)
                    }

                    if let updated = viewModel.updatedTimeAgo {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.clockwise")
                                .font(.caption2)
                            Text(updated)
                                .font(.caption)
                        }
                        .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Commit Selector

    @ViewBuilder
    private var commitSelectorSection: some View {
        if !viewModel.commits.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SectionHeader(
                        title: "Commits",
                        subtitle: "\(viewModel.commits.count) commit\(viewModel.commits.count == 1 ? "" : "s")"
                    )
                    Spacer()
                    if viewModel.commits.count > 1 {
                        Text("Tap to select")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(Array(viewModel.commits.enumerated().reversed()), id: \.element.id) { index, commit in
                            commitChip(commit, position: viewModel.commits.count - index)
                        }
                    }
                    .padding(.horizontal, 1)
                    .padding(.vertical, 1)
                }
            }
        }
    }

    @ViewBuilder
    private func commitChip(_ commit: PRCommit, position: Int) -> some View {
        let isSelected = viewModel.selectedSha == commit.sha

        Button {
            Task {
                await viewModel.selectSha(commit.sha)
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                // Position badge and SHA
                HStack(spacing: 6) {
                    Text("\(position)")
                        .font(.caption2.bold())
                        .foregroundStyle(isSelected ? .white.opacity(0.7) : .secondary)
                        .frame(width: 20, height: 20)
                        .background(
                            Circle()
                                .fill(isSelected ? Color.white.opacity(0.2) : Color(.systemGray5))
                        )

                    Text(commit.shortSha)
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(isSelected ? .white : .primary)
                }

                // Commit title
                if let title = commit.title {
                    Text(title)
                        .font(.caption2)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(isSelected ? .white.opacity(0.85) : .secondary)
                        .frame(maxWidth: 180, alignment: .leading)
                }

                // Job status indicator (shown after commit jobs have been loaded)
                if let summary = viewModel.commitJobSummaries[commit.sha] {
                    HStack(spacing: 4) {
                        if summary.failed > 0 {
                            HStack(spacing: 2) {
                                Circle().fill(AppColors.failure).frame(width: 6, height: 6)
                                Text("\(summary.failed)")
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                            }
                        }
                        if summary.passed > 0 {
                            HStack(spacing: 2) {
                                Circle().fill(AppColors.success).frame(width: 6, height: 6)
                                Text("\(summary.passed)")
                                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                            }
                        }
                        if summary.pending > 0 {
                            HStack(spacing: 2) {
                                Circle().fill(AppColors.pending).frame(width: 6, height: 6)
                                Text("\(summary.pending)")
                                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                            }
                        }
                    }
                    .foregroundStyle(isSelected ? .white.opacity(0.8) : .secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minWidth: 140, maxWidth: 220)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(isSelected ? Color.accentColor : Color(.tertiarySystemBackground))
            )
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Color.accentColor.opacity(0.3), lineWidth: 3)
                }
            }
            .shadow(
                color: isSelected ? Color.accentColor.opacity(0.3) : Color.clear,
                radius: 8,
                y: 2
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Summary Stats

    @ViewBuilder
    private var summaryStatsSection: some View {
        if viewModel.selectedSha != nil {
            VStack(spacing: 12) {
                // Visual progress bar
                VStack(spacing: 8) {
                    HStack(spacing: 4) {
                        if viewModel.totalJobs > 0 {
                            let passedWidth = CGFloat(viewModel.passedJobs) / CGFloat(viewModel.totalJobs)
                            let failedWidth = CGFloat(viewModel.failedJobs) / CGFloat(viewModel.totalJobs)
                            let pendingWidth = CGFloat(viewModel.pendingJobs) / CGFloat(viewModel.totalJobs)

                            if viewModel.passedJobs > 0 {
                                Rectangle()
                                    .fill(AppColors.success)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 8)
                                    .layoutPriority(passedWidth)
                            }
                            if viewModel.failedJobs > 0 {
                                Rectangle()
                                    .fill(AppColors.failure)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 8)
                                    .layoutPriority(failedWidth)
                            }
                            if viewModel.pendingJobs > 0 {
                                Rectangle()
                                    .fill(AppColors.pending)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 8)
                                    .layoutPriority(pendingWidth)
                            }
                        } else {
                            Rectangle()
                                .fill(Color(.systemGray5))
                                .frame(height: 8)
                        }
                    }
                    .clipShape(Capsule())

                    // Stats grid
                    HStack(spacing: 8) {
                        PRStatCell(label: "Total", value: viewModel.totalJobs, color: .primary, compact: true)
                        PRStatCell(label: "Passed", value: viewModel.passedJobs, color: AppColors.success, compact: true)
                        PRStatCell(label: "Failed", value: viewModel.failedJobs, color: AppColors.failure, compact: true)
                        PRStatCell(label: "Pending", value: viewModel.pendingJobs, color: AppColors.pending, compact: true)
                    }
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                // Status message and quick action
                if viewModel.totalJobs > 0 {
                    let successRate = Int((Double(viewModel.passedJobs) / Double(viewModel.totalJobs)) * 100)
                    HStack(spacing: 8) {
                        Image(systemName: statusIcon)
                            .font(.caption)
                            .foregroundStyle(statusColor)

                        Text(statusMessage(successRate: successRate))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(statusTextColor)

                        Spacer()

                        // Quick jump to failures
                        if viewModel.failedJobs > 0 && viewModel.jobFilter != .failures {
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    viewModel.showFailuresOnly()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "line.3.horizontal.decrease")
                                        .font(.caption2)
                                    Text("Show Failures")
                                        .font(.caption2.weight(.medium))
                                }
                                .foregroundStyle(AppColors.failure)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(AppColors.failure.opacity(0.1))
                                .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var statusIcon: String {
        if viewModel.failedJobs == 0 && viewModel.pendingJobs == 0 {
            return "checkmark.circle.fill"
        } else if viewModel.failedJobs > viewModel.passedJobs {
            return "xmark.circle.fill"
        } else {
            return "exclamationmark.circle.fill"
        }
    }

    private var statusColor: Color {
        if viewModel.failedJobs == 0 && viewModel.pendingJobs == 0 {
            return AppColors.success
        } else if viewModel.failedJobs > viewModel.passedJobs {
            return AppColors.failure
        } else {
            return AppColors.unstable
        }
    }

    private var statusTextColor: Color {
        if viewModel.failedJobs == 0 && viewModel.pendingJobs == 0 {
            return AppColors.success
        } else if viewModel.pendingJobs > 0 && viewModel.failedJobs == 0 {
            return .secondary
        } else {
            return AppColors.failure
        }
    }

    private func statusMessage(successRate: Int) -> String {
        if viewModel.failedJobs == 0 && viewModel.pendingJobs == 0 {
            return "All checks passed!"
        } else if viewModel.pendingJobs > 0 && viewModel.failedJobs == 0 {
            return "\(successRate)% complete - \(viewModel.pendingJobs) job\(viewModel.pendingJobs == 1 ? "" : "s") in progress"
        } else {
            return "\(successRate)% passed - \(viewModel.failedJobs) failure\(viewModel.failedJobs == 1 ? "" : "s")"
        }
    }

    // MARK: - Job Filter Bar

    @ViewBuilder
    private var jobFilterBar: some View {
        if !viewModel.groupedJobs.isEmpty {
            VStack(spacing: 10) {
                // Search bar
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    TextField("Search jobs...", text: $viewModel.jobSearchQuery)
                        .font(.subheadline)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    if !viewModel.jobSearchQuery.isEmpty {
                        Button {
                            viewModel.clearJobSearch()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))

                // Filter chips
                HStack(spacing: 8) {
                    ForEach(PRDetailViewModel.JobFilter.allCases, id: \.rawValue) { filter in
                        let isActive = viewModel.jobFilter == filter
                        let count: Int = {
                            switch filter {
                            case .all: return viewModel.totalJobs
                            case .failures: return viewModel.failedJobs
                            case .pending: return viewModel.pendingJobs
                            }
                        }()

                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) {
                                viewModel.setJobFilter(isActive ? .all : filter)
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(filter.rawValue)
                                    .font(.caption.weight(.medium))
                                if filter != .all {
                                    Text("\(count)")
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(
                                            isActive
                                                ? Color.white.opacity(0.25)
                                                : Color(.systemGray5)
                                        )
                                        .clipShape(Capsule())
                                }
                            }
                            .foregroundStyle(isActive ? .white : .primary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                isActive
                                    ? filterColor(for: filter)
                                    : Color(.tertiarySystemBackground)
                            )
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    Spacer()

                    // Filtered count indicator
                    if viewModel.isFiltering {
                        Text("\(viewModel.filteredJobCount.formatted()) of \(viewModel.totalJobs.formatted())")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func filterColor(for filter: PRDetailViewModel.JobFilter) -> Color {
        switch filter {
        case .all: return Color.accentColor
        case .failures: return AppColors.failure
        case .pending: return AppColors.pending
        }
    }

    // MARK: - Jobs Section

    @ViewBuilder
    private var jobsSection: some View {
        if viewModel.selectedSha == nil {
            EmptyStateView(
                icon: "square.stack.3d.up",
                title: "Select a Commit",
                message: "Choose a commit above to see its CI jobs."
            )
        } else if viewModel.isLoadingJobs {
            VStack(spacing: 12) {
                ProgressView()
                    .controlSize(.large)
                Text("Loading jobs...")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else if let jobError = viewModel.jobLoadError {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 32))
                    .foregroundStyle(.orange)
                Text("Failed to load jobs")
                    .font(.headline)
                Text(jobError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Retry") {
                    if let sha = viewModel.selectedSha {
                        Task { await viewModel.selectSha(sha) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else if viewModel.groupedJobs.isEmpty {
            VStack(spacing: 12) {
                EmptyStateView(
                    icon: "hammer",
                    title: "No Jobs",
                    message: "No CI jobs were found for this commit."
                )
                if let sha = viewModel.selectedSha {
                    Text("SHA: \(String(sha.prefix(7)))")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        } else if viewModel.filteredGroupedJobs.isEmpty {
            VStack(spacing: 12) {
                EmptyStateView(
                    icon: "line.3.horizontal.decrease.circle",
                    title: "No Matching Jobs",
                    message: "No jobs match the current filter."
                )
                Button {
                    withAnimation {
                        viewModel.setJobFilter(.all)
                        viewModel.clearJobSearch()
                    }
                } label: {
                    Text("Clear Filters")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.blue)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionHeader(
                        title: "CI Jobs",
                        subtitle: viewModel.isFiltering
                            ? "\(viewModel.filteredJobCount.formatted()) of \(viewModel.totalJobs.formatted()) jobs"
                            : "\(viewModel.totalJobs.formatted()) jobs in \(viewModel.filteredGroupedJobs.count) workflow\(viewModel.filteredGroupedJobs.count == 1 ? "" : "s")"
                    )
                    Spacer()
                    if viewModel.filteredGroupedJobs.contains(where: { !viewModel.expandedWorkflows.contains($0.workflowName) }) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.expandAllWorkflows()
                            }
                        } label: {
                            Text("Expand All")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.blue)
                        }
                    } else if !viewModel.filteredGroupedJobs.isEmpty {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.collapseAllWorkflows()
                            }
                        } label: {
                            Text("Collapse All")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.blue)
                        }
                    }
                }

                VStack(spacing: 8) {
                    ForEach(viewModel.filteredGroupedJobs, id: \.workflowName) { group in
                        prWorkflowSection(group)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func prWorkflowSection(_ group: (workflowName: String, jobs: [JobData])) -> some View {
        let isExpanded = viewModel.expandedWorkflows.contains(group.workflowName)
        let failureCount = group.jobs.filter { $0.isFailure }.count
        let successCount = group.jobs.filter { $0.isSuccess }.count
        let pendingCount = group.jobs.filter {
            let c = $0.conclusion?.lowercased()
            return c == nil || c == "pending" || c == "queued" || c == "in_progress"
        }.count

        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    viewModel.toggleWorkflow(group.workflowName)
                }
            } label: {
                HStack(spacing: 10) {
                    // Status indicator
                    Circle()
                        .fill(failureCount > 0 ? AppColors.failure : successCount == group.jobs.count ? AppColors.success : AppColors.pending)
                        .frame(width: 10, height: 10)

                    // Expand icon
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.workflowName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        HStack(spacing: 6) {
                            if successCount > 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.caption2)
                                        .foregroundStyle(AppColors.success)
                                    Text("\(successCount)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if failureCount > 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.caption2)
                                        .foregroundStyle(AppColors.failure)
                                    Text("\(failureCount)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if pendingCount > 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "clock.fill")
                                        .font(.caption2)
                                        .foregroundStyle(AppColors.pending)
                                    Text("\(pendingCount)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    Spacer()

                    Text("\(group.jobs.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.systemGray6))
                        .clipShape(Capsule())
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(failureCount > 0 ? AppColors.failure.opacity(0.05) : Color(.tertiarySystemBackground))
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(group.jobs, id: \.id) { job in
                        prJobRow(job)
                        if job.id != group.jobs.last?.id {
                            Divider()
                                .padding(.leading, 44)
                        }
                    }
                }
                .background(Color(.secondarySystemBackground))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(.separator).opacity(0.5), lineWidth: 0.5)
        }
    }

    @ViewBuilder
    private func prJobRow(_ job: JobData) -> some View {
        Button {
            selectedJob = job
        } label: {
            HStack(spacing: 12) {
                JobStatusIcon(conclusion: job.conclusion)

                VStack(alignment: .leading, spacing: 4) {
                    Text(job.jobName ?? job.name ?? "Unknown Job")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 8) {
                        if let duration = job.durationFormatted {
                            HStack(spacing: 3) {
                                Image(systemName: "clock")
                                    .font(.caption2)
                                Text(duration)
                                    .font(.caption)
                            }
                            .foregroundStyle(.secondary)
                        }

                        if job.unstable == true {
                            Text("Unstable")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(AppColors.unstable)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(AppColors.unstable.opacity(0.15))
                                .clipShape(Capsule())
                        }

                        if let runnerName = job.runnerName {
                            HStack(spacing: 3) {
                                Image(systemName: "server.rack")
                                    .font(.caption2)
                                Text(runnerName)
                                    .font(.caption2)
                            }
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        }
                    }

                    if job.isFailure, let failureLines = job.failureLines, !failureLines.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(failureLines.prefix(2), id: \.self) { line in
                                Text(line)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(AppColors.failure)
                                    .lineLimit(1)
                            }
                            if failureLines.count > 2 {
                                Text("+\(failureLines.count - 2) more error\(failureLines.count - 2 == 1 ? "" : "s")")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.top, 2)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Body Section

    @ViewBuilder
    private var bodySection: some View {
        if let body = viewModel.prResponse?.body, !body.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        viewModel.toggleBodyExpanded()
                    }
                } label: {
                    HStack {
                        SectionHeader(title: "Description")
                        Spacer()
                        Image(systemName: viewModel.isBodyExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)

                if viewModel.isBodyExpanded {
                    ScrollView(.vertical) {
                        Text(body)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 300)
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                }
            }
        }
    }

    // MARK: - Helpers

    private func authorAvatarURL(for author: AuthorInfo) -> URL? {
        guard let urlString = author.avatarUrl else { return nil }
        return URL(string: urlString)
    }
}

// MARK: - PR Stat Cell

private struct PRStatCell: View {
    let label: String
    let value: Int
    let color: Color
    var compact: Bool = false

    var body: some View {
        if compact {
            VStack(spacing: 3) {
                Text(value.formatted())
                    .font(.title3.bold())
                    .foregroundStyle(color)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
        } else {
            VStack(spacing: 4) {
                Text(value.formatted())
                    .font(.title2.bold())
                    .foregroundStyle(color)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

#Preview {
    NavigationStack {
        PRDetailView(prNumber: 12345)
    }
}
