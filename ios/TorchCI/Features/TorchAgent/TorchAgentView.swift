import SwiftUI
import UIKit

struct TorchAgentView: View {
    @StateObject private var viewModel = TorchAgentViewModel()
    @State private var queryText = ""
    @State private var showHistory = false
    @State private var scrollProxy: ScrollViewProxy?
    @State private var showScrollToBottom = false
    @FocusState private var isInputFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                switch viewModel.state {
                case .idle, .checkingPermissions:
                    LoadingView(message: "Checking permissions...")

                case .unauthorized:
                    unauthorizedView

                case .error(let message):
                    permissionErrorView(message)

                case .ready:
                    readyContent
                }
            }
            .navigationTitle("PyTorch CI Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showHistory = true
                    } label: {
                        Image(systemName: "sidebar.left")
                    }
                    .disabled(viewModel.state != .ready)
                }

                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        Text("PyTorch CI Agent")
                            .font(.headline)

                        Text("BETA")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Color.orange)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        if !viewModel.messages.isEmpty {
                            Button {
                                viewModel.newChat()
                            } label: {
                                Image(systemName: "square.and.pencil")
                            }
                        }

                        Button {
                            Task { await viewModel.shareSession() }
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .disabled(viewModel.sessionId == nil)
                    }
                }
            }
            .sheet(isPresented: $showHistory) {
                ChatHistoryView(viewModel: viewModel, isPresented: $showHistory)
            }
            .alert("Session Shared", isPresented: $viewModel.showShareAlert) {
                if let url = viewModel.shareURL {
                    Button("Copy Link") {
                        UIPasteboard.general.string = url
                    }
                }
                Button("OK", role: .cancel) {}
            } message: {
                if let url = viewModel.shareURL {
                    Text("Share this link:\n\(url)")
                }
            }
            .alert("Share Failed", isPresented: $viewModel.showShareError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.shareErrorMessage)
            }
            .task {
                if viewModel.state == .idle {
                    await viewModel.checkPermissions()
                }
            }
        }
    }

    // MARK: - Unauthorized View

    private var unauthorizedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Access Required")
                .font(.headline)

            Text("You need to sign in with an authorized GitHub account to use the PyTorch CI Agent.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                Task { await viewModel.checkPermissions() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.body.weight(.medium))
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Permission Error View

    private func permissionErrorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Something went wrong")
                .font(.headline)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                Task { await viewModel.checkPermissions() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.body.weight(.medium))
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Ready Content

    private var readyContent: some View {
        VStack(spacing: 0) {
            if viewModel.messages.isEmpty && !viewModel.isStreaming {
                welcomeScreen
            } else {
                messagesScrollView
            }

            QueryInputBar(
                text: $queryText,
                isStreaming: viewModel.isStreaming,
                onSend: sendMessage,
                onCancel: { viewModel.cancelStream() }
            )
        }
    }

    // MARK: - Welcome Screen

    private var welcomeScreen: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer()
                    .frame(height: 40)

                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [Color.accentColor.opacity(0.15), Color.accentColor.opacity(0.05)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 100, height: 100)

                    Image(systemName: "cpu")
                        .font(.system(size: 48, weight: .semibold))
                        .foregroundStyle(.tint)
                }

                VStack(spacing: 10) {
                    Text("PyTorch CI Agent")
                        .font(.title.weight(.bold))

                    Text("Ask questions about CI status, failures, test results, and more.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                }

                VStack(spacing: 14) {
                    HStack {
                        Text("Try asking")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                            .tracking(0.5)

                        Spacer()
                    }

                    ForEach(examplePrompts, id: \.self) { prompt in
                        Button {
                            queryText = prompt
                            sendMessage()
                        } label: {
                            HStack(spacing: 12) {
                                Text(prompt)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .multilineTextAlignment(.leading)

                                Spacer()

                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 24))
                                    .foregroundStyle(.tint)
                            }
                            .padding(.horizontal, 18)
                            .padding(.vertical, 14)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14)
                                    .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)

                Spacer()
            }
        }
    }

    // MARK: - Messages

    private var messagesScrollView: some View {
        ZStack(alignment: .bottomTrailing) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 20) {
                        // Session info header when resuming a session
                        if viewModel.sessionId != nil && viewModel.messages.count > 2
                            && !viewModel.isStreaming {
                            sessionInfoHeader
                        }

                        ForEach(viewModel.messages) { message in
                            ChatMessageView(message: message)
                                .id(message.id)
                                .transition(.asymmetric(
                                    insertion: .opacity.combined(with: .move(edge: .bottom)),
                                    removal: .opacity
                                ))
                        }

                        if viewModel.isStreaming {
                            streamingSection
                                .id("streaming")
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        // Feedback bar shown after the last assistant message when not streaming
                        if !viewModel.isStreaming, viewModel.sessionId != nil,
                           let lastMessage = viewModel.messages.last,
                           lastMessage.role == .assistant {
                            feedbackBar
                                .transition(.opacity)
                        }

                        // Invisible anchor for scrolling
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 20)
                    .animation(.easeInOut(duration: 0.3), value: viewModel.messages.count)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear {
                    scrollProxy = proxy
                }
                .onChange(of: viewModel.messages.count) {
                    scrollToBottom(proxy: proxy)
                    showScrollToBottom = false
                }
                .onChange(of: viewModel.streamingContent) {
                    scrollToBottom(proxy: proxy)
                }
            }

            // Scroll-to-bottom floating button
            if showScrollToBottom {
                Button {
                    if let proxy = scrollProxy {
                        scrollToBottom(proxy: proxy)
                    }
                    showScrollToBottom = false
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial)
                        .clipShape(Circle())
                        .shadow(color: Color.black.opacity(0.15), radius: 4, x: 0, y: 2)
                }
                .padding(.trailing, 16)
                .padding(.bottom, 8)
                .transition(.scale.combined(with: .opacity))
            }
        }
    }

    private var sessionInfoHeader: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(Color(.separator).opacity(0.3))
                .frame(height: 1)

            Text("\(viewModel.messages.count) messages")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .layoutPriority(1)

            Rectangle()
                .fill(Color(.separator).opacity(0.3))
                .frame(height: 1)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 4)
    }

    private var streamingSection: some View {
        HStack(alignment: .top, spacing: 8) {
            // Assistant avatar for streaming
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

            VStack(alignment: .leading, spacing: 12) {
                // Show tool uses in progress
                ForEach(viewModel.currentToolUses) { toolUse in
                    ToolUseView(toolUse: toolUse)
                }

                // Show streaming text if any
                if !viewModel.streamingContent.isEmpty {
                    InlineStreamingText(text: viewModel.streamingContent)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(ChatBubbleShape(isUser: false))
                        .shadow(color: Color.black.opacity(0.08), radius: 2, x: 0, y: 1)
                }

                // Streaming indicator
                StreamingIndicator(
                    elapsedTime: viewModel.elapsedTime,
                    tokenCount: viewModel.tokenCount,
                    thinkingContent: viewModel.streamingThinking,
                    toolCount: viewModel.currentToolUses.count,
                    hasContent: !viewModel.streamingContent.isEmpty
                )
            }
        }
    }

    // MARK: - Feedback Bar

    private var feedbackBar: some View {
        VStack(spacing: 0) {
            Divider()
                .padding(.horizontal, 20)
                .padding(.bottom, 10)

            HStack(spacing: 14) {
                Text("Was this helpful?")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
                    feedbackButton(
                        rating: 1,
                        icon: "hand.thumbsup",
                        filledIcon: "hand.thumbsup.fill",
                        activeColor: Color.accentColor
                    )

                    feedbackButton(
                        rating: -1,
                        icon: "hand.thumbsdown",
                        filledIcon: "hand.thumbsdown.fill",
                        activeColor: Color.red
                    )
                }

                Spacer()
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 40)
        }
    }

    private func feedbackButton(
        rating: Int,
        icon: String,
        filledIcon: String,
        activeColor: Color
    ) -> some View {
        let isSelected = viewModel.feedbackSubmitted == rating

        return Button {
            Task { await viewModel.submitFeedback(rating) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isSelected ? filledIcon : icon)
                    .font(.callout)
                if isSelected {
                    Text("Thanks!")
                        .font(.caption.weight(.medium))
                }
            }
            .foregroundStyle(isSelected ? activeColor : .secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                isSelected ? activeColor.opacity(0.12) : Color(.tertiarySystemFill)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .disabled(viewModel.feedbackSubmitted != nil)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: viewModel.feedbackSubmitted)
    }

    // MARK: - Actions

    private func sendMessage() {
        let query = queryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        queryText = ""
        viewModel.sendQuery(query)
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    // MARK: - Data

    private var examplePrompts: [String] {
        [
            "What are the current CI failures on main?",
            "Show me the flakiest tests this week",
            "Why is the linux-focal-cuda12.1 job failing?",
            "What's the CI status for the latest commit on main?",
        ]
    }
}

#Preview {
    TorchAgentView()
}
