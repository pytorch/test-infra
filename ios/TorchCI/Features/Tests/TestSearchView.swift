import SwiftUI

struct TestSearchView: View {
    @StateObject private var viewModel = TestSearchViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Inline search bar for quick filtering
            SearchBar(
                text: $viewModel.searchQuery,
                placeholder: viewModel.selectedTab == .disabled
                    ? "Filter disabled tests..."
                    : "Quick search by test name...",
                onSubmit: {
                    // On submit: for all-tests tab, copy query to name filter and search
                    if viewModel.selectedTab == .all && !viewModel.searchQuery.isEmpty {
                        viewModel.nameFilter = viewModel.searchQuery
                        viewModel.applyFilters()
                    }
                }
            )
            .padding(.horizontal)
            .padding(.top, 8)
            .padding(.bottom, 4)
            .onChange(of: viewModel.searchQuery) {
                if viewModel.selectedTab == .disabled {
                    viewModel.onSearchQueryChanged()
                }
            }

            // Active filter chips
            if viewModel.hasActiveFilters {
                filterChipsBar
            }

            // Tab picker
            SegmentedPicker(
                options: TestSearchViewModel.TestTab.allCases,
                selection: $viewModel.selectedTab
            )
            .padding(.horizontal)
            .padding(.bottom, 4)
            .onChange(of: viewModel.selectedTab) {
                viewModel.onTabChanged()
            }

            // Result count and advanced filter button
            resultCountBar

            Divider()

