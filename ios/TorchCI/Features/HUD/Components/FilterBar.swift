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

                // Quick filter toggles
                HStack(spacing: 8) {
                    filterChip(
                        label: "Failures Only",
                        icon: "xmark.circle",
                        isActive: viewModel.showFailuresOnly
                    ) {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.showFailuresOnly.toggle()
                        }
                    }

                    filterChip(
                        label: "Hide Unstable",
                        icon: "eye.slash",
                        isActive: viewModel.hideUnstable
                    ) {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.hideUnstable.toggle()
                        }
                    }

                    Spacer()
                }

                if hasActiveFilters {
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
                                viewModel.showFailuresOnly = false
                                viewModel.hideUnstable = false
                            }
                        } label: {
                            Text("Clear All")
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

    private var hasActiveFilters: Bool {
        !viewModel.searchFilter.isEmpty || viewModel.showFailuresOnly || viewModel.hideUnstable
    }

    private func filterChip(label: String, icon: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: isActive ? "\(icon).fill" : icon)
                    .font(.caption2)
                Text(label)
                    .font(.caption2.weight(.medium))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(isActive ? Color.accentColor.opacity(0.15) : Color(.tertiarySystemBackground))
            .foregroundStyle(isActive ? Color.accentColor : .secondary)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .strokeBorder(isActive ? Color.accentColor.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
    }
}
