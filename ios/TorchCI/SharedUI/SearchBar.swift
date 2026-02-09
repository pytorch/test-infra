import SwiftUI

struct SearchBar: View {
    @Binding var text: String
    var placeholder: String = "Search..."
    var isRegexEnabled: Bool = false
    var onRegexToggle: (() -> Void)?
    var onSubmit: (() -> Void)?

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
                    .accessibilityHidden(true)

                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($isFocused)
                    .submitLabel(.search)
                    .onSubmit { onSubmit?() }

                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(10)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            if let onRegexToggle {
                Button {
                    onRegexToggle()
                } label: {
                    Text(".*")
                        .font(.system(.subheadline, design: .monospaced, weight: .bold))
                        .foregroundStyle(isRegexEnabled ? .white : .secondary)
                        .padding(8)
                        .background(isRegexEnabled ? Color.accentColor : Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}

#Preview {
    SearchBar(text: .constant("test query"), placeholder: "Search jobs...")
        .padding()
}
