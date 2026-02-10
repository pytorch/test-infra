import SwiftUI
import UIKit

struct ErrorView: View {
    let error: Error
    var retryAction: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Something went wrong")
                .font(.headline)

            Text(error.localizedDescription)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
                .textSelection(.enabled)

            HStack(spacing: 12) {
                if let retryAction {
                    Button(action: retryAction) {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(.body.weight(.medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Retry loading data")
                }

                Button {
                    UIPasteboard.general.string = error.localizedDescription
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Label("Copy Error", systemImage: "doc.on.doc")
                        .font(.body.weight(.medium))
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

struct InlineErrorView: View {
    let message: String
    var retryAction: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let retryAction {
                Button("Retry", action: retryAction)
                    .font(.caption)
                    .accessibilityLabel("Retry loading")
            }
        }
        .padding(8)
        .background(Color.red.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }
}
