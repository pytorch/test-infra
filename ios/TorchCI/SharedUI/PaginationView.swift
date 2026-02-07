import SwiftUI

struct PaginationView: View {
    @Binding var currentPage: Int
    let totalPages: Int?
    var onPageChange: ((Int) -> Void)?

    var body: some View {
        HStack(spacing: 16) {
            Button {
                if currentPage > 1 {
                    currentPage -= 1
                    onPageChange?(currentPage)
                }
            } label: {
                Image(systemName: "chevron.left")
            }
            .disabled(currentPage <= 1)

            if let totalPages {
                Text("Page \(currentPage) of \(totalPages)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text("Page \(currentPage)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Button {
                if let totalPages, currentPage >= totalPages {
                    return
                }
                currentPage += 1
                onPageChange?(currentPage)
            } label: {
                Image(systemName: "chevron.right")
            }
            .disabled(totalPages.map { currentPage >= $0 } ?? false)
        }
        .padding(.vertical, 8)
    }
}

#Preview {
    PaginationView(currentPage: .constant(3), totalPages: 10)
}
