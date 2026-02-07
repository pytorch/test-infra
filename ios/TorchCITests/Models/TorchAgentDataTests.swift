import XCTest
@testable import TorchCI

final class TorchAgentDataTests: XCTestCase {

    // MARK: - TorchAgentMessage

    func testMessageHasUniqueId() {
        let msg1 = TorchAgentMessage(
            role: .user,
            content: "Hello",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )
        let msg2 = TorchAgentMessage(
            role: .user,
            content: "Hello",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )
        XCTAssertNotEqual(msg1.id, msg2.id)
    }

    func testMessageRoleValues() {
        XCTAssertEqual(TorchAgentMessage.MessageRole.user.rawValue, "user")
        XCTAssertEqual(TorchAgentMessage.MessageRole.assistant.rawValue, "assistant")
    }

    func testMessageWithToolUses() {
        let toolUse = ToolUseBlock(
            toolName: "search",
            input: "query",
            output: "result",
            isExpanded: true
        )
        let msg = TorchAgentMessage(
            role: .assistant,
            content: "Found it",
            toolUses: [toolUse],
            thinkingContent: "Thinking...",
            timestamp: Date()
        )
        XCTAssertEqual(msg.toolUses.count, 1)
        XCTAssertEqual(msg.toolUses.first?.toolName, "search")
        XCTAssertEqual(msg.thinkingContent, "Thinking...")
    }

    // MARK: - ToolUseBlock

    func testToolUseBlockHasUniqueId() {
        let block1 = ToolUseBlock(toolName: "a", input: "b", output: nil, isExpanded: false)
        let block2 = ToolUseBlock(toolName: "a", input: "b", output: nil, isExpanded: false)
        XCTAssertNotEqual(block1.id, block2.id)
    }

