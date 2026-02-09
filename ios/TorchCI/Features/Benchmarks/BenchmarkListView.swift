import SwiftUI

struct BenchmarkListView: View {
    @StateObject private var viewModel = BenchmarkListViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading where !viewModel.hasData:
                LoadingView(message: "Loading benchmarks...")

            case .error(let message) where !viewModel.hasData:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.refresh() } }
                )

            default:
                benchmarkList
            }
        }
        .navigationTitle("Benchmarks")
        .task {
            if viewModel.state == .idle {
                await viewModel.loadBenchmarks()
            }
        }
    }

    // MARK: - Main List

    private var benchmarkList: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Summary header
                summaryHeader
                    .padding(.horizontal)

                // Search
                SearchBar(
                    text: $viewModel.searchText,
                    placeholder: "Search benchmarks, categories..."
                )
                .padding(.horizontal)

                // Active search feedback
                if !viewModel.searchText.isEmpty {
                    searchFeedback
                }

                // Category Sections
                if viewModel.filteredCategories.isEmpty {
                    if !viewModel.searchText.isEmpty {
                        VStack(spacing: 12) {
                            EmptyStateView(
                                icon: "magnifyingglass",
                                title: "No Benchmarks Match '\(viewModel.searchText)'",
                                message: "Try a different search term or clear the search."
                            )

                            Button {
                                viewModel.searchText = ""
                            } label: {
                                Label("Clear Search", systemImage: "xmark.circle")
                                    .font(.subheadline.weight(.medium))
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                        }
                        .frame(minHeight: 300)
                    } else {
                        EmptyStateView(
                            icon: "chart.bar.xaxis",
                            title: "No Benchmarks Found",
                            message: "Try adjusting your search query."
                        )
                        .frame(minHeight: 300)
                    }
                } else {
                    categoryList
                }
            }
            .padding(.vertical)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await viewModel.refresh()
        }
        .overlay {
            if viewModel.isLoading && viewModel.hasData {
                VStack {
                    InlineLoadingView()
                        .padding(8)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                    Spacer()
                }
                .padding(.top, 8)
            }
        }
    }

    // MARK: - Summary Header

    private var summaryHeader: some View {
        HStack(spacing: 12) {
            statBadge(
                icon: "chart.bar.fill",
                value: "\(viewModel.totalBenchmarkCount)",
                label: "Benchmarks"
            )

            statBadge(
                icon: "folder.fill",
                value: "\(viewModel.categories.count)",
                label: "Categories"
            )

            Spacer()
        }
    }

    private func statBadge(icon: String, value: String, label: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.accentColor)

            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)

            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.tertiarySystemFill))
        .clipShape(Capsule())
    }

    // MARK: - Search Feedback

    private var searchFeedback: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                .font(.caption)
                .foregroundStyle(Color.accentColor)

            Text("Showing \(viewModel.filteredBenchmarkCount) of \(viewModel.totalBenchmarkCount) benchmarks")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(.horizontal)
    }

    // MARK: - Category List

    private var categoryList: some View {
        LazyVStack(spacing: 20) {
            ForEach(viewModel.filteredCategories) { category in
                categorySection(category)
            }
        }
        .padding(.horizontal)
    }

    private func categorySection(_ category: BenchmarkCategory) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // Category Header
            categoryHeader(category)

            // Category Items
            VStack(spacing: 8) {
                ForEach(category.items) { item in
                    categoryItemRow(item)
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 2)
    }

    private func categoryHeader(_ category: BenchmarkCategory) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: category.icon)
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(category.color.gradient)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(category.title)
                        .font(.headline)
                        .foregroundStyle(.primary)

                    if let subtitle = category.subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Text("\(category.items.count) \(category.items.count == 1 ? "benchmark" : "benchmarks")")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(Capsule())
            }

            Divider()
        }
    }

    private func categoryItemRow(_ item: BenchmarkItem) -> some View {
        NavigationLink {
            destinationView(for: item)
        } label: {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    if let description = item.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }

                    if let info = item.info {
                        HStack(spacing: 4) {
                            Image(systemName: "info.circle")
                                .font(.caption2)
                            Text(info)
                                .font(.caption2)
                        }
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    }

                    // Suites
                    if let suites = item.suites, !suites.isEmpty {
                        suitesRow(suites)
                    }
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.name)
        .accessibilityHint(item.description ?? "View benchmark details")
        .accessibilityAddTraits(.isButton)
    }

    private func suitesRow(_ suites: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Image(systemName: "folder.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                ForEach(suites.prefix(3), id: \.self) { suite in
                    Text(suite)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Capsule())
                }

                if suites.count > 3 {
                    Text("+\(suites.count - 3)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Navigation Destinations

    @ViewBuilder
    private func destinationView(for item: BenchmarkItem) -> some View {
        switch item.id {
        case "compiler_inductor":
            CompilerBenchmarkView(benchmarkId: item.id)

        case "pytorch_gptfast", "pytorch_x_vllm_benchmark", "vllm_benchmark", "sglang_benchmark":
            LLMBenchmarkView(benchmarkId: item.id)

        case "torchao_micro_api_benchmark":
            TorchAOBenchmarkView(benchmarkId: item.id)

        default:
            BenchmarkDashboardView(
                benchmark: BenchmarkMetadata(
                    id: item.id,
                    name: item.name,
                    description: item.description,
                    suites: item.suites,
                    lastUpdated: nil
                )
            )
        }
    }
}

#Preview {
    BenchmarkListView()
}
