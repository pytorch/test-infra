import SwiftUI

struct QueryInputBar: View {
    @Binding var text: String
    let isStreaming: Bool
    let onSend: () -> Void
    let onCancel: () -> Void

    @FocusState private var isFocused: Bool
    @State private var textHeight: CGFloat = 36

    var body: some View {
        VStack(spacing: 0) {
            Divider()
                .background(Color(.separator).opacity(0.5))

            HStack(alignment: .bottom, spacing: 10) {
                // Clear button (only when text is present and not streaming)
                if !text.isEmpty && !isStreaming {
                    Button(action: clearText) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(.secondary)
                    }
                    .transition(.scale.combined(with: .opacity))
                }

                // Text input
                textEditor

                // Action button
                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    // MARK: - Text Editor

    @ViewBuilder
    private var textEditor: some View {
        ZStack(alignment: .topLeading) {
            // Placeholder
            if text.isEmpty {
                Text("Ask about CI status, failures, tests...")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .allowsHitTesting(false)
            }

            // Expandable text field
            TextField("", text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...8)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .overlay(
                    RoundedRectangle(cornerRadius: 22)
                        .strokeBorder(
                            isFocused ? Color.accentColor.opacity(0.6) : Color(.separator).opacity(0.2),
                            lineWidth: isFocused ? 1.5 : 1
                        )
                )
                .focused($isFocused)
                .disabled(isStreaming)
                .onSubmit {
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming {
                        onSend()
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: isFocused)
        }
    }

    // MARK: - Helpers

    private func clearText() {
        text = ""
        isFocused = true
    }

    // MARK: - Action Button

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            Button(action: onCancel) {
                ZStack {
                    Circle()
                        .fill(Color.red.opacity(0.15))
                        .frame(width: 34, height: 34)

                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.red)
                }
            }
            .transition(.scale.combined(with: .opacity))
        } else {
            Button(action: onSend) {
                ZStack {
                    Circle()
                        .fill(canSend ? Color.accentColor : Color(.quaternaryLabel))
                        .frame(width: 34, height: 34)

                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .disabled(!canSend)
            .scaleEffect(canSend ? 1.0 : 0.92)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: canSend)
            .transition(.scale.combined(with: .opacity))
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming
    }
}

#Preview {
    VStack {
        Spacer()
        QueryInputBar(
            text: .constant(""),
            isStreaming: false,
            onSend: {},
            onCancel: {}
        )
    }
}
