import XCTest
@testable import TorchCI

final class SharedSessionViewTests: XCTestCase {

    // MARK: - Share URL

    func testShareURLContainsUUID() {
        let view = SharedSessionView(uuid: "abc-123-def")
        XCTAssertEqual(view.shareURL, "https://hud.pytorch.org/torchagent/shared/abc-123-def")
    }

    func testShareURLWithEmptyUUID() {
        let view = SharedSessionView(uuid: "")
        XCTAssertEqual(view.shareURL, "https://hud.pytorch.org/torchagent/shared/")
    }

    func testShareURLWithSpecialCharacters() {
        let view = SharedSessionView(uuid: "uuid-with-special/chars?q=1")
        XCTAssertTrue(view.shareURL.contains("uuid-with-special/chars?q=1"))
    }

    // MARK: - Formatted Date

    func testFormattedDateWithValidISO8601() {
        // A date far in the past (> 7 days) should use medium date format
        let result = SharedSessionView.formattedDate("2020-01-15T10:30:00Z")
        XCTAssertFalse(result.isEmpty)
        // Should not be the raw ISO string since it was parseable
        XCTAssertNotEqual(result, "2020-01-15T10:30:00Z")
        // Should contain "2020" or "Jan" or similar date components
        XCTAssertTrue(result.contains("2020") || result.contains("Jan"), "Expected formatted date, got: \(result)")
    }

    func testFormattedDateWithInvalidString() {
        let result = SharedSessionView.formattedDate("not-a-date")
        // Should return the raw string when parsing fails
        XCTAssertEqual(result, "not-a-date")
    }

    func testFormattedDateWithEmptyString() {
        let result = SharedSessionView.formattedDate("")
        XCTAssertEqual(result, "")
    }

    func testFormattedDateRecentUsesRelativeTime() {
        // Create an ISO 8601 date string for 1 hour ago
        let oneHourAgo = Date().addingTimeInterval(-3600)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: oneHourAgo)

