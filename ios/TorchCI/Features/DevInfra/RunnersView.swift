import SwiftUI

struct RunnersView: View {
    @StateObject private var viewModel = RunnersViewModel()

    var body: some View {
        VStack(spacing: 0) {
            headerSection
                .padding(.horizontal)
                .padding(.top, 8)

            if viewModel.state == .loaded {
                organizationInfo
                    .padding(.horizontal)
                    .padding(.top, 8)
            }

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Runners")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadData()
            viewModel.startAutoRefresh()
        }
        .onDisappear {
            viewModel.stopAutoRefresh()
        }
    }

    private var organizationInfo: some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Self-hosted GitHub Actions runners for \(viewModel.selectedOrg)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                orgPicker
                Spacer()
                if viewModel.state == .loaded {
                    lastUpdatedLabel
                }
            }

            SearchBar(
                text: $viewModel.searchFilter,
                placeholder: "Search by name, ID, OS, or labels..."
            )

            if viewModel.state == .loaded {
                VStack(spacing: 10) {
                    summaryBar
                    sortControls
                }
            }
        }
    }

    private var orgPicker: some View {
        Menu {
            ForEach(RunnersViewModel.orgs, id: \.self) { org in
                Button {
                    viewModel.selectOrg(org)
                } label: {
                    HStack {
                        Text(org)
                        if org == viewModel.selectedOrg {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "building.2")
                    .font(.caption)
                Text(viewModel.selectedOrg)
                    .font(.subheadline.weight(.medium))
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityLabel("Organization: \(viewModel.selectedOrg)")
        .accessibilityHint("Double tap to change organization")
    }

    private var lastUpdatedLabel: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(AppColors.success)
                .frame(width: 6, height: 6)
            if let lastRefreshed = viewModel.lastRefreshed {
                Text(lastRefreshed, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("Live")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Live data, auto-refreshing")
    }

    // MARK: - Summary Bar

    private var summaryBar: some View {
        HStack(spacing: 6) {
            ForEach(RunnersViewModel.StatusFilter.allCases, id: \.self) { filter in
                summaryPill(filter: filter)
            }
        }
    }

    private func summaryPill(filter: RunnersViewModel.StatusFilter) -> some View {
        let count = viewModel.count(for: filter)
        let color = colorForFilter(filter)
        let isActive = viewModel.statusFilter == filter

        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                viewModel.toggleStatusFilter(filter)
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
                Text(filter.label)
                    .font(.caption2)
                    .foregroundStyle(isActive ? Color.white : .secondary)
                Text("\(count)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(isActive ? Color.white : Color.primary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(isActive ? color : color.opacity(0.1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(filter.label): \(count) runners")
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(isActive ? "Double tap to clear filter" : "Double tap to filter by \(filter.label.lowercased())")
    }

    private func colorForFilter(_ filter: RunnersViewModel.StatusFilter) -> Color {
        switch filter {
        case .all: return .primary
        case .idle: return AppColors.success
        case .busy: return AppColors.unstable
        case .offline: return AppColors.neutral
        }
    }

    private var sortControls: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation {
                    viewModel.sortOrder = .alphabetical
                }
            } label: {
                Text("Sort A-Z")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(viewModel.sortOrder == .alphabetical ? Color.white : Color.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(viewModel.sortOrder == .alphabetical ? Color.accentColor : Color(.systemGray5))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .accessibilityAddTraits(viewModel.sortOrder == .alphabetical ? [.isButton, .isSelected] : .isButton)

            Button {
                withAnimation {
                    viewModel.sortOrder = .count
                }
            } label: {
                Text("Sort by Count")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(viewModel.sortOrder == .count ? Color.white : Color.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(viewModel.sortOrder == .count ? Color.accentColor : Color(.systemGray5))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .accessibilityAddTraits(viewModel.sortOrder == .count ? [.isButton, .isSelected] : .isButton)

            Spacer()

            if viewModel.filteredGroups.count > 1 {
                Menu {
                    Button {
                        withAnimation {
                            viewModel.expandAll()
                        }
                    } label: {
                        Label("Expand All", systemImage: "chevron.down.circle")
                    }

                    Button {
                        withAnimation {
                            viewModel.collapseAll()
                        }
                    } label: {
                        Label("Collapse All", systemImage: "chevron.up.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(6)
                }
                .accessibilityLabel("More options")
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            EmptyStateView(
                icon: "server.rack",
                title: "Runners",
                message: "Loading runner information..."
            )

        case .loading:
            LoadingView(message: "Fetching runners...")

        case .loaded:
            if viewModel.filteredGroups.isEmpty {
                if viewModel.searchFilter.isEmpty && viewModel.statusFilter == .all {
                    EmptyStateView(
                        icon: "server.rack",
                        title: "No Runners",
                        message: "No runner groups found for \(viewModel.selectedOrg)."
                    )
                } else {
                    EmptyStateView(
                        icon: "magnifyingglass",
                        title: "No Results",
                        message: noResultsMessage,
                        actionTitle: "Clear Filters"
                    ) {
                        viewModel.searchFilter = ""
                        viewModel.statusFilter = .all
                    }
                }
            } else {
                runnersList
            }

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    private var noResultsMessage: String {
        var parts: [String] = []
        if !viewModel.searchFilter.isEmpty {
            parts.append("search \"\(viewModel.searchFilter)\"")
        }
        if viewModel.statusFilter != .all {
            parts.append("status \"\(viewModel.statusFilter.label)\"")
        }
        if parts.isEmpty {
            return "No runners match your current filters."
        }
        return "No runners match \(parts.joined(separator: " and "))."
    }

    // MARK: - Runners List

    private var runnersList: some View {
        VStack(spacing: 0) {
            if !viewModel.searchFilter.isEmpty || viewModel.statusFilter != .all {
                searchResultsHeader
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                Divider()
            }

            List {
                ForEach(viewModel.filteredGroups) { group in
                    Section {
                        runnerGroupHeader(group)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    viewModel.toggleGroup(group)
                                }
                            }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityHint(viewModel.isGroupExpanded(group) ? "Double tap to collapse" : "Double tap to expand")

                        if viewModel.isGroupExpanded(group) {
                            ForEach(group.runners) { runner in
                                RunnerRow(runner: runner)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await viewModel.refresh() }
        }
    }

    private var searchResultsHeader: some View {
        HStack {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("\(filteredRunnerCount) runners in \(viewModel.filteredGroups.count) groups")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                viewModel.searchFilter = ""
                viewModel.statusFilter = .all
            } label: {
                Text("Clear All")
                    .font(.caption.weight(.medium))
            }
        }
    }

    private var filteredRunnerCount: Int {
        viewModel.filteredGroups.reduce(0) { $0 + $1.runners.count }
    }

    private func runnerGroupHeader(_ group: RunnerGroup) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: viewModel.isGroupExpanded(group) ? "chevron.down" : "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)

                Text(group.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)

                Spacer()

                Text("\(group.totalCount)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color(.systemGray5))
                    .clipShape(Capsule())
            }

            // Status breakdown badges
            HStack(spacing: 4) {
                groupCountBadge(count: group.idleCount, label: "idle", color: AppColors.success)
                groupCountBadge(count: group.busyCount, label: "busy", color: AppColors.unstable)
                groupCountBadge(count: group.offlineCount, label: "offline", color: AppColors.neutral)
            }
            .padding(.leading, 20)

            // Utilization bar
            if group.totalCount > 0 {
                GroupUtilizationBar(group: group)
                    .padding(.leading, 20)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(group.name), \(group.totalCount) runners: \(group.idleCount) idle, \(group.busyCount) busy, \(group.offlineCount) offline")
    }

    private func groupCountBadge(count: Int, label: String, color: Color) -> some View {
        Group {
            if count > 0 {
                HStack(spacing: 3) {
                    Text("\(count)")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                    Text(label)
                        .font(.caption2)
                }
                .foregroundStyle(color)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(color.opacity(0.15))
                .clipShape(Capsule())
            }
        }
    }
}

// MARK: - Group Utilization Bar

private struct GroupUtilizationBar: View {
    let group: RunnerGroup

    var body: some View {
        GeometryReader { geometry in
            let totalWidth = geometry.size.width
            let idleFraction = CGFloat(group.idleCount) / CGFloat(max(group.totalCount, 1))
            let busyFraction = CGFloat(group.busyCount) / CGFloat(max(group.totalCount, 1))
            let offlineFraction = CGFloat(group.offlineCount) / CGFloat(max(group.totalCount, 1))

            HStack(spacing: 1) {
                if group.idleCount > 0 {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AppColors.success)
                        .frame(width: max(idleFraction * totalWidth, 2))
                }
                if group.busyCount > 0 {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AppColors.unstable)
                        .frame(width: max(busyFraction * totalWidth, 2))
                }
                if group.offlineCount > 0 {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AppColors.neutral.opacity(0.5))
                        .frame(width: max(offlineFraction * totalWidth, 2))
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

// MARK: - Runner Row

private struct RunnerRow: View {
    let runner: Runner

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(runner.name)
                        .font(.caption.weight(.medium))
                        .lineLimit(2)
                        .textSelection(.enabled)

                    Text("ID: \(runner.id)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }

                Spacer(minLength: 8)

                statusChip
            }

            metadataRow
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(runner.name), status: \(runner.statusDisplay)")
    }

    @ViewBuilder
    private var metadataRow: some View {
        let hasOS = runner.os != nil && !(runner.os?.isEmpty ?? true)
        let hasLabels = runner.labels != nil && !(runner.labels?.isEmpty ?? true)

        if hasOS || hasLabels {
            FlowLayout(spacing: 4) {
                if let os = runner.os, !os.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: osIcon)
                            .font(.system(size: 9))
                        Text(os)
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }

                if let labels = runner.labels, !labels.isEmpty {
                    ForEach(Array(labels.prefix(4))) { label in
                        Text(label.name)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }

                    if labels.count > 4 {
                        Text("+\(labels.count - 4)")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 3)
                    }
                }
            }
        }
    }

    private var statusChip: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(runner.statusDisplay)
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(statusColor.opacity(0.15))
        .foregroundStyle(statusColor)
        .clipShape(Capsule())
    }

    private var statusColor: Color {
        switch runner.statusColor {
        case "green": return AppColors.success
        case "orange": return AppColors.unstable
        default: return AppColors.neutral
        }
    }

    private var osIcon: String {
        guard let os = runner.os?.lowercased() else { return "desktopcomputer" }
        if os.contains("linux") { return "server.rack" }
        if os.contains("macos") || os.contains("darwin") { return "laptopcomputer" }
        if os.contains("windows") { return "pc" }
        return "desktopcomputer"
    }
}

#Preview {
    NavigationStack {
        RunnersView()
    }
}
