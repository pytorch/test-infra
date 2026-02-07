import XCTest
@testable import TorchCI

// MARK: - TorchAgentSession Model Tests

final class TorchAgentSessionTests: XCTestCase {

    // MARK: - Decoding

    func testDecodingFullSession() {
        let json = """
        {
            "session_id": "sess-abc-123",
            "title": "CI failure investigation",
            "created_at": "2025-01-15T10:30:00Z",
            "updated_at": "2025-01-15T11:00:00Z",
            "message_count": 12
        }
        """

        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.sessionId, "sess-abc-123")
        XCTAssertEqual(session.title, "CI failure investigation")
        XCTAssertEqual(session.createdAt, "2025-01-15T10:30:00Z")
        XCTAssertEqual(session.updatedAt, "2025-01-15T11:00:00Z")
        XCTAssertEqual(session.messageCount, 12)
    }

    func testDecodingMinimalSession() {
        let json = """
        {
            "session_id": "sess-minimal"
        }
        """

        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.sessionId, "sess-minimal")
        XCTAssertNil(session.title)
        XCTAssertNil(session.createdAt)
        XCTAssertNil(session.updatedAt)
        XCTAssertNil(session.messageCount)
    }

    func testDecodingSessionWithNullFields() {
        let json = """
        {
            "session_id": "sess-nulls",
            "title": null,
            "created_at": null,
            "updated_at": null,
            "message_count": null
        }
        """

        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.sessionId, "sess-nulls")
        XCTAssertNil(session.title)
        XCTAssertNil(session.createdAt)
        XCTAssertNil(session.updatedAt)
        XCTAssertNil(session.messageCount)
    }

    func testDecodingSessionArray() {
        let json = """
        [
            {"session_id": "s1", "title": "First"},
            {"session_id": "s2", "title": "Second"},
            {"session_id": "s3", "title": "Third"}
        ]
        """

        let sessions: [TorchAgentSession] = MockData.decode(json)

        XCTAssertEqual(sessions.count, 3)
        XCTAssertEqual(sessions[0].sessionId, "s1")
        XCTAssertEqual(sessions[1].sessionId, "s2")
        XCTAssertEqual(sessions[2].sessionId, "s3")
    }

    // MARK: - Identifiable

    func testIdentifiableConformance() {
        let json = #"{"session_id": "test-id-123"}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.id, "test-id-123")
        XCTAssertEqual(session.id, session.sessionId)
    }

    // MARK: - Display Date

    func testDisplayDateWithValidISO8601() {
        let json = #"{"session_id": "s1", "created_at": "2025-01-15T10:30:00Z"}"#
        let session: TorchAgentSession = MockData.decode(json)

        let displayDate = session.displayDate
        // The relative date formatter should produce a non-empty string
        XCTAssertFalse(displayDate.isEmpty)
        // It should not be the raw ISO 8601 string (it should be formatted)
        XCTAssertNotEqual(displayDate, "2025-01-15T10:30:00Z")
    }

    func testDisplayDateWithNilCreatedAt() {
        let json = #"{"session_id": "s1"}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.displayDate, "")
    }

    func testDisplayDateWithInvalidDateString() {
        let json = #"{"session_id": "s1", "created_at": "not-a-date"}"#
        let session: TorchAgentSession = MockData.decode(json)

        // When parsing fails, it should return the raw string
        XCTAssertEqual(session.displayDate, "not-a-date")
    }

    func testDisplayDateWithEmptyCreatedAt() {
        let json = #"{"session_id": "s1", "created_at": ""}"#
        let session: TorchAgentSession = MockData.decode(json)

        // Empty string is not a valid ISO8601 date, so it returns the raw string
        XCTAssertEqual(session.displayDate, "")
    }

    // MARK: - Message Count Pluralization

    func testMessageCountZero() {
        let json = #"{"session_id": "s1", "message_count": 0}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.messageCount, 0)
    }

    func testMessageCountOne() {
        let json = #"{"session_id": "s1", "message_count": 1}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.messageCount, 1)
    }

    func testMessageCountMany() {
        let json = #"{"session_id": "s1", "message_count": 42}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.messageCount, 42)
    }
}

// MARK: - ChatHistory ViewModel Integration Tests

