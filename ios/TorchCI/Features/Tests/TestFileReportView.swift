import SwiftUI

struct TestFileReportView: View {
    @StateObject private var viewModel = TestFileReportViewModel()

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            switch viewModel.state {
            case .idle:
                EmptyView()
            case .loading:
                LoadingView(message: "Loading test file report...")
            case .loaded:
                LoadedContentView(viewModel: viewModel)
            case .error(let message):
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.refresh() } }
                )
            }
        }
        .navigationTitle("Test File Report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Date Range", selection: $viewModel.selectedDateRange) {
                        Text("Last 3 Days").tag(3)
                        Text("Last 7 Days").tag(7)
                        Text("Last 14 Days").tag(14)
                        Text("Last 30 Days").tag(30)
                    }
                } label: {
                    Label("Date Range", systemImage: "calendar")
                }
            }
        }
        .task {
            if viewModel.state == .idle {
                await viewModel.loadData()
            }
        }
        .onChange(of: viewModel.selectedDateRange) { oldValue, newValue in
            viewModel.onDateRangeChanged()
        }
    }
}


// MARK: - Loaded Content View

private struct LoadedContentView: View {
    @ObservedObject var viewModel: TestFileReportViewModel

    var body: some View {
        VStack(spacing: 0) {
            // Search and Sort Controls
            VStack(spacing: 10) {
                // Search Bar
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField("Search files or labels...", text: $viewModel.searchQuery)
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        .onChange(of: viewModel.searchQuery) { oldValue, newValue in
                            viewModel.onSearchQueryChanged()
                        }
                    if !viewModel.searchQuery.isEmpty {
                        Button(action: { viewModel.searchQuery = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(10)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 10))

                // Sort Options
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Text("Sort:")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        ForEach(TestFileReportViewModel.SortOption.allCases, id: \.self) { option in
                            Button(action: { viewModel.sortOption = option }) {
                                Text(option.rawValue)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(viewModel.sortOption == option ? Color.accentColor : Color(.systemGray5))
                                    .foregroundStyle(viewModel.sortOption == option ? .white : .primary)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Color(.systemBackground))

            // Summary Bar
            SummaryBarView(viewModel: viewModel)

            Divider()

            // File List
            if viewModel.filteredAndSortedFiles.isEmpty {
                EmptyStateView(
                    icon: viewModel.searchQuery.isEmpty ? "doc.text" : "magnifyingglass",
                    title: viewModel.searchQuery.isEmpty ? "No Test Files" : "No Matching Files",
                    message: viewModel.searchQuery.isEmpty
                        ? "No test file data available for this time period."
                        : "Try adjusting your search query."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(viewModel.filteredAndSortedFiles) { fileStat in
                            FileStatsRow(
                                fileStat: fileStat,
                                isExpanded: viewModel.expandedFiles.contains(fileStat.file),
                                onToggleExpand: { viewModel.toggleExpanded(fileStat.file) },
                                detailResults: viewModel.resultsForFile(fileStat.file)
                            )
                            Divider()
                        }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .refreshable {
            await viewModel.refresh()
        }
    }
}

// MARK: - Summary Bar

private struct SummaryBarView: View {
    @ObservedObject var viewModel: TestFileReportViewModel

    var body: some View {
        let stats = viewModel.filteredAndSortedFiles
        let totalFiles = stats.count
        let totalFailures = stats.reduce(0) { $0 + $1.failureCount }
        let totalSuccess = stats.reduce(0) { $0 + $1.successCount }
        let totalSkipped = stats.reduce(0) { $0 + $1.skippedCount }
        let totalTests = stats.reduce(0) { $0 + $1.totalTests }
        let passRate = totalTests > 0 ? Double(totalSuccess) / Double(totalTests) : 0

        HStack(spacing: 0) {
            SummaryStatItem(
                label: "Files",
                value: "\(totalFiles)",
                color: .primary
            )
            Divider().frame(height: 28)
            SummaryStatItem(
                label: "Pass",
                value: String(format: "%.1f%%", passRate * 100),
                color: passRate > 0.95 ? .green : passRate > 0.8 ? .orange : .red
            )
            Divider().frame(height: 28)
            SummaryStatItem(
                label: "Fail",
                value: "\(totalFailures)",
                color: totalFailures > 0 ? .red : .green
            )
            Divider().frame(height: 28)
            SummaryStatItem(
                label: "Skip",
                value: "\(totalSkipped)",
                color: totalSkipped > 0 ? .orange : .secondary
            )
        }
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
    }
}

private struct SummaryStatItem: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - File Stats Row

private struct FileStatsRow: View {
    let fileStat: FileStats
    let isExpanded: Bool
    let onToggleExpand: () -> Void
    let detailResults: [FileReportResult]

    var body: some View {
        VStack(spacing: 0) {
            // Main Row
            Button(action: onToggleExpand) {
                VStack(alignment: .leading, spacing: 8) {
                    // Top: file name + chevron
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                            .padding(.top, 5)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(fileStat.file)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)

                            if !fileStat.ownerLabels.isEmpty && fileStat.ownerLabels != ["unknown"] {
                                Text(fileStat.ownerLabels.joined(separator: ", "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }

                        Spacer(minLength: 4)

                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                    }

                    // Pass rate bar
                    PassRateBar(
                        successCount: fileStat.successCount,
                        failureCount: fileStat.failureCount,
                        skippedCount: fileStat.skippedCount
                    )

                    // Bottom: stats chips
                    HStack(spacing: 6) {
                        if fileStat.failureCount > 0 {
                            StatChip(
                                icon: "xmark.circle.fill",
                                value: "\(fileStat.failureCount)",
                                color: .red
                            )
                        }
                        if fileStat.skippedCount > 0 {
                            StatChip(
                                icon: "minus.circle.fill",
                                value: "\(fileStat.skippedCount)",
                                color: .orange
                            )
                        }
                        StatChip(
                            icon: "checkmark.circle.fill",
                            value: "\(fileStat.successCount)",
                            color: .green
                        )

                        Spacer(minLength: 0)

                        Label(formatDuration(fileStat.totalDuration), systemImage: "clock")
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        if fileStat.estimatedCost > 0 {
                            Text(formatCost(fileStat.estimatedCost))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Expanded Detail
            if isExpanded {
                VStack(spacing: 0) {
                    Divider()
                        .padding(.leading, 14)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Results by Job")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text("\(detailResults.count) jobs")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.bottom, 2)

                        ForEach(detailResults) { result in
                            JobResultRow(result: result)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(.systemGray6))
                }
            }
        }
    }

    private var statusColor: Color {
        if fileStat.failureCount > 0 { return .red }
        if fileStat.skippedCount > 0 { return .orange }
        return .green
    }

    private func formatDuration(_ duration: TimeInterval) -> String {
        let hours = Int(duration) / 3600
        let minutes = Int(duration) % 3600 / 60
        let seconds = Int(duration) % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if minutes > 0 {
            return "\(minutes)m \(seconds)s"
        }
        return "\(seconds)s"
    }

    private func formatCost(_ cost: Double) -> String {
        if cost >= 1000 {
            return String(format: "$%.1fk", cost / 1000)
        } else if cost >= 1 {
            return String(format: "$%.2f", cost)
        } else {
            return String(format: "$%.3f", cost)
        }
    }
}

// MARK: - Pass Rate Bar

private struct PassRateBar: View {
    let successCount: Int
    let failureCount: Int
    let skippedCount: Int

    private var total: Int { successCount + failureCount + skippedCount }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let successWidth = total > 0 ? width * CGFloat(successCount) / CGFloat(total) : width
            let failureWidth = total > 0 ? width * CGFloat(failureCount) / CGFloat(total) : 0
            let skippedWidth = total > 0 ? width * CGFloat(skippedCount) / CGFloat(total) : 0

            HStack(spacing: 1) {
                if failureCount > 0 {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.red)
                        .frame(width: max(failureWidth, 2))
                }
                if skippedCount > 0 {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.orange)
                        .frame(width: max(skippedWidth, 2))
                }
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.green.opacity(0.6))
                    .frame(width: max(successWidth, 2))
            }
        }
        .frame(height: 4)
        .clipShape(Capsule())
    }
}

// MARK: - Stat Chip

private struct StatChip: View {
    let icon: String
    let value: String
    let color: Color

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: icon)
                .foregroundStyle(color)
            Text(value)
                .foregroundStyle(.primary)
        }
        .font(.caption2.weight(.medium))
    }
}

// MARK: - Job Result Row

private struct JobResultRow: View {
    let result: FileReportResult

    private var statusIcon: String {
        if result.failures > 0 { return "xmark.circle.fill" }
        if result.skipped > 0 { return "minus.circle.fill" }
        return "checkmark.circle.fill"
    }

    private var statusColor: Color {
        if result.failures > 0 { return .red }
        if result.skipped > 0 { return .orange }
        return .green
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: statusIcon)
                .font(.caption2)
                .foregroundStyle(statusColor)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                Text(result.shortJobName)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if result.failures > 0 {
                        Text("\(result.failures) fail")
                            .foregroundStyle(.red)
                    }
                    if result.skipped > 0 {
                        Text("\(result.skipped) skip")
                            .foregroundStyle(.orange)
                    }
                    Text("\(result.success) pass")
                        .foregroundStyle(.green)

                    Spacer(minLength: 0)

                    Text(formatDuration(result.time))
                        .foregroundStyle(.secondary)
                }
                .font(.caption2)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func formatDuration(_ duration: TimeInterval) -> String {
        let hours = Int(duration) / 3600
        let minutes = Int(duration) % 3600 / 60
        let seconds = Int(duration) % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if minutes > 0 {
            return "\(minutes)m \(seconds)s"
        }
        return "\(seconds)s"
    }
}

#Preview {
    NavigationStack {
        TestFileReportView()
    }
}
