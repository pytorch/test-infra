import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject var authManager: AuthManager
    @EnvironmentObject var deepLinkHandler: DeepLinkHandler
    @StateObject private var hudViewModel = HUDViewModel()
    @State private var selectedTab: AppTab = .hud

    // Deep link navigation state for the HUD tab.
    @State private var hudDeepLink: DeepLink?
    @State private var hudNavigationPath = NavigationPath()

    // Deep link navigation state for the TorchAgent tab (flambeau sessions).
    @State private var torchAgentNavigationPath = NavigationPath()

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $hudNavigationPath) {
                HUDView(viewModel: hudViewModel, navigationPath: $hudNavigationPath)
                    .navigationDestination(for: DeepLinkCommitDestination.self) { dest in
                        CommitDetailView(
                            sha: dest.sha,
                            repoOwner: dest.repoOwner,
                            repoName: dest.repoName
                        )
                    }
                    .navigationDestination(for: DeepLinkPRDestination.self) { dest in
                        PRDetailView(
                            prNumber: dest.number,
                            repoOwner: dest.repoOwner,
                            repoName: dest.repoName
                        )
                    }
            }
            .tabItem {
                Label("HUD", systemImage: "square.grid.3x3")
            }
            .badge(hudViewModel.hasData ? hudViewModel.jobHealthStats.blockingFailureCount : 0)
            .tag(AppTab.hud)

            NavigationStack {
                MetricsDashboardView()
            }
            .tabItem {
                Label("Metrics", systemImage: "chart.xyaxis.line")
            }
            .tag(AppTab.metrics)

            NavigationStack {
                BenchmarkListView()
            }
            .tabItem {
                Label("Benchmarks", systemImage: "gauge.with.dots.needle.33percent")
            }
            .tag(AppTab.benchmarks)

            NavigationStack {
                TestSearchView()
            }
            .tabItem {
                Label("Tests", systemImage: "testtube.2")
            }
            .tag(AppTab.tests)

            NavigationStack {
                DevInfraTabView()
            }
            .tabItem {
                Label("DevInfra", systemImage: "server.rack")
            }
            .tag(AppTab.devInfra)

            NavigationStack(path: $torchAgentNavigationPath) {
                TorchAgentContainerView()
                    .navigationDestination(for: DeepLinkFlambeauDestination.self) { dest in
                        SharedTorchAgentView(uuid: dest.uuid)
                    }
            }
            .tabItem {
                Label("Agent", systemImage: "cpu")
            }
            .tag(AppTab.torchAgent)

            NavigationStack {
                SettingsView()
            }
            .tabItem {
                Label("Settings", systemImage: "gear")
            }
            .tag(AppTab.settings)
        }
        .onChange(of: deepLinkHandler.pendingDeepLink) { _, link in
            if let link {
                handleDeepLink(link)
            }
        }
        // iPad keyboard shortcuts: ⌘1-⌘7 for tab switching
        .background {
            Group {
                Button("") { selectedTab = .hud }
                    .keyboardShortcut("1", modifiers: .command)
                Button("") { selectedTab = .metrics }
                    .keyboardShortcut("2", modifiers: .command)
                Button("") { selectedTab = .benchmarks }
                    .keyboardShortcut("3", modifiers: .command)
                Button("") { selectedTab = .tests }
                    .keyboardShortcut("4", modifiers: .command)
                Button("") { selectedTab = .devInfra }
                    .keyboardShortcut("5", modifiers: .command)
                Button("") { selectedTab = .torchAgent }
                    .keyboardShortcut("6", modifiers: .command)
                Button("") { selectedTab = .settings }
                    .keyboardShortcut("7", modifiers: .command)
            }
            .frame(width: 0, height: 0)
            .opacity(0)
        }
    }

    // MARK: - Deep Link Navigation

    private func handleDeepLink(_ link: DeepLink) {
        // OAuth callbacks are handled by AuthManager, not by navigation.
        if case .oauthCallback = link {
            deepLinkHandler.pendingDeepLink = nil
            return
        }

        // Switch to the correct tab.
        withAnimation(.easeInOut(duration: 0.25)) {
            selectedTab = link.targetTab
        }

        // Delay slightly to let the tab switch animation complete before pushing.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            navigateToDestination(link)
            // Clear after handling.
            deepLinkHandler.pendingDeepLink = nil
        }
    }

    private func navigateToDestination(_ link: DeepLink) {
        switch link {
        case let .hud(repoOwner, repoName, branch):
            // Pop to root, then post a notification so HUDView can switch repo/branch.
            hudNavigationPath = NavigationPath()
            NotificationCenter.default.post(
                name: .hudDeepLinkRepoSwitch,
                object: nil,
                userInfo: [
                    "repoOwner": repoOwner,
                    "repoName": repoName,
                    "branch": branch,
                ]
            )

        case let .commit(repoOwner, repoName, sha):
            // Pop to root, then push CommitDetailView.
            hudNavigationPath = NavigationPath()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                hudNavigationPath.append(DeepLinkCommitDestination(
                    repoOwner: repoOwner,
                    repoName: repoName,
                    sha: sha
                ))
            }

        case let .pr(repoOwner, repoName, number):
            // Pop to root, then push PRDetailView.
            hudNavigationPath = NavigationPath()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                hudNavigationPath.append(DeepLinkPRDestination(
                    repoOwner: repoOwner,
                    repoName: repoName,
                    number: number
                ))
            }

        case let .flambeau(uuid):
            // Navigate to the shared TorchAgent session in the TorchAgent tab.
            torchAgentNavigationPath = NavigationPath()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                torchAgentNavigationPath.append(DeepLinkFlambeauDestination(uuid: uuid))
            }

        case .metrics, .tests, .benchmarks, .devInfra, .torchAgent, .settings:
            // Tab switch was already handled; no further navigation needed.
            break

        case .oauthCallback:
            break
        }
    }
}

