import SwiftUI
import Charts

struct DisabledTestsView: View {
    @StateObject private var viewModel = DisabledTestsViewModel()

    @State private var showingSafariURL: URL?
    @State private var showFilters = false
    @State private var showSortMenu = false
    @State private var collapsedSuites: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            SearchBar(
                text: $viewModel.searchQuery,
                placeholder: "Search test, suite, assignee, #issue..."
            )
            .padding(.horizontal)
            .padding(.vertical, 8)

            // Filter toolbar
            filterToolbar

            Divider()

            // Content
            contentView
        }
        .navigationTitle("Disabled Tests")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    groupToggleButton
                    sortButton
                    filterToggleButton
                }
            }
        }
        .task {
            await viewModel.loadDisabledTests()
        }
        .sheet(item: $showingSafariURL) { url in
            SafariView(url: url)
                .ignoresSafeArea()
        }
    }

    // MARK: - Sort Button

    private var sortButton: some View {
        Menu {
            Picker("Sort by", selection: $viewModel.sortOption) {
                ForEach(DisabledTestsViewModel.SortOption.allCases) { option in
                    Label(option.rawValue, systemImage: sortIcon(for: option))
                        .tag(option)
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down.circle")
                .font(.body)
        }
    }

    private func sortIcon(for option: DisabledTestsViewModel.SortOption) -> String {
        switch option {
        case .highPriority: return "exclamationmark.triangle"
        case .newest: return "arrow.down"
        case .oldest: return "arrow.up"
        case .platform: return "square.stack.3d.up"
        }
    }

    // MARK: - Group Toggle

    private var groupToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) {
                viewModel.groupBySuite.toggle()
                if !viewModel.groupBySuite {
                    collapsedSuites.removeAll()
                }
            }
        } label: {
            Image(systemName: viewModel.groupBySuite ? "rectangle.3.group.fill" : "rectangle.3.group")
                .font(.body)
        }
        .accessibilityLabel(viewModel.groupBySuite ? "Disable grouping" : "Group by suite")
    }

    // MARK: - Filter Toolbar

    private var filterToolbar: some View {
        Group {
            if showFilters {
                VStack(spacing: 12) {
                    // Platform picker
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            Text("Platform:")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            ForEach(viewModel.availablePlatforms, id: \.self) { platform in
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        viewModel.platformFilter = platform
                                    }
                                } label: {
                                    Text(platform)
                                        .font(.caption)
                                        .fontWeight(viewModel.platformFilter == platform ? .semibold : .regular)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(
                                            viewModel.platformFilter == platform
                                                ? Color.accentColor
                                                : Color(.systemGray5)
                                        )
                                        .foregroundStyle(
                                            viewModel.platformFilter == platform ? .white : .primary
                                        )
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        .padding(.horizontal)
                    }

                    // Triaged filter
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            Text("Status:")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            ForEach(DisabledTestsViewModel.TriagedFilter.allCases) { filter in
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        viewModel.triagedFilter = filter
                                    }
                                } label: {
                                    Text(filter.rawValue)
                                        .font(.caption)
                                        .fontWeight(viewModel.triagedFilter == filter ? .semibold : .regular)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(
                                            viewModel.triagedFilter == filter
                                                ? Color.accentColor
                                                : Color(.systemGray5)
                                        )
                                        .foregroundStyle(
                                            viewModel.triagedFilter == filter ? .white : .primary
                                        )
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        .padding(.horizontal)
                    }

                    // Active filter summary
                    if viewModel.hasActiveFilters {
                        HStack {
                            Text("\(viewModel.filteredTests.count) of \(viewModel.totalCount) tests")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            Spacer()

                            Button {
                                withAnimation {
                                    viewModel.clearFilters()
                                }
                            } label: {
                                Label("Clear Filters", systemImage: "xmark.circle")
                                    .font(.caption)
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                .padding(.bottom, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private var filterToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) {
                showFilters.toggle()
            }
        } label: {
            Image(systemName: showFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(.body)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentView: some View {
        switch viewModel.state {
        case .loading:
            LoadingView(message: "Loading disabled tests...")

        case .loaded:
            if viewModel.filteredTests.isEmpty {
                if viewModel.allTests.isEmpty {
                    EmptyStateView(
                        icon: "minus.circle",
                        title: "No Disabled Tests",
                        message: "There are currently no disabled tests."
                    )
                } else {
                    EmptyStateView(
                        icon: "magnifyingglass",
                        title: "No Results",
                        message: "No tests match your current filters. Try adjusting your search or filters.",
                        actionTitle: "Clear Filters"
                    ) {
                        viewModel.clearFilters()
                    }
                }
            } else {
                testList
            }

        case .error(let message):
            ErrorView(
                error: NSError(
                    domain: "",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: message]
                )
            ) {
                Task { await viewModel.loadDisabledTests() }
            }
        }
    }

    // MARK: - Test List

    private var testList: some View {
        List {
            // Summary header with stats
            Section {
                summaryHeader
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)

            // Historical chart
            if !viewModel.historicalData.isEmpty {
                Section {
                    historicalChart
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }

            // Test rows - grouped or flat
            if viewModel.groupBySuite {
                groupedTestSections
            } else {
                flatTestSection
            }
        }
        .listStyle(.plain)
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Flat Test Section

    private var flatTestSection: some View {
        Section {
            ForEach(viewModel.filteredTests) { test in
                disabledTestRow(test)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let url = viewModel.issueURL(for: test) {
                            showingSafariURL = url
                        }
                    }
            }
        } header: {
            Text("Disabled Tests (\(viewModel.filteredTests.count))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }

    // MARK: - Grouped Test Sections

    @ViewBuilder
    private var groupedTestSections: some View {
        ForEach(viewModel.groupedTests) { group in
            Section {
                if !collapsedSuites.contains(group.suiteName) {
                    ForEach(group.tests) { test in
                        disabledTestRow(test, showSuite: false)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if let url = viewModel.issueURL(for: test) {
                                    showingSafariURL = url
                                }
                            }
                    }
                }
            } header: {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if collapsedSuites.contains(group.suiteName) {
                            collapsedSuites.remove(group.suiteName)
                        } else {
                            collapsedSuites.insert(group.suiteName)
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: collapsedSuites.contains(group.suiteName) ? "chevron.right" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        Text(group.suiteName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)

                        Text("(\(group.tests.count))")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Spacer()
                    }
                    .textCase(nil)
                }
            }
        }
    }

    // MARK: - Summary Header

    private var summaryHeader: some View {
        VStack(spacing: 12) {
            HStack(spacing: 20) {
                // Total count
                StatCard(
                    value: "\(viewModel.totalCount)",
                    label: "Total",
                    color: .blue
                )

                // Triaged
                StatCard(
                    value: "\(viewModel.triagedCount)",
                    label: "Triaged",
                    color: .green
                )

                // Untriaged
                StatCard(
                    value: "\(viewModel.untriagedCount)",
                    label: "Untriaged",
                    color: .orange
                )

                // High priority
                StatCard(
                    value: "\(viewModel.highPriorityCount)",
                    label: "High Priority",
                    color: .red
                )
            }

            // Trend indicator
            if let trend = viewModel.trend {
                HStack(spacing: 4) {
                    Image(systemName: trend > 0 ? "arrow.up.circle.fill" : trend < 0 ? "arrow.down.circle.fill" : "minus.circle.fill")
                        .foregroundStyle(trend > 0 ? .red : trend < 0 ? .green : .secondary)
                    Text("\(abs(trend)) \(trend > 0 ? "more" : "fewer") than yesterday")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: - Historical Chart

    private var historicalChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Disabled Tests Over Time")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            Chart(viewModel.historicalData.suffix(30)) { data in
                LineMark(
                    x: .value("Date", data.date ?? Date()),
                    y: .value("Count", data.count)
                )
                .foregroundStyle(.blue)
                .interpolationMethod(.catmullRom)

                AreaMark(
                    x: .value("Date", data.date ?? Date()),
                    y: .value("Count", data.count)
                )
                .foregroundStyle(.blue.opacity(0.1))
                .interpolationMethod(.catmullRom)
            }
            .frame(height: 180)
            .chartYAxis {
                AxisMarks(position: .leading)
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                    AxisValueLabel(format: .dateTime.month().day())
                }
            }
        }
        .padding()
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Disabled Test Row

    private func disabledTestRow(_ test: DisabledTest, showSuite: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Test name with badges
            HStack(spacing: 6) {
                Text(test.parsedTestName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)

                Spacer(minLength: 4)

                if test.isHighPriority {
                    Label("High Priority", systemImage: "exclamationmark.triangle.fill")
                        .labelStyle(.iconOnly)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }

                if test.isTriaged {
                    Label("Triaged", systemImage: "checkmark.seal.fill")
                        .labelStyle(.iconOnly)
                        .font(.caption2)
                        .foregroundStyle(.green)
                }
            }

            // Suite name (hidden when grouped since header shows it)
            if showSuite, let suite = test.suiteName, !suite.isEmpty {
                Text(suite)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            // Platform badges
            if let platforms = test.platforms, !platforms.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(platforms, id: \.self) { platform in
                            platformBadge(platform)
                        }
                    }
                }
            }

            // Metadata row
            HStack(spacing: 12) {
                // Issue link with number
                if let issueNumber = test.issueNumber {
                    HStack(spacing: 4) {
                        Image(systemName: "link.circle.fill")
                            .font(.caption2)
                        Text("#\(issueNumber)")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(Color.accentColor)
                }

                // Assignee
                if let assignee = test.assignee {
                    HStack(spacing: 4) {
                        Image(systemName: "person.circle")
                            .font(.caption2)
                        Text(assignee)
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }

                Spacer()

                // Days since updated with staleness indicator
                if let days = test.daysSinceUpdated {
                    HStack(spacing: 3) {
                        if days > 90 {
                            Image(systemName: "clock.badge.exclamationmark")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(formattedAge(days: days))
                            .font(.caption)
                            .foregroundStyle(days > 90 ? Color.orange : Color.gray)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: test))
    }

    // MARK: - Helpers

    private func formattedAge(days: Int) -> String {
        if days == 0 { return "today" }
        if days == 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        let months = days / 30
        if months < 12 { return "\(months)mo ago" }
        let years = months / 12
        return "\(years)y ago"
    }

    private func accessibilityLabel(for test: DisabledTest) -> String {
        var parts = [test.parsedTestName]
        if let suite = test.suiteName { parts.append("in suite \(suite)") }
        if test.isHighPriority { parts.append("high priority") }
        if test.isTriaged { parts.append("triaged") }
        if let assignee = test.assignee { parts.append("assigned to \(assignee)") }
        if let issue = test.issueNumber { parts.append("issue \(issue)") }
        if let days = test.daysSinceUpdated { parts.append("updated \(formattedAge(days: days))") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Badges & Components

    private func platformBadge(_ platform: String) -> some View {
        Text(platform)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(platformColor(platform))
            .background(platformColor(platform).opacity(0.12))
            .clipShape(Capsule())
    }

    private func platformColor(_ platform: String) -> Color {
        switch platform.lowercased() {
        case "linux": return .orange
        case "mac", "macos": return .blue
        case "windows", "win": return .purple
        case "rocm": return .red
        case "asan": return .pink
        case "dynamo": return .indigo
        case "inductor": return .cyan
        case "slow": return .brown
        case "xpu": return .mint
        default: return AppColors.neutral
        }
    }
}

// MARK: - Stat Card

struct StatCard: View {
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - URL Identifiable Conformance

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

#Preview {
    NavigationStack {
        DisabledTestsView()
    }
}