            // Content
            contentView
        }
        .navigationTitle("Test Search")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(destination: TestFileReportView()) {
                    Label("File Report", systemImage: "doc.text.magnifyingglass")
                }
            }
        }
        .sheet(isPresented: $viewModel.isShowingFilters) {
            filterSheet
        }
        .task {
            await viewModel.loadInitialData()
        }
    }

    // MARK: - Filter Chips Bar

    private var filterChipsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(viewModel.activeFilterChips, id: \.label) { chip in
                    HStack(spacing: 4) {
                        Text(chip.label)
                            .font(.caption)
                            .lineLimit(1)

                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.removeFilter(chip.field)
                            }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption2)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .foregroundStyle(Color.accentColor)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(Capsule())
                }

                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        viewModel.clearFilters()
                    }
                } label: {
                    Text("Clear all")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(Color(.systemGray6))
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal)
        }
        .padding(.bottom, 4)
    }

    // MARK: - Result Count Bar

    private var resultCountBar: some View {
        HStack(spacing: 8) {
            if let countText = viewModel.resultCountText {
                Text(countText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }

            Spacer()

            Button {
                viewModel.isShowingFilters = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: viewModel.hasActiveFilters
                        ? "line.3.horizontal.decrease.circle.fill"
                        : "line.3.horizontal.decrease.circle"
                    )
                    Text("Filters")
                        .font(.caption)
                }
                .font(.subheadline)
                .foregroundStyle(viewModel.hasActiveFilters ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.2), value: viewModel.resultCountText)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentView: some View {
        switch viewModel.state {
        case .idle:
            Color.clear

        case .loading:
            LoadingView(message: loadingMessage)

        case .loaded:
            if viewModel.hasResults {
                resultsList
            } else if viewModel.hasActiveFilters || viewModel.hasSearchQuery {
                emptyStateView
            } else {
                welcomeView
            }

        case .error(let message):
            ErrorView(
                error: NSError(
                    domain: "",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: message]
                )
            ) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Results List

    private var resultsList: some View {
        List {
            if viewModel.selectedTab == .disabled {
                disabledTestsList
            } else {
                testResultsList
            }
        }
        .listStyle(.plain)
        .refreshable {
            await viewModel.refresh()
        }
    }

    private var testResultsList: some View {
        Group {
            ForEach(viewModel.tests) { test in
                NavigationLink {
                    TestInfoView(
                        testName: test.name,
                        testSuite: test.suite,
                        testFile: test.file
                    )
                } label: {
                    TestResultRow(test: test)
                }
                .buttonStyle(.plain)
                .onAppear {
                    // Load more when user scrolls near the end
                    if test.id == viewModel.tests.last?.id {
                        viewModel.loadMore()
                    }
                }
            }

            // Load more indicator
            if viewModel.canLoadMore {
                HStack {
                    Spacer()
                    ProgressView()
                        .padding()
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }
        }
    }

    private var disabledTestsList: some View {
        ForEach(viewModel.disabledTests) { test in
            disabledTestRow(test)
        }
    }

    // MARK: - Disabled Test Row

    private func disabledTestRow(_ test: DisabledTest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Test name
            Text(test.parsedTestName)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)

            // Suite name
            if let suite = test.suiteName, !suite.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "folder")
                        .font(.caption2)
                    Text(suite)
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }

            // Status badge and platforms
            HStack(spacing: 8) {
                TestStatusBadge(status: .disabled)

                if let platforms = test.platforms, !platforms.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(platforms, id: \.self) { platform in
                                platformBadge(platform)
                            }
                        }
                    }
                }
            }

            // Issue link
            if let issueUrl = test.issueUrl, let issueNumber = test.issueNumber {
                LinkButton(
                    title: "Issue #\(issueNumber)",
                    url: issueUrl,
                    icon: "link.circle"
                )
                .font(.caption)
            }
        }
        .padding(.vertical, 4)
    }

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

    // MARK: - Welcome View

    private var welcomeView: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 12) {
                    Image(systemName: "magnifyingglass.circle.fill")
                        .font(.system(size: 60))
                        .foregroundStyle(.secondary)

                    Text("Search for Tests")
                        .font(.title2.weight(.semibold))

                    Text("Search by name above, or use advanced filters for suite and file")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding(.top, 60)

                if !viewModel.recentSearches.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Recent Searches")
                            .font(.headline)
                            .padding(.horizontal)

                        ForEach(viewModel.recentSearches) { search in
                            recentSearchRow(search)
                        }
                    }
                    .padding(.top, 12)
                }

                Button {
                    viewModel.isShowingFilters = true
                } label: {
                    HStack {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                        Text("Advanced Filters")
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .padding(.top, 8)

                // Quick tips
                VStack(alignment: .leading, spacing: 8) {
                    Text("Tips")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    tipRow(icon: "magnifyingglass", text: "Type a test name and press return to search")
                    tipRow(icon: "line.3.horizontal.decrease.circle", text: "Use filters to search by suite or file")
                    tipRow(icon: "arrow.left.arrow.right", text: "Switch tabs to browse disabled tests")
                }
                .padding()
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func tipRow(icon: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func recentSearchRow(_ search: RecentSearch) -> some View {
        Button {
            viewModel.applyRecentSearch(search)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)

                VStack(alignment: .leading, spacing: 2) {
                    Text(search.displayText)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    Text(search.timestamp, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    viewModel.removeRecentSearch(search)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        EmptyStateView(
            icon: emptyStateIcon,
            title: emptyStateTitle,
            message: emptyStateMessage,
            actionTitle: (viewModel.hasActiveFilters || viewModel.hasSearchQuery) ? "Clear Filters" : nil
        ) {
            viewModel.clearFilters()
        }
    }

    private var emptyStateIcon: String {
        switch viewModel.selectedTab {
        case .all: return "magnifyingglass"
        case .disabled: return "minus.circle"
        }
    }

    private var emptyStateTitle: String {
        switch viewModel.selectedTab {
        case .all: return "No Tests Found"
        case .disabled: return "No Disabled Tests"
        }
    }

    private var emptyStateMessage: String {
        if viewModel.hasActiveFilters || viewModel.hasSearchQuery {
            return "No results match your search criteria. Try adjusting your filters or search terms."
        }
        switch viewModel.selectedTab {
        case .all: return "Enter a search term or use filters to find tests."
        case .disabled: return "There are currently no disabled tests."
        }
    }

    private var loadingMessage: String {
        switch viewModel.selectedTab {
        case .all: return "Searching tests..."
        case .disabled: return "Loading disabled tests..."
        }
    }

    // MARK: - Filter Sheet

    private var filterSheet: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Image(systemName: "character.cursor.ibeam")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        TextField(
                            "Test Name",
                            text: $viewModel.nameFilter,
                            prompt: Text("e.g. test_conv2d_backward_gpu")
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    }

                    HStack {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        TextField(
                            "Test Suite/Class",
                            text: $viewModel.suiteFilter,
                            prompt: Text("e.g. TestConvolutionNN")
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    }

                    HStack {
                        Image(systemName: "doc.text")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        TextField(
                            "Test File",
                            text: $viewModel.fileFilter,
                            prompt: Text("e.g. test_nn.py")
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    }
                } header: {
                    Text("Search Filters")
                } footer: {
                    Text("All filters are optional and combined with AND logic. Partial matches are supported.")
                }

                if viewModel.hasActiveFilters {
                    Section {
                        // Preview of active filters
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Active Filters")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            Text(viewModel.activeFilterSummary)
                                .font(.subheadline)
                                .foregroundStyle(Color.accentColor)
                        }

                        Button(role: .destructive) {
                            viewModel.clearFilters()
                        } label: {
                            HStack {
                                Image(systemName: "xmark.circle.fill")
                                Text("Clear All Filters")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Test Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.isShowingFilters = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Search") {
                        viewModel.applyFilters()
                    }
                    .fontWeight(.semibold)
                    .disabled(!viewModel.hasActiveFilters)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

#Preview {
    NavigationStack {
        TestSearchView()
    }
}