// MARK: - App Tabs

enum AppTab: Hashable {
    case hud
    case metrics
    case benchmarks
    case tests
    case devInfra
    case torchAgent
    case settings
}

// MARK: - Deep Link Navigation Destinations

/// Hashable destination for programmatic NavigationStack pushes to commit detail.
struct DeepLinkCommitDestination: Hashable {
    let repoOwner: String
    let repoName: String
    let sha: String
}

/// Hashable destination for programmatic NavigationStack pushes to PR detail.
struct DeepLinkPRDestination: Hashable {
    let repoOwner: String
    let repoName: String
    let number: Int
}

/// Hashable destination for programmatic NavigationStack pushes to shared TorchAgent sessions.
struct DeepLinkFlambeauDestination: Hashable {
    let uuid: String
}

// MARK: - Notification Names for Deep Link Coordination

extension Notification.Name {
    /// Posted when a deep link requests switching the HUD to a specific repo/branch.
    /// userInfo keys: "repoOwner" (String), "repoName" (String), "branch" (String).
    static let hudDeepLinkRepoSwitch = Notification.Name("com.pytorch.torchci.hudDeepLinkRepoSwitch")
}

// MARK: - TorchAgent Container View

/// Embeds the TorchAgent chat UI without its own NavigationStack, so the tab-level
/// NavigationStack can manage both the root agent view and deep-link destinations
/// (e.g. shared sessions) without nesting stacks.
struct TorchAgentContainerView: View {
    @StateObject private var viewModel = TorchAgentViewModel()
    @State private var queryText = ""
    @State private var showHistory = false
    @State private var scrollProxy: ScrollViewProxy?