    func testToolUseBlockProperties() {
        let block = ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT count() FROM jobs",
            output: "42",
            isExpanded: true
        )
        XCTAssertEqual(block.toolName, "clickhouse_query")
        XCTAssertEqual(block.input, "SELECT count() FROM jobs")
        XCTAssertEqual(block.output, "42")
        XCTAssertTrue(block.isExpanded)
    }

    func testToolUseBlockWithNilOutput() {
        let block = ToolUseBlock(
            toolName: "bash",
            input: "echo hello",
            output: nil,
            isExpanded: false
        )
        XCTAssertNil(block.output)
    }

    // MARK: - TorchAgentSession Decoding

    func testSessionDecoding() throws {
        let json = """
        {
            "session_id": "sess-123",
            "title": "CI Analysis",
            "created_at": "2026-01-15T10:30:00Z",
            "updated_at": "2026-01-15T11:00:00Z",
            "message_count": 8
        }
        """
        let data = Data(json.utf8)
        let session = try JSONDecoder().decode(TorchAgentSession.self, from: data)

        XCTAssertEqual(session.sessionId, "sess-123")
        XCTAssertEqual(session.title, "CI Analysis")
        XCTAssertEqual(session.createdAt, "2026-01-15T10:30:00Z")
        XCTAssertEqual(session.updatedAt, "2026-01-15T11:00:00Z")
        XCTAssertEqual(session.messageCount, 8)
        XCTAssertEqual(session.id, "sess-123")
    }

    func testSessionDecodingMinimalFields() throws {
        let json = """
        {"session_id": "minimal"}
        """
        let data = Data(json.utf8)
        let session = try JSONDecoder().decode(TorchAgentSession.self, from: data)

        XCTAssertEqual(session.sessionId, "minimal")
        XCTAssertNil(session.title)
        XCTAssertNil(session.createdAt)
        XCTAssertNil(session.updatedAt)
        XCTAssertNil(session.messageCount)
    }

    func testSessionDisplayDateWithValidISO8601() {
        // Create a session with a recent date so we get a relative string
        let formatter = ISO8601DateFormatter()
        let recentDate = Calendar.current.date(byAdding: .hour, value: -2, to: Date())!
        let dateString = formatter.string(from: recentDate)

        let session = TorchAgentSession(
            sessionId: "s1",
            title: nil,
            createdAt: dateString,
            updatedAt: nil,
            messageCount: nil
        )

        let display = session.displayDate
        // Should be a non-empty relative date string
        XCTAssertFalse(display.isEmpty)
    }

    func testSessionDisplayDateWithNilDate() {
        let session = TorchAgentSession(
            sessionId: "s2",
            title: nil,
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )
        XCTAssertEqual(session.displayDate, "")
    }

    func testSessionDisplayDateWithInvalidDate() {
        let session = TorchAgentSession(
            sessionId: "s3",
            title: nil,
            createdAt: "not-a-date",
            updatedAt: nil,
            messageCount: nil
        )
        // Falls back to the raw string
        XCTAssertEqual(session.displayDate, "not-a-date")
    }

    // MARK: - TorchAgentStreamChunk Decoding

    func testStreamChunkTextDecoding() throws {
        let json = #"{"type":"text","content":"Hello world"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.type, "text")
        XCTAssertEqual(chunk.content, "Hello world")
        XCTAssertNil(chunk.toolName)
        XCTAssertNil(chunk.sessionId)
        XCTAssertNil(chunk.done)
    }

    func testStreamChunkToolUseDecoding() throws {
        let json = """
        {
            "type": "tool_use",
            "tool_name": "search_hud",
            "tool_input": "query string"
        }
        """
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.type, "tool_use")
        XCTAssertEqual(chunk.toolName, "search_hud")
        XCTAssertEqual(chunk.toolInput, "query string")
    }

    func testStreamChunkToolResultDecoding() throws {
        let json = #"{"type":"tool_result","tool_result":"Found 5 results"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.type, "tool_result")
        XCTAssertEqual(chunk.toolResult, "Found 5 results")
    }

    func testStreamChunkThinkingDecoding() throws {
        let json = #"{"type":"thinking","thinking_content":"Let me reason about this..."}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.type, "thinking")
        XCTAssertEqual(chunk.thinkingContent, "Let me reason about this...")
    }

    func testStreamChunkDoneDecoding() throws {
        let json = #"{"type":"done","done":true}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.type, "done")
        XCTAssertEqual(chunk.done, true)
    }

    func testStreamChunkSessionIdDecoding() throws {
        let json = #"{"type":"text","content":"hi","session_id":"sess-abc"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(chunk.sessionId, "sess-abc")
    }

    func testStreamChunkMinimalDecoding() throws {
        // All fields optional
        let json = #"{}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(chunk.type)
        XCTAssertNil(chunk.content)
        XCTAssertNil(chunk.toolName)
        XCTAssertNil(chunk.toolInput)
        XCTAssertNil(chunk.toolResult)
        XCTAssertNil(chunk.thinkingContent)
        XCTAssertNil(chunk.sessionId)
        XCTAssertNil(chunk.done)
    }

    // MARK: - TorchAgentPermission Decoding

    func testPermissionAuthorizedDecoding() throws {
        let json = #"{"authorized":true,"username":"pytorch-dev"}"#
        let permission = try JSONDecoder().decode(
            TorchAgentPermission.self,
            from: Data(json.utf8)
        )
        XCTAssertTrue(permission.authorized)
        XCTAssertEqual(permission.username, "pytorch-dev")
    }

    func testPermissionUnauthorizedDecoding() throws {
        let json = #"{"authorized":false}"#
        let permission = try JSONDecoder().decode(
            TorchAgentPermission.self,
            from: Data(json.utf8)
        )
        XCTAssertFalse(permission.authorized)
        XCTAssertNil(permission.username)
    }

    // MARK: - SharedSession Decoding

    func testSharedSessionDecoding() throws {
        let json = """
        {
            "session_id": "shared-sess",
            "title": "Shared Analysis",
            "shared_by": "user123",
            "shared_at": "2026-01-20T15:00:00Z",
            "messages": [
                {"role": "user", "content": "What failed?"},
                {
                    "role": "assistant",
                    "content": "Two jobs failed",
                    "tool_uses": [
                        {"name": "clickhouse_query", "input": "SELECT *", "output": "results"}
                    ]
                }
            ]
        }
        """
        let session = try JSONDecoder().decode(SharedSession.self, from: Data(json.utf8))

        XCTAssertEqual(session.sessionId, "shared-sess")
        XCTAssertEqual(session.title, "Shared Analysis")
        XCTAssertEqual(session.sharedBy, "user123")
        XCTAssertEqual(session.sharedAt, "2026-01-20T15:00:00Z")
        XCTAssertEqual(session.messages?.count, 2)
    }

    func testSharedSessionMinimalDecoding() throws {
        let json = "{}"
        let session = try JSONDecoder().decode(SharedSession.self, from: Data(json.utf8))

        XCTAssertNil(session.sessionId)
        XCTAssertNil(session.title)
        XCTAssertNil(session.sharedBy)
        XCTAssertNil(session.sharedAt)
        XCTAssertNil(session.messages)
    }

    // MARK: - SharedMessage Decoding

    func testSharedMessageDecoding() throws {
        let json = """
        {
            "role": "assistant",
            "content": "Here are the results",
            "tool_uses": [
                {"name": "search", "input": "query", "output": "found"}
            ]
        }
        """
        let msg = try JSONDecoder().decode(SharedMessage.self, from: Data(json.utf8))

        XCTAssertEqual(msg.role, "assistant")
        XCTAssertEqual(msg.content, "Here are the results")
        XCTAssertEqual(msg.toolUses?.count, 1)
        XCTAssertEqual(msg.toolUses?.first?.name, "search")
    }

    func testSharedMessageHasUniqueId() throws {
        let json = #"{"role": "user", "content": "test"}"#
        let msg1 = try JSONDecoder().decode(SharedMessage.self, from: Data(json.utf8))
        let msg2 = try JSONDecoder().decode(SharedMessage.self, from: Data(json.utf8))
        XCTAssertNotEqual(msg1.id, msg2.id)
    }

    // MARK: - SharedToolUse Decoding

    func testSharedToolUseDecoding() throws {
        let json = #"{"name": "bash", "input": "ls -la", "output": "file1\nfile2"}"#
        let tool = try JSONDecoder().decode(SharedToolUse.self, from: Data(json.utf8))

        XCTAssertEqual(tool.name, "bash")
        XCTAssertEqual(tool.input, "ls -la")
        XCTAssertEqual(tool.output, "file1\nfile2")
    }

    func testSharedToolUseMinimalDecoding() throws {
        let json = "{}"
        let tool = try JSONDecoder().decode(SharedToolUse.self, from: Data(json.utf8))

        XCTAssertNil(tool.name)
        XCTAssertNil(tool.input)
        XCTAssertNil(tool.output)
    }

    func testSharedToolUseHasUniqueId() throws {
        let json = #"{"name": "tool"}"#
        let tool1 = try JSONDecoder().decode(SharedToolUse.self, from: Data(json.utf8))
        let tool2 = try JSONDecoder().decode(SharedToolUse.self, from: Data(json.utf8))
        XCTAssertNotEqual(tool1.id, tool2.id)
    }

    // MARK: - Session Array Decoding

    func testSessionArrayDecoding() throws {
        let json = """
        [
            {"session_id": "s1", "title": "First", "message_count": 3},
            {"session_id": "s2", "title": "Second"},
            {"session_id": "s3", "message_count": 10}
        ]
        """
        let sessions = try JSONDecoder().decode(
            [TorchAgentSession].self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(sessions.count, 3)
        XCTAssertEqual(sessions[0].title, "First")
        XCTAssertEqual(sessions[0].messageCount, 3)
        XCTAssertNil(sessions[1].messageCount)
        XCTAssertNil(sessions[2].title)
        XCTAssertEqual(sessions[2].messageCount, 10)
    }
}
