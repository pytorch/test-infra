import SwiftUI

struct ChatHistoryView: View {
    @ObservedObject var viewModel: TorchAgentViewModel
    @Binding var isPresented: Bool

    @State private var isLoading = true
    @State private var searchText = ""

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    LoadingView(message: "Loading history...")
                } else if viewModel.sessions.isEmpty {
                    emptyState
                } else {
                    sessionsList
                }
            }
            .navigationTitle("Chat History")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $searchText, prompt: "Search conversations")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        isPresented = false
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        startNewChat()
                    } label: {
                        Label("New Chat", systemImage: "square.and.pencil")
                    }
                }
            }
            .task {
                await loadHistory()
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 72))
                .foregroundStyle(.quaternary)

            VStack(spacing: 8) {
                Text("No Conversations Yet")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.primary)

                Text("Your chat sessions will appear here.\nStart a new conversation to get going.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button {
                startNewChat()
            } label: {
                Label("New Chat", systemImage: "square.and.pencil")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: 200)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 8)

            Spacer()
        }
        .padding()
    }

    // MARK: - Sessions List

    private var sessionsList: some View {
        List {
            let grouped = groupedSessions

            ForEach(DateGroup.allCases, id: \.self) { group in
                if let sessions = grouped[group], !sessions.isEmpty {
                    Section {
                        ForEach(sessions) { session in
                            Button {
                                loadSession(session)
                            } label: {
                                sessionRow(session)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    deleteSession(session)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    } header: {
                        Text(group.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func sessionRow(_ session: TorchAgentSession) -> some View {
        HStack(spacing: 12) {
            // Icon
            Circle()
                .fill(session.sessionId == viewModel.sessionId ? Color.accentColor : Color(.tertiarySystemFill))
                .frame(width: 40, height: 40)
                .overlay {
                    Image(systemName: session.sessionId == viewModel.sessionId ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
                        .font(.system(size: 16))
                        .foregroundStyle(session.sessionId == viewModel.sessionId ? .white : .secondary)
                }

            VStack(alignment: .leading, spacing: 4) {
                // Title (first query)
                Text(session.title ?? "Untitled Session")
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                // Timestamp and message count
                HStack(spacing: 6) {
                    Text(session.displayDate)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let count = session.messageCount, count > 0 {
                        Text("•")
                            .font(.caption)
                            .foregroundStyle(.tertiary)

                        Text("\(count) message\(count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if session.sessionId == viewModel.sessionId {
                        Text("•")
                            .font(.caption)
                            .foregroundStyle(.tertiary)

                        Text("Active")
                            .font(.caption)
                            .foregroundStyle(Color.accentColor)
                    }
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.quaternary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    // MARK: - Grouping

    private enum DateGroup: CaseIterable {
        case today
        case yesterday
        case lastWeek
        case older

        var title: String {
            switch self {
            case .today: return "Today"
            case .yesterday: return "Yesterday"
            case .lastWeek: return "Last 7 Days"
            case .older: return "Older"
            }
        }
    }

    private var groupedSessions: [DateGroup: [TorchAgentSession]] {
        let filtered = filteredSessions
        var groups: [DateGroup: [TorchAgentSession]] = [:]

        let calendar = Calendar.current
        let now = Date()
        let isoFormatter = ISO8601DateFormatter()

        for session in filtered {
            guard let createdAt = session.createdAt,
                  let date = isoFormatter.date(from: createdAt) else {
                // If no date, put in "Older"
                groups[.older, default: []].append(session)
                continue
            }

            let daysAgo = calendar.dateComponents([.day], from: date, to: now).day ?? 0

            let group: DateGroup
            if calendar.isDateInToday(date) {
                group = .today
            } else if calendar.isDateInYesterday(date) {
                group = .yesterday
            } else if daysAgo <= 7 {
                group = .lastWeek
            } else {
                group = .older
            }

            groups[group, default: []].append(session)
        }

        return groups
    }

    private var filteredSessions: [TorchAgentSession] {
        if searchText.trimmingCharacters(in: .whitespaces).isEmpty {
            return viewModel.sessions
        }

        let query = searchText.lowercased()
        return viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            if session.sessionId.lowercased().contains(query) {
                return true
            }
            return false
        }
    }

    // MARK: - Actions

    private func startNewChat() {
        viewModel.newChat()
        isPresented = false
    }

    private func loadSession(_ session: TorchAgentSession) {
        Task {
            await viewModel.loadSession(session)
            isPresented = false
        }
    }

    private func deleteSession(_ session: TorchAgentSession) {
        withAnimation {
            viewModel.sessions.removeAll { $0.sessionId == session.sessionId }
        }
    }

    private func loadHistory() async {
        isLoading = true
        await viewModel.loadSessions()
        isLoading = false
    }
}

#Preview {
    ChatHistoryView(
        viewModel: TorchAgentViewModel(),
        isPresented: .constant(true)
    )
}
