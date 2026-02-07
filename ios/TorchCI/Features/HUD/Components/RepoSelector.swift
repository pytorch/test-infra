import SwiftUI

struct RepoSelector: View {
    let repos: [RepoConfig]
    @Binding var selectedRepo: RepoConfig

    var body: some View {
        Menu {
            ForEach(repos) { repo in
                Button {
                    selectedRepo = repo
                } label: {
                    HStack {
                        Text(repo.displayName)
                        if repo.id == selectedRepo.id {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.caption)
                Text(selectedRepo.name)
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
    }
}

#Preview {
    RepoSelector(
        repos: HUDViewModel.repos,
        selectedRepo: .constant(HUDViewModel.repos[0])
    )
}