        let result = SharedSessionView.formattedDate(dateString)
        XCTAssertFalse(result.isEmpty)
        // Relative time for 1 hour ago typically contains "hr" or "hour" or similar
        // It should NOT be a full date format
        XCTAssertFalse(result.contains("202"), "Expected relative time, got full date: \(result)")
    }

    func testFormattedDateOlderThan7DaysUsesFullDate() {
        // Create an ISO 8601 date string for 10 days ago
        let tenDaysAgo = Date().addingTimeInterval(-10 * 24 * 3600)
        let formatter = ISO8601DateFormatter()
        let dateString = formatter.string(from: tenDaysAgo)

        let result = SharedSessionView.formattedDate(dateString)
        XCTAssertFalse(result.isEmpty)
        // Full date format should include time components
        XCTAssertNotEqual(result, dateString)
    }

    // MARK: - Markdown String

    func testMarkdownStringParsesBasicMarkdown() {
        let result = SharedSessionView.markdownString("Hello **world**")
        let plainText = String(result.characters)
        XCTAssertEqual(plainText, "Hello world")
    }

    func testMarkdownStringPreservesPlainText() {
        let result = SharedSessionView.markdownString("Simple text")
        let plainText = String(result.characters)
        XCTAssertEqual(plainText, "Simple text")
    }

    func testMarkdownStringHandlesEmptyString() {
        let result = SharedSessionView.markdownString("")
        let plainText = String(result.characters)
        XCTAssertEqual(plainText, "")
    }

    func testMarkdownStringParsesInlineCode() {
        let result = SharedSessionView.markdownString("Use `torch.compile` for this")
        let plainText = String(result.characters)
        XCTAssertEqual(plainText, "Use torch.compile for this")
    }

    func testMarkdownStringPreservesWhitespace() {
        let result = SharedSessionView.markdownString("Line 1\nLine 2")
        let plainText = String(result.characters)
        XCTAssertTrue(plainText.contains("Line 1"))
        XCTAssertTrue(plainText.contains("Line 2"))
    }

    // MARK: - Message Count Text

    func testMessageCountTextSingular() {
        XCTAssertEqual(SharedSessionView.messageCountText(1), "1 message")
    }

    func testMessageCountTextPlural() {
        XCTAssertEqual(SharedSessionView.messageCountText(2), "2 messages")
    }

    func testMessageCountTextZero() {
        XCTAssertEqual(SharedSessionView.messageCountText(0), "0 messages")
    }

    func testMessageCountTextLargeNumber() {
        XCTAssertEqual(SharedSessionView.messageCountText(100), "100 messages")
    }

    // MARK: - SharedSession Decoding

    func testSharedSessionDecodingFullResponse() {
        let json = """
        {
            "session_id": "sess-abc-123",
            "title": "CI Status Discussion",
            "shared_by": "pytorch-dev",
            "shared_at": "2025-01-20T14:30:00Z",
            "messages": [
                {
                    "role": "user",
                    "content": "What are the current failures?",
                    "tool_uses": []
                },
                {
                    "role": "assistant",
                    "content": "I found **3 failures** on main.",
                    "tool_uses": [
                        {
                            "name": "clickhouse_query",
                            "input": "SELECT count() FROM failures",
                            "output": "3"
                        }
                    ]
                }
            ]
        }
        """

        let session: SharedSession = MockData.decode(json)

        XCTAssertEqual(session.sessionId, "sess-abc-123")
        XCTAssertEqual(session.title, "CI Status Discussion")
        XCTAssertEqual(session.sharedBy, "pytorch-dev")
        XCTAssertEqual(session.sharedAt, "2025-01-20T14:30:00Z")
        XCTAssertEqual(session.messages?.count, 2)
    }

    func testSharedSessionDecodingMinimalResponse() {
        let json = """
        {
            "session_id": null,
            "title": null,
            "shared_by": null,
            "shared_at": null,
            "messages": null
        }
        """

        let session: SharedSession = MockData.decode(json)

        XCTAssertNil(session.sessionId)
        XCTAssertNil(session.title)
        XCTAssertNil(session.sharedBy)
        XCTAssertNil(session.sharedAt)
        XCTAssertNil(session.messages)
    }

    func testSharedSessionDecodingEmptyMessages() {
        let json = """
        {
            "session_id": "s1",
            "title": "Empty Session",
            "messages": []
        }
        """

        let session: SharedSession = MockData.decode(json)

        XCTAssertNotNil(session.messages)
        XCTAssertTrue(session.messages?.isEmpty ?? false)
    }

    // MARK: - SharedMessage Decoding

    func testSharedMessageDecodingUserMessage() {
        let json = """
        {
            "role": "user",
            "content": "Hello, agent!",
            "tool_uses": null
        }
        """

        let message: SharedMessage = MockData.decode(json)

        XCTAssertEqual(message.role, "user")
        XCTAssertEqual(message.content, "Hello, agent!")
        XCTAssertNil(message.toolUses)
    }

    func testSharedMessageDecodingAssistantMessage() {
        let json = """
        {
            "role": "assistant",
            "content": "Here are the results.",
            "tool_uses": [
                {
                    "name": "search_hud",
                    "input": "failures on main",
                    "output": "Found 5 failures"
                }
            ]
        }
        """

        let message: SharedMessage = MockData.decode(json)

        XCTAssertEqual(message.role, "assistant")
        XCTAssertEqual(message.content, "Here are the results.")
        XCTAssertEqual(message.toolUses?.count, 1)
        XCTAssertEqual(message.toolUses?.first?.name, "search_hud")
        XCTAssertEqual(message.toolUses?.first?.input, "failures on main")
        XCTAssertEqual(message.toolUses?.first?.output, "Found 5 failures")
    }

    func testSharedMessageDecodingNullContent() {
        let json = """
        {
            "role": "assistant",
            "content": null,
            "tool_uses": []
        }
        """

        let message: SharedMessage = MockData.decode(json)

        XCTAssertEqual(message.role, "assistant")
        XCTAssertNil(message.content)
        XCTAssertNotNil(message.toolUses)
        XCTAssertTrue(message.toolUses?.isEmpty ?? false)
    }

    func testSharedMessageHasUniqueId() {
        let json = """
        {
            "role": "user",
            "content": "test"
        }
        """

        let message1: SharedMessage = MockData.decode(json)
        let message2: SharedMessage = MockData.decode(json)

        // Each decoded message should get a unique UUID
        XCTAssertNotEqual(message1.id, message2.id)
    }

    // MARK: - SharedToolUse Decoding

    func testSharedToolUseDecodingComplete() {
        let json = """
        {
            "name": "bash_command",
            "input": "ls -la",
            "output": "total 42\\ndrwxr-xr-x  5 user  staff  160 Jan 20 14:30 ."
        }
        """

        let toolUse: SharedToolUse = MockData.decode(json)

        XCTAssertEqual(toolUse.name, "bash_command")
        XCTAssertEqual(toolUse.input, "ls -la")
        XCTAssertNotNil(toolUse.output)
    }

    func testSharedToolUseDecodingAllNull() {
        let json = """
        {
            "name": null,
            "input": null,
            "output": null
        }
        """

        let toolUse: SharedToolUse = MockData.decode(json)

        XCTAssertNil(toolUse.name)
        XCTAssertNil(toolUse.input)
        XCTAssertNil(toolUse.output)
    }

    func testSharedToolUseHasUniqueId() {
        let json = """
        {
            "name": "test",
            "input": "input",
            "output": "output"
        }
        """

        let tool1: SharedToolUse = MockData.decode(json)
        let tool2: SharedToolUse = MockData.decode(json)

        XCTAssertNotEqual(tool1.id, tool2.id)
    }

    // MARK: - Fetch Shared Session

    @MainActor
    func testFetchSharedSessionSuccess() async {
        let mockClient = MockAPIClient()
        let json = """
        {
            "session_id": "sess-test",
            "title": "Test Session",
            "shared_by": "tester",
            "shared_at": "2025-01-20T14:30:00Z",
            "messages": [
                {
                    "role": "user",
                    "content": "Hello"
                }
            ]
        }
        """
        mockClient.setResponse(json, for: "/api/torchagent-get-shared/test-uuid")

        var view = SharedSessionView(uuid: "test-uuid", apiClient: mockClient)
        await view.fetchSharedSession()

        // Verify the correct endpoint was called
        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, "/api/torchagent-get-shared/test-uuid")
    }

    @MainActor
    func testFetchSharedSessionError() async {
        let mockClient = MockAPIClient()
        mockClient.setError(APIError.notFound, for: "/api/torchagent-get-shared/bad-uuid")

        var view = SharedSessionView(uuid: "bad-uuid", apiClient: mockClient)
        await view.fetchSharedSession()

        // Verify the correct endpoint was called
        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths().first, "/api/torchagent-get-shared/bad-uuid")
    }

    @MainActor
    func testFetchSharedSessionCallsCorrectEndpoint() async {
        let mockClient = MockAPIClient()
        let json = """
        {
            "session_id": "s1",
            "title": null,
            "messages": []
        }
        """
        mockClient.setResponse(json, for: "/api/torchagent-get-shared/my-uuid-456")

        var view = SharedSessionView(uuid: "my-uuid-456", apiClient: mockClient)
        await view.fetchSharedSession()

        let recorded = mockClient.recordedCalls.first
        XCTAssertEqual(recorded?.path, "/api/torchagent-get-shared/my-uuid-456")
        XCTAssertEqual(recorded?.method, "GET")
    }

    // MARK: - API Endpoint

    func testTorchAgentSharedEndpointPath() {
        let endpoint = APIEndpoint.torchAgentShared(uuid: "shared-uuid-789")
        XCTAssertEqual(endpoint.path, "/api/torchagent-get-shared/shared-uuid-789")
        XCTAssertEqual(endpoint.method, .GET)
        XCTAssertNil(endpoint.queryItems)
        XCTAssertNil(endpoint.body)
    }

    func testTorchAgentSharedEndpointDefaultTimeout() {
        let endpoint = APIEndpoint.torchAgentShared(uuid: "test")
        XCTAssertEqual(endpoint.timeout, 30)
    }

    // MARK: - Multiple Messages with Tool Uses

    func testComplexSessionDecoding() {
        let json = """
        {
            "session_id": "complex-sess",
            "title": "Complex Debugging Session",
            "shared_by": "senior-dev",
            "shared_at": "2025-06-15T10:00:00Z",
            "messages": [
                {
                    "role": "user",
                    "content": "Why is CI broken?"
                },
                {
                    "role": "assistant",
                    "content": "Let me investigate the CI failures.",
                    "tool_uses": [
                        {
                            "name": "clickhouse_query",
                            "input": "SELECT * FROM failures WHERE branch='main'",
                            "output": "Found 5 failures"
                        },
                        {
                            "name": "github_api",
                            "input": "GET /repos/pytorch/pytorch/pulls/12345",
                            "output": "PR #12345: Fix distributed test"
                        }
                    ]
                },
                {
                    "role": "user",
                    "content": "Can you fix it?"
                },
                {
                    "role": "assistant",
                    "content": "The issue is a **flaky test** in `test_distributed_nccl`.",
                    "tool_uses": []
                }
            ]
        }
        """

        let session: SharedSession = MockData.decode(json)

        XCTAssertEqual(session.messages?.count, 4)

        let userMessages = session.messages?.filter { $0.role == "user" } ?? []
        let assistantMessages = session.messages?.filter { $0.role == "assistant" } ?? []
        XCTAssertEqual(userMessages.count, 2)
        XCTAssertEqual(assistantMessages.count, 2)

        // First assistant message should have 2 tool uses
        let firstAssistant = session.messages?[1]
        XCTAssertEqual(firstAssistant?.toolUses?.count, 2)
        XCTAssertEqual(firstAssistant?.toolUses?[0].name, "clickhouse_query")
        XCTAssertEqual(firstAssistant?.toolUses?[1].name, "github_api")

        // Second assistant message should have empty tool uses
        let secondAssistant = session.messages?[3]
        XCTAssertTrue(secondAssistant?.toolUses?.isEmpty ?? true)
    }

    // MARK: - Edge Cases

    func testSharedSessionWithOnlyToolUseMessages() {
        let json = """
        {
            "session_id": "tool-only",
            "title": null,
            "messages": [
                {
                    "role": "assistant",
                    "content": null,
                    "tool_uses": [
                        {
                            "name": "bash",
                            "input": "echo hello",
                            "output": "hello"
                        }
                    ]
                }
            ]
        }
        """

        let session: SharedSession = MockData.decode(json)
        let message = session.messages?.first

        XCTAssertNil(message?.content)
        XCTAssertEqual(message?.toolUses?.count, 1)
    }

    func testSharedToolUseWithNoOutput() {
        let json = """
        {
            "name": "long_running_query",
            "input": "SELECT * FROM big_table",
            "output": null
        }
        """

        let toolUse: SharedToolUse = MockData.decode(json)

        XCTAssertEqual(toolUse.name, "long_running_query")
        XCTAssertNotNil(toolUse.input)
        XCTAssertNil(toolUse.output)
    }
}
