import XCTest
@testable import TorchCI

/// Tests for TorchAgentMessage model, ChatMessageView logic, and component helpers.
final class ChatMessageViewTests: XCTestCase {

    // MARK: - TorchAgentMessage Model Tests

    func testUserMessageCreation() {
        let message = TorchAgentMessage(
            role: .user,
            content: "Hello world",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )

        XCTAssertEqual(message.role, .user)
        XCTAssertEqual(message.content, "Hello world")
        XCTAssertTrue(message.toolUses.isEmpty)
        XCTAssertNil(message.thinkingContent)
        XCTAssertFalse(message.id.uuidString.isEmpty)
    }

    func testAssistantMessageCreation() {
        let toolUse = ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT count() FROM jobs",
            output: "42",
            isExpanded: false
        )

        let message = TorchAgentMessage(
            role: .assistant,
            content: "Found **42** jobs.",
            toolUses: [toolUse],
            thinkingContent: "Analyzing CI data...",
            timestamp: Date()
        )

        XCTAssertEqual(message.role, .assistant)
        XCTAssertEqual(message.content, "Found **42** jobs.")
        XCTAssertEqual(message.toolUses.count, 1)
        XCTAssertEqual(message.thinkingContent, "Analyzing CI data...")
    }

    func testMessageWithEmptyContent() {
        let message = TorchAgentMessage(
            role: .assistant,
            content: "",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )

        XCTAssertTrue(message.content.isEmpty)
    }

    func testMessageUniqueIds() {
        let message1 = TorchAgentMessage(
            role: .user,
            content: "Same text",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )
        let message2 = TorchAgentMessage(
            role: .user,
            content: "Same text",
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )

        XCTAssertNotEqual(message1.id, message2.id)
    }

    func testMessageRoleRawValues() {
        XCTAssertEqual(TorchAgentMessage.MessageRole.user.rawValue, "user")
        XCTAssertEqual(TorchAgentMessage.MessageRole.assistant.rawValue, "assistant")
    }

    // MARK: - ToolUseBlock Model Tests

    func testToolUseBlockCreation() {
        let toolUse = ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT * FROM jobs",
            output: "3 rows",
            isExpanded: false
        )

        XCTAssertEqual(toolUse.toolName, "clickhouse_query")
        XCTAssertEqual(toolUse.input, "SELECT * FROM jobs")
        XCTAssertEqual(toolUse.output, "3 rows")
        XCTAssertFalse(toolUse.isExpanded)
    }

    func testToolUseBlockWithNilOutput() {
        let toolUse = ToolUseBlock(
            toolName: "bash_command",
            input: "echo hello",
            output: nil,
            isExpanded: false
        )

        XCTAssertNil(toolUse.output)
    }

    func testToolUseBlockUniqueIds() {
        let toolUse1 = ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT 1",
            output: "1",
            isExpanded: false
        )
        let toolUse2 = ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT 1",
            output: "1",
            isExpanded: false
        )

        XCTAssertNotEqual(toolUse1.id, toolUse2.id)
    }

    func testToolUseBlockWithEmptyInput() {
        let toolUse = ToolUseBlock(
            toolName: "search",
            input: "",
            output: "No results",
            isExpanded: false
        )

        XCTAssertTrue(toolUse.input.isEmpty)
    }

    // MARK: - Timestamp Formatting Tests

    func testFormatTimestampReturnsNonEmptyString() {
        let now = Date()
        let result = ChatMessageView.formatTimestamp(now)
        XCTAssertFalse(result.isEmpty, "Formatted timestamp should not be empty")
    }

    func testFormatTimestampConsistentForSameDate() {
        let date = Date(timeIntervalSince1970: 1700000000) // Fixed date
        let result1 = ChatMessageView.formatTimestamp(date)
        let result2 = ChatMessageView.formatTimestamp(date)
        XCTAssertEqual(result1, result2, "Same date should produce same formatted string")
    }

    func testFormatTimestampDifferentForDifferentTimes() {
        let date1 = Date(timeIntervalSince1970: 1700000000)
        let date2 = Date(timeIntervalSince1970: 1700003600) // 1 hour later
        let result1 = ChatMessageView.formatTimestamp(date1)
        let result2 = ChatMessageView.formatTimestamp(date2)
        XCTAssertNotEqual(result1, result2, "Different times should produce different strings")
    }

    // MARK: - ToolUseView Metadata Tests

    func testIconForClickhouseQuery() {
        let view = ToolUseView(toolUse: makeToolUse(name: "clickhouse_query"))
        XCTAssertEqual(view.iconForTool("clickhouse_query"), "cylinder.split.1x2")
    }

    func testIconForSQLQuery() {
        let view = ToolUseView(toolUse: makeToolUse(name: "sql_query"))
        XCTAssertEqual(view.iconForTool("sql_query"), "cylinder.split.1x2")
    }

    func testIconForGrafana() {
        let view = ToolUseView(toolUse: makeToolUse(name: "grafana_dashboard"))
        XCTAssertEqual(view.iconForTool("grafana_dashboard"), "chart.xyaxis.line")
    }

    func testIconForChartTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "chart_render"))
        XCTAssertEqual(view.iconForTool("chart_render"), "chart.xyaxis.line")
    }

    func testIconForGraphTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "graph_data"))
        XCTAssertEqual(view.iconForTool("graph_data"), "chart.xyaxis.line")
    }

    func testIconForBashCommand() {
        let view = ToolUseView(toolUse: makeToolUse(name: "bash_command"))
        XCTAssertEqual(view.iconForTool("bash_command"), "terminal")
    }

    func testIconForShellExec() {
        let view = ToolUseView(toolUse: makeToolUse(name: "shell_exec"))
        XCTAssertEqual(view.iconForTool("shell_exec"), "terminal")
    }

    func testIconForExecCommand() {
        let view = ToolUseView(toolUse: makeToolUse(name: "exec_tool"))
        XCTAssertEqual(view.iconForTool("exec_tool"), "terminal")
    }

    func testIconForGitHub() {
        let view = ToolUseView(toolUse: makeToolUse(name: "github_api"))
        XCTAssertEqual(view.iconForTool("github_api"), "chevron.left.forwardslash.chevron.right")
    }

    func testIconForPRTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "pr_review"))
        XCTAssertEqual(view.iconForTool("pr_review"), "chevron.left.forwardslash.chevron.right")
    }

    func testIconForIssueTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "issue_lookup"))
        XCTAssertEqual(view.iconForTool("issue_lookup"), "chevron.left.forwardslash.chevron.right")
    }

    func testIconForSearch() {
        let view = ToolUseView(toolUse: makeToolUse(name: "search_hud"))
        XCTAssertEqual(view.iconForTool("search_hud"), "magnifyingglass")
    }

    func testIconForFindTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "find_results"))
        XCTAssertEqual(view.iconForTool("find_results"), "magnifyingglass")
    }

    func testIconForUnknownTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "some_random_tool"))
        XCTAssertEqual(view.iconForTool("some_random_tool"), "wrench")
    }

    // MARK: - Color for Tool Tests

    func testColorForClickhouse() {
        let view = ToolUseView(toolUse: makeToolUse(name: "clickhouse_query"))
        XCTAssertEqual(view.colorForTool("clickhouse_query"), .orange)
    }

    func testColorForSQLTool() {
        let view = ToolUseView(toolUse: makeToolUse(name: "sql_runner"))
        XCTAssertEqual(view.colorForTool("sql_runner"), .orange)
    }

    func testColorForGrafana() {
        let view = ToolUseView(toolUse: makeToolUse(name: "grafana"))
        XCTAssertEqual(view.colorForTool("grafana"), .purple)
    }

    func testColorForBash() {
        let view = ToolUseView(toolUse: makeToolUse(name: "bash"))
        XCTAssertEqual(view.colorForTool("bash"), .green)
    }

    func testColorForGitHub() {
        let view = ToolUseView(toolUse: makeToolUse(name: "github"))
        XCTAssertEqual(view.colorForTool("github"), .indigo)
    }

    func testColorForUnknown() {
        let view = ToolUseView(toolUse: makeToolUse(name: "unknown"))
        XCTAssertEqual(view.colorForTool("unknown"), .blue)
    }

    // MARK: - Display Name Tests

    func testDisplayNameForClickhouse() {
        let view = ToolUseView(toolUse: makeToolUse(name: "clickhouse_query"))
        XCTAssertEqual(view.displayNameForTool("clickhouse_query"), "ClickHouse Query")
    }

    func testDisplayNameForGrafana() {
        let view = ToolUseView(toolUse: makeToolUse(name: "grafana_dashboard"))
        XCTAssertEqual(view.displayNameForTool("grafana_dashboard"), "Grafana")
    }

    func testDisplayNameForBash() {
        let view = ToolUseView(toolUse: makeToolUse(name: "bash_command"))
        XCTAssertEqual(view.displayNameForTool("bash_command"), "Bash Command")
    }

    func testDisplayNameForShell() {
        let view = ToolUseView(toolUse: makeToolUse(name: "shell_exec"))
        XCTAssertEqual(view.displayNameForTool("shell_exec"), "Bash Command")
    }

    func testDisplayNameForGitHub() {
        let view = ToolUseView(toolUse: makeToolUse(name: "github_api"))
        XCTAssertEqual(view.displayNameForTool("github_api"), "GitHub API")
    }

    func testDisplayNameForSearch() {
        let view = ToolUseView(toolUse: makeToolUse(name: "search_hud"))
        XCTAssertEqual(view.displayNameForTool("search_hud"), "Search")
    }

    func testDisplayNameForUnknownUsesRawName() {
        let view = ToolUseView(toolUse: makeToolUse(name: "custom_analyzer"))
        XCTAssertEqual(view.displayNameForTool("custom_analyzer"), "custom_analyzer")
    }

    func testDisplayNameCaseInsensitive() {
        let view = ToolUseView(toolUse: makeToolUse(name: "ClickHouse_Query"))
        XCTAssertEqual(view.displayNameForTool("ClickHouse_Query"), "ClickHouse Query")
    }

    // MARK: - TorchAgentSession Tests

    func testSessionDisplayDateWithValidISO8601() {
        let session = TorchAgentSession(
            sessionId: "s1",
            title: "Test",
            createdAt: ISO8601DateFormatter().string(from: Date()),
            updatedAt: nil,
            messageCount: 5
        )

        XCTAssertFalse(session.displayDate.isEmpty)
    }

    func testSessionDisplayDateWithNilCreatedAt() {
        let session = TorchAgentSession(
            sessionId: "s1",
            title: "Test",
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        XCTAssertEqual(session.displayDate, "")
    }

    func testSessionDisplayDateWithInvalidDate() {
        let session = TorchAgentSession(
            sessionId: "s1",
            title: "Test",
            createdAt: "not-a-date",
            updatedAt: nil,
            messageCount: nil
        )

        // Falls back to returning the raw string
        XCTAssertEqual(session.displayDate, "not-a-date")
    }

    func testSessionIdProperty() {
        let session = TorchAgentSession(
            sessionId: "abc-123",
            title: nil,
            createdAt: nil,
            updatedAt: nil,
            messageCount: nil
        )

        XCTAssertEqual(session.id, "abc-123")
        XCTAssertEqual(session.id, session.sessionId)
    }

    // MARK: - TorchAgentStreamChunk Decoding Tests

    func testDecodeTextChunk() throws {
        let json = #"{"type":"text","content":"Hello world"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "text")
        XCTAssertEqual(chunk.content, "Hello world")
        XCTAssertNil(chunk.toolName)
        XCTAssertNil(chunk.done)
    }

    func testDecodeToolUseChunk() throws {
        let json = #"{"type":"tool_use","tool_name":"clickhouse_query","tool_input":"SELECT 1"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "tool_use")
        XCTAssertEqual(chunk.toolName, "clickhouse_query")
        XCTAssertEqual(chunk.toolInput, "SELECT 1")
    }

    func testDecodeToolResultChunk() throws {
        let json = #"{"type":"tool_result","tool_result":"Found 5 results"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "tool_result")
        XCTAssertEqual(chunk.toolResult, "Found 5 results")
    }

    func testDecodeThinkingChunk() throws {
        let json = #"{"type":"thinking","thinking_content":"Let me analyze..."}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "thinking")
        XCTAssertEqual(chunk.thinkingContent, "Let me analyze...")
    }

    func testDecodeDoneChunk() throws {
        let json = #"{"type":"done","done":true}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "done")
        XCTAssertEqual(chunk.done, true)
    }

    func testDecodeChunkWithSessionId() throws {
        let json = #"{"type":"text","content":"Hi","session_id":"sess-456"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.sessionId, "sess-456")
    }

    func testDecodeErrorChunk() throws {
        let json = #"{"type":"error","content":"Rate limit exceeded"}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(chunk.type, "error")
        XCTAssertEqual(chunk.content, "Rate limit exceeded")
    }

    func testDecodeMinimalChunk() throws {
        let json = #"{}"#
        let chunk = try JSONDecoder().decode(
            TorchAgentStreamChunk.self,
            from: Data(json.utf8)
        )

        XCTAssertNil(chunk.type)
        XCTAssertNil(chunk.content)
        XCTAssertNil(chunk.toolName)
        XCTAssertNil(chunk.done)
    }

    // MARK: - TorchAgentSession Decoding Tests

    func testDecodeSession() throws {
        let json = """
        {
            "session_id": "sess-1",
            "title": "CI Analysis",
            "created_at": "2024-01-15T10:30:00Z",
            "updated_at": "2024-01-15T11:00:00Z",
            "message_count": 12
        }
        """
        let session = try JSONDecoder().decode(
            TorchAgentSession.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(session.sessionId, "sess-1")
        XCTAssertEqual(session.title, "CI Analysis")
        XCTAssertEqual(session.createdAt, "2024-01-15T10:30:00Z")
        XCTAssertEqual(session.updatedAt, "2024-01-15T11:00:00Z")
        XCTAssertEqual(session.messageCount, 12)
    }

    func testDecodeSessionWithMissingOptionalFields() throws {
        let json = #"{"session_id":"s2"}"#
        let session = try JSONDecoder().decode(
            TorchAgentSession.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(session.sessionId, "s2")
        XCTAssertNil(session.title)
        XCTAssertNil(session.createdAt)
        XCTAssertNil(session.updatedAt)
        XCTAssertNil(session.messageCount)
    }

    // MARK: - SharedSession / SharedMessage Decoding Tests

    func testDecodeSharedSession() throws {
        let json = """
        {
            "session_id": "shared-1",
            "title": "Shared Chat",
            "messages": [
                {"role": "user", "content": "What is CI?"},
                {"role": "assistant", "content": "CI is Continuous Integration."}
            ],
            "shared_by": "developer",
            "shared_at": "2024-06-01T12:00:00Z"
        }
        """
        let session = try JSONDecoder().decode(
            SharedSession.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(session.sessionId, "shared-1")
        XCTAssertEqual(session.title, "Shared Chat")
        XCTAssertEqual(session.messages?.count, 2)
        XCTAssertEqual(session.sharedBy, "developer")
        XCTAssertEqual(session.messages?.first?.role, "user")
        XCTAssertEqual(session.messages?.first?.content, "What is CI?")
    }

    func testDecodeSharedMessageWithToolUses() throws {
        let json = """
        {
            "role": "assistant",
            "content": "Results found",
            "tool_uses": [
                {"name": "search", "input": "failures", "output": "3 results"}
            ]
        }
        """
        let message = try JSONDecoder().decode(
            SharedMessage.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(message.role, "assistant")
        XCTAssertEqual(message.toolUses?.count, 1)
        XCTAssertEqual(message.toolUses?.first?.name, "search")
        XCTAssertEqual(message.toolUses?.first?.input, "failures")
        XCTAssertEqual(message.toolUses?.first?.output, "3 results")
    }

    func testDecodeSharedToolUseWithNils() throws {
        let json = #"{}"#
        let toolUse = try JSONDecoder().decode(
            SharedToolUse.self,
            from: Data(json.utf8)
        )

        XCTAssertNil(toolUse.name)
        XCTAssertNil(toolUse.input)
        XCTAssertNil(toolUse.output)
    }

    // MARK: - TorchAgentPermission Decoding Tests

    func testDecodePermissionAuthorized() throws {
        let json = #"{"authorized":true,"username":"pytorch-dev"}"#
        let permission = try JSONDecoder().decode(
            TorchAgentPermission.self,
            from: Data(json.utf8)
        )

        XCTAssertTrue(permission.authorized)
        XCTAssertEqual(permission.username, "pytorch-dev")
    }

    func testDecodePermissionUnauthorized() throws {
        let json = #"{"authorized":false,"username":null}"#
        let permission = try JSONDecoder().decode(
            TorchAgentPermission.self,
            from: Data(json.utf8)
        )

        XCTAssertFalse(permission.authorized)
        XCTAssertNil(permission.username)
    }

    // MARK: - ChatBubbleShape Tests

    func testChatBubbleShapeUserPath() {
        let shape = ChatBubbleShape(isUser: true)
        let rect = CGRect(x: 0, y: 0, width: 200, height: 100)
        let path = shape.path(in: rect)

        XCTAssertFalse(path.isEmpty, "User bubble path should not be empty")
        XCTAssertTrue(path.boundingRect.width > 0, "Path should have positive width")
        XCTAssertTrue(path.boundingRect.height > 0, "Path should have positive height")
    }

    func testChatBubbleShapeAssistantPath() {
        let shape = ChatBubbleShape(isUser: false)
        let rect = CGRect(x: 0, y: 0, width: 200, height: 100)
        let path = shape.path(in: rect)

        XCTAssertFalse(path.isEmpty, "Assistant bubble path should not be empty")
        XCTAssertTrue(path.boundingRect.width > 0, "Path should have positive width")
        XCTAssertTrue(path.boundingRect.height > 0, "Path should have positive height")
    }

    func testChatBubbleShapeUserAndAssistantDiffer() {
        let userShape = ChatBubbleShape(isUser: true)
        let assistantShape = ChatBubbleShape(isUser: false)
        let rect = CGRect(x: 0, y: 0, width: 200, height: 100)

        let userPath = userShape.path(in: rect)
        let assistantPath = assistantShape.path(in: rect)

        // The bounding rects should differ because the tail is on different sides
        XCTAssertNotEqual(
            userPath.boundingRect.origin.x,
            assistantPath.boundingRect.origin.x,
            accuracy: 1.0,
            "User and assistant bubble tails should be on different sides"
        )
    }

    func testChatBubbleShapeSmallRect() {
        let shape = ChatBubbleShape(isUser: true)
        let smallRect = CGRect(x: 0, y: 0, width: 40, height: 40)
        let path = shape.path(in: smallRect)

        // Should still produce a valid path even for small rects
        XCTAssertFalse(path.isEmpty, "Small rect should still produce a path")
    }

    func testChatBubbleShapeZeroRect() {
        let shape = ChatBubbleShape(isUser: false)
        let zeroRect = CGRect.zero
        let path = shape.path(in: zeroRect)

        // Zero rect should still be handled without crash
        // Path may be degenerate but should not crash
        _ = path.boundingRect
    }

    // MARK: - Message with Multiple Tool Uses

    func testMessageWithMultipleToolUses() {
        let toolUses = [
            ToolUseBlock(toolName: "clickhouse_query", input: "SELECT 1", output: "1", isExpanded: false),
            ToolUseBlock(toolName: "bash_command", input: "ls", output: nil, isExpanded: false),
            ToolUseBlock(toolName: "github_api", input: "GET /repos", output: "{}", isExpanded: true),
        ]

        let message = TorchAgentMessage(
            role: .assistant,
            content: "Analysis complete.",
            toolUses: toolUses,
            thinkingContent: "Running multiple tools...",
            timestamp: Date()
        )

        XCTAssertEqual(message.toolUses.count, 3)
        XCTAssertEqual(message.toolUses[0].toolName, "clickhouse_query")
        XCTAssertEqual(message.toolUses[1].toolName, "bash_command")
        XCTAssertEqual(message.toolUses[2].toolName, "github_api")
        XCTAssertNil(message.toolUses[1].output)
        XCTAssertTrue(message.toolUses[2].isExpanded)
    }

    // MARK: - Helpers

    private func makeToolUse(name: String) -> ToolUseBlock {
        ToolUseBlock(toolName: name, input: "", output: nil, isExpanded: false)
    }
}
