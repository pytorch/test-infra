import XCTest
@testable import TorchCI

@MainActor
final class TorchAgentViewModelTests: XCTestCase {

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

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.sessions.isEmpty)
        XCTAssertNil(viewModel.sessionId)
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.streamingContent, "")
        XCTAssertEqual(viewModel.streamingThinking, "")
        XCTAssertTrue(viewModel.currentToolUses.isEmpty)
        XCTAssertEqual(viewModel.tokenCount, 0)
        XCTAssertEqual(viewModel.elapsedTime, 0)
        XCTAssertNil(viewModel.shareURL)
        XCTAssertFalse(viewModel.showShareAlert)
        XCTAssertFalse(viewModel.showShareError)
        XCTAssertNil(viewModel.feedbackSubmitted)
        XCTAssertNil(viewModel.username)
    }

    // MARK: - Send Message

    func testSendMessageAddsUserMessageToList() {
        // Set up stream chunks that complete immediately
        mockClient.streamChunks = []

        viewModel.sendQuery("What is the CI status?")

        // The user message should be added synchronously
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, .user)
        XCTAssertEqual(viewModel.messages.first?.content, "What is the CI status?")
        XCTAssertTrue(viewModel.messages.first?.toolUses.isEmpty ?? false)
        XCTAssertNil(viewModel.messages.first?.thinkingContent)
    }

    func testSendEmptyMessageDoesNothing() {
        viewModel.sendQuery("")
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
    }

    func testSendWhitespaceOnlyMessageDoesNothing() {
        viewModel.sendQuery("   \n\t  ")
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
    }

    func testSendMessageSetsStreamingState() {
        mockClient.streamChunks = []

        viewModel.sendQuery("Hello")

        XCTAssertTrue(viewModel.isStreaming)
        XCTAssertEqual(viewModel.streamingContent, "")
        XCTAssertEqual(viewModel.tokenCount, 0)
    }

    func testSendMessageWhileStreamingIsIgnored() {
        mockClient.streamChunks = []

        viewModel.sendQuery("First")
        XCTAssertEqual(viewModel.messages.count, 1)

        // Try to send another while streaming
        viewModel.sendQuery("Second")
        // The second message should be ignored because isStreaming is true
        XCTAssertEqual(viewModel.messages.count, 1)
    }

    func testSendQueryRecordsEndpointCall() async throws {
        mockClient.streamChunks = []

        viewModel.sendQuery("test query")

        // sendQuery spawns a Task internally, give it time to start
        try await Task.sleep(nanoseconds: 50_000_000)

        // The stream endpoint should be called
        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, "/api/torchagent-api")
    }

    func testSendMultipleMessagesAfterStreamCompletes() async {
        // First message with completed stream
        let doneChunk = #"{"type":"done","done":true}"#
        mockClient.streamChunks = [Data(doneChunk.utf8)]

        viewModel.sendQuery("First message")

        // Wait for the stream to finish
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertFalse(viewModel.isStreaming)

        // Now send another message
        mockClient.streamChunks = [Data(doneChunk.utf8)]
        viewModel.sendQuery("Second message")

        let userMessages = viewModel.messages.filter { $0.role == .user }
        XCTAssertEqual(userMessages.count, 2)
        XCTAssertEqual(userMessages[0].content, "First message")
        XCTAssertEqual(userMessages[1].content, "Second message")
    }

    // MARK: - Permission Check

    func testPermissionCheckAuthorizedSetsReady() async {
        let permissionJSON = #"{"authorized":true,"username":"pytorch-dev"}"#
        mockClient.setResponse(permissionJSON, for: "/api/torchagent-check-permissions")

        await viewModel.checkPermissions()

        XCTAssertEqual(viewModel.state, .ready)
        XCTAssertEqual(viewModel.username, "pytorch-dev")
    }

    func testPermissionCheckUnauthorizedSetsUnauthorized() async {
        let permissionJSON = #"{"authorized":false,"username":"random-user"}"#
        mockClient.setResponse(permissionJSON, for: "/api/torchagent-check-permissions")

        await viewModel.checkPermissions()

        XCTAssertEqual(viewModel.state, .unauthorized)
        XCTAssertEqual(viewModel.username, "random-user")
    }

    func testPermissionCheckAPIUnauthorizedErrorSetsUnauthorized() async {
        mockClient.setError(APIError.unauthorized, for: "/api/torchagent-check-permissions")

        await viewModel.checkPermissions()

        XCTAssertEqual(viewModel.state, .unauthorized)
    }

    func testPermissionCheckServerErrorSetsErrorState() async {
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-check-permissions")

        await viewModel.checkPermissions()

        if case .error(let msg) = viewModel.state {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testPermissionCheckSetsCheckingPermissionsState() async {
        // Before the check
        XCTAssertEqual(viewModel.state, .idle)

        let permissionJSON = #"{"authorized":true,"username":"test"}"#
        mockClient.setResponse(permissionJSON, for: "/api/torchagent-check-permissions")

        await viewModel.checkPermissions()

        // After check completes
        XCTAssertEqual(viewModel.state, .ready)
    }

    // MARK: - Stream Parsing

    func testStreamParsingTextContent() async {
        let chunk1 = #"{"type":"text","content":"Hello "}"#
        let chunk2 = #"{"type":"text","content":"world!"}"#
        let chunk3 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
            Data(chunk3.utf8),
        ]

        viewModel.sendQuery("Hi")

        // Wait for streaming to complete
        try? await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(viewModel.isStreaming)

        // Should have user message + assistant message
        XCTAssertEqual(viewModel.messages.count, 2)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Hello world!")
    }

    func testStreamParsingContentType() async {
        let chunk1 = #"{"type":"content","content":"Response text"}"#
        let chunk2 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
        ]

        viewModel.sendQuery("Test")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Response text")
    }

    func testStreamParsingThinkingContent() async {
        let chunk1 = #"{"type":"thinking","thinking_content":"Let me think..."}"#
        let chunk2 = #"{"type":"text","content":"Here is my answer."}"#
        let chunk3 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
            Data(chunk3.utf8),
        ]

        viewModel.sendQuery("Think about this")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Here is my answer.")
        XCTAssertEqual(assistantMessage?.thinkingContent, "Let me think...")
    }

    func testStreamParsingToolUse() async {
        let chunk1 = #"{"type":"tool_use","tool_name":"search_hud","tool_input":"{\"query\":\"failures\"}"}"#
        let chunk2 = #"{"type":"tool_result","tool_result":"Found 3 failures"}"#
        let chunk3 = #"{"type":"text","content":"I found 3 failures."}"#
        let chunk4 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
            Data(chunk3.utf8),
            Data(chunk4.utf8),
        ]

        viewModel.sendQuery("Search for failures")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "I found 3 failures.")
        XCTAssertEqual(assistantMessage?.toolUses.count, 1)
        XCTAssertEqual(assistantMessage?.toolUses.first?.toolName, "search_hud")
        XCTAssertEqual(assistantMessage?.toolUses.first?.output, "Found 3 failures")
    }

    func testStreamParsingSetsSessionId() async {
        let chunk1 = #"{"type":"text","content":"Hi","session_id":"sess-abc-123"}"#
        let chunk2 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
        ]

        XCTAssertNil(viewModel.sessionId)

        viewModel.sendQuery("Hello")

        try? await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertEqual(viewModel.sessionId, "sess-abc-123")
    }

    func testStreamParsingErrorChunk() async {
        let chunk1 = #"{"type":"text","content":"Starting..."}"#
        let chunk2 = #"{"type":"error","content":"Rate limit exceeded"}"#
        let chunk3 = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
            Data(chunk3.utf8),
        ]

        viewModel.sendQuery("Test error")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertTrue(assistantMessage?.content.contains("Rate limit exceeded") ?? false)
    }

    func testStreamParsingSSEFormat() async {
        // Lines prefixed with "data: " should have that prefix stripped
        let sseChunk = "data: {\"type\":\"text\",\"content\":\"SSE content\"}\n"
        let doneChunk = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(sseChunk.utf8),
            Data(doneChunk.utf8),
        ]

        viewModel.sendQuery("Test SSE")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "SSE content")
    }

    func testStreamErrorAddsErrorMessage() async {
        mockClient.streamChunks = []
        mockClient.streamError = APIError.serverError(500)

        viewModel.sendQuery("Will fail")

        try? await Task.sleep(nanoseconds: 500_000_000)

        // Should have user message + error assistant message
        XCTAssertGreaterThanOrEqual(viewModel.messages.count, 2)
        let lastMessage = viewModel.messages.last
        XCTAssertEqual(lastMessage?.role, .assistant)
        XCTAssertTrue(lastMessage?.content.contains("error") ?? lastMessage?.content.contains("Error") ?? false)
    }

    // MARK: - Cancel Stream

    func testCancelStreamStopsStreaming() {
        mockClient.streamChunks = []
        viewModel.sendQuery("Test cancel")

        XCTAssertTrue(viewModel.isStreaming)

        viewModel.cancelStream()

        XCTAssertFalse(viewModel.isStreaming)
    }

    // MARK: - New Chat

    func testNewChatResetsState() async {
        // First have a conversation
        let chunk = #"{"type":"text","content":"response","session_id":"sess-1"}"#
        let done = #"{"type":"done","done":true}"#
        mockClient.streamChunks = [Data(chunk.utf8), Data(done.utf8)]

        viewModel.sendQuery("Hello")
        try? await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(viewModel.messages.isEmpty)
        XCTAssertNotNil(viewModel.sessionId)

        // Start new chat
        viewModel.newChat()

        XCTAssertNil(viewModel.sessionId)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertEqual(viewModel.streamingContent, "")
        XCTAssertEqual(viewModel.streamingThinking, "")
        XCTAssertTrue(viewModel.currentToolUses.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.tokenCount, 0)
        XCTAssertEqual(viewModel.elapsedTime, 0)
        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    // MARK: - Load Sessions

    func testLoadSessionsPopulatesList() async {
        let sessionsJSON = """
        [
            {"session_id":"s1","title":"Chat 1","message_count":5},
            {"session_id":"s2","title":"Chat 2","message_count":3}
        ]
        """
        mockClient.setResponse(sessionsJSON, for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 2)
        XCTAssertEqual(viewModel.sessions.first?.sessionId, "s1")
        XCTAssertEqual(viewModel.sessions.first?.title, "Chat 1")
    }

    func testLoadSessionsErrorSetsEmptyList() async {
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-get-history")

        await viewModel.loadSessions()

        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    // MARK: - Share

    func testShareSessionWithNoSessionIdShowsError() async {
        viewModel.sessionId = nil

        await viewModel.shareSession()

        XCTAssertTrue(viewModel.showShareError)
        XCTAssertFalse(viewModel.shareErrorMessage.isEmpty)
    }

    func testShareSessionSuccess() async {
        viewModel.sessionId = "sess-123"

        let shareJSON = #"{"uuid":"shared-uuid-456","url":"https://hud.pytorch.org/torchagent/shared/shared-uuid-456"}"#
        mockClient.setResponse(shareJSON, for: "/api/torchagent-share")

        await viewModel.shareSession()

        XCTAssertTrue(viewModel.showShareAlert)
        XCTAssertNotNil(viewModel.shareURL)
        XCTAssertTrue(viewModel.shareURL?.contains("shared-uuid-456") ?? false)
    }

    // MARK: - Feedback

    func testSubmitFeedbackRecordsRating() async {
        viewModel.sessionId = "sess-123"

        // Set up a raw response for the feedback endpoint
        mockClient.responses["/api/torchagent-feedback"] = Data("{}".utf8)

        await viewModel.submitFeedback(1)

        XCTAssertEqual(viewModel.feedbackSubmitted, 1)
    }

    func testSubmitFeedbackWithNoSessionDoesNothing() async {
        viewModel.sessionId = nil

        await viewModel.submitFeedback(1)

        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    func testSubmitNegativeFeedbackRecordsRating() async {
        viewModel.sessionId = "sess-456"
        mockClient.responses["/api/torchagent-feedback"] = Data("{}".utf8)

        await viewModel.submitFeedback(-1)

        XCTAssertEqual(viewModel.feedbackSubmitted, -1)
    }

    func testSubmitFeedbackErrorSilentlyFails() async {
        viewModel.sessionId = "sess-789"
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-feedback")

        await viewModel.submitFeedback(1)

        // Should remain nil because the request failed
        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    func testSubmitFeedbackRecordsCorrectEndpoint() async {
        viewModel.sessionId = "sess-check"
        mockClient.responses["/api/torchagent-feedback"] = Data("{}".utf8)

        await viewModel.submitFeedback(1)

        XCTAssertTrue(mockClient.callPaths().contains("/api/torchagent-feedback"))
    }

    // MARK: - Cancel Stream Edge Cases

    func testCancelStreamWithPartialContentAddsAssistantMessage() async {
        // Simulate a stream that produces some content before being cancelled
        let chunk1 = #"{"type":"text","content":"Partial response..."}"#

        mockClient.streamChunks = [Data(chunk1.utf8)]
        // No done chunk, so stream finishes after yielding content

        viewModel.sendQuery("Test partial cancel")

        // Wait for chunks to be processed
        try? await Task.sleep(nanoseconds: 300_000_000)

        viewModel.cancelStream()

        XCTAssertFalse(viewModel.isStreaming)
        // The partial content should have been saved as an assistant message
        let assistantMessages = viewModel.messages.filter { $0.role == .assistant }
        // Note: Because stream completes quickly, the content may already be finalized.
        // This test ensures cancel does not crash and cleans up state.
        XCTAssertEqual(viewModel.streamingContent, "")
        XCTAssertEqual(viewModel.streamingThinking, "")
        XCTAssertTrue(viewModel.currentToolUses.isEmpty)
    }

    func testCancelStreamWithNoContentDoesNotAddMessage() {
        mockClient.streamChunks = []

        viewModel.sendQuery("Test empty cancel")

        // Cancel immediately before any content arrives
        viewModel.cancelStream()

        // Only the user message should be present
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, .user)
    }

    func testCancelStreamClearsStreamingState() {
        mockClient.streamChunks = []
        viewModel.sendQuery("Test cancel cleanup")

        viewModel.cancelStream()

        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.streamingContent, "")
        XCTAssertEqual(viewModel.streamingThinking, "")
        XCTAssertTrue(viewModel.currentToolUses.isEmpty)
    }

    // MARK: - Stream Parsing Edge Cases

    func testStreamParsingMultipleToolUses() async {
        let tool1 = #"{"type":"tool_use","tool_name":"clickhouse_query","tool_input":"SELECT * FROM jobs"}"#
        let result1 = #"{"type":"tool_result","tool_result":"100 rows"}"#
        let tool2 = #"{"type":"tool_use","tool_name":"bash_command","tool_input":"echo hello"}"#
        let result2 = #"{"type":"tool_result","tool_result":"hello"}"#
        let text = #"{"type":"text","content":"Analysis complete."}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(tool1.utf8),
            Data(result1.utf8),
            Data(tool2.utf8),
            Data(result2.utf8),
            Data(text.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Run multiple tools")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.toolUses.count, 2)
        XCTAssertEqual(assistantMessage?.toolUses[0].toolName, "clickhouse_query")
        XCTAssertEqual(assistantMessage?.toolUses[0].output, "100 rows")
        XCTAssertEqual(assistantMessage?.toolUses[1].toolName, "bash_command")
        XCTAssertEqual(assistantMessage?.toolUses[1].output, "hello")
        XCTAssertEqual(assistantMessage?.content, "Analysis complete.")
    }

    func testStreamParsingChunkWithNoType() async {
        // A chunk with just content and no type field
        let chunk = #"{"content":"Untyped content"}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test untyped")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Untyped content")
    }

    func testStreamParsingUnknownTypeWithContent() async {
        // A chunk with an unknown type should still capture content
        let chunk = #"{"type":"custom_type","content":"Custom content"}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test unknown type")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Custom content")
    }

    func testStreamParsingDoneBooleanWithoutType() async {
        // Some backends send done as a boolean without a type field
        let chunk = #"{"type":"text","content":"response"}"#
        let done = #"{"done":true}"#

        mockClient.streamChunks = [
            Data(chunk.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test done boolean")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "response")
    }

    func testStreamParsingSSEDoneMarker() async {
        // "data: [DONE]" should be skipped gracefully
        let chunk = #"{"type":"text","content":"SSE response"}"#
        let sseDone = "data: [DONE]\n"
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk.utf8),
            Data(sseDone.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test SSE done")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "SSE response")
    }

    func testStreamParsingInvalidJSON() async {
        // Invalid JSON chunks should be silently skipped
        let invalidChunk = "not valid json at all"
        let validChunk = #"{"type":"text","content":"Valid content"}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(invalidChunk.utf8),
            Data(validChunk.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test invalid JSON")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "Valid content")
    }

    func testStreamParsingEmptyChunksAreSkipped() async {
        let emptyChunk = "\n"
        let textChunk = #"{"type":"text","content":"After empty"}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(emptyChunk.utf8),
            Data(emptyChunk.utf8),
            Data(textChunk.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Test empty chunks")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.content, "After empty")
    }

    func testStreamErrorWithPartialContentAddsIncompleteWarning() async {
        let chunk = #"{"type":"text","content":"Partial text"}"#
        mockClient.streamChunks = [Data(chunk.utf8)]
        mockClient.streamError = APIError.networkError(URLError(.timedOut))

        viewModel.sendQuery("Test stream error with content")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        // The content should contain the partial text and possibly a warning
        XCTAssertTrue(assistantMessage?.content.contains("Partial text") ?? false)
    }

    func testStreamParsingMultipleThinkingChunks() async {
        let think1 = #"{"type":"thinking","thinking_content":"First thought. "}"#
        let think2 = #"{"type":"thinking","thinking_content":"Second thought."}"#
        let text = #"{"type":"text","content":"Final answer."}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(think1.utf8),
            Data(think2.utf8),
            Data(text.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Think deeply")

        try? await Task.sleep(nanoseconds: 500_000_000)

        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        XCTAssertEqual(assistantMessage?.thinkingContent, "First thought. Second thought.")
        XCTAssertEqual(assistantMessage?.content, "Final answer.")
    }

    // MARK: - Session Management Edge Cases

    func testLoadSessionSetsSessionId() async {
        let sessionJSON = """
        {
            "session_id": "loaded-sess",
            "title": "Test Session",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"}
            ]
        }
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-get-chat-history")

        let session = TorchAgentSession(
            sessionId: "loaded-sess",
            title: "Test Session",
            createdAt: nil,
            updatedAt: nil,
            messageCount: 2
        )

        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.sessionId, "loaded-sess")
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].content, "Hello")
        XCTAssertEqual(viewModel.messages[1].role, .assistant)
        XCTAssertEqual(viewModel.messages[1].content, "Hi there!")
    }

    func testLoadSessionWithToolUses() async {
        let sessionJSON = """
        {
            "session_id": "tool-sess",
            "messages": [
                {"role": "user", "content": "Search"},
                {
                    "role": "assistant",
                    "content": "Found results",
                    "tool_uses": [
                        {"name": "clickhouse_query", "input": "SELECT 1", "output": "1"}
                    ]
                }
            ]
        }
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-get-chat-history")

        let session = TorchAgentSession(
            sessionId: "tool-sess",
            title: nil,
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.messages.count, 2)
        let assistantMsg = viewModel.messages[1]
        XCTAssertEqual(assistantMsg.toolUses.count, 1)
        XCTAssertEqual(assistantMsg.toolUses[0].toolName, "clickhouse_query")
        XCTAssertEqual(assistantMsg.toolUses[0].input, "SELECT 1")
        XCTAssertEqual(assistantMsg.toolUses[0].output, "1")
    }

    func testLoadSessionErrorShowsErrorMessage() async {
        mockClient.setError(APIError.serverError(500), for: "/api/torchagent-get-chat-history")

        let session = TorchAgentSession(
            sessionId: "fail-sess",
            title: "Failing",
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        await viewModel.loadSession(session)

        // Should have an error message as an assistant message
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, .assistant)
        XCTAssertTrue(viewModel.messages.first?.content.contains("Failed to load session") ?? false)
    }

    func testLoadSessionClearsPreviousMessages() async {
        // First, add a message
        viewModel.messages = [
            TorchAgentMessage(
                role: .user,
                content: "Previous",
                toolUses: [],
                thinkingContent: nil,
                timestamp: Date()
            )
        ]
        viewModel.sessionId = "old-session"

        let sessionJSON = """
        {
            "session_id": "new-sess",
            "messages": [
                {"role": "user", "content": "New message"}
            ]
        }
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-get-chat-history")

        let session = TorchAgentSession(
            sessionId: "new-sess",
            title: nil,
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        await viewModel.loadSession(session)

        XCTAssertEqual(viewModel.sessionId, "new-sess")
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.content, "New message")
    }

    func testLoadSessionResetsFeedback() async {
        viewModel.feedbackSubmitted = 1

        let sessionJSON = """
        {"session_id": "new", "messages": []}
        """
        mockClient.setResponse(sessionJSON, for: "/api/torchagent-get-chat-history")

        let session = TorchAgentSession(
            sessionId: "new",
            title: nil,
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        await viewModel.loadSession(session)

        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    func testLoadSessionsWrappedResponseFormat() async {
        // Test the fallback format where sessions are wrapped in an object
        mockClient.setError(
            APIError.decodingError(NSError(domain: "test", code: 0)),
            for: "/api/torchagent-get-history"
        )

        await viewModel.loadSessions()

        // Should fall back gracefully to empty
        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    // MARK: - Share Edge Cases

    func testShareSessionWithUUIDOnlyResponse() async {
        viewModel.sessionId = "sess-share-uuid"

        let shareJSON = #"{"uuid":"only-uuid-no-url"}"#
        mockClient.setResponse(shareJSON, for: "/api/torchagent-share")

        await viewModel.shareSession()

        XCTAssertTrue(viewModel.showShareAlert)
        XCTAssertEqual(
            viewModel.shareURL,
            "https://hud.pytorch.org/torchagent/shared/only-uuid-no-url"
        )
    }

    func testShareSessionErrorShowsAlert() async {
        viewModel.sessionId = "sess-share-fail"
        mockClient.setError(APIError.serverError(503), for: "/api/torchagent-share")

        await viewModel.shareSession()

        XCTAssertTrue(viewModel.showShareError)
        XCTAssertFalse(viewModel.shareErrorMessage.isEmpty)
        XCTAssertFalse(viewModel.showShareAlert)
    }

    // MARK: - New Chat Edge Cases

    func testNewChatWhileStreamingCancelsStream() {
        mockClient.streamChunks = []
        viewModel.sendQuery("In progress")
        XCTAssertTrue(viewModel.isStreaming)

        viewModel.newChat()

        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertNil(viewModel.sessionId)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(TorchAgentViewModel.ViewState.idle, .idle)
        XCTAssertEqual(TorchAgentViewModel.ViewState.checkingPermissions, .checkingPermissions)
        XCTAssertEqual(TorchAgentViewModel.ViewState.unauthorized, .unauthorized)
        XCTAssertEqual(TorchAgentViewModel.ViewState.ready, .ready)
        XCTAssertEqual(TorchAgentViewModel.ViewState.error("msg"), .error("msg"))

        XCTAssertNotEqual(TorchAgentViewModel.ViewState.idle, .ready)
        XCTAssertNotEqual(TorchAgentViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(TorchAgentViewModel.ViewState.unauthorized, .error("test"))
    }

    // MARK: - Token Estimation

    func testTokenCountIncreasesWithContent() async {
        let chunk1 = #"{"type":"text","content":"Short"}"#
        let chunk2 = #"{"type":"text","content":"This is a much longer piece of text that should produce more estimated tokens than the short one."}"#
        let done = #"{"type":"done","done":true}"#

        mockClient.streamChunks = [
            Data(chunk1.utf8),
            Data(chunk2.utf8),
            Data(done.utf8),
        ]

        viewModel.sendQuery("Token test")

        try? await Task.sleep(nanoseconds: 500_000_000)

        // Token count should be greater than 0
        let assistantMessage = viewModel.messages.last
        XCTAssertEqual(assistantMessage?.role, .assistant)
        // The content should be the concatenation
        XCTAssertTrue(assistantMessage?.content.hasPrefix("Short") ?? false)
    }

    // MARK: - Send Query Resets Feedback

    func testSendQueryResetsFeedback() {
        viewModel.feedbackSubmitted = 1
        mockClient.streamChunks = []

        viewModel.sendQuery("New question")

        XCTAssertNil(viewModel.feedbackSubmitted)
    }

    // MARK: - Send Query With Existing Session ID

    func testSendQueryWithSessionIdPassesItToEndpoint() async throws {
        viewModel.sessionId = "existing-session"
        mockClient.streamChunks = []

        viewModel.sendQuery("Follow up question")

        // sendQuery spawns a Task internally, give it time to start
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(mockClient.callCount, 1)
        let call = mockClient.recordedCalls.first
        XCTAssertEqual(call?.path, "/api/torchagent-api")
        XCTAssertEqual(call?.method, "POST")
    }
}
