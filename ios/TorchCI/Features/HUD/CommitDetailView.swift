import SwiftUI
import UIKit

struct CommitDetailView: View {
    @StateObject private var viewModel: CommitDetailViewModel
    @State private var showingSafari = false
    @State private var safariURL: URL?
    @State private var selectedJob: JobData?
    @State private var copiedSHA = false

    init(sha: String, repoOwner: String = "pytorch", repoName: String = "pytorch") {
        _viewModel = StateObject(wrappedValue: CommitDetailViewModel(
            sha: sha,
            repoOwner: repoOwner,
            repoName: repoName
        ))
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading commit...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadCommit() }
                }

            case .loaded:
                commitContent
            }
        }
        .navigationTitle("Commit")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.loadCommit() }
        .onAppear { viewModel.startAutoRefresh() }
        .onDisappear { viewModel.stopAutoRefresh() }
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
        .navigationDestination(for: PRNavigation.self) { nav in
            PRDetailView(
                prNumber: nav.prNumber,
                repoOwner: nav.repoOwner,
                repoName: nav.repoName
            )
        }
    }

    // MARK: - Main Content

    @ViewBuilder
    private var commitContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                commitHeaderSection

                if viewModel.isAutorevert {
                    autorevertBanner
                }

                summaryStatsSection

                progressBarSection

                linksSection

                jobsSection
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Commit Header

    @ViewBuilder
    private var commitHeaderSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Title with better typography
            if let title = viewModel.commitResponse?.commit.title {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            // Author Row with improved layout
            if let authorName = viewModel.commitResponse?.commit.author {
                HStack(spacing: 12) {
                    AsyncImage(url: commitAvatarURL) { phase in
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
                                        .font(.system(size: 16))
                                }
                        @unknown default:
                            Circle()
                                .fill(Color(.systemGray4))
                        }
                    }
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())

                    VStack(alignment: .leading, spacing: 3) {
                        if let authorUrl = viewModel.commitResponse?.commit.authorUrl,
                           let url = URL(string: authorUrl) {
                            Button {
                                safariURL = url
                                showingSafari = true
                            } label: {
                                HStack(spacing: 4) {
                                    Text(authorName)
                                        .font(.subheadline.weight(.semibold))
                                    Image(systemName: "arrow.up.right")
                                        .font(.system(size: 9))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        } else {
                            Text(authorName)
                                .font(.subheadline.weight(.semibold))
                        }
                        if let date = viewModel.commitResponse?.commit.date {
                            Text("committed \(date, style: .relative)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    // PR badge if available
                    if let prNumber = viewModel.commitResponse?.commit.prNumber {
                        NavigationLink(value: PRNavigation(
                            prNumber: prNumber,
                            repoOwner: viewModel.repoOwner,
                            repoName: viewModel.repoName
                        )) {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.triangle.branch")
                                    .font(.caption)
                                Text("#\(prNumber)")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.blue)
                            .clipShape(Capsule())
                        }
                    }

                    // Phabricator diff badge if available
                    if let diffNum = viewModel.commitResponse?.commit.diffNum {
                        Text(diffNum)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.purple)
                            .clipShape(Capsule())
                    }
                }
            }

            // SHA with copy button
            HStack(spacing: 8) {
                Image(systemName: "number")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(viewModel.commitResponse?.commit.shortSha ?? viewModel.sha.prefix(7).description)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)

                Button {
                    UIPasteboard.general.string = viewModel.sha
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copiedSHA = true
                    Task { try? await Task.sleep(for: .seconds(2)); copiedSHA = false }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copiedSHA ? "checkmark" : "doc.on.doc")
                            .font(.caption)
                        Text(copiedSHA ? "Copied!" : "Copy SHA")
                            .font(.caption)
                    }
                    .foregroundStyle(copiedSHA ? .green : .blue)
                }
                .disabled(copiedSHA)
            }

            // Body in disclosure group
            if let body = viewModel.commitResponse?.commit.body, !body.isEmpty {
                DisclosureGroup {
                    Text(body)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.top, 8)
                } label: {
                    Text("Full Commit Message")
                        .font(.subheadline.weight(.medium))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Autorevert Banner

    @ViewBuilder
    private var autorevertBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .font(.title3)
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 2) {
                Text("Autorevert Commit")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Text("This commit was generated by the autorevert system.")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.8))
            }

            Spacer()
        }
        .padding()
        .background(AppColors.unstable.gradient)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Summary Stats

    @ViewBuilder
    private var summaryStatsSection: some View {
        VStack(spacing: 12) {
            // Primary stats row
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 12) {
                StatCell(
                    label: "Total",
                    value: viewModel.totalJobs,
                    color: .primary
                )
                StatCell(
                    label: "Passed",
                    value: viewModel.passedJobs,
                    color: AppColors.success
                )
                StatCell(
                    label: "Failed",
                    value: viewModel.failedJobs,
                    color: AppColors.failure
                )
                StatCell(
                    label: "Pending",
                    value: viewModel.pendingJobs,
                    color: AppColors.pending
                )
            }

            // Secondary stats row (only show if there are skipped or cancelled jobs)
            if viewModel.skippedJobs > 0 || viewModel.cancelledJobs > 0 {
                HStack(spacing: 12) {
                    if viewModel.skippedJobs > 0 {
                        StatCell(
                            label: "Skipped",
                            value: viewModel.skippedJobs,
                            color: AppColors.skipped
                        )
                    }
                    if viewModel.cancelledJobs > 0 {
                        StatCell(
                            label: "Cancelled",
                            value: viewModel.cancelledJobs,
                            color: AppColors.cancelled
                        )
                    }
                    Spacer()
                }
            }
        }
    }

    // MARK: - Progress Bar

    @ViewBuilder
    private var progressBarSection: some View {
        if viewModel.totalJobs > 0 {
            VStack(alignment: .leading, spacing: 8) {
                // Completion label
                HStack {
                    Text("CI Progress")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text("\(Int(viewModel.completionRatio * 100))% complete")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Stacked progress bar
                GeometryReader { geometry in
                    let totalWidth = geometry.size.width
                    ZStack(alignment: .leading) {
                        // Background
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color(.quaternarySystemFill))
                            .frame(height: 8)

                        // Success portion
                        if viewModel.passedJobs > 0 {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(AppColors.success)
                                .frame(width: totalWidth * viewModel.successRatio, height: 8)
                        }

                        // Failure portion (stacked after success)
                        if viewModel.failedJobs > 0 {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(AppColors.failure)
                                .frame(width: totalWidth * viewModel.failureRatio, height: 8)
                                .offset(x: totalWidth * viewModel.successRatio)
                        }
                    }
                }
                .frame(height: 8)
                .animation(.easeInOut(duration: 0.3), value: viewModel.completionRatio)
            }
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Links Section

    @ViewBuilder
    private var linksSection: some View {
        HStack(spacing: 10) {
            Button {
                if let url = URL(string: viewModel.commitURL) {
                    safariURL = url
                    showingSafari = true
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "link.circle.fill")
                        .font(.body)
                    Text("View on GitHub")
                        .font(.subheadline.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.bordered)
            .tint(.blue)

            if let prNumber = viewModel.commitResponse?.commit.prNumber {
                NavigationLink(value: PRNavigation(
                    prNumber: prNumber,
                    repoOwner: viewModel.repoOwner,
                    repoName: viewModel.repoName
                )) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.body)
                        Text("View PR")
                            .font(.subheadline.weight(.medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(.purple)
            }

            if let url = URL(string: viewModel.commitURL) {
                ShareLink(item: url) {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.body)
                        Text("Share")
                            .font(.subheadline.weight(.medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
            }
        }
    }

    // MARK: - Jobs Section

    @ViewBuilder
    private var jobsSection: some View {
        if viewModel.groupedJobs.isEmpty {
            VStack(spacing: 16) {
                Image(systemName: "hammer.circle")
                    .font(.system(size: 64))
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.hierarchical)

                VStack(spacing: 8) {
                    Text("No Jobs Found")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)

                    Text("This commit doesn't have any CI jobs yet. They may still be queuing or this commit might not trigger any workflows.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .padding(.horizontal, 32)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                // Header with expand/collapse
                HStack {
                    Text("Workflows")
                        .font(.title3.weight(.semibold))

                    Spacer()

                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            if viewModel.hasExpandedWorkflows {
                                viewModel.collapseAllWorkflows()
                            } else {
                                viewModel.expandAllWorkflows()
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: viewModel.hasExpandedWorkflows ? "chevron.up.circle" : "chevron.down.circle")
                                .font(.body)
                            Text(viewModel.hasExpandedWorkflows ? "Collapse All" : "Expand All")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(.blue)
                    }
                }

                // Status filter chips
                statusFilterChips

                // Sort picker + Job search bar
                HStack(spacing: 8) {
                    jobSearchBar

                    Menu {
                        ForEach(CommitDetailViewModel.SortOption.allCases, id: \.self) { option in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    viewModel.sortOption = option
                                }
                            } label: {
                                HStack {
                                    Text(option.rawValue)
                                    if viewModel.sortOption == option {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.up.arrow.down")
                                .font(.caption)
                            Text(viewModel.sortOption.rawValue)
                                .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 9)
                        .background(viewModel.sortOption != .status ? Color.accentColor.opacity(0.15) : Color(.tertiarySystemFill))
                        .foregroundStyle(viewModel.sortOption != .status ? Color.accentColor : .secondary)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }

                // Filter results indicator
                if viewModel.isFiltering {
                    HStack(spacing: 6) {
                        Image(systemName: "line.3.horizontal.decrease.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Showing \(viewModel.visibleJobCount.formatted()) of \(viewModel.totalJobs.formatted()) jobs")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.clearFilters()
                            }
                        } label: {
                            Text("Clear Filters")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.blue)
                        }
                    }
                }

                // Filtered workflow list
                let displayedGroups = viewModel.filteredGroupedJobs
                if displayedGroups.isEmpty && viewModel.isFiltering {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text("No matching jobs")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                        Text("Try adjusting your filters or search query.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                } else {
                    ForEach(displayedGroups, id: \.workflowName) { group in
                        workflowSection(group)
                    }
                }
            }
        }
    }

    // MARK: - Status Filter Chips

    @ViewBuilder
    private var statusFilterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(CommitDetailViewModel.StatusFilter.allCases, id: \.self) { filter in
                    let isSelected = viewModel.statusFilter == filter
                    let count = countForFilter(filter)
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.statusFilter = filter
                            if filter != .all {
                                viewModel.expandFilteredWorkflows()
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            if filter != .all {
                                Circle()
                                    .fill(colorForFilter(filter))
                                    .frame(width: 6, height: 6)
                            }
                            Text(filter.rawValue)
                                .font(.caption.weight(.medium))
                            if filter != .all && count > 0 {
                                Text("\(count)")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(isSelected ? .white.opacity(0.8) : .secondary)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(isSelected ? colorForFilter(filter) : Color(.tertiarySystemFill))
                        .foregroundStyle(isSelected ? .white : .primary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func countForFilter(_ filter: CommitDetailViewModel.StatusFilter) -> Int {
        switch filter {
        case .all: return viewModel.totalJobs
        case .failed: return viewModel.failedJobs
        case .cancelled: return viewModel.cancelledJobs
        case .pending: return viewModel.pendingJobs
        case .passed: return viewModel.passedJobs
        case .skipped: return viewModel.skippedJobs
        }
    }

    private func colorForFilter(_ filter: CommitDetailViewModel.StatusFilter) -> Color {
        switch filter {
        case .all: return .blue
        case .failed: return AppColors.failure
        case .cancelled: return AppColors.cancelled
        case .pending: return AppColors.pending
        case .passed: return AppColors.success
        case .skipped: return AppColors.skipped
        }
    }

    // MARK: - Job Search Bar

    @ViewBuilder
    private var jobSearchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(.secondary)

            TextField("Search jobs...", text: $viewModel.jobSearchText)
                .font(.subheadline)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            if !viewModel.jobSearchText.isEmpty {
                Button {
                    viewModel.jobSearchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Workflow Section

    @ViewBuilder
    private func workflowSection(_ group: (workflowName: String, jobs: [JobData])) -> some View {
        let isExpanded = viewModel.expandedWorkflows.contains(group.workflowName)
        let failureCount = group.jobs.filter {
            $0.isFailure && $0.conclusion?.lowercased() != "cancelled" && $0.conclusion?.lowercased() != "canceled"
        }.count
        let successCount = group.jobs.filter { $0.isSuccess }.count
        let pendingCount = group.jobs.filter {
            let c = $0.conclusion?.lowercased()
            return c == nil || c == "pending" || c == "queued" || c == "in_progress"
        }.count

        VStack(alignment: .leading, spacing: 0) {
            // Workflow Header
            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    viewModel.toggleWorkflow(group.workflowName)
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                        .animation(.easeInOut(duration: 0.2), value: isExpanded)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.workflowName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        // Compact status indicator dots
                        HStack(spacing: 10) {
                            if failureCount > 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 10))
                                        .foregroundStyle(AppColors.failure)
                                    Text("\(failureCount) failed")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if pendingCount > 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "clock.fill")
                                        .font(.system(size: 10))
                                        .foregroundStyle(AppColors.pending)
                                    Text("\(pendingCount) pending")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if successCount > 0 && failureCount == 0 && pendingCount == 0 {
                                HStack(spacing: 3) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 10))
                                        .foregroundStyle(AppColors.success)
                                    Text("All passed")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    Spacer()

                    // Mini progress ring for the workflow
                    workflowProgressRing(
                        total: group.jobs.count,
                        passed: successCount,
                        failed: failureCount
                    )

                    Text("\(group.jobs.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.quaternarySystemFill))
                        .clipShape(Capsule())
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color(.tertiarySystemBackground))
                .clipShape(
                    RoundedRectangle(cornerRadius: isExpanded ? 0 : 10)
                        .corners(isExpanded ? [.topLeft, .topRight] : .allCorners)
                )
            }
            .buttonStyle(.plain)

            // Expanded Job List
            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(group.jobs, id: \.id) { job in
                        jobRow(job)
                            .background(Color(.secondarySystemBackground))
                        if job.id != group.jobs.last?.id {
                            Divider()
                                .padding(.leading, 44)
                        }
                    }
                }
                .background(Color(.secondarySystemBackground))
                .clipShape(
                    RoundedRectangle(cornerRadius: 10)
                        .corners([.bottomLeft, .bottomRight])
                )
            }
        }
        .shadow(color: Color.black.opacity(0.05), radius: 3, x: 0, y: 1)
    }

    // MARK: - Workflow Progress Ring

    @ViewBuilder
    private func workflowProgressRing(total: Int, passed: Int, failed: Int) -> some View {
        let passedFraction = total > 0 ? Double(passed) / Double(total) : 0
        let failedFraction = total > 0 ? Double(failed) / Double(total) : 0
        let ringColor: Color = failed > 0 ? AppColors.failure : (passed == total ? AppColors.success : AppColors.pending)

        ZStack {
            Circle()
                .stroke(Color(.quaternarySystemFill), lineWidth: 2.5)

            Circle()
                .trim(from: 0, to: passedFraction + failedFraction)
                .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 20, height: 20)
        .animation(.easeInOut(duration: 0.3), value: passedFraction)
    }

    // MARK: - Job Row

    @ViewBuilder
    private func jobRow(_ job: JobData) -> some View {
        Button {
            selectedJob = job
        } label: {
            HStack(spacing: 12) {
                // Status icon with larger size for better visibility
                JobStatusIcon(conclusion: job.unstable == true ? "unstable" : job.conclusion)
                    .frame(width: 20)

                VStack(alignment: .leading, spacing: 4) {
                    // Job name with better typography
                    Text(job.jobName ?? job.name ?? "Unknown Job")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    // Metadata row
                    HStack(spacing: 10) {
                        if let duration = job.durationFormatted {
                            HStack(spacing: 4) {
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

                        if job.isFailure, let prev = job.previousRun, prev.conclusion == "failure" {
                            Text("Known")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color(.systemGray4).opacity(0.5))
                                .clipShape(Capsule())
                        }

                        if let attempt = job.runAttempt, attempt > 1 {
                            Text("Attempt \(attempt)")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.15))
                                .clipShape(Capsule())
                        }

                        // Show conclusion text for non-success/non-failure states
                        if let conclusion = job.conclusion,
                           conclusion.lowercased() != "success" && conclusion.lowercased() != "failure" {
                            Text(conclusion.capitalized)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(AppColors.forConclusion(conclusion))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(AppColors.forConclusion(conclusion).opacity(0.15))
                                .clipShape(Capsule())
                        }
                    }

                    // Failure line with better styling
                    if job.isFailure, let failureLines = job.failureLines, let firstLine = failureLines.first {
                        Text(firstLine)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(AppColors.failure.opacity(0.9))
                            .lineLimit(1)
                            .padding(.top, 2)
                    }
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Helpers

    /// Build an avatar URL from the commit's authorUrl (GitHub profile URL).
    private var commitAvatarURL: URL? {
        guard let authorUrl = viewModel.commitResponse?.commit.authorUrl else { return nil }
        return URL(string: authorUrl + ".png?size=64")
    }
}

// MARK: - Stat Cell

private struct StatCell: View {
    let label: String
    let value: Int
    let color: Color

    var body: some View {
        VStack(spacing: 6) {
            Text(value.formatted())
                .font(.title2.bold())
                .foregroundStyle(color)
                .contentTransition(.numericText())
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.5)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(color: Color.black.opacity(0.03), radius: 2, x: 0, y: 1)
    }
}

// MARK: - RoundedCorners Helper

private extension Shape {
    func corners(_ corners: UIRectCorner) -> some Shape {
        RoundedCornerShape(corners: corners, shape: self)
    }
}

private struct RoundedCornerShape<S: Shape>: Shape {
    let corners: UIRectCorner
    let shape: S

    func path(in rect: CGRect) -> Path {
        shape.path(in: rect)
    }
}

#Preview {
    NavigationStack {
        CommitDetailView(sha: "abc1234567890")
    }
}
