import SwiftUI

struct ChatMessageView: View {
    let message: TorchAgentMessage

    @State private var isThinkingExpanded = false
    @State private var showCopied = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var isUser: Bool { message.role == .user }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !isUser {
                assistantAvatar
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                // Thinking content (assistant only)
                if let thinking = message.thinkingContent, !thinking.isEmpty {
                    thinkingSection(thinking)
                }

                // Tool use blocks (assistant only)
                if !message.toolUses.isEmpty {
                    toolUsesSection
                }

                // Message content
                if !message.content.isEmpty {
                    MessageBubble(content: message.content, isUser: isUser)
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = message.content
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    showCopied = true
                                }
                                Task {
                                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                                    withAnimation { showCopied = false }
                                }
                            } label: {
                                Label("Copy Message", systemImage: "doc.on.doc")
                            }
                        }
                }

                // Timestamp and copied indicator
                HStack(spacing: 6) {
                    if showCopied {
                        Label("Copied", systemImage: "checkmark")
                            .font(.caption2)
                            .foregroundStyle(AppColors.success)
                            .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }

                    Text(Self.formatTimestamp(message.timestamp))
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }
                .padding(.horizontal, isUser ? 6 : 4)
            }

            if isUser {
                userAvatar
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    // MARK: - Avatars

    private var assistantAvatar: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.2), Color.accentColor.opacity(0.1)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 28, height: 28)

            Image(systemName: "cpu")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.accentColor)
        }
        .padding(.top, 4)
    }

    private var userAvatar: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor)
                .frame(width: 28, height: 28)

            Image(systemName: "person.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.top, 4)
    }

    // MARK: - Thinking Section

    private func thinkingSection(_ thinking: String) -> some View {
        DisclosureGroup(isExpanded: $isThinkingExpanded) {
            Text(thinking)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(12)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.top, 6)
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(Color.purple.opacity(0.15))
                        .frame(width: 24, height: 24)

                    Image(systemName: "brain")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.purple)
                }

                Text("Thinking")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                if !isThinkingExpanded {
                    Text("\(thinking.prefix(40))...")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 1)
        )
        .tint(.secondary)
    }

    // MARK: - Tool Uses

    private var toolUsesSection: some View {
        VStack(spacing: 8) {
            ForEach(message.toolUses) { toolUse in
                ToolUseView(toolUse: toolUse)
            }
        }
    }

    // MARK: - Timestamp Formatting

    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter
    }()

    static func formatTimestamp(_ date: Date) -> String {
        timestampFormatter.string(from: date)
    }
}

#Preview {
    ScrollView {
        VStack(spacing: 20) {
            ChatMessageView(
                message: TorchAgentMessage(
                    role: .user,
                    content: "What are the current CI failures on main?",
                    toolUses: [],
                    thinkingContent: nil,
                    timestamp: Date()
                )
            )

            ChatMessageView(
                message: TorchAgentMessage(
                    role: .assistant,
                    content: "I found **3 failures** on the main branch. Let me break them down for you.\n\nHere are the details of the failing jobs:",
                    toolUses: [
                        ToolUseBlock(
                            toolName: "clickhouse_query",
                            input: "SELECT * FROM failures WHERE branch = 'main' ORDER BY created_at DESC LIMIT 10",
                            output: "3 rows returned",
                            isExpanded: false
                        )
                    ],
                    thinkingContent: "Let me analyze the CI data to find recent failures on the main branch...",
                    timestamp: Date()
                )
            )

            ChatMessageView(
                message: TorchAgentMessage(
                    role: .user,
                    content: "Can you show more details about the CUDA failures?",
                    toolUses: [],
                    thinkingContent: nil,
                    timestamp: Date()
                )
            )

            ChatMessageView(
                message: TorchAgentMessage(
                    role: .assistant,
                    content: "The CUDA test failures are primarily in `test_cuda.py` and `test_nn.py`. These appear to be related to a recent commit that changed memory allocation.",
                    toolUses: [],
                    thinkingContent: nil,
                    timestamp: Date()
                )
            )
        }
        .padding()
    }
}