    var body: some View {
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
                Button {
                    Task { await viewModel.shareSession() }
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(viewModel.sessionId == nil)
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
            VStack(spacing: 24) {
                Spacer()
                    .frame(height: 40)

                Image(systemName: "cpu")
                    .font(.system(size: 56))
                    .foregroundStyle(.tint)

                VStack(spacing: 8) {
                    Text("PyTorch CI Agent")
                        .font(.title.weight(.bold))

                    Text("Ask questions about CI status, failures, test results, and more.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                VStack(spacing: 12) {
                    Text("Try asking")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.tertiary)
                        .textCase(.uppercase)

                    ForEach(examplePrompts, id: \.self) { prompt in
                        Button {
                            queryText = prompt
                            sendMessage()
                        } label: {
                            HStack {
                                Text(prompt)
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                    .multilineTextAlignment(.leading)

                                Spacer()

                                Image(systemName: "arrow.up.circle.fill")
                                    .foregroundStyle(.tint)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
                .padding(.horizontal, 20)

                Spacer()
            }
        }
    }

    // MARK: - Messages

    private var messagesScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
                    ForEach(viewModel.messages) { message in
                        ChatMessageView(message: message)
                            .id(message.id)
                    }

                    if viewModel.isStreaming {
                        streamingSection
                            .id("streaming")
                    }

                    // Feedback bar shown after the last assistant message when not streaming
                    if !viewModel.isStreaming, viewModel.sessionId != nil,
                       let lastMessage = viewModel.messages.last,
                       lastMessage.role == .assistant {
                        feedbackBar
                    }

                    // Invisible anchor for scrolling
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onAppear {
                scrollProxy = proxy
            }
            .onChange(of: viewModel.messages.count) {
                scrollToBottom(proxy: proxy)
            }
            .onChange(of: viewModel.streamingContent) {
                scrollToBottom(proxy: proxy)
            }
        }
    }

    private var streamingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(viewModel.currentToolUses) { toolUse in
                ToolUseView(toolUse: toolUse)
            }

            if !viewModel.streamingContent.isEmpty {
                HStack {
                    InlineStreamingText(text: viewModel.streamingContent)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(ChatBubbleShape(isUser: false))

                    Spacer(minLength: 60)
                }
            }

            StreamingIndicator(
                elapsedTime: viewModel.elapsedTime,
                tokenCount: viewModel.tokenCount,
                thinkingContent: viewModel.streamingThinking
            )
        }
    }

    // MARK: - Feedback Bar

