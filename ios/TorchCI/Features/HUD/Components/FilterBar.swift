import SwiftUI

struct FilterBar: View {
    @ObservedObject var viewModel: HUDViewModel

    var body: some View {
        VStack(spacing: 12) {
            // Top row: Repo + Branch selectors
            HStack(spacing: 10) {
                RepoSelector(
                    repos: HUDViewModel.repos,
                    selectedRepo: Binding(
                        get: { viewModel.selectedRepo },
                        set: { viewModel.selectRepo($0) }
                    )
                )

                BranchSelector(
                    branches: HUDViewModel.branches,
                    selectedBranch: Binding(
                        get: { viewModel.selectedBranch },
                        set: { viewModel.selectBranch($0) }
                    )
                )

                Spacer()

                if viewModel.isLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            // Search bar with filter count
            VStack(spacing: 6) {
                SearchBar(
                    text: $viewModel.searchFilter,
                    placeholder: "Filter jobs by name...",
                    isRegexEnabled: viewModel.isRegexEnabled,
                    onRegexToggle: { viewModel.toggleRegex() },
                    onSubmit: nil
                )

                if !viewModel.searchFilter.isEmpty {
                    HStack(spacing: 8) {
                        HStack(spacing: 4) {
                            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(viewModel.filteredJobNames.count) of \(viewModel.hudData?.jobNames.count ?? 0) jobs")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.clearFilter()
                            }
                        } label: {
                            Text("Clear")
                                .font(.caption.weight(.medium))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground).opacity(0.5))
    }
}
