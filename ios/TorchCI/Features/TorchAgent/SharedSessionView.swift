import SwiftUI
import UIKit

struct SharedSessionView: View {
    let uuid: String

    @State private var session: SharedSession?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var linkCopied = false

    var apiClient: APIClientProtocol = APIClient.shared

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    LoadingView(message: "Loading shared session...")
                } else if let errorMessage {
                    errorView(errorMessage)
                } else if let session {
                    sharedContent(session)
                }
            }
            .navigationTitle("Shared Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if session != nil {
                        Button {
                            copyShareLink()
                        } label: {
                            Image(systemName: linkCopied ? "checkmark" : "doc.on.doc")
                                .font(.subheadline)
                                .foregroundStyle(linkCopied ? AppColors.success : Color.accentColor)
                        }
                        .animation(.easeInOut(duration: 0.2), value: linkCopied)
                    }
                }
            }
        }
        .task {
            await fetchSharedSession()
        }
    }

    // MARK: - Shared Content

    private func sharedContent(_ session: SharedSession) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    // Header
                    sharedHeader(session)
                        .padding(.top, 12)
                        .padding(.bottom, 12)

                    // Message count badge
                    if let messages = session.messages, !messages.isEmpty {
                        messageCountBadge(messages.count)
                            .padding(.bottom, 8)
                    }

                    Divider()
                        .padding(.horizontal, 16)

                    // Messages
                    if let messages = session.messages, !messages.isEmpty {
                        LazyVStack(spacing: 20) {
                            ForEach(messages) { message in
                                sharedMessageView(message)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 16)
                    } else {
                        EmptyStateView(
                            icon: "bubble.left",
                            title: "No Messages",
                            message: "This shared session does not contain any messages."
                        )
                        .padding(.top, 32)
                    }
                }
                .padding(.bottom, 16)
            }

            // Bottom action bar
            bottomActionBar
        }
    }

    // MARK: - Header

    private func sharedHeader(_ session: SharedSession) -> some View {
        VStack(spacing: 10) {
            // Agent icon
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color.accentColor.opacity(0.15), Color.accentColor.opacity(0.05)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 52, height: 52)

                Image(systemName: "cpu")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }

            if let title = session.title {
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }

            // Shared by / date metadata
            VStack(spacing: 2) {
                if let sharedBy = session.sharedBy {
                    HStack(spacing: 4) {
                        Image(systemName: "person.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Text("Shared by \(sharedBy)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }

                if let sharedAt = session.sharedAt {
                    Text(formattedDate(sharedAt))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
    }

    // MARK: - Message Count Badge

    private func messageCountBadge(_ count: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.caption2.weight(.medium))
            Text("\(count) message\(count == 1 ? "" : "s")")
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.tertiarySystemBackground))
        .clipShape(Capsule())
    }

    // MARK: - Shared Message

    private func sharedMessageView(_ message: SharedMessage) -> some View {
        let isUser = message.role == "user"

        return VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            // Role label
            HStack(spacing: 4) {
                Image(systemName: isUser ? "person.fill" : "cpu")
                    .font(.caption2.weight(.semibold))
                Text(isUser ? "User" : "Assistant")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.tertiary)
            .padding(.horizontal, isUser ? 6 : 10)

            // Tool uses
            if let toolUses = message.toolUses, !toolUses.isEmpty {
                VStack(spacing: 8) {
                    ForEach(toolUses) { tool in
                        ToolUseView(toolUse: ToolUseBlock(
                            toolName: tool.name ?? "tool",
                            input: tool.input ?? "",
                            output: tool.output,
                            isExpanded: false
                        ))
                    }
                }
            }

            // Content
            if let content = message.content, !content.isEmpty {
                if isUser {
                    MessageBubble(content: content, isUser: true)
                } else {
                    HStack(alignment: .top, spacing: 0) {
                        Text(markdownString(content))
                            .font(.body)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(ChatBubbleShape(isUser: false))
                            .shadow(color: Color.black.opacity(0.06), radius: 2, x: 0, y: 1)

                        Spacer(minLength: 40)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    // MARK: - Bottom Action Bar

    private var bottomActionBar: some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 12) {
                // Copy link button
                Button {
                    copyShareLink()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: linkCopied ? "checkmark" : "link")
                            .font(.subheadline.weight(.medium))
                        Text(linkCopied ? "Copied" : "Copy Link")
                            .font(.subheadline.weight(.medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(linkCopied ? AppColors.success : nil)
                .animation(.easeInOut(duration: 0.2), value: linkCopied)

                // Open in TorchAgent button
                Button {
                    UIPasteboard.general.string = shareURL
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "cpu")
                            .font(.subheadline.weight(.medium))
                        Text("Open in Agent")
                            .font(.subheadline.weight(.medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    // MARK: - Error View

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Could not load session")
                .font(.headline)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Button {
                Task { await fetchSharedSession() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.body.weight(.medium))
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Helpers

    var shareURL: String {
        "https://hud.pytorch.org/torchagent/shared/\(uuid)"
    }

    func fetchSharedSession() async {
        isLoading = true
        errorMessage = nil

        let client = apiClient
        do {
            let loaded: SharedSession = try await client.fetch(
                .torchAgentShared(uuid: uuid)
            )
            session = loaded
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func copyShareLink() {
        UIPasteboard.general.string = shareURL
        linkCopied = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            linkCopied = false
        }
    }

    static func formattedDate(_ dateString: String) -> String {
        if let date = ISO8601DateFormatter().date(from: dateString) {
            let now = Date()
            let interval = now.timeIntervalSince(date)

            // Show relative time for recent dates (less than 7 days)
            if interval < 7 * 24 * 3600 && interval > 0 {
                let formatter = RelativeDateTimeFormatter()
                formatter.unitsStyle = .short
                return formatter.localizedString(for: date, relativeTo: now)
            }

            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
        return dateString
    }

    // Instance method that delegates to static
    private func formattedDate(_ dateString: String) -> String {
        Self.formattedDate(dateString)
    }

    static func markdownString(_ content: String) -> AttributedString {
        (try? AttributedString(markdown: content, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(content)
    }

    // Instance method that delegates to static
    private func markdownString(_ content: String) -> AttributedString {
        Self.markdownString(content)
    }

    static func messageCountText(_ count: Int) -> String {
        "\(count) message\(count == 1 ? "" : "s")"
    }
}

#Preview {
    SharedSessionView(uuid: "test-uuid-123")
}