    private var feedbackBar: some View {
        HStack(spacing: 16) {
            Text("Was this helpful?")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                Button {
                    Task { await viewModel.submitFeedback(1) }
                } label: {
                    Image(systemName: viewModel.feedbackSubmitted == 1
                          ? "hand.thumbsup.fill" : "hand.thumbsup")
                        .font(.body)
                        .foregroundStyle(viewModel.feedbackSubmitted == 1
                                         ? Color.accentColor : .secondary)
                }
                .disabled(viewModel.feedbackSubmitted != nil)

                Button {
                    Task { await viewModel.submitFeedback(-1) }
                } label: {
                    Image(systemName: viewModel.feedbackSubmitted == -1
                          ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                        .font(.body)
                        .foregroundStyle(viewModel.feedbackSubmitted == -1
                                         ? Color.red : .secondary)
                }
                .disabled(viewModel.feedbackSubmitted != nil)
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
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

// MARK: - DevInfra Tab View

/// Root view for the DevInfra tab, providing navigation to all infrastructure tools.
struct DevInfraTabView: View {
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Text("DevInfra Dashboard")
                        .font(.headline)
                    Text("Monitor CI infrastructure health, performance metrics, and resource utilization")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            Section {
                NavigationLink(destination: FailureAnalysisView()) {
                    DevInfraRow(
                        icon: "exclamationmark.triangle.fill",
                        iconColor: AppColors.failure,
                        title: "Failure Analysis",
                        subtitle: "Search and analyze CI job failures across repositories",
                        showIndicator: false
                    )
                }
                NavigationLink(destination: FailedJobsView()) {
                    DevInfraRow(
                        icon: "tag.fill",
                        iconColor: AppColors.unstable,
                        title: "Failed Jobs Classifier",
                        subtitle: "Categorize and track recurring job failures",
                        showIndicator: false
                    )
                }
            } header: {
                Text("Failure Analysis")
                    .font(.subheadline.weight(.semibold))
            } footer: {
                Text("Tools for investigating and categorizing CI failures")
                    .font(.caption2)
            }

            Section {
                NavigationLink(destination: RunnersView()) {
                    DevInfraRow(
                        icon: "server.rack",
                        iconColor: AppColors.success,
                        title: "Runners",
                        subtitle: "Monitor GitHub Actions runner status and availability",
                        badge: "Live",
                        badgeColor: AppColors.success
                    )
                }
                NavigationLink(destination: UtilizationView()) {
                    DevInfraRow(
                        icon: "cpu.fill",
                        iconColor: Color.purple,
                        title: "Utilization",
                        subtitle: "Track CPU and resource usage across runner groups",
                        showIndicator: false
                    )
                }
                NavigationLink(destination: NightliesView()) {
                    DevInfraRow(
                        icon: "moon.stars.fill",
                        iconColor: Color.indigo,
                        title: "Nightlies",
                        subtitle: "View nightly build status and test results",
                        showIndicator: false
                    )
                }
            } header: {
                Text("Infrastructure")
                    .font(.subheadline.weight(.semibold))
            } footer: {
                Text("Real-time infrastructure monitoring and resource management")
                    .font(.caption2)
            }

            Section {
                NavigationLink(destination: QueueTimeView()) {
                    DevInfraRow(
                        icon: "clock.arrow.circlepath",
                        iconColor: Color.blue,
                        title: "Queue Time Analysis",
                        subtitle: "Measure job queue wait times and bottlenecks",
                        showIndicator: false
                    )
                }
                NavigationLink(destination: BuildTimeView()) {
                    DevInfraRow(
                        icon: "hammer.fill",
                        iconColor: Color.orange,
                        title: "Build Time Metrics",
                        subtitle: "Analyze build duration trends and performance",
                        showIndicator: false
                    )
                }
                NavigationLink(destination: JobCancellationView()) {
                    DevInfraRow(
                        icon: "xmark.circle.fill",
                        iconColor: AppColors.cancelled,
                        title: "Job Cancellations",
                        subtitle: "Track cancelled jobs and identify patterns",
                        showIndicator: false
                    )
                }
            } header: {
                Text("Performance Metrics")
                    .font(.subheadline.weight(.semibold))
            } footer: {
                Text("Analyze CI pipeline performance and efficiency")
                    .font(.caption2)
            }

            Section {
                NavigationLink(destination: CostAnalysisView()) {
                    DevInfraRow(
                        icon: "dollarsign.circle.fill",
                        iconColor: Color.green,
                        title: "Cost Analysis",
                        subtitle: "Monitor CI infrastructure spending and usage costs",
                        showIndicator: false
                    )
                }
                NavigationLink(destination: ClaudeBillingView()) {
                    DevInfraRow(
                        icon: "brain.filled.head.profile",
                        iconColor: Color.purple,
                        title: "Claude Billing",
                        subtitle: "Track Claude AI API usage and associated costs",
                        showIndicator: false
                    )
                }
            } header: {
                Text("Cost Management")
                    .font(.subheadline.weight(.semibold))
            } footer: {
                Text("Track and optimize infrastructure and AI service spending")
                    .font(.caption2)
            }
        }
        .navigationTitle("Dev Infra")
    }
}

// MARK: - DevInfra Row Component
private struct DevInfraRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    var badge: String? = nil
    var badgeColor: Color? = nil
    var showIndicator: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(iconColor.opacity(0.15))
                    .frame(width: 40, height: 40)
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .foregroundStyle(iconColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title)
                        .font(.subheadline.weight(.medium))

                    if showIndicator {
                        Circle()
                            .fill(AppColors.failure)
                            .frame(width: 6, height: 6)
                    }

                    if let badge, let badgeColor {
                        Text(badge)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(badgeColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(badgeColor.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Shared TorchAgent Session View (for flambeau deep links)

/// Displays a shared TorchAgent session loaded by UUID.
/// This is the destination for `torchci://flambeau/{uuid}` deep links.
struct SharedTorchAgentView: View {
    let uuid: String

    @State private var session: SharedSession?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showCopiedConfirmation = false

    private let apiClient: APIClientProtocol = APIClient.shared

    var body: some View {
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
                shareButton
            }
        }
        .task {
            await loadSharedSession()
        }
    }

    // MARK: - Shared Content

    private func sharedContent(_ session: SharedSession) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 16) {
                    // Session metadata header
                    sessionHeader(session)
                        .padding(.top, 8)

                    Divider()
                        .padding(.horizontal)

                    // Messages
                    if let messages = session.messages, !messages.isEmpty {
                        LazyVStack(spacing: 16) {
                            ForEach(messages) { message in
                                sharedMessageView(message)
                            }
                        }
                        .padding(.horizontal, 12)
                    } else {
                        emptyMessagesView
                    }
                }
                .padding(.bottom, 16)
            }

            // Read-only banner
            readOnlyBanner
        }
    }

    // MARK: - Session Header

    private func sessionHeader(_ session: SharedSession) -> some View {
        VStack(spacing: 8) {
            // Title
            if let title = session.title, !title.isEmpty {
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
            } else {
                Text("Shared Conversation")
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }

            // Metadata row
            HStack(spacing: 12) {
                // Shared by
                if let sharedBy = session.sharedBy {
                    Label {
                        Text(sharedBy)
                    } icon: {
                        Image(systemName: "person.circle")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }

                if session.sharedBy != nil && session.sharedAt != nil {
                    Text("•")
                        .font(.subheadline)
                        .foregroundStyle(.quaternary)
                }

                // Date shared
                if let sharedAt = session.sharedAt {
                    Label {
                        Text(formattedDate(sharedAt))
                    } icon: {
                        Image(systemName: "calendar")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
            }

            // Message count
            if let messages = session.messages {
                HStack(spacing: 4) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)

                    Text("\(messages.count) message\(messages.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Shared Message

    private func sharedMessageView(_ message: SharedMessage) -> some View {
        let isUser = message.role == "user"

        return VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            // Tool uses (shown before message)
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

            // Message content bubble
            if let content = message.content, !content.isEmpty {
                if isUser {
                    MessageBubble(content: content, isUser: true)
                } else {
                    HStack {
                        Text(markdownString(content))
                            .font(.body)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(ChatBubbleShape(isUser: false))

                        Spacer(minLength: 60)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    // MARK: - Empty State

    private var emptyMessagesView: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)

            Text("No Messages")
                .font(.headline)
                .foregroundStyle(.secondary)

            Text("This shared session does not contain any messages.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 60)
    }

    // MARK: - Read-only Banner

    private var readOnlyBanner: some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 8) {
                Image(systemName: "lock.circle.fill")
                    .foregroundStyle(.secondary)

                Text("This is a read-only shared conversation")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.bar)
        }
    }

    // MARK: - Share Button

    private var shareButton: some View {
        Button {
            copyShareLink()
        } label: {
            if showCopiedConfirmation {
                Label("Copied!", systemImage: "checkmark")
                    .foregroundStyle(.green)
            } else {
                Image(systemName: "link")
            }
        }
        .disabled(showCopiedConfirmation)
    }

    // MARK: - Error View

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)

            Text("Could Not Load Session")
                .font(.headline)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                Task { await loadSharedSession() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .font(.body.weight(.medium))
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Helpers

    private func loadSharedSession() async {
        isLoading = true
        errorMessage = nil

        do {
            let endpoint = APIEndpoint.torchAgentShared(uuid: uuid)
            session = try await apiClient.fetch(endpoint)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func copyShareLink() {
        let shareURL = "https://hud.pytorch.org/flambeau/s/\(uuid)"
        UIPasteboard.general.string = shareURL

        withAnimation {
            showCopiedConfirmation = true
        }

        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation {
                showCopiedConfirmation = false
            }
        }
    }

    private func formattedDate(_ dateString: String) -> String {
        if let date = ISO8601DateFormatter().date(from: dateString) {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            return formatter.localizedString(for: date, relativeTo: Date())
        }
        return dateString
    }

    private func markdownString(_ content: String) -> AttributedString {
        (try? AttributedString(markdown: content, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(content)
    }
}

#Preview {
    ContentView()
        .environmentObject(AuthManager.shared)
        .environmentObject(ThemeManager.shared)
        .environmentObject(NotificationManager.shared)
        .environmentObject(DeepLinkHandler.shared)
}
