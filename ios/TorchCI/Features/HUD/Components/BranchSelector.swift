import SwiftUI

struct BranchSelector: View {
    let branches: [String]
    @Binding var selectedBranch: String

    var body: some View {
        Menu {
            ForEach(branches, id: \.self) { branch in
                Button {
                    selectedBranch = branch
                } label: {
                    HStack {
                        Text(branch)
                        if branch == selectedBranch {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption)
                Text(selectedBranch)
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
    BranchSelector(
        branches: HUDViewModel.branches,
        selectedBranch: .constant("main")
    )
}