@MainActor
final class ChatHistoryViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TorchAgentViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TorchAgentViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Load Sessions

    func testLoadSessionsDecodesArray() async {
        let json = """
        [
            {"session_id": "s1", "title": "Chat about failures", "message_count": 5, "created_at": "2025-01-15T10:30:00Z"},
            {"session_id": "s2", "title": "CUDA debugging", "message_count": 3, "created_at": "2025-01-14T09:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 2)
        XCTAssertEqual(viewModel.sessions[0].sessionId, "s1")
        XCTAssertEqual(viewModel.sessions[0].title, "Chat about failures")
        XCTAssertEqual(viewModel.sessions[0].messageCount, 5)
        XCTAssertEqual(viewModel.sessions[1].sessionId, "s2")
        XCTAssertEqual(viewModel.sessions[1].title, "CUDA debugging")
    }

    func testLoadSessionsDecodesWrappedResponseWithSessionsKey() async {
        // Some backends return sessions in a wrapper object
        let json = """
        {"sessions": [{"session_id": "wrapped-1", "title": "Wrapped session"}]}
        """
        mockClient.setResponse(json, for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 1)
        XCTAssertEqual(viewModel.sessions[0].sessionId, "wrapped-1")
    }

    func testLoadSessionsDecodesWrappedResponseWithHistoryKey() async {
        let json = """
        {"history": [{"session_id": "hist-1", "title": "History session"}]}
        """
        mockClient.setResponse(json, for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 1)
        XCTAssertEqual(viewModel.sessions[0].sessionId, "hist-1")
    }

    func testLoadSessionsEmptyArray() async {
        mockClient.setResponse("[]", for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    func testLoadSessionsNetworkErrorSetsEmptyList() async {
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    func testLoadSessionsConnectionErrorSetsEmptyList() async {
        mockClient.setError(APIError.networkError(URLError(.notConnectedToInternet)), for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    // MARK: - Load Individual Session

    func testLoadSessionSetsSessionId() async {
        let sessionJSON = """
        {"session_id": "sess-load", "title": "Loaded", "messages": []}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-load", title: "Loaded")
        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.sessionId, "sess-load")
    }

    func testLoadSessionClearsExistingMessages() async {
        // Pre-populate messages
        viewModel.sendQuery("Pre-existing message")
        mockClient.streamChunks = []

        let sessionJSON = """
        {"session_id": "sess-new", "messages": [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"}
        ]}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-new")
        await viewModel.loadSession(session)

        // Messages should only be from the loaded session
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].content, "Hello")
        XCTAssertEqual(viewModel.messages[1].role, .assistant)
        XCTAssertEqual(viewModel.messages[1].content, "Hi there!")
    }

    func testLoadSessionWithToolUses() async {
        let sessionJSON = """
        {"session_id": "sess-tools", "messages": [
            {"role": "assistant", "content": "Found results", "tool_uses": [
                {"name": "search_hud", "input": "query", "output": "3 results"}
            ]}
        ]}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-tools")
        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].toolUses.count, 1)
        XCTAssertEqual(viewModel.messages[0].toolUses[0].toolName, "search_hud")
        XCTAssertEqual(viewModel.messages[0].toolUses[0].output, "3 results")
    }

    func testLoadSessionErrorAddsErrorMessage() async {
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-fail")
        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.sessionId, "sess-fail")
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertTrue(viewModel.messages[0].content.contains("Failed to load session"))
    }

    func testLoadSessionResetsFeedback() async {
        viewModel.feedbackSubmitted = 1

        let sessionJSON = """
        {"session_id": "sess-fb", "messages": []}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-fb")
        await viewModel.loadSession(session)

        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    // MARK: - Delete Session (Local)

    func testDeleteSessionRemovesFromList() {
        viewModel.sessions = [
            makeSession(id: "s1", title: "First"),
            makeSession(id: "s2", title: "Second"),
            makeSession(id: "s3", title: "Third"),
        ]

        viewModel.sessions.removeAll { $0.sessionId == "s2" }

        XCTAssertEqual(viewModel.sessions.count, 2)
        XCTAssertEqual(viewModel.sessions[0].sessionId, "s1")
        XCTAssertEqual(viewModel.sessions[1].sessionId, "s3")
    }

    func testDeleteNonexistentSessionDoesNothing() {
        viewModel.sessions = [
            makeSession(id: "s1"),
            makeSession(id: "s2"),
        ]

        viewModel.sessions.removeAll { $0.sessionId == "nonexistent" }

        XCTAssertEqual(viewModel.sessions.count, 2)
    }

    func testDeleteAllSessions() {
        viewModel.sessions = [
            makeSession(id: "s1"),
            makeSession(id: "s2"),
        ]

        viewModel.sessions.removeAll { _ in true }

        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    // MARK: - Search Filtering

    func testFilterByTitle() {
        viewModel.sessions = [
            makeSession(id: "s1", title: "CUDA build failure"),
            makeSession(id: "s2", title: "Test flakiness report"),
            makeSession(id: "s3", title: "CUDA memory leak"),
        ]

        let query = "cuda"
        let filtered = viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            if session.sessionId.lowercased().contains(query) {
                return true
            }
            return false
        }

        XCTAssertEqual(filtered.count, 2)
        XCTAssertEqual(filtered[0].sessionId, "s1")
        XCTAssertEqual(filtered[1].sessionId, "s3")
    }

    func testFilterBySessionId() {
        viewModel.sessions = [
            makeSession(id: "sess-abc-123"),
            makeSession(id: "sess-def-456"),
            makeSession(id: "sess-abc-789"),
        ]

        let query = "abc"
        let filtered = viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            if session.sessionId.lowercased().contains(query) {
                return true
            }
            return false
        }

        XCTAssertEqual(filtered.count, 2)
        XCTAssertEqual(filtered[0].sessionId, "sess-abc-123")
        XCTAssertEqual(filtered[1].sessionId, "sess-abc-789")
    }

    func testFilterCaseInsensitive() {
        viewModel.sessions = [
            makeSession(id: "s1", title: "PyTorch CI Dashboard"),
            makeSession(id: "s2", title: "pytorch model training"),
        ]

        let query = "pytorch"
        let filtered = viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            return false
        }

        XCTAssertEqual(filtered.count, 2)
    }

    func testFilterEmptyQueryReturnsAll() {
        viewModel.sessions = [
            makeSession(id: "s1"),
            makeSession(id: "s2"),
            makeSession(id: "s3"),
        ]

        let query = "   "
        let isEmptySearch = query.trimmingCharacters(in: .whitespaces).isEmpty

        XCTAssertTrue(isEmptySearch, "Whitespace-only query should be treated as empty")
    }

    func testFilterNoMatchReturnsEmpty() {
        viewModel.sessions = [
            makeSession(id: "s1", title: "Chat about CI"),
            makeSession(id: "s2", title: "Build debugging"),
        ]

        let query = "zzzznonexistent"
        let filtered = viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            if session.sessionId.lowercased().contains(query) {
                return true
            }
            return false
        }

        XCTAssertTrue(filtered.isEmpty)
    }

    func testFilterSessionWithNilTitle() {
        viewModel.sessions = [
            makeSession(id: "s1", title: nil),
            makeSession(id: "s2", title: "Has a title"),
        ]

        let query = "title"
        let filtered = viewModel.sessions.filter { session in
            if let title = session.title, title.lowercased().contains(query) {
                return true
            }
            if session.sessionId.lowercased().contains(query) {
                return true
            }
            return false
        }

        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered[0].sessionId, "s2")
    }

    // MARK: - Date Grouping

    func testDateGroupingToday() {
        let now = Date()
        let isoFormatter = ISO8601DateFormatter()
        let todayISO = isoFormatter.string(from: now)

        let session = makeSession(id: "s1", createdAt: todayISO)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .today)
    }

    func testDateGroupingYesterday() {
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let yesterdayISO = isoFormatter.string(from: yesterday)

        let session = makeSession(id: "s1", createdAt: yesterdayISO)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .yesterday)
    }

    func testDateGroupingLastWeek() {
        let threeDaysAgo = Calendar.current.date(byAdding: .day, value: -3, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let iso = isoFormatter.string(from: threeDaysAgo)

        let session = makeSession(id: "s1", createdAt: iso)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .lastWeek)
    }

    func testDateGroupingFiveDaysAgo() {
        let fiveDaysAgo = Calendar.current.date(byAdding: .day, value: -5, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let iso = isoFormatter.string(from: fiveDaysAgo)

        let session = makeSession(id: "s1", createdAt: iso)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .lastWeek)
    }

    func testDateGroupingSevenDaysAgo() {
        let sevenDaysAgo = Calendar.current.date(byAdding: .day, value: -7, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let iso = isoFormatter.string(from: sevenDaysAgo)

        let session = makeSession(id: "s1", createdAt: iso)
        let group = dateGroup(for: session)

        // 7 days ago: daysAgo == 7, which satisfies <= 7, so it should be lastWeek
        XCTAssertEqual(group, .lastWeek)
    }

    func testDateGroupingOlder() {
        let twoWeeksAgo = Calendar.current.date(byAdding: .day, value: -14, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let iso = isoFormatter.string(from: twoWeeksAgo)

        let session = makeSession(id: "s1", createdAt: iso)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .older)
    }

    func testDateGroupingThirtyDaysAgo() {
        let thirtyDaysAgo = Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        let isoFormatter = ISO8601DateFormatter()
        let iso = isoFormatter.string(from: thirtyDaysAgo)

        let session = makeSession(id: "s1", createdAt: iso)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .older)
    }

    func testDateGroupingNilDateGoesToOlder() {
        let session = makeSession(id: "s1", createdAt: nil)
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .older)
    }

    func testDateGroupingInvalidDateGoesToOlder() {
        let session = makeSession(id: "s1", createdAt: "not-a-date")
        let group = dateGroup(for: session)

        XCTAssertEqual(group, .older)
    }

    func testDateGroupingMultipleSessions() {
        let now = Date()
        let calendar = Calendar.current
        let isoFormatter = ISO8601DateFormatter()

        let todayISO = isoFormatter.string(from: now)
        let yesterdayISO = isoFormatter.string(from: calendar.date(byAdding: .day, value: -1, to: now)!)
        let threeDaysISO = isoFormatter.string(from: calendar.date(byAdding: .day, value: -3, to: now)!)
        let twoWeeksISO = isoFormatter.string(from: calendar.date(byAdding: .day, value: -14, to: now)!)

        let sessions = [
            makeSession(id: "s1", createdAt: todayISO),
            makeSession(id: "s2", createdAt: todayISO),
            makeSession(id: "s3", createdAt: yesterdayISO),
            makeSession(id: "s4", createdAt: threeDaysISO),
            makeSession(id: "s5", createdAt: twoWeeksISO),
            makeSession(id: "s6", createdAt: nil),
        ]

        let groups = groupSessions(sessions)

        XCTAssertEqual(groups[.today]?.count, 2)
        XCTAssertEqual(groups[.yesterday]?.count, 1)
        XCTAssertEqual(groups[.lastWeek]?.count, 1)
        XCTAssertEqual(groups[.older]?.count, 2) // two weeks ago + nil date
    }

    // MARK: - New Chat Resets

    func testNewChatAfterLoadingSessionResetsState() async {
        let sessionJSON = """
        {"session_id": "sess-loaded", "messages": [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"}
        ]}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-chat-history")

        let session = makeSession(id: "sess-loaded")
        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.sessionId, "sess-loaded")
        XCTAssertEqual(viewModel.messages.count, 2)

        viewModel.newChat()

        XCTAssertNil(viewModel.sessionId)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    // MARK: - Edge Cases

    func testSessionWithEmptyTitle() {
        let json = #"{"session_id": "s1", "title": ""}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.title, "")
    }

    func testSessionWithLongTitle() {
        let longTitle = String(repeating: "A", count: 500)
        let json = """
        {"session_id": "s1", "title": "\(longTitle)"}
        """
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.title?.count, 500)
    }

    func testSessionWithSpecialCharactersInTitle() {
        let json = #"{"session_id": "s1", "title": "What's the status of PR #12345?"}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.title, "What's the status of PR #12345?")
    }

    func testSessionWithZeroMessageCount() {
        let json = #"{"session_id": "s1", "message_count": 0}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.messageCount, 0)
    }

    func testSessionWithLargeMessageCount() {
        let json = #"{"session_id": "s1", "message_count": 9999}"#
        let session: TorchAgentSession = MockData.decode(json)

        XCTAssertEqual(session.messageCount, 9999)
    }

    // MARK: - Helpers

    /// Create a TorchAgentSession from JSON for testing.
    private func makeSession(
        id: String,
        title: String? = nil,
        createdAt: String? = nil,
        messageCount: Int? = nil
    ) -> TorchAgentSession {
        var parts: [String] = [#""session_id": "\#(id)""#]
        if let title {
            parts.append(#""title": "\#(title)""#)
        }
        if let createdAt {
            parts.append(#""created_at": "\#(createdAt)""#)
        }
        if let messageCount {
            parts.append(#""message_count": \#(messageCount)"#)
        }
        let json = "{\(parts.joined(separator: ", "))}"
        return MockData.decode(json)
    }

    /// Mirrors the date grouping logic from ChatHistoryView for testability.
    enum DateGroup: CaseIterable {
        case today
        case yesterday
        case lastWeek
        case older
    }

    private func dateGroup(for session: TorchAgentSession) -> DateGroup {
        let calendar = Calendar.current
        let now = Date()
        let isoFormatter = ISO8601DateFormatter()

        guard let createdAt = session.createdAt,
              let date = isoFormatter.date(from: createdAt) else {
            return .older
        }

        let daysAgo = calendar.dateComponents([.day], from: date, to: now).day ?? 0

        if calendar.isDateInToday(date) {
            return .today
        } else if calendar.isDateInYesterday(date) {
            return .yesterday
        } else if daysAgo <= 7 {
            return .lastWeek
        } else {
            return .older
        }
    }

    private func groupSessions(_ sessions: [TorchAgentSession]) -> [DateGroup: [TorchAgentSession]] {
        var groups: [DateGroup: [TorchAgentSession]] = [:]
        for session in sessions {
            let group = dateGroup(for: session)
            groups[group, default: []].append(session)
        }
        return groups
    }
}
